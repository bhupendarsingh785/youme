# YouMe — poora setup (jo maine joda aur set kiya)

## Kya-kya maine joda

### 1. Backend (tumhara code) — Render par live
- URL: https://youme-api.onrender.com
- Health: https://youme-api.onrender.com/api/health  → `{"ok":true}`
- `render.yaml` — maine banaya (ek-click deploy ke liye): Node 22, health check, `JWT_SECRET` auto, `CORS_ORIGIN` set

### 2. Frontend ko backend se jodna
`public/index.html` me `API_BASE`:
- `?api=...` ya `localStorage['ym.api']` se badal sakte ho
- GitHub Pages par khule to apne aap `https://youme-api.onrender.com` use karta hai
- Wahi server par khule to same-origin

### 3. GitHub Pages deploy (`.github/workflows/pages.yml`)
- Sirf `public/` folder deploy hota hai
- Link: https://bhupendarsingh785.github.io/youme/
- Cache se bachne ke liye alag file: `/youme/app.html`

### 4. CI (`.github/workflows/ci.yml`)
- Node 22 par 36 tests
- Docker image bhi banti hai (ghcr.io)

## Sab kuch chalanе ka tareeka

**Local:**
```bash
npm start        # http://localhost:3000
npm test         # 36 tests
```

**Live:**
- Frontend: https://bhupendarsingh785.github.io/youme/
- Backend: https://youme-api.onrender.com

## Zaroori sach
- Render free plan: 15 min inactive → server so jata hai (pehla load 30-50 sec)
- Render free plan par disk temporary → server restart par data ja sakta hai ($7/mo disk se pakka)
- GitHub Pages sirf frontend chalata hai, backend nahi
- `public/index.html` = online (server), `youme-2.html` = offline (sirf phone)

## JWT_SECRET
Render khud banata hai (`generateValue: true`). Manually dena ho to:
Service → Environment → `JWT_SECRET` → Save
