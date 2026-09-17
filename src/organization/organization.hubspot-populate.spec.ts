import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { OrganizationService } from './organization.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { HandlerOrganizationCreation } from '../hubspot/handlers/organizationCreation';
import { HandlerDealCreation } from '../hubspot/handlers/dealCreation';
import { NotificationsService } from '../notifications/notifications.service';
import { SqsService } from '../sqs/sqs.service';
import { ContactService } from '../contacts/contacts.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { CandidateAuditService } from '../candidate/candidate-audit.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrismaService = {
  organization: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
};

const mockAuthService = {};
const mockHubspotService = {};
const handlerOrganizationCreationMock = { execute: jest.fn() };
const handlerDealCreationMock = { execute: jest.fn() };
const mockNotificationsService = {};
const mockSqsService = {};
const mockContactService = {};

const businessUnitContextMock = {
  getVisibleHubspotValues: jest.fn(),
};

const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

function emptySearchResponse() {
  return { data: { results: [], paging: {} } };
}

describe('OrganizationService — HubSpot BU-driven filterGroups', () => {
  let service: OrganizationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: HubspotService, useValue: mockHubspotService },
        {
          provide: HandlerOrganizationCreation,
          useValue: handlerOrganizationCreationMock,
        },
        { provide: HandlerDealCreation, useValue: handlerDealCreationMock },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: SqsService, useValue: mockSqsService },
        { provide: ContactService, useValue: mockContactService },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    service = module.get<OrganizationService>(OrganizationService);

    jest.clearAllMocks();
    mockPrismaService.organization.deleteMany.mockReset();
    mockPrismaService.organization.createMany.mockReset();
    handlerOrganizationCreationMock.execute.mockReset();
    businessUnitContextMock.getVisibleHubspotValues.mockReset();
    businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
      'MedVirtual',
      'Berry Virtual',
    ]);
    mockedAxios.post.mockResolvedValue(emptySearchResponse());
  });

  // ── getAllFromHubspot ──────────────────────────────────────────────────────

  describe('getAllFromHubspot', () => {
    it('builds one filterGroup per visible BU (derived from getVisibleHubspotValues)', async () => {
      await service.getAllFromHubspot();

      expect(
        businessUnitContextMock.getVisibleHubspotValues,
      ).toHaveBeenCalled();
      const body = mockedAxios.post.mock.calls[0][1] as any;
      const values = body.filterGroups.map(
        (g: any) =>
          g.filters.find((f: any) => f.propertyName === 'business_unit').value,
      );
      expect(values).toEqual(['MedVirtual', 'Berry Virtual']);
    });

    it('includes a filterGroup for a third, newly-visible BU (e.g. MMVA)', async () => {
      businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
        'MedVirtual',
        'Berry Virtual',
        'MMVA',
      ]);

      await service.getAllFromHubspot();

      const body = mockedAxios.post.mock.calls[0][1] as any;
      const values = body.filterGroups.map(
        (g: any) =>
          g.filters.find((f: any) => f.propertyName === 'business_unit').value,
      );
      expect(values).toContain('MMVA');
      expect(body.filterGroups).toHaveLength(3);
    });

    it('excludes no visible BU: filterGroups count always matches getVisibleHubspotValues length', async () => {
      businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
        'MedVirtual',
      ]);

      await service.getAllFromHubspot();

      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(body.filterGroups).toHaveLength(1);
    });
  });

  // ── populateDbFromHubspotX ─────────────────────────────────────────────────

  describe('populateDbFromHubspotX', () => {
    it('builds filterGroups from getVisibleHubspotValues instead of hardcoded literals', async () => {
      mockPrismaService.organization.deleteMany.mockResolvedValue({ count: 0 });

      await service.populateDbFromHubspotX();

      expect(
        businessUnitContextMock.getVisibleHubspotValues,
      ).toHaveBeenCalled();
      const body = mockedAxios.post.mock.calls[0][1] as any;
      const values = body.filterGroups.map(
        (g: any) =>
          g.filters.find((f: any) => f.propertyName === 'business_unit').value,
      );
      expect(values).toEqual(['MedVirtual', 'Berry Virtual']);
    });

    it('includes MMVA once visible, with no destructive deleteMany of unrecognized BUs', async () => {
      businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
        'MedVirtual',
        'Berry Virtual',
        'MMVA',
      ]);
      mockPrismaService.organization.deleteMany.mockResolvedValue({ count: 0 });

      await service.populateDbFromHubspotX();

      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(body.filterGroups).toHaveLength(3);
      // Referred-orgs guard is preserved — deleteMany only ever excludes
      // referred organizations, never filtered by BU literal.
      expect(mockPrismaService.organization.deleteMany).toHaveBeenCalledWith({
        where: { hubspot_id: { not: null }, referred_by_affiliate_id: null },
      });
    });
  });

  // ── populateDbFromHubspot (paginated) ──────────────────────────────────────

  describe('populateDbFromHubspot', () => {
    it('builds filterGroups from getVisibleHubspotValues on every page request', async () => {
      mockPrismaService.organization.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.organization.createMany.mockResolvedValue({ count: 0 });

      await service.populateDbFromHubspot();

      expect(
        businessUnitContextMock.getVisibleHubspotValues,
      ).toHaveBeenCalled();
      const body = mockedAxios.post.mock.calls[0][1] as any;
      const values = body.filterGroups.map(
        (g: any) =>
          g.filters.find((f: any) => f.propertyName === 'business_unit').value,
      );
      expect(values).toEqual(['MedVirtual', 'Berry Virtual']);
    });

    it('reflects a visible MMVA BU across paginated filterGroups', async () => {
      businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
        'MedVirtual',
        'Berry Virtual',
        'MMVA',
      ]);
      mockPrismaService.organization.deleteMany.mockResolvedValue({ count: 0 });
      mockPrismaService.organization.createMany.mockResolvedValue({ count: 0 });

      await service.populateDbFromHubspot();

      const body = mockedAxios.post.mock.calls[0][1] as any;
      expect(body.filterGroups).toHaveLength(3);
    });
  });
});
