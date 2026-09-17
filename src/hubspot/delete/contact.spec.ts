import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { ContactDeleteService } from './contact';
import { HubspotAuditService } from '../hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const auditMock = { log: jest.fn() };

const contactData = {
  id: 'contact-db-uuid',
  hubspot_contact_id: 'hs-contact-555',
};

describe('ContactDeleteService', () => {
  let service: ContactDeleteService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactDeleteService,
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<ContactDeleteService>(ContactDeleteService);
  });

  describe('execute() — success', () => {
    it('returns true on successful deletion', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      const result = await service.execute(contactData, 'user-abc');
      expect(result).toBe(true);
    });

    it('logs DELETE audit with success=true', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      await service.execute(contactData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-abc',
          entityType: HubspotEntityType.contact,
          entityId: 'contact-db-uuid',
          hubspotObjectId: 'hs-contact-555',
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.DELETE,
          source: HubspotAuditSource.user_action,
          success: true,
        }),
      );
    });

    it('uses hubspot_contact_id as entityId fallback when data.id is absent', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      await service.execute(
        { hubspot_contact_id: 'hs-contact-555' },
        'user-abc',
      );

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'hs-contact-555' }),
      );
    });

    it('sets source=cron when no actorUserId', async () => {
      mockedAxios.delete.mockResolvedValueOnce({ status: 204 });
      await service.execute(contactData);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ source: HubspotAuditSource.cron }),
      );
    });
  });

  describe('execute() — failure', () => {
    it('logs DELETE audit with success=false on HTTP error', async () => {
      mockedAxios.delete.mockRejectedValueOnce({
        response: { status: 404, data: 'Not Found' },
        message: 'Not Found',
      });

      await service.execute(contactData, 'user-abc');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorCode: '404',
          errorMessage: 'Not Found',
        }),
      );
    });

    it('does not return true on failure', async () => {
      mockedAxios.delete.mockRejectedValueOnce({
        message: 'error',
        code: 'ECONNREFUSED',
      });
      const result = await service.execute(contactData, 'user-abc');
      expect(result).not.toBe(true);
    });
  });
});
