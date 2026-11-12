// Social login (Google, Apple, Microsoft, ... WeChat, Kakao, LINE) + Email code login.
// Zero dependency: sirf node:crypto aur built-in fetch.
//
// Har provider tabhi chalu hota hai jab uski key environment me ho:
//   GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET, ...
// Kisi bhi desh ka koi bhi OpenID Connect provider bina code badle:
//   OIDC_<NAAM>_ISSUER, OIDC_<NAAM>_CLIENT_ID, OIDC_<NAAM>_CLIENT_SECRET, OIDC_<NAAM>_LABEL, OIDC_<NAAM>_FLAG
// Callback URL (provider ki website par yahi daalna):  <PUBLIC_URL>/api/auth/<provider>/callback
import { randomBytes, randomInt, createHash, createHmac, createSign, createPrivateKey, timingSafeEqual } from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");
const ENC = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
const decodeJwt = (t) => { try { return JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString()); } catch { return {}; } };
const truthy = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined);
const bearer = (t) => ({ Authorization: "Bearer " + t });

class RetryableError extends Error {}
const MAX_RESPONSE = 1_000_000;    // provider ka jawab 1 MB se bada ho to mana (memory bachao)

async function getJsonOnce(url, { method = "GET", headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    let r;
    try {
      r = await fetch(url, { method, headers: { Accept: "application/json", "User-Agent": "YouMe", ...headers }, body, signal: ctrl.signal });
    } catch (e) { throw new RetryableError(`${new URL(url).host} network: ${e.name === "AbortError" ? "timeout" : e.message}`); }
    if (Number(r.headers.get("content-length")) > MAX_RESPONSE) throw new Error(`${new URL(url).host} jawab bahut bada`);
    const txt = await r.text();
    if (txt.length > MAX_RESPONSE) throw new Error(`${new URL(url).host} jawab bahut bada`);
    let j;
    try { j = JSON.parse(txt); } catch { j = Object.fromEntries(new URLSearchParams(txt)); }
    const bad = !r.ok || (j && !Array.isArray(j) && (j.error || (j.errcode && j.errcode !== 0) || (j.ret && j.ret !== 0)));
    if (bad) {
      const msg = `${new URL(url).host} ${r.status} ${(j && (j.error_description || j.errmsg || j.msg || JSON.stringify(j.error))) || ""}`;
      throw r.status >= 500 || r.status === 429 ? new RetryableError(msg) : new Error(msg);
    }
    return j;
  } finally { clearTimeout(t); }
}

// GET (padhna) network/5xx par ek baar dobara koshish karta hai.
// Token lene wali call (code ek hi baar chalta hai) kabhi dobara nahi — usme noRetry.
async function getJson(url, opts = {}) {
  const canRetry = (opts.method || "GET") === "GET" && !opts.noRetry;
  try { return await getJsonOnce(url, opts); }
  catch (e) {
    if (!canRetry || !(e instanceof RetryableError)) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return getJsonOnce(url, opts);
  }
}

// OpenID Connect userinfo -> hamara profile
const oidcInfo = (url) => async (t) => {
  const u = await getJson(url, { headers: bearer(t) });
  return { id: u.sub, email: u.email, emailVerified: truthy(u.email_verified), name: u.name || u.preferred_username || u.nickname };
};

// ---------- providers ----------
// profile() -> { id, email?, emailVerified? (true/false/undefined), name? }
// emailVerified === false  => login mana (sirf verified account).
export const PROVIDERS = {
  google: {
    label: "Google", icon: "G", flag: "🌍",
    auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile", pkce: true, authExtra: { prompt: "select_account" },
    nonce: true, iss: ["https://accounts.google.com", "accounts.google.com"],
    profile: oidcInfo("https://openidconnect.googleapis.com/v1/userinfo"),
  },
  apple: {
    label: "Apple", icon: "🍎", flag: "🌍",
    auth: "https://appleid.apple.com/auth/authorize", token: "https://appleid.apple.com/auth/token",
    scope: "name email", authExtra: { response_mode: "form_post" },
    nonce: true, iss: ["https://appleid.apple.com"],
    profile: async (t, tr, { extra }) => {
      const c = decodeJwt(tr.id_token);
      let name;
      try { const n = JSON.parse(extra.user || "{}").name || {}; name = [n.firstName, n.lastName].filter(Boolean).join(" "); } catch {}
      return { id: c.sub, email: c.email, emailVerified: truthy(c.email_verified), name };
    },
  },
  microsoft: {
    label: "Microsoft", icon: "🪟", flag: "🌍",
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid email profile", pkce: true, nonce: true,
    profile: oidcInfo("https://graph.microsoft.com/oidc/userinfo"),
  },
  facebook: {
    label: "Facebook", icon: "f", flag: "🌍",
    auth: "https://www.facebook.com/v19.0/dialog/oauth", token: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "email public_profile", tokenMethod: "GET",
    profile: async (t) => {
      const u = await getJson("https://graph.facebook.com/me?" + ENC({ fields: "id,name,email", access_token: t }));
      return { id: u.id, email: u.email, name: u.name };
    },
  },
  x: {
    label: "X (Twitter)", icon: "𝕏", flag: "🌍",
    auth: "https://twitter.com/i/oauth2/authorize", token: "https://api.twitter.com/2/oauth2/token",
    scope: "users.read tweet.read", pkce: true, tokenAuth: "basic",
    profile: async (t) => {
      const d = (await getJson("https://api.twitter.com/2/users/me", { headers: bearer(t) })).data || {};
      return { id: d.id, name: d.name || d.username };
    },
  },
  github: {
    label: "GitHub", icon: "🐙", flag: "🌍",
    auth: "https://github.com/login/oauth/authorize", token: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    profile: async (t) => {
      const h = { ...bearer(t), Accept: "application/vnd.github+json" };
      const u = await getJson("https://api.github.com/user", { headers: h });
      let em = [];
      try { em = await getJson("https://api.github.com/user/emails", { headers: h }); } catch {}
      const pri = Array.isArray(em) ? em.find((e) => e.primary) : null;
      return { id: String(u.id), email: pri ? pri.email : undefined, emailVerified: pri ? !!pri.verified : undefined, name: u.name || u.login };
    },
  },
  linkedin: {
    label: "LinkedIn", icon: "in", flag: "🌍",
    auth: "https://www.linkedin.com/oauth/v2/authorization", token: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: "openid profile email",
    profile: oidcInfo("https://api.linkedin.com/v2/userinfo"),
  },
  discord: {
    label: "Discord", icon: "🎮", flag: "🌍",
    auth: "https://discord.com/oauth2/authorize", token: "https://discord.com/api/oauth2/token",
    scope: "identify email",
    profile: async (t) => {
      const u = await getJson("https://discord.com/api/users/@me", { headers: bearer(t) });
      return { id: u.id, email: u.email, emailVerified: u.email ? !!u.verified : undefined, name: u.global_name || u.username };
    },
  },
  yahoo: {
    label: "Yahoo", icon: "Y!", flag: "🌍",
    auth: "https://api.login.yahoo.com/oauth2/request_auth", token: "https://api.login.yahoo.com/oauth2/get_token",
    scope: "openid email profile",
    profile: oidcInfo("https://api.login.yahoo.com/openid/v1/userinfo"),
  },
  yandex: {
    label: "Yandex", icon: "Я", flag: "🇷🇺",
    auth: "https://oauth.yandex.com/authorize", token: "https://oauth.yandex.com/token",
    profile: async (t) => {
      const u = await getJson("https://login.yandex.ru/info?format=json", { headers: { Authorization: "OAuth " + t } });
      return { id: u.id, email: u.default_email, name: u.display_name || u.real_name || u.login };
    },
  },
  kakao: {
    label: "Kakao", icon: "💬", flag: "🇰🇷", secretOptional: true,
    auth: "https://kauth.kakao.com/oauth/authorize", token: "https://kauth.kakao.com/oauth/token",
    profile: async (t) => {
      const u = await getJson("https://kapi.kakao.com/v2/user/me", { headers: bearer(t) });
      const ka = u.kakao_account || {};
      return { id: String(u.id), email: ka.email, emailVerified: ka.email ? truthy(ka.is_email_verified) : undefined,
               name: (ka.profile && ka.profile.nickname) || (u.properties && u.properties.nickname) };
    },
  },
  naver: {
    label: "Naver", icon: "N", flag: "🇰🇷", tokenState: true,
    auth: "https://nid.naver.com/oauth2.0/authorize", token: "https://nid.naver.com/oauth2.0/token",
    profile: async (t) => {
      const u = (await getJson("https://openapi.naver.com/v1/nid/me", { headers: bearer(t) })).response || {};
      return { id: u.id, email: u.email, name: u.name || u.nickname };
    },
  },
  line: {
    label: "LINE", icon: "🟢", flag: "🇯🇵",
    auth: "https://access.line.me/oauth2/v2.1/authorize", token: "https://api.line.me/oauth2/v2.1/token",
    scope: "openid profile email", pkce: true, nonce: true, iss: ["https://access.line.me"],
    profile: async (t, tr) => {
      const c = decodeJwt(tr.id_token);
      if (c.sub) return { id: c.sub, email: c.email, name: c.name };
      const u = await getJson("https://api.line.me/v2/profile", { headers: bearer(t) });
      return { id: u.userId, name: u.displayName };
    },
  },
  wechat: {
    label: "WeChat", icon: "💚", flag: "🇨🇳",
    authUrl: (p, redirect, state) => "https://open.weixin.qq.com/connect/qrconnect?" +
      ENC({ appid: p.id, redirect_uri: redirect, response_type: "code", scope: "snsapi_login", state }) + "#wechat_redirect",
    exchange: (p, code) => getJson("https://api.weixin.qq.com/sns/oauth2/access_token?" +
      ENC({ appid: p.id, secret: p.secret, code, grant_type: "authorization_code" })),
    profile: async (t, tr) => {
      const u = await getJson("https://api.weixin.qq.com/sns/userinfo?" + ENC({ access_token: t, openid: tr.openid }));
      return { id: u.unionid || tr.unionid || tr.openid, name: u.nickname };
    },
  },
  qq: {
    label: "QQ", icon: "🐧", flag: "🇨🇳",
    auth: "https://graph.qq.com/oauth2.0/authorize", token: "https://graph.qq.com/oauth2.0/token",
    scope: "get_user_info", tokenMethod: "GET", tokenExtra: { fmt: "json" },
    profile: async (t, tr, { p }) => {
      const me = await getJson("https://graph.qq.com/oauth2.0/me?" + ENC({ access_token: t, fmt: "json" }));
      const u = await getJson("https://graph.qq.com/user/get_user_info?" + ENC({ access_token: t, oauth_consumer_key: p.id, openid: me.openid }));
      return { id: me.openid, name: u.nickname };
    },
  },
  weibo: {
    label: "Weibo", icon: "🔴", flag: "🇨🇳",
    auth: "https://api.weibo.com/oauth2/authorize", token: "https://api.weibo.com/oauth2/access_token",
    profile: async (t, tr) => {
      const u = await getJson("https://api.weibo.com/2/users/show.json?" + ENC({ access_token: t, uid: tr.uid }));
      return { id: String(u.idstr || tr.uid), name: u.screen_name };
    },
  },
};

function appleSecret(env) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID }));
  const p = b64url(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 600, aud: "https://appleid.apple.com", sub: env.APPLE_CLIENT_ID }));
  const sig = createSign("SHA256").update(`${h}.${p}`).sign({ key: String(env.APPLE_PRIVATE_KEY).replace(/\\n/g, "\n"), dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64url(sig)}`;
}

export function buildProviders(env = {}, warn = () => {}) {
  const out = {};
  for (const [key, d] of Object.entries(PROVIDERS)) {
    const K = key.toUpperCase();
    const id = env[`${K}_CLIENT_ID`], secret = env[`${K}_CLIENT_SECRET`];
    let ready = key === "apple"
      ? !!(id && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY)
      : !!(id && (secret || d.secretOptional));
    if (id && !ready) warn(`${d.label}: ${K}_CLIENT_ID hai par baaki keys nahi — ye login band rahega`);
    if (key === "apple" && ready) {
      // Galat .p8 key ka pata abhi chal jaaye, login ke waqt nahi
      try { createPrivateKey(String(env.APPLE_PRIVATE_KEY).replace(/\\n/g, "\n")); }
      catch { ready = false; warn("Apple: APPLE_PRIVATE_KEY sahi .p8 key nahi hai — Apple login band"); }
    }
    out[key] = { ...d, key, id, secret, ready };
  }
  // Kisi bhi desh ka koi bhi OpenID Connect provider
  for (const k of Object.keys(env)) {
    const m = /^OIDC_([A-Z0-9]+)_ISSUER$/.exec(k);
    if (!m) continue;
    const K = m[1], key = "oidc_" + K.toLowerCase();
    let issuer = String(env[k]).trim().replace(/\/$/, "");
    try { if (new URL(issuer).protocol !== "https:" && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(issuer + "/")) throw 0; }
    catch { warn(`OIDC_${K}_ISSUER https URL hona chahiye — ye login band`); issuer = ""; }
    out[key] = {
      key, oidc: true, label: env[`OIDC_${K}_LABEL`] || K, icon: "🔐", flag: env[`OIDC_${K}_FLAG`] || "🌐",
      issuer, scope: "openid email profile", pkce: true, nonce: true,
      id: env[`OIDC_${K}_CLIENT_ID`], secret: env[`OIDC_${K}_CLIENT_SECRET`], ready: !!(issuer && env[`OIDC_${K}_CLIENT_ID`]),
    };
  }
  return out;
}

async function discover(p) {
  if (p.auth && p.discoveredAt > Date.now() - 6 * 3600_000) return;     // 6 ghante tak yaad
  const d = await getJson(p.issuer + "/.well-known/openid-configuration");
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error("discovery adhoori hai");
  p.auth = d.authorization_endpoint;
  p.token = d.token_endpoint;
  p.iss = [d.issuer || p.issuer];
  p.profile = d.userinfo_endpoint
    ? oidcInfo(d.userinfo_endpoint)
    : async (t, tr) => { const c = decodeJwt(tr.id_token); return { id: c.sub, email: c.email, emailVerified: truthy(c.email_verified), name: c.name }; };
  p.discoveredAt = Date.now();
}

async function readForm(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 64_000) break; }
  return Object.fromEntries(new URLSearchParams(s));
}

// ID token (provider ka signed parcha) ki jaanch. Token seedha provider se TLS par aaya hai,
// isliye signature ki jagah ye jaanch kaafi hai (OpenID Connect Core 3.1.3.7):
// kiske liye bana (aud), kisne banaya (iss), kab tak (exp), aur hamara nonce.
function checkIdToken(p, tr, nonce) {
  if (!tr.id_token) return null;
  const c = decodeJwt(tr.id_token);
  const now = Date.now() / 1000;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(p.id)) return "id_token kisi aur app ke liye hai";
  if (!c.exp || c.exp < now - 120) return "id_token purana ho gaya";
  if (p.iss && !p.iss.includes(c.iss)) return "id_token galat jagah se aaya";
  if (p.nonce && c.nonce !== undefined && c.nonce !== nonce) return "id_token ka nonce mel nahi khata";
  return null;
}

export function registerOAuth({ route, db, env = {}, secret, newToken, publicUser, HttpError, readJson, trustProxy, production, sendMail }) {
  const warn = (m) => console.warn("[login] " + m);
  const P = buildProviders(env, warn);

  // Kin providers ke verified email par bharosa karke purane account se jodna hai.
  // Default sirf woh jo email ki malkiyat pakki karte hain. Baaki ka naya alag account banta hai.
  const LINK = new Set(String(env.LINK_BY_EMAIL || "email,google,apple,github").split(",").map((x) => x.trim()).filter(Boolean));
  const MAIL_PER_HOUR = Number(env.MAIL_PER_EMAIL_HOUR) || 5;
  const MAIL_PER_DAY = Number(env.MAIL_DAILY_LIMIT) || 200;
  const NEW_PER_IP_HOUR = Number(env.NEW_ACCOUNTS_PER_IP_HOUR) || 20;

  const q = {
    identity: db.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?"),
    identityByEmail: db.prepare(`SELECT provider, user_id FROM identities WHERE email = ? ORDER BY created_at`),
    addIdentity: db.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    userByName: db.prepare("SELECT 1 FROM users WHERE username = ?"),
    insertUser: db.prepare("INSERT INTO users (username, display, pass_hash, created_at) VALUES (?, ?, '!', ?)"),
    codeGet: db.prepare("SELECT * FROM email_codes WHERE email = ?"),
    codeSet: db.prepare(`INSERT INTO email_codes (email, code_hash, expires_at, sent_at, tries) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, sent_at = excluded.sent_at, tries = 0`),
    codeTry: db.prepare("UPDATE email_codes SET tries = tries + 1 WHERE email = ?"),
    codeDel: db.prepare("DELETE FROM email_codes WHERE email = ?"),
    codeSweep: db.prepare("DELETE FROM email_codes WHERE expires_at < ?"),
    cntGet: db.prepare("SELECT n, reset_at FROM auth_counters WHERE key = ?"),
    cntSet: db.prepare(`INSERT INTO auth_counters (key, n, reset_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET n = excluded.n, reset_at = excluded.reset_at`),
    cntSweep: db.prepare("DELETE FROM auth_counters WHERE reset_at < ?"),
  };

  // Database me ginti (server restart par bhi yaad rehti hai). true = limit paar.
  function over(key, max, windowMs, peek = false) {
    const now = Date.now();
    const r = q.cntGet.get(key);
    const live = r && r.reset_at > now;
    const n = live ? r.n : 0;
    if (n >= max) return true;
    if (!peek) q.cntSet.run(key, n + 1, live ? r.reset_at : now + windowMs);
    return false;
  }
  const sweepDb = () => { const now = Date.now(); q.codeSweep.run(now - 3600_000); q.cntSweep.run(now); };

  // ---------- URL aur suraksha ----------
  const base = (req) => (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL ||
    `${(trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()) || "http"}://${req.headers.host}`).replace(/\/$/, "");
  const allowedOrigins = (req) => {
    const set = new Set([new URL(base(req)).origin]);
    for (const v of [env.APP_URL, env.CORS_ORIGIN]) {
      for (const s of String(v || "").split(",")) { try { set.add(new URL(s.trim()).origin); } catch {} }
    }
    return set;
  };
  const defaultRet = (req) => String(env.APP_URL || "").split(",")[0].trim() || base(req) + "/";
  // Login ke baad sirf apni hi site par wapas bhejo (doosri site par token kabhi nahi)
  const safeRet = (req, r) => {
    try {
      const u = new URL(r);
      const out = u.origin + u.pathname + u.search;
      if ((u.protocol === "https:" || u.protocol === "http:") && allowedOrigins(req).has(u.origin) && out.length <= 600) return out;
    } catch {}
    return defaultRet(req);
  };

  // Login ki "parchi" (state) server ki memory me nahi, signed cookie me — Render restart ho
  // jaaye tab bhi aadha login chalta rahe. Har login ki alag cookie, taaki do tab saath chal sakein.
  const sign = (d) => createHmac("sha256", secret).update("ym-oauth:" + d).digest("base64url");
  const pack = (o) => { const d = b64url(JSON.stringify(o)); return d + "." + sign(d); };
  const unpack = (v) => {
    const [d, sg] = String(v || "").split(".");
    if (!d || !sg) return null;
    const a = Buffer.from(sg), b = Buffer.from(sign(d));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try { return JSON.parse(Buffer.from(d, "base64url").toString()); } catch { return null; }
  };
  const cookieName = (state) => "ym_os_" + String(state).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  const cookie = (req, name, v, age) => `${name}=${v}; Path=/api/auth; Max-Age=${age}; HttpOnly; ` +
    (base(req).startsWith("https:") ? "Secure; SameSite=None" : "SameSite=Lax");
  const readCookie = (req, name) => {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || "");
    return m ? m[1] : null;
  };

  // ---------- naya ya purana user ----------
  function uniqueName(prof) {
    const src = (prof.email ? String(prof.email).split("@")[0] : "") || prof.name || "";
    let b = src.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 14);
    if (b.length < 3) b = (b || "user") + randomInt(100, 1000);
    if (!q.userByName.get(b)) return b;
    for (let i = 0; i < 20; i++) { const n = b + randomInt(100, 99999); if (!q.userByName.get(n)) return n; }
    return "user" + Date.now().toString(36);
  }
  // { user, created } ya { error }
  function findOrCreate(provider, prof, ip) {
    const subject = String(prof.id).slice(0, 255);
    const hit = q.identity.get(provider, subject);
    if (hit) { const u = q.userById.get(hit.user_id); if (u) return { user: u, created: false }; }
    const email = prof.emailVerified === true && prof.email ? String(prof.email).trim().toLowerCase().slice(0, 254) : null;
    // Purane account se tabhi jodo jab DONO taraf bharosemand provider ne email pakka kiya ho
    let uid = null;
    if (email && LINK.has(provider)) {
      const m = q.identityByEmail.all(email).find((r) => LINK.has(r.provider));
      if (m) uid = m.user_id;
    }
    if (!uid && over("new:" + (ip || "?"), NEW_PER_IP_HOUR, 3600_000)) {
      return { error: "Is network se bahut naye account ban chuke — 1 ghante baad try karo" };
    }
    db.exec("BEGIN");
    try {
      let created = false;
      if (!uid) {
        const username = uniqueName(prof);
        const display = String(prof.name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || username;
        uid = Number(q.insertUser.run(username, display, Date.now()).lastInsertRowid);
        created = true;
      }
      q.addIdentity.run(provider, subject, uid, email, Date.now());
      db.exec("COMMIT");
      if (created) console.log(`[login] naya account #${uid} (${provider})`);
      return { user: q.userById.get(uid), created };
    } catch (e) {
      db.exec("ROLLBACK");
      const again = q.identity.get(provider, subject);         // saath-saath do login: jo pehle bana wahi lo
      if (again) return { user: q.userById.get(again.user_id), created: false };
      throw e;
    }
  }

  // ---------- token lena ----------
  const authUrl = (p, redirect, state, challenge, nonce) => p.authUrl ? p.authUrl(p, redirect, state) :
    p.auth + "?" + ENC({ response_type: "code", client_id: p.id, redirect_uri: redirect, scope: p.scope, state,
      ...(p.pkce ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
      ...(p.nonce ? { nonce } : {}), ...(p.authExtra || {}) });

  async function exchange(p, code, redirect, verifier, state) {
    if (p.exchange) return p.exchange(p, code);
    const sec = p.key === "apple" ? appleSecret(env) : p.secret;
    const basic = p.tokenAuth === "basic";
    const params = { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: p.id,
      ...(basic ? {} : { client_secret: sec }), ...(p.pkce ? { code_verifier: verifier } : {}),
      ...(p.tokenState ? { state } : {}), ...(p.tokenExtra || {}) };
    const headers = basic ? { Authorization: "Basic " + Buffer.from(`${p.id}:${sec}`).toString("base64") } : {};
    if (p.tokenMethod === "GET") return getJson(p.token + "?" + ENC(params), { headers, noRetry: true });
    return getJson(p.token, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: ENC(params) });
  }

  // ---------- routes ----------
  const mailReady = !!sendMail || !!(env.RESEND_API_KEY && env.MAIL_FROM) || !production;

  // Shuru me hi galat settings bata do (login ke waqt achanak fail se behtar)
  if (production) {
    if (!env.PUBLIC_URL && !env.RENDER_EXTERNAL_URL) warn("PUBLIC_URL set nahi — callback URL galat ban sakta hai");
    if (!env.APP_URL) warn("APP_URL set nahi — login ke baad user server ke page par jayega");
    if (!mailReady) warn("RESEND_API_KEY / MAIL_FROM nahi — Email login band");
    const on = Object.values(P).filter((p) => p.ready).map((p) => p.key);
    console.log(`[login] chalu: ${[...on, ...(mailReady ? ["email"] : [])].join(", ") || "sirf username/password"}`);
  }

  route("GET", /^\/api\/auth\/providers$/, () => ({
    providers: Object.values(P).map((p) => ({ key: p.key, label: p.label, icon: p.icon, flag: p.flag, ready: p.ready })),
    email: mailReady,
  }));

  route("GET", /^\/api\/auth\/([a-z0-9_]+)\/start$/, async (req, m, url) => {
    const p = P[m[1]];
    const ret = safeRet(req, url.searchParams.get("return") || "");
    const err = (msg) => ({ redirect: ret + "#ym_error=" + encodeURIComponent(msg) });
    if (!p || !p.ready) return err("Ye login abhi chalu nahi hai");
    try { if (p.oidc) await discover(p); } catch (e) { warn(`${p.label} discovery fail: ${e.message}`); return err(`${p.label} se jud nahi paaye — thodi der baad try karo`); }
    const state = b64url(randomBytes(18)), verifier = b64url(randomBytes(32)), nonce = b64url(randomBytes(16));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const ticket = pack({ s: state, p: p.key, v: verifier, n: nonce, r: ret, e: Date.now() + 600_000 });
    return { redirect: authUrl(p, base(req) + `/api/auth/${p.key}/callback`, state, challenge, nonce), cookie: cookie(req, cookieName(state), ticket, 600) };
  }, { strict: true });

  const callback = async (req, m, url) => {
    const p = P[m[1]];
    const params = req.method === "POST" ? await readForm(req) : Object.fromEntries(url.searchParams);
    const name = params.state ? cookieName(params.state) : null;
    const st = name ? unpack(readCookie(req, name)) : null;
    const done = (frag) => ({ redirect: (st && st.r ? st.r : defaultRet(req)) + "#" + frag, cookie: name ? cookie(req, name, "", 0) : undefined });
    const fail = (msg) => done("ym_error=" + encodeURIComponent(msg));
    if (!p || !p.ready) return fail("Ye login abhi chalu nahi hai");
    if (!st) return fail("Login usi browser me poora karo jisme shuru kiya tha (ya samay khatam ho gaya)");
    if (st.s !== params.state || st.p !== p.key || !(st.e > Date.now())) return fail("Login ka samay khatam ho gaya — dobara try karo");
    if (params.error || !params.code) return fail("Login cancel ho gaya");
    let prof;
    try {
      if (p.oidc) await discover(p);
      const tr = await exchange(p, String(params.code).slice(0, 2048), base(req) + `/api/auth/${p.key}/callback`, st.v, params.state);
      const bad = checkIdToken(p, tr, st.n);
      if (bad) { warn(`${p.key}: ${bad}`); return fail(`${p.label} ka jawab sahi nahi laga — dobara try karo`); }
      prof = await p.profile(tr.access_token, tr, { p, extra: params });
    } catch (e) {
      warn(`${p.key} fail: ${e.message}`);
      return fail(`${p.label} se login nahi hua — dobara try karo`);
    }
    if (!prof || prof.id === undefined || prof.id === null || prof.id === "") return fail(`${p.label} ne account ki jaankari nahi di`);
    if (prof.emailVerified === false) return fail(`Pehle apna ${p.label} account/email verify karo, phir login karo`);
    const r = findOrCreate(p.key, prof, req._ip);
    if (r.error) return fail(r.error);
    return done("ym_token=" + newToken(r.user) + (r.created ? "&ym_new=1" : ""));
  };
  route("GET", /^\/api\/auth\/([a-z0-9_]+)\/callback$/, callback);
  route("POST", /^\/api\/auth\/([a-z0-9_]+)\/callback$/, callback);   // Apple POST se wapas aata hai

  // ---------- Email: 6 ankon ka code ----------
  const normEmail = (v) => {
    const e = String(v || "").trim().toLowerCase();
    if (e.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpError(400, "Sahi email likho");
    return e;
  };
  const codeHash = (email, code) => createHmac("sha256", secret).update(email + ":" + code).digest("hex");
  async function deliver(to, code) {
    if (sendMail) return sendMail(to, code);
    if (env.RESEND_API_KEY && env.MAIL_FROM) {
      await getJson("https://api.resend.com/emails", {
        method: "POST", headers: { ...bearer(env.RESEND_API_KEY), "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: `YouMe login code: ${code}`,
          text: `Tumhara YouMe login code: ${code}\n\nYe 10 minute tak chalega. Agar tumne nahi maanga to is email ko ignore karo.` }),
      });
      return;
    }
    console.log(`[DEV — email set nahi] ${to} ka login code: ${code}`);
  }

  route("POST", /^\/api\/auth\/email\/start$/, async (req) => {
    if (!mailReady) throw new HttpError(503, "Email login abhi chalu nahi hai");
    const email = normEmail((await readJson(req)).email);
    sweepDb();
    const row = q.codeGet.get(email);
    if (row && row.sent_at > Date.now() - 60_000) throw new HttpError(429, "Code abhi bheja hai — 1 minute baad dobara mangao");
    // Spam se bachav: ek email par ghante me 5, poore server par din me 200 (badal sakte ho)
    if (over("mail:" + email, MAIL_PER_HOUR, 3600_000, true)) throw new HttpError(429, "Is email par bahut code bhej chuke — 1 ghante baad try karo");
    if (over("mail:day", MAIL_PER_DAY, 86_400_000, true)) {
      warn(`aaj ki email limit (${MAIL_PER_DAY}) poori — MAIL_DAILY_LIMIT badhao`);
      throw new HttpError(503, "Aaj email login ki limit poori ho gayi — kal try karo ya doosra tareeka chuno");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    q.codeSet.run(email, codeHash(email, code), Date.now() + 600_000, Date.now());
    try { await deliver(email, code); }
    catch (e) { q.codeDel.run(email); warn("email fail: " + e.message); throw new HttpError(502, "Email nahi gaya — thodi der baad try karo"); }
    over("mail:" + email, MAIL_PER_HOUR, 3600_000);
    over("mail:day", MAIL_PER_DAY, 86_400_000);
    return { ok: true };
  }, { strict: true });

  route("POST", /^\/api\/auth\/email\/verify$/, async (req) => {
    const b = await readJson(req);
    const email = normEmail(b.email);
    const code = String(b.code || "").replace(/\D/g, "");
    const row = q.codeGet.get(email);
    if (!row || row.expires_at < Date.now()) throw new HttpError(400, "Code khatam ho gaya — naya code mangao");
    if (row.tries >= 5) { q.codeDel.run(email); throw new HttpError(429, "Bahut galat koshish — naya code mangao"); }
    if (code.length !== 6 || !timingSafeEqual(Buffer.from(codeHash(email, code)), Buffer.from(row.code_hash))) {
      q.codeTry.run(email);
      throw new HttpError(400, "Code galat hai");
    }
    q.codeDel.run(email);
    const r = findOrCreate("email", { id: email, email, emailVerified: true, name: email.split("@")[0] }, req._ip);
    if (r.error) throw new HttpError(429, r.error);
    return { token: newToken(r.user), user: publicUser(r.user), created: r.created };
  }, { strict: true });
}
