import { Test, TestingModule } from '@nestjs/testing';
import { ReferralSyncService } from './referral-sync.service';
import { HubspotMatchingService } from './hubspot-matching.service';
import { InvoiceIngestionService } from './invoice-ingestion.service';
import { StaffMatchingService } from './staff-matching.service';
import { CommissionDetectionService } from './commission-detection.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalInvoiceSnapshotService } from './internal-invoice-snapshot.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  organization: { findUnique: jest.fn() },
  invoice: { count: jest.fn() },
};

const mockHubspotMatching = { run: jest.fn() };
const mockInvoiceIngestion = { run: jest.fn() };
const mockStaffMatching = { run: jest.fn() };
const mockCommissionDetection = { run: jest.fn() };
const mockInternalInvoiceSnapshot = { syncAllForOrganization: jest.fn() };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const invoiceStats = (overrides = {}) => ({
  created: 1,
  updated: 0,
  skipped: 0,
  lineItems: { created: 1, updated: 0, skipped: 0 },
  ...overrides,
});
const staffMatchStats = (overrides = {}) => ({
  matched: 1,
  unmatched: 0,
  ambiguous: 0,
  ...overrides,
});
const commissionStats = (overrides = {}) => ({
  created: 1,
  skipped: 0,
  ...overrides,
});

const makeMatchResult = (
  outcome: string,
  hubspotCompanyId?: string,
  error?: string,
) => ({
  outcome,
  hubspotCompanyId,
  error,
});

describe('ReferralSyncService', () => {
  let service: ReferralSyncService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralSyncService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: HubspotMatchingService, useValue: mockHubspotMatching },
        { provide: InvoiceIngestionService, useValue: mockInvoiceIngestion },
        { provide: StaffMatchingService, useValue: mockStaffMatching },
        {
          provide: CommissionDetectionService,
          useValue: mockCommissionDetection,
        },
        {
          provide: InternalInvoiceSnapshotService,
          useValue: mockInternalInvoiceSnapshot,
        },
      ],
    }).compile();

    service = module.get<ReferralSyncService>(ReferralSyncService);
    mockStaffMatching.run.mockResolvedValue(staffMatchStats());
    mockPrisma.invoice.count.mockResolvedValue(0);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Deleted organization — sync must be skipped entirely
  // -------------------------------------------------------------------------
  describe('deleted organization guard', () => {
    it('should skip the whole pipeline when the organization is deleted', async () => {
      mockPrisma.organization.findUnique.mockResolvedValueOnce({
        status: 'deleted',
      });

      const result = await service.run('org-1');

      expect(result.phaseA.outcome).toBe('skipped_deleted');
      expect(result.phaseB).toBeUndefined();
      expect(mockHubspotMatching.run).not.toHaveBeenCalled();
      expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
      expect(mockCommissionDetection.run).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Phase A halt conditions
  // -------------------------------------------------------------------------
  describe('Phase A — halt conditions', () => {
    it('should return result without phaseB when outcome is multiple_matches', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('multiple_matches'),
      );

      const result = await service.run('org-1');

      expect(result.phaseA.outcome).toBe('multiple_matches');
      expect(result.phaseB).toBeUndefined();
      expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
      expect(mockCommissionDetection.run).not.toHaveBeenCalled();
    });

    it('should return result without phaseB when outcome is error', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('error', undefined, 'HubSpot timeout'),
      );

      const result = await service.run('org-1');

      expect(result.phaseA.outcome).toBe('error');
      expect(result.phaseA.error).toBe('HubSpot timeout');
      expect(result.phaseB).toBeUndefined();
      expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Phase B — blocked referral
  // -------------------------------------------------------------------------
  it('should skip Phase B when org is blocked as active client', async () => {
    mockHubspotMatching.run.mockResolvedValue(
      makeMatchResult('synced', 'hs-1'),
    );
    mockPrisma.organization.findUnique.mockResolvedValue({
      hubspot_id: 'hs-1',
      med_alliance_referral_status: 'not_eligible',
      med_alliance_block_reason:
        'active_client_block: organization_active_by_email',
    });

    const result = await service.run('org-1');

    expect(result.phaseB).toBeUndefined();
    expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
    expect(mockCommissionDetection.run).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Phase B — no_match (no hubspot_id)
  // -------------------------------------------------------------------------
  it('should return empty phaseB stats when org has no hubspot_id after Phase A', async () => {
    mockHubspotMatching.run.mockResolvedValue(makeMatchResult('no_match'));
    mockPrisma.organization.findUnique.mockResolvedValue({
      hubspot_id: null,
      med_alliance_referral_status: 'eligible',
    });

    const result = await service.run('org-1');

    expect(result.phaseB).toEqual({
      invoices: { created: 0, updated: 0, skipped: 0 },
      internalInvoices: { created: 0, updated: 0, skipped: 0 },
      lineItems: { created: 0, matched: 0, unmatched: 0, ambiguous: 0 },
      commissions: { created: 0, skipped: 0 },
    });
    expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
    expect(mockCommissionDetection.run).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Full pipeline — success
  // -------------------------------------------------------------------------
  describe('full pipeline success', () => {
    beforeEach(() => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        hubspot_id: 'hs-company-1',
        med_alliance_referral_status: 'eligible',
      });
      mockInvoiceIngestion.run.mockResolvedValue(invoiceStats());
      mockCommissionDetection.run.mockResolvedValue(commissionStats());
    });

    it('should run Phase B when synced outcome and hubspot_id is present', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('synced', 'hs-company-1'),
      );

      const result = await service.run('org-1');

      expect(result.phaseA.outcome).toBe('synced');
      expect(result.phaseB).toBeDefined();
      expect(result.phaseB!.invoices).toEqual(invoiceStats());
      expect(result.phaseB!.lineItems).toEqual({
        created: 1,
        matched: 1,
        unmatched: 0,
        ambiguous: 0,
      });
      expect(result.phaseB!.commissions).toEqual(commissionStats());
    });

    it('should call StaffMatchingService.run between invoice ingestion and commission detection', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('synced', 'hs-company-1'),
      );

      await service.run('org-1');

      expect(mockStaffMatching.run).toHaveBeenCalledWith('org-1');
    });

    it('should run Phase B when already_matched outcome (hubspot_id was already set)', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('already_matched', 'hs-company-1'),
      );

      const result = await service.run('org-1');

      expect(result.phaseB).toBeDefined();
      expect(mockInvoiceIngestion.run).toHaveBeenCalledWith(
        'org-1',
        'hs-company-1',
      );
      expect(mockCommissionDetection.run).toHaveBeenCalledWith('org-1');
    });

    it('should pass the correct hubspot_id to InvoiceIngestionService', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('synced', 'hs-company-1'),
      );

      await service.run('org-1');

      expect(mockInvoiceIngestion.run).toHaveBeenCalledWith(
        'org-1',
        'hs-company-1',
      );
    });

    it('should always re-read org from DB before Phase B (not trust Phase A result)', async () => {
      // Phase A says synced with hs-company-1, but DB has been updated to hs-NEW by the time we re-read
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('synced', 'hs-company-1'),
      );
      mockPrisma.organization.findUnique.mockResolvedValue({
        hubspot_id: 'hs-NEW',
        med_alliance_referral_status: 'eligible',
      });

      await service.run('org-1');

      // Should use the DB value, not Phase A's returned value
      expect(mockInvoiceIngestion.run).toHaveBeenCalledWith('org-1', 'hs-NEW');
    });

    it('should include organizationId in result', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('synced', 'hs-company-1'),
      );

      const result = await service.run('org-1');

      expect(result.organizationId).toBe('org-1');
    });
  });

  // -------------------------------------------------------------------------
  // Phase B stats propagated correctly
  // -------------------------------------------------------------------------
  it('should propagate invoice, line item, and commission stats into phaseB result', async () => {
    mockHubspotMatching.run.mockResolvedValue(
      makeMatchResult('synced', 'hs-1'),
    );
    mockPrisma.organization.findUnique.mockResolvedValue({
      hubspot_id: 'hs-1',
      med_alliance_referral_status: 'eligible',
    });
    mockInvoiceIngestion.run.mockResolvedValue({
      created: 3,
      updated: 1,
      skipped: 2,
      lineItems: { created: 5, updated: 2, skipped: 1 },
    });
    mockStaffMatching.run.mockResolvedValue({
      matched: 4,
      unmatched: 1,
      ambiguous: 0,
    });
    mockCommissionDetection.run.mockResolvedValue({ created: 2, skipped: 1 });

    const result = await service.run('org-1');

    expect(result.phaseB!.invoices).toEqual({
      created: 3,
      updated: 1,
      skipped: 2,
      lineItems: { created: 5, updated: 2, skipped: 1 },
    });
    expect(result.phaseB!.lineItems).toEqual({
      created: 5,
      matched: 4,
      unmatched: 1,
      ambiguous: 0,
    });
    expect(result.phaseB!.commissions).toEqual({ created: 2, skipped: 1 });
  });

  // -------------------------------------------------------------------------
  // multiple_matches halts at Phase A
  // -------------------------------------------------------------------------
  it('should halt at Phase A when multiple HubSpot matches are found', async () => {
    // hubspot-matching sets outcome = 'multiple_matches' and med_alliance_referral_status = 'not_eligible'.
    // This test ensures the orchestrator's halt check is based on outcome, not on the DB status.
    mockHubspotMatching.run.mockResolvedValue(
      makeMatchResult('multiple_matches'),
    );

    const result = await service.run('org-1');

    expect(result.phaseB).toBeUndefined();
    // findUnique is called once for the deleted-status pre-check, but never for the Phase B reload
    expect(mockPrisma.organization.findUnique).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Internal (Stripe/Hubstaff) invoices
  // -------------------------------------------------------------------------
  describe('internal invoices', () => {
    const internalStats = { created: 2, updated: 1, skipped: 0 };

    beforeEach(() => {
      mockPrisma.invoice.count.mockResolvedValue(3);
      mockInternalInvoiceSnapshot.syncAllForOrganization.mockResolvedValue(
        internalStats,
      );
      mockCommissionDetection.run.mockResolvedValue(commissionStats());
    });

    it('should process internal invoices and detect commissions when the org has no hubspot_id', async () => {
      mockHubspotMatching.run.mockResolvedValue(makeMatchResult('no_match'));
      mockPrisma.organization.findUnique.mockResolvedValue({
        hubspot_id: null,
        med_alliance_block_reason: null,
      });

      const result = await service.run('org-1');

      expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
      expect(
        mockInternalInvoiceSnapshot.syncAllForOrganization,
      ).toHaveBeenCalledWith('org-1');
      expect(mockStaffMatching.run).toHaveBeenCalledWith('org-1');
      expect(mockCommissionDetection.run).toHaveBeenCalledWith('org-1');
      expect(result.phaseB!.internalInvoices).toEqual(internalStats);
      expect(result.phaseB!.invoices).toEqual({
        created: 0,
        updated: 0,
        skipped: 0,
        lineItems: { created: 0, updated: 0, skipped: 0 },
      });
    });

    it('should run both ingestions before staff matching and commission detection', async () => {
      const callOrder: string[] = [];
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('already_matched', 'hs-1'),
      );
      mockPrisma.organization.findUnique.mockResolvedValue({
        hubspot_id: 'hs-1',
        med_alliance_block_reason: null,
      });
      mockInvoiceIngestion.run.mockImplementation(() => {
        callOrder.push('hubspot');
        return Promise.resolve(invoiceStats());
      });
      mockInternalInvoiceSnapshot.syncAllForOrganization.mockImplementation(
        () => {
          callOrder.push('internal');
          return Promise.resolve(internalStats);
        },
      );
      mockStaffMatching.run.mockImplementation(() => {
        callOrder.push('matching');
        return Promise.resolve(staffMatchStats());
      });
      mockCommissionDetection.run.mockImplementation(() => {
        callOrder.push('detection');
        return Promise.resolve(commissionStats());
      });

      await service.run('org-1');

      expect(callOrder).toEqual([
        'hubspot',
        'internal',
        'matching',
        'detection',
      ]);
    });

    it('should still process internal invoices when Phase A halts on multiple_matches', async () => {
      mockHubspotMatching.run.mockResolvedValue(
        makeMatchResult('multiple_matches'),
      );
      mockPrisma.organization.findUnique.mockResolvedValue({
        hubspot_id: 'hs-1',
        med_alliance_block_reason: null,
      });

      const result = await service.run('org-1');

      expect(mockInvoiceIngestion.run).not.toHaveBeenCalled();
      expect(
        mockInternalInvoiceSnapshot.syncAllForOrganization,
      ).toHaveBeenCalledWith('org-1');
      expect(mockCommissionDetection.run).toHaveBeenCalledWith('org-1');
      expect(result.phaseB!.internalInvoices).toEqual(internalStats);
    });

    it('should not process internal invoices for an active-client blocked org', async () => {
      mockHubspotMatching.run.mockResolvedValue(makeMatchResult('no_match'));
      mockPrisma.organization.findUnique.mockResolvedValue({
        hubspot_id: null,
        med_alliance_block_reason: 'active_client_block: by_email',
      });

      const result = await service.run('org-1');

      expect(result.phaseB).toBeUndefined();
      expect(
        mockInternalInvoiceSnapshot.syncAllForOrganization,
      ).not.toHaveBeenCalled();
      expect(mockCommissionDetection.run).not.toHaveBeenCalled();
    });
  });
});
