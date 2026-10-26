/**
 * Helpers for filling config/catalog.json from OLX's public category data
 * (`npm run catalog -- categories` / `npm run catalog -- fields <id>`).
 */

/** OLX Lebanon's public catalog API (no login needed). */
export const OLX_LB_CATALOG_API = 'https://api-prod.olx-dubizzle.com/api/v1';

export interface OlxCategoryNode {
  id: number;
  name: string;
  externalID: string;
  level: number;
  children?: OlxCategoryNode[];
  locationDepthLimits?: { min?: number; max?: number };
}

export interface OlxFieldChoice {
  value: string;
  label: string;
}

export interface OlxField {
  attribute: string;
  name: string;
  valueType: string;
  isMandatory: boolean;
  roles?: string[];
  minValue?: number | null;
  maxValue?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  choices?: OlxFieldChoice[] | Record<string, OlxFieldChoice[]>;
  state?: string;
}

/** Fields the adapter fills itself from the product's price and currency. */
const PRICE_FIELDS = new Set(['price', 'secondary_price', 'price_type']);

/** Flattens the category tree into `path → externalID` lines, optionally filtered by text. */
export function listCategories(tree: OlxCategoryNode[], filter?: string): string[] {
  const out: string[] = [];
  const needle = filter?.toLowerCase();
  const walk = (n: OlxCategoryNode, path: string[]) => {
    const p = [...path, n.name];
    const leaf = !n.children?.length;
    const line = `${n.externalID.padStart(6)}  ${p.join(' > ')}${leaf ? '' : '  (has subcategories)'}`;
    if (!needle || n.name.toLowerCase().includes(needle)) out.push(line);
    for (const c of n.children ?? []) walk(c, p);
  };
  for (const n of tree) walk(n, []);
  return out;
}

/** The fields the posting form shows for a category (OLX marks the rest `exclude_from_post_an_ad`). */
export function postableFields(fields: OlxField[]): OlxField[] {
  return fields.filter((f) => !(f.roles ?? []).includes('exclude_from_post_an_ad') && (f.state ?? 'active') === 'active');
}

function choicesOf(f: OlxField): OlxFieldChoice[] {
  if (Array.isArray(f.choices)) return f.choices;
  if (f.choices && typeof f.choices === 'object') return Object.values(f.choices).flat();
  return [];
}

/** A readable table of a category's postable fields. */
export function describeFields(fields: OlxField[], maxChoices = Infinity): string {
  const lines: string[] = [];
  for (const f of postableFields(fields)) {
    const limits = [
      f.minValue != null ? `min ${f.minValue}` : '',
      f.maxValue != null ? `max ${f.maxValue}` : '',
      f.minLength != null ? `min length ${f.minLength}` : '',
      f.maxLength != null ? `max length ${f.maxLength}` : '',
    ].filter(Boolean);
    const auto = PRICE_FIELDS.has(f.attribute) ? '  (filled from the product price)' : '';
    lines.push(`${f.isMandatory ? 'REQUIRED' : 'optional'}  ${f.attribute}  [${f.valueType}]  "${f.name}"${limits.length ? '  ' + limits.join(', ') : ''}${auto}`);
    const choices = choicesOf(f);
    for (const c of choices.slice(0, maxChoices)) lines.push(`            ${JSON.stringify(c.value)} = ${c.label}`);
    if (choices.length > maxChoices) lines.push(`            … ${choices.length - maxChoices} more`);
  }
  return lines.join('\n');
}

/** A starting catalog entry for the category: required fields listed, placeholders for the rest. */
export function catalogEntry(externalId: string, label: string, fields: OlxField[]): Record<string, unknown> {
  const postable = postableFields(fields);
  const required = postable.filter((f) => f.isMandatory && !PRICE_FIELDS.has(f.attribute)).map((f) => f.attribute);
  // Every choice field, labels → OLX values, ready to rename to your own attribute names.
  const valueMap = Object.fromEntries(
    postable
      .filter((f) => !PRICE_FIELDS.has(f.attribute) && choicesOf(f).length > 0)
      .map((f) => [f.attribute, Object.fromEntries(choicesOf(f).map((c) => [c.label.trim(), c.value]))]),
  );
  const price = postable.find((f) => f.attribute === 'price');
  const priceLimits =
    price && (price.minValue != null || price.maxValue != null)
      ? { ...(price.minValue != null ? { min: price.minValue } : {}), ...(price.maxValue != null ? { max: price.maxValue } : {}) }
      : undefined;
  return {
    label,
    olxCategoryId: externalId,
    requiredAttributes: required,
    attributeMap: {},
    valueMap,
    defaults: {},
    ...(priceLimits ? { priceLimits } : {}),
  };
}

/** Finds a category's path label in the tree. */
export function categoryLabel(tree: OlxCategoryNode[], externalId: string): string | undefined {
  const walk = (n: OlxCategoryNode, path: string[]): string | undefined => {
    const p = [...path, n.name];
    if (n.externalID === externalId) return p.join(' > ');
    for (const c of n.children ?? []) {
      const hit = walk(c, p);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const n of tree) {
    const hit = walk(n, []);
    if (hit) return hit;
  }
  return undefined;
}

/** OLX Lebanon's public location index (the posting form's location picker reads it). */
export const OLX_LB_LOCATIONS_SEARCH = 'https://search-prod.olx-dubizzle.com/olx-lb-production-locations-en/_msearch';

export interface OlxLocation {
  id: number;
  externalID: string;
  name: string;
  level: number;
  hierarchy?: Array<{ externalID: string; name: string; level: number }>;
}

/** The msearch body for every location at the given levels (one query per level). */
export function locationsQuery(levels: number[]): string {
  const index = { index: 'olx-lb-production-locations-en' };
  return (
    levels
      .flatMap((level) => [index, { query: { bool: { must: [{ term: { level } }] } }, size: 10000, sort: [{ name: { order: 'asc' } }] }])
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  );
}

/** Reads the locations out of an msearch response. */
export function parseLocations(raw: unknown): OlxLocation[] {
  const responses = (raw as { responses?: Array<{ hits?: { hits?: Array<{ _source?: OlxLocation }> } }> })?.responses ?? [];
  return responses.flatMap((r) => (r.hits?.hits ?? []).map((h) => h._source).filter((s): s is OlxLocation => !!s && typeof s.id === 'number'));
}

/**
 * `id  District > Area` lines, sorted by district then name, optionally filtered by text
 * (matched against the whole path). Ads need a location below district level.
 */
export function formatLocations(locations: OlxLocation[], filter?: string): string[] {
  const needle = filter?.toLowerCase();
  const path = (l: OlxLocation) =>
    [...(l.hierarchy ?? []).filter((h) => h.level >= 1 && h.level < l.level).map((h) => h.name), l.name].join(' > ');
  return locations
    .filter((l) => l.level >= 2)
    .map((l) => ({ l, p: path(l) }))
    .filter(({ p }) => !needle || p.toLowerCase().includes(needle))
    .sort((a, b) => a.p.localeCompare(b.p))
    .map(({ l, p }) => `${String(l.id).padStart(6)}  ${p}${l.level > 2 ? `  (level ${l.level})` : ''}`);
}
