#!/usr/bin/env node
/** `olx-lb-server`: the REST service on its own. Same as `olx-lb serve`. */
import 'dotenv/config';
import { startServer } from './start.js';

startServer().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).message ?? err}\n`);
  process.exit(1);
});
