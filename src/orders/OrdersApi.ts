import type { OlxHttpClient } from '../http/HttpClient.js';
import { parseDeliveryOrders, parseSellingListings, type DeliveryOrder, type SellingListing } from '../listings/olxResponses.js';

/** What a seller can do with an OLX delivery order. */
export type DeliveryOrderAction = 'accept' | 'reject' | 'cancel' | 'out_for_delivery' | 'delivered';

const ACTIONS: readonly DeliveryOrderAction[] = ['accept', 'reject', 'cancel', 'out_for_delivery', 'delivered'];

/**
 * OLX delivery orders on your listings: buyers order through OLX, you accept and ship.
 *
 * Experimental: mapped from the OLX website's code, and not yet checked against real orders.
 * The fields beyond `id` and `status` are in `raw`.
 */
export class OrdersApi {
  constructor(private readonly http: OlxHttpClient) {}

  /** Your listings that have delivery orders: `active` ones, or `archived` (finished) ones. */
  async listings(status: 'active' | 'archived' = 'active'): Promise<SellingListing[]> {
    return parseSellingListings(await this.http.call('sellingOrders', { query: { status } }));
  }

  /** The delivery orders on one of your ads. */
  async forAd(adId: string, status: 'active' | 'archived' = 'active'): Promise<DeliveryOrder[]> {
    return parseDeliveryOrders(await this.http.call('sellingOrdersByAd', { params: { id: adId }, query: { status } }));
  }

  /** Accepts, rejects, cancels, or marks an order out for delivery or delivered. A paced write. */
  async update(orderId: string, action: DeliveryOrderAction): Promise<void> {
    if (!ACTIONS.includes(action)) throw new TypeError(`Unknown delivery order action "${action}"; use ${ACTIONS.join(', ')}`);
    await this.http.call('updateDeliveryOrder', { params: { id: orderId, action } });
  }
}
