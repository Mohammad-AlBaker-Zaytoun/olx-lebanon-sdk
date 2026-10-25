import { randomUUID } from 'node:crypto';
import type { ListingInput } from '../listings/types.js';
import { silentLogger, type Logger } from '../logger.js';

export type JobType = 'upsert' | 'remove';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  productId: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  error?: { name: string; message: string };
}

export type JobHandler = (job: Job, payload: ListingInput | undefined) => Promise<unknown>;

export interface JobQueueOptions {
  logger?: Logger;
  /** Finished jobs kept in memory for GET /jobs/:id. */
  maxHistory?: number;
  onSettled?: (job: Job) => void;
}

/**
 * In-memory FIFO queue that runs one job at a time. If a product already has a job
 * waiting, a newer request replaces it instead of queueing a second one, so a burst
 * of price changes becomes a single edit.
 */
export class JobQueue {
  private readonly jobs = new Map<string, Job>();
  private readonly payloads = new Map<string, ListingInput | undefined>();
  private readonly pending: string[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private readonly logger: Logger;

  constructor(
    private readonly handler: JobHandler,
    private readonly opts: JobQueueOptions = {},
  ) {
    this.logger = opts.logger ?? silentLogger;
  }

  enqueue(type: JobType, productId: string, payload?: ListingInput): Job {
    const waitingId = this.pending.find((id) => this.jobs.get(id)?.productId === productId);
    if (waitingId) {
      const job = this.jobs.get(waitingId)!;
      job.type = type;
      this.payloads.set(waitingId, payload);
      this.logger.debug('Coalesced job', { jobId: job.id, productId, type });
      return job;
    }

    const job: Job = { id: randomUUID(), type, productId, status: 'queued', createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.payloads.set(job.id, payload);
    this.pending.push(job.id);
    this.kick();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  stats(): { queued: number; running: boolean; tracked: number } {
    return { queued: this.pending.length, running: this.running, tracked: this.jobs.size };
  }

  /** Resolves once every queued job has finished. */
  idle(): Promise<void> {
    if (!this.running && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const id = this.pending.shift()!;
        const job = this.jobs.get(id)!;
        const payload = this.payloads.get(id);
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        try {
          job.result = await this.handler(job, payload);
          job.status = 'succeeded';
        } catch (err) {
          const e = err as Error;
          job.status = 'failed';
          job.error = { name: e.name ?? 'Error', message: e.message ?? String(err) };
          this.logger.error('Job failed', { jobId: job.id, productId: job.productId, error: job.error });
        } finally {
          job.finishedAt = new Date().toISOString();
          this.payloads.delete(id);
          this.prune();
          try {
            this.opts.onSettled?.(job);
          } catch (err) {
            this.logger.warn('onSettled hook threw', { error: (err as Error).message });
          }
        }
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private prune(): void {
    const max = this.opts.maxHistory ?? 500;
    const finished = [...this.jobs.values()].filter((j) => j.status === 'succeeded' || j.status === 'failed');
    for (const job of finished.slice(0, Math.max(0, finished.length - max))) this.jobs.delete(job.id);
  }
}
