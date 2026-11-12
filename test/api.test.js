import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { rankPosts } from "../server/feed.js";
import { signToken, verifyToken, hashPassword, verifyPassword } from "../server/auth.js";

let server, base, db;

before(async () => {
  db = openDb(":memory:");
  server = createApp({ db, secret: "test-secret", rateLimit: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const signup = async (username) => (await api("/api/signup", { method: "POST", body: { username, password: "secret123" } })).json;

test("health", async () => {
  const r = await api("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("signup, login, me — aur galat password / duplicate username mana", async () => {
  const s = await api("/api/signup", { method: "POST", body: { username: "riya_1", password: "secret123", display: "Riya" } });
  assert.equal(s.status, 201);
  assert.equal(s.json.user.display, "Riya");
  assert.equal(s.json.user.pass_hash, undefined, "password hash kabhi bahar nahi jana chahiye");

  const dup = await api("/api/signup", { method: "POST", body: { username: "RIYA_1", password: "secret123" } });
  assert.equal(dup.status, 409);

  const bad = await api("/api/login", { method: "POST", body: { username: "riya_1", password: "galat" } });
  assert.equal(bad.status, 401);

  const ok = await api("/api/login", { method: "POST", body: { username: "riya_1", password: "secret123" } });
  assert.equal(ok.status, 200);
  const me = await api("/api/me", { token: ok.json.token });
  assert.equal(me.json.user.username, "riya_1");

  assert.equal((await api("/api/signup", { method: "POST", body: { username: "a b", password: "secret123" } })).status, 400);
  assert.equal((await api("/api/signup", { method: "POST", body: { username: "short_pw", password: "123" } })).status, 400);
});

test("bina login ya galat token se 401", async () => {
  assert.equal((await api("/api/feed")).status, 401);
  assert.equal((await api("/api/feed", { token: "fake.token" })).status, 401);
});

test("post banao: coins milte hain, photo par zyada, galat photo mana", async () => {
  const { token } = await signup("poster");
  const p = await api("/api/posts", { method: "POST", token, body: { text: "namaste" } });
  assert.equal(p.status, 201);
  assert.equal(p.json.earned, 5);
  const photo = await api("/api/posts", { method: "POST", token, body: { text: "pic", img: "data:image/png;base64,iVBORw0KGgo=" } });
  assert.equal(photo.json.earned, 8);
  assert.equal(photo.json.coins, 13);
  const evil = await api("/api/posts", { method: "POST", token, body: { text: "x", img: "data:text/html;base64,PHNjcmlwdD4=" } });
  assert.equal(evil.status, 400);
  assert.equal((await api("/api/posts", { method: "POST", token, body: {} })).status, 400);
});

test("roz ke post-reward ki limit hai", async () => {
  const { token } = await signup("spammer");
  let total = 0;
  for (let i = 0; i < 13; i++) total += (await api("/api/posts", { method: "POST", token, body: { text: "p" + i } })).json.earned;
  assert.equal(total, 10 * 5, "sirf pehle 10 post par coins");
});

test("like toggle, reply, hide aur feed", async () => {
  const a = await signup("author_x");
  const b = await signup("reader_x");
  const post = (await api("/api/posts", { method: "POST", token: a.token, body: { text: "pehla post" } })).json.post;

  let l = await api(`/api/posts/${post.id}/like`, { method: "POST", token: b.token });
  assert.deepEqual([l.json.liked, l.json.likes], [true, 1]);
  l = await api(`/api/posts/${post.id}/like`, { method: "POST", token: b.token });
  assert.deepEqual([l.json.liked, l.json.likes], [false, 0]);
  await api(`/api/posts/${post.id}/like`, { method: "POST", token: b.token });

  const r = await api(`/api/posts/${post.id}/replies`, { method: "POST", token: b.token, body: { text: "badhiya!" } });
  assert.equal(r.json.earned, 1);
  assert.equal((await api(`/api/posts/${post.id}/replies`, { method: "POST", token: b.token, body: { text: "  " } })).status, 400);

  const detail = await api(`/api/posts/${post.id}`, { token: b.token });
  assert.equal(detail.json.replies.length, 1);
  assert.equal(detail.json.replies[0].user.username, "reader_x");

  let feed = await api("/api/feed", { token: b.token });
  const seen = feed.json.posts.find((x) => x.id === post.id);
  assert.ok(seen);
  assert.equal(seen.liked, true);
  assert.equal(seen.replies, 1);

  await api(`/api/posts/${post.id}/hide`, { method: "POST", token: b.token });
  feed = await api("/api/feed", { token: b.token });
  assert.equal(feed.json.posts.find((x) => x.id === post.id), undefined);
  // doosre user ki feed par asar nahi
  assert.ok((await api("/api/feed", { token: a.token })).json.posts.find((x) => x.id === post.id));
});

test("roz ka bonus sirf ek baar", async () => {
  const { token } = await signup("daily_u");
  assert.equal((await api("/api/daily", { method: "POST", token })).json.given, 2);
  assert.equal((await api("/api/daily", { method: "POST", token })).json.given, 0);
});

test("static: path traversal band", async () => {
  const res = await fetch(base + "/..%2f..%2fpackage.json");
  assert.ok([403, 404].includes(res.status));
  const res2 = await fetch(base + "/%2e%2e/package.json");
  assert.ok([403, 404].includes(res2.status));
});

test("rate limit: login par bahut koshish rukti hai", async () => {
  const db2 = openDb(":memory:");
  const s2 = createApp({ db: db2, secret: "x", authLimit: 3 });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s2.address().port}/api/login`;
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "nope", password: "nope123" }) })).status);
  }
  s2.close(); db2.close();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

// ---------- pure logic ----------
const NOW = 1_700_000_000_000;
const post = (id, user_id, over = {}) => ({ id, user_id, text: "hi", media: "", img: null, likes: 0, replies: 0, created_at: NOW - 3600_000, ...over });
const noRng = () => 0;

test("ranking: pasandida creator upar aata hai", () => {
  const ctx = { uid: 99, aff: new Map([[2, 20]]), postCount: new Map([[1, 9], [2, 9]]) };
  const out = rankPosts([post(1, 1), post(2, 2)], ctx, NOW, noRng);
  assert.equal(out[0].user_id, 2);
  assert.equal(out[0].why, "tumhe pasand hai");
});

test("ranking: ek hi creator lagatar nahi aata (variety)", () => {
  const ctx = { uid: 99, aff: new Map(), postCount: new Map([[1, 9], [2, 9]]) };
  const posts = [post(1, 1, { likes: 10 }), post(2, 1, { likes: 9 }), post(3, 2, { likes: 5 })];
  const out = rankPosts(posts, ctx, NOW, noRng);
  assert.deepEqual(out.map((p) => p.user_id), [1, 2, 1]);
});

test("ranking: purana post neeche, photo wala upar", () => {
  const ctx = { uid: 99, aff: new Map(), postCount: new Map([[1, 9], [2, 9], [3, 9]]) };
  const out = rankPosts([
    post(1, 1, { created_at: NOW - 10 * 86400_000 }),
    post(2, 2),
    post(3, 3, { img: "data:image/png;base64,AA" }),
  ], ctx, NOW, noRng);
  assert.equal(out.at(-1).id, 1);
  assert.equal(out[0].id, 3);
});

test("token: sahi chalta hai, chheda gaya ya expire to mana", () => {
  const t = signToken({ uid: 5 }, "s1");
  assert.equal(verifyToken(t, "s1").uid, 5);
  assert.equal(verifyToken(t, "s2"), null);
  assert.equal(verifyToken(t.slice(0, -2) + "xx", "s1"), null);
  assert.equal(verifyToken(signToken({ uid: 5 }, "s1", -10), "s1"), null);
});

test("password hash: sahi/galat", () => {
  const h = hashPassword("mera-pass");
  assert.equal(verifyPassword("mera-pass", h), true);
  assert.equal(verifyPassword("galat", h), false);
});
