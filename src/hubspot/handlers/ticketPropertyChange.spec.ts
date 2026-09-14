import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { HandlerTicketPropertyChange } from './ticketPropertyChange';
import { PrismaService } from '../../prisma/prisma.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    patch: jest.fn(),
  },
}));

const prismaMock = {
  hireRequest: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  uSER: {
    findUnique: jest.fn(),
  },
};

const BASE_HR = {
  id: 'hr-id-1',
  hubspot_ticket_id: 'ticket-123',
};

const BASE_HR_WITH_ORG: {
  hubspot_pairing_request_type: string | null;
  hubspot_numberVA: number | null;
  hubspot_role_type: string | null;
  availability: string | null;
  organization: { name: string };
} = {
  hubspot_pairing_request_type: 'New Client',
  hubspot_numberVA: 2,
  hubspot_role_type: 'Medical Scribe',
  availability: 'full-time',
  organization: { name: 'Acme Health' },
};

describe('HandlerTicketPropertyChange', () => {
  let handler: HandlerTicketPropertyChange;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerTicketPropertyChange,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    handler = module.get<HandlerTicketPropertyChange>(
      HandlerTicketPropertyChange,
    );
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  // ─── execute: early exits ──────────────────────────────────────────────────

  describe('execute — hire request not found', () => {
    it('should return undefined when HR does not exist in DB', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);

      const result = await handler.execute({
        objectId: 'ticket-999',
        propertyName: 'subject',
        propertyValue: 'test',
      });

      expect(result).toBeUndefined();
      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('execute — unknown property', () => {
    it('should return undefined for a property not in the dictionary', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'unknown_property',
        propertyValue: 'x',
      });

      expect(result).toBeUndefined();
      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('execute — hubspot_pipeline_stage', () => {
    it('should skip update and return false for pipeline stage changes', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'hs_pipeline_stage',
        propertyValue: '2',
      });

      expect(result).toBe(false);
      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
    });
  });

  // ─── execute: va_pay_rate_range ────────────────────────────────────────────

  describe('execute — va_pay_rate_range', () => {
    it('should parse and update salary_range_from and salary_range_to', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.hireRequest.update.mockResolvedValue({});

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'va_pay_rate_range',
        propertyValue: '120 - 150',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: BASE_HR.id },
        data: { salary_range_from: 120, salary_range_to: 150 },
      });
      expect(result).toBe(true);
    });
  });

  // ─── execute: pairing_specialist ──────────────────────────────────────────

  describe('execute — pairing_specialist', () => {
    it('should update assign_sourcing_id when user is found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.uSER.findUnique.mockResolvedValue({ id: 'user-abc' });
      prismaMock.hireRequest.update.mockResolvedValue({});

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'pairing_specialist',
        propertyValue: 'hs-owner-1',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: BASE_HR.id },
        data: { assign_sourcing_id: 'user-abc' },
      });
      expect(result).toBe(true);
    });

    it('should return true without updating when user is not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.uSER.findUnique.mockResolvedValue(null);

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'pairing_specialist',
        propertyValue: 'hs-unknown',
      });

      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  // ─── execute: hubspot_owner_id ────────────────────────────────────────────

  describe('execute — hubspot_owner_id', () => {
    it('should update assign_user_id when user is found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.uSER.findUnique.mockResolvedValue({ id: 'user-xyz' });
      prismaMock.hireRequest.update.mockResolvedValue({});

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'hubspot_owner_id',
        propertyValue: 'hs-owner-2',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: BASE_HR.id },
        data: { assign_user_id: 'user-xyz' },
      });
      expect(result).toBe(true);
    });

    it('should return true without updating when user is not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.uSER.findUnique.mockResolvedValue(null);

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'hubspot_owner_id',
        propertyValue: 'hs-unknown',
      });

      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  // ─── execute: staffing_coordinator ────────────────────────────────────────

  describe('execute — staffing_coordinator', () => {
    it('should update assign_staffing_coordinator when user is found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.uSER.findUnique.mockResolvedValue({ id: 'user-staff' });
      prismaMock.hireRequest.update.mockResolvedValue({});

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'staffing_coordinator',
        propertyValue: 'hs-owner-3',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: BASE_HR.id },
        data: { assign_staffing_coordinator: 'user-staff' },
      });
      expect(result).toBe(true);
    });

    it('should return true without updating when user is not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.uSER.findUnique.mockResolvedValue(null);

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'staffing_coordinator',
        propertyValue: 'hs-unknown',
      });

      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  // ─── execute: generic dictionary fields (no title sync) ───────────────────

  describe('execute — generic field (no title sync)', () => {
    it('should update the mapped DB field without syncing title', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);
      prismaMock.hireRequest.update.mockResolvedValue({});

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'language',
        propertyValue: 'Spanish',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: BASE_HR.id },
        data: { hubspot_language: 'Spanish' },
      });
      expect(axios.patch).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should parse number_of_vas as integer', async () => {
      prismaMock.hireRequest.findUnique
        .mockResolvedValueOnce(BASE_HR)
        .mockResolvedValueOnce(BASE_HR_WITH_ORG);
      prismaMock.hireRequest.update.mockResolvedValue({});
      (axios.patch as jest.Mock).mockResolvedValue({ status: 200 });

      await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'number_of_vas',
        propertyValue: '3',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenNthCalledWith(1, {
        where: { id: BASE_HR.id },
        data: { hubspot_numberVA: 3 },
      });
    });
  });

  // ─── execute: title-affecting fields → syncTitle ──────────────────────────

  describe('execute — title-affecting fields trigger syncTitle', () => {
    beforeEach(() => {
      // First findUnique: find HR by hubspot_ticket_id
      // Second findUnique: syncTitle re-fetches HR with organization
      prismaMock.hireRequest.findUnique
        .mockResolvedValueOnce(BASE_HR)
        .mockResolvedValueOnce(BASE_HR_WITH_ORG);
      prismaMock.hireRequest.update.mockResolvedValue({});
      (axios.patch as jest.Mock).mockResolvedValue({ status: 200 });
    });

    it('should sync title after va_deployment_type change', async () => {
      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'va_deployment_type',
        propertyValue: 'Part-Time',
      });

      // First update: the field itself
      expect(prismaMock.hireRequest.update).toHaveBeenNthCalledWith(1, {
        where: { id: BASE_HR.id },
        data: { availability: 'Part-Time' },
      });
      // Second update: the recalculated title
      expect(prismaMock.hireRequest.update).toHaveBeenNthCalledWith(2, {
        where: { id: BASE_HR.id },
        data: { title: expect.any(String) },
      });
      expect(axios.patch).toHaveBeenCalledWith(
        `https://api.hubapi.com/crm/v3/objects/tickets/ticket-123`,
        { properties: { subject: expect.any(String) } },
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Bearer'),
          }),
        }),
      );
      expect(result).toBe(true);
    });

    it('should sync title after number_of_vas change', async () => {
      await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'number_of_vas',
        propertyValue: '2',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledTimes(2);
      expect(axios.patch).toHaveBeenCalledTimes(1);
    });

    it('should sync title after pairing_request_type change', async () => {
      await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'pairing_request_type',
        propertyValue: 'Upsell Agent',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledTimes(2);
      expect(axios.patch).toHaveBeenCalledTimes(1);
    });

    it('should NOT sync title for non-title-affecting fields', async () => {
      // Reset mocks: only one findUnique call expected
      prismaMock.hireRequest.findUnique.mockReset();
      prismaMock.hireRequest.findUnique.mockResolvedValue(BASE_HR);

      await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'language',
        propertyValue: 'English',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledTimes(1);
      expect(axios.patch).not.toHaveBeenCalled();
    });
  });

  // ─── buildTitle (via syncTitle) ────────────────────────────────────────────

  describe('buildTitle — title formula', () => {
    let savedEnvironment: string | undefined;

    beforeEach(() => {
      savedEnvironment = process.env.ENVIRONMENT;
      delete process.env.ENVIRONMENT; // ensure non-production by default
    });

    afterEach(() => {
      if (savedEnvironment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        process.env.ENVIRONMENT = savedEnvironment;
      }
    });

    const triggerSyncTitle = async (
      hrData: Partial<{
        hubspot_pairing_request_type: string | null;
        hubspot_numberVA: number | null;
        hubspot_role_type: string | null;
        availability: string | null;
        organization: { name: string };
      }>,
    ) => {
      prismaMock.hireRequest.findUnique
        .mockResolvedValueOnce(BASE_HR)
        .mockResolvedValueOnce({ ...BASE_HR_WITH_ORG, ...hrData });
      prismaMock.hireRequest.update.mockResolvedValue({});
      (axios.patch as jest.Mock).mockResolvedValue({ status: 200 });

      await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'number_of_vas',
        propertyValue: '2',
      });

      const titleUpdate = prismaMock.hireRequest.update.mock.calls[1][0];
      return titleUpdate.data.title as string;
    };

    it('should build full title: TEST HR - OrgName - NVAs - Role - Availability', async () => {
      const title = await triggerSyncTitle({});
      // NODE_ENV in jest is 'test', so prefix is 'TEST HR'
      expect(title).toBe(
        'TEST HR - Acme Health - 2 - Medical Scribe - Full-Time',
      );
    });

    it('should add UPS prefix for Upsell Agent request type', async () => {
      const title = await triggerSyncTitle({
        hubspot_pairing_request_type: 'Upsell Agent',
      });
      expect(title).toMatch(/^UPS TEST HR/);
    });

    it('should add REP prefix for Agent Replacement request type', async () => {
      const title = await triggerSyncTitle({
        hubspot_pairing_request_type: 'Agent Replacement',
      });
      expect(title).toMatch(/^REP TEST HR/);
    });

    it('should omit organization name when not present', async () => {
      const title = await triggerSyncTitle({ organization: { name: '' } });
      expect(title).not.toContain('Acme Health');
      expect(title).toBe('TEST HR - 2 - Medical Scribe - Full-Time');
    });

    it('should omit number of VAs when null', async () => {
      const title = await triggerSyncTitle({ hubspot_numberVA: null });
      expect(title).toBe('TEST HR - Acme Health - Medical Scribe - Full-Time');
    });

    it('should omit hubspot_role_type when null', async () => {
      const title = await triggerSyncTitle({ hubspot_role_type: null });
      expect(title).toBe('TEST HR - Acme Health - 2 - Full-Time');
    });

    it('should omit availability when null', async () => {
      const title = await triggerSyncTitle({ availability: null });
      expect(title).toBe('TEST HR - Acme Health - 2 - Medical Scribe');
    });

    it('should capitalize each segment of hyphenated availability', async () => {
      const title = await triggerSyncTitle({ availability: 'part-time' });
      expect(title).toContain('Part-Time');
    });

    it('should return only the prefix when all optional fields are missing', async () => {
      const title = await triggerSyncTitle({
        organization: { name: '' },
        hubspot_numberVA: null,
        hubspot_role_type: null,
        availability: null,
      });
      expect(title).toBe('TEST HR');
    });

    it('should use HR (not TEST HR) in production environment', async () => {
      process.env.ENVIRONMENT = 'PROD';

      const title = await triggerSyncTitle({});

      expect(title).toMatch(/^HR - /);
      expect(title).not.toContain('TEST');
    });
  });

  // ─── syncTitle: HubSpot API failure ───────────────────────────────────────

  describe('syncTitle — HubSpot API failure', () => {
    it('should update DB title but not throw when HubSpot PATCH fails', async () => {
      prismaMock.hireRequest.findUnique
        .mockResolvedValueOnce(BASE_HR)
        .mockResolvedValueOnce(BASE_HR_WITH_ORG);
      prismaMock.hireRequest.update.mockResolvedValue({});
      (axios.patch as jest.Mock).mockRejectedValue({
        response: { data: 'HubSpot error' },
      });

      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const result = await handler.execute({
        objectId: 'ticket-123',
        propertyName: 'number_of_vas',
        propertyValue: '2',
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Error syncing title to HubSpot:',
        expect.anything(),
      );
      expect(result).toBe(true);

      consoleSpy.mockRestore();
    });
  });
});
