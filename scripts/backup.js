// Database ki surakshit copy:  npm run backup            -> backups/youme-<tarikh>.db
//                              npm run backup -- /path/x.db
import { openDb, backupTo } from "../server/db.js";

const src = process.env.DB_PATH || "data/youme.db";
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const dest = process.argv[2] || `backups/youme-${stamp}.db`;

const db = openDb(src);
backupTo(db, dest);
db.close();
console.log(`Backup ban gaya: ${dest}`);
