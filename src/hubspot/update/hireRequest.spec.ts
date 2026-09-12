import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { HireRequestUpdateService } from './hireRequest';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerCreationService } from '../create/Owner';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: { findUnique: jest.fn() },
};

const ownerCreationMock = { execute: jest.fn() };
const auditMock = { log: jest.fn() };

const baseData = {
  id: 'hr-uuid-001',
  hubspot_ticket_id: 'hs-ticket-123',
  title: 'Updated VA Request',
  availability: 'full-time',
  priority: 'medium',
  salary_range_from: 20,
  salary_range_to: 30,
};

describe('HireRequestUpdateService', () => {
  let service: HireRequestUpdateService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HireRequestUpdateService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: OwnerCreationService, useValue: ownerCreationMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<HireRequestUpdateService>(HireRequestUpdateService);
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.patch.mockResolvedValueOnce({
        data: { id: 'hs-ticket-123' },
      });
    });

    it('returns true on successful update', async () => {
      const result = await service.execute(baseData, undefined, 'user-abc');
      expect(result).toBe(true);
    });

    it('logs UPDATE audit with success=true', async () => {
      await service.execute(baseData, undefined, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.hire_request,
          entityId: 'hr-uuid-001',
          hubspotObjectId: 'hs-ticket-123',
          hubspotObjectType: 'tickets',
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });

    it('sets source=user_action when actorUserId is provided', async () => {
      await service.execute(baseData, undefined, 'user-abc');
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('sets source=cron when actorUserId is absent', async () => {
      await service.execute(baseData);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });

    it('logs {specificField} in payload when specificField is provided', async () => {
      await service.execute(baseData, 'cancel_date', 'user-abc');
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { specificField: 'cancel_date' },
        }),
      );
    });

    it('logs {fields: [...]} in payload when specificField is absent', async () => {
      await service.execute(baseData, undefined, 'user-abc');
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ fields: expect.any(Array) }),
        }),
      );
    });
  });

  // ── entityId fallback chain ──────────────────────────────────────────────────

  describe('entityId resolution', () => {
    beforeEach(() => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
    });

    it('uses data.id when present', async () => {
      await service.execute({ ...baseData });
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hr-uuid-001' }),
      );
    });

    it('falls back to hubspot_ticket_id when data.id is absent', async () => {
      const { id: _omit, ...dataWithoutId } = baseData;
      await service.execute(dataWithoutId);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hs-ticket-123' }),
      );
    });

    it('falls back to "unknown" when both id and hubspot_ticket_id are absent', async () => {
      await service.execute({});
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'unknown' }),
      );
    });
  });

  // ── Failure path ─────────────────────────────────────────────────────────────

  describe('execute() — failure', () => {
    it('logs UPDATE audit with success=false on HTTP error', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 404 },
        message: 'Not Found',
      });

      await service.execute(baseData, undefined, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: '404',
          errorMessage: 'Not Found',
        }),
      );
    });

    it('does not throw to the caller on failure', async () => {
      mockedAxios.patch.mockRejectedValueOnce({ message: 'network error' });
      await expect(service.execute(baseData)).resolves.not.toThrow();
    });
  });
});
