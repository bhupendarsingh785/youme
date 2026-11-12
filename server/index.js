import { randomBytes } from "node:crypto";
import { openDb } from "./db.js";
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
});

const port = Number(env.PORT) || 3000;
server.listen(port, () => console.log(`YouMe server chal raha hai: http://localhost:${port}`));

function shutdown() {
  console.log("band ho raha hai…");
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
