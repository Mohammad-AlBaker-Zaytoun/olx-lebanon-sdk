/**
 * Maintainers: refreshes src/data/locations.ts from OLX's location search (public data).
 * Needs the website's read-only search key: OLX_SEARCH_AUTH, or a capture in captures/
 * (`olx-lb capture`) that contains a location search. Run: npm run update-locations
 */
import { loadEnvFile } from '../src/env.js';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OLX_LB_LOCATIONS_SEARCH, locationsQuery } from '../src/tools/catalogFields.js';

loadEnvFile();

function searchKey(): string {
  if (process.env.OLX_SEARCH_AUTH) return process.env.OLX_SEARCH_AUTH;
  for (const f of readdirSync('captures')
    .filter((x) => x.endsWith('.har'))
    .sort()
    .reverse()) {
    const har = JSON.parse(readFileSync(join('captures', f), 'utf8')) as {
      log: { entries: Array<{ request: { url: string; headers: Array<{ name: string; value: string }> } }> };
    };
    for (const e of har.log.entries) {
      if (!e.request.url.includes('locations-en/_msearch')) continue;
      const h = e.request.headers.find((x) => x.name.toLowerCase() === 'authorization');
      if (h && /^basic\s/i.test(h.value)) return h.value;
    }
  }
  throw new Error('No search key: set OLX_SEARCH_AUTH or run `olx-lb capture` and browse to the posting form');
}

type Src = {
  id: number;
  externalID: string;
  name: string;
  name_l1?: string;
  level: number;
  hierarchy?: Array<{ id: number; level: number }>;
};
const res = await fetch(OLX_LB_LOCATIONS_SEARCH, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-ndjson',
    accept: 'application/json',
    origin: 'https://www.olx.com.lb',
    authorization: searchKey(),
  },
  body: locationsQuery([0, 1, 2, 3]),
});
if (!res.ok) throw new Error(`Location search returned HTTP ${res.status}`);
const json = (await res.json()) as { responses: Array<{ hits?: { hits?: Array<{ _source: Src }> } }> };
const rows = json.responses
  .flatMap((r) => (r.hits?.hits ?? []).map((h) => h._source))
  .map(
    (s) =>
      [
        s.id,
        s.externalID,
        s.name,
        s.name_l1 ?? null,
        s.level,
        (s.hierarchy ?? []).find((h) => h.level === s.level - 1)?.id ?? null,
      ] as const,
  )
  .sort((a, b) => a[4] - b[4] || a[0] - b[0]);
if (rows.length < 500) throw new Error(`Only ${rows.length} locations returned; not overwriting the snapshot`);
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  'src/data/locations.ts',
  `/**
 * OLX Lebanon's locations: public data from the posting form's location search, taken on
 * ${today} (${rows.length} entries: country, districts, areas, sub-areas). Maintainers refresh it
 * with \`npm run update-locations\`.
 *
 * Row: [id, externalID, name (English), name (Arabic), level, parent id]. \`location_id\` on an
 * ad is the numeric \`id\` of a level 2 or 3 entry (an area); a district (level 1) is rejected.
 */
export type LocationRow = readonly [id: number, externalID: string, name: string, nameAr: string | null, level: number, parentId: number | null];

export const OLX_LB_LOCATIONS_TAKEN_AT = '${today}';

export const OLX_LB_LOCATION_ROWS: readonly LocationRow[] = [
${rows.map((r) => '  ' + JSON.stringify(r) + ',').join('\n')}
];
`,
);
console.log(`Wrote ${rows.length} locations to src/data/locations.ts`);
