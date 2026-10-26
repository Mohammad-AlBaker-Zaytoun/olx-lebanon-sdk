// app/products/actions.ts: a server action for a "Publish on OLX" button in your admin pages.
'use server';

import { toErrorInfo } from 'olx-lebanon-sdk';
import { olx } from '../../lib/olx';
import { getProduct, toAdInput } from '../../lib/products';

export type PublishState = { ok: true; adId: string; status: string } | { ok: false; code: string; message: string };

export async function publishToOlx(productId: string): Promise<PublishState> {
  // Server actions are public endpoints: check that the user is staff here (your auth library).
  const product = await getProduct(productId);
  if (!product) return { ok: false, code: 'not_found', message: 'No such product' };
  try {
    const { record } = await olx.sync.upsert(product.id, toAdInput(product));
    return { ok: true, adId: record.adId, status: record.status };
  } catch (err) {
    const { code, message } = toErrorInfo(err);
    return { ok: false, code, message };
  }
}
