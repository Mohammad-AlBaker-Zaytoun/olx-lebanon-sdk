import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AdStatus } from '../listings/types.js';

/** Links one of your store's products to the OLX ad that represents it. */
export interface SyncRecord {
  productId: string;
  adId: string;
  adUrl?: string;
  status: AdStatus;
  /** Hash of the last listing content pushed to OLX; unchanged content is never re-sent. */
  contentHash: string;
  createdAt: string;
  lastSyncedAt: string;
}

/**
 * Persistence for product ↔ ad links. Ships with JSON-file and in-memory stores;
 * implement this interface to keep the mapping in your own database (e.g. SQL Server).
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

/** JSON file store. Writes are serialised and atomic (temp file + rename). */
export class JsonFileSyncStore implements SyncStore {
  private records: Map<string, SyncRecord> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async get(productId: string) {
    return (await this.load()).get(productId);
  }

  async set(record: SyncRecord) {
    (await this.load()).set(record.productId, record);
    await this.persist();
  }

  async delete(productId: string) {
    (await this.load()).delete(productId);
    await this.persist();
  }

  async all() {
    return [...(await this.load()).values()];
  }

  private async load(): Promise<Map<string, SyncRecord>> {
    if (this.records) return this.records;
    try {
      const list = JSON.parse(await readFile(this.file, 'utf8')) as SyncRecord[];
      this.records = new Map(list.map((r) => [r.productId, r]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.records = new Map();
    }
    return this.records;
  }

  private persist(): Promise<void> {
    const run = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify([...(this.records ?? new Map()).values()], null, 2));
      await rename(tmp, this.file);
    });
    this.writes = run.catch(() => {});
    return run;
  }
}
