import { randomBytes } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { openDb, backupTo } from "./db.js";
import { createApp } from "./app.js";

const env = process.env;
const production = env.NODE_ENV === "production";

let secret = env.JWT_SECRET;
if (!secret) {
  if (production) {
    console.error("JWT_SECRET set karo (production me zaroori hai). Banane ke liye: openssl rand -hex 32");
    process.exit(1);
  }
  secret = randomBytes(32).toString("hex");
  console.warn("JWT_SECRET set nahi hai — is baar ke liye random bana; restart par sab logout ho jayenge.");
}

const db = openDb(env.DB_PATH || "data/youme.db");
const server = createApp({
  db,
  secret,
  corsOrigin: env.CORS_ORIGIN || "*",
  trustProxy: env.TRUST_PROXY === "1",
  hsts: env.HSTS === "1",
  log: true,
});

// Apne aap backup: BACKUP_DIR set karo. Har BACKUP_EVERY_HOURS (default 24) ghante me, aakhri BACKUP_KEEP (default 7) rakhta hai.
if (env.BACKUP_DIR) {
  const every = (Number(env.BACKUP_EVERY_HOURS) || 24) * 3600_000;
  const keep = Number(env.BACKUP_KEEP) || 7;
  const runBackup = () => {
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      backupTo(db, `${env.BACKUP_DIR}/youme-${stamp}.db`);
      const old = readdirSync(env.BACKUP_DIR).filter((f) => /^youme-.*\.db$/.test(f)).sort().slice(0, -keep);
      for (const f of old) rmSync(`${env.BACKUP_DIR}/${f}`);
      console.log("backup ho gaya");
    } catch (e) { console.error("backup fail:", e.message); }
  };
  runBackup();
  setInterval(runBackup, every).unref();
}

const port = Number(env.PORT) || 3000;
server.listen(port, () => console.log(`YouMe server chal raha hai: http://localhost:${port}`));

function shutdown() {
  console.log("band ho raha hai…");
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
