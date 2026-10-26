// app/api/products/[id]/olx/route.ts
//   POST   → post the product on OLX, or edit its ad (skipped when nothing changed)
//   DELETE → remove the product's ad
import { OlxSdkError, toErrorInfo, type OlxErrorCode } from 'olx-lebanon-sdk';
import { isAdmin } from '../../../../../lib/auth';
import { olx } from '../../../../../lib/olx';
import { getProduct, toAdInput } from '../../../../../lib/products';

export const runtime = 'nodejs'; // the SDK needs Node.js, not the Edge runtime
export const maxDuration = 300; // a write waits for the pace (≥ 60 s after the previous one) and for photo uploads

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  if (!isAdmin(req)) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) return Response.json({ error: { code: 'not_found' } }, { status: 404 });

  try {
    const result = await olx.sync.upsert(product.id, toAdInput(product));
    return Response.json({ action: result.action, adId: result.record.adId, status: result.record.status });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  if (!isAdmin(req)) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  const { id } = await params;
  try {
    return Response.json(await olx.sync.remove(id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** The SDK's stable error codes, as HTTP statuses for your own API. */
const HTTP_STATUS: Partial<Record<OlxErrorCode, number>> = {
  invalid_listing: 400,
  olx_rejected: 422,
  reconcile_required: 409,
  auth_failed: 503, // your OLX token needs renewing: not the caller's fault
  outcome_unknown: 502,
  image_upload_failed: 502,
};

function errorResponse(err: unknown): Response {
  const info = toErrorInfo(err);
  const status = err instanceof OlxSdkError ? (HTTP_STATUS[err.code] ?? 500) : 500;
  if (status === 500) console.error(err);
  return Response.json({ error: info }, { status });
}
