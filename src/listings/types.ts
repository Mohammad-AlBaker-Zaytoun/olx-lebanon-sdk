import { z } from 'zod';

export type AttributeValue = string | number | boolean;

export type ImageSource = { url: string } | { path: string } | { data: Uint8Array; filename: string; contentType?: string };

/**
 * An ad's content. Give the category and the location either as OLX ids (`categoryId`,
 * `locationId`, from `client.catalog`) or as keys from your catalog file (`categoryKey`,
 * `locationKey`), which maps your own names to OLX's ids and fields.
 */
export interface ListingInput {
  title: string;
  description: string;
  /** In `currency` (USD by default). */
  price: number;
  currency?: 'USD' | 'LBP';
  /** OLX's category id, e.g. "175" for laptops. Only categories without subcategories. */
  categoryId?: string | number;
  /** A key from your catalog file. Use this or `categoryId`. */
  categoryKey?: string;
  /** OLX's location id of an area (not a district), e.g. "47" for Beirut > Hamra. */
  locationId?: string | number;
  /** A key from your catalog file. Use this or `locationId`, or neither to use `listingDefaults`. */
  locationKey?: string;
  /**
   * The category's fields: OLX's attribute names and choice values when you use
   * `categoryId` (see `client.catalog.fields()`), or your catalog's names with `categoryKey`.
   */
  attributes?: Record<string, AttributeValue>;
  images?: ImageSource[];
}

/**
 * `limited`: the ad exists but OLX keeps it hidden, usually because the account has used up
 * its free ads in that category and the ad needs a paid package to go live.
 */
export type AdStatus = 'active' | 'pending_review' | 'limited' | 'rejected' | 'expired' | 'deleted' | 'unknown';

/** A photo uploaded to OLX, as the ad body refers to it. */
export interface UploadedImage {
  /** OLX's id or name for the photo. */
  id: string;
  /** Where OLX serves the uploaded photo, when the wire format needs it. */
  url?: string;
  width?: number;
  height?: number;
  contentType?: string;
}

/** The logged-in OLX account, read from OLX when the wire format needs it. */
export interface AccountInfo {
  /** The account's public id (OLX: `externalID`, sent as `user_external_id`). */
  externalId: string;
  /** Display name shown on ads. */
  name?: string;
  /** Phone number in the format OLX stores it. */
  phone?: string;
}

/** Who buyers contact; empty fields fall back to the account profile. */
export interface ContactSettings {
  name?: string;
  phone?: string;
  /** OLX's contact option, e.g. phone only, chat only, or both. */
  method?: string;
}

export interface OlxAd {
  id: string;
  status: AdStatus;
  url?: string;
  title?: string;
  /** The untouched OLX response, for anything the adapter does not normalise yet. */
  raw: unknown;
}

/**
 * Schema for listings arriving over the REST API. Images are URL-only there, so a
 * caller can't make the service read arbitrary local files.
 */
/** PHP sends SQL Server decimals as strings ("799.00"); accept plain decimal strings too. */
const Price = z.preprocess(
  (v) => (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
  z.number().finite().nonnegative(),
);

/** An OLX id sent as a number or a string ("175"). */
const OlxId = z
  .union([z.string().trim().regex(/^\d+$/, 'must be a numeric OLX id'), z.number().int().positive()])
  .transform(String);

/** PHP's json_encode turns an empty associative array into `[]`; treat it as `{}`. */
const Attributes = z.preprocess(
  (v) => (Array.isArray(v) && v.length === 0 ? {} : v),
  z
    .record(z.string().max(100), z.union([z.string().max(1_000), z.number(), z.boolean()]))
    .refine((a) => Object.keys(a).length <= 100, 'at most 100 attributes'),
);

export const RestListingSchema = z
  .object({
    // Generous caps on what the queue holds in memory; OLX's own limits (70 / 4,096) are
    // checked when the job runs, so a catalog can still change them.
    title: z.string().trim().min(1).max(1_000),
    description: z.string().trim().min(1).max(20_000),
    price: Price,
    currency: z.enum(['USD', 'LBP']).default('USD'),
    categoryKey: z.string().min(1).optional(),
    categoryId: OlxId.optional(),
    locationKey: z.string().min(1).optional(),
    locationId: OlxId.optional(),
    attributes: Attributes.default({}),
    images: z
      .array(
        z.object({
          url: z.string().superRefine((u, ctx) => {
            let url: URL;
            try {
              url = new URL(u);
            } catch {
              ctx.addIssue({ code: 'custom', message: 'must be a valid URL' });
              return;
            }
            if (url.protocol !== 'https:' && url.protocol !== 'http:') {
              ctx.addIssue({ code: 'custom', message: 'image URLs must use https (or http for a host in OLX_IMAGE_HOSTS)' });
            }
            if (url.username || url.password)
              ctx.addIssue({ code: 'custom', message: 'image URLs must not contain credentials' });
          }),
        }),
      )
      .max(20)
      .default([]),
  })
  .refine((l) => (l.categoryKey === undefined) !== (l.categoryId === undefined), {
    message: 'give either categoryKey or categoryId',
    path: ['categoryId'],
  })
  // Neither is fine when the catalog sets listingDefaults.locationId; that is checked when the job runs.
  .refine((l) => l.locationKey === undefined || l.locationId === undefined, {
    message: 'give locationKey or locationId, not both',
    path: ['locationId'],
  });

export type RestListing = z.infer<typeof RestListingSchema>;
