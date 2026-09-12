import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { OwnerCreationService } from './Owner';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: { update: jest.fn() },
};
const auditMock = { log: jest.fn() };

const baseData = {
  id: 'user-uuid-001',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
};

describe('OwnerCreationService', () => {
  let service: OwnerCreationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OwnerCreationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<OwnerCreationService>(OwnerCreationService);
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-owner-999' } });
      prismaMock.uSER.update.mockResolvedValueOnce({});
    });

    it('returns true on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe(true);
    });

    it('saves hubspot_id to USER record', async () => {
      await service.execute(baseData, 'user-abc');
      expect(prismaMock.uSER.update).toHaveBeenCalledWith({
        where: { id: 'user-uuid-001' },
        data: { hubspot_id: 'hs-owner-999' },
      });
    });

    it('logs CREATE with success=true and correct fields', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.owner,
          entityId: 'user-uuid-001',
          hubspotObjectId: 'hs-owner-999',
          hubspotObjectType: 'owners',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { email: 'john@example.com' },
          response: { id: 'hs-owner-999' },
        }),
      );
    });

    it('uses cron source when actorUserId is absent', async () => {
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          source: HubspotAuditSource.cron,
          success: true,
        }),
      );
    });
  });

  // ── Failure path ──────────────────────────────────────────────────────────────

  describe('execute() — failure', () => {
    it('logs CREATE with success=false on HTTP error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        response: { status: 400, data: { message: 'Bad Request' } },
        message: 'Bad Request',
      });

      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.owner,
          entityId: 'user-uuid-001',
          hubspotObjectType: 'owners',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: false,
          errorCode: '400',
          errorMessage: 'Bad Request',
        }),
      );
    });

    it('logs success=false with error.code on network error', async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNRESET',
      });

      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ECONNRESET',
          errorMessage: 'Network Error',
        }),
      );
    });

    it('does not call prisma.uSER.update when API fails', async () => {
      mockedAxios.post.mockRejectedValueOnce({ message: 'fail', code: 'ERR' });
      await service.execute(baseData);
      expect(prismaMock.uSER.update).not.toHaveBeenCalled();
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId is provided', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { id: 'hs-1' } });
      prismaMock.uSER.update.mockResolvedValueOnce({});

      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron when actorUserId is absent', async () => {
      mockedAxios.post.mockRejectedValueOnce({ message: 'err', code: 'ERR' });
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });
});
