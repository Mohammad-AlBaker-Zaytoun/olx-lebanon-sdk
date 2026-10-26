/**
 * OLX Lebanon's public catalog: categories, the fields each category's posting form asks
 * for, and locations. No login is needed. Use it to look up ids, or to build forms and
 * dropdowns in your own app.
 */
import { OlxSdkError } from '../errors.js';
import { OLX_LB_LOCATION_ROWS, OLX_LB_LOCATIONS_TAKEN_AT } from '../data/locations.js';
import { OLX_LB_CATALOG_API, postableFields, type OlxCategoryNode, type OlxField } from '../tools/catalogFields.js';

export interface Category {
  /** The id ads use (`categoryId`). */
  id: string;
  name: string;
  /** Names from the top level down, e.g. ["Electronics & Home Appliances", "Laptops, Tablets, Computers"]. */
  path: string[];
  /** Ads can only be posted in categories without subcategories. */
  isLeaf: boolean;
  children: Category[];
}

export interface FieldChoice {
  /** What you send in `attributes`. */
  value: string;
  label: string;
}

export interface CategoryField {
  /** The key in an ad's `attributes`. */
  attribute: string;
  label: string;
  type: 'enum' | 'float' | 'integer' | 'string' | 'boolean' | (string & {});
  required: boolean;
  /** For `enum` fields: the allowed values. */
  choices: FieldChoice[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** price, price_type and secondary_price are filled from the ad's `price` and `currency`. */
  filledFromPrice: boolean;
}

export interface Location {
  /** The id ads use (`locationId`). */
  id: string;
  name: string;
  nameAr?: string;
  /** 0 country, 1 district, 2 area, 3 sub-area. Ads need level 2 or 3. */
  level: number;
  /** e.g. ["Beirut", "Hamra"] (the country is left out). */
  path: string[];
  /** Whether an ad can use this location. */
  postable: boolean;
}

const PRICE_FIELDS = new Set(['price', 'secondary_price', 'price_type']);
const CACHE_MS = 60 * 60 * 1000;

export interface OlxCatalogOptions {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

function toCategory(n: OlxCategoryNode, path: string[]): Category {
  const p = [...path, n.name];
  const children = (n.children ?? []).map((c) => toCategory(c, p));
  return { id: n.externalID, name: n.name, path: p, isLeaf: children.length === 0, children };
}

function flatten(cats: Category[]): Category[] {
  return cats.flatMap((c) => [c, ...flatten(c.children)]);
}

const LOCATIONS: Location[] = (() => {
  const byId = new Map(OLX_LB_LOCATION_ROWS.map((r) => [r[0], r]));
  return OLX_LB_LOCATION_ROWS.map(([id, , name, nameAr, level, parentId]) => {
    const path = [name];
    for (let p = parentId; p !== null; ) {
      const parent = byId.get(p);
      if (!parent || parent[4] === 0) break;
      path.unshift(parent[2]);
      p = parent[5];
    }
    return { id: String(id), name, ...(nameAr ? { nameAr } : {}), level, path, postable: level >= 2 };
  });
})();
const LOCATION_BY_ID = new Map(LOCATIONS.map((l) => [l.id, l]));

/** Lowercase, no accents or punctuation, so "Achrafiyeh", "achrafieh" and "Ashrafieh" stay close. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export class OlxCatalog {
  private categoriesCache?: { at: number; value: Promise<Category[]> };
  private readonly fieldsCache = new Map<string, { at: number; value: Promise<CategoryField[]> }>();

  constructor(private readonly o: OlxCatalogOptions = {}) {}

  private async get<T>(path: string): Promise<T> {
    const fetchImpl = this.o.fetch ?? fetch;
    const res = await fetchImpl((this.o.apiBase ?? OLX_LB_CATALOG_API) + path, {
      headers: { accept: 'application/json', 'accept-language': 'en', origin: 'https://www.olx.com.lb' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new OlxSdkError(`OLX returned HTTP ${res.status} for the catalog (${path.split('?')[0]})`);
    return (await res.json()) as T;
  }

  /** The category tree (cached for an hour). */
  categories(): Promise<Category[]> {
    if (!this.categoriesCache || Date.now() - this.categoriesCache.at > CACHE_MS) {
      const value = this.get<OlxCategoryNode[]>('/categories').then((tree) => tree.map((n) => toCategory(n, [])));
      value.catch(() => {
        if (this.categoriesCache?.value === value) this.categoriesCache = undefined;
      });
      this.categoriesCache = { at: Date.now(), value };
    }
    return this.categoriesCache.value;
  }

  /** Categories whose name contains the text (all of them without text). Leaves only by default. */
  async findCategories(text?: string, opts: { leavesOnly?: boolean } = {}): Promise<Category[]> {
    const needle = text ? norm(text) : '';
    return flatten(await this.categories()).filter(
      (c) => (opts.leavesOnly === false || c.isLeaf) && (!needle || norm(c.name).includes(needle)),
    );
  }

  async category(id: string | number): Promise<Category | undefined> {
    return flatten(await this.categories()).find((c) => c.id === String(id));
  }

  /** The fields a category's posting form shows, with their choices (cached for an hour). */
  fields(categoryId: string | number): Promise<CategoryField[]> {
    const id = String(categoryId);
    const hit = this.fieldsCache.get(id);
    if (hit && Date.now() - hit.at <= CACHE_MS) return hit.value;
    const value = this.get<Record<string, { flatFields?: OlxField[] }>>(
      `/categoryFields?categoryExternalIDs=${encodeURIComponent(id)}&groupChoicesBySection=true`,
    ).then((data) => {
      const flat = data[id]?.flatFields;
      if (!flat) throw new OlxSdkError(`OLX has no fields for category ${id}; check the id with catalog.findCategories()`);
      return postableFields(flat).map(toField);
    });
    value.catch(() => {
      if (this.fieldsCache.get(id)?.value === value) this.fieldsCache.delete(id);
    });
    this.fieldsCache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * Locations from the snapshot shipped with the SDK (no network). With text, those whose
   * name or path contains it; postable areas only unless `includeDistricts` is set.
   */
  locations(text?: string, opts: { includeDistricts?: boolean } = {}): Location[] {
    const needle = text ? norm(text) : '';
    return LOCATIONS.filter(
      (l) => (opts.includeDistricts || l.postable) && (!needle || norm(l.path.join(' ')).includes(needle) || (l.nameAr?.includes(text!) ?? false)),
    );
  }

  location(id: string | number): Location | undefined {
    return LOCATION_BY_ID.get(String(id));
  }

  /** When the shipped location snapshot was taken. */
  readonly locationsTakenAt = OLX_LB_LOCATIONS_TAKEN_AT;
}

function choicesOf(f: OlxField): FieldChoice[] {
  const raw = Array.isArray(f.choices) ? f.choices : f.choices ? Object.values(f.choices).flat() : [];
  return raw.map((c) => ({ value: String(c.value), label: c.label.trim() }));
}

function toField(f: OlxField): CategoryField {
  return {
    attribute: f.attribute,
    label: f.name,
    type: f.valueType,
    required: f.isMandatory,
    choices: choicesOf(f),
    ...(f.minValue != null ? { min: f.minValue } : {}),
    ...(f.maxValue != null ? { max: f.maxValue } : {}),
    ...(f.minLength != null ? { minLength: f.minLength } : {}),
    ...(f.maxLength != null ? { maxLength: f.maxLength } : {}),
    filledFromPrice: PRICE_FIELDS.has(f.attribute),
  };
}
