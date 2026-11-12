import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Har migration ek baar chalti hai; PRAGMA user_version me yaad rehta hai ki kahan tak ho chuki.
// Naya badlav chahiye to list ke END me ek aur string jodo — purani kabhi mat badlo.
const MIGRATIONS = [
  // 1: shuruaati tables
  `
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY,
    username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display    TEXT NOT NULL,
    pass_hash  TEXT NOT NULL,
    coins      INTEGER NOT NULL DEFAULT 0,
    last_bonus TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE posts (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL DEFAULT '',
    media      TEXT NOT NULL DEFAULT '',
    img        TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX posts_created ON posts(created_at DESC);
  CREATE TABLE likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE replies (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX replies_post ON replies(post_id, created_at);
  CREATE TABLE hides (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE affinity (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score     REAL NOT NULL,
    PRIMARY KEY (user_id, author_id)
  );
  `,
  // 2: safety — recovery code, token version, block, report, DM
  `
  ALTER TABLE users ADD COLUMN recovery_hash TEXT;
  ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE blocks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, blocked_id)
  );
  CREATE TABLE reports (
    id          INTEGER PRIMARY KEY,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (reporter_id, post_id)
  );
  CREATE INDEX reports_post ON reports(post_id);
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY,
    from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at    INTEGER
  );
  CREATE INDEX messages_pair ON messages(from_id, to_id, id);
  CREATE INDEX messages_to ON messages(to_id, read_at);
  `,
  // 3: coins ka rozana hisab alag table me (post delete karke dobara coins kamane se bachav)
  `
  CREATE TABLE reward_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    kind    TEXT NOT NULL,
    n       INTEGER NOT NULL,
    PRIMARY KEY (user_id, day, kind)
  );
  `,
];

export function openDb(file = ":memory:") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

  let v = db.prepare("PRAGMA user_version").get().user_version;
  // Purana (migration system se pehle ka) database: tables hain par user_version 0 hai
  if (v === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) {
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    v = cols.includes("recovery_hash") ? 2 : 1;  // (3 sirf nayi DB me hota hai)
    db.exec(`PRAGMA user_version = ${v}`);
  }
  for (; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${v + 1} fail hui: ${e.message}`);
    }
  }
  return db;
}

/** Chalte database ki surakshit copy (server band kiye bina). */
export function backupTo(db, destFile) {
  if (/['\0]/.test(destFile)) throw new Error("Galat file naam");
  mkdirSync(dirname(destFile), { recursive: true });
  db.exec(`VACUUM INTO '${destFile}'`);
}
