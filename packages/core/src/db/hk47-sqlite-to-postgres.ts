/**
 * HK-47 fork (PERS-31): copy an Archon SQLite database into Postgres.
 *
 * Usage: DATABASE_URL=postgresql://... bun packages/core/src/db/hk47-sqlite-to-postgres.ts <archon.db>
 *
 * Opens the SQLite file read-only, lets PostgresAdapter apply the bundled schema,
 * then copies every remote_agent_* table both sides share, in one transaction with
 * FK triggers deferred via session_replication_role. Refuses a target that already
 * holds rows. Verifies afterwards that every table has the same row count and the
 * same set of primary keys. Run it with the Archon server stopped: rows written to
 * SQLite after the copy starts are not seen.
 */
import { Database } from 'bun:sqlite';
import { Pool } from 'pg';
import { PostgresAdapter } from './adapters/postgres';

const SKIP = new Set(['remote_agent_schema_version']);
const BATCH = 200;

interface PgCol {
  column_name: string;
  data_type: string;
  udt_name: string;
}

function convert(v: unknown, col: PgCol): unknown {
  if (v === null || v === undefined) return null;
  switch (col.data_type) {
    case 'boolean':
      return v === 1 || v === '1' || v === true || v === 'true';
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      // SQLite CURRENT_TIMESTAMP is UTC without a zone; numbers are epoch ms.
      return typeof v === 'number' ? new Date(v).toISOString() : v;
    case 'ARRAY':
      return typeof v === 'string' && v.startsWith('[') ? JSON.parse(v) : v;
    default:
      return v;
  }
}

async function main(): Promise<void> {
  const sqlitePath = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!sqlitePath || !url) {
    console.error(
      'usage: DATABASE_URL=... bun packages/core/src/db/hk47-sqlite-to-postgres.ts <archon.db>'
    );
    process.exit(2);
  }

  // Schema first, exactly as the server would apply it.
  const adapter = new PostgresAdapter(url);
  await adapter.query('SELECT 1');
  await adapter.close();

  const src = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();

  const srcTables = new Set(
    src
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(r => r.name)
  );
  const dstTables = (
    await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'remote_agent_%'"
    )
  ).rows.map(r => r.table_name);
  const tables = dstTables.filter(t => srcTables.has(t) && !SKIP.has(t)).sort();

  const missing = [...srcTables].filter(
    t => t.startsWith('remote_agent_') && !SKIP.has(t) && !dstTables.includes(t)
  );
  if (missing.length)
    throw new Error(`tables in SQLite with no Postgres home: ${missing.join(', ')}`);

  const pks = new Map<string, string[]>();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query('SET LOCAL session_replication_role = replica');

    for (const t of tables) {
      const existing = await client.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}"`);
      if (Number(existing.rows[0].n) > 0) throw new Error(`${t} already has rows; refusing`);

      const pgCols = (
        await client.query<PgCol>(
          'SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
          ['public', t]
        )
      ).rows;
      const srcCols = new Set(
        src
          .query<{ name: string }, []>(`PRAGMA table_info("${t}")`)
          .all()
          .map(r => r.name)
      );
      // A SQLite-only column is harmless only while it holds nothing.
      const dropped = [...srcCols].filter(
        c =>
          !pgCols.some(p => p.column_name === c) &&
          (src.query<{ n: number }, []>(`SELECT count("${c}") AS n FROM "${t}"`).get()?.n ?? 0) > 0
      );
      if (dropped.length)
        throw new Error(
          `${t}: SQLite columns with data and no Postgres home: ${dropped.join(', ')}`
        );
      const cols = pgCols.filter(c => srcCols.has(c.column_name));

      const pk = (
        await client.query<{ attname: string }>(
          `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
           WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attname`,
          [t]
        )
      ).rows.map(r => r.attname);
      pks.set(t, pk);

      const rows = src.query<Record<string, unknown>, []>(`SELECT * FROM "${t}"`).all();
      const names = cols.map(c => `"${c.column_name}"`).join(', ');
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const params: unknown[] = [];
        const tuples = chunk.map(r => {
          const ph = cols.map(c => {
            params.push(convert(r[c.column_name], c));
            return `$${params.length}`;
          });
          return `(${ph.join(', ')})`;
        });
        await client.query(`INSERT INTO "${t}" (${names}) VALUES ${tuples.join(', ')}`, params);
      }

      // Serial columns must continue past the copied ids.
      for (const c of cols) {
        const seq = await client.query<{ s: string | null }>(
          'SELECT pg_get_serial_sequence($1, $2) AS s',
          [t, c.column_name]
        );
        const s = seq.rows[0]?.s;
        if (s) {
          await client.query(
            `SELECT setval($1, COALESCE((SELECT max("${c.column_name}") FROM "${t}"), 0) + 1, false)`,
            [s]
          );
        }
      }
      console.log(`${t}: ${rows.length}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }

  // Verify: same counts, same primary keys.
  let bad = 0;
  for (const t of tables) {
    const pk = pks.get(t) ?? [];
    // SQLite ids are bare hex; Postgres uuid prints them dashed. Same value.
    const key = (r: Record<string, unknown>): string =>
      pk.map(k => String(r[k]).replace(/-/g, '').toLowerCase()).join('|');
    const a = src.query<Record<string, unknown>, []>(`SELECT * FROM "${t}"`).all().map(key).sort();
    const b = (await client.query(`SELECT * FROM "${t}"`)).rows.map(key).sort();
    const same = a.length === b.length && (pk.length === 0 || a.every((v, i) => v === b[i]));
    if (!same) {
      bad++;
      console.error(`MISMATCH ${t}: sqlite ${a.length}, postgres ${b.length}`);
    }
  }
  client.release();
  await pool.end();
  src.close();
  if (bad) process.exit(1);
  console.log(`verified ${tables.length} tables`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
