import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdStatus } from '../listings/types.js';

/**
 * - `creating`: a create is in flight (if this survives a crash, the outcome is unknown).
 * - `needs_reconcile`: a create was sent but its outcome is unknown; a human must check OLX.
 * - `gone`: the linked ad no longer exists on OLX.
 * Absent means the link is healthy.
 */
export type SyncState = 'creating' | 'needs_reconcile' | 'gone';

/** Links one of your store's products to the OLX ad that represents it. */
export interface SyncRecord {
  productId: string;
  /** Empty while `syncState` is `creating` / `needs_reconcile`. */
  adId: string;
  adUrl?: string;
  status: AdStatus;
  syncState?: SyncState;
  /** Hash of the last listing content pushed to OLX; unchanged content is never re-sent. */
  contentHash: string;
  /** Hash of the product's photo list at the last push; unchanged photos aren't re-uploaded. */
  imagesHash?: string;
  createdAt: string;
  lastSyncedAt: string;
  lastError?: string;
}

/**
 * Persistence for product ↔ ad links. Ships with JSON-file and in-memory stores;
 * implement this interface to keep the mapping in your own database (e.g. SQL Server).
 * Use one process per store: two processes sharing a JSON file will overwrite each other.
 */
export interface SyncStore {
  get(productId: string): Promise<SyncRecord | undefined>;
  set(record: SyncRecord): Promise<void>;
  delete(productId: string): Promise<void>;
  all(): Promise<SyncRecord[]>;
}

export class MemorySyncStore implements SyncStore {
  protected records = new Map<string, SyncRecord>();
  async get(productId: string) {
    return this.records.get(productId);
  }
  async set(record: SyncRecord) {
    this.records.set(record.productId, record);
  }
  async delete(productId: string) {
    this.records.delete(productId);
  }
  async all() {
    return [...this.records.values()];
  }
}

const RETRYABLE_FS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE']);

/** On Windows, antivirus / indexer / OneDrive briefly lock files; retry the rename like graceful-fs does. */
async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE_FS.has(code) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** i, 2_000)));
    }
  }
}

/** JSON file store. Writes are serialised and atomic (temp file + rename). */
export class JsonFileSyncStore implements SyncStore {
  private loading: Promise<Map<string, SyncRecord>> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async get(productId: string) {
    return (await this.load()).get(productId);
  }

  async set(record: SyncRecord) {
    const records = await this.load();
    const previous = records.get(record.productId);
    records.set(record.productId, record);
    await this.persistOrRollback(record.productId, previous);
  }

  async delete(productId: string) {
    const records = await this.load();
    const previous = records.get(productId);
    records.delete(productId);
    await this.persistOrRollback(productId, previous);
  }

  async all() {
    return [...(await this.load()).values()];
  }

  /** Memory must match disk: if the write fails, undo the in-memory change (unless a later change replaced it). */
  private async persistOrRollback(productId: string, previous: SyncRecord | undefined): Promise<void> {
    const records = await this.load();
    const changed = records.get(productId);
    try {
      await this.persist();
    } catch (err) {
      if (records.get(productId) === changed) {
        if (previous) records.set(productId, previous);
        else records.delete(productId);
      }
      throw err;
    }
  }

  /** Cache the load promise (not its result) so concurrent first calls share one map. */
  private load(): Promise<Map<string, SyncRecord>> {
    this.loading ??= (async () => {
      try {
        const list = JSON.parse(await readFile(this.file, 'utf8')) as SyncRecord[];
        return new Map(list.map((r) => [r.productId, r]));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.loading = null; // let a later call retry instead of caching the failure
          throw err;
        }
        return new Map<string, SyncRecord>();
      }
    })();
    return this.loading;
  }

  private persist(): Promise<void> {
    const run = this.writes.then(async () => {
      const records = await this.load();
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify([...records.values()], null, 2));
      try {
        await renameWithRetry(tmp, this.file);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });
    this.writes = run.catch(() => {});
    return run;
  }
}
