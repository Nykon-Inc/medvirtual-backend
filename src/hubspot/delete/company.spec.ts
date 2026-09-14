import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { CompanyDeleteService } from './company';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const auditMock = { log: jest.fn() };

describe('CompanyDeleteService', () => {
  let service: CompanyDeleteService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyDeleteService,
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<CompanyDeleteService>(CompanyDeleteService);
  });

  describe('execute() — success', () => {
    it('returns true on successful deletion', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      const result = await service.execute(
        'hs-company-111',
        'user-abc',
        'org-db-uuid',
      );
      expect(result).toBe(true);
    });

    it('logs DELETE audit with success=true using DB entityId when provided', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      await service.execute('hs-company-111', 'user-abc', 'org-db-uuid');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.organization,
          entityId: 'org-db-uuid',
          hubspotObjectId: 'hs-company-111',
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.DELETE,
          source: HubspotAuditSource.user_action,
          success: true,
        }),
      );
    });

    it('falls back to hubspotCompanyId as entityId when entityId is not provided', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      await service.execute('hs-company-111', 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hs-company-111' }),
      );
    });

    it('sets source=cron when no actorUserId', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      await service.execute('hs-company-111');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });

  describe('execute() — failure', () => {
    it('returns false on Hubspot API error', async () => {
      mockedAxios.delete.mockRejectedValueOnce({
        response: { status: 500, data: 'Server Error' },
        message: 'Server Error',
      });

      const result = await service.execute(
        'hs-company-111',
        'user-abc',
        'org-db-uuid',
      );
      expect(result).toBe(false);
    });

    it('logs DELETE audit with success=false on HTTP error', async () => {
      mockedAxios.delete.mockRejectedValueOnce({
        response: { status: 403, data: 'Forbidden' },
        message: 'Forbidden',
      });

      await service.execute('hs-company-111', 'user-abc', 'org-db-uuid');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: '403',
          errorMessage: 'Forbidden',
          entityId: 'org-db-uuid',
        }),
      );
    });

    it('logs DELETE audit with success=false on network error', async () => {
      mockedAxios.delete.mockRejectedValueOnce({
        code: 'ETIMEDOUT',
        message: 'Connection timed out',
      });

      await service.execute('hs-company-111');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ETIMEDOUT',
        }),
      );
    });
  });
});
