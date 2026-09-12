import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { ContactUpdateService } from './contact';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../../common/dictionaries/contact-dictionary', () => ({
  dbToContactDictionary: {
    first_name: 'firstname',
    last_name: 'lastname',
    email: 'email',
    phone: 'phone',
  },
}));

const auditMock = { log: jest.fn() };

const baseData = {
  id: 'user-uuid-001',
  hubspot_contact_id: 'hs-contact-555',
  first_name: 'Alice',
  last_name: 'Wonder',
  email: 'alice@example.com',
  phone: '5551112222',
};

describe('ContactUpdateService', () => {
  let service: ContactUpdateService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactUpdateService,
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<ContactUpdateService>(ContactUpdateService);
  });

  // ── Success path ─────────────────────────────────────────────────────────────

  describe('execute() — success', () => {
    beforeEach(() => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
    });

    it('returns true on success', async () => {
      const result = await service.execute(baseData, 'user-abc');
      expect(result).toBe(true);
    });

    it('logs UPDATE with success=true and fields list', async () => {
      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.contact,
          entityId: 'user-uuid-001',
          hubspotObjectId: 'hs-contact-555',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.UPDATE,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: expect.objectContaining({ fields: expect.any(Array) }),
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

    it('falls back to hubspot_contact_id as entityId when id is missing', async () => {
      const dataWithoutId = { ...baseData, id: undefined };
      await service.execute(dataWithoutId, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hs-contact-555' }),
      );
    });
  });

  // ── Failure path ──────────────────────────────────────────────────────────────

  describe('execute() — failure', () => {
    it('logs UPDATE with success=false on HTTP error', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        response: { status: 404, data: {} },
        message: 'Not Found',
      });

      await service.execute(baseData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          entityId: 'user-uuid-001',
          hubspotObjectId: 'hs-contact-555',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.UPDATE,
          success: false,
          errorCode: '404',
          errorMessage: 'Not Found',
        }),
      );
    });

    it('logs success=false with error.code on network error', async () => {
      mockedAxios.patch.mockRejectedValueOnce({
        message: 'Network Error',
        code: 'ECONNRESET',
      });

      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: 'ECONNRESET',
          source: HubspotAuditSource.cron,
        }),
      );
    });
  });

  // ── Source inference ──────────────────────────────────────────────────────────

  describe('source inference', () => {
    it('uses user_action when actorUserId provided', async () => {
      mockedAxios.patch.mockResolvedValueOnce({ data: {} });
      await service.execute(baseData, 'user-123');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.user_action }),
      );
    });

    it('uses cron when actorUserId absent', async () => {
      mockedAxios.patch.mockRejectedValueOnce({ message: 'err', code: 'ERR' });
      await service.execute(baseData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });
});
