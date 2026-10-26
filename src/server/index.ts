#!/usr/bin/env node
/** `olx-lb-server`: the REST service on its own. Same as `olx-lb serve`. */
import { loadEnvFile } from '../env.js';
import { startServer } from './start.js';

loadEnvFile();

startServer().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message ?? err}\n`);
  process.exit(1);
});
