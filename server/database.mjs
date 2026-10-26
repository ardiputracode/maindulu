import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { acquireDataLock } from './data-lock.mjs'
import { canonicalPath } from './config.mjs'

const migrations = [
  {
    version: 1,
    name: 'application-metadata',
    sql: `CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;`,
  },
  {
    version: 2,
    name: 'local-accounts-and-sessions',
    sql: `CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      recovery_code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE INDEX sessions_expiry ON sessions(expires_at);`,
  },
  {
    version: 3,
    name: 'manual-server-states',
    sql: `CREATE TABLE saves (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL, console_id TEXT NOT NULL, core TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
      title TEXT NOT NULL, metadata TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      size INTEGER NOT NULL CHECK(size >= 0), checksum TEXT NOT NULL,
      blob_key TEXT, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, game_id, console_id, core, slot)
    ) STRICT;
    CREATE INDEX saves_owner ON saves(user_id);`,
  },
  {
    version: 4,
    name: 'autosave-slot',
    // The dedicated Autosave state shares the saves table under slot 99.
    // SQLite cannot alter a CHECK constraint, so the table is rebuilt.
    sql: `CREATE TABLE saves_v4 (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL, console_id TEXT NOT NULL, core TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK(slot = 99 OR slot BETWEEN 1 AND 3),
      title TEXT NOT NULL, metadata TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      size INTEGER NOT NULL CHECK(size >= 0), checksum TEXT NOT NULL,
      blob_key TEXT, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, game_id, console_id, core, slot)
    ) STRICT;
    INSERT INTO saves_v4 (id, user_id, game_id, console_id, core, slot, title, metadata, revision, size, checksum, blob_key, updated_at)
      SELECT id, user_id, game_id, console_id, core, slot, title, metadata, revision, size, checksum, blob_key, updated_at FROM saves;
    DROP TABLE saves;
    ALTER TABLE saves_v4 RENAME TO saves;
    CREATE INDEX saves_owner ON saves(user_id);`,
  },
  {
    version: 5,
    name: 'automatic-game-saves',
    sql: `CREATE TABLE game_saves (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL, console_id TEXT NOT NULL, core TEXT NOT NULL,
      title TEXT NOT NULL, metadata TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      size INTEGER NOT NULL CHECK(size >= 0), checksum TEXT NOT NULL,
      blob_key TEXT, updated_at INTEGER NOT NULL,
      UNIQUE(user_id, game_id, console_id, core)
    ) STRICT;
    CREATE INDEX game_saves_owner ON game_saves(user_id);`,
  },
  {
    version: 6,
    name: 'explicit-save-decisions-and-backups',
    sql: `CREATE TABLE save_backups (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('state', 'progress')),
      game_id TEXT NOT NULL, console_id TEXT NOT NULL, core TEXT NOT NULL,
      slot INTEGER NOT NULL, title TEXT NOT NULL, metadata TEXT NOT NULL,
      source_revision INTEGER, size INTEGER NOT NULL CHECK(size > 0),
      checksum TEXT NOT NULL, blob_key TEXT NOT NULL,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX save_backups_owner ON save_backups(user_id);
    CREATE INDEX save_backups_blob ON save_backups(kind, blob_key);
    CREATE TABLE save_decisions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(user_id, operation_id)
    ) STRICT;`,
  },
  {
    version: 7,
    name: 'account-roles',
    sql: `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'));`,
  },
]

export const schemaVersion = migrations.at(-1).version

export async function openDatabase(dataDir) {
  dataDir = await canonicalPath(resolve(dataDir))
  await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 })
  const release = await acquireDataLock(dataDir)
  let db
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    db = new DatabaseSync(join(dataDir, 'maindulu.sqlite'))
  } catch (error) { release(); throw error }
  const close = db.close.bind(db)
  db.close = () => { close(); release() }
  db[Symbol.dispose] = () => { if (db.isOpen) db.close() }
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    db.exec('BEGIN IMMEDIATE')
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version > migrations.at(-1).version) throw new Error('Versi database lebih baru daripada aplikasi. Gunakan versi aplikasi yang sesuai; jangan hapus database.')
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;`)
      for (const migration of migrations.filter(m => m.version > version)) {
        db.exec(migration.sql)
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString())
        db.exec(`PRAGMA user_version = ${migration.version}`)
      }
      const put = db.prepare('INSERT OR IGNORE INTO app_metadata (key, value) VALUES (?, ?)')
      put.run('installation_id', randomUUID())
      put.run('created_at', new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
