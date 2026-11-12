import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, backupTo } from "../server/db.js";
import { createApp } from "../server/app.js";

let server, base, db;

before(async () => {
  db = openDb(":memory:");
  server = createApp({ db, secret: "test-secret", rateLimit: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

async function call(b, path, { method = "GET", token, body } = {}) {
  const res = await fetch(b + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
const api = (path, o) => call(base, path, o);
let n = 0;
async function mk(prefix = "u") {
  const username = `${prefix}${++n}_${Math.random().toString(36).slice(2, 6)}`;
  const r = await api("/api/signup", { method: "POST", body: { username, password: "secret123" } });
  assert.equal(r.status, 201);
  return { username, token: r.json.token, code: r.json.recoveryCode, id: r.json.user.id };
}
const post = async (u, text = "hello") => (await api("/api/posts", { method: "POST", token: u.token, body: { text } })).json.post;
const feedIds = async (u) => (await api("/api/feed", { token: u.token })).json.posts.map((p) => p.id);

// ---------- recovery / password ----------
test("recovery code: password wapas milta hai, purana code aur purane token bekaar", async () => {
  const u = await mk("rec");
  assert.match(u.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);

  const bad = await api("/api/recover", { method: "POST", body: { username: u.username, recoveryCode: "AAAA-AAAA-AAAA-AAAA-AAAA", newPassword: "newpass99" } });
  assert.equal(bad.status, 401);

  // chhote akshar / bina dash bhi chalna chahiye (phone par type karte waqt)
  const ok = await api("/api/recover", { method: "POST", body: { username: u.username, recoveryCode: u.code.toLowerCase().replaceAll("-", " "), newPassword: "newpass99" } });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.json.recoveryCode, u.code, "naya code milna chahiye");

  assert.equal((await api("/api/login", { method: "POST", body: { username: u.username, password: "secret123" } })).status, 401);
  assert.equal((await api("/api/login", { method: "POST", body: { username: u.username, password: "newpass99" } })).status, 200);
  assert.equal((await api("/api/me", { token: u.token })).status, 401, "purana token band");
  assert.equal((await api("/api/me", { token: ok.json.token })).status, 200);

  const reuse = await api("/api/recover", { method: "POST", body: { username: u.username, recoveryCode: u.code, newPassword: "hacked123" } });
  assert.equal(reuse.status, 401, "purana code dobara nahi chalta");
});

test("password badlo: baaki device logout, naya token chalta hai", async () => {
  const u = await mk("pw");
  assert.equal((await api("/api/password", { method: "POST", token: u.token, body: { current: "galat!", next: "brandnew1" } })).status, 403);
  assert.equal((await api("/api/password", { method: "POST", token: u.token, body: { current: "secret123", next: "123" } })).status, 400);
  const ok = await api("/api/password", { method: "POST", token: u.token, body: { current: "secret123", next: "brandnew1" } });
  assert.equal(ok.status, 200);
  assert.equal((await api("/api/me", { token: u.token })).status, 401);
  assert.equal((await api("/api/me", { token: ok.json.token })).status, 200);
});

test("logout-all purane token band karta hai", async () => {
  const u = await mk("lo");
  assert.equal((await api("/api/logout-all", { method: "POST", token: u.token })).status, 200);
  assert.equal((await api("/api/me", { token: u.token })).status, 401);
});

test("naya recovery code (puraane account ke liye) password maangta hai", async () => {
  const u = await mk("nrc");
  assert.equal((await api("/api/recovery-code", { method: "POST", token: u.token, body: { password: "galat" } })).status, 403);
  const r = await api("/api/recovery-code", { method: "POST", token: u.token, body: { password: "secret123" } });
  assert.equal(r.status, 200);
  const ok = await api("/api/recover", { method: "POST", body: { username: u.username, recoveryCode: r.json.recoveryCode, newPassword: "another99" } });
  assert.equal(ok.status, 200);
});

test("account delete: sab saaf, login band", async () => {
  const u = await mk("del");
  const p = await post(u);
  assert.equal((await api("/api/delete-account", { method: "POST", token: u.token, body: { password: "galat" } })).status, 403);
  assert.equal((await api("/api/delete-account", { method: "POST", token: u.token, body: { password: "secret123" } })).status, 200);
  assert.equal((await api("/api/login", { method: "POST", body: { username: u.username, password: "secret123" } })).status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM posts WHERE id = ?").get(p.id).n, 0);
});

test("brute-force: ek username par 8 galat koshish ke baad rok (sahi password bhi)", async () => {
  const db2 = openDb(":memory:");
  const s2 = createApp({ db: db2, secret: "x", authLimit: 1000 });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${s2.address().port}`;
  await call(b, "/api/signup", { method: "POST", body: { username: "victim", password: "secret123" } });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await call(b, "/api/login", { method: "POST", body: { username: "victim", password: "x" + i + "xxxx" } })).status);
  assert.ok(codes.every((c) => c === 401));
  assert.equal((await call(b, "/api/login", { method: "POST", body: { username: "victim", password: "secret123" } })).status, 429);
  assert.equal((await call(b, "/api/recover", { method: "POST", body: { username: "victim", recoveryCode: "AAAA", newPassword: "newpass99" } })).status, 429);
  s2.close(); db2.close();
});

// ---------- block ----------
test("block: dono taraf se feed, post, reply aur DM band; unblock par wapas", async () => {
  const a = await mk("ba"), b = await mk("bb");
  const pa = await post(a, "a ka post"), pb = await post(b, "b ka post");
  assert.ok((await feedIds(a)).includes(pb.id));

  assert.equal((await api(`/api/users/${b.username}/block`, { method: "POST", token: a.token })).status, 200);
  assert.ok(!(await feedIds(a)).includes(pb.id));
  assert.ok(!(await feedIds(b)).includes(pa.id), "jisne block kiya uska post bhi mujhe nahi dikhna");
  assert.equal((await api(`/api/posts/${pb.id}`, { token: a.token })).status, 404);
  assert.equal((await api(`/api/posts/${pa.id}/like`, { method: "POST", token: b.token })).status, 404);
  assert.equal((await api("/api/messages", { method: "POST", token: b.token, body: { to: a.username, text: "hi" } })).status, 403);
  assert.equal((await api("/api/messages", { method: "POST", token: a.token, body: { to: b.username, text: "hi" } })).status, 403);
  assert.deepEqual((await api("/api/blocks", { token: a.token })).json.blocked.map((x) => x.username), [b.username]);
  assert.equal((await api(`/api/users/${a.username}/block`, { method: "POST", token: a.token })).status, 400);

  await api(`/api/users/${b.username}/unblock`, { method: "POST", token: a.token });
  assert.ok((await feedIds(a)).includes(pb.id));
  assert.equal((await api("/api/messages", { method: "POST", token: b.token, body: { to: a.username, text: "hi" } })).status, 201);
});

test("block ke baad us user ke reply thread me nahi dikhte", async () => {
  const a = await mk("bra"), b = await mk("brb"), c = await mk("brc");
  const p = await post(c, "c ka post");
  await api(`/api/posts/${p.id}/replies`, { method: "POST", token: b.token, body: { text: "b ka jawab" } });
  assert.equal((await api(`/api/posts/${p.id}`, { token: a.token })).json.replies.length, 1);
  await api(`/api/users/${b.username}/block`, { method: "POST", token: a.token });
  assert.equal((await api(`/api/posts/${p.id}`, { token: a.token })).json.replies.length, 0);
});

// ---------- report ----------
test("report: reporter ko turant chhupta hai, 3 logon ke baad sabse; author ko dikhta rehta hai", async () => {
  const author = await mk("ra");
  const [r1, r2, r3, other] = [await mk("r1"), await mk("r2"), await mk("r3"), await mk("ro")];
  const p = await post(author, "bura post");

  assert.equal((await api(`/api/posts/${p.id}/report`, { method: "POST", token: author.token, body: { reason: "spam" } })).status, 400);
  assert.equal((await api(`/api/posts/${p.id}/report`, { method: "POST", token: r1.token, body: { reason: "pata-nahi" } })).status, 400);

  const first = await api(`/api/posts/${p.id}/report`, { method: "POST", token: r1.token, body: { reason: "spam" } });
  assert.equal(first.json.hiddenForAll, false);
  await api(`/api/posts/${p.id}/report`, { method: "POST", token: r1.token, body: { reason: "spam" } });   // dobara — ginti nahi badhti
  assert.ok(!(await feedIds(r1)).includes(p.id));
  assert.ok((await feedIds(other)).includes(p.id), "ek report se sabse nahi chhupta");

  await api(`/api/posts/${p.id}/report`, { method: "POST", token: r2.token, body: { reason: "abuse" } });
  assert.ok((await feedIds(other)).includes(p.id), "do reports (r1 do baar) abhi kaafi nahi");
  const third = await api(`/api/posts/${p.id}/report`, { method: "POST", token: r3.token, body: { reason: "nudity" } });
  assert.equal(third.json.hiddenForAll, true);
  assert.ok(!(await feedIds(other)).includes(p.id));
  assert.ok((await feedIds(author)).includes(p.id), "author ko apna post dikhta rahe");
});

// ---------- DM ----------
test("DM: bhejo, unread ginti, padhne par saaf, after se sirf naye", async () => {
  const a = await mk("da"), b = await mk("db");
  const send = (from, to, text) => api("/api/messages", { method: "POST", token: from.token, body: { to: to.username, text } });
  const m1 = await send(a, b, "namaste");
  assert.equal(m1.status, 201);
  await send(a, b, "kaise ho?");

  assert.equal((await api("/api/me", { token: b.token })).json.unread, 2);
  let convs = (await api("/api/conversations", { token: b.token })).json.conversations;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].unread, 2);
  assert.equal(convs[0].last.text, "kaise ho?");
  assert.equal(convs[0].last.mine, false);

  const t = await api(`/api/messages/${a.username}`, { token: b.token });
  assert.deepEqual(t.json.messages.map((m) => [m.text, m.mine]), [["namaste", false], ["kaise ho?", false]]);
  assert.equal((await api("/api/me", { token: b.token })).json.unread, 0);

  await send(b, a, "badhiya");
  const after = await api(`/api/messages/${b.username}?after=${m1.json.message.id + 1}`, { token: a.token });
  assert.deepEqual(after.json.messages.map((m) => m.text), ["badhiya"]);
  convs = (await api("/api/conversations", { token: a.token })).json.conversations;
  assert.equal(convs[0].last.mine, false);
});

test("DM: khud ko, anjaan ko, khaali ya lamba message mana", async () => {
  const a = await mk("dx");
  const send = (to, text) => api("/api/messages", { method: "POST", token: a.token, body: { to, text } });
  assert.equal((await send(a.username, "hi")).status, 400);
  assert.equal((await send("koi_nahi_hai", "hi")).status, 404);
  const b = await mk("dy");
  assert.equal((await send(b.username, "   ")).status, 400);
  assert.equal((await send(b.username, "x".repeat(1001))).status, 400);
  assert.equal((await api("/api/conversations")).status, 401);
});

test("DM: bahut tez bhejne par rok (30/minute)", async () => {
  const db2 = openDb(":memory:");
  const s2 = createApp({ db: db2, secret: "x", authLimit: 1000 });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${s2.address().port}`;
  const a = (await call(b, "/api/signup", { method: "POST", body: { username: "spam_a", password: "secret123" } })).json;
  await call(b, "/api/signup", { method: "POST", body: { username: "spam_b", password: "secret123" } });
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await call(b, "/api/messages", { method: "POST", token: a.token, body: { to: "spam_b", text: "m" + i } })).status;
  s2.close(); db2.close();
  assert.equal(last, 429);
});

test("user search: prefix, khud aur blocked nahi, % jaise akshar sirf akshar", async () => {
  const a = await mk("srch");
  const target = await mk("findme");
  const prefix = target.username.slice(0, 6);
  let r = await api(`/api/users?q=${prefix}`, { token: a.token });
  assert.ok(r.json.users.some((u) => u.username === target.username));
  assert.ok(!r.json.users.some((u) => u.username === a.username));
  assert.deepEqual((await api("/api/users?q=%25%25", { token: a.token })).json.users, []);
  assert.deepEqual((await api("/api/users?q=f", { token: a.token })).json.users, [], "ek akshar se khoj nahi");
  await api(`/api/users/${target.username}/block`, { method: "POST", token: a.token });
  r = await api(`/api/users?q=${prefix}`, { token: a.token });
  assert.ok(!r.json.users.some((u) => u.username === target.username));
});

// ---------- posts / coins ----------
test("post delete: sirf apna; delete karke coins dobara nahi kamaye ja sakte", async () => {
  const a = await mk("pd"), b = await mk("pe");
  const p = await post(a, "mera");
  assert.equal((await api(`/api/posts/${p.id}`, { method: "DELETE", token: b.token })).status, 403);
  assert.equal((await api(`/api/posts/${p.id}`, { method: "DELETE", token: a.token })).status, 200);
  assert.equal((await api(`/api/posts/${p.id}`, { method: "DELETE", token: a.token })).status, 404);

  let total = 0;
  for (let i = 0; i < 14; i++) {
    const r = await api("/api/posts", { method: "POST", token: a.token, body: { text: "farm" + i } });
    total += r.json.earned;
    await api(`/api/posts/${r.json.post.id}`, { method: "DELETE", token: a.token });
  }
  assert.equal(total, 9 * 5, "pehla post (delete se pehle) + 9 aur = rozana 10 hi, delete se limit nahi hatti");
});

test("header: clickjacking / sniffing se bachav", async () => {
  const r = await api("/api/health");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(r.headers.get("permissions-policy"), /camera=\(self\)/);
});

test("JSON array / galat body mana", async () => {
  const u = await mk("js");
  const res = await fetch(base + "/api/posts", { method: "POST", headers: { Authorization: "Bearer " + u.token, "Content-Type": "application/json" }, body: "[1,2]" });
  assert.equal(res.status, 400);
  const res2 = await fetch(base + "/api/posts", { method: "POST", headers: { Authorization: "Bearer " + u.token, "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(res2.status, 400);
});

// ---------- database migration / backup ----------
test("purana (v1) database khulte hi naye tables ke saath upgrade hota hai, data salamat", () => {
  const dir = mkdtempSync(join(tmpdir(), "ym-mig-"));
  try {
    const file = join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display TEXT NOT NULL,
      pass_hash TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0, last_bonus TEXT, created_at INTEGER NOT NULL);
      INSERT INTO users (username, display, pass_hash, coins, created_at) VALUES ('purana', 'Purana', 'x', 42, 1);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '', img TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE likes (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, PRIMARY KEY (user_id, post_id));
      CREATE TABLE replies (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE hides (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, PRIMARY KEY (user_id, post_id));
      CREATE TABLE affinity (user_id INTEGER NOT NULL, author_id INTEGER NOT NULL, score REAL NOT NULL, PRIMARY KEY (user_id, author_id));`);
    old.close();
    const up = openDb(file);
    assert.equal(up.prepare("PRAGMA user_version").get().user_version, 6);
    assert.equal(up.prepare("SELECT coins FROM users WHERE username = 'purana'").get().coins, 42);
    for (const t of ["blocks", "reports", "messages", "reward_log"]) assert.ok(up.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
    up.close();
    openDb(file).close();    // dobara kholne par kuch nahi toota
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("backup: copy me data wahi, aur khul jaati hai", () => {
  const dir = mkdtempSync(join(tmpdir(), "ym-bk-"));
  try {
    const src = openDb(join(dir, "src.db"));
    src.prepare("INSERT INTO users (username, display, pass_hash, created_at) VALUES ('bk', 'Bk', 'x', 1)").run();
    backupTo(src, join(dir, "sub", "copy.db"));
    src.close();
    const copy = openDb(join(dir, "sub", "copy.db"));
    assert.equal(copy.prepare("SELECT display FROM users WHERE username = 'bk'").get().display, "Bk");
    copy.close();
    assert.throws(() => backupTo(openDb(":memory:"), "/tmp/x'; DROP TABLE users; --"), /Galat file naam/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
