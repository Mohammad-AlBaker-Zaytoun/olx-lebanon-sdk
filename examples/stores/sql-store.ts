/**
 * A `SyncStore` backed by a SQL table, so product ↔ ad links survive restarts and are shared
 * by every instance of your app. Written for PostgreSQL with node-postgres (`pg`), and works with
 * any client that has the same `query(text, values)` shape. For MySQL or SQL Server, change the
 * upsert statement (see the notes on `set`).
 *
 * Table (PostgreSQL):
 *
 *   CREATE TABLE olx_links (
 *     product_id text PRIMARY KEY,
 *     ad_id      text NOT NULL,
 *     record     jsonb NOT NULL,
 *     updated_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX olx_links_ad_id ON olx_links (ad_id);
 *
 * The whole `SyncRecord` goes in `record`, so new fields in later SDK versions need no migration.
 * `ad_id` is a copy for your own queries ("which product is ad 117146151?").
 */
import type { SyncRecord, SyncStore } from 'olx-lebanon-sdk';

/** The part of a database client this store uses. A `pg.Pool` or `pg.Client` fits. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class SqlSyncStore implements SyncStore {
  constructor(
    private readonly db: SqlClient,
    private readonly table = 'olx_links',
  ) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new TypeError(`Unsafe table name "${table}"`);
  }

  async get(productId: string): Promise<SyncRecord | undefined> {
    const { rows } = await this.db.query(`SELECT record FROM ${this.table} WHERE product_id = $1`, [productId]);
    return rows[0]?.record as SyncRecord | undefined;
  }

  /**
   * Insert or replace. MySQL: `INSERT … ON DUPLICATE KEY UPDATE`. SQL Server: `MERGE`, or an
   * `UPDATE` followed by an `INSERT` when no row was updated, inside one transaction.
   */
  async set(record: SyncRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table} (product_id, ad_id, record, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (product_id) DO UPDATE SET ad_id = EXCLUDED.ad_id, record = EXCLUDED.record, updated_at = now()`,
      [record.productId, record.adId, JSON.stringify(record)],
    );
  }

  async delete(productId: string): Promise<void> {
    await this.db.query(`DELETE FROM ${this.table} WHERE product_id = $1`, [productId]);
  }

  async all(): Promise<SyncRecord[]> {
    const { rows } = await this.db.query(`SELECT record FROM ${this.table} ORDER BY product_id`);
    return rows.map((r) => r.record as SyncRecord);
  }
}
