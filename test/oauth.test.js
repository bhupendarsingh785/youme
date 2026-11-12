import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { buildProviders } from "../server/oauth.js";

// ---------- nakli OpenID provider (asli Google jaisa hi bartav) ----------
let idp, IDP;
const codes = new Map();        // code -> { user, nonce }
let failMeOnce = false;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
before(async () => {
  idp = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/.well-known/openid-configuration")
      return json({ issuer: IDP, authorization_endpoint: IDP + "/auth", token_endpoint: IDP + "/token", userinfo_endpoint: IDP + "/me" });
    if (u.pathname === "/token") {
      let body = ""; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const c = codes.get(p.get("code"));
      if (!c || p.get("client_secret") !== "sec" || !p.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      const out = { access_token: "at-" + p.get("code") };
      if (c.user.idt) {
        const claims = { iss: IDP, aud: "cid", sub: c.user.sub, exp: Math.floor(Date.now() / 1000) + 300, nonce: c.nonce, ...c.user.idt };
        out.id_token = `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
      }
      return json(out);
    }
    if (u.pathname === "/me") {
      if (failMeOnce) { failMeOnce = false; return json({ error: "busy" }, 503); }
      const c = codes.get(String(req.headers.authorization).slice(10));
      const { idt, ...user } = c.user;
      return json(user);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => idp.listen(0, "127.0.0.1", r));
  IDP = `http://127.0.0.1:${idp.address().port}`;
});
after(() => idp.close());

const APP = "http://app.test/youme/app.html";
const servers = [];
after(() => servers.forEach((s) => s.close()));
function makeServer(extra = {}, db = openDb(":memory:"), secret = "x") {
  const mails = [];
  const s = createApp({
    db, secret, rateLimit: false,
    authEnv: { OIDC_TEST_ISSUER: IDP, OIDC_TEST_CLIENT_ID: "cid", OIDC_TEST_CLIENT_SECRET: "sec", OIDC_TEST_LABEL: "TestID",
               APP_URL: "http://app.test/youme/", ...extra },
    sendMail: (to, code) => mails.push({ to, code }),
  });
  servers.push(s);
  return { db, s, mails };
}
async function listen(s) { await new Promise((r) => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${s.address().port}`; }
const get = (url, headers = {}) => fetch(url, { redirect: "manual", headers });
const post = async (url, body, token) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const frag = (loc) => new URLSearchParams(String(loc).split("#")[1] || "");

// Do hisse: start (provider par bhejna) aur finish (provider se wapas aana)
async function begin(B, ret = APP) {
  const r = await get(`${B}/api/auth/oidc_test/start?return=${encodeURIComponent(ret)}`);
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get("location"));
  return { to, cookie: r.headers.get("set-cookie") ? r.headers.get("set-cookie").split(";")[0] : "", state: to.searchParams.get("state"), nonce: to.searchParams.get("nonce") };
}
async function finish(b, user, { base, cookie = b.cookie, nonce = b.nonce } = {}) {
  const code = "c" + Math.random().toString(36).slice(2);
  codes.set(code, { user, nonce });
  const cb = new URL(b.to.searchParams.get("redirect_uri"));
  const url = (base || cb.origin) + cb.pathname + `?code=${code}&state=${b.state}`;
  const r = await get(url, cookie ? { cookie } : {});
  assert.equal(r.status, 302);
  const loc = r.headers.get("location"), h = frag(loc);
  return { loc, token: h.get("ym_token"), isNew: h.get("ym_new") === "1", error: h.get("ym_error") };
}
const socialLogin = async (B, user, opts = {}) => finish(await begin(B, opts.ret), user, opts);
const me = async (B, token) => (await (await fetch(B + "/api/me", { headers: { authorization: "Bearer " + token } })).json()).user;

test("providers list: Google se WeChat tak sab, sirf key wale chalu; galat Apple key pehle hi pakdi", () => {
  const warns = [];
  const P = buildProviders({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", KAKAO_CLIENT_ID: "k", GITHUB_CLIENT_ID: "only-id",
    APPLE_CLIENT_ID: "s", APPLE_TEAM_ID: "t", APPLE_KEY_ID: "k", APPLE_PRIVATE_KEY: "kachra",
    OIDC_BAD_ISSUER: "http://evil.example", OIDC_BAD_CLIENT_ID: "x" }, (m) => warns.push(m));
  for (const k of ["google", "apple", "microsoft", "facebook", "x", "github", "linkedin", "discord", "yahoo", "yandex", "kakao", "naver", "line", "wechat", "qq", "weibo"]) assert.ok(P[k], k);
  assert.equal(P.google.ready, true);
  assert.equal(P.kakao.ready, true, "Kakao me secret zaroori nahi");
  assert.equal(P.github.ready, false, "secret ke bina band");
  assert.equal(P.apple.ready, false, "galat .p8 key");
  assert.equal(P.oidc_bad.ready, false, "https ke bina OIDC band");
  assert.ok(warns.some((w) => /GitHub/.test(w)) && warns.some((w) => /Apple/.test(w)) && warns.some((w) => /OIDC_BAD/.test(w)));
});

test("social login: naya account, dobara login par wahi account, bina password", async () => {
  const { s } = makeServer(); const B = await listen(s);
  const list = await (await fetch(B + "/api/auth/providers")).json();
  assert.ok(list.providers.find((p) => p.key === "oidc_test" && p.ready && p.label === "TestID"));
  const a = await socialLogin(B, { sub: "u-1", email: "Riya@Mail.com", email_verified: true, name: "Riya Sharma" });
  assert.ok(a.loc.startsWith(APP + "#ym_token="), a.loc);
  assert.equal(a.isNew, true);
  const u = await me(B, a.token);
  assert.equal(u.display, "Riya Sharma");
  assert.equal(u.username, "riya");
  assert.equal(u.hasPassword, false);
  const b = await socialLogin(B, { sub: "u-1", email: "riya@mail.com", email_verified: true, name: "Riya" });
  assert.equal(b.isNew, false);
  assert.equal((await me(B, b.token)).id, u.id);
  assert.equal((await post(B + "/api/login", { username: "riya", password: "!" })).status, 401);
});

test("verified nahi to login mana", async () => {
  const { s } = makeServer(); const B = await listen(s);
  const r = await socialLogin(B, { sub: "u-2", email: "x@y.com", email_verified: false });
  assert.equal(r.token, null);
  assert.match(r.error, /verify/);
});

test("server restart beech me ho jaaye tab bhi login poora hota hai", async () => {
  const db = openDb(":memory:");
  const A = await listen(makeServer({}, db, "same-secret").s);
  const b = await begin(A);
  const B2 = await listen(makeServer({}, db, "same-secret").s);       // naya process, wahi secret
  const r = await finish(b, { sub: "restart-1" }, { base: B2 });
  assert.ok(r.token, r.error);
});

test("do tab saath me login kar sakte hain", async () => {
  const { s } = makeServer(); const B = await listen(s);
  const t1 = await begin(B), t2 = await begin(B);
  assert.notEqual(t1.cookie.split("=")[0], t2.cookie.split("=")[0]);
  assert.ok((await finish(t2, { sub: "tab-2" })).token);
  assert.ok((await finish(t1, { sub: "tab-1" })).token);
});

test("suraksha: doosri site par token nahi, cookie ke bina/chhedi hui cookie se nahi, band provider nahi", async () => {
  const { s } = makeServer(); const B = await listen(s);
  const evil = await socialLogin(B, { sub: "u-3" }, { ret: "https://evil.example/steal" });
  assert.ok(evil.loc.startsWith("http://app.test/youme/#"), "evil site par nahi gaya: " + evil.loc);
  assert.equal((await socialLogin(B, { sub: "u-4" }, { cookie: "" })).token, null);
  const b = await begin(B);
  const [n, v] = b.cookie.split("=");
  const tampered = await finish(b, { sub: "u-5" }, { cookie: `${n}=${v.slice(0, -3)}abc` });
  assert.equal(tampered.token, null);
  const off = await get(`${B}/api/auth/wechat/start?return=${encodeURIComponent(APP)}`);
  assert.match(decodeURIComponent(off.headers.get("location")), /chalu nahi/);
});

test("id_token ki jaanch: sahi chalta hai, galat app (aud) ya galat nonce mana", async () => {
  const { s } = makeServer(); const B = await listen(s);
  assert.ok((await socialLogin(B, { sub: "it-1", idt: {} })).token, "sahi id_token");
  const aud = await socialLogin(B, { sub: "it-2", idt: { aud: "kisi-aur-ki-app" } });
  assert.equal(aud.token, null);
  assert.match(aud.error, /sahi nahi/);
  const nonce = await socialLogin(B, { sub: "it-3", idt: {} }, { nonce: "galat-nonce" });
  assert.equal(nonce.token, null);
  const old = await socialLogin(B, { sub: "it-4", idt: { exp: 1000 } });
  assert.equal(old.token, null);
});

test("provider ek baar atke (503) to dobara koshish karke login ho jaata hai", async () => {
  const { s } = makeServer(); const B = await listen(s);
  failMeOnce = true;
  const r = await socialLogin(B, { sub: "retry-1" });
  assert.ok(r.token, r.error);
  assert.equal(failMeOnce, false);
});

test("email code login: galat code, sahi code, ek hi baar", async () => {
  const { s, mails } = makeServer(); const B = await listen(s);
  assert.equal((await post(B + "/api/auth/email/start", { email: "galat" })).status, 400);
  assert.equal((await post(B + "/api/auth/email/start", { email: "Aman@Mail.com" })).status, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].code, /^\d{6}$/);
  assert.equal((await post(B + "/api/auth/email/start", { email: "aman@mail.com" })).status, 429, "1 minute me dobara nahi");
  const wrong = mails[0].code === "000000" ? "111111" : "000000";
  assert.equal((await post(B + "/api/auth/email/verify", { email: "aman@mail.com", code: wrong })).status, 400);
  const ok = await post(B + "/api/auth/email/verify", { email: "aman@mail.com", code: mails[0].code });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.created, true);
  assert.equal(ok.json.user.username, "aman");
  assert.equal((await post(B + "/api/auth/email/verify", { email: "aman@mail.com", code: mails[0].code })).status, 400, "code ek hi baar");
});

test("email se jodna: anjaan provider ka 'verified' email purane account se NAHI judta; bharosemand jodta hai", async () => {
  const one = makeServer(); const B = await listen(one.s);
  await post(B + "/api/auth/email/start", { email: "neha@mail.com" });
  const e = await post(B + "/api/auth/email/verify", { email: "neha@mail.com", code: one.mails[0].code });
  const g = await socialLogin(B, { sub: "g-neha", email: "neha@mail.com", email_verified: true });
  assert.equal(g.isNew, true, "anjaan provider -> alag account (account chori se bachav)");
  assert.notEqual((await me(B, g.token)).id, e.json.user.id);

  const two = makeServer({ LINK_BY_EMAIL: "email,oidc_test" }); const B2 = await listen(two.s);
  await post(B2 + "/api/auth/email/start", { email: "neha@mail.com" });
  const e2 = await post(B2 + "/api/auth/email/verify", { email: "neha@mail.com", code: two.mails[0].code });
  const g2 = await socialLogin(B2, { sub: "g-neha", email: "neha@mail.com", email_verified: true });
  assert.equal(g2.isNew, false);
  assert.equal((await me(B2, g2.token)).id, e2.json.user.id);
});

test("email spam se bachav: ek email par ghante ki limit, poore server ki din ki limit", async () => {
  const { s, db, mails } = makeServer({ MAIL_PER_EMAIL_HOUR: "2", MAIL_DAILY_LIMIT: "3" }); const B = await listen(s);
  const back = () => db.prepare("UPDATE email_codes SET sent_at = sent_at - 120000").run();
  assert.equal((await post(B + "/api/auth/email/start", { email: "a@m.com" })).status, 200); back();
  assert.equal((await post(B + "/api/auth/email/start", { email: "a@m.com" })).status, 200); back();
  const third = await post(B + "/api/auth/email/start", { email: "a@m.com" });
  assert.equal(third.status, 429);
  assert.match(third.json.error, /ghante/);
  assert.equal((await post(B + "/api/auth/email/start", { email: "b@m.com" })).status, 200);
  const day = await post(B + "/api/auth/email/start", { email: "c@m.com" });
  assert.equal(day.status, 503, "din ki limit poori");
  assert.equal(mails.length, 3);
});

test("ek network se bahut naye account nahi, par purane account ka login chalta rahe", async () => {
  const { s } = makeServer({ NEW_ACCOUNTS_PER_IP_HOUR: "2" }); const B = await listen(s);
  assert.ok((await socialLogin(B, { sub: "n-1" })).token);
  assert.ok((await socialLogin(B, { sub: "n-2" })).token);
  const third = await socialLogin(B, { sub: "n-3" });
  assert.equal(third.token, null);
  assert.match(third.error, /ghante/);
  assert.ok((await socialLogin(B, { sub: "n-1" })).token, "purana account chalta hai");
});

test("email code: 5 galat koshish ke baad code band", async () => {
  const { s, mails } = makeServer(); const B = await listen(s);
  await post(B + "/api/auth/email/start", { email: "k@m.com" });
  const wrong = mails[0].code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await post(B + "/api/auth/email/verify", { email: "k@m.com", code: wrong });
  assert.equal((await post(B + "/api/auth/email/verify", { email: "k@m.com", code: mails[0].code })).status, 429);
});

test("bina password wala account: password set, recovery code, delete — sab chalta hai", async () => {
  const { s } = makeServer(); const B = await listen(s);
  const a = await socialLogin(B, { sub: "np-1", name: "Neha" });
  assert.equal((await post(B + "/api/recovery-code", {}, a.token)).status, 200);
  const pw = await post(B + "/api/password", { next: "mera-naya1" }, a.token);
  assert.equal(pw.status, 200);
  const u = await me(B, pw.json.token);
  assert.equal(u.hasPassword, true);
  assert.equal((await post(B + "/api/login", { username: u.username, password: "mera-naya1" })).status, 200);
  const b = await socialLogin(B, { sub: "np-2" });
  assert.equal((await post(B + "/api/delete-account", {}, b.token)).status, 200);
});
