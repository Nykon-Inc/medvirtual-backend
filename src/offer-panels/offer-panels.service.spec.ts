import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OfferPanelsService } from './offer-panels.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandidatesService } from '../candidate/candidates.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { HireRequestService } from '../hire-request/hire-request.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { TicketAuditService } from '../ticket/ticket-audit.service';
import { OfferPanelsAuditService } from './offer-panels-audit.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, any> = {}): any {
  return {
    id: 'user-org-1',
    role: 'organization_admin',
    organization_id: 'org-1',
    first_name: 'Jane',
    last_name: 'Client',
    email: 'jane@sunrise.com',
    ...overrides,
  };
}

function makeAdminUser(overrides: Record<string, any> = {}): any {
  return {
    id: 'user-admin-1',
    role: 'system_admin',
    organization_id: null,
    first_name: 'Admin',
    last_name: 'User',
    email: 'admin@medvirtual.com',
    ...overrides,
  };
}

function makePanel(overrides: Record<string, any> = {}): any {
  return {
    id: 'panel-1',
    title: 'Top RNs',
    description: 'Great candidates',
    business_unit: 'MedVirtual',
    status: 'sent',
    is_public: false,
    public_token: null,
    recipient_type: 'client_user',
    recipient_user_id: 'user-org-1',
    recipient_company_id: null,
    recipient_name: 'Jane Client',
    recipient_email: 'jane@sunrise.com',
    recipient_org_name: 'Sunrise Clinic',
    created_by_user_id: 'user-admin-1',
    viewed_at: null,
    last_viewed_at: null,
    view_count: 0,
    decided_at: null,
    createdAt: new Date('2026-06-01'),
    updatedAt: new Date('2026-06-01'),
    candidates: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = {
  uSER: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  contact: {
    findMany: jest.fn(),
  },
  candidate: {
    findMany: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
  offerPanel: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  offerPanelCandidate: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  },
  hireRequest: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  ticket: {
    create: jest.fn(),
    findFirst: jest.fn(),
  },
  staff: {
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockCandidatesService = {
  getTalentPoolCandidateById: jest.fn(),
  // Batch loader used by the list endpoints (findAll, findForClientUser).
  // Returns a Map keyed by candidate id, so tests that don't care about the
  // candidate payload still get a well-formed empty result.
  getTalentPoolCandidatesByIds: jest.fn().mockResolvedValue(new Map()),
};

const mockNotificationsService = {
  notifyOfferPanelCreatedClient: jest.fn().mockResolvedValue(undefined),
  notifyOfferPanelCreatedPublic: jest.fn().mockResolvedValue(undefined),
  notifyAdminOfferPanelAccepted: jest.fn().mockResolvedValue(undefined),
  notifyAdminOfferPanelDeclined: jest.fn().mockResolvedValue(undefined),
};

const mockHubspotService = {
  createHireRequestInHubspot: jest.fn().mockResolvedValue({}),
};

const mockHireRequestService = {
  getVATypes: jest.fn().mockResolvedValue([
    { label: 'Nurse', value: 'Nurse' },
    { label: 'Book Keeper', value: 'Book Keeper' },
    { label: 'Jr Bookkeeper', value: 'Jr Bookkeeper' },
  ]),
};

const businessUnitContextMock = {
  getVisibleHubspotValues: jest.fn(),
  isAllowedHubspotValue: jest.fn(),
  resolveByHubspotValue: jest.fn(),
  brandingFor: jest.fn(),
  poolFor: jest.fn(),
  displayToSlug: jest.fn(),
  normalizeBusinessUnit: jest.fn(),
  bustCache: jest.fn(),
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const mockTicketAuditService = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  findAllLogs: jest.fn(),
  findByTicket: jest.fn(),
  findLastDeletedEvent: jest.fn(),
};

const mockPanelAuditService = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  findAllLogs: jest.fn(),
  findByOfferPanel: jest.fn(),
};

describe('OfferPanelsService', () => {
  let service: OfferPanelsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OfferPanelsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CandidatesService, useValue: mockCandidatesService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: HubspotService, useValue: mockHubspotService },
        { provide: HireRequestService, useValue: mockHireRequestService },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
        { provide: TicketAuditService, useValue: mockTicketAuditService },
        {
          provide: OfferPanelsAuditService,
          useValue: mockPanelAuditService,
        },
      ],
    }).compile();

    service = module.get<OfferPanelsService>(OfferPanelsService);

    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);
    businessUnitContextMock.getVisibleHubspotValues.mockResolvedValue([
      'MedVirtual',
      'Berry Virtual',
      'MMVA',
    ]);
    businessUnitContextMock.brandingFor.mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // searchContacts
  // -------------------------------------------------------------------------

  describe('searchContacts', () => {
    it('returns merged results from users and contacts, deduped by email', async () => {
      mockPrisma.uSER.findMany.mockResolvedValue([
        {
          id: 'u1',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'alice@org.com',
          organization: { id: 'org-1', name: 'Sunrise' },
        },
      ]);
      mockPrisma.contact.findMany.mockResolvedValue([
        {
          id: 'c1',
          first_name: 'Bob',
          last_name: 'Jones',
          email: 'bob@org.com',
          company_name: 'BobCo',
          user_id: 'u2',
          organization: { id: 'org-2', name: 'BobCo' },
        },
      ]);

      const results = await service.searchContacts('test', 'MedVirtual');

      expect(results).toHaveLength(2);
      expect(results[0].recipient_type).toBe('client_user');
      expect(results[1].recipient_type).toBe('client_user');
    });

    it('deduplicates contacts that share an email with a user (user takes priority)', async () => {
      mockPrisma.uSER.findMany.mockResolvedValue([
        {
          id: 'u1',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'shared@org.com',
          organization: null,
        },
      ]);
      mockPrisma.contact.findMany.mockResolvedValue([
        {
          id: 'c1',
          first_name: 'Alice',
          last_name: 'Smith',
          email: 'shared@org.com',
          company_name: null,
          user_id: null,
          organization: null,
        },
      ]);

      const results = await service.searchContacts('shared', 'MedVirtual');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('u1');
    });

    it('caps results at 20 total', async () => {
      const manyUsers = Array.from({ length: 20 }, (_, i) => ({
        id: `u${i}`,
        first_name: 'User',
        last_name: `${i}`,
        email: `user${i}@org.com`,
        organization: null,
      }));
      const manyContacts = Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`,
        first_name: 'Contact',
        last_name: `${i}`,
        email: `contact${i}@org.com`,
        company_name: null,
        user_id: null,
        organization: null,
      }));

      mockPrisma.uSER.findMany.mockResolvedValue(manyUsers);
      mockPrisma.contact.findMany.mockResolvedValue(manyContacts);

      const results = await service.searchContacts('user', 'MedVirtual');

      expect(results).toHaveLength(20);
    });

    it('skips users and contacts with no email', async () => {
      mockPrisma.uSER.findMany.mockResolvedValue([
        {
          id: 'u1',
          first_name: 'No',
          last_name: 'Email',
          email: null,
          organization: null,
        },
      ]);
      mockPrisma.contact.findMany.mockResolvedValue([]);

      const results = await service.searchContacts('no', 'MedVirtual');

      expect(results).toHaveLength(0);
    });

    it('sets contact recipient_type to client_user when contact has user_id', async () => {
      mockPrisma.uSER.findMany.mockResolvedValue([]);
      mockPrisma.contact.findMany.mockResolvedValue([
        {
          id: 'c1',
          first_name: 'Joe',
          last_name: 'Linked',
          email: 'joe@org.com',
          company_name: null,
          user_id: 'u-linked',
          organization: null,
        },
      ]);

      const results = await service.searchContacts('joe', 'MedVirtual');

      expect(results[0].recipient_type).toBe('client_user');
      expect(results[0].user_id).toBe('u-linked');
    });

    it('passes AND token filters when query contains multiple words', async () => {
      mockPrisma.uSER.findMany.mockResolvedValue([
        {
          id: 'u1',
          first_name: 'Paulo',
          last_name: 'Melo',
          email: 'paulo@org.com',
          organization: { id: 'org-1', name: 'Clinic' },
        },
      ]);
      mockPrisma.contact.findMany.mockResolvedValue([]);

      const results = await service.searchContacts('Paulo Melo', 'MedVirtual');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Paulo Melo');

      const userCall = mockPrisma.uSER.findMany.mock.calls[0][0];
      expect(userCall.where.AND).toHaveLength(2);
      expect(userCall.where.AND[0].OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            first_name: expect.objectContaining({ contains: 'Paulo' }),
          }),
        ]),
      );
      expect(userCall.where.AND[1].OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            last_name: expect.objectContaining({ contains: 'Melo' }),
          }),
        ]),
      );
    });

    it('uses a single AND entry for single-word queries (same shape as before)', async () => {
      mockPrisma.uSER.findMany.mockResolvedValue([]);
      mockPrisma.contact.findMany.mockResolvedValue([]);

      await service.searchContacts('alice', 'MedVirtual');

      const userCall = mockPrisma.uSER.findMany.mock.calls[0][0];
      expect(userCall.where.AND).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    const adminUser = makeAdminUser();

    const validDto = {
      title: 'Top RNs',
      description: 'Best candidates',
      business_unit: 'MedVirtual',
      candidateIds: ['cand-1'],
      recipients: [
        {
          recipient_type: 'client_user' as const,
          user_id: 'user-org-1',
          email: 'jane@sunrise.com',
          name: 'Jane Client',
        },
      ],
    };

    beforeEach(() => {
      mockPrisma.candidate.findMany.mockResolvedValue([{ id: 'cand-1' }]);
      mockPrisma.uSER.findUnique.mockResolvedValue({
        id: 'user-org-1',
        role: 'organization_admin',
        organization: { name: 'Sunrise Clinic' },
      });

      const createdPanel = makePanel();
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          offerPanel: { create: jest.fn().mockResolvedValue(createdPanel) },
        };
        return fn(txPrisma);
      });
    });

    it('creates panels for each recipient and returns them', async () => {
      const result = await service.create(validDto, adminUser);

      expect(result).toHaveLength(1);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('accepts a visible business_unit (validated against BusinessUnitContext)', async () => {
      businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);

      await service.create(validDto, adminUser);

      expect(
        businessUnitContextMock.isAllowedHubspotValue,
      ).toHaveBeenCalledWith('MedVirtual');
    });

    it('rejects a non-visible/unknown business_unit with BadRequestException', async () => {
      businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(false);
      const dto = { ...validDto, business_unit: 'SomeDormantBU' };

      await expect(service.create(dto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts a newly-visible BU like MMVA once it is in the visible set', async () => {
      businessUnitContextMock.isAllowedHubspotValue.mockImplementation(
        async (v: string) => v === 'MMVA',
      );
      const dto = { ...validDto, business_unit: 'MMVA' };

      const result = await service.create(dto, adminUser);

      expect(result).toHaveLength(1);
    });

    it('throws BadRequestException when a candidateId does not exist', async () => {
      mockPrisma.candidate.findMany.mockResolvedValue([]); // no candidates found

      await expect(service.create(validDto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for duplicate recipient emails', async () => {
      const dto = {
        ...validDto,
        recipients: [
          { recipient_type: 'email' as const, email: 'same@x.com', name: 'A' },
          { recipient_type: 'email' as const, email: 'same@x.com', name: 'B' },
        ],
      };

      await expect(service.create(dto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when client_user has no user_id', async () => {
      const dto = {
        ...validDto,
        recipients: [
          {
            recipient_type: 'client_user' as const,
            email: 'jane@sunrise.com',
            name: 'Jane',
          },
        ],
      };

      await expect(service.create(dto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when client_user does not exist in DB', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue(null);

      await expect(service.create(validDto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when client_user has wrong role', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue({
        id: 'user-org-1',
        role: 'system_admin',
        organization: null,
      });

      await expect(service.create(validDto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when company_contact has no company_id', async () => {
      const dto = {
        ...validDto,
        recipients: [
          {
            recipient_type: 'company_contact' as const,
            email: 'contact@co.com',
            name: 'Contact',
          },
        ],
      };

      await expect(service.create(dto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when company_contact organization not found', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);
      const dto = {
        ...validDto,
        recipients: [
          {
            recipient_type: 'company_contact' as const,
            company_id: 'org-missing',
            email: 'contact@co.com',
            name: 'Contact',
          },
        ],
      };

      await expect(service.create(dto, adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates a public panel for email recipient type', async () => {
      const emailRecipientPanel = makePanel({
        is_public: true,
        public_token: 'tok-abc',
      });
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          offerPanel: {
            create: jest.fn().mockResolvedValue(emailRecipientPanel),
          },
        };
        return fn(txPrisma);
      });

      const dto = {
        ...validDto,
        recipients: [
          {
            recipient_type: 'email' as const,
            email: 'prospect@co.com',
            name: 'Prospect',
          },
        ],
      };

      const result = await service.create(dto, adminUser);

      expect(result).toHaveLength(1);
    });

    it('awaits client notification before returning', async () => {
      // Deferred on a macrotask: a floating promise would leave `settled`
      // false, while a real `await` cannot resolve until setTimeout fires.
      // Guards the Lambda freeze bug, where the container is suspended as
      // soon as the handler resolves and the pending send never runs.
      let settled = false;
      mockNotificationsService.notifyOfferPanelCreatedClient.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              settled = true;
              resolve(true);
            }, 0),
          ),
      );

      await service.create(validDto, adminUser);

      expect(
        mockNotificationsService.notifyOfferPanelCreatedClient,
      ).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
    });

    it('does not fail creation when notification rejects', async () => {
      mockNotificationsService.notifyOfferPanelCreatedClient.mockRejectedValueOnce(
        new Error('Resend down'),
      );

      const result = await service.create(validDto, adminUser);

      expect(result).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // findAll
  // -------------------------------------------------------------------------

  describe('findAll', () => {
    /**
     * The page and the status tallies are fetched together in one
     * $transaction([page, groupBy]), so tests stub the transaction rather than
     * the individual calls.
     */
    const mockFindAll = (
      panels: any[] = [],
      grouped: { status: string; _count: { status: number } }[] = [],
    ) => {
      mockPrisma.offerPanel.findMany.mockReturnValue('page-query');
      mockPrisma.offerPanel.groupBy.mockReturnValue('counts-query');
      mockPrisma.$transaction.mockResolvedValue([panels, grouped]);
    };

    /** The `where` handed to the paged query. */
    const pageWhere = () =>
      mockPrisma.offerPanel.findMany.mock.calls[0][0].where;

    /** The `where` handed to the status tallies. */
    const countsWhere = () =>
      mockPrisma.offerPanel.groupBy.mock.calls[0][0].where;

    it('returns paginated list with default pagination', async () => {
      mockFindAll([makePanel()], [{ status: 'sent', _count: { status: 1 } }]);

      const result = await service.findAll({});

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(20);
      expect(result.pagination.totalPages).toBe(1);
    });

    it('filters by status', async () => {
      mockFindAll();

      await service.findAll({ status: 'sent' as any });

      expect(pageWhere().AND).toContainEqual({ status: 'sent' });
    });

    it('filters by recipient_type', async () => {
      mockFindAll();

      await service.findAll({ recipient_type: 'client_user' as any });

      expect(pageWhere().AND).toContainEqual({
        recipient_type: 'client_user',
      });
    });

    it('filters by client org name (partial, insensitive)', async () => {
      mockFindAll();

      await service.findAll({ client: 'sunrise' });

      expect(pageWhere().AND).toContainEqual({
        recipient_org_name: { contains: 'sunrise', mode: 'insensitive' },
      });
    });

    it('filters by search term across title, recipient name, and email', async () => {
      mockFindAll();

      await service.findAll({ search: 'jane' });

      const searchGroup = pageWhere().AND.find((c: any) => c.OR);
      expect(searchGroup.OR).toHaveLength(3);
    });

    // Search and the business-unit filter each need their own OR group. Before
    // the conditions were collected in an array, assigning both onto `where.OR`
    // meant the second silently dropped the first.
    // A panel is created at the moment it is sent, so the period filter is a
    // window on `createdAt`.
    it('filters by a created/sent date range, with dateTo covering the whole day', async () => {
      mockFindAll();

      await service.findAll({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });

      expect(pageWhere().AND).toContainEqual({
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          // End-of-day, so a panel sent on the 31st is not excluded.
          lte: new Date('2026-01-31T23:59:59.999Z'),
        },
      });
    });

    it('leaves the range open-ended when only one bound is given', async () => {
      mockFindAll();

      await service.findAll({ dateFrom: '2026-01-01' });

      expect(pageWhere().AND).toContainEqual({
        createdAt: { gte: new Date('2026-01-01T00:00:00.000Z') },
      });
    });

    it('adds no date condition when neither bound is given', async () => {
      mockFindAll();

      await service.findAll({});

      expect(pageWhere().AND).not.toContainEqual(
        expect.objectContaining({ createdAt: expect.anything() }),
      );
    });

    // The tabs would otherwise show global totals contradicting the filtered
    // list, so the window must reach the tallies too.
    it('applies the date range to the status tallies as well', async () => {
      mockFindAll();

      await service.findAll({
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
        status: 'sent' as any,
      });

      expect(countsWhere().AND).toContainEqual({
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-01-31T23:59:59.999Z'),
        },
      });
      // …while status stays out of the tallies, so each tab keeps its own size.
      expect(countsWhere().AND).not.toContainEqual({ status: 'sent' });
    });

    it('keeps search and business_unit as independent conditions', async () => {
      mockFindAll();
      businessUnitContextMock.resolveByHubspotValue.mockResolvedValue({
        hubspot_value: 'Berry Virtual',
        name: 'Berry Virtual',
        slug: 'berryvirtual',
      });

      await service.findAll({ search: 'jane', business_unit: 'berryvirtual' });

      const orGroups = pageWhere().AND.filter((c: any) => c.OR);
      expect(orGroups).toHaveLength(2);
    });

    it('matches every stored spelling of a business unit', async () => {
      mockFindAll();
      businessUnitContextMock.resolveByHubspotValue.mockResolvedValue({
        hubspot_value: 'Berry Virtual',
        name: 'Berry Virtual',
        slug: 'berryvirtual',
      });

      await service.findAll({ business_unit: 'berryvirtual' });

      const buGroup = pageWhere().AND.find((c: any) =>
        c.OR?.some((o: any) => o.business_unit),
      );
      const values = buGroup.OR.map((o: any) => o.business_unit.equals);
      // Rows exist as both "Berry Virtual" and "BerryVirtual"; `insensitive`
      // covers casing but not the missing space.
      expect(values).toEqual(
        expect.arrayContaining(['Berry Virtual', 'BerryVirtual']),
      );
    });

    it('returns an empty result for an unknown business unit', async () => {
      mockFindAll([makePanel()], [{ status: 'sent', _count: { status: 1 } }]);
      businessUnitContextMock.resolveByHubspotValue.mockResolvedValue(null);

      const result = await service.findAll({ business_unit: 'nope' });

      // Narrows to nothing rather than widening to every panel.
      expect(result.data).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('reports a count per status', async () => {
      mockFindAll(
        [],
        [
          { status: 'sent', _count: { status: 3 } },
          { status: 'accepted', _count: { status: 2 } },
        ],
      );

      const result = await service.findAll({});

      expect(result.counts).toEqual({
        sent: 3,
        viewed: 0,
        accepted: 2,
        declined: 0,
      });
      // No status filter, so the page spans every bucket.
      expect(result.pagination.total).toBe(5);
    });

    // The tabs display all four counts at once, so a selected tab must not
    // zero out the others.
    it('counts every status but pages only the selected one', async () => {
      mockFindAll(
        [],
        [
          { status: 'sent', _count: { status: 3 } },
          { status: 'accepted', _count: { status: 2 } },
        ],
      );

      const result = await service.findAll({ status: 'accepted' as any });

      expect(countsWhere().AND).not.toContainEqual({ status: 'accepted' });
      expect(pageWhere().AND).toContainEqual({ status: 'accepted' });
      expect(result.counts.sent).toBe(3);
      // Pagination follows the selected bucket only.
      expect(result.pagination.total).toBe(2);
    });

    it('applies search to the counts as well as the page', async () => {
      mockFindAll();

      await service.findAll({ search: 'jane', status: 'sent' as any });

      const searchGroup = countsWhere().AND.find((c: any) => c.OR);
      expect(searchGroup.OR).toHaveLength(3);
    });

    it('respects page and limit params', async () => {
      mockFindAll([], [{ status: 'sent', _count: { status: 50 } }]);

      const result = await service.findAll({ page: 3, limit: 10 });

      const call = mockPrisma.offerPanel.findMany.mock.calls[0][0];
      expect(call.skip).toBe(20);
      expect(call.take).toBe(10);
      expect(result.pagination.totalPages).toBe(5);
    });

    // Regression guard: this endpoint used to enrich candidates one at a time,
    // issuing a query (and a full PositionRateConfig read) per candidate per
    // panel. Candidate loading must stay batched no matter the page size.
    it('loads candidates for the whole page in a single batch', async () => {
      mockFindAll([
        makePanel({
          id: 'p1',
          candidates: [{ candidate_id: 'c1' }, { candidate_id: 'c2' }],
        }),
        makePanel({
          id: 'p2',
          candidates: [{ candidate_id: 'c3' }, { candidate_id: 'c1' }],
        }),
      ]);
      mockCandidatesService.getTalentPoolCandidatesByIds.mockResolvedValue(
        new Map([
          ['c1', { id: 'c1' }],
          ['c2', { id: 'c2' }],
          ['c3', { id: 'c3' }],
        ]),
      );

      await service.findAll({});

      expect(
        mockCandidatesService.getTalentPoolCandidatesByIds,
      ).toHaveBeenCalledTimes(1);
      expect(
        mockCandidatesService.getTalentPoolCandidateById,
      ).not.toHaveBeenCalled();
      // Every candidate of every panel is requested in that one call.
      expect(
        mockCandidatesService.getTalentPoolCandidatesByIds.mock.calls[0][0],
      ).toEqual(['c1', 'c2', 'c3', 'c1']);
    });

    it('skips candidates that no longer exist instead of failing the list', async () => {
      mockFindAll([
        makePanel({
          id: 'p1',
          candidates: [{ candidate_id: 'c1' }, { candidate_id: 'gone' }],
        }),
      ]);
      mockCandidatesService.getTalentPoolCandidatesByIds.mockResolvedValue(
        new Map([['c1', { id: 'c1' }]]),
      );

      const result = await service.findAll({});

      expect(result.data[0].candidates).toHaveLength(1);
      expect(result.data[0].candidates[0].id).toBe('c1');
    });
  });

  // -------------------------------------------------------------------------
  // findByToken
  // -------------------------------------------------------------------------

  describe('findByToken', () => {
    it('returns enriched panel with candidates', async () => {
      const panel = makePanel({
        public_token: 'tok-1',
        candidates: [{ candidate_id: 'cand-1' }],
      });
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panel);
      mockCandidatesService.getTalentPoolCandidateById.mockResolvedValue({
        id: 'cand-1',
        name: 'Dr. Smith',
      });

      const result = await service.findByToken('tok-1');

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].name).toBe('Dr. Smith');
    });

    it('throws NotFoundException when token does not match', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.findByToken('bad-token')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('attaches the resolved BU branding for the unauthenticated public page', async () => {
      const panel = makePanel({
        public_token: 'tok-mmva',
        business_unit: 'MMVA',
        candidates: [],
      });
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panel);
      const branding = {
        slug: 'mmva',
        name: 'My Medical VA',
        primary_color: '#7C3AED',
        primary_hover: '#6d28d9',
        logo_url: 'https://cdn.example.com/mmva-logo.png',
        favicon_url: 'https://cdn.example.com/mmva.ico',
      };
      businessUnitContextMock.brandingFor.mockResolvedValue(branding);

      const result = await service.findByToken('tok-mmva');

      expect(businessUnitContextMock.brandingFor).toHaveBeenCalledWith('MMVA');
      expect(result.branding).toEqual(branding);
    });

    it('returns branding=null for an unknown/legacy BU (frontend falls back to Med)', async () => {
      const panel = makePanel({ public_token: 'tok-legacy', candidates: [] });
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panel);
      businessUnitContextMock.brandingFor.mockResolvedValue(null);

      const result = await service.findByToken('tok-legacy');

      expect(result.branding).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // findOne
  // -------------------------------------------------------------------------

  describe('findOne', () => {
    it('returns panel for system admin regardless of recipient', async () => {
      const admin = makeAdminUser();
      const panel = makePanel({ recipient_user_id: 'someone-else' });
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panel);
      mockCandidatesService.getTalentPoolCandidateById.mockResolvedValue({});

      await expect(service.findOne('panel-1', admin)).resolves.toBeDefined();
    });

    it('returns panel for the recipient client user', async () => {
      const client = makeUser({ id: 'user-org-1' });
      const panel = makePanel({
        recipient_user_id: 'user-org-1',
        candidates: [],
      });
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panel);

      await expect(service.findOne('panel-1', client)).resolves.toBeDefined();
    });

    it('throws ForbiddenException when client user is not the recipient', async () => {
      const client = makeUser({ id: 'other-user' });
      const panel = makePanel({ recipient_user_id: 'user-org-1' });
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panel);

      await expect(service.findOne('panel-1', client)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when panel does not exist', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing', makeAdminUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // findForClientUser
  // -------------------------------------------------------------------------

  describe('findForClientUser', () => {
    it('returns panels for the client user excluding declined', async () => {
      const panels = [
        makePanel(),
        makePanel({ id: 'panel-2', status: 'viewed' }),
      ];
      mockPrisma.offerPanel.findMany.mockResolvedValue(panels);

      const result = await service.findForClientUser(makeUser());

      expect(result).toHaveLength(2);
      const call = mockPrisma.offerPanel.findMany.mock.calls[0][0];
      expect(call.where.status).toEqual({ notIn: ['declined'] });
      expect(call.where.recipient_user_id).toBe('user-org-1');
    });
  });

  // -------------------------------------------------------------------------
  // trackView
  // -------------------------------------------------------------------------

  describe('trackView', () => {
    it('increments view_count and flips sent→viewed on first view', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'user-org-1',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await service.trackView('panel-1');

      const updateCall = mockPrisma.offerPanel.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe('viewed');
      expect(updateCall.data.viewed_at).toBeDefined();
      expect(updateCall.data.view_count).toEqual({ increment: 1 });
    });

    it('increments view_count without flipping status on subsequent views', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'viewed',
        recipient_user_id: 'user-org-1',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await service.trackView('panel-1');

      const updateCall = mockPrisma.offerPanel.update.mock.calls[0][0];
      expect(updateCall.data.status).toBeUndefined();
    });

    it('throws NotFoundException when panel does not exist', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.trackView('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when user is not the recipient', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'other-user',
      });

      const user = makeUser({ id: 'user-org-1' });

      await expect(service.trackView('panel-1', user)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('does not throw ForbiddenException when no user is passed (public access)', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'user-org-1',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await expect(service.trackView('panel-1')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // trackViewByToken
  // -------------------------------------------------------------------------

  describe('trackViewByToken', () => {
    it('increments view and flips status for sent panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        status: 'sent',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await service.trackViewByToken('tok-1');

      const updateCall = mockPrisma.offerPanel.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe('viewed');
    });

    it('does not flip status for already-viewed panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        status: 'viewed',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await service.trackViewByToken('tok-1');

      const updateCall = mockPrisma.offerPanel.update.mock.calls[0][0];
      expect(updateCall.data.status).toBeUndefined();
    });

    it('throws NotFoundException for unknown token', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.trackViewByToken('bad')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // removeCandidate
  // -------------------------------------------------------------------------

  describe('removeCandidate', () => {
    const client = makeUser({ id: 'user-org-1' });

    it('removes candidate and returns updated panel when others remain', async () => {
      mockPrisma.offerPanel.findUnique
        .mockResolvedValueOnce({
          status: 'sent',
          recipient_user_id: 'user-org-1',
        })
        .mockResolvedValueOnce(makePanel());
      mockPrisma.offerPanelCandidate.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.offerPanelCandidate.count.mockResolvedValue(1);

      const result = await service.removeCandidate('panel-1', 'cand-1', client);

      expect(result.deleted).toBe(false);
      expect(result.panel).toBeDefined();
    });

    it('deletes the entire panel when the last candidate is removed (R8)', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'user-org-1',
        title: 'Panel',
      });
      mockPrisma.offerPanelCandidate.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.offerPanelCandidate.count.mockResolvedValue(0);
      // The delete now runs inside a transaction, alongside the audit tombstone.
      const txDelete = jest.fn().mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation(async (fn: any) =>
        fn({ offerPanel: { delete: txDelete } }),
      );

      const result = await service.removeCandidate('panel-1', 'cand-1', client);

      expect(result.deleted).toBe(true);
      expect(txDelete).toHaveBeenCalledWith({ where: { id: 'panel-1' } });
      expect(mockPanelAuditService.logOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          offerPanelId: 'panel-1',
          event: 'deleted',
          reason: 'Last candidate removed by the recipient',
        }),
        expect.anything(),
      );
    });

    it('audits a candidate removal that leaves the panel intact', async () => {
      mockPrisma.offerPanel.findUnique
        .mockResolvedValueOnce({
          status: 'sent',
          recipient_user_id: 'user-org-1',
          title: 'Panel',
        })
        .mockResolvedValueOnce(makePanel());
      mockPrisma.offerPanelCandidate.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.offerPanelCandidate.count.mockResolvedValue(2);

      await service.removeCandidate('panel-1', 'cand-1', client);

      expect(mockPanelAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          offerPanelId: 'panel-1',
          event: 'candidate_removed',
          metadata: expect.objectContaining({
            candidateId: 'cand-1',
            remainingCount: 2,
          }),
        }),
      );
    });

    it('throws NotFoundException when panel not found', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(
        service.removeCandidate('missing', 'cand-1', client),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user is not the recipient', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'other-user',
      });

      await expect(
        service.removeCandidate('panel-1', 'cand-1', client),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when panel is already decided', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'accepted',
        recipient_user_id: 'user-org-1',
      });

      await expect(
        service.removeCandidate('panel-1', 'cand-1', client),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when candidate is not in the panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'user-org-1',
      });
      mockPrisma.offerPanelCandidate.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.removeCandidate('panel-1', 'cand-missing', client),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // removeCandidateFromAllPanels
  // -------------------------------------------------------------------------

  describe('removeCandidateFromAllPanels', () => {
    it('removes the candidate from every panel it appears in', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        { offer_panel_id: 'panel-1' },
        { offer_panel_id: 'panel-2' },
      ]);
      mockPrisma.offerPanelCandidate.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.offerPanelCandidate.count.mockResolvedValue(2);

      await service.removeCandidateFromAllPanels('cand-1');

      expect(mockPrisma.offerPanelCandidate.deleteMany).toHaveBeenCalledWith({
        where: { offer_panel_id: 'panel-1', candidate_id: 'cand-1' },
      });
      expect(mockPrisma.offerPanelCandidate.deleteMany).toHaveBeenCalledWith({
        where: { offer_panel_id: 'panel-2', candidate_id: 'cand-1' },
      });
      // Panels still holding candidates are neither deleted nor audited. The delete
      // path runs inside a transaction, so assert on that rather than on the
      // top-level client.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPanelAuditService.logOrThrow).not.toHaveBeenCalled();
    });

    it('deletes a panel that becomes empty after removing the candidate', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          offer_panel_id: 'panel-1',
          offerPanel: { status: 'sent', title: 'Panel' },
        },
      ]);
      mockPrisma.offerPanelCandidate.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.offerPanelCandidate.count.mockResolvedValue(0);
      const txDelete = jest.fn().mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation(async (fn: any) =>
        fn({ offerPanel: { delete: txDelete } }),
      );

      await service.removeCandidateFromAllPanels('cand-1');

      expect(txDelete).toHaveBeenCalledWith({ where: { id: 'panel-1' } });
      // A candidate deletion must not make panels vanish without a trace.
      expect(mockPanelAuditService.logOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          offerPanelId: 'panel-1',
          event: 'deleted',
          reason: 'Candidate removed from the system',
          source: 'system',
        }),
        expect.anything(),
      );
    });

    it('does nothing when the candidate is not present in any panel', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([]);

      await service.removeCandidateFromAllPanels('cand-1');

      expect(mockPrisma.offerPanelCandidate.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.offerPanel.delete).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // decline
  // -------------------------------------------------------------------------

  describe('decline', () => {
    const client = makeUser({ id: 'user-org-1' });

    it('marks panel as declined', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'user-org-1',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await service.decline('panel-1', client);

      expect(mockPrisma.offerPanel.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'declined' }),
        }),
      );
    });

    it('is idempotent: silently returns if already declined (E8)', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'declined',
        recipient_user_id: 'user-org-1',
      });

      await expect(service.decline('panel-1', client)).resolves.toBeUndefined();
      expect(mockPrisma.offerPanel.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when already accepted', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'accepted',
        recipient_user_id: 'user-org-1',
      });

      await expect(service.decline('panel-1', client)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ForbiddenException when user is not the recipient', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        status: 'sent',
        recipient_user_id: 'other-user',
      });

      await expect(service.decline('panel-1', client)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when panel not found', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.decline('panel-1', client)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // declineByToken
  // -------------------------------------------------------------------------

  describe('declineByToken', () => {
    it('marks panel as declined via public token', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        status: 'sent',
      });
      mockPrisma.offerPanel.update.mockResolvedValue({});

      await service.declineByToken('tok-1');

      expect(mockPrisma.offerPanel.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'declined' }),
        }),
      );
    });

    it('is idempotent when already declined (E8)', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        status: 'declined',
      });

      await expect(service.declineByToken('tok-1')).resolves.toBeUndefined();
      expect(mockPrisma.offerPanel.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when already accepted', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        status: 'accepted',
      });

      await expect(service.declineByToken('tok-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException for unknown token', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.declineByToken('bad-token')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // acceptByClientUser
  // -------------------------------------------------------------------------

  describe('acceptByClientUser', () => {
    const client = makeUser({ id: 'user-org-1', organization_id: 'org-1' });

    const panelData = {
      status: 'sent',
      recipient_user_id: 'user-org-1',
      title: 'Top RNs',
      description: 'Great picks',
      created_by_user_id: 'user-admin-1',
    };

    const hireRequestData = { id: 'hr-1', title: 'Top RNs' };

    beforeEach(() => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panelData);
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['RN'] },
        },
      ]);
      mockPrisma.organization.findUnique.mockResolvedValue({
        name: 'Sunrise Clinic',
        hubspot_id: 'hs-org-1',
        business_unit: 'MedVirtual',
        website_url: 'https://sunrise.example.com',
      });
      mockPrisma.staff.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: { create: jest.fn().mockResolvedValue(hireRequestData) },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });
      mockHireRequestService.getVATypes.mockResolvedValue([
        { label: 'Nurse', value: 'Nurse' },
        { label: 'Book Keeper', value: 'Book Keeper' },
        { label: 'Jr Bookkeeper', value: 'Jr Bookkeeper' },
      ]);
    });

    it('creates a HireRequest and returns it', async () => {
      const result = await service.acceptByClientUser('panel-1', client);

      expect(result.hireRequest).toBeDefined();
      expect(result.hireRequest.id).toBe('hr-1');
    });

    it('links offer_panel_id on the created HireRequest', async () => {
      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.offer_panel_id).toBe('panel-1');
    });

    it('sets hubspot_pairing_request_type to null when org has no active staff', async () => {
      mockPrisma.staff.count.mockResolvedValue(0);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.hubspot_pairing_request_type).toBeNull();
      expect(createArgs.data.title).not.toContain('UPS');
    });

    it('sets hubspot_pairing_request_type to "Upsell Agent" when org has active staff', async () => {
      mockPrisma.staff.count.mockResolvedValue(2);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.hubspot_pairing_request_type).toBe('Upsell Agent');
      expect(createArgs.data.title).toContain('UPS');
    });

    it('throws ForbiddenException when user is not the recipient', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        ...panelData,
        recipient_user_id: 'other-user',
      });

      await expect(
        service.acceptByClientUser('panel-1', client),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when panel is declined', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        ...panelData,
        status: 'declined',
      });

      await expect(
        service.acceptByClientUser('panel-1', client),
      ).rejects.toThrow(BadRequestException);
    });

    it('is idempotent: returns existing HireRequest when already accepted (E8)', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        ...panelData,
        status: 'accepted',
      });
      mockPrisma.hireRequest.findFirst.mockResolvedValue(hireRequestData);

      const result = await service.acceptByClientUser('panel-1', client);

      expect(result.hireRequest).toEqual(hireRequestData);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when panel not found', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(
        service.acceptByClientUser('panel-1', client),
      ).rejects.toThrow(NotFoundException);
    });

    it('sets hubspot_role_type to the most common approved position across candidates', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['RN'] },
        },
        {
          candidate_id: 'cand-2',
          candidate: { approved_positions_pairing: ['LPN'] },
        },
        {
          candidate_id: 'cand-3',
          candidate: { approved_positions_pairing: ['RN'] },
        },
      ]);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.hubspot_role_type).toBe('RN');
      expect(createArgs.data.hubspot_numberVA).toBe(3);
      expect(createArgs.data.title).toContain('RN');
      expect(createArgs.data.title).toContain('Sunrise Clinic');
    });

    it('breaks approved position ties by picking the first one encountered', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['LPN'] },
        },
        {
          candidate_id: 'cand-2',
          candidate: { approved_positions_pairing: ['RN'] },
        },
      ]);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.hubspot_role_type).toBe('LPN');
    });

    it('sets hubspot_role_type to null when no candidate has approved positions', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: [] },
        },
      ]);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.hubspot_role_type).toBeNull();
    });

    it('counts every approved position across all candidates when a candidate has multiple', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['RN', 'LPN'] },
        },
        {
          candidate_id: 'cand-2',
          candidate: { approved_positions_pairing: ['LPN'] },
        },
      ]);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);

      expect(createArgs.data.hubspot_role_type).toBe('LPN');
    });

    it('sends the approved position as va_type to HubSpot when it matches a valid option', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['Nurse'] },
        },
      ]);

      await service.acceptByClientUser('panel-1', client);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockHireRequestService.getVATypes).toHaveBeenCalled();
      expect(mockHubspotService.createHireRequestInHubspot).toHaveBeenCalled();
      const lastCallIndex =
        mockHubspotService.createHireRequestInHubspot.mock.calls.length - 1;
      const [payload] =
        mockHubspotService.createHireRequestInHubspot.mock.calls[lastCallIndex];
      expect(payload.hubspot_role_type).toBe('Nurse');
    });

    it('sends null as va_type to HubSpot when the approved position has no matching HubSpot option, but keeps the title/DB value', async () => {
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['Bookkeeper'] },
        },
      ]);

      let createArgs: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          hireRequest: {
            create: jest.fn((args: any) => {
              createArgs = args;
              return Promise.resolve(hireRequestData);
            }),
          },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });

      await service.acceptByClientUser('panel-1', client);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(createArgs.data.hubspot_role_type).toBe('Bookkeeper');
      const lastCallIndex =
        mockHubspotService.createHireRequestInHubspot.mock.calls.length - 1;
      const [payload] =
        mockHubspotService.createHireRequestInHubspot.mock.calls[lastCallIndex];
      expect(payload.hubspot_role_type).toBeNull();
      expect(payload.title).toContain('Bookkeeper');
    });

    it('falls back to null va_type when fetching HubSpot va_type options fails', async () => {
      mockHireRequestService.getVATypes.mockRejectedValueOnce(
        new Error('network error'),
      );
      mockPrisma.offerPanelCandidate.findMany.mockResolvedValue([
        {
          candidate_id: 'cand-1',
          candidate: { approved_positions_pairing: ['Nurse'] },
        },
      ]);

      await service.acceptByClientUser('panel-1', client);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockHubspotService.createHireRequestInHubspot).toHaveBeenCalled();
      const lastCallIndex =
        mockHubspotService.createHireRequestInHubspot.mock.calls.length - 1;
      const [payload] =
        mockHubspotService.createHireRequestInHubspot.mock.calls[lastCallIndex];
      expect(payload.hubspot_role_type).toBeNull();
    });

    it('uses the resolved org business_unit (not a hardcoded literal) in the HubSpot payload', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        name: 'MMVA Clinic',
        hubspot_id: 'hs-org-2',
        business_unit: 'MMVA',
        website_url: 'https://mmva.example.com',
      });

      await service.acceptByClientUser('panel-1', client);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const lastCallIndex =
        mockHubspotService.createHireRequestInHubspot.mock.calls.length - 1;
      const [payload] =
        mockHubspotService.createHireRequestInHubspot.mock.calls[lastCallIndex];
      expect(payload.organization.business_unit).toBe('MMVA');
    });

    it('does not hardcode "MedVirtual" when the organization lookup returns null', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await service.acceptByClientUser('panel-1', client);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const lastCallIndex =
        mockHubspotService.createHireRequestInHubspot.mock.calls.length - 1;
      const [payload] =
        mockHubspotService.createHireRequestInHubspot.mock.calls[lastCallIndex];
      expect(payload.organization.business_unit).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // acceptByToken
  // -------------------------------------------------------------------------

  describe('acceptByToken', () => {
    const panelData = {
      id: 'panel-1',
      status: 'sent',
      title: 'Billing shortlist',
      recipient_name: 'Prospect Lead',
      recipient_email: 'lead@prospect.com',
      recipient_company_id: null,
      created_by_user_id: 'user-admin-1',
    };

    const ticketData = { id: 'ticket-1', title: 'Billing shortlist' };

    beforeEach(() => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(panelData);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txPrisma = {
          ticket: { create: jest.fn().mockResolvedValue(ticketData) },
          offerPanel: { update: jest.fn().mockResolvedValue({}) },
        };
        return fn(txPrisma);
      });
    });

    it('creates a Ticket and returns it', async () => {
      const result = await service.acceptByToken('tok-1');

      expect(result.ticket).toBeDefined();
      expect(result.ticket.id).toBe('ticket-1');
    });

    it('records a created audit event tagged with the offer_panel_accepted origin', async () => {
      await service.acceptByToken('tok-1');

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          event: 'created',
          // Accepted through a public token, so there is no authenticated user.
          actorUserId: null,
          actorLabel: expect.stringContaining('Prospect Lead'),
          metadata: expect.objectContaining({
            origin: 'offer_panel_accepted',
            offerPanelId: 'panel-1',
            recipientEmail: 'lead@prospect.com',
            panelCreatedBy: 'user-admin-1',
          }),
        }),
      );
    });

    it('does not re-log a created event on an idempotent repeat accept', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        ...panelData,
        status: 'accepted',
      });
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketData);

      await service.acceptByToken('tok-1');

      expect(mockTicketAuditService.log).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when panel is declined', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        ...panelData,
        status: 'declined',
      });

      await expect(service.acceptByToken('tok-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('is idempotent: returns existing Ticket when already accepted (E8)', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        ...panelData,
        status: 'accepted',
      });
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketData);

      const result = await service.acceptByToken('tok-1');

      expect(result.ticket).toEqual(ticketData);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for unknown token', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.acceptByToken('bad-token')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('update', () => {
    it('updates and returns the panel', async () => {
      const updated = makePanel({ title: 'New Title' });
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        title: 'Old Title',
        description: 'desc',
        status: 'sent',
      });
      mockPrisma.offerPanel.update.mockResolvedValue(updated);

      const result = await service.update(
        'panel-1',
        { title: 'New Title' },
        makeAdminUser(),
      );

      expect(result.title).toBe('New Title');
      expect(mockPrisma.offerPanel.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { title: 'New Title' } }),
      );
    });

    it('audits the change with a before/after diff', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        title: 'Old Title',
        description: 'desc',
        status: 'sent',
      });
      mockPrisma.offerPanel.update.mockResolvedValue(
        makePanel({ title: 'New Title', description: 'desc' }),
      );

      await service.update('panel-1', { title: 'New Title' }, makeAdminUser());

      expect(mockPanelAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          offerPanelId: 'panel-1',
          event: 'updated',
          before: expect.objectContaining({ title: 'Old Title' }),
          after: expect.objectContaining({ title: 'New Title' }),
          metadata: expect.objectContaining({ changedFields: ['title'] }),
        }),
      );
    });

    // An "Updated" entry whose before and after match is noise in the timeline.
    it('writes no audit entry when nothing actually changed', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        title: 'Same Title',
        description: 'desc',
        status: 'sent',
      });
      mockPrisma.offerPanel.update.mockResolvedValue(
        makePanel({ title: 'Same Title', description: 'desc' }),
      );

      await service.update('panel-1', { title: 'Same Title' }, makeAdminUser());

      expect(mockPanelAuditService.log).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when panel not found', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(
        service.update('missing', { title: 'x' }, makeAdminUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  describe('remove', () => {
    /** remove() deletes inside a transaction so the audit tombstone commits with it. */
    const mockRemoveTransaction = () => {
      const txDelete = jest.fn().mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation(async (fn: any) =>
        fn({ offerPanel: { delete: txDelete } }),
      );
      return txDelete;
    };

    it('deletes the panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        title: 'Panel',
        status: 'sent',
      });
      const txDelete = mockRemoveTransaction();

      await service.remove('panel-1', makeAdminUser());

      expect(txDelete).toHaveBeenCalledWith({ where: { id: 'panel-1' } });
    });

    // The panel row is hard deleted, so the audit entry is the only surviving record.
    it('writes the tombstone with logOrThrow inside the transaction', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue({
        id: 'panel-1',
        title: 'Panel',
        status: 'sent',
        promo_enabled: true,
      });
      mockRemoveTransaction();

      await service.remove('panel-1', makeAdminUser());

      expect(mockPanelAuditService.logOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          offerPanelId: 'panel-1',
          event: 'deleted',
          before: expect.objectContaining({ promo_enabled: true }),
        }),
        expect.anything(),
      );
    });

    it('throws NotFoundException when panel not found', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', makeAdminUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // resendPublicLink
  // -------------------------------------------------------------------------

  describe('resendPublicLink', () => {
    const publicPanel = (overrides: Record<string, any> = {}) => ({
      id: 'panel-1',
      status: 'sent',
      is_public: true,
      public_token: 'tok-123',
      recipient_email: 'jane@sunrise.com',
      recipient_name: 'Jane Client',
      ...overrides,
    });

    it('resends the email and reports the recipient', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(publicPanel());
      mockNotificationsService.notifyOfferPanelCreatedPublic.mockResolvedValue(
        true,
      );

      const result = await service.resendPublicLink('panel-1', makeAdminUser());

      expect(result).toEqual({ sentTo: 'jane@sunrise.com' });
      expect(
        mockNotificationsService.notifyOfferPanelCreatedPublic,
      ).toHaveBeenCalledWith('panel-1');
      expect(mockPanelAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ offerPanelId: 'panel-1', event: 'resent' }),
      );
    });

    // Client-user panels have no token and no public page — nothing to resend.
    it('rejects a non-public panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(
        publicPanel({ is_public: false, public_token: null }),
      );

      await expect(
        service.resendPublicLink('panel-1', makeAdminUser()),
      ).rejects.toThrow(BadRequestException);
      expect(
        mockNotificationsService.notifyOfferPanelCreatedPublic,
      ).not.toHaveBeenCalled();
    });

    // A decided panel renders read-only publicly, so a resend cannot cause a
    // second accept — recipients legitimately ask for the link again.
    it('allows resending an already-accepted panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(
        publicPanel({ status: 'accepted' }),
      );
      mockNotificationsService.notifyOfferPanelCreatedPublic.mockResolvedValue(
        true,
      );

      await expect(
        service.resendPublicLink('panel-1', makeAdminUser()),
      ).resolves.toEqual({ sentTo: 'jane@sunrise.com' });
    });

    // Never report a false success to the admin.
    it('throws when the send fails', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(publicPanel());
      mockNotificationsService.notifyOfferPanelCreatedPublic.mockResolvedValue(
        false,
      );

      await expect(
        service.resendPublicLink('panel-1', makeAdminUser()),
      ).rejects.toThrow(BadRequestException);
      expect(mockPanelAuditService.log).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when panel not found', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);

      await expect(
        service.resendPublicLink('missing', makeAdminUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // public_token exposure
  // -------------------------------------------------------------------------

  describe('public_token gating', () => {
    const tokenPanel = makePanel({
      is_public: true,
      public_token: 'tok-secret',
    });

    beforeEach(() => {
      mockCandidatesService.getTalentPoolCandidateById.mockResolvedValue({
        id: 'cand-1',
      });
    });

    it('returns the token to a system role', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(tokenPanel);

      const result = await service.findOne('panel-1', makeAdminUser());

      expect(result.public_token).toBe('tok-secret');
    });

    // The token is a bearer credential: holding it permits accept/decline with
    // no authentication, so it must never reach an organization-role viewer.
    it('strips the token for an organization role', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(tokenPanel);

      const result = await service.findOne(
        'panel-1',
        makeUser({ role: 'organization_admin' }),
      );

      expect(result).not.toHaveProperty('public_token');
    });

    it('does not echo the token back on the public token read', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(tokenPanel);
      businessUnitContextMock.brandingFor.mockResolvedValue(null);

      const result = await service.findByToken('tok-secret');

      expect(result).not.toHaveProperty('public_token');
    });
  });

  describe('getStats', () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** A stats row as selected by getStats (not a full panel). */
    const makeRow = (overrides: Record<string, any> = {}): any => ({
      created_by_user_id: 'user-admin-1',
      status: 'sent',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      viewed_at: null,
      decided_at: null,
      _count: { candidates: 3 },
      ...overrides,
    });

    /**
     * getStats issues $transaction([groupBy, findMany]), then a separate user
     * lookup, so tests stub the transaction and the creator read together.
     */
    const mockStats = (
      rows: any[] = [],
      grouped: {
        created_by_user_id: string;
        status: string;
        _count: { status: number };
      }[] = [],
      creators: any[] = [
        {
          id: 'user-admin-1',
          first_name: 'Admin',
          last_name: 'User',
          email: 'admin@medvirtual.com',
        },
      ],
    ) => {
      mockPrisma.offerPanel.groupBy.mockReturnValue('grouped-query');
      mockPrisma.offerPanel.findMany.mockReturnValue('rows-query');
      mockPrisma.$transaction.mockResolvedValue([grouped, rows]);
      mockPrisma.uSER.findMany.mockResolvedValue(creators);
    };

    /** Every number in the payload, flattened, for NaN sweeps. */
    const numbersIn = (value: any): number[] => {
      if (typeof value === 'number') return [value];
      if (Array.isArray(value)) return value.flatMap(numbersIn);
      if (value && typeof value === 'object')
        return Object.values(value).flatMap(numbersIn);
      return [];
    };

    it('returns a zeroed payload for a window with no panels', async () => {
      mockStats([], []);

      const result = await service.getStats({});

      expect(result.totals).toEqual({
        sent: 0,
        viewed: 0,
        accepted: 0,
        declined: 0,
        total: 0,
      });
      expect(result.rates).toEqual({
        acceptanceRate: 0,
        declineRate: 0,
        viewRate: 0,
      });
      expect(result.senders).toEqual([]);
      expect(result.topSenders.mostSent).toBeNull();
      // The dashboard renders these directly, so NaN must never reach it.
      expect(numbersIn(result).some(Number.isNaN)).toBe(false);
    });

    it('reports 0% for a sender with sends but no decisions', async () => {
      mockStats(
        [makeRow(), makeRow()],
        [
          {
            created_by_user_id: 'user-admin-1',
            status: 'sent',
            _count: { status: 2 },
          },
        ],
      );

      const result = await service.getStats({});

      expect(result.senders).toHaveLength(1);
      expect(result.senders[0].acceptedPct).toBe(0);
      expect(result.senders[0].declinedPct).toBe(0);
      expect(result.rates.acceptanceRate).toBe(0);
      expect(numbersIn(result).some(Number.isNaN)).toBe(false);
    });

    it('counts the view rate from viewed_at, not from the viewed status', async () => {
      // An accepted panel was also viewed; its status no longer says so.
      mockStats(
        [
          makeRow({
            status: 'accepted',
            viewed_at: new Date('2026-06-01T02:00:00.000Z'),
            decided_at: new Date('2026-06-02T00:00:00.000Z'),
          }),
          makeRow({ status: 'sent' }),
        ],
        [
          {
            created_by_user_id: 'user-admin-1',
            status: 'accepted',
            _count: { status: 1 },
          },
          {
            created_by_user_id: 'user-admin-1',
            status: 'sent',
            _count: { status: 1 },
          },
        ],
      );

      const result = await service.getStats({});

      expect(result.totals.viewed).toBe(0); // no row carries the `viewed` status
      expect(result.rates.viewRate).toBe(50); // but one of two was in fact viewed
      expect(result.funnel.viewed).toBe(1);
      expect(result.rates.acceptanceRate).toBe(100); // 1 of 1 decided
    });

    it('keeps the funnel monotonically non-increasing', async () => {
      mockStats(
        [
          makeRow({
            status: 'accepted',
            viewed_at: new Date('2026-06-01T01:00:00.000Z'),
            decided_at: new Date('2026-06-01T05:00:00.000Z'),
          }),
          makeRow({
            status: 'declined',
            viewed_at: new Date('2026-06-01T03:00:00.000Z'),
            decided_at: new Date('2026-06-01T09:00:00.000Z'),
          }),
          makeRow({ status: 'sent' }),
        ],
        [
          {
            created_by_user_id: 'user-admin-1',
            status: 'accepted',
            _count: { status: 1 },
          },
          {
            created_by_user_id: 'user-admin-1',
            status: 'declined',
            _count: { status: 1 },
          },
          {
            created_by_user_id: 'user-admin-1',
            status: 'sent',
            _count: { status: 1 },
          },
        ],
      );

      const { funnel } = await service.getStats({});

      expect(funnel.sent).toBeGreaterThanOrEqual(funnel.viewed);
      expect(funnel.viewed).toBeGreaterThanOrEqual(funnel.decided);
      expect(funnel.decided).toBeGreaterThanOrEqual(funnel.accepted);
      expect(funnel).toEqual({ sent: 3, viewed: 2, decided: 2, accepted: 1 });
    });

    it('counts unviewed panels older than 7 days as awaiting a response', async () => {
      const now = Date.now();
      mockStats(
        [
          makeRow({ createdAt: new Date(now - 10 * DAY) }), // stale
          makeRow({ createdAt: new Date(now - 2 * DAY) }), // still fresh
        ],
        [
          {
            created_by_user_id: 'user-admin-1',
            status: 'sent',
            _count: { status: 2 },
          },
        ],
      );

      const result = await service.getStats({});

      expect(result.speed.awaitingResponse).toBe(1);
    });

    it('averages durations only over panels that reached the milestone', async () => {
      mockStats(
        [
          makeRow({
            status: 'accepted',
            viewed_at: new Date('2026-06-01T02:00:00.000Z'), // 2h
            decided_at: new Date('2026-06-02T00:00:00.000Z'), // 24h
          }),
          makeRow({ status: 'sent' }), // never viewed — must not drag the mean
        ],
        [
          {
            created_by_user_id: 'user-admin-1',
            status: 'accepted',
            _count: { status: 1 },
          },
          {
            created_by_user_id: 'user-admin-1',
            status: 'sent',
            _count: { status: 1 },
          },
        ],
      );

      const { speed } = await service.getStats({});

      expect(speed.avgTimeToViewHours).toBe(2);
      expect(speed.avgTimeToDecisionHours).toBe(24);
    });

    it('applies no date filter at all when no period is given', async () => {
      mockStats();

      await service.getStats({});

      // No `createdAt` clause: the window is every panel ever created, with no
      // implicit "last 12 months" and no upper bound to exclude future-dated rows.
      const where = mockPrisma.offerPanel.groupBy.mock.calls[0][0].where;
      expect(where).toEqual({});
      expect(JSON.stringify(where)).not.toContain('createdAt');
    });

    it('leaves the window open-ended when only dateFrom is given', async () => {
      mockStats();

      await service.getStats({ dateFrom: '2026-06-01' });

      const where = mockPrisma.offerPanel.groupBy.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({
        createdAt: { gte: new Date('2026-06-01T00:00:00.000Z') },
      });
    });

    it('narrows by creation date, inclusive of the final day', async () => {
      mockStats();

      await service.getStats({ dateFrom: '2026-06-01', dateTo: '2026-06-30' });

      const where = mockPrisma.offerPanel.groupBy.mock.calls[0][0].where;
      expect(where.AND).toContainEqual({
        createdAt: {
          gte: new Date('2026-06-01T00:00:00.000Z'),
          lte: new Date('2026-06-30T23:59:59.999Z'),
        },
      });
    });

    it('narrows to nothing when the business unit cannot be resolved', async () => {
      mockStats();
      businessUnitContextMock.resolveByHubspotValue.mockResolvedValue(null);

      const result = await service.getStats({ business_unit: 'Nope' });

      expect(result.totals.total).toBe(0);
      expect(result.senders).toEqual([]);
      // Never widen to every business unit.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('ranks top senders and falls back to email for unnamed users', async () => {
      mockStats(
        [
          makeRow({ created_by_user_id: 'u1', status: 'accepted' }),
          makeRow({ created_by_user_id: 'u1', status: 'accepted' }),
          makeRow({ created_by_user_id: 'u2', status: 'declined' }),
        ],
        [
          {
            created_by_user_id: 'u1',
            status: 'accepted',
            _count: { status: 2 },
          },
          {
            created_by_user_id: 'u2',
            status: 'declined',
            _count: { status: 1 },
          },
        ],
        [
          {
            id: 'u1',
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: 'ada@x',
          },
          { id: 'u2', first_name: null, last_name: null, email: 'bob@x' },
        ],
      );

      const result = await service.getStats({});

      expect(result.topSenders.mostSent).toEqual({
        userId: 'u1',
        name: 'Ada Lovelace',
        count: 2,
      });
      expect(result.topSenders.mostAccepted?.name).toBe('Ada Lovelace');
      expect(result.topSenders.mostDeclined?.name).toBe('bob@x');
    });

    it('buckets monthly outcomes by creation month', async () => {
      mockStats(
        [
          makeRow({
            createdAt: new Date('2026-05-10T00:00:00.000Z'),
            status: 'accepted',
            decided_at: new Date('2026-06-02T00:00:00.000Z'),
            viewed_at: new Date('2026-05-11T00:00:00.000Z'),
          }),
          makeRow({ createdAt: new Date('2026-06-10T00:00:00.000Z') }),
        ],
        [
          {
            created_by_user_id: 'user-admin-1',
            status: 'accepted',
            _count: { status: 1 },
          },
          {
            created_by_user_id: 'user-admin-1',
            status: 'sent',
            _count: { status: 1 },
          },
        ],
      );

      const { monthly } = await service.getStats({});

      // Decided in June, but created in May — it counts in May, keeping each
      // month's outcome bars a subset of that month's sent bar.
      expect(monthly).toEqual([
        { month: '2026-05', sent: 1, accepted: 1, declined: 0 },
        { month: '2026-06', sent: 1, accepted: 0, declined: 0 },
      ]);
    });
  });
});
