# Kaam karne ka tareeka

```bash
npm test                 # sab tests (server + frontend ke jaanch)
python3 e2e/e2e.py       # asli Chrome me poora flow (playwright + Chrome chahiye, optional)
```

1. `main` par seedha push mat karo — nayi branch banao, Pull Request (GitHub) / Merge Request (GitLab) kholo.
2. Pipeline hari hone par hi merge karo.
3. Naya feature = uske test bhi.
4. **Database badalna ho** to `server/db.js` ki `MIGRATIONS` list me END me ek nayi entry jodo. Purani entry kabhi mat badlo — wo chal chuki hain.
5. `.env`, `*.db`, `backups/` kabhi commit mat karo (`.gitignore` me hain).
6. Naya package mat jodo jab tak zaroori na ho — abhi sab zero-dependency hai, wahi isko halka aur surakshit rakhta hai.
