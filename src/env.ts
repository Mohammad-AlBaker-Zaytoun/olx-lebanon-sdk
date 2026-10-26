import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Loads a `.env` file into `process.env` with Node's own parser. Variables that are already
 * set win over the file, so a secret from the real environment is never replaced. Returns
 * whether the file existed.
 */
export function loadEnvFile(path = '.env', env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(path)) return false;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}
