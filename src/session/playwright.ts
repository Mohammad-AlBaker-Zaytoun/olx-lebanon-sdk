import type * as Playwright from 'playwright';
import { OlxSdkError } from '../errors.js';

/**
 * Playwright is an optional peer dependency: only `olx-lb login` and `olx-lb capture` need it.
 * The specifier is hidden from bundlers (Next.js, webpack) so apps that never log in from
 * code don't need it installed. Internal: not exported from the package, so its types never
 * require Playwright in an app that doesn't install it.
 */
export async function loadPlaywright(): Promise<typeof Playwright> {
  const name = 'playwright';
  try {
    return (await import(/* webpackIgnore: true */ /* @vite-ignore */ name)) as typeof Playwright;
  } catch {
    throw new OlxSdkError(
      'Signing in opens a browser, which needs Playwright: run `npm install playwright` and `npx playwright install chromium`.',
    );
  }
}
