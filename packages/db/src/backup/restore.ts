import type pg from 'pg';

import {
  BACKUP_PREFIX,
  type BackupBucket,
  type BackupManifest,
  listCompleteBackups,
  readManifest,
} from './backup';

/**
 * Restore a backup made by the Backup workflow into a migrated, empty
 * database (Node: tooling/cloudflare/src/restore.ts). Tables load in
 * foreign-key order; analytics.events replays its full export and every
 * incremental one up to the chosen date; identity/serial sequences are
 * moved past the restored rows.
 *
 * Pages were exported at different moments, so a row can reference one
 * created after its parent table was exported. Such rows fail their
 * foreign key and are skipped (and counted): the next backup has them.
 */

const INSERT_CHUNK = 2000;
const FOREIGN_KEY_VIOLATION = '23503';

type Log = (message: string) => void;

interface TablePlan {
  schema: string;
  table: string;
  parts: string[];
  expectedRows: number;
}

async function gunzipLines(bytes: ArrayBuffer): Promise<string[]> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  return text.split('\n').filter((line) => line.length > 0);
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Tables ordered so every foreign key's target loads first. */
async function foreignKeyOrder(
  client: pg.Client,
  tables: { schema: string; table: string }[],
): Promise<{ schema: string; table: string }[]> {
  const { rows } = await client.query<{ child: string; parent: string }>(`
    SELECT cn.nspname || '.' || c.relname AS child, pn.nspname || '.' || p.relname AS parent
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE k.contype = 'f'
  `);
  const names = tables.map((table) => `${table.schema}.${table.table}`);
  const parents = new Map<string, Set<string>>(names.map((name) => [name, new Set()]));
  for (const { child, parent } of rows) {
    if (child !== parent && parents.has(child) && parents.has(parent)) {
      parents.get(child)!.add(parent);
    }
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (ordered.includes(name) || visiting.has(name)) {
      return;
    }
    visiting.add(name);
    for (const parent of parents.get(name) ?? []) {
      visit(parent);
    }
    visiting.delete(name);
    ordered.push(name);
  };
  for (const name of names) {
    visit(name);
  }
  return ordered.map((name) => {
    const [schema, table] = name.split('.') as [string, string];
    return { schema, table };
  });
}

/**
 * The columns a restore writes: those in the backup that the target still
 * has and accepts values for (not generated). Columns added after the
 * backup take their defaults.
 */
async function insertableColumns(
  client: pg.Client,
  schema: string,
  table: string,
  sample: string | undefined,
): Promise<string[]> {
  if (!sample) {
    return [];
  }
  const { rows } = await client.query<{ name: string }>(
    `SELECT attname AS name FROM pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`,
    [`${quote(schema)}.${quote(table)}`],
  );
  const target = new Set(rows.map((row) => row.name));
  return Object.keys(JSON.parse(sample) as Record<string, unknown>).filter((name) =>
    target.has(name),
  );
}

async function insertRows(
  client: pg.Client,
  schema: string,
  table: string,
  lines: string[],
): Promise<{ inserted: number; skipped: number }> {
  const target = `${quote(schema)}.${quote(table)}`;
  const columns = (await insertableColumns(client, schema, table, lines[0])).map(quote).join(', ');
  if (!columns) {
    return { inserted: 0, skipped: 0 };
  }
  const statement = `
    INSERT INTO ${target} (${columns}) OVERRIDING SYSTEM VALUE
    SELECT ${columns} FROM json_populate_recordset(NULL::${target}, $1::json)
    ON CONFLICT DO NOTHING
  `;
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i += INSERT_CHUNK) {
    const chunk = lines.slice(i, i + INSERT_CHUNK);
    try {
      await client.query('SAVEPOINT chunk');
      const result = await client.query(statement, [`[${chunk.join(',')}]`]);
      await client.query('RELEASE SAVEPOINT chunk');
      inserted += result.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT chunk');
      if ((error as { code?: string }).code !== FOREIGN_KEY_VIOLATION) {
        throw error;
      }
      // A foreign key failed: go row by row and skip the orphans.
      for (const line of chunk) {
        try {
          await client.query('SAVEPOINT row');
          const result = await client.query(statement, [`[${line}]`]);
          await client.query('RELEASE SAVEPOINT row');
          inserted += result.rowCount ?? 0;
        } catch (rowError) {
          await client.query('ROLLBACK TO SAVEPOINT row');
          if ((rowError as { code?: string }).code !== FOREIGN_KEY_VIOLATION) {
            throw rowError;
          }
          skipped++;
        }
      }
    }
  }
  return { inserted, skipped };
}

/** The manifests an events restore replays: the full export, then its incrementals. */
async function eventsChain(
  bucket: BackupBucket,
  manifest: BackupManifest,
): Promise<BackupManifest[]> {
  const events = manifest.tables.find(
    (table) => table.schema === 'analytics' && table.table === 'events',
  );
  if (!events || events.mode === 'full' || !events.basedOn) {
    return [manifest];
  }
  const chain: BackupManifest[] = [];
  for (const date of await listCompleteBackups(bucket)) {
    if (date < events.basedOn || date > manifest.date) {
      continue;
    }
    const candidate = await readManifest(bucket, date);
    const candidateEvents = candidate?.tables.find(
      (table) => table.schema === 'analytics' && table.table === 'events',
    );
    if (!(candidate && candidateEvents)) {
      continue;
    }
    const belongs =
      date === events.basedOn
        ? candidateEvents.mode === 'full'
        : candidateEvents.mode === 'incremental' &&
          candidateEvents.basedOn === events.basedOn;
    if (belongs) {
      chain.push(candidate);
    }
  }
  if (chain[0]?.date !== events.basedOn) {
    throw new Error(`The full events backup ${events.basedOn} is missing`);
  }
  return chain;
}

export async function restoreBackup(options: {
  bucket: BackupBucket;
  date: string;
  client: pg.Client;
  log?: Log;
}): Promise<{ tables: { name: string; inserted: number; skipped: number; expected: number }[] }> {
  const { bucket, client } = options;
  const log = options.log ?? (() => undefined);
  const manifest = await readManifest(bucket, options.date);
  if (!manifest) {
    throw new Error(`No complete backup for ${options.date} (manifest missing)`);
  }

  const plans = new Map<string, TablePlan>();
  for (const table of manifest.tables) {
    if (table.schema === 'analytics' && table.table === 'events') {
      continue;
    }
    plans.set(`${table.schema}.${table.table}`, {
      schema: table.schema,
      table: table.table,
      parts: table.parts.map((part) => part.key),
      expectedRows: table.rows,
    });
  }
  const eventParts: string[] = [];
  let eventRows = 0;
  for (const link of await eventsChain(bucket, manifest)) {
    const events = link.tables.find(
      (table) => table.schema === 'analytics' && table.table === 'events',
    );
    eventParts.push(...(events?.parts.map((part) => part.key) ?? []));
    eventRows += events?.rows ?? 0;
  }
  if (manifest.tables.some((table) => table.schema === 'analytics' && table.table === 'events')) {
    plans.set('analytics.events', {
      schema: 'analytics',
      table: 'events',
      parts: eventParts,
      expectedRows: eventRows,
    });
  }

  const order = await foreignKeyOrder(client, [...plans.values()]);
  const results: { name: string; inserted: number; skipped: number; expected: number }[] = [];
  await client.query('BEGIN');
  try {
    for (const { schema, table } of order) {
      const plan = plans.get(`${schema}.${table}`)!;
      let inserted = 0;
      let skipped = 0;
      for (const key of plan.parts) {
        const object = await bucket.get(key);
        if (!object) {
          throw new Error(`Backup part missing: ${key}`);
        }
        const lines = await gunzipLines(await object.arrayBuffer());
        const result = await insertRows(client, schema, table, lines);
        inserted += result.inserted;
        skipped += result.skipped;
      }
      log(`${schema}.${table}: ${inserted} rows${skipped ? `, ${skipped} orphans skipped` : ''}`);
      results.push({ name: `${schema}.${table}`, inserted, skipped, expected: plan.expectedRows });
    }

    // Identity / serial columns continue after the restored rows.
    const { rows: sequences } = await client.query<{ schema: string; table: string; column: string }>(`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'analytics') AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL
    `);
    for (const { schema, table, column } of sequences) {
      const target = `${quote(schema)}.${quote(table)}`;
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT max(${quote(column)}) FROM ${target}), 0), 1))`,
        [`${quote(schema)}.${quote(table)}`, column],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  log(`Restored ${BACKUP_PREFIX}${manifest.date}`);
  return { tables: results };
}
