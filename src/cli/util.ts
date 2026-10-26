import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { OlxSdkError } from '../errors.js';

/** What every command receives. Output goes through `out` / `err` so commands are testable. */
export interface CliContext {
  /** Folder the command works in (relative paths in .env resolve from here). */
  cwd: string;
  out: (line?: string) => void;
  err: (line?: string) => void;
  /** Asks a question on the terminal; tests replace it. */
  ask: (question: string) => Promise<string>;
  /** Show stack traces on errors. */
  debug: boolean;
}

/** A user-facing failure: printed without a stack trace, exit code 1. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Wrong usage: exit code 2, with the command's help. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export const defaultContext = (cwd = process.cwd(), debug = false): CliContext => ({
  cwd,
  debug,
  out: (line = '') => stdout.write(line + '\n'),
  err: (line = '') => process.stderr.write(line + '\n'),
  ask: async (question) => {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
});

/** The installed package's root folder (where package.json and config/*.example.json live). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'olx-lebanon-sdk') {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new OlxSdkError('Could not find the olx-lebanon-sdk package folder');
}

export function packageVersion(): string {
  return (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version;
}

export const resolveFrom = (ctx: CliContext, path: string): string => resolve(ctx.cwd, path);

/** `--name value` / `--name=value` / `--flag` parsing, without positional reordering. */
export function parseFlags(
  args: string[],
  spec: Record<string, 'string' | 'boolean'>,
): { flags: Record<string, string | boolean | undefined>; positionals: string[] } {
  const flags: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const [rawName, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const type = spec[rawName];
    if (!type) throw new UsageError(`Unknown option --${rawName}`);
    if (type === 'boolean') {
      if (inline !== undefined) throw new UsageError(`--${rawName} takes no value`);
      flags[rawName] = true;
    } else {
      const value = inline ?? args[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError(`--${rawName} needs a value`);
      }
      flags[rawName] = value;
    }
  }
  return { flags, positionals };
}

/** Prints rows as aligned columns. */
export function table(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd(),
  );
}
