import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { MappingError, OlxSdkError } from '../errors.js';
import type { AttributeValue, ListingInput } from '../listings/types.js';

const Id = z.union([z.string().min(1), z.number()]).transform(String);
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
    const category = this.catalog.categories[input.categoryKey];
    const location = this.catalog.locations[input.locationKey];
    if (!category) issues.push(`Unknown categoryKey "${input.categoryKey}" — add it to your catalog file`);
    if (!location) issues.push(`Unknown locationKey "${input.locationKey}" — add it to your catalog file`);

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

    const merged: Record<string, AttributeValue> = { ...(category?.defaults ?? {}), ...(input.attributes ?? {}) };
    if (category) {
      const missing = category.requiredAttributes.filter((a) => merged[a] === undefined || merged[a] === '');
      if (missing.length > 0) {
        issues.push(`Category "${input.categoryKey}" requires: ${missing.join(', ')}`);
      }
    }

    if (issues.length > 0 || !category || !location) {
      throw new MappingError(`Cannot map listing "${input.title}": ${issues.join('; ')}`, issues);
    }

    const attributes = Object.fromEntries(
      Object.entries(merged).map(([key, value]) => [category.attributeMap[key] ?? key, value]),
    );

    return {
      categoryId: category.olxCategoryId,
      locationId: location.olxLocationId,
      title,
      description,
      price: input.price,
      currency: input.currency ?? 'USD',
      attributes,
    };
  }
}
