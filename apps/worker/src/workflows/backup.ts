import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type ExportedPart,
  pruneBackups,
  writeManifest,
} from '@openpanel/db/src/backup/backup';
import {
  type BackupOptions,
  type ChunkPosition,
  DEFAULT_BACKUP_OPTIONS,
  buildManifest,
  exportTableChunk,
  planBackup,
} from '@openpanel/db/src/backup/run';

import { inStepScope } from './scope';

export interface BackupParams {
  /** The backup's date (YYYY-MM-DD, UTC). */
  date: string;
}

const EXPORT_CONFIG = {
  retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The nightly backup (Neon → R2): every table exported page by page, each
 * chunk of pages a durable step (a failure resumes at that chunk), then the
 * manifest, then pruning (BACKUP_RETENTION_DAYS). Restore with
 * tooling/cloudflare/src/restore.ts.
 */
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
    const bucket = this.env.BACKUPS;
    if (!bucket) {
      return { skipped: 'no BACKUPS bucket bound' };
    }
    const options: BackupOptions = {
      ...DEFAULT_BACKUP_OPTIONS,
      fullEveryDays: positiveInt(this.env.BACKUP_FULL_EVERY_DAYS, 7),
      retentionDays: positiveInt(this.env.BACKUP_RETENTION_DAYS, 30),
    };
    const { date } = event.payload;

    const plan = await step.do('plan', () =>
      inStepScope(this.env, this.ctx, () => planBackup(bucket, date, options)),
    );

    const exported = new Map<string, ExportedPart[]>();
    for (const table of plan.tables) {
      const name = `${table.schema}.${table.table}`;
      const parts: ExportedPart[] = [];
      let position: ChunkPosition = { cursor: null, index: 0 };
      for (let chunk = 0; ; chunk++) {
        const result = await step.do(`export ${name} #${chunk}`, EXPORT_CONFIG, () =>
          inStepScope(this.env, this.ctx, () =>
            exportTableChunk(bucket, plan, table, position, options),
          ),
        );
        parts.push(...result.parts);
        position = { cursor: result.cursor, index: result.index };
        if (!result.cursor) {
          break;
        }
      }
      exported.set(name, parts);
    }

    const manifest = buildManifest(plan, exported);
    await step.do('manifest', () => writeManifest(bucket, manifest));
    const pruned = await step.do('prune', () =>
      pruneBackups(bucket, date, options.retentionDays),
    );

    return {
      date,
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0),
      pruned,
    };
  }
}
