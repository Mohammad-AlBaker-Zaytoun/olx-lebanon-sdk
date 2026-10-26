import type { AdAction, OlxAd } from './types.js';

/**
 * What you can do with an ad in its current status, following the OLX website's own rules:
 * an active ad can be deactivated or marked as sold, an expired or deactivated one can be
 * republished, a `limited` one can be activated with a free slot, and so on. Delete is always
 * possible, except for an ad that is already gone.
 */
export function adActions(ad: Pick<OlxAd, 'status' | 'rejection'>): AdAction[] {
  switch (ad.status) {
    case 'active':
      return ['edit', 'deactivate', 'mark_sold', 'delete'];
    case 'pending_review':
      return ['edit', 'delete'];
    case 'limited':
      return ['activate', 'edit', 'delete'];
    case 'expired':
      return ['republish', 'edit', 'mark_sold', 'delete'];
    case 'inactive':
      return ['republish', 'delete'];
    case 'sold':
      return ['delete'];
    case 'rejected':
      return ad.rejection === 'soft' ? ['edit', 'rejection_reason', 'delete'] : ['rejection_reason', 'delete'];
    case 'deleted':
      return [];
    case 'unknown':
      return ['delete'];
  }
}
