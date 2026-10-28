// An in-memory node:sqlite database with migrations/ applied, behind the
// SqlDb port (src/db/node-sqlite.ts): the D1 schema every SQL-level test
// runs against (the workers tier checks D1 builds the same tables).
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../src/clock';
import { migrate } from '../../src/db/migrate';
import { openNodeSqlite, type NodeSqlite } from '../../src/db/node-sqlite';
import { fakeClock } from '../fakes/clock';

// `.href`: the Workers and Node type packages both declare URL.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url).href);

/** A fresh migrated database; the caller closes it (or lets the test end). */
export function migratedDatabase(clock: Clock = fakeClock(1_800_000_000_000)): NodeSqlite {
  const database = openNodeSqlite(':memory:');
  migrate(database.connection, MIGRATIONS_DIR, clock);
  return database;
}
