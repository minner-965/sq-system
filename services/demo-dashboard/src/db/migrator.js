import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Umzug } from 'umzug';

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
// Databases created before the runner existed had 001–063 applied by the
// postgres image's first-boot hook, which left no record of them.
const UNRECORDED_BOOTSTRAP_LAST = 63;
const ADVISORY_LOCK_KEY = 4_802_651;

export function defaultMigrationsDir(env = process.env) {
  const projectRoot = env.DPV_PROJECT_ROOT
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  return path.join(projectRoot, 'database', 'migrations');
}

export function listMigrationFiles(dir) {
  const files = readdirSync(dir).filter(name => MIGRATION_FILE.test(name)).sort();
  const seen = new Map();
  for (const name of files) {
    const number = name.slice(0, 3);
    if (seen.has(number)) throw new Error(`Duplicate migration number ${number}: ${seen.get(number)} and ${name}`);
    seen.set(number, name);
  }
  return files;
}

export function migrationChecksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

const managesOwnTransaction = sql => /^\s*BEGIN\s*;/im.test(sql);

async function ensureLedger(client) {
  // Same definition as migration 024, which creates it with IF NOT EXISTS.
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS leadgen;
    CREATE TABLE IF NOT EXISTS leadgen.schema_migrations (
        migration_key text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9A-Fa-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text NOT NULL DEFAULT current_user
    );`);
}

async function recordUnrecordedBootstrap(client, dir, files, log) {
  const { rows: [state] } = await client.query(`
    SELECT (SELECT count(*)::int FROM leadgen.schema_migrations) AS recorded,
           to_regclass('leadgen.companies') IS NOT NULL AS has_schema`);
  if (state.recorded > 0 || !state.has_schema) return;
  const bootstrap = files.filter(name => Number(name.slice(0, 3)) <= UNRECORDED_BOOTSTRAP_LAST);
  for (const name of bootstrap) {
    await client.query(
      `INSERT INTO leadgen.schema_migrations (migration_key, checksum_sha256, applied_by) VALUES ($1, $2, 'bootstrap')`,
      [name, migrationChecksum(readFileSync(path.join(dir, name), 'utf8'))]);
  }
  log(`recorded ${bootstrap.length} migrations already present in this database`);
}

async function assertHistoryUnchanged(client, dir, files) {
  const { rows } = await client.query('SELECT migration_key, checksum_sha256 FROM leadgen.schema_migrations');
  const onDisk = new Set(files);
  for (const row of rows) {
    if (!onDisk.has(row.migration_key)) {
      throw Object.assign(new Error(`Applied migration ${row.migration_key} is missing from ${dir}`), { code: 'MIGRATION_FILE_MISSING' });
    }
    const current = migrationChecksum(readFileSync(path.join(dir, row.migration_key), 'utf8'));
    if (current !== row.checksum_sha256.toLowerCase()) {
      throw Object.assign(new Error(`Applied migration ${row.migration_key} was edited after it ran; add a new migration instead`), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
    }
  }
}

function createUmzug({ client, dir, log }) {
  return new Umzug({
    context: client,
    logger: undefined,
    migrations: listMigrationFiles(dir).map(name => ({
      name,
      async up() {
        const sql = readFileSync(path.join(dir, name), 'utf8');
        const record = () => client.query(
          'INSERT INTO leadgen.schema_migrations (migration_key, checksum_sha256) VALUES ($1, $2)',
          [name, migrationChecksum(sql)]);
        if (managesOwnTransaction(sql)) {
          await client.query(sql);
          await record();
        } else {
          await client.query('BEGIN');
          try {
            await client.query(sql);
            await record();
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }
        log(`applied ${name}`);
      }
    })),
    storage: {
      async executed() {
        const { rows } = await client.query('SELECT migration_key FROM leadgen.schema_migrations ORDER BY migration_key');
        return rows.map(row => row.migration_key);
      },
      // The migration itself writes its ledger row so both commit together.
      async logMigration() {},
      async unlogMigration() { throw new Error('Migrations are forward-only'); }
    }
  });
}

/**
 * Applies pending SQL files from database/migrations in numeric order and
 * records each in leadgen.schema_migrations. Safe to run on every start.
 */
export async function runMigrations({ pool, dir = defaultMigrationsDir(), log = () => {}, dryRun = false }) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    const files = listMigrationFiles(dir);
    await ensureLedger(client);
    await recordUnrecordedBootstrap(client, dir, files, log);
    await assertHistoryUnchanged(client, dir, files);
    const umzug = createUmzug({ client, dir, log });
    const pending = (await umzug.pending()).map(migration => migration.name);
    const applied = dryRun ? [] : (await umzug.up()).map(migration => migration.name);
    return { total: files.length, pending, applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
