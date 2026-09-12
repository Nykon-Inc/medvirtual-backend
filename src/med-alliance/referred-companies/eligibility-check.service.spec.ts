import { Test, TestingModule } from '@nestjs/testing';
import { EligibilityCheckService } from './eligibility-check.service';
import { PrismaService } from '../../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  organization: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  medAllianceAuditLog: {
    create: jest.fn(),
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const makeOrg = (overrides: Partial<any> = {}) => ({
  id: 'org-1',
  hubspot_id: null,
  email: 'contact@acme.com',
  ...overrides,
});

describe('EligibilityCheckService', () => {
  let service: EligibilityCheckService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EligibilityCheckService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EligibilityCheckService>(EligibilityCheckService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // check
  // -------------------------------------------------------------------------
  describe('check', () => {
    it('should return eligible when organization does not exist', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      const result = await service.check('non-existent');

      expect(result).toEqual({ eligible: true });
      expect(mockPrisma.organization.findFirst).not.toHaveBeenCalled();
    });

    it('should return eligible when org has no hubspot_id and no email', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ hubspot_id: null, email: null }),
      );

      const result = await service.check('org-1');

      expect(result).toEqual({ eligible: true });
      expect(mockPrisma.organization.findFirst).not.toHaveBeenCalled();
    });

    describe('hubspot_id match (priority 1)', () => {
      it('should return not_eligible when an active org shares the same hubspot_id', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: 'hs-123' }),
        );
        mockPrisma.organization.findFirst.mockResolvedValueOnce({
          id: 'existing-client',
        });

        const result = await service.check('org-1');

        expect(result).toEqual({
          eligible: false,
          reason: 'active_client_block: organization_active_by_hubspot_id',
          matchedOrganizationId: 'existing-client',
        });
        // findFirst called once for hubspot_id — email check should be skipped
        expect(mockPrisma.organization.findFirst).toHaveBeenCalledTimes(1);
        expect(mockPrisma.organization.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              hubspot_id: 'hs-123',
              id: { not: 'org-1' },
              status: 'active',
            }),
          }),
        );
      });

      it('should skip email check when hubspot_id match returns no active client', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: 'hs-123', email: 'contact@acme.com' }),
        );
        // No hubspot_id match
        mockPrisma.organization.findFirst.mockResolvedValueOnce(null);
        // No email match
        mockPrisma.organization.findFirst.mockResolvedValueOnce(null);

        const result = await service.check('org-1');

        expect(result).toEqual({ eligible: true });
        expect(mockPrisma.organization.findFirst).toHaveBeenCalledTimes(2);
      });

      it('should not match itself (excludes same org id)', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: 'hs-123' }),
        );
        mockPrisma.organization.findFirst.mockResolvedValue(null);

        await service.check('org-1');

        const [call] = mockPrisma.organization.findFirst.mock.calls;
        expect(call[0].where.id).toEqual({ not: 'org-1' });
      });
    });

    describe('email match (priority 2 / fallback)', () => {
      it('should return not_eligible when an active non-referral org shares the same email', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: null, email: 'shared@corp.com' }),
        );
        mockPrisma.organization.findFirst.mockResolvedValueOnce({
          id: 'active-client-id',
        });

        const result = await service.check('org-1');

        expect(result).toEqual({
          eligible: false,
          reason: 'active_client_block: organization_active_by_email',
          matchedOrganizationId: 'active-client-id',
        });
        expect(mockPrisma.organization.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              email: { equals: 'shared@corp.com', mode: 'insensitive' },
              id: { not: 'org-1' },
              referred_by_affiliate_id: null,
              status: 'active',
            }),
          }),
        );
      });

      it('should return eligible when email matches another referral org (not a real client)', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: null, email: 'shared@corp.com' }),
        );
        // Email match query (referred_by_affiliate_id: null) returns nothing
        mockPrisma.organization.findFirst.mockResolvedValueOnce(null);

        const result = await service.check('org-1');

        expect(result).toEqual({ eligible: true });
      });

      it('should return eligible when no email match found', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: null, email: 'unique@acme.com' }),
        );
        mockPrisma.organization.findFirst.mockResolvedValue(null);

        const result = await service.check('org-1');

        expect(result).toEqual({ eligible: true });
      });

      it('should skip email check when org has no email', async () => {
        mockPrisma.organization.findUnique.mockResolvedValue(
          makeOrg({ hubspot_id: null, email: null }),
        );

        const result = await service.check('org-1');

        expect(result).toEqual({ eligible: true });
        expect(mockPrisma.organization.findFirst).not.toHaveBeenCalled();
      });
    });

    it('should use hubspot_id over email when both are present and hubspot_id blocks', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ hubspot_id: 'hs-xyz', email: 'contact@acme.com' }),
      );
      // hubspot_id check finds a match → should return immediately without checking email
      mockPrisma.organization.findFirst.mockResolvedValueOnce({
        id: 'hubspot-match-id',
      });

      const result = await service.check('org-1');

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(
        'active_client_block: organization_active_by_hubspot_id',
      );
      // Only one findFirst call — email check was skipped
      expect(mockPrisma.organization.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // runAndPersist
  // -------------------------------------------------------------------------
  describe('runAndPersist', () => {
    it('should no-op (leave status untouched) and write audit log when no match and no prior block', async () => {
      // check() returns eligible, and findUnique (both calls) returns an org
      // with no prior active_client_block reason and an existing pending_confirmation status.
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          hubspot_id: null,
          email: 'unique@acme.com',
          med_alliance_referral_status: 'pending_confirmation',
          med_alliance_block_reason: null,
        }),
      );
      mockPrisma.organization.findFirst.mockResolvedValue(null);
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.runAndPersist('org-1', 'user-1', 'user');

      // No update call — only the two findUnique reads (check() + current lookup) plus the
      // final no-op findUnique read that stands in for `updated`.
      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
      expect(mockPrisma.organization.findUnique).toHaveBeenCalledTimes(3);
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entity_type: 'referred_company',
            entity_id: 'org-1',
            event: 'eligibility_check',
            old_status: 'pending_confirmation',
            new_status: 'pending_confirmation',
            source: 'user',
            actor_user_id: 'user-1',
            reason: null,
          }),
        }),
      );
      expect(result).toEqual(expect.objectContaining({ id: 'org-1' }));
    });

    it('should clear a prior active_client_block reason without touching status when no longer matched', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({
          hubspot_id: null,
          email: 'unique@acme.com',
          med_alliance_referral_status: 'not_eligible',
          med_alliance_block_reason:
            'active_client_block: organization_active_by_email',
        }),
      );
      mockPrisma.organization.findFirst.mockResolvedValue(null);
      mockPrisma.organization.update.mockResolvedValue({
        id: 'org-1',
        med_alliance_referral_status: 'not_eligible',
        med_alliance_block_reason: null,
      });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      const result = await service.runAndPersist('org-1', 'user-1', 'user');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        data: { med_alliance_block_reason: null },
      });
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            old_status: 'not_eligible',
            new_status: 'not_eligible',
            reason: null,
          }),
        }),
      );
      expect(result).toEqual(expect.objectContaining({ id: 'org-1' }));
    });

    it('should update org with not_eligible when hubspot_id match found', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ hubspot_id: 'hs-999' }),
      );
      mockPrisma.organization.findFirst.mockResolvedValueOnce({
        id: 'client-org',
      });
      mockPrisma.organization.update.mockResolvedValue({
        id: 'org-1',
        med_alliance_referral_status: 'not_eligible',
      });
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.runAndPersist('org-1', 'admin-1', 'admin_action');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        data: {
          med_alliance_referral_status: 'not_eligible',
          med_alliance_block_reason:
            'active_client_block: organization_active_by_hubspot_id',
        },
      });
      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            new_status: 'not_eligible',
            reason: 'active_client_block: organization_active_by_hubspot_id',
            source: 'admin_action',
            actor_user_id: 'admin-1',
            metadata: { matched_organization_id: 'client-org' },
          }),
        }),
      );
    });

    it('should set metadata.matched_organization_id only when there is a match', async () => {
      // eligible — no match
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ email: 'a@b.com', hubspot_id: null }),
      );
      mockPrisma.organization.findFirst.mockResolvedValue(null);
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.runAndPersist('org-1', 'user-1', 'user');

      const auditCall = mockPrisma.medAllianceAuditLog.create.mock.calls[0][0];
      expect(auditCall.data.metadata).toBeUndefined();
    });

    it('should use source = sync when called from sync context', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.organization.findFirst.mockResolvedValue(null);
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.runAndPersist('org-1', 'system', 'sync');

      const auditCall = mockPrisma.medAllianceAuditLog.create.mock.calls[0][0];
      expect(auditCall.data.source).toBe('sync');
    });

    it('should always write exactly one audit log entry per call', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockPrisma.organization.findFirst.mockResolvedValue(null);
      mockPrisma.organization.update.mockResolvedValue({});
      mockPrisma.medAllianceAuditLog.create.mockResolvedValue({});

      await service.runAndPersist('org-1', 'user-1', 'user');

      expect(mockPrisma.medAllianceAuditLog.create).toHaveBeenCalledTimes(1);
    });
  });
});
