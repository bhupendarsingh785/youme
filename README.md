# YouMe

Feed, reels, DM aur wallet wali social app. Backend **zero dependency** hai: sirf Node.js 22+ (built-in `node:http` aur `node:sqlite`). `npm install` ki zaroorat nahi.

## Chalane ka tareeka

```bash
npm start            # http://localhost:3000
npm run dev          # code badalne par apne aap restart
npm test             # 14 tests
```

Browser me `http://localhost:3000` kholo — login screen aayegi. Backend na mile (jaise `public/index.html` seedha file se khola) to app purane "sirf is phone me" mode me chalti hai.

## Folder

| Jagah | Kaam |
|---|---|
| `server/app.js` | API routes, rate limit, static files |
| `server/feed.js` | Feed ranking algorithm (pure functions) |
| `server/auth.js` | Password hash (scrypt) aur signed login token |
| `server/db.js` | SQLite tables |
| `server/index.js` | Server shuru karna, env variables |
| `public/` | Frontend (`index.html`) |
| `test/` | `node:test` tests |

## API

Login ke baad har request me header: `Authorization: Bearer <token>`.

| Method | Path | Kaam |
|---|---|---|
| POST | `/api/signup`, `/api/login` | `{username, password, display?}` → `{token, user}` |
| GET | `/api/me` | Apna profile + coins |
| GET | `/api/feed` | Tumhare liye ranked posts (har post me `why`) |
| POST | `/api/posts` | `{text, media?, img?}` — img: jpeg/png/webp data URL, max ~1.5MB |
| GET | `/api/posts/:id` | Post + replies |
| POST | `/api/posts/:id/like` | Toggle like |
| POST | `/api/posts/:id/replies` | `{text}` |
| POST | `/api/posts/:id/hide`, `/share` | "Kam dikhao" / share signal |
| POST | `/api/daily` | Roz ka bonus (+2) |
| POST | `/api/reset-interests` | Algorithm ki seekhi hui pasand saaf |
| GET | `/api/health` | Zinda hai ya nahi |

## Algorithm kaise chalta hai

Har post ko score milta hai: **taaza-pan** + **trending** (likes, replies) + **tumhari pasand** (jis creator ko like/reply/share kiya) + **mehnat** (photo, lamba text) + **naya creator bonus** + thoda random. Ek hi creator lagatar nahi aata. Coins sirf mehnat par: post +5, photo +8, reply +1, roz aane par +2 — rozana limit ke saath (10 post, 30 reply), taaki spam se coins na bane.

## Environment variables

`.env.example` dekho. **Production me `JWT_SECRET` zaroori hai** (`openssl rand -hex 32`), warna server chalega hi nahi.

## Docker

```bash
docker build -t youme .
docker run -p 3000:3000 -v youme-data:/data -e JWT_SECRET=$(openssl rand -hex 32) youme
```

`/data` volume zaroor jodo — database wahin rehta hai.

## GitHub / GitLab

Dono ke pipelines ready hain, jo platform use karo wahi chalega:

- **GitHub:** `.github/workflows/ci.yml` — har push/PR par tests; `main` par image `ghcr.io/<tum>/<repo>` me jaati hai.
- **GitLab:** `.gitlab-ci.yml` — har merge request / default branch par tests; default branch par image GitLab Container Registry me jaati hai.

Pehli baar push:

```bash
git remote add origin <repo-ka-URL>
git push -u origin main
```

> Pipelines abhi tak asli GitHub/GitLab par chalaye nahi gaye hain. Pehle push ke baad Actions / CI tab me dekh lena.

## Abhi ka dhyan rakhne wali baatein

- **Photo database me hi save hoti hai** (base64). Chhote scale par theek hai; users badhein to object storage (S3/R2) par le jao.
- **SQLite ek server par** hi chalta hai. Kai servers chahiye to Postgres par jao.
- **Reels, stories aur DM abhi bhi local/demo** hain (seed data). DM ka AI jawab pollinations.ai se aata hai.
- **Coins demo hain** — asli paisa/UPI/Razorpay abhi nahi juda.
- Password bhoolne par reset (email/OTP) abhi nahi hai.
- Rate limit memory me hai (ek server ke liye).
