import { loadConfig } from '../../config.js';
import { startServer } from '../../server/start.js';
import type { Command } from '../index.js';
import { parseFlags, resolveFrom } from '../util.js';

export const serve: Command = {
  summary: 'Run the REST service, for store backends in any language (PHP, Python, .NET...)',
  usage: `Usage: olx-lb serve [--port <n>] [--host <addr>]

Starts the REST service with the settings in .env (SERVER_API_KEY is required; \`olx-lb init\`
creates one). It listens on 127.0.0.1:8787 by default: keep it on the same machine or
private network as your store. Stop it with Ctrl+C; the running job finishes first.`,

  async run(args, ctx) {
    const { flags } = parseFlags(args, { port: 'string', host: 'string' });
    const config = loadConfig();
    const port = flags.port === undefined ? config.server.port : Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1-65535');
    const running = await startServer({
      config: {
        ...config,
        sessionFile: resolveFrom(ctx, config.sessionFile),
        catalogFile: resolveFrom(ctx, config.catalogFile),
        endpointsFile: resolveFrom(ctx, config.endpointsFile),
        syncStoreFile: resolveFrom(ctx, config.syncStoreFile),
        requestLogFile: resolveFrom(ctx, config.requestLogFile),
        server: { ...config.server, port, host: typeof flags.host === 'string' ? flags.host : config.server.host },
      },
    });
    ctx.out(`Listening on ${running.url}. Press Ctrl+C to stop.`);
    await new Promise(() => {}); // runs until a signal stops it
  },
};
