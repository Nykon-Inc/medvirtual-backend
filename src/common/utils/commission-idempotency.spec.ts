import { createHash } from 'crypto';
import {
  buildCommissionIdempotencyKey,
  resolveInvoiceIdempotencyRef,
} from './commission-idempotency';

describe('commission idempotency', () => {
  describe('resolveInvoiceIdempotencyRef', () => {
    it('uses the HubSpot id unchanged for HubSpot snapshots', () => {
      expect(
        resolveInvoiceIdempotencyRef({
          hubspot_id: '588407860315',
          internal_invoice_id: null,
        }),
      ).toBe('588407860315');
    });

    it('prefixes internal invoice ids so they cannot collide with HubSpot ids', () => {
      expect(
        resolveInvoiceIdempotencyRef({
          hubspot_id: null,
          internal_invoice_id: 'inv-1',
        }),
      ).toBe('internal:inv-1');
    });

    it('falls back to the snapshot id when the internal invoice was deleted', () => {
      expect(
        resolveInvoiceIdempotencyRef({
          hubspot_id: null,
          internal_invoice_id: null,
          id: 'snap-1',
        }),
      ).toBe('internal:snap-1');
    });
  });

  describe('buildCommissionIdempotencyKey', () => {
    it('hashes affiliate, invoice and line item', () => {
      expect(
        buildCommissionIdempotencyKey({
          affiliateId: 'a',
          hubspotInvoiceId: 'i',
          hubspotLineItemId: 'l',
        }),
      ).toBe(createHash('sha256').update('a|i|l').digest('hex'));
    });

    it('keeps the legacy invoice-level key shape when no line item is given', () => {
      expect(
        buildCommissionIdempotencyKey({
          affiliateId: 'a',
          hubspotInvoiceId: 'i',
        }),
      ).toBe(createHash('sha256').update('a|i|').digest('hex'));
    });
  });
});
