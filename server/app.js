import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.js";
import { rankPosts } from "./feed.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// Mehnat ke inaam (coins) — rozana limit ke saath, taaki spam se coins na kamaye ja sakein
const REWARD = { post: 5, photo: 8, reply: 1, daily: 2 };
const DAILY_CAP = { post: 10, reply: 30 };
const MAX_BODY = 2 * 1024 * 1024;
const MAX_IMG = 1_500_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ db, secret, corsOrigin = "*", rateLimit = true, authLimit = 10, apiLimit = 240, trustProxy = false } = {}) {
  if (!db) throw new Error("db chahiye");
  if (!secret) throw new Error("secret chahiye");

  const q = {
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (username, display, pass_hash, created_at) VALUES (?, ?, ?, ?)"),
    addCoins: db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?"),
    insertPost: db.prepare("INSERT INTO posts (user_id, text, media, img, created_at) VALUES (?, ?, ?, ?, ?)"),
    postById: db.prepare("SELECT * FROM posts WHERE id = ?"),
    countPostsSince: db.prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at >= ?"),
    countRepliesSince: db.prepare("SELECT COUNT(*) AS n FROM replies WHERE user_id = ? AND created_at >= ?"),
    hasLike: db.prepare("SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?"),
    addLike: db.prepare("INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)"),
    delLike: db.prepare("DELETE FROM likes WHERE user_id = ? AND post_id = ?"),
    countLikes: db.prepare("SELECT COUNT(*) AS n FROM likes WHERE post_id = ?"),
    insertReply: db.prepare("INSERT INTO replies (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)"),
    addHide: db.prepare("INSERT OR IGNORE INTO hides (user_id, post_id) VALUES (?, ?)"),
    bumpAff: db.prepare(`INSERT INTO affinity (user_id, author_id, score) VALUES (?, ?, MAX(-10, MIN(30, ?)))
      ON CONFLICT(user_id, author_id) DO UPDATE SET score = MAX(-10, MIN(30, score + excluded.score))`),
    affOf: db.prepare("SELECT author_id, score FROM affinity WHERE user_id = ?"),
    resetAff: db.prepare("DELETE FROM affinity WHERE user_id = ?"),
    setBonus: db.prepare("UPDATE users SET last_bonus = ? WHERE id = ?"),
    postCounts: db.prepare("SELECT user_id, COUNT(*) AS n FROM posts GROUP BY user_id"),
    feedRows: db.prepare(`
      SELECT p.id, p.user_id, p.text, p.media, p.img, p.created_at, u.username, u.display,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
        (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS replies,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
      FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.id NOT IN (SELECT post_id FROM hides WHERE user_id = ?)
      ORDER BY p.created_at DESC LIMIT 200`),
    oneRow: db.prepare(`
      SELECT p.id, p.user_id, p.text, p.media, p.img, p.created_at, u.username, u.display,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
        (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS replies,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
      FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`),
    repliesOf: db.prepare(`
      SELECT r.id, r.text, r.created_at, u.username, u.display
      FROM replies r JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.created_at ASC LIMIT 500`),
  };

  const hits = new Map();
  function limited(key, max, windowMs = 60_000) {
    if (!rateLimit) return false;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return h.n > max;
  }

  const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
  const today = () => new Date().toISOString().slice(0, 10);

  const publicUser = (u) => ({ id: u.id, username: u.username, display: u.display, coins: u.coins });
  const publicPost = (r) => ({
    id: r.id, user: { id: r.user_id, username: r.username, display: r.display },
    text: r.text, media: r.media, img: r.img || null, createdAt: r.created_at,
    likes: r.likes, replies: r.replies, liked: !!r.liked, ...(r.why ? { why: r.why } : {}),
  });

  function bump(uid, authorId, n) { if (uid !== authorId) q.bumpAff.run(uid, authorId, n); }

  function reward(uid, kind) {
    const amount = REWARD[kind];
    q.addCoins.run(amount, uid);
    return amount;
  }

  function cleanText(v, max, { required = false } = {}) {
    const t = typeof v === "string" ? v.trim() : "";
    if (required && !t) throw new HttpError(400, "Kuch likho");
    if (t.length > max) throw new HttpError(400, `Zyada lamba (max ${max} akshar)`);
    return t;
  }

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, "Body bahut badi hai");
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new HttpError(400, "JSON galat hai"); }
  }

  function auth(req) {
    const h = req.headers.authorization || "";
    const p = verifyToken(h.startsWith("Bearer ") ? h.slice(7) : "", secret);
    const u = p && q.userById.get(p.uid);
    if (!u) throw new HttpError(401, "Pehle login karo");
    return u;
  }

  const routes = [];
  const route = (method, re, fn, opts = {}) => routes.push({ method, re, fn, ...opts });

  // ---------- health ----------
  route("GET", /^\/api\/health$/, () => ({ ok: true, time: Date.now() }));

  // ---------- auth ----------
  route("POST", /^\/api\/signup$/, async (req) => {
    const b = await readJson(req);
    const username = String(b.username || "").trim();
    const password = String(b.password || "");
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, "Username 3-20 akshar: a-z, 0-9, _");
    if (password.length < 6 || password.length > 100) throw new HttpError(400, "Password kam se kam 6 akshar ka ho");
    const display = cleanText(b.display, 40) || username;
    if (q.userByName.get(username)) throw new HttpError(409, "Ye username le liya gaya hai");
    const { lastInsertRowid } = q.insertUser.run(username, display, hashPassword(password), Date.now());
    const u = q.userById.get(Number(lastInsertRowid));
    return { status: 201, body: { token: signToken({ uid: u.id }, secret), user: publicUser(u) } };
  }, { auth: true });

  route("POST", /^\/api\/login$/, async (req) => {
    const b = await readJson(req);
    const u = q.userByName.get(String(b.username || "").trim());
    // user na mile tab bhi hash chalao, taaki time se pata na chale ki username hai ya nahi
    const ok = verifyPassword(String(b.password || ""), u ? u.pass_hash : hashPassword("dummy-password"));
    if (!u || !ok) throw new HttpError(401, "Username ya password galat hai");
    return { token: signToken({ uid: u.id }, secret), user: publicUser(u) };
  }, { auth: true });

  route("GET", /^\/api\/me$/, (req) => ({ user: publicUser(auth(req)) }));

  route("POST", /^\/api\/daily$/, (req) => {
    const u = auth(req);
    if (u.last_bonus === today()) return { given: 0, coins: u.coins };
    q.setBonus.run(today(), u.id);
    const given = reward(u.id, "daily");
    return { given, coins: u.coins + given };
  });

  // ---------- feed ----------
  route("GET", /^\/api\/feed$/, (req) => {
    const u = auth(req);
    const rows = q.feedRows.all(u.id, u.id);
    const aff = new Map(q.affOf.all(u.id).map((r) => [r.author_id, r.score]));
    const postCount = new Map(q.postCounts.all().map((r) => [r.user_id, r.n]));
    const ranked = rankPosts(rows, { uid: u.id, aff, postCount });
    return { posts: ranked.map(publicPost) };
  });

  route("POST", /^\/api\/posts$/, async (req) => {
    const u = auth(req);
    const b = await readJson(req);
    const text = cleanText(b.text, 1000);
    const media = ["", "📷 Photo", "🎬 Reel", "📊 Poll"].includes(b.media) ? b.media : "";
    let img = null;
    if (b.img != null) {
      if (typeof b.img !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(b.img)) throw new HttpError(400, "Sirf jpeg/png/webp photo");
      if (b.img.length > MAX_IMG) throw new HttpError(413, "Photo bahut badi hai");
      img = b.img;
    }
    if (!text && !media && !img) throw new HttpError(400, "Kuch likho ya media chuno");
    const { lastInsertRowid } = q.insertPost.run(u.id, text, media, img, Date.now());
    let earned = 0;
    if (q.countPostsSince.get(u.id, startOfDay()).n <= DAILY_CAP.post) earned = reward(u.id, img ? "photo" : "post");
    const row = q.oneRow.get(u.id, Number(lastInsertRowid));
    return { status: 201, body: { post: publicPost(row), earned, coins: u.coins + earned } };
  });

  const withPost = (id) => {
    const p = q.postById.get(Number(id));
    if (!p) throw new HttpError(404, "Post nahi mila");
    return p;
  };

  route("GET", /^\/api\/posts\/(\d+)$/, (req, m) => {
    const u = auth(req);
    const p = withPost(m[1]);
    bump(u.id, p.user_id, 1);
    return { post: publicPost(q.oneRow.get(u.id, p.id)), replies: q.repliesOf.all(p.id).map((r) => ({
      id: r.id, text: r.text, createdAt: r.created_at, user: { username: r.username, display: r.display } })) };
  });

  route("POST", /^\/api\/posts\/(\d+)\/like$/, (req, m) => {
    const u = auth(req);
    const p = withPost(m[1]);
    const had = !!q.hasLike.get(u.id, p.id);
    if (had) { q.delLike.run(u.id, p.id); bump(u.id, p.user_id, -3); }
    else { q.addLike.run(u.id, p.id); bump(u.id, p.user_id, 3); }
    return { liked: !had, likes: q.countLikes.get(p.id).n };
  });

  route("POST", /^\/api\/posts\/(\d+)\/replies$/, async (req, m) => {
    const u = auth(req);
    const p = withPost(m[1]);
    const text = cleanText((await readJson(req)).text, 500, { required: true });
    q.insertReply.run(p.id, u.id, text, Date.now());
    bump(u.id, p.user_id, 4);
    let earned = 0;
    if (q.countRepliesSince.get(u.id, startOfDay()).n <= DAILY_CAP.reply) earned = reward(u.id, "reply");
    return { status: 201, body: { ok: true, earned, coins: u.coins + earned } };
  });

  route("POST", /^\/api\/posts\/(\d+)\/hide$/, (req, m) => {
    const u = auth(req);
    const p = withPost(m[1]);
    q.addHide.run(u.id, p.id);
    bump(u.id, p.user_id, -4);
    return { ok: true };
  });

  route("POST", /^\/api\/posts\/(\d+)\/share$/, (req, m) => {
    const u = auth(req);
    bump(u.id, withPost(m[1]).user_id, 3);
    return { ok: true };
  });

  route("POST", /^\/api\/reset-interests$/, (req) => {
    q.resetAff.run(auth(req).id);
    return { ok: true };
  });

  // ---------- http ----------
  function headers(extra = {}) {
    return {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    };
  }

  function sendJson(res, status, body) {
    res.writeHead(status, headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }));
    res.end(JSON.stringify(body));
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method allowed nahi" });
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: "Galat path" }); }
    if (rel.includes("\0")) return sendJson(res, 400, { error: "Galat path" });
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = resolve(join(PUBLIC_DIR, normalize(rel)));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 403, { error: "Mana hai" });
    try {
      const data = await readFile(file);
      res.writeHead(200, headers({
        "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      }));
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      sendJson(res, 404, { error: "Nahi mila" });
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
      if (req.method === "OPTIONS") { res.writeHead(204, headers()); return res.end(); }
      if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res, url.pathname);

      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return sendJson(res, 404, { error: "Ye route nahi hai" });
      if (limited("a:" + ip, apiLimit)) return sendJson(res, 429, { error: "Bahut zyada request — thoda ruko" });
      if (r.auth && limited("l:" + ip, authLimit)) return sendJson(res, 429, { error: "Bahut koshish — 1 minute baad try karo" });

      const out = await r.fn(req, url.pathname.match(r.re), url);
      if (out && out.status) sendJson(res, out.status, out.body); else sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error("server error:", e);
      sendJson(res, 500, { error: "Server me gadbad" });
    }
  });

  return server;
}
