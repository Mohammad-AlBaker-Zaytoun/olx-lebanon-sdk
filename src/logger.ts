import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

export interface Logger {
  debug(msg: string, meta?: Meta): void;
  info(msg: string, meta?: Meta): void;
  warn(msg: string, meta?: Meta): void;
  error(msg: string, meta?: Meta): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Minimal JSON-lines logger (stderr by default). Swap in pino/winston by implementing `Logger`. */
export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const min = ORDER[level];
  const emit =
    (lvl: LogLevel) =>
    (msg: string, meta?: Meta): void => {
      if (ORDER[lvl] < min) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...meta }));
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** One line per HTTP call to OLX. Deliberately excludes bodies, cookies and auth headers. */
export interface RequestLogEntry {
  ts: string;
  endpoint: string;
  method: string;
  url: string;
  attempt: number;
  durationMs: number;
  status?: number;
  error?: string;
}

export interface RequestLog {
  write(entry: RequestLogEntry): void;
}

export class FileRequestLog implements RequestLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  write(entry: RequestLogEntry): void {
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }
}

export class MemoryRequestLog implements RequestLog {
  readonly entries: RequestLogEntry[] = [];
  write(entry: RequestLogEntry): void {
    this.entries.push(entry);
  }
}
