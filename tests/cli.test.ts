import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli/index.js';
import { parseFlags, type CliContext } from '../src/cli/util.js';

function ctx(cwd = mkdtempSync(join(tmpdir(), 'olx-cli-')), answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const c: CliContext = {
    cwd,
    debug: false,
    out: (l = '') => out.push(l),
    err: (l = '') => err.push(l),
    ask: async () => answers.shift() ?? '',
  };
  return { c, out, err, cwd };
}

// The CLI loads .env files into process.env; keep each test's environment separate.
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('olx-lb', () => {
  it('prints help, version and per-command help', async () => {
    const t = ctx();
    expect(await main([], t.c)).toBe(0);
    expect(t.out.join('\n')).toMatch(/Commands:[\s\S]*init[\s\S]*test-post[\s\S]*serve/);
    expect(await main(['--version'], t.c)).toBe(0);
    expect(t.out.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
    expect(await main(['catalog', '--help'], t.c)).toBe(0);
    expect(t.out.at(-1)).toMatch(/olx-lb catalog locations/);
  });

  it('exits 2 on wrong usage', async () => {
    const t = ctx();
    expect(await main(['nope'], t.c)).toBe(2);
    expect(await main(['catalog', 'fields'], t.c)).toBe(2);
    expect(await main(['catalog', 'locations', '--bogus'], t.c)).toBe(2);
    expect(t.err.join('\n')).toMatch(/Unknown option --bogus/);
  });

  it('looks up areas from the shipped data, also as JSON', async () => {
    const t = ctx();
    expect(await main(['catalog', 'locations', 'verdun', '--json'], t.c)).toBe(0);
    expect(JSON.parse(t.out.join('\n'))).toEqual([expect.objectContaining({ name: 'Verdun', path: ['Beirut', 'Verdun'], postable: true })]);
  });

  describe('init', () => {
    it('creates .env with a fresh API key, a catalog file and .gitignore entries', async () => {
      const t = ctx(undefined, ['My Shop']);
      expect(await main(['init'], t.c)).toBe(0);
      const env = readFileSync(join(t.cwd, '.env'), 'utf8');
      expect(env).toMatch(/^SERVER_API_KEY=[0-9a-f]{64}$/m);
      expect(env).toMatch(/^OLX_CONTACT_NAME=My Shop$/m);
      expect(JSON.parse(readFileSync(join(t.cwd, 'config/catalog.json'), 'utf8'))).toMatchObject({ categories: {}, locations: {} });
      expect(readFileSync(join(t.cwd, '.gitignore'), 'utf8')).toMatch(/\.env\n\/\.olx-session\/\n\/captures\/\n\/data\/\n\/logs\//);
    });

    it('never overwrites without --force, and never duplicates .gitignore lines', async () => {
      const t = ctx();
      writeFileSync(join(t.cwd, '.gitignore'), 'node_modules\n.env\ndata/\n');
      await main(['init', '--yes'], t.c);
      const key = readFileSync(join(t.cwd, '.env'), 'utf8').match(/SERVER_API_KEY=(\w+)/)![1];
      await main(['init', '--yes'], t.c);
      expect(readFileSync(join(t.cwd, '.env'), 'utf8')).toContain(key);
      expect(t.out.join('\n')).toMatch(/Existing files were kept/);
      const gi = readFileSync(join(t.cwd, '.gitignore'), 'utf8');
      expect(gi.match(/^\.env$/gm)).toHaveLength(1);
      expect(gi).not.toMatch(/^\/data\/$/m); // `data/` already covers it
      expect(gi).toMatch(/^node_modules$/m);

      await main(['init', '--yes', '--force'], t.c);
      expect(readFileSync(join(t.cwd, '.env'), 'utf8')).not.toContain(key);
    });
  });

  it('test-post creates a template product on first run and posts nothing', async () => {
    const t = ctx();
    expect(await main(['test-post', 'create'], t.c)).toBe(0);
    expect(JSON.parse(readFileSync(join(t.cwd, 'olx-test-product.json'), 'utf8'))).toMatchObject({ categoryId: '174', locationId: '47' });
    expect(existsSync(join(t.cwd, 'data'))).toBe(false);
  });

  it('token refuses without a saved session', async () => {
    const t = ctx();
    expect(await main(['token', '--yes', '--env-file', join(t.cwd, 'missing.env')], t.c)).toBe(1);
    writeFileSync(join(t.cwd, '.env'), `OLX_SESSION_FILE=${join(t.cwd, 'none.json').replace(/\\/g, '/')}\n`);
    expect(await main(['token', '--yes'], t.c)).toBe(1);
    expect(t.err.join('\n')).toMatch(/olx-lb login/);
  });
});

describe('parseFlags', () => {
  it('reads --name value, --name=value, booleans and positionals', () => {
    expect(parseFlags(['a', '--product', 'p.json', '--json', '--x=1', 'b'], { product: 'string', json: 'boolean', x: 'string' })).toEqual({
      flags: { product: 'p.json', json: true, x: '1' },
      positionals: ['a', 'b'],
    });
  });
  it('rejects missing values and values on booleans', () => {
    expect(() => parseFlags(['--product'], { product: 'string' })).toThrow(/needs a value/);
    expect(() => parseFlags(['--json=1'], { json: 'boolean' })).toThrow(/takes no value/);
  });
});
