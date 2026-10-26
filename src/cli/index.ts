#!/usr/bin/env node
/**
 * The `olx-lb` command: setup, login, catalog lookup, checks and the REST service.
 * Run `olx-lb help` for the list of commands.
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { OlxSdkError } from '../errors.js';
import { CliError, UsageError, defaultContext, packageVersion, type CliContext } from './util.js';

export interface Command {
  summary: string;
  usage: string;
  run(args: string[], ctx: CliContext): Promise<number | void>;
}

/** Commands are loaded on demand, so `olx-lb help` doesn't load Playwright or Fastify. */
const COMMANDS: Record<string, () => Promise<Command>> = {
  init: async () => (await import('./commands/init.js')).init,
  login: async () => (await import('./commands/login.js')).login,
  token: async () => (await import('./commands/login.js')).token,
  catalog: async () => (await import('./commands/catalog.js')).catalog,
  check: async () => (await import('./commands/check.js')).check,
  'test-post': async () => (await import('./commands/testPost.js')).testPost,
  serve: async () => (await import('./commands/serve.js')).serve,
  capture: async () => (await import('./commands/capture.js')).capture,
};

const ORDER = ['init', 'login', 'token', 'catalog', 'check', 'test-post', 'serve', 'capture'];

async function help(ctx: CliContext, name?: string): Promise<void> {
  if (name && COMMANDS[name]) {
    const cmd = await COMMANDS[name]!();
    ctx.out(`${cmd.summary}\n\n${cmd.usage}`);
    return;
  }
  ctx.out(`olx-lb ${packageVersion()} — post and manage your own OLX Lebanon listings

Usage: olx-lb <command> [options]

Commands:`);
  for (const n of ORDER) ctx.out(`  ${n.padEnd(11)} ${(await COMMANDS[n]!()).summary}`);
  ctx.out(`
Global options:
  --env-file <path>  settings file to load (default: .env in the current folder)
  --debug            show full error details
  -h, --help         help for a command (olx-lb <command> --help)
  -v, --version      print the version

Start with: olx-lb init`);
}

/** Runs the CLI and returns the exit code (0 ok, 1 failure, 2 wrong usage). */
export async function main(argv: string[], ctx: CliContext = defaultContext()): Promise<number> {
  const args = [...argv];
  let envFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--debug') {
      ctx.debug = true;
      args.splice(i--, 1);
    } else if (a === '--env-file' || a.startsWith('--env-file=')) {
      envFile = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
      args.splice(i--, a.includes('=') ? 1 : 2);
    }
  }

  const [name, ...rest] = args;
  if (!name || name === 'help' || name === '-h' || name === '--help') {
    await help(ctx, rest[0]);
    return 0;
  }
  if (name === '-v' || name === '--version' || name === 'version') {
    ctx.out(packageVersion());
    return 0;
  }
  const load = COMMANDS[name];
  if (!load) {
    ctx.err(`Unknown command "${name}". Run \`olx-lb help\` for the list of commands.`);
    return 2;
  }
  const cmd = await load();
  if (rest.includes('--help') || rest.includes('-h')) {
    ctx.out(`${cmd.summary}\n\n${cmd.usage}`);
    return 0;
  }

  const envPath = resolve(ctx.cwd, envFile ?? '.env');
  if (envFile && !existsSync(envPath)) {
    ctx.err(`Settings file not found: ${envPath}`);
    return 1;
  }
  if (existsSync(envPath)) dotenv.config({ path: envPath, quiet: true } as dotenv.DotenvConfigOptions);

  try {
    const code = await cmd.run(rest, ctx);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.err(`${err.message}\n\n${cmd.usage}`);
      return err.exitCode;
    }
    if (err instanceof CliError) {
      ctx.err(err.message);
      return err.exitCode;
    }
    const e = err as Error & { status?: number; body?: unknown };
    if (ctx.debug || !(err instanceof OlxSdkError)) {
      ctx.err(e.stack ?? String(err));
    } else {
      ctx.err(`${e.name}: ${e.message}`);
    }
    // OLX's error body names the field it rejected; it holds no secrets.
    if (e.body !== undefined) ctx.err(`OLX said: ${JSON.stringify(e.body).slice(0, 1500)}`);
    return 1;
  }
}

/** True when this file is the program being run (directly, or through npm's bin link). */
function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(realpathSync(resolve(arg))).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
