/**
 * Reads OLX Lebanon's public category data to help fill config/catalog.json:
 *
 *   npm run catalog -- categories [text]   list categories and their ids (optionally filtered)
 *   npm run catalog -- fields <id> [...]   the posting form's fields for one or more categories,
 *                                          plus a starting catalog entry to paste
 *
 * No login is needed; nothing is posted.
 */
import {
  OLX_LB_CATALOG_API,
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

const [command, ...args] = process.argv.slice(2);
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
  console.log('Usage:\n  npm run catalog -- categories [text]\n  npm run catalog -- fields <categoryId> [...]');
  process.exitCode = 1;
}
