// app/api/olx/locations/route.ts: GET ?q=hamra → areas for a location picker in your admin UI.
// Locations ship with the SDK, so this needs no token and no call to OLX.
import { OlxCatalog } from 'olx-lebanon-sdk';

export const runtime = 'nodejs';

const catalog = new OlxCatalog();

export function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return Response.json([]);
  const found = catalog.locations(q).slice(0, 20);
  return Response.json(found.map((l) => ({ id: l.id, label: l.path.join(' › '), labelAr: l.nameAr })));
}
