import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { MappingError, OlxSdkError } from '../errors.js';
import type { AttributeValue, ListingInput } from '../listings/types.js';

const Id = z.union([z.string().trim().min(1), z.number()]).transform(String);

/** Ids still holding the example-file placeholder; mapping refuses them instead of sending them to OLX. */
const isPlaceholderId = (id: string): boolean => /^(todo|tbd|xxx+|<.*>)$/i.test(id.trim());

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const Attr = z.union([z.string(), z.number(), z.boolean()]);

const CategorySchema = z.object({
  olxCategoryId: Id,
  label: z.string().optional(),
  /** Attribute names (in your store's terms) that must be present for this category. */
  requiredAttributes: z.array(z.string()).default([]),
  /** Renames your attribute names to OLX's field names, e.g. { "brand": "make" }. */
  attributeMap: z.record(z.string()).default({}),
  /** Values applied when the product doesn't provide one. */
  defaults: z.record(Attr).default({}),
  /**
   * Translates your values to OLX's choice values, per attribute (your attribute names),
   * e.g. { "condition": { "new": "1", "used": "2" } }. Matching ignores case and surrounding
   * spaces. Unlisted values are sent unchanged.
   */
  valueMap: z.record(z.record(Attr)).default({}),
  /** The category's price range in USD, from the posting form; checked before posting. */
  priceLimits: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
});

const LocationSchema = z.object({
  olxLocationId: Id,
  label: z.string().optional(),
});

export const CatalogSchema = z.object({
  limits: z
    .object({
      titleMaxLength: z.number().int().positive().optional(),
      descriptionMaxLength: z.number().int().positive().optional(),
      maxImages: z.number().int().positive().optional(),
    })
    .default({}),
  categories: z.record(CategorySchema).default({}),
  locations: z.record(LocationSchema).default({}),
});

export type Catalog = z.infer<typeof CatalogSchema>;

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

    if (input.locationId !== undefined && input.locationKey !== undefined) {
      issues.push('Give locationId or locationKey, not both');
    } else if (input.locationId !== undefined) {
      locationId = String(input.locationId).trim();
      if (!/^\d+$/.test(locationId)) issues.push(`locationId "${locationId}" is not a numeric OLX location id`);
    } else if (input.locationKey !== undefined) {
      const location = own(this.catalog.locations, input.locationKey);
      if (!location) issues.push(`Unknown locationKey "${input.locationKey}" — add it to your catalog file`);
      else if (isPlaceholderId(location.olxLocationId)) {
        issues.push(`Location "${input.locationKey}" still has a placeholder olxLocationId — set the real id`);
      } else locationId = location.olxLocationId;
    } else {
      issues.push('Give the location: locationId (an OLX area id) or locationKey (from your catalog file)');
    }

    const { titleMaxLength, descriptionMaxLength, maxImages } = this.catalog.limits;
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title) issues.push('Title is empty');
    if (!description) issues.push('Description is empty');
    if (titleMaxLength && title.length > titleMaxLength) {
      issues.push(`Title is ${title.length} characters; OLX allows ${titleMaxLength}`);
    }
    if (descriptionMaxLength && description.length > descriptionMaxLength) {
      issues.push(`Description is ${description.length} characters; OLX allows ${descriptionMaxLength}`);
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
            const values = own(category!.valueMap, key);
            const mappedValue = values ? lookupValue(values, value) : value;
            return [own(category!.attributeMap, key) ?? key, mappedValue];
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
