import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

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
]

export async function openDatabase(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dataDir, 'maindulu.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
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
