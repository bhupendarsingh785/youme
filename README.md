# YouMe

Feed, reels, DM aur wallet wali social app. Backend **zero dependency** hai: sirf Node.js 22+ (built-in `node:http` aur `node:sqlite`). `npm install` ki zaroorat nahi.

## Chalane ka tareeka

```bash
npm start            # http://localhost:3000
npm run dev          # code badalne par apne aap restart
npm test             # 36 tests (server + frontend ki jaanch)
npm run backup       # database ki surakshit copy -> backups/
python3 e2e/e2e.py   # (optional) asli Chrome me poora flow — playwright + Chrome chahiye
```

Browser me `http://localhost:3000` kholo — login screen aayegi. Backend na mile (jaise `public/index.html` seedha file se khola) to app purane "sirf is phone me" mode me chalti hai.

## Kya-kya hai

- **Account:** signup/login, **recovery code** (email ke bina password wapas pane ke liye), password badlo, sab device logout, account delete.
- **Feed:** server par ranking (taaza-pan, trending, tumhari pasand, mehnat, naya creator, variety). Har post par "💡 kyun dikha".
- **Post:** text, photo (Lens camera se), like, reply, share, "kam dikhao", apna post delete.
- **Safety:** report (3 alag logon ke baad post sabse chhup jaata hai), block (dono taraf se feed/DM/reply band), rate limit, login lockout.
- **DM:** server wale, unread ginti, 4 second me naye message. "YouMe AI" chat abhi bhi local/demo.
- **Coins:** sirf mehnat par (post +5, photo +8, reply +1, roz +2) rozana limit ke saath; delete karke dobara kamana nahi chalta.
- **Privacy / Terms:** `public/privacy.html`, `public/terms.html` (shuruaati template — public karne se pehle vakil se dikhwao aur `[apna email]` badlo).

## Folder

| Jagah | Kaam |
|---|---|
| `server/app.js` | API routes, rate limit, security headers, static files |
| `server/feed.js` | Feed ranking algorithm (pure functions) |
| `server/auth.js` | Password hash (scrypt), signed token, recovery code |
| `server/db.js` | SQLite tables + migrations + backup |
| `server/index.js` | Server shuru karna, env variables, apne aap backup |
| `scripts/backup.js` | `npm run backup` |
| `public/` | Frontend (`index.html`), privacy/terms, manifest |
| `test/` | `node:test` tests |
| `e2e/` | Chrome wala end-to-end test (optional) |

## API

Login ke baad har request me header: `Authorization: Bearer <token>`.

| Method | Path | Kaam |
|---|---|---|
| POST | `/api/signup`, `/api/login` | `{username, password, display?}` → `{token, user, recoveryCode?}` |
| POST | `/api/recover` | `{username, recoveryCode, newPassword}` → naya token + **naya** recovery code |
| POST | `/api/password` | `{current, next}` — baaki device logout |
| POST | `/api/recovery-code` | `{password}` → naya recovery code |
| POST | `/api/logout-all`, `/api/delete-account` | Sab device logout / account delete (`{password}`) |
| GET | `/api/me` | Profile, coins, unread DM |
| POST | `/api/daily` | Roz ka bonus |
| GET | `/api/feed` | Tumhare liye ranked posts (har post me `why`) |
| POST | `/api/posts` | `{text, media?, img?}` — img: jpeg/png/webp data URL, max ~1.5MB |
| GET / DELETE | `/api/posts/:id` | Post + replies / apna post delete |
| POST | `/api/posts/:id/like` `/replies` `/hide` `/share` `/report` | Like toggle, jawab, kam dikhao, share, report (`{reason}`) |
| POST | `/api/reset-interests` | Algorithm ki seekhi hui pasand saaf |
| GET | `/api/users?q=` | Username khoj (prefix) |
| POST | `/api/users/:name/block` `/unblock` | Block / unblock |
| GET | `/api/blocks` | Block kiye hue log |
| GET | `/api/conversations` | DM list + unread |
| GET | `/api/messages/:name?after=ID` | Chat ke message (padhne par unread saaf) |
| POST | `/api/messages` | `{to, text}` |
| GET | `/api/health` | Zinda hai ya nahi |

## Environment variables

`.env.example` dekho. **Production me `JWT_SECRET` zaroori hai** (`openssl rand -hex 32`), warna server chalega hi nahi. `BACKUP_DIR` set karo to server khud har 24 ghante backup banata hai (aakhri 7 rakhta hai).

## Database badalna

`server/db.js` ki `MIGRATIONS` list me **end me** nayi entry jodo. Purani entry kabhi mat badlo. Server shuru hote hi baaki migrations apne aap chal jaati hain, puraane data ko chhue bina.

## Docker

```bash
docker build -t youme .
docker run -p 3000:3000 -v youme-data:/data -e JWT_SECRET=$(openssl rand -hex 32) youme
```

`/data` volume zaroor jodo — database wahin rehta hai.

## GitHub / GitLab

Dono ke pipelines ready hain, jo platform use karo wahi chalega:

- **GitHub:** `.github/workflows/ci.yml` — har push/PR par tests; `main` par image `ghcr.io/<tum>/<repo>` me jaati hai. Dependabot, PR aur issue template bhi hain.
- **GitLab:** `.gitlab-ci.yml` — har merge request / default branch par tests; default branch par image GitLab Container Registry me jaati hai. MR aur issue template bhi hain.

Pehli baar push:

```bash
git remote add origin <repo-ka-URL>
git push -u origin main
```

> Pipelines abhi tak asli GitHub/GitLab par chalaye nahi gaye hain (yahan sirf local par tests chalaye). Pehle push ke baad Actions / CI tab me dekh lena. `main` ko "protected" karke PR/MR zaroori kar dena (GitHub: Settings → Branches; GitLab: Settings → Repository → Protected branches).

## Abhi baaki / dhyan rakhne wali baatein

- **Photo database me hi save hoti hai** (base64). Chhote scale par theek hai; users badhein to object storage (S3/R2) par le jao.
- **SQLite ek server par** hi chalta hai. Kai servers chahiye to Postgres par jao; rate limit bhi tab Redis me.
- **Reels aur stories abhi demo/seed** hain (video upload nahi). "YouMe AI" ke jawab pollinations.ai se aate hain.
- **Coins demo** hain — asli paisa/UPI/Razorpay abhi nahi juda.
- **DM encrypted nahi** hain (server dekh sakta hai) — privacy page me likha hai.
- Password/recovery code badalte waqt abhi browser ka `prompt()` use hota hai (password dikhta hai). Alag form baad me.
- Koi admin panel nahi: report hui posts dekhne ke liye database me `reports` table dekho.
- `LICENSE` file tumhari marzi ki hai — abhi koi license nahi daala.
