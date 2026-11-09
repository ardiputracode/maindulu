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
  {
    version: 8,
    name: 'persistent-game-and-bios-catalogs',
    sql: `CREATE TABLE games (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      console_id TEXT NOT NULL CHECK(console_id IN ('nes', 'snes', 'gb', 'gba', 'megadrive', 'psx')),
      description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 10000),
      license TEXT NOT NULL DEFAULT '' CHECK(length(license) <= 2000),
      original_name TEXT NOT NULL CHECK(length(original_name) BETWEEN 1 AND 240),
      storage_key TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 805306368),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
      cover_storage_key TEXT UNIQUE,
      cover_type TEXT,
      cover_size INTEGER,
      cover_sha256 TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      UNIQUE(console_id, sha256),
      CHECK((cover_storage_key IS NULL AND cover_type IS NULL AND cover_size IS NULL AND cover_sha256 IS NULL)
        OR (cover_storage_key IS NOT NULL AND cover_type IS NOT NULL AND cover_size IS NOT NULL AND cover_sha256 IS NOT NULL
          AND cover_type IN ('image/png', 'image/jpeg', 'image/webp') AND cover_size BETWEEN 1 AND 8388608
          AND length(cover_sha256) = 64 AND cover_sha256 NOT GLOB '*[^a-f0-9]*'))
    ) STRICT;
    CREATE INDEX games_active_console ON games(console_id, created_at DESC, id) WHERE deleted_at IS NULL;
    CREATE TABLE bios (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      console_id TEXT NOT NULL CHECK(console_id IN ('nes', 'snes', 'gb', 'gba', 'megadrive', 'psx')),
      description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 10000),
      distribution_rights TEXT NOT NULL DEFAULT '' CHECK(length(distribution_rights) <= 2000),
      original_name TEXT NOT NULL CHECK(length(original_name) BETWEEN 1 AND 240),
      storage_key TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 33554432),
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      UNIQUE(console_id, sha256)
    ) STRICT;
    CREATE INDEX bios_active_console ON bios(console_id, created_at DESC, id) WHERE deleted_at IS NULL;`,
  },
  {
    version: 9,
    name: 'catalog-upload-reservations-and-cleanup',
    sql: `CREATE TABLE catalog_cleanup (
      folder TEXT NOT NULL CHECK(folder IN ('games', 'bios', 'covers')),
      storage_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(folder, storage_key)
    ) STRICT;
    CREATE TABLE catalog_uploads (
      id TEXT PRIMARY KEY NOT NULL,
      reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes > 0),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE catalog_capacity (
      id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL
    ) STRICT;
    INSERT INTO catalog_capacity VALUES (1, 0);`,
  },
  {
    version: 10,
    name: 'screenscraper-metadata-provenance-jobs-cache-revision',
    sql: `CREATE TABLE game_metadata (
      game_id TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      release_date TEXT CHECK(release_date IS NULL OR length(release_date) BETWEEN 1 AND 32),
      release_precision TEXT CHECK(release_precision IS NULL OR release_precision IN ('year', 'month', 'day')),
      genre TEXT NOT NULL DEFAULT '' CHECK(length(genre) <= 200),
      developer TEXT NOT NULL DEFAULT '' CHECK(length(developer) <= 200),
      publisher TEXT NOT NULL DEFAULT '' CHECK(length(publisher) <= 200),
      players TEXT NOT NULL DEFAULT '' CHECK(length(players) <= 32),
      region_language TEXT NOT NULL DEFAULT '' CHECK(length(region_language) <= 64),
      provider_game_id TEXT CHECK(provider_game_id IS NULL OR length(provider_game_id) BETWEEN 1 AND 64),
      match_method TEXT CHECK(match_method IS NULL OR match_method IN ('hash', 'name', 'game_id', 'manual')),
      fetched_at INTEGER,
      applied_at INTEGER,
      metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK(metadata_revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE game_metadata_field_sources (
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      field TEXT NOT NULL CHECK(field IN ('title', 'description', 'release_date', 'genre', 'developer', 'publisher', 'players', 'region_language', 'cover')),
      source TEXT NOT NULL CHECK(source IN ('filename', 'manual', 'screenscraper')),
      locked INTEGER NOT NULL CHECK(locked IN (0, 1)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(game_id, field)
    ) STRICT;
    CREATE INDEX game_metadata_field_sources_game ON game_metadata_field_sources(game_id);
    CREATE TABLE metadata_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      asset_fingerprint TEXT NOT NULL CHECK(length(asset_fingerprint) BETWEEN 1 AND 256),
      generation INTEGER NOT NULL CHECK(generation > 0),
      phase TEXT NOT NULL CHECK(phase IN ('identifying', 'lookup', 'cover', 'apply')),
      status TEXT NOT NULL CHECK(status IN ('disabled', 'queued', 'running', 'retry_wait', 'paused', 'needs_review', 'succeeded', 'not_found', 'unsupported', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      next_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_expires_at INTEGER,
      error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(game_id, generation)
    ) STRICT;
    CREATE INDEX metadata_jobs_status_next ON metadata_jobs(status, next_at);
    CREATE INDEX metadata_jobs_game ON metadata_jobs(game_id, generation);
    CREATE TABLE provider_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      system_id TEXT NOT NULL CHECK(length(system_id) BETWEEN 1 AND 32),
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) BETWEEN 1 AND 256),
      preference_key TEXT NOT NULL CHECK(length(preference_key) BETWEEN 1 AND 128),
      normalization_version INTEGER NOT NULL CHECK(normalization_version > 0),
      payload TEXT NOT NULL CHECK(length(payload) BETWEEN 1 AND 2097152),
      expires_at INTEGER NOT NULL,
      negative INTEGER NOT NULL CHECK(negative IN (0, 1)),
      size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX provider_cache_expires ON provider_cache(expires_at);
    CREATE TABLE catalog_revision (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      revision INTEGER NOT NULL CHECK(revision > 0)
    ) STRICT;
    INSERT INTO catalog_revision VALUES (1, 1);`,
  },
  {
    version: 11,
    name: 'metadata-job-candidates',
    sql: `ALTER TABLE metadata_jobs ADD COLUMN candidate_json TEXT CHECK(candidate_json IS NULL OR length(candidate_json) BETWEEN 1 AND 2097152);
    ALTER TABLE metadata_jobs ADD COLUMN candidate_at INTEGER;`,
  },
  {
    version: 12,
    name: 'conservative-upload-title-provenance',
    // M3 labelled explicit admin-upload titles as filename. No UI/server
    // filename fallback existed before M5: lock these historical titles.
    sql: `UPDATE game_metadata_field_sources SET source = 'manual', locked = 1 WHERE field = 'title' AND source = 'filename';`,
  },
  {
    version: 13,
    name: 'metadata-review-requests-and-shared-provider-gate',
    sql: `ALTER TABLE metadata_jobs ADD COLUMN request_method TEXT NOT NULL DEFAULT 'hash' CHECK(request_method IN ('hash', 'name', 'apply'));
    ALTER TABLE metadata_jobs ADD COLUMN request_json TEXT CHECK(request_json IS NULL OR length(request_json) <= 4096);
    CREATE TABLE metadata_provider_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      lease_token TEXT,
      lease_expires_at INTEGER,
      next_at INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT
    ) STRICT;
    INSERT INTO metadata_provider_state(id) VALUES (1);`,
  },
  {
    version: 14,
    name: 'platform-original-filename-storage',
    // Ownership tokens remain immutable even when a physical filename is reused.
    // Operational mapping is normalized away in metadata-only backup snapshots.
    sql: `CREATE TABLE catalog_asset_files (
      storage_key TEXT PRIMARY KEY,
      folder TEXT NOT NULL CHECK(folder IN ('games', 'bios')),
      platform TEXT NOT NULL CHECK(platform IN ('nes', 'snes', 'gb', 'gbc', 'gba', 'genesis', 'psx')),
      file_name TEXT NOT NULL,
      name_identity TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'ready', 'deleting')),
      UNIQUE(folder, platform, name_identity)
    ) STRICT;`,
  },
  {
    version: 15,
    name: 'chd-serial-match-provenance',
    // SQLite cannot alter a CHECK constraint; rebuild the small metadata table.
    // No indexes reference game_metadata, so only columns and rows are copied.
    sql: `CREATE TABLE game_metadata_v15 (
      game_id TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      release_date TEXT CHECK(release_date IS NULL OR length(release_date) BETWEEN 1 AND 32),
      release_precision TEXT CHECK(release_precision IS NULL OR release_precision IN ('year', 'month', 'day')),
      genre TEXT NOT NULL DEFAULT '' CHECK(length(genre) <= 200),
      developer TEXT NOT NULL DEFAULT '' CHECK(length(developer) <= 200),
      publisher TEXT NOT NULL DEFAULT '' CHECK(length(publisher) <= 200),
      players TEXT NOT NULL DEFAULT '' CHECK(length(players) <= 32),
      region_language TEXT NOT NULL DEFAULT '' CHECK(length(region_language) <= 64),
      provider_game_id TEXT CHECK(provider_game_id IS NULL OR length(provider_game_id) BETWEEN 1 AND 64),
      match_method TEXT CHECK(match_method IS NULL OR match_method IN ('hash', 'name', 'game_id', 'manual', 'serial')),
      fetched_at INTEGER,
      applied_at INTEGER,
      metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK(metadata_revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO game_metadata_v15 (game_id, release_date, release_precision, genre, developer, publisher, players,
      region_language, provider_game_id, match_method, fetched_at, applied_at, metadata_revision, created_at, updated_at)
      SELECT game_id, release_date, release_precision, genre, developer, publisher, players,
        region_language, provider_game_id, match_method, fetched_at, applied_at, metadata_revision, created_at, updated_at
      FROM game_metadata;
    DROP TABLE game_metadata;
    ALTER TABLE game_metadata_v15 RENAME TO game_metadata;`,
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
