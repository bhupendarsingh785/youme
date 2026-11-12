import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashPassword, verifyPassword, signToken, verifyToken, makeRecoveryCode, normalizeRecoveryCode,
} from "./auth.js";
import { rankPosts } from "./feed.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

// Mehnat ke inaam (coins) — rozana limit ke saath, taaki spam se coins na kamaye ja sakein
const REWARD = { post: 5, photo: 8, reply: 1, daily: 2 };
const DAILY_CAP = { post: 10, reply: 30, daily: 1 };
const MAX_BODY = 2 * 1024 * 1024;
const MAX_IMG = 1_500_000;
const REPORT_REASONS = ["spam", "abuse", "nudity", "violence", "other"];
const REPORTS_TO_HIDE = 3;           // itne alag logon ke report par post sabse chhup jaata hai
const LOGIN_FAILS = 8;               // ek username par 15 minute me itni galat koshish ke baad rok
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({
  db, secret, corsOrigin = "*", rateLimit = true, authLimit = 10, apiLimit = 240,
  trustProxy = false, hsts = false, log = false,
} = {}) {
  if (!db) throw new Error("db chahiye");
  if (!secret) throw new Error("secret chahiye");

  const POST_COLS = `p.id, p.user_id, p.text, p.media, p.img, p.created_at, u.username, u.display,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
        (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS replies,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked`;
  // jisko maine block kiya ya jisne mujhe block kiya — dono taraf se chhupao
  const NOT_BLOCKED = (col) => `${col} NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
        AND ${col} NOT IN (SELECT user_id FROM blocks WHERE blocked_id = ?)`;

  const q = {
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (username, display, pass_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)"),
    setPassword: db.prepare("UPDATE users SET pass_hash = ?, recovery_hash = ?, token_version = token_version + 1 WHERE id = ?"),
    setRecovery: db.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?"),
    bumpTokens: db.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    addCoins: db.prepare("UPDATE users SET coins = coins + ? WHERE id = ?"),
    logReward: db.prepare(`INSERT INTO reward_log (user_id, day, kind, n) VALUES (?, ?, ?, 1)
      ON CONFLICT(user_id, day, kind) DO UPDATE SET n = n + 1 RETURNING n`),
    insertPost: db.prepare("INSERT INTO posts (user_id, text, media, img, created_at) VALUES (?, ?, ?, ?, ?)"),
    postById: db.prepare("SELECT * FROM posts WHERE id = ?"),
    deletePost: db.prepare("DELETE FROM posts WHERE id = ?"),
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
    postCounts: db.prepare("SELECT user_id, COUNT(*) AS n FROM posts GROUP BY user_id"),
    feedRows: db.prepare(`
      SELECT ${POST_COLS}
      FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.id NOT IN (SELECT post_id FROM hides WHERE user_id = ?)
        AND ${NOT_BLOCKED("p.user_id")}
        AND (p.user_id = ? OR (SELECT COUNT(*) FROM reports rp WHERE rp.post_id = p.id) < ${REPORTS_TO_HIDE})
      ORDER BY p.created_at DESC LIMIT 200`),
    oneRow: db.prepare(`SELECT ${POST_COLS} FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`),
    repliesOf: db.prepare(`
      SELECT r.id, r.text, r.created_at, u.username, u.display
      FROM replies r JOIN users u ON u.id = r.user_id
      WHERE r.post_id = ? AND ${NOT_BLOCKED("r.user_id")}
      ORDER BY r.created_at ASC LIMIT 500`),
    isBlockedEither: db.prepare(`SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`),
    addBlock: db.prepare("INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)"),
    delBlock: db.prepare("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?"),
    myBlocks: db.prepare("SELECT u.username, u.display FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY u.username"),
    addReport: db.prepare("INSERT OR IGNORE INTO reports (reporter_id, post_id, reason, created_at) VALUES (?, ?, ?, ?)"),
    reportCount: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE post_id = ?"),
    searchUsers: db.prepare(`
      SELECT username, display FROM users
      WHERE username LIKE ? ESCAPE '\\' AND id != ? AND ${NOT_BLOCKED("id")}
      ORDER BY username LIMIT 10`),
    insertMsg: db.prepare("INSERT INTO messages (from_id, to_id, text, created_at) VALUES (?, ?, ?, ?)"),
    convs: db.prepare(`
      SELECT m.id, m.from_id, m.text, m.created_at, u.username, u.display,
        (SELECT COUNT(*) FROM messages x WHERE x.to_id = ? AND x.from_id = u.id AND x.read_at IS NULL) AS unread
      FROM messages m JOIN users u ON u.id = CASE WHEN m.from_id = ? THEN m.to_id ELSE m.from_id END
      WHERE m.id IN (SELECT MAX(id) FROM messages WHERE from_id = ? OR to_id = ?
                     GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)
        AND ${NOT_BLOCKED("u.id")}
      ORDER BY m.id DESC LIMIT 100`),
    thread: db.prepare(`
      SELECT id, from_id, text, created_at FROM messages
      WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) AND id > ?
      ORDER BY id DESC LIMIT 200`),
    markRead: db.prepare("UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL"),
    unreadTotal: db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.to_id = ? AND m.read_at IS NULL
      AND ${NOT_BLOCKED("m.from_id")}`),
  };

  // ---------- rate limit (memory me, ek server ke liye) ----------
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
  const fails = new Map();
  const failKey = (name, ip) => name.toLowerCase() + "|" + (ip || "?");
  const failCheck = (name, ip) => { const f = fails.get(failKey(name, ip)); return !!(rateLimit && f && f.reset > Date.now() && f.n >= LOGIN_FAILS); };
  const failAdd = (name, ip) => {
    const k = failKey(name, ip), now = Date.now();
    let f = fails.get(k);
    if (!f || f.reset < now) { f = { n: 0, reset: now + 15 * 60_000 }; fails.set(k, f); }
    f.n++;
    if (fails.size > 5000) for (const [kk, v] of fails) if (v.reset < now) fails.delete(kk);
  };
  const failClear = (name, ip) => fails.delete(failKey(name, ip));

  const today = () => new Date().toISOString().slice(0, 10);

  const publicUser = (u) => ({ id: u.id, username: u.username, display: u.display, coins: u.coins });
  const publicPost = (r) => ({
    id: r.id, user: { id: r.user_id, username: r.username, display: r.display },
    text: r.text, media: r.media, img: r.img ? `/api/img/${r.id}` : null, createdAt: r.created_at,
    likes: r.likes, replies: r.replies, liked: !!r.liked, ...(r.why ? { why: r.why } : {}),
  });
  const newToken = (u) => signToken({ uid: u.id, tv: u.token_version }, secret);

  function bump(uid, authorId, n) { if (uid !== authorId) q.bumpAff.run(uid, authorId, n); }

  function reward(uid, kind, amount = REWARD[kind]) {
    const cap = DAILY_CAP[kind === "photo" ? "post" : kind];
    const n = q.logReward.get(uid, today(), kind === "photo" ? "post" : kind).n;
    if (cap && n > cap) return 0;
    q.addCoins.run(amount, uid);
    return amount;
  }

  // Control akshar hatao (newline/tab rehne do), lambai jaanch
  const stripCtl = (t) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  function cleanText(v, max, { required = false } = {}) {
    const t = typeof v === "string" ? stripCtl(v).trim() : "";
    if (required && !t) throw new HttpError(400, "Kuch likho");
    if (t.length > max) throw new HttpError(400, `Zyada lamba (max ${max} akshar)`);
    return t;
  }
  function checkPassword(pw) {
    if (typeof pw !== "string" || pw.length < 6 || pw.length > 100) throw new HttpError(400, "Password kam se kam 6 akshar ka ho");
    return pw;
  }

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, "Body bahut badi hai");
      chunks.push(c);
    }
    if (!size) return {};
    let v;
    try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new HttpError(400, "JSON galat hai"); }
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "JSON object chahiye");
    return v;
  }

  function auth(req) {
    const h = req.headers.authorization || "";
    const p = verifyToken(h.startsWith("Bearer ") ? h.slice(7) : "", secret);
    const u = p && q.userById.get(p.uid);
    if (!u || u.token_version !== p.tv) throw new HttpError(401, "Pehle login karo");
    return u;
  }

  const userNamed = (name) => {
    const u = q.userByName.get(String(name || ""));
    if (!u) throw new HttpError(404, "Ye user nahi mila");
    return u;
  };
  const blockedEitherWay = (a, b) => !!q.isBlockedEither.get(a, b, b, a);

  const routes = [];
  const route = (method, re, fn, opts = {}) => routes.push({ method, re, fn, ...opts });

  // ---------- health ----------
  route("GET", /^\/api\/health$/, () => ({ ok: true, time: Date.now() }));

  // ---------- auth ----------
  route("POST", /^\/api\/signup$/, async (req) => {
    const b = await readJson(req);
    const username = String(b.username || "").trim();
    const password = checkPassword(b.password);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, "Username 3-20 akshar: a-z, 0-9, _");
    const display = cleanText(b.display, 40) || username;
    if (q.userByName.get(username)) throw new HttpError(409, "Ye username le liya gaya hai");
    const code = makeRecoveryCode();
    const { lastInsertRowid } = q.insertUser.run(username, display, hashPassword(password), hashPassword(normalizeRecoveryCode(code)), Date.now());
    const u = q.userById.get(Number(lastInsertRowid));
    return { status: 201, body: { token: newToken(u), user: publicUser(u), recoveryCode: code } };
  }, { strict: true });

  route("POST", /^\/api\/login$/, async (req) => {
    const b = await readJson(req);
    const name = String(b.username || "").trim();
    if (failCheck(name, req._ip)) throw new HttpError(429, "Is account par bahut galat koshish — 15 minute baad try karo");
    const u = q.userByName.get(name);
    // user na mile tab bhi hash chalao, taaki time se pata na chale ki username hai ya nahi
    const ok = verifyPassword(String(b.password || ""), u ? u.pass_hash : DUMMY_HASH);
    if (!u || !ok) { failAdd(name, req._ip); throw new HttpError(401, "Username ya password galat hai"); }
    failClear(name, req._ip);
    return { token: newToken(u), user: publicUser(u), hasRecovery: !!u.recovery_hash };
  }, { strict: true });

  // Password bhool gaye: recovery code se naya password
  route("POST", /^\/api\/recover$/, async (req) => {
    const b = await readJson(req);
    const name = String(b.username || "").trim();
    const next = checkPassword(b.newPassword);
    if (failCheck(name, req._ip)) throw new HttpError(429, "Bahut galat koshish — 15 minute baad try karo");
    const u = q.userByName.get(name);
    const ok = verifyPassword(normalizeRecoveryCode(b.recoveryCode), u && u.recovery_hash ? u.recovery_hash : DUMMY_HASH);
    if (!u || !u.recovery_hash || !ok) { failAdd(name, req._ip); throw new HttpError(401, "Username ya recovery code galat hai"); }
    failClear(name, req._ip);
    const code = makeRecoveryCode();      // purana code ek hi baar chalta hai — naya milta hai
    q.setPassword.run(hashPassword(next), hashPassword(normalizeRecoveryCode(code)), u.id);
    const fresh = q.userById.get(u.id);
    return { token: newToken(fresh), user: publicUser(fresh), recoveryCode: code };
  }, { strict: true });

  route("POST", /^\/api\/password$/, async (req) => {
    const u = auth(req);
    const b = await readJson(req);
    if (!verifyPassword(String(b.current || ""), u.pass_hash)) throw new HttpError(403, "Abhi ka password galat hai");
    q.setPassword.run(hashPassword(checkPassword(b.next)), u.recovery_hash, u.id);   // baaki sab device logout
    return { token: newToken(q.userById.get(u.id)) };
  }, { strict: true });

  // Naya recovery code (purana bekaar ho jaata hai) — puraane accounts ke liye bhi
  route("POST", /^\/api\/recovery-code$/, async (req) => {
    const u = auth(req);
    const b = await readJson(req);
    if (!verifyPassword(String(b.password || ""), u.pass_hash)) throw new HttpError(403, "Password galat hai");
    const code = makeRecoveryCode();
    q.setRecovery.run(hashPassword(normalizeRecoveryCode(code)), u.id);
    return { recoveryCode: code };
  }, { strict: true });

  route("POST", /^\/api\/logout-all$/, (req) => {
    const u = auth(req);
    q.bumpTokens.run(u.id);
    return { ok: true };
  });

  route("POST", /^\/api\/delete-account$/, async (req) => {
    const u = auth(req);
    const b = await readJson(req);
    if (!verifyPassword(String(b.password || ""), u.pass_hash)) throw new HttpError(403, "Password galat hai");
    q.deleteUser.run(u.id);     // posts, likes, replies, DM sab saath me hat jaate hain
    return { ok: true };
  }, { strict: true });

  route("GET", /^\/api\/me$/, (req) => {
    const u = auth(req);
    return { user: publicUser(u), unread: q.unreadTotal.get(u.id, u.id, u.id).n, hasRecovery: !!u.recovery_hash };
  });

  route("POST", /^\/api\/daily$/, (req) => {
    const u = auth(req);
    const given = reward(u.id, "daily");
    return { given, coins: u.coins + given };
  });

  // ---------- feed ----------
  route("GET", /^\/api\/feed$/, (req) => {
    const u = auth(req);
    const rows = q.feedRows.all(u.id, u.id, u.id, u.id, u.id);
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
      if (typeof b.img !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(b.img)) throw new HttpError(400, "Sirf jpeg/png/webp photo");
      if (b.img.length > MAX_IMG) throw new HttpError(413, "Photo bahut badi hai");
      img = b.img;
    }
    if (!text && !media && !img) throw new HttpError(400, "Kuch likho ya media chuno");
    const { lastInsertRowid } = q.insertPost.run(u.id, text, media, img, Date.now());
    const earned = reward(u.id, img ? "photo" : "post");
    const row = q.oneRow.get(u.id, Number(lastInsertRowid));
    return { status: 201, body: { post: publicPost(row), earned, coins: u.coins + earned } };
  });

  // Post dekhne layak hai? (block ho to "nahi mila" — pata na chale ki block hua)
  const visiblePost = (u, id) => {
    const p = q.postById.get(Number(id));
    if (!p || (p.user_id !== u.id && blockedEitherWay(u.id, p.user_id))) throw new HttpError(404, "Post nahi mila");
    return p;
  };

  route("GET", /^\/api\/posts\/(\d+)$/, (req, m) => {
    const u = auth(req);
    const p = visiblePost(u, m[1]);
    bump(u.id, p.user_id, 1);
    return {
      post: publicPost(q.oneRow.get(u.id, p.id)),
      replies: q.repliesOf.all(p.id, u.id, u.id).map((r) => ({
        id: r.id, text: r.text, createdAt: r.created_at, user: { username: r.username, display: r.display } })),
    };
  });

  route("DELETE", /^\/api\/posts\/(\d+)$/, (req, m) => {
    const u = auth(req);
    const p = q.postById.get(Number(m[1]));
    if (!p) throw new HttpError(404, "Post nahi mila");
    if (p.user_id !== u.id) throw new HttpError(403, "Ye tumhara post nahi hai");
    q.deletePost.run(p.id);
    return { ok: true };
  });

  route("POST", /^\/api\/posts\/(\d+)\/like$/, (req, m) => {
    const u = auth(req);
    const p = visiblePost(u, m[1]);
    const had = !!q.hasLike.get(u.id, p.id);
    if (had) { q.delLike.run(u.id, p.id); bump(u.id, p.user_id, -3); }
    else { q.addLike.run(u.id, p.id); bump(u.id, p.user_id, 3); }
    return { liked: !had, likes: q.countLikes.get(p.id).n };
  });

  route("POST", /^\/api\/posts\/(\d+)\/replies$/, async (req, m) => {
    const u = auth(req);
    const p = visiblePost(u, m[1]);
    const text = cleanText((await readJson(req)).text, 500, { required: true });
    q.insertReply.run(p.id, u.id, text, Date.now());
    bump(u.id, p.user_id, 4);
    const earned = reward(u.id, "reply");
    return { status: 201, body: { ok: true, earned, coins: u.coins + earned } };
  });

  route("POST", /^\/api\/posts\/(\d+)\/hide$/, (req, m) => {
    const u = auth(req);
    const p = visiblePost(u, m[1]);
    q.addHide.run(u.id, p.id);
    bump(u.id, p.user_id, -4);
    return { ok: true };
  });

  route("POST", /^\/api\/posts\/(\d+)\/share$/, (req, m) => {
    const u = auth(req);
    bump(u.id, visiblePost(u, m[1]).user_id, 3);
    return { ok: true };
  });

  route("POST", /^\/api\/posts\/(\d+)\/report$/, async (req, m) => {
    const u = auth(req);
    const p = visiblePost(u, m[1]);
    if (p.user_id === u.id) throw new HttpError(400, "Apna hi post report nahi kar sakte");
    const reason = String((await readJson(req)).reason || "other");
    if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, "Wajah: " + REPORT_REASONS.join(", "));
    q.addReport.run(u.id, p.id, reason, Date.now());
    q.addHide.run(u.id, p.id);                       // report karne wale ko turant chhup jaata hai
    return { ok: true, hiddenForAll: q.reportCount.get(p.id).n >= REPORTS_TO_HIDE };
  });

  route("POST", /^\/api\/reset-interests$/, (req) => {
    q.resetAff.run(auth(req).id);
    return { ok: true };
  });

  // Photo alag se (feed me poori photo nahi bhejte — feed tez rehti hai). <img> header nahi bhej sakta, isliye bina login.
  route("GET", /^\/api\/img\/(\d+)$/, (req, m) => {
    const p = q.postById.get(Number(m[1]));
    const mt = p && p.img && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s.exec(p.img);
    if (!mt) throw new HttpError(404, "Photo nahi mili");
    return { raw: Buffer.from(mt[2], "base64"), type: mt[1] };
  });

  // ---------- block ----------
  route("GET", /^\/api\/blocks$/, (req) => ({ blocked: q.myBlocks.all(auth(req).id) }));

  route("POST", /^\/api\/users\/([A-Za-z0-9_]{3,20})\/block$/, (req, m) => {
    const u = auth(req);
    const other = userNamed(m[1]);
    if (other.id === u.id) throw new HttpError(400, "Khud ko block nahi kar sakte");
    q.addBlock.run(u.id, other.id);
    return { ok: true };
  });

  route("POST", /^\/api\/users\/([A-Za-z0-9_]{3,20})\/unblock$/, (req, m) => {
    const u = auth(req);
    q.delBlock.run(u.id, userNamed(m[1]).id);
    return { ok: true };
  });

  route("GET", /^\/api\/users$/, (req, m, url) => {
    const u = auth(req);
    const term = (url.searchParams.get("q") || "").trim();
    if (term.length < 2 || term.length > 20) return { users: [] };
    const like = term.replace(/[\\%_]/g, "\\$&") + "%";
    return { users: q.searchUsers.all(like, u.id, u.id, u.id) };
  });

  // ---------- DM ----------
  route("GET", /^\/api\/conversations$/, (req) => {
    const u = auth(req);
    const rows = q.convs.all(u.id, u.id, u.id, u.id, u.id, u.id, u.id);
    return { conversations: rows.map((r) => ({
      user: { username: r.username, display: r.display },
      last: { text: r.text, mine: r.from_id === u.id, createdAt: r.created_at },
      unread: r.unread,
    })) };
  });

  route("GET", /^\/api\/messages\/([A-Za-z0-9_]{3,20})$/, (req, m, url) => {
    const u = auth(req);
    const other = userNamed(m[1]);
    if (blockedEitherWay(u.id, other.id)) throw new HttpError(403, "Is user se chat nahi ho sakti");
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    const rows = q.thread.all(u.id, other.id, other.id, u.id, after).reverse();
    q.markRead.run(Date.now(), u.id, other.id);
    return {
      user: { username: other.username, display: other.display },
      messages: rows.map((r) => ({ id: r.id, mine: r.from_id === u.id, text: r.text, createdAt: r.created_at })),
    };
  });

  route("POST", /^\/api\/messages$/, async (req) => {
    const u = auth(req);
    if (limited("m:" + u.id, 30)) throw new HttpError(429, "Bahut tez message — thoda ruko");
    const b = await readJson(req);
    const other = userNamed(String(b.to || "").trim());
    if (other.id === u.id) throw new HttpError(400, "Khud ko message nahi bhej sakte");
    if (blockedEitherWay(u.id, other.id)) throw new HttpError(403, "Is user ko message nahi bhej sakte");
    const text = cleanText(b.text, 1000, { required: true });
    const now = Date.now();
    const { lastInsertRowid } = q.insertMsg.run(u.id, other.id, text, now);
    return { status: 201, body: { message: { id: Number(lastInsertRowid), mine: true, text, createdAt: now } } };
  });

  // ---------- http ----------
  function headers(extra = {}) {
    return {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()",
      "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
      ...(hsts ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
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
        "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
      }));
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      sendJson(res, 404, { error: "Nahi mila" });
    }
  }

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    let path = "?";
    if (log) res.on("finish", () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`));
    try {
      const url = new URL(req.url, "http://x");
      path = url.pathname;
      const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",").pop().trim()) || req.socket.remoteAddress || "?";
      req._ip = ip;
      if (req.method === "OPTIONS") { res.writeHead(204, headers()); return res.end(); }
      if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res, url.pathname);

      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return sendJson(res, 404, { error: "Ye route nahi hai" });
      if (limited("a:" + ip, apiLimit)) return sendJson(res, 429, { error: "Bahut zyada request — thoda ruko" });
      if (r.strict && limited("l:" + ip, authLimit)) return sendJson(res, 429, { error: "Bahut koshish — 1 minute baad try karo" });

      const out = await r.fn(req, url.pathname.match(r.re), url);
      if (out && out.raw) {
        res.writeHead(200, headers({ "Content-Type": out.type, "Cache-Control": "public, max-age=86400", "Cross-Origin-Resource-Policy": "cross-origin" }));
        return res.end(out.raw);
      }
      if (out && out.status) sendJson(res, out.status, out.body); else sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      console.error("server error:", e);
      sendJson(res, 500, { error: "Server me gadbad" });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  return server;
}
