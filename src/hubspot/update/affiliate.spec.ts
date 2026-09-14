import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { AffiliateUpdateService } from './affiliate';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const auditMock = { log: jest.fn() };

const OBJECT_TYPE = 'p20630393_growth_partners';

describe('AffiliateUpdateService', () => {
  let service: AffiliateUpdateService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AffiliateUpdateService,
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<AffiliateUpdateService>(AffiliateUpdateService);
  });

  // ── deactivate ────────────────────────────────────────────────────────────────

  describe('deactivate()', () => {
    it('logs UPDATE with hs_pipeline_stage deactivated on success', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.deactivate('hs-gp-001', 'user-abc', 'aff-db-uuid');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.affiliate,
          entityId: 'aff-db-uuid',
          hubspotObjectId: 'hs-gp-001',
          hubspotObjectType: OBJECT_TYPE,
          action: HubspotAuditAction.UPDATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { hs_pipeline_stage: '1329693872' },
        }),
      );
    });

    it('falls back to hubspotId as entityId when entityId not provided', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      await service.deactivate('hs-gp-001');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hs-gp-001' }),
      );
    });

    it('logs success=false on HTTP failure', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 400 },
        message: 'Bad Request',
      });

      await service.deactivate('hs-gp-001', 'user-abc', 'aff-db-uuid');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: '400' }),
      );
    });
  });

  // ── reactivate ────────────────────────────────────────────────────────────────

  describe('reactivate()', () => {
    it('logs UPDATE with hs_pipeline_stage reactivated on success', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.reactivate('hs-gp-001', 'user-abc', 'aff-db-uuid');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          payload: { hs_pipeline_stage: '1329693870' },
        }),
      );
    });

    it('logs success=false on failure', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        message: 'Network error',
        code: 'ECONNRESET',
      });
      await service.reactivate('hs-gp-001');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: 'ECONNRESET' }),
      );
    });
  });

  // ── updateCommission ──────────────────────────────────────────────────────────

  describe('updateCommission()', () => {
    it('logs UPDATE with alliance_commission in payload on success', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.updateCommission(
        'hs-gp-001',
        12,
        'user-abc',
        'aff-db-uuid',
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          payload: { alliance_commission: 12 },
        }),
      );
    });

    it('logs success=false on HTTP failure', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 422 },
        message: 'Unprocessable Entity',
      });

      await service.updateCommission('hs-gp-001', 10);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: '422' }),
      );
    });
  });

  // ── updateBankingData ─────────────────────────────────────────────────────────

  describe('updateBankingData()', () => {
    it('logs UPDATE with banking fields in payload on success', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.updateBankingData(
        'hs-gp-001',
        'John Doe',
        '****1234',
        'user-abc',
        'aff-db-uuid',
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          payload: { fields: ['account_name', 'account_number'] },
        }),
      );
    });

    it('logs success=false on failure', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        message: 'error',
        code: 'ERR_NETWORK',
      });
      await service.updateBankingData('hs-gp-001', 'Name', '9999');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
      );
    });
  });

  // ── clearBankingData ──────────────────────────────────────────────────────────

  describe('clearBankingData()', () => {
    it('logs UPDATE with cleared=true in payload on success', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });

      await service.clearBankingData('hs-gp-001', 'user-abc', 'aff-db-uuid');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          payload: {
            fields: ['account_name', 'account_number'],
            cleared: true,
          },
        }),
      );
    });

    it('logs success=false on failure', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        message: 'timeout',
        code: 'ETIMEDOUT',
      });
      await service.clearBankingData('hs-gp-001');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, errorCode: 'ETIMEDOUT' }),
      );
    });
  });

  // ── source inference (shared across all methods) ──────────────────────────────

  describe('source inference', () => {
    it('uses user_action source when actorUserId is present', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      await service.deactivate('hs-gp-001', 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron source when actorUserId is absent', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      await service.reactivate('hs-gp-001');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });
});
