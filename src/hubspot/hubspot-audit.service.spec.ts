import { Test, TestingModule } from '@nestjs/testing';
import { HubspotAuditService } from './hubspot-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';

const prismaMock = {
  hubspotAuditLog: {
    create: jest.fn(),
  },
};

describe('HubspotAuditService', () => {
  let service: HubspotAuditService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HubspotAuditService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<HubspotAuditService>(HubspotAuditService);
  });

  // ── Core write ──────────────────────────────────────────────────────────────

  describe('log()', () => {
    it('creates a record with all mandatory fields', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        entityType: HubspotEntityType.hire_request,
        entityId: 'hr-uuid-001',
        hubspotObjectType: 'tickets',
        action: HubspotAuditAction.CREATE,
        source: HubspotAuditSource.user_action,
        success: true,
      });

      expect(prismaMock.hubspotAuditLog.create).toHaveBeenCalledTimes(1);
      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.entity_type).toBe(HubspotEntityType.hire_request);
      expect(data.entity_id).toBe('hr-uuid-001');
      expect(data.hubspot_object_type).toBe('tickets');
      expect(data.action).toBe(HubspotAuditAction.CREATE);
      expect(data.source).toBe(HubspotAuditSource.user_action);
      expect(data.success).toBe(true);
    });

    it('stores actorUserId and leaves actor_label null when actor is a user', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        actorUserId: 'user-123',
        entityType: HubspotEntityType.contact,
        entityId: 'contact-uuid',
        hubspotObjectType: 'contacts',
        action: HubspotAuditAction.UPDATE,
        source: HubspotAuditSource.user_action,
        success: true,
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.actor_user_id).toBe('user-123');
      expect(data.actor_label).toBeNull();
    });

    it('stores actorLabel and leaves actor_user_id null for non-human actors', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        actorLabel: 'WebhookHubspot',
        entityType: HubspotEntityType.organization,
        entityId: 'hs-obj-999',
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source: HubspotAuditSource.webhook,
        success: true,
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.actor_label).toBe('WebhookHubspot');
      expect(data.actor_user_id).toBeNull();
    });

    it('stores hubspotObjectId, payload, and response when provided', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        entityType: HubspotEntityType.hire_request,
        entityId: 'hr-001',
        hubspotObjectId: 'hs-ticket-555',
        hubspotObjectType: 'tickets',
        action: HubspotAuditAction.CREATE,
        source: HubspotAuditSource.user_action,
        success: true,
        payload: { title: 'New VA Request' },
        response: { id: 'hs-ticket-555' },
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.hubspot_object_id).toBe('hs-ticket-555');
      expect(data.payload).toEqual({ title: 'New VA Request' });
      expect(data.response).toEqual({ id: 'hs-ticket-555' });
    });

    it('stores error fields when success=false', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        entityType: HubspotEntityType.contact,
        entityId: 'contact-002',
        hubspotObjectType: 'contacts',
        action: HubspotAuditAction.DELETE,
        source: HubspotAuditSource.user_action,
        success: false,
        errorCode: '401',
        errorMessage: 'Unauthorized',
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.success).toBe(false);
      expect(data.error_code).toBe('401');
      expect(data.error_message).toBe('Unauthorized');
    });

    it('coerces undefined optional fields to null in the persisted record', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        entityType: HubspotEntityType.affiliate,
        entityId: 'aff-001',
        hubspotObjectType: 'p20630393_growth_partners',
        action: HubspotAuditAction.CREATE,
        source: HubspotAuditSource.user_action,
        success: true,
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.actor_user_id).toBeNull();
      expect(data.actor_label).toBeNull();
      expect(data.hubspot_object_id).toBeNull();
      expect(data.error_code).toBeNull();
      expect(data.error_message).toBeNull();
    });
  });

  // ── Fire-and-forget safety ──────────────────────────────────────────────────

  describe('error isolation', () => {
    it('swallows DB errors — never throws to the caller', async () => {
      prismaMock.hubspotAuditLog.create.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      await expect(
        service.log({
          entityType: HubspotEntityType.hire_request,
          entityId: 'hr-001',
          hubspotObjectType: 'tickets',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.user_action,
          success: true,
        }),
      ).resolves.toBeUndefined();
    });

    it('logs the DB error to console.error but does not propagate', async () => {
      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      prismaMock.hubspotAuditLog.create.mockRejectedValueOnce(
        new Error('Timeout'),
      );

      await service.log({
        entityType: HubspotEntityType.organization,
        entityId: 'org-001',
        hubspotObjectType: 'companies',
        action: HubspotAuditAction.UPDATE,
        source: HubspotAuditSource.cron,
        success: true,
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        '[HubspotAudit] Failed to write audit log:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  // ── Source inference ────────────────────────────────────────────────────────

  describe('source field semantics', () => {
    it('accepts source=cron for scheduled operations', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        entityType: HubspotEntityType.candidate,
        entityId: 'cand-001',
        hubspotObjectType: 'custom_object',
        action: HubspotAuditAction.SYNC,
        source: HubspotAuditSource.cron,
        success: true,
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.source).toBe(HubspotAuditSource.cron);
    });

    it('accepts source=bulk_sync for batch operations', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        actorLabel: 'BulkSync',
        entityType: HubspotEntityType.candidate,
        entityId: 'bulk',
        hubspotObjectType: 'custom_object',
        action: HubspotAuditAction.BATCH_UPDATE,
        source: HubspotAuditSource.bulk_sync,
        success: true,
        payload: { count: 50 },
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.source).toBe(HubspotAuditSource.bulk_sync);
      expect(data.actor_label).toBe('BulkSync');
    });

    it('accepts source=webhook for inbound Hubspot events', async () => {
      prismaMock.hubspotAuditLog.create.mockResolvedValueOnce({});

      await service.log({
        actorLabel: 'WebhookHubspot',
        entityType: HubspotEntityType.deal,
        entityId: '12345',
        hubspotObjectId: '12345',
        hubspotObjectType: 'deals',
        action: HubspotAuditAction.CREATE,
        source: HubspotAuditSource.webhook,
        success: true,
      });

      const data = prismaMock.hubspotAuditLog.create.mock.calls[0][0].data;
      expect(data.source).toBe(HubspotAuditSource.webhook);
    });
  });
});
