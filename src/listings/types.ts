import { z } from 'zod';

export type AttributeValue = string | number | boolean;

export type ImageSource =
  | { url: string }
  | { path: string }
  | { data: Uint8Array; filename: string; contentType?: string };

/**
 * A product, described in your store's terms. `categoryKey` and `locationKey`
 * are keys from your catalog file, which maps them to OLX's own IDs.
 */
export interface ListingInput {
  title: string;
  description: string;
  price: number;
  currency?: 'USD' | 'LBP';
  categoryKey: string;
  locationKey: string;
  attributes?: Record<string, AttributeValue>;
  images?: ImageSource[];
}

export type AdStatus = 'active' | 'pending_review' | 'rejected' | 'expired' | 'deleted' | 'unknown';

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

/** PHP's json_encode turns an empty associative array into `[]`; treat it as `{}`. */
const Attributes = z.preprocess(
  (v) => (Array.isArray(v) && v.length === 0 ? {} : v),
  z.record(z.union([z.string(), z.number(), z.boolean()])),
);

export const RestListingSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  price: Price,
  currency: z.enum(['USD', 'LBP']).default('USD'),
  categoryKey: z.string().min(1),
  locationKey: z.string().min(1),
  attributes: Attributes.default({}),
  images: z
    .array(
      z.object({
        url: z
          .string()
          .url()
          .refine((u) => {
            const url = new URL(u);
            return !url.username && !url.password;
          }, 'image URLs must not contain credentials'),
      }),
    )
    .max(30)
    .default([]),
});

export type RestListing = z.infer<typeof RestListingSchema>;
