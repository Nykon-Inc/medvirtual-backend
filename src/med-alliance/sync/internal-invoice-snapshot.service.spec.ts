import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { InternalInvoiceSnapshotService } from './internal-invoice-snapshot.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';
import { StaffMatchingService } from './staff-matching.service';
import { InvoicePaidCommissionService } from './invoice-paid-commission.service';

const mockPrisma = {
  invoice: { findUnique: jest.fn(), findMany: jest.fn() },
  hubspotInvoiceSnapshot: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  hubspotLineItemSnapshot: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  candidate: { findMany: jest.fn() },
  staff: { findMany: jest.fn() },
};
const mockReviewCases = { openOrSkip: jest.fn() };
const mockStaffMatching = { run: jest.fn() };
const mockInvoicePaid = {
  markOrganizationDeployedFromFirstPaidInvoice: jest.fn(),
  createCommissionsForPaidSnapshot: jest.fn(),
};

const line = (overrides: Record<string, any> = {}) => ({
  id: 'line-1',
  worker_id: 'hs-100',
  worker_name_snapshot: 'Jane Doe',
  category: 'hourly_service',
  description: 'Hourly services for Jane Doe',
  final_total: new Decimal(1000),
  ...overrides,
});

const buildInvoice = (overrides: Record<string, any> = {}) => ({
  id: 'inv-1',
  organization_id: 'org-1',
  status: 'published',
  invoice_number: '00042',
  reference: 'REF-00042',
  currentVersion: {
    id: 'ver-1',
    version_number: 1,
    total: new Decimal(1000),
    currency: 'USD',
    due_date: new Date('2026-09-01'),
    line_items: [line()],
  },
  payments: [],
  ...overrides,
});

describe('InternalInvoiceSnapshotService', () => {
  let service: InternalInvoiceSnapshotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InternalInvoiceSnapshotService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ReviewCasesService, useValue: mockReviewCases },
        { provide: StaffMatchingService, useValue: mockStaffMatching },
        { provide: InvoicePaidCommissionService, useValue: mockInvoicePaid },
      ],
    }).compile();

    service = module.get(InternalInvoiceSnapshotService);

    mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue(null);
    mockPrisma.hubspotInvoiceSnapshot.create.mockResolvedValue({
      id: 'snap-1',
    });
    mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);
    mockPrisma.candidate.findMany.mockResolvedValue([
      { hubstaff_id: 'hs-100', hubspot_vaid: 'va-1' },
    ]);
    mockPrisma.staff.findMany.mockResolvedValue([
      {
        id: 'staff-1',
        status: 'active',
        candidate: { hubstaff_id: 'hs-100', hubspot_vaid: 'va-1' },
      },
    ]);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.clearAllMocks());

  describe('mapInvoiceStatus', () => {
    it.each([
      ['draft', 'draft'],
      ['under_review', 'draft'],
      ['approved', 'draft'],
      ['published', 'open'],
      ['partially_paid', 'open'],
      ['paid', 'paid'],
      ['voided', 'voided'],
      ['cancelled', 'voided'],
    ])('maps %s to %s', (internal, hubspot) => {
      expect(
        InternalInvoiceSnapshotService.mapInvoiceStatus(internal as any),
      ).toBe(hubspot);
    });
  });

  describe('buildLineKeys', () => {
    it('keys lines by worker + category + ordinal, independent of line ids', () => {
      const keys = InternalInvoiceSnapshotService.buildLineKeys([
        line({ id: 'a' }),
        line({ id: 'b', category: 'overtime' }),
        line({ id: 'c', category: 'manual_charge' }),
        line({ id: 'd', category: 'manual_charge' }),
        line({ id: 'e', worker_id: null, category: 'setup_fee' }),
      ] as any);

      expect(Object.fromEntries(keys)).toEqual({
        a: 'hs-100|hourly_service|0',
        b: 'hs-100|overtime|0',
        c: 'hs-100|manual_charge|0',
        d: 'hs-100|manual_charge|1',
        e: 'org|setup_fee|0',
      });
    });
  });

  describe('syncFromInvoice', () => {
    it('creates an internal snapshot mapped from the current version', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(
        buildInvoice({
          status: 'paid',
          payments: [{ paid_at: new Date('2026-09-05') }],
        }),
      );

      const result = await service.syncFromInvoice('inv-1', {
        pdfLink: 'https://stripe.test/pdf',
      });

      expect(result).toEqual({ outcome: 'created', snapshotId: 'snap-1' });
      expect(mockPrisma.hubspotInvoiceSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: 'internal',
            internal_invoice_id: 'inv-1',
            organization_id: 'org-1',
            invoice_status: 'paid',
            payment_status: 'succeeded',
            invoice_amount: new Decimal(1000),
            currency: 'USD',
            paid_at: new Date('2026-09-05'),
            due_date: new Date('2026-09-01'),
            invoice_number: '00042',
            hubspot_pdf_link: 'https://stripe.test/pdf',
          }),
        }),
      );
    });

    it('does not create a snapshot for a zero-amount invoice', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(
        buildInvoice({
          currentVersion: {
            ...buildInvoice().currentVersion,
            total: new Decimal(0),
          },
        }),
      );

      const result = await service.syncFromInvoice('inv-1');

      expect(result).toEqual({ outcome: 'skipped' });
      expect(mockPrisma.hubspotInvoiceSnapshot.create).not.toHaveBeenCalled();
    });

    it('skips an invoice without a current version', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(
        buildInvoice({ currentVersion: null }),
      );

      await expect(service.syncFromInvoice('inv-1')).resolves.toEqual({
        outcome: 'skipped',
      });
    });

    it('continues as an update when a concurrent event created the snapshot first (P2002)', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
      mockPrisma.hubspotInvoiceSnapshot.create.mockRejectedValue({
        code: 'P2002',
      });
      mockPrisma.hubspotInvoiceSnapshot.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'snap-1',
          sync_hash: 'stale',
          invoice_amount: new Decimal(1000),
          hubspot_pdf_link: null,
          commissions: [],
        });

      const result = await service.syncFromInvoice('inv-1');

      expect(result).toEqual({ outcome: 'updated', snapshotId: 'snap-1' });
      expect(mockPrisma.hubspotInvoiceSnapshot.update).toHaveBeenCalled();
    });

    it('opens a reconciliation review case when a snapshot with a live commission changes', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: 'old-hash',
        invoice_amount: new Decimal(900),
        hubspot_pdf_link: null,
        commissions: [{ id: 'com-1', status: 'eligible' }],
      });

      await service.syncFromInvoice('inv-1');

      expect(mockReviewCases.openOrSkip).toHaveBeenCalledWith(
        'org-1',
        'reconciliation_invoice_changed',
        expect.objectContaining({
          snapshot_id: 'snap-1',
          commission_id: 'com-1',
          internal_invoice_id: 'inv-1',
          old_amount: '900',
          new_amount: '1000',
        }),
      );
    });

    it('stores a new Stripe PDF link on an existing snapshot', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: 'x',
        invoice_amount: new Decimal(1000),
        hubspot_pdf_link: null,
        commissions: [],
      });

      await service.syncFromInvoice('inv-1', { pdfLink: 'https://pdf' });

      expect(mockPrisma.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'snap-1' },
        data: { hubspot_pdf_link: 'https://pdf' },
      });
    });

    it('rethrows a non-P2002 error on snapshot creation', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
      mockPrisma.hubspotInvoiceSnapshot.create.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.syncFromInvoice('inv-1')).rejects.toThrow('db down');
    });

    it('does not open a review case when the changed snapshot has no live commission', async () => {
      mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        sync_hash: 'old',
        invoice_amount: new Decimal(900),
        hubspot_pdf_link: null,
        commissions: [],
      });

      const result = await service.syncFromInvoice('inv-1');

      expect(result.outcome).toBe('updated');
      expect(mockReviewCases.openOrSkip).not.toHaveBeenCalled();
    });

    describe('line items', () => {
      beforeEach(() => {
        mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
          id: 'snap-1',
          sync_hash: 'x',
          invoice_amount: new Decimal(1000),
          hubspot_pdf_link: null,
          commissions: [],
        });
      });

      it('creates one snapshot line per invoice line, auto-matching the Hubstaff worker to org staff', async () => {
        mockPrisma.invoice.findUnique.mockResolvedValue(
          buildInvoice({
            currentVersion: {
              ...buildInvoice().currentVersion,
              line_items: [
                line({ id: 'l1' }),
                line({
                  id: 'l2',
                  category: 'overtime',
                  final_total: new Decimal(200),
                }),
                line({
                  id: 'l3',
                  worker_id: null,
                  worker_name_snapshot: null,
                  category: 'setup_fee',
                  description: 'Setup fee',
                }),
              ],
            },
          }),
        );

        await service.syncFromInvoice('inv-1');

        const creates =
          mockPrisma.hubspotLineItemSnapshot.create.mock.calls.map(
            (c) => c[0].data,
          );
        expect(creates).toHaveLength(3);
        expect(creates[0]).toEqual(
          expect.objectContaining({
            source: 'internal',
            invoice_id: 'snap-1',
            internal_line_key: 'hs-100|hourly_service|0',
            internal_line_item_id: 'l1',
            line_category: 'hourly_service',
            name: 'Jane Doe',
            staff_id: 'staff-1',
            match_status: 'matched',
            matched_by: 'auto',
          }),
        );
        expect(creates[1]).toEqual(
          expect.objectContaining({
            internal_line_key: 'hs-100|overtime|0',
            amount: new Decimal(200),
            staff_id: 'staff-1',
          }),
        );
        expect(creates[2]).toEqual(
          expect.objectContaining({
            internal_line_key: 'org|setup_fee|0',
            match_status: 'not_applicable',
          }),
        );
        expect(mockPrisma.staff.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ organization_id: 'org-1' }),
          }),
        );
      });

      it('leaves match_status null for name matching when the worker resolves to several active staff', async () => {
        mockPrisma.staff.findMany.mockResolvedValue([
          {
            id: 'staff-1',
            status: 'active',
            candidate: { hubstaff_id: 'hs-100', hubspot_vaid: 'va-1' },
          },
          {
            id: 'staff-2',
            status: 'active',
            candidate: { hubstaff_id: null, hubspot_vaid: 'va-1' },
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        const data =
          mockPrisma.hubspotLineItemSnapshot.create.mock.calls[0][0].data;
        expect(data.match_status).toBeUndefined();
        expect(data.staff_id).toBeUndefined();
      });

      it('prefers the active placement when the worker has an old and an active staff row', async () => {
        mockPrisma.staff.findMany.mockResolvedValue([
          {
            id: 'staff-old',
            status: 'terminated',
            candidate: { hubstaff_id: 'hs-100', hubspot_vaid: 'va-1' },
          },
          {
            id: 'staff-new',
            status: 'active',
            candidate: { hubstaff_id: 'hs-100', hubspot_vaid: 'va-1' },
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        expect(
          mockPrisma.hubspotLineItemSnapshot.create.mock.calls[0][0].data
            .staff_id,
        ).toBe('staff-new');
      });

      it('leaves match_status null when the worker has no staff at this organization', async () => {
        mockPrisma.staff.findMany.mockResolvedValue([]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        const data =
          mockPrisma.hubspotLineItemSnapshot.create.mock.calls[0][0].data;
        expect(data.match_status).toBeUndefined();
      });

      it('updates the same snapshot line in place when a new version recreates the line with a new id', async () => {
        mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
          {
            id: 'sli-1',
            internal_line_key: 'hs-100|hourly_service|0',
            internal_line_item_id: 'old-line-id',
            name: 'Jane Doe',
            description: 'Hourly services for Jane Doe',
            amount: new Decimal(1000),
            line_category: 'hourly_service',
            removed_at: null,
            commissions: [],
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(
          buildInvoice({
            currentVersion: {
              ...buildInvoice().currentVersion,
              line_items: [line({ id: 'new-line-id' })],
            },
          }),
        );

        await service.syncFromInvoice('inv-1');

        expect(
          mockPrisma.hubspotLineItemSnapshot.create,
        ).not.toHaveBeenCalled();
        expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'sli-1' },
            data: expect.objectContaining({
              internal_line_item_id: 'new-line-id',
            }),
          }),
        );
        expect(mockReviewCases.openOrSkip).not.toHaveBeenCalled();
      });

      it('isolates a failing line so the others are still synced', async () => {
        mockPrisma.invoice.findUnique.mockResolvedValue(
          buildInvoice({
            currentVersion: {
              ...buildInvoice().currentVersion,
              line_items: [
                line({ id: 'l1' }),
                line({ id: 'l2', category: 'bonus' }),
              ],
            },
          }),
        );
        mockPrisma.hubspotLineItemSnapshot.create
          .mockRejectedValueOnce(new Error('db'))
          .mockRejectedValueOnce({ code: 'P2002' });

        await expect(service.syncFromInvoice('inv-1')).resolves.toEqual({
          outcome: 'updated',
          snapshotId: 'snap-1',
        });
        expect(mockPrisma.hubspotLineItemSnapshot.create).toHaveBeenCalledTimes(
          2,
        );
      });

      it('does not touch a line that did not change', async () => {
        mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
          {
            id: 'sli-1',
            internal_line_key: 'hs-100|hourly_service|0',
            internal_line_item_id: 'line-1',
            name: 'Jane Doe',
            description: 'Hourly services for Jane Doe',
            amount: new Decimal(1000),
            line_category: 'hourly_service',
            removed_at: null,
            commissions: [],
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        expect(
          mockPrisma.hubspotLineItemSnapshot.update,
        ).not.toHaveBeenCalled();
        expect(
          mockPrisma.hubspotLineItemSnapshot.create,
        ).not.toHaveBeenCalled();
      });

      it('opens a review case when the amount of a commissioned line changes', async () => {
        mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
          {
            id: 'sli-1',
            internal_line_key: 'hs-100|hourly_service|0',
            internal_line_item_id: 'line-1',
            name: 'Jane Doe',
            description: 'Hourly services for Jane Doe',
            amount: new Decimal(800),
            line_category: 'hourly_service',
            removed_at: null,
            commissions: [{ id: 'com-1' }],
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        expect(mockReviewCases.openOrSkip).toHaveBeenCalledWith(
          'org-1',
          'reconciliation_invoice_changed',
          expect.objectContaining({
            commission_id: 'com-1',
            hubspot_line_item_snapshot_id: 'sli-1',
            old_amount: '800',
            new_amount: '1000',
          }),
        );
      });

      it('marks a line removed from the current version and opens a review case only when it was commissioned', async () => {
        mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
          {
            id: 'sli-gone-commissioned',
            internal_line_key: 'hs-100|bonus|0',
            amount: new Decimal(300),
            removed_at: null,
            commissions: [{ id: 'com-1' }],
          },
          {
            id: 'sli-gone-plain',
            internal_line_key: 'hs-100|overtime|0',
            amount: new Decimal(100),
            removed_at: null,
            commissions: [],
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
          where: { id: 'sli-gone-commissioned' },
          data: { removed_at: expect.any(Date) },
        });
        expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
          where: { id: 'sli-gone-plain' },
          data: { removed_at: expect.any(Date) },
        });
        expect(mockReviewCases.openOrSkip).toHaveBeenCalledTimes(1);
        expect(mockReviewCases.openOrSkip).toHaveBeenCalledWith(
          'org-1',
          'reconciliation_invoice_changed',
          expect.objectContaining({
            commission_id: 'com-1',
            hubspot_line_item_snapshot_id: 'sli-gone-commissioned',
            new_amount: null,
          }),
        );
      });

      it('restores a previously removed line that reappears', async () => {
        mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
          {
            id: 'sli-1',
            internal_line_key: 'hs-100|hourly_service|0',
            internal_line_item_id: 'line-1',
            name: 'Jane Doe',
            description: 'Hourly services for Jane Doe',
            amount: new Decimal(1000),
            line_category: 'hourly_service',
            removed_at: new Date('2026-09-01'),
            commissions: [],
          },
        ]);
        mockPrisma.invoice.findUnique.mockResolvedValue(buildInvoice());

        await service.syncFromInvoice('inv-1');

        expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'sli-1' },
            data: expect.objectContaining({ removed_at: null }),
          }),
        );
      });
    });
  });

  describe('onInvoicePaid', () => {
    it('runs snapshot sync → deployed transition → staff matching → commission creation, in order', async () => {
      const order: string[] = [];
      const syncSpy = jest
        .spyOn(service, 'syncFromInvoice')
        .mockImplementation(() => {
          order.push('sync');
          return Promise.resolve({ outcome: 'updated', snapshotId: 'snap-1' });
        });
      mockPrisma.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        paid_at: new Date('2026-09-05'),
        organization: { id: 'org-1' },
      });
      mockInvoicePaid.markOrganizationDeployedFromFirstPaidInvoice.mockImplementation(
        () => {
          order.push('deployed');
          return Promise.resolve(true);
        },
      );
      mockStaffMatching.run.mockImplementation(() => {
        order.push('matching');
        return Promise.resolve();
      });
      mockInvoicePaid.createCommissionsForPaidSnapshot.mockImplementation(
        () => {
          order.push('commissions');
          return Promise.resolve(true);
        },
      );

      await service.onInvoicePaid('inv-1', { pdfLink: 'pdf' });

      expect(order).toEqual(['sync', 'deployed', 'matching', 'commissions']);
      expect(syncSpy).toHaveBeenCalledWith('inv-1', {
        pdfLink: 'pdf',
      });
      expect(
        mockInvoicePaid.markOrganizationDeployedFromFirstPaidInvoice,
      ).toHaveBeenCalledWith({
        organizationId: 'org-1',
        firstInvoiceDate: new Date('2026-09-05'),
        internalInvoiceId: 'inv-1',
      });
      expect(
        mockInvoicePaid.createCommissionsForPaidSnapshot,
      ).toHaveBeenCalledWith({ id: 'snap-1' }, 'internal:inv-1');
    });

    it('does nothing when no snapshot exists (e.g. zero-amount invoice)', async () => {
      jest
        .spyOn(service, 'syncFromInvoice')
        .mockResolvedValue({ outcome: 'skipped' });

      await service.onInvoicePaid('inv-1');

      expect(
        mockInvoicePaid.markOrganizationDeployedFromFirstPaidInvoice,
      ).not.toHaveBeenCalled();
      expect(
        mockInvoicePaid.createCommissionsForPaidSnapshot,
      ).not.toHaveBeenCalled();
    });
  });

  describe('safe entry points', () => {
    it('safeSync swallows errors so billing never fails', async () => {
      jest
        .spyOn(service, 'syncFromInvoice')
        .mockRejectedValue(new Error('db down'));

      await expect(service.safeSync('inv-1')).resolves.toBeUndefined();
    });

    it('safeOnPaid swallows errors so the Stripe webhook never fails', async () => {
      jest.spyOn(service, 'onInvoicePaid').mockRejectedValue(new Error('boom'));

      await expect(service.safeOnPaid('inv-1')).resolves.toBeUndefined();
    });
  });

  describe('syncAllForOrganization', () => {
    it('syncs every internal invoice of the org and aggregates outcomes, isolating failures', async () => {
      mockPrisma.invoice.findMany.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]);
      jest
        .spyOn(service, 'syncFromInvoice')
        .mockResolvedValueOnce({ outcome: 'created', snapshotId: 's-a' })
        .mockRejectedValueOnce(new Error('bad invoice'))
        .mockResolvedValueOnce({ outcome: 'skipped' });

      await expect(service.syncAllForOrganization('org-1')).resolves.toEqual({
        created: 1,
        updated: 0,
        skipped: 1,
      });
    });
  });
});
