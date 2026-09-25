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

/**
 * The invoice reference that goes into buildCommissionIdempotencyKey's `hubspotInvoiceId`.
 * HubSpot snapshots keep using their hubspot_id so every existing key stays byte-for-byte
 * identical; internal (Stripe/Hubstaff) invoices get an `internal:` prefix so the two id
 * namespaces can never collide.
 */
export function resolveInvoiceIdempotencyRef(snapshot: {
  hubspot_id: string | null;
  internal_invoice_id?: string | null;
  id?: string;
}): string {
  if (snapshot.hubspot_id) return snapshot.hubspot_id;
  return `internal:${snapshot.internal_invoice_id ?? snapshot.id}`;
}
