import { createHash } from 'crypto';

/**
 * Builds the idempotency key for an AffiliateCommission.
 *
 * `hubspotLineItemId` should be passed whenever a commission is scoped to a specific
 * collaborator's line item (the standard case after the per-collaborator commission
 * rewrite) — this keeps commissions for different line items on the same invoice from
 * colliding on the same key. Omit it only for legacy call sites still computing a
 * commission for a whole invoice (pre-migration data paths).
 */
export function buildCommissionIdempotencyKey(params: {
  affiliateId: string;
  hubspotInvoiceId: string;
  hubspotLineItemId?: string;
}): string {
  const payload = [
    params.affiliateId,
    params.hubspotInvoiceId,
    params.hubspotLineItemId ?? '',
  ].join('|');

  return createHash('sha256').update(payload).digest('hex');
}
