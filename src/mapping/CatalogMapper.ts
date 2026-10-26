import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { OLX_LB_LOCATION_ROWS } from '../data/locations.js';
import { MappingError, OlxSdkError } from '../errors.js';
import type { AttributeValue, ListingInput } from '../listings/types.js';

const Id = z.union([z.string().trim().min(1), z.number()]).transform(String);

/** Ids still holding the example-file placeholder; mapping refuses them instead of sending them to OLX. */
const isPlaceholderId = (id: string): boolean => /^(todo|tbd|xxx+|<.*>)$/i.test(id.trim());

const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);
const Attr = z.union([z.string(), z.number(), z.boolean()]);

const CategorySchema = z.object({
  olxCategoryId: Id,
  label: z.string().optional(),
  /** Attribute names (in your store's terms) that must be present for this category. */
  requiredAttributes: z.array(z.string()).default([]),
  /** Renames your attribute names to OLX's field names, e.g. { "brand": "make" }. */
  attributeMap: z.record(z.string(), z.string()).default({}),
  /** Values applied when the product doesn't provide one. */
  defaults: z.record(z.string(), Attr).default({}),
  /**
   * Translates your values to OLX's choice values, per attribute (your attribute names),
   * e.g. { "condition": { "new": "1", "used": "2" } }. Matching ignores case and surrounding
   * spaces. Unlisted values are sent unchanged.
   */
  valueMap: z.record(z.string(), z.record(z.string(), Attr)).default({}),
  /** The category's price range in USD, from the posting form; checked before posting. */
  priceLimits: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
});

const LocationSchema = z.object({
  olxLocationId: Id,
  label: z.string().optional(),
});

/** OLX Lebanon's posting form limits, checked before anything is sent. */
export const OLX_LB_LIMITS = { titleMaxLength: 70, descriptionMaxLength: 4096, minImages: 1, maxImages: 20 } as const;

export const CatalogSchema = z.object({
  limits: z
    .object({
      titleMaxLength: z.number().int().positive().optional(),
      descriptionMaxLength: z.number().int().positive().optional(),
      /** OLX refuses an ad without a photo ("The images field is required"); 0 turns the check off. */
      minImages: z.number().int().nonnegative().optional(),
      maxImages: z.number().int().positive().optional(),
    })
    .default({}),
  categories: z.record(z.string(), CategorySchema).default({}),
  locations: z.record(z.string(), LocationSchema).default({}),
  /**
   * Applied to every listing: a location for listings that don't give one (a store with one
   * address), and a line added to the end of every description ("Delivery all over Lebanon").
   */
  listingDefaults: z
    .object({
      locationId: Id.optional(),
      locationKey: z.string().min(1).optional(),
      descriptionFooter: z.string().trim().min(1).max(500).optional(),
    })
    .refine((d) => d.locationId === undefined || d.locationKey === undefined, {
      message: 'give locationId or locationKey, not both',
      path: ['locationId'],
    })
    .default({}),
});

export type Catalog = z.infer<typeof CatalogSchema>;
/** A catalog as you write it (optional fields may be left out). */
export type CatalogInput = z.input<typeof CatalogSchema>;

/** A listing translated into OLX's IDs and field names, ready for the adapter to serialise. */
export interface MappedListing {
  categoryId: string;
  locationId: string;
  title: string;
  description: string;
  price: number;
  currency: 'USD' | 'LBP';
  attributes: Record<string, AttributeValue>;
}

/** Exact match first, then ignoring case and surrounding spaces. */
function lookupValue(values: Record<string, AttributeValue>, value: AttributeValue): AttributeValue {
  const exact = own(values, String(value));
  if (exact !== undefined) return exact;
  const wanted = String(value).trim().toLowerCase();
  for (const [k, v] of Object.entries(values)) if (k.trim().toLowerCase() === wanted) return v;
  return value;
}

/**
 * OLX rejects ads placed in a whole district or the country ("Please select a more specific
 * location"). Catch that before sending, using the shipped location snapshot. Ids that aren't
 * in the snapshot pass, in case OLX added an area since.
 */
function broadLocation(id: string): string | undefined {
  const row = OLX_LB_LOCATION_ROWS.find((r) => String(r[0]) === id);
  if (!row || row[4] >= 2) return undefined;
  const areas = OLX_LB_LOCATION_ROWS.filter((r) => r[5] === row[0] && r[4] >= 2).slice(0, 3);
  const hint = areas.length ? `, e.g. ${areas.map((r) => `${r[0]} (${r[2]})`).join(', ')}` : '';
  return `locationId ${id} is ${row[4] === 0 ? 'the whole country' : `the district "${row[2]}"`}; OLX needs an area in it${hint}`;
}

const photosNeeded = (n: number) => (n === 1 ? 'OLX needs at least one photo' : `OLX needs at least ${n} photos`);

export function parseCatalog(raw: unknown): Catalog {
  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new OlxSdkError(`Invalid catalog file:\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}

export function loadCatalog(file: string): Catalog {
  if (!existsSync(file)) return parseCatalog({});
  return parseCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Translates store products into OLX terms. This is where most real-world breakage
 * shows up (new required fields, renamed categories), so it validates loudly
 * instead of letting OLX reject the ad later.
 */
export class CatalogMapper {
  constructor(readonly catalog: Catalog) {}

  /**
   * Throws if a NEW ad has fewer photos than OLX requires (an edit may leave `images` out to
   * keep the ad's photos, so `resolve` can't tell on its own).
   */
  assertPhotosForCreate(input: ListingInput): void {
    const min = this.catalog.limits.minImages ?? OLX_LB_LIMITS.minImages;
    if (min && (input.images?.length ?? 0) < min) {
      throw new MappingError(`Cannot map listing "${input.title}": ${photosNeeded(min)}`, [photosNeeded(min)]);
    }
  }

  resolve(input: ListingInput): MappedListing {
    const issues: string[] = [];
    let categoryId: string | undefined;
    let locationId: string | undefined;
    // Own-property lookups only: "toString" or "constructor" must not resolve to Object.prototype.
    let category: Catalog['categories'][string] | undefined;

    if (input.categoryId !== undefined && input.categoryKey !== undefined) {
      issues.push('Give categoryId or categoryKey, not both');
    } else if (input.categoryId !== undefined) {
      categoryId = String(input.categoryId).trim();
      if (!/^\d+$/.test(categoryId)) issues.push(`categoryId "${categoryId}" is not a numeric OLX category id`);
    } else if (input.categoryKey !== undefined) {
      category = own(this.catalog.categories, input.categoryKey);
      if (!category) issues.push(`Unknown categoryKey "${input.categoryKey}" — add it to your catalog file`);
      else if (isPlaceholderId(category.olxCategoryId)) {
        issues.push(`Category "${input.categoryKey}" still has a placeholder olxCategoryId — set the real id`);
      } else categoryId = category.olxCategoryId;
    } else {
      issues.push('Give the category: categoryId (an OLX id) or categoryKey (from your catalog file)');
    }

    // A listing without a location uses the store-wide default, if there is one.
    const defaults = this.catalog.listingDefaults;
    const loc =
      input.locationId !== undefined || input.locationKey !== undefined
        ? { locationId: input.locationId, locationKey: input.locationKey }
        : { locationId: defaults.locationId, locationKey: defaults.locationKey };
    if (loc.locationId !== undefined && loc.locationKey !== undefined) {
      issues.push('Give locationId or locationKey, not both');
    } else if (loc.locationId !== undefined) {
      locationId = String(loc.locationId).trim();
      if (!/^\d+$/.test(locationId)) issues.push(`locationId "${locationId}" is not a numeric OLX location id`);
    } else if (loc.locationKey !== undefined) {
      const location = own(this.catalog.locations, loc.locationKey);
      if (!location) issues.push(`Unknown locationKey "${loc.locationKey}" — add it to your catalog file`);
      else if (isPlaceholderId(location.olxLocationId)) {
        issues.push(`Location "${loc.locationKey}" still has a placeholder olxLocationId — set the real id`);
      } else locationId = location.olxLocationId;
    } else {
      issues.push(
        'Give the location: locationId (an OLX area id) or locationKey (from your catalog file), or set listingDefaults.locationId',
      );
    }
    if (locationId) {
      const tooBroad = broadLocation(locationId);
      if (tooBroad) issues.push(tooBroad);
    }

    // OLX's own limits apply unless the catalog sets its own.
    const { titleMaxLength, descriptionMaxLength, minImages, maxImages } = { ...OLX_LB_LIMITS, ...this.catalog.limits };
    const title = input.title.trim();
    const body = input.description.trim();
    if (!title) issues.push('Title is empty');
    if (!body) issues.push('Description is empty');
    const footer = defaults.descriptionFooter;
    const description = body && footer && !body.endsWith(footer) ? `${body}\n\n${footer}` : body;
    if (titleMaxLength && title.length > titleMaxLength) {
      issues.push(`Title is ${title.length} characters; OLX allows ${titleMaxLength}`);
    }
    if (descriptionMaxLength && description.length > descriptionMaxLength) {
      issues.push(
        `Description is ${description.length} characters${description === body ? '' : ' with the footer'}; OLX allows ${descriptionMaxLength}`,
      );
    }
    // Leaving `images` out of an edit keeps the ad's photos; new ads are checked in create.
    if (minImages && input.images !== undefined && input.images.length < minImages) {
      issues.push(photosNeeded(minImages));
    }
    if (maxImages && (input.images?.length ?? 0) > maxImages) {
      issues.push(`${input.images?.length} images given; OLX allows ${maxImages}`);
    }
    if (!Number.isFinite(input.price) || input.price < 0) issues.push('Price must be a non-negative number');
    const limits = category?.priceLimits;
    if (limits && (input.currency ?? 'USD') === 'USD' && Number.isFinite(input.price)) {
      if (limits.min !== undefined && input.price < limits.min) {
        issues.push(`Price ${input.price} USD is below OLX's minimum of ${limits.min} for this category`);
      }
      if (limits.max !== undefined && input.price > limits.max) {
        issues.push(`Price ${input.price} USD is above OLX's maximum of ${limits.max} for this category`);
      }
    }

    const merged: Record<string, AttributeValue> = { ...(category?.defaults ?? {}), ...(input.attributes ?? {}) };
    if (category) {
      const missing = category.requiredAttributes.filter((a) => merged[a] === undefined || merged[a] === '');
      if (missing.length > 0) {
        issues.push(`Category "${input.categoryKey}" requires: ${missing.join(', ')}`);
      }
    }

    if (issues.length > 0 || categoryId === undefined || locationId === undefined) {
      throw new MappingError(`Cannot map listing "${input.title}": ${issues.join('; ')}`, issues);
    }

    // With a catalog category, rename attributes and translate values; raw ids pass them as given.
    const attributes = category
      ? Object.fromEntries(
          Object.entries(merged).map(([key, value]) => {
            const values = own(category.valueMap, key);
            const mappedValue = values ? lookupValue(values, value) : value;
            return [own(category.attributeMap, key) ?? key, mappedValue];
          }),
        )
      : merged;

    return {
      categoryId,
      locationId,
      title,
      description,
      price: input.price,
      currency: input.currency ?? 'USD',
      attributes,
    };
  }
}
