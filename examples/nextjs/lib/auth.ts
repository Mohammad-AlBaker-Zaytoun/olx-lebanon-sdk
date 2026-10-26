// lib/auth.ts: only your staff may post to your OLX account.
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * A minimal check for an `Authorization: Bearer <ADMIN_API_KEY>` header. If your app already
 * has sign-in (NextAuth, Clerk, your own sessions), check the user's role there instead.
 */
export function isAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected || expected.length < 16) return false;
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}
