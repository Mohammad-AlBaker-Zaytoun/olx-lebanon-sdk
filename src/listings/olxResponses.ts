/**
 * Parsers for OLX Lebanon's answers beyond the ad itself: activation, rejection reasons,
 * analytics, the wallet, package offers and delivery orders. OLX wraps them all the same way:
 * `{ status: "OK" | "ERROR", data, message, messageCode }`.
 */
import { OlxSdkError } from '../errors.js';
import type { ActivateResult, AdMetrics, RejectionReason } from './types.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const numOrUndefined = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** `data` from OLX's envelope; throws when the answer isn't one. */
function data(raw: unknown, what: string): unknown {
  const o = rec(raw);
  if (!('data' in o)) throw new OlxSdkError(`Unexpected OLX answer for ${what}; the format may have changed`);
  return o.data;
}

const ACTIVATE_CODES: Record<string, ActivateResult> = {
  ad_activated: 'activated',
  ad_not_eligible_for_free_quota: 'needs_package',
  ad_not_limited: 'not_limited',
};

/** The activation outcome, or undefined when OLX's answer has no known code. */
export function parseActivateResult(raw: unknown): ActivateResult | undefined {
  const o = rec(raw);
  const d = rec(o.data);
  const code = str(d.message_code) ?? str(d.messageCode) ?? str(o.message_code) ?? str(o.messageCode);
  return code ? ACTIVATE_CODES[code.toLowerCase()] : undefined;
}

export function parseRejectionReason(raw: unknown): RejectionReason | undefined {
  const o = rec(raw);
  if (str(o.messageCode) === 'rejection_reason_not_found') return undefined;
  const d = rec(data(raw, 'the rejection reason'));
  const message = str(d.longMessage);
  if (!message) return undefined;
  const rules = Array.isArray(d.rules)
    ? d.rules.map((r) => str(r) ?? str(rec(r).message) ?? str(rec(r).title)).filter((r): r is string => !!r)
    : [];
  const messageAr = str(d.longMessage_l1);
  return { message, ...(messageAr ? { messageAr } : {}), rules };
}

export function parseAdMetrics(raw: unknown): Record<string, AdMetrics> {
  const byId = rec(data(raw, 'ad analytics'));
  const out: Record<string, AdMetrics> = {};
  for (const [id, value] of Object.entries(byId)) {
    const m = rec(value);
    const metrics = {
      searchViews: num(m.searchCount),
      views: num(m.viewCount),
      storyViews: num(m.storyViewCount),
      reelViews: num(m.reelViewCount),
      phoneViews: num(m.phoneViewCount),
      chatLeads: num(m.chatLeadsCount),
      whatsAppLeads: num(m.whatsAppLeadsCount),
      smsLeads: num(m.smsLeadsCount),
      applyLeads: num(m.applyLeadCount),
      favorites: num(m.favoriteCount),
    };
    out[id] = {
      ...metrics,
      leads: metrics.phoneViews + metrics.chatLeads + metrics.whatsAppLeads + metrics.smsLeads + metrics.applyLeads,
    };
  }
  return out;
}

/** Your OLX wallet: prepaid credit for packages. */
export interface Wallet {
  /** In USD. */
  balance: number;
  /** The credit that expires first, if any. */
  nextExpiry?: { amount: number; expiresAt: string };
}

export function parseWallet(raw: unknown): Wallet {
  const d = rec(data(raw, 'the wallet'));
  const first = rec(d.firstAmountToExpire);
  const amount = numOrUndefined(first.remainingValue) ?? numOrUndefined(first.value);
  const expiresAt = str(first.expiresAt);
  return {
    balance: num(d.balance),
    ...(amount !== undefined && expiresAt ? { nextExpiry: { amount, expiresAt } } : {}),
  };
}

/** A package OLX sells for posting past the free limit in a category (read only: the SDK never buys). */
export interface PackageOffer {
  /** OLX's offer id. */
  id: string;
  /** e.g. `limit_featured`, `limit_elite`. */
  type: string;
  title?: string;
  name?: string;
  /** In USD. */
  price: number;
  /** After any discount, when there is one. */
  discountPrice?: number;
  /** What the package contains, e.g. `ad_limit_bump`, `featured_ad`. */
  items: string[];
  benefits: string[];
}

export function parsePackageOffers(raw: unknown): PackageOffer[] {
  const groups = data(raw, 'package offers');
  if (!Array.isArray(groups)) return [];
  const out: PackageOffer[] = [];
  for (const group of groups.map(rec)) {
    for (const offer of Array.isArray(group.offers) ? group.offers.map(rec) : []) {
      for (const item of Array.isArray(offer.items) ? offer.items.map(rec) : []) {
        const pkg = rec(item.productPackage);
        const id = str(item.packageOfferExternalId) ?? str(item.packageOfferID);
        if (!id) continue;
        const discount = numOrUndefined(item.discountPrice);
        const title = str(group.title);
        const name = str(pkg.name);
        out.push({
          id,
          type: str(group.packageType) ?? 'unknown',
          ...(title ? { title } : {}),
          ...(name ? { name } : {}),
          price: num(item.price),
          ...(discount ? { discountPrice: discount } : {}),
          items: Array.isArray(pkg.productItems)
            ? pkg.productItems.map((p) => str(rec(p).type)).filter((t): t is string => !!t)
            : [],
          benefits: Array.isArray(item.benefits) ? item.benefits.map(str).filter((b): b is string => !!b) : [],
        });
      }
    }
  }
  return out;
}

/** A listing of yours with OLX delivery orders. */
export interface SellingListing {
  /** The ad id. */
  id: string;
  title?: string;
  /** Delivery offers buyers made on it. */
  offers?: number;
  raw: unknown;
}

/** A delivery order a buyer placed on one of your listings. */
export interface DeliveryOrder {
  id: string;
  /** OLX's order status: `new`, `accepted`, `verified`, `rejected`, `await_pickup`, `out_for_delivery`, `delivered`… */
  status?: string;
  raw: unknown;
}

export function parseSellingListings(raw: unknown): SellingListing[] {
  const list = data(raw, 'selling orders');
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).flatMap((item) => {
    const o = rec(item);
    const id = str(o.externalID) ?? str(o.id) ?? str(o.adExternalID);
    if (!id) return [];
    const title = str(o.title);
    const offers = numOrUndefined(o.deliveryOffersCount);
    return [{ id, ...(title ? { title } : {}), ...(offers !== undefined ? { offers } : {}), raw: item }];
  });
}

export function parseDeliveryOrders(raw: unknown): DeliveryOrder[] {
  const d = data(raw, 'delivery orders');
  const nested = rec(d).orders;
  const list: unknown[] = Array.isArray(d) ? d : Array.isArray(nested) ? nested : [];
  return list.flatMap((item) => {
    const o = rec(item);
    const id = str(o.externalID) ?? str(o.orderExternalID) ?? str(o.id);
    if (!id) return [];
    const status = str(o.status) ?? str(o.state);
    return [{ id, ...(status ? { status } : {}), raw: item }];
  });
}

/** OLX's exchange rate (public). */
export interface ExchangeRate {
  base: 'USD';
  /** Lebanese pounds per US dollar. */
  lbp: number;
}

export function parseExchangeRate(raw: unknown): ExchangeRate {
  const d = rec(data(raw, 'the exchange rate'));
  const lbp = numOrUndefined(rec(d.rates).LBP);
  if (!lbp) throw new OlxSdkError('No LBP rate in the OLX exchange-rate answer');
  return { base: 'USD', lbp };
}

/** OLX delivery's limits for sellers (public). */
export interface DeliveryConfig {
  /** In USD. */
  maxPrice?: number;
  maxWeightKg?: number;
  minDaysToShip?: number;
  maxDaysToShip?: number;
}

export function parseDeliveryConfig(raw: unknown): DeliveryConfig {
  const o = rec(rec(raw).data ?? raw);
  const pick = (k: string) => numOrUndefined(o[k]);
  const c: DeliveryConfig = {};
  if (pick('maxPrice') !== undefined) c.maxPrice = pick('maxPrice');
  if (pick('maxWeight') !== undefined) c.maxWeightKg = pick('maxWeight');
  if (pick('minTimeToShipInDays') !== undefined) c.minDaysToShip = pick('minTimeToShipInDays');
  if (pick('maxTimeToShipInDays') !== undefined) c.maxDaysToShip = pick('maxTimeToShipInDays');
  return c;
}

export type { ActivateResult, AdMetrics, RejectionReason, SoldOn } from './types.js';
