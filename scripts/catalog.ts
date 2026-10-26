/**
 * Reads OLX Lebanon's public category data to help fill config/catalog.json:
 *
 *   npm run catalog -- categories [text]   list categories and their ids (optionally filtered)
 *   npm run catalog -- fields <id> [...]   the posting form's fields for one or more categories,
 *                                          plus a starting catalog entry to paste
 *   npm run catalog -- locations [text]    location ids below district level (ads need one)
 *
 * No login is needed; nothing is posted.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OLX_LB_CATALOG_API,
  OLX_LB_LOCATIONS_SEARCH,
  formatLocations,
  locationsQuery,
  parseLocations,
  catalogEntry,
  categoryLabel,
  describeFields,
  listCategories,
  type OlxCategoryNode,
  type OlxField,
} from '../src/tools/catalogFields.js';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(OLX_LB_CATALOG_API + path, {
    headers: { accept: 'application/json', 'accept-language': 'en', origin: 'https://www.olx.com.lb' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OLX returned HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/**
 * The read-only key the OLX website itself sends to its location search (it is in every
 * visitor's browser): OLX_SEARCH_AUTH, or else the one in your latest capture. Never printed.
 */
function searchAuth(): string | undefined {
  if (process.env.OLX_SEARCH_AUTH) return process.env.OLX_SEARCH_AUTH;
  if (!existsSync('captures')) return undefined;
  for (const file of readdirSync('captures').filter((f) => f.endsWith('.har')).sort().reverse()) {
    const har = JSON.parse(readFileSync(join('captures', file), 'utf8')) as {
      log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> } }> };
    };
    for (const e of har.log.entries) {
      if (!e.request.url.startsWith(OLX_LB_LOCATIONS_SEARCH.replace(/_msearch$/, ''))) continue;
      const h = e.request.headers.find((x) => x.name.toLowerCase() === 'authorization');
      if (h && /^basic\s/i.test(h.value)) return h.value;
    }
  }
  return undefined;
}

async function searchLocations(): Promise<ReturnType<typeof parseLocations>> {
  const send = (auth?: string) =>
    fetch(OLX_LB_LOCATIONS_SEARCH, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-ndjson',
        accept: 'application/json',
        origin: 'https://www.olx.com.lb',
        ...(auth ? { authorization: auth } : {}),
      },
      body: locationsQuery([2, 3]),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  let res = await send();
  if (res.status === 401 || res.status === 403) {
    const auth = searchAuth();
    if (!auth) throw new Error('The location search needs the website key: run `npm run capture` once (or set OLX_SEARCH_AUTH)');
    res = await send(auth);
  }
  if (!res.ok) throw new Error(`OLX location search returned HTTP ${res.status}`);
  return parseLocations(await res.json());
}

const [command, ...args] = process.argv.slice(2);
if (command === 'locations') {
  const lines = formatLocations(await searchLocations(), args.join(' ') || undefined);
  console.log(lines.length ? `    id  location\n${lines.join('\n')}` : 'No location matches that text.');
  console.log('\nUse the id as olxLocationId in config/catalog.json.');
  process.exit(0);
}
const tree = await get<OlxCategoryNode[]>('/categories');

if (command === 'categories') {
  const lines = listCategories(tree, args.join(' ') || undefined);
  console.log(lines.length ? `    id  category\n${lines.join('\n')}` : 'No category matches that text.');
  console.log('\nUse the id of a category WITHOUT subcategories as olxCategoryId.');
} else if (command === 'fields' && args.length > 0) {
  const data = await get<Record<string, { flatFields?: OlxField[] }>>(
    `/categoryFields?categoryExternalIDs=${args.map(encodeURIComponent).join(',')}&groupChoicesBySection=true`,
  );
  for (const id of args) {
    const fields = data[id]?.flatFields;
    const label = categoryLabel(tree, id) ?? `category ${id}`;
    console.log('='.repeat(90));
    if (!fields) {
      console.log(`${id}: no fields returned. Check the id with: npm run catalog -- categories`);
      continue;
    }
    console.log(`${label}  (olxCategoryId ${id})\n`);
    console.log(describeFields(fields));
    console.log('\nStarting entry for config/catalog.json "categories" (rename the key, fill valueMap/defaults):\n');
    console.log(JSON.stringify({ 'your-category-key': catalogEntry(id, label, fields) }, null, 2));
  }
} else {
  console.log('Usage:\n  npm run catalog -- categories [text]\n  npm run catalog -- fields <categoryId> [...]\n  npm run catalog -- locations [text]');
  process.exitCode = 1;
}
