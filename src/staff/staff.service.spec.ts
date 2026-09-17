import { Test, TestingModule } from '@nestjs/testing';
import { StaffService } from './staff.service';
import { PrismaService } from '../prisma/prisma.service';
import { HandlerObjectCreation } from '../hubspot/handlers/objectCreation';
import { HandlerOrganizationCreation } from '../hubspot/handlers/organizationCreation';
import { TicketAuditService } from '../ticket/ticket-audit.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock('axios');

const mockPrisma = {
  staff: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
  uSER: {
    findUnique: jest.fn(),
  },
  candidate: {
    findUnique: jest.fn(),
  },
  bonus: {
    create: jest.fn(),
  },
  ticket: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

const HandlerObjectCreationMock = {
  execute: jest.fn(),
};

const HandlerOrganizationCreationMock = {
  execute: jest.fn(),
};

const mockTicketAuditService = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  findAllLogs: jest.fn(),
  findByTicket: jest.fn(),
  findLastDeletedEvent: jest.fn(),
};

describe('StaffService', () => {
  let service: StaffService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: HandlerObjectCreation, useValue: HandlerObjectCreationMock },
        {
          provide: HandlerOrganizationCreation,
          useValue: HandlerOrganizationCreationMock,
        },
        { provide: TicketAuditService, useValue: mockTicketAuditService },
      ],
    }).compile();

    service = module.get<StaffService>(StaffService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // create
  // ─────────────────────────────────────────────────────────────────────────────
  describe('create', () => {
    const mockUser = { id: 'user-1', role: 'system_admin' } as any;
    const mockDto = {
      candidate_id: 'cand-1',
      hirerequest_id: 'hr-1',
      status: 'Active',
      salary: 1000,
      start_date: new Date('2024-01-01'),
    } as any;
    const mockCreated = { id: 'staff-1' };
    const mockFindOneResult = {
      id: 'staff-1',
      status: 'active',
      candidate: null,
      hireRequest: null,
      bonus: [],
    };

    it('should create staff and return findOne result', async () => {
      mockPrisma.staff.create.mockResolvedValue(mockCreated);
      mockPrisma.staff.findUnique.mockResolvedValue(mockFindOneResult);

      const result = await service.create(mockDto, mockUser);

      expect(mockPrisma.staff.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          candidate_id: mockDto.candidate_id,
          hirerequest_id: mockDto.hirerequest_id,
          status: 'active', // staffStatusDictionary['Active']
          created_by: mockUser.id,
        }),
      });
      expect(result).toEqual(mockFindOneResult);
    });

    it('should throw BadRequestException if creation fails', async () => {
      mockPrisma.staff.create.mockRejectedValue(new Error('DB error'));

      await expect(service.create(mockDto, mockUser)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // addBonus
  // ─────────────────────────────────────────────────────────────────────────────
  describe('addBonus', () => {
    const mockSystemUser = {
      id: 'user-1',
      role: 'system_admin',
      organization_id: undefined,
    } as any;
    const mockOrgUser = {
      id: 'user-2',
      role: 'organization_admin',
      organization_id: 'org-1',
    } as any;
    const mockData = {
      staff_id: 'staff-1',
      bonus: 500,
      description: 'Holiday bonus',
    } as any;
    const mockStaff = {
      id: 'staff-1',
      status: 'active',
      hubspot_deal_name: 'Deal A',
      candidate_id: 'cand-1',
      candidate: {
        id: 'cand-1',
        first_name: 'John',
        last_name: 'Doe',
        name: 'John Doe',
      },
    };
    const mockFindOneResult = {
      id: 'staff-1',
      status: 'active',
      candidate: null,
      hireRequest: null,
      bonus: [],
    };

    it('should throw NotFoundException if staff not found', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(null);

      await expect(service.addBonus(mockData, mockSystemUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if staff is not active', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue({
        ...mockStaff,
        status: 'terminated',
      });

      await expect(service.addBonus(mockData, mockSystemUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if org user has no organization_id', async () => {
      const userWithoutOrg = {
        id: 'user-3',
        role: 'organization_admin',
        organization_id: null,
      } as any;
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);

      await expect(service.addBonus(mockData, userWithoutOrg)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if organization not found for org user', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(service.addBonus(mockData, mockOrgUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if creator user not found', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
      mockPrisma.uSER.findUnique.mockResolvedValue(null);

      await expect(service.addBonus(mockData, mockSystemUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if assigned user not found for org user', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
      mockPrisma.organization.findUnique.mockResolvedValue({
        admin_id: 'admin-1',
      });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'user-2' }) // creator found
        .mockResolvedValueOnce(null); // assigned not found

      await expect(service.addBonus(mockData, mockOrgUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should add bonus for system user and return updated staff', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaff) // initial staff check
        .mockResolvedValueOnce(mockFindOneResult); // findOne after transaction
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.bonus.create.mockResolvedValue({ id: 'bonus-1' });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'ticket-1' });
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      const result = await service.addBonus(mockData, mockSystemUser);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.organization.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual(mockFindOneResult);
    });

    it('should record a created audit event tagged with the staff_bonus origin', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaff)
        .mockResolvedValueOnce(mockFindOneResult);
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.bonus.create.mockResolvedValue({ id: 'bonus-1' });
      mockPrisma.ticket.create.mockResolvedValue({
        id: 'ticket-1',
        status: 'new',
        type: 'bonus',
      });
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      await service.addBonus(mockData, mockSystemUser);

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          event: 'created',
          actorUserId: 'user-1',
          metadata: expect.objectContaining({
            origin: 'staff_bonus',
            bonusId: 'bonus-1',
            bonusAmount: mockData.bonus,
          }),
        }),
      );
    });

    it('should resolve org admin and add bonus for org user', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaff)
        .mockResolvedValueOnce(mockFindOneResult);
      mockPrisma.organization.findUnique.mockResolvedValue({
        admin_id: 'admin-1',
      });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'user-2' }) // creator
        .mockResolvedValueOnce({ id: 'admin-1' }); // assigned
      mockPrisma.bonus.create.mockResolvedValue({ id: 'bonus-1' });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'ticket-1' });
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      const result = await service.addBonus(mockData, mockOrgUser);

      expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        select: { admin_id: true },
      });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result).toEqual(mockFindOneResult);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // requestTermination
  // ─────────────────────────────────────────────────────────────────────────────
  describe('requestTermination', () => {
    const mockSystemUser = {
      id: 'user-1',
      role: 'system_admin',
      organization_id: undefined,
    } as any;
    const mockOrgUser = {
      id: 'user-2',
      role: 'organization_admin',
      organization_id: 'org-1',
    } as any;
    const mockData = {
      staff_id: 'staff-1',
      description: 'Performance issues',
    } as any;
    const mockStaff = {
      id: 'staff-1',
      status: 'active',
      hubspot_deal_name: 'Deal A',
      candidate: {
        id: 'cand-1',
        first_name: 'Jane',
        last_name: 'Doe',
        name: 'Jane Doe',
      },
    };
    const mockFindOneResult = {
      id: 'staff-1',
      status: 'termination-requested',
      candidate: null,
      hireRequest: null,
      bonus: [],
    };

    it('should throw NotFoundException if staff not found', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(null);

      await expect(
        service.requestTermination(mockData, mockSystemUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if org user has no organization_id', async () => {
      const userWithoutOrg = {
        id: 'u',
        role: 'organization_admin',
        organization_id: null,
      } as any;
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);

      await expect(
        service.requestTermination(mockData, userWithoutOrg),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if organization not found for org user', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.requestTermination(mockData, mockOrgUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if creator user not found', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
      mockPrisma.uSER.findUnique.mockResolvedValue(null);

      await expect(
        service.requestTermination(mockData, mockSystemUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if assigned user not found for org user', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaff);
      mockPrisma.organization.findUnique.mockResolvedValue({
        admin_id: 'admin-1',
      });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'user-2' })
        .mockResolvedValueOnce(null);

      await expect(
        service.requestTermination(mockData, mockOrgUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create termination ticket and return updated staff for system user', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaff)
        .mockResolvedValueOnce(mockFindOneResult);
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.staff.update.mockResolvedValue({
        id: 'staff-1',
        status: 'termination-requested',
      });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'ticket-1' });
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      const result = await service.requestTermination(mockData, mockSystemUser);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result).toEqual(mockFindOneResult);
    });

    it('should record a created audit event tagged with the staff_termination origin', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaff)
        .mockResolvedValueOnce(mockFindOneResult);
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrisma.staff.update.mockResolvedValue({
        id: 'staff-1',
        status: 'termination-requested',
      });
      mockPrisma.ticket.create.mockResolvedValue({
        id: 'ticket-1',
        status: 'new',
        type: 'termination',
      });
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      await service.requestTermination(mockData, mockSystemUser);

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-1',
          event: 'created',
          actorUserId: 'user-1',
          metadata: expect.objectContaining({
            origin: 'staff_termination',
            staffStatusAfter: 'termination-requested',
          }),
        }),
      );
    });

    it('should resolve org admin and create termination for org user', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaff)
        .mockResolvedValueOnce(mockFindOneResult);
      mockPrisma.organization.findUnique.mockResolvedValue({
        admin_id: 'admin-1',
      });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'user-2' })
        .mockResolvedValueOnce({ id: 'admin-1' });
      mockPrisma.staff.update.mockResolvedValue({
        id: 'staff-1',
        status: 'termination-requested',
      });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'ticket-1' });
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      await service.requestTermination(mockData, mockOrgUser);

      expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith({
        where: { id: 'org-1' },
        select: { admin_id: true },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getStaffForTickets
  // ─────────────────────────────────────────────────────────────────────────────
  describe('getStaffForTickets', () => {
    const mockStaffList = [
      {
        id: 'staff-1',
        status: 'active',
        candidate: { first_name: 'John' },
        hireRequest: { title: 'Job A' },
      },
    ];

    it('should return all staff for system user without org filter', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;
      mockPrisma.staff.findMany.mockResolvedValue(mockStaffList);

      const result = await service.getStaffForTickets(systemUser);

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.hireRequest).toEqual({});
      expect(result).toEqual(mockStaffList);
    });

    it('should filter by org_id for organization user', async () => {
      const orgUser = {
        id: 'u2',
        role: 'organization_admin',
        organization_id: 'org-1',
      } as any;
      mockPrisma.staff.findMany.mockResolvedValue(mockStaffList);

      await service.getStaffForTickets(orgUser);

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.hireRequest.org_id).toBe('org-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // findAll
  // ─────────────────────────────────────────────────────────────────────────────
  describe('findAll', () => {
    const mockStaffData = [
      {
        id: 'staff-1',
        status: 'active',
        candidate: { avatar_url: 'avatar.png' },
      },
    ];
    const mockTotal = 1;

    beforeEach(() => {
      mockPrisma.staff.findMany.mockResolvedValue(mockStaffData);
      mockPrisma.staff.count.mockResolvedValue(mockTotal);
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );
    });

    it('should return paginated staff with default pagination', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      const result: any = await service.findAll(
        systemUser,
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      );

      expect(result.meta.page).toBe(1);
      expect(result.meta.perPage).toBe(10);
      expect(result.meta.total).toBe(mockTotal);
      expect(result.meta.totalPages).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('should return paginated staff with custom pagination', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      const result: any = await service.findAll(
        systemUser,
        2,
        5,
        null as any,
        null as any,
        null as any,
      );

      expect(result.meta.page).toBe(2);
      expect(result.meta.perPage).toBe(5);
    });

    it('should not add AND condition for system user without search', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      await service.findAll(
        systemUser,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toBeUndefined();
    });

    it('should add only org filter in AND for org user without search', async () => {
      const orgUser = {
        id: 'u2',
        role: 'organization_admin',
        organization_id: 'org-1',
      } as any;

      await service.findAll(
        orgUser,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(1);
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          { hireRequest: { org_id: 'org-1' } },
          { organization_id: 'org-1' },
        ]),
      );
    });

    it('should add only search filter in AND for system user with search', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      await service.findAll(
        systemUser,
        1,
        10,
        'John',
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(1);
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'John', mode: 'insensitive' },
            },
          },
        ]),
      );
    });

    it('should combine org AND search filters for org user with search (AND with two ORs)', async () => {
      const orgUser = {
        id: 'u2',
        role: 'organization_admin',
        organization_id: 'org-1',
      } as any;

      await service.findAll(orgUser, 1, 10, 'John', null as any, null as any);

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(2);

      // First AND condition: org filter
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          { hireRequest: { org_id: 'org-1' } },
          { organization_id: 'org-1' },
        ]),
      );

      // Second AND condition: search filter
      expect(whereArg.AND[1].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'John', mode: 'insensitive' },
            },
          },
          {
            candidate: { last_name: { contains: 'John', mode: 'insensitive' } },
          },
          { hubspot_deal_name: { contains: 'John', mode: 'insensitive' } },
        ]),
      );
    });

    it('should tokenize a full name into multiple AND conditions', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      await service.findAll(
        systemUser,
        1,
        10,
        'Svetlana Petrova',
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(2);
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'Svetlana', mode: 'insensitive' },
            },
          },
        ]),
      );
      expect(whereArg.AND[1].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              last_name: { contains: 'Petrova', mode: 'insensitive' },
            },
          },
        ]),
      );
    });

    it('should apply start_date range when both dates are provided', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;
      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');

      await service.findAll(systemUser, 1, 10, null as any, from, to);

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.start_date.gte).toEqual(new Date(from));
      expect(whereArg.start_date.lte).toEqual(new Date(to));
    });

    it('should apply only start_date.gte when only start_date_from is provided', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;
      const from = new Date('2024-01-01');

      await service.findAll(systemUser, 1, 10, null as any, from, null as any);

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.start_date.gte).toEqual(new Date(from));
      expect(whereArg.start_date.lte).toBeUndefined();
    });

    it('should map avatar_url to avatar with AVATAR_URL env var', async () => {
      process.env.AVATAR_URL = 'https://cdn.example.com/';
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      const result: any = await service.findAll(
        systemUser,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      expect(result.data[0].candidate.avatar).toBe(
        'https://cdn.example.com/avatar.png',
      );
      delete process.env.AVATAR_URL;
    });

    it('should set avatar to null when avatar_url is absent', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-2', status: 'active', candidate: { avatar_url: null } },
      ]);
      const systemUser = { id: 'u1', role: 'system_admin' } as any;

      const result: any = await service.findAll(
        systemUser,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      expect(result.data[0].candidate.avatar).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // findByOrganization
  // ─────────────────────────────────────────────────────────────────────────────
  describe('findByOrganization', () => {
    const mockSystemUser = { id: 'u1', role: 'system_admin' } as any;
    const orgId = 'org-1';
    const mockStaffData = [{ id: 'staff-1', status: 'active' }];
    const mockTotal = 1;

    beforeEach(() => {
      mockPrisma.staff.findMany.mockResolvedValue(mockStaffData);
      mockPrisma.staff.count.mockResolvedValue(mockTotal);
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );
    });

    it('should return paginated staff for the given organization', async () => {
      const result: any = await service.findByOrganization(
        mockSystemUser,
        orgId,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      expect(result.status).toBe(200);
      expect(result.data).toEqual([{ ...mockStaffData[0], candidate: null }]);
      expect(result.meta.total).toBe(mockTotal);
    });

    it('should use default pagination if page/perPage not provided', async () => {
      const result: any = await service.findByOrganization(
        mockSystemUser,
        orgId,
        null as any,
        null as any,
        null as any,
        null as any,
        null as any,
      );

      expect(result.meta.page).toBe(1);
      expect(result.meta.perPage).toBe(10);
    });

    it('should filter by organizationId in OR condition', async () => {
      await service.findByOrganization(
        mockSystemUser,
        orgId,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.OR).toEqual(
        expect.arrayContaining([
          { hireRequest: { org_id: orgId } },
          { organization_id: orgId },
        ]),
      );
    });

    it('should apply start_date range filter', async () => {
      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');

      await service.findByOrganization(
        mockSystemUser,
        orgId,
        1,
        10,
        null as any,
        from,
        to,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.start_date.gte).toEqual(new Date(from));
      expect(whereArg.start_date.lte).toEqual(new Date(to));
    });

    it('should calculate totalPages correctly', async () => {
      mockPrisma.staff.count.mockResolvedValue(25);

      const result: any = await service.findByOrganization(
        mockSystemUser,
        orgId,
        1,
        10,
        null as any,
        null as any,
        null as any,
      );

      expect(result.meta.totalPages).toBe(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // updateStaff
  // ─────────────────────────────────────────────────────────────────────────────
  describe('updateStaff', () => {
    const mockUser = { id: 'u1', role: 'system_admin' } as any;
    const staffId = 'staff-1';
    const mockExistingStaff = {
      id: staffId,
      status: 'active',
      candidate: { id: 'cand-1' },
    };
    const mockUpdatedResult = { id: staffId, status: 'termination-requested' };

    it('should throw NotFoundException if staff not found', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStaff(
          staffId,
          { status: 'Termination Requested' },
          mockUser,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update staff status and return result with status 200', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockExistingStaff);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txMock = {
          staff: {
            update: jest.fn().mockResolvedValue(mockExistingStaff),
            findUnique: jest.fn().mockResolvedValue(mockUpdatedResult),
          },
        };
        return fn(txMock);
      });

      const result: any = await service.updateStaff(
        staffId,
        { status: 'Termination Requested' },
        mockUser,
      );

      expect(result.status).toBe(200);
      expect(result.message).toBe('Staff updated successfully');
      expect(result.data).toEqual({ ...mockUpdatedResult, candidate: null });
    });

    it('should translate status via staffStatusDictionary', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockExistingStaff);
      let capturedUpdateData: any;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const txMock = {
          staff: {
            update: jest.fn().mockImplementation(({ data }) => {
              capturedUpdateData = data;
              return Promise.resolve(mockExistingStaff);
            }),
            findUnique: jest.fn().mockResolvedValue(mockUpdatedResult),
          },
        };
        return fn(txMock);
      });

      await service.updateStaff(
        staffId,
        { status: 'Termination Requested' },
        mockUser,
      );

      expect(capturedUpdateData.status).toBe('termination-requested');
    });

    it('should throw BadRequestException on unexpected DB error', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockExistingStaff);
      mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));

      await expect(
        service.updateStaff(staffId, { status: 'Active' }, mockUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should re-throw NotFoundException if thrown inside transaction', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockExistingStaff);
      mockPrisma.$transaction.mockRejectedValue(
        new NotFoundException('Staff not found inside tx'),
      );

      await expect(
        service.updateStaff(staffId, { status: 'Active' }, mockUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // moveStaffBackToActive
  // ─────────────────────────────────────────────────────────────────────────────
  describe('moveStaffBackToActive', () => {
    const mockStaffId = '123';
    const mockStaffData = { id: mockStaffId, status: 'termination-requested' };
    const mockUpdatedStaff = { id: mockStaffId, status: 'active' };
    const mockFindOneResult = {
      id: mockStaffId,
      name: 'John Doe',
      candidate: null,
    };

    it('should throw BadRequestException if staffId is not provided', async () => {
      await expect(service.moveStaffBackToActive('')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if staff is not found or not in termination-requested status', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(null);

      await expect(service.moveStaffBackToActive(mockStaffId)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.staff.findUnique).toHaveBeenCalledWith({
        where: { id: mockStaffId, status: 'termination-requested' },
        select: { id: true },
      });
    });

    it('should throw BadRequestException if update returns null', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(mockStaffData);
      mockPrisma.staff.update.mockResolvedValue(null);

      await expect(service.moveStaffBackToActive(mockStaffId)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.staff.update).toHaveBeenCalledWith({
        where: { id: mockStaffId },
        data: { status: 'active' },
      });
    });

    it('should update status to active and return updated staff', async () => {
      mockPrisma.staff.findUnique
        .mockResolvedValueOnce(mockStaffData)
        .mockResolvedValueOnce(mockFindOneResult);
      mockPrisma.staff.update.mockResolvedValue(mockUpdatedStaff);

      const result = await service.moveStaffBackToActive(mockStaffId);

      expect(mockPrisma.staff.update).toHaveBeenCalledWith({
        where: { id: mockStaffId },
        data: { status: 'active' },
      });
      expect(result).toEqual(mockFindOneResult);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // searchStaff
  // ─────────────────────────────────────────────────────────────────────────────
  describe('searchStaff', () => {
    beforeEach(() => {
      mockPrisma.staff.findMany.mockResolvedValue([]);
    });

    it('should return empty array when no staff found', async () => {
      const result = await service.searchStaff({});
      expect(result).toEqual([]);
      expect(mockPrisma.staff.findMany).toHaveBeenCalled();
    });

    it('should filter by status when provided', async () => {
      await service.searchStaff({ status: 'active' });
      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.status).toBe('active');
    });

    it('should filter by organization_id when provided', async () => {
      await service.searchStaff({ organization_id: 'org-1' });
      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.organization_id).toBe('org-1');
    });

    it('should add OR search filter when a single-word search is provided', async () => {
      await service.searchStaff({ search: 'John' });
      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(1);
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'John', mode: 'insensitive' },
            },
          },
          {
            candidate: { last_name: { contains: 'John', mode: 'insensitive' } },
          },
        ]),
      );
    });

    it('should still match by email as a single token', async () => {
      await service.searchStaff({ search: 'doctor@hospital.com' });
      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              email: { contains: 'doctor@hospital.com', mode: 'insensitive' },
            },
          },
        ]),
      );
    });

    it('should match a full name split across first_name and last_name', async () => {
      // Regression: searching a complete full name ("Svetlana Petrova") must
      // match a staff whose first_name is "Svetlana" and last_name is "Petrova".
      await service.searchStaff({ search: 'Svetlana Petrova' });
      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;

      // Each whitespace-separated token must be AND-ed together, each token
      // matchable against any searchable column.
      expect(whereArg.AND).toBeDefined();
      expect(whereArg.AND).toHaveLength(2);

      const [firstToken, secondToken] = whereArg.AND;

      expect(firstToken.OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'Svetlana', mode: 'insensitive' },
            },
          },
          {
            candidate: {
              last_name: { contains: 'Svetlana', mode: 'insensitive' },
            },
          },
        ]),
      );

      expect(secondToken.OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'Petrova', mode: 'insensitive' },
            },
          },
          {
            candidate: {
              last_name: { contains: 'Petrova', mode: 'insensitive' },
            },
          },
        ]),
      );
    });

    it('should apply take limit when limit is provided', async () => {
      await service.searchStaff({ limit: 5 });
      const queryArg = mockPrisma.staff.findMany.mock.calls[0][0];
      expect(queryArg.take).toBe(5);
    });

    it('should map avatar_url to avatar in returned staff', async () => {
      process.env.AVATAR_URL = 'https://cdn.example.com/';
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', candidate: { avatar_url: 'photo.png' } },
      ]);

      const result: any = await service.searchStaff({});
      expect(result[0].candidate.avatar).toBe(
        'https://cdn.example.com/photo.png',
      );
      delete process.env.AVATAR_URL;
    });

    it('should set avatar to null when candidate has no avatar_url', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', candidate: { avatar_url: null } },
      ]);

      const result: any = await service.searchStaff({});
      expect(result[0].candidate.avatar).toBeNull();
    });

    it('should set candidate to null when staff has no candidate', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', candidate: null },
      ]);

      const result: any = await service.searchStaff({});
      expect(result[0].candidate).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // findByOrganization — search branch
  // ─────────────────────────────────────────────────────────────────────────────
  describe('findByOrganization (search branch)', () => {
    it('should add tokenized search conditions when search is provided', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;
      mockPrisma.staff.findMany.mockResolvedValue([]);
      mockPrisma.staff.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      await service.findByOrganization(
        systemUser,
        'org-1',
        1,
        10,
        'Jane',
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(1);
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'Jane', mode: 'insensitive' },
            },
          },
          {
            candidate: { last_name: { contains: 'Jane', mode: 'insensitive' } },
          },
        ]),
      );
    });

    it('should tokenize a full name across first_name and last_name', async () => {
      const systemUser = { id: 'u1', role: 'system_admin' } as any;
      mockPrisma.staff.findMany.mockResolvedValue([]);
      mockPrisma.staff.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockImplementation((arr: any[]) =>
        Promise.all(arr),
      );

      await service.findByOrganization(
        systemUser,
        'org-1',
        1,
        10,
        'Svetlana Petrova',
        null as any,
        null as any,
      );

      const whereArg = mockPrisma.staff.findMany.mock.calls[0][0].where;
      expect(whereArg.AND).toHaveLength(2);
      expect(whereArg.AND[0].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              first_name: { contains: 'Svetlana', mode: 'insensitive' },
            },
          },
        ]),
      );
      expect(whereArg.AND[1].OR).toEqual(
        expect.arrayContaining([
          {
            candidate: {
              last_name: { contains: 'Petrova', mode: 'insensitive' },
            },
          },
        ]),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // syncOrganizationIds
  // ─────────────────────────────────────────────────────────────────────────────
  describe('syncOrganizationIds', () => {
    it('should return early message when no staff records without org', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([]);

      const result = await service.syncOrganizationIds();

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.message).toContain('No staff records to sync');
    });

    it('should update staff organization_id when org is found directly', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', hubspot_organization_id: 'hs-org-1' },
      ]);
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-1' });
      mockPrisma.staff.update.mockResolvedValue({});

      const result = await service.syncOrganizationIds();

      expect(mockPrisma.staff.update).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
        data: { organization_id: 'org-1' },
      });
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('should create org via organizationCreation when not found, then update', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', hubspot_organization_id: 'hs-org-2' },
      ]);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce(null) // not found initially
        .mockResolvedValueOnce({ id: 'org-2' }); // found after creation
      HandlerOrganizationCreationMock.execute.mockResolvedValue({});
      mockPrisma.staff.update.mockResolvedValue({});

      const result = await service.syncOrganizationIds();

      expect(HandlerOrganizationCreationMock.execute).toHaveBeenCalledWith({
        objectId: 'hs-org-2',
      });
      expect(result.updated).toBe(1);
    });

    it('should record error and skip when organizationCreation.execute throws', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', hubspot_organization_id: 'hs-org-fail' },
      ]);
      mockPrisma.organization.findUnique.mockResolvedValue(null);
      HandlerOrganizationCreationMock.execute.mockRejectedValue(
        new Error('HubSpot error'),
      );

      const result = await service.syncOrganizationIds();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].staffId).toBe('staff-1');
      expect(result.updated).toBe(0);
    });

    it('should skip when org still not found after creation attempt', async () => {
      mockPrisma.staff.findMany.mockResolvedValue([
        { id: 'staff-1', hubspot_organization_id: 'hs-org-3' },
      ]);
      mockPrisma.organization.findUnique
        .mockResolvedValueOnce(null) // not found initially
        .mockResolvedValueOnce(null); // still not found after creation
      HandlerOrganizationCreationMock.execute.mockResolvedValue({});

      const result = await service.syncOrganizationIds();

      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // populateDbFromHubspot
  // ─────────────────────────────────────────────────────────────────────────────
  describe('populateDbFromHubspot', () => {
    let axiosMock: jest.Mocked<any>;

    beforeEach(() => {
      axiosMock = jest.requireMock('axios');
      jest.clearAllMocks();
    });

    it('should return success message with 0 deals when no deals are fetched', async () => {
      axiosMock.post.mockResolvedValueOnce({
        data: { results: [], paging: null },
      });

      const result = await service.populateDbFromHubspot();
      expect(result).toContain('0 deals');
      expect(mockPrisma.staff.createMany).not.toHaveBeenCalled();
    });

    it('should process deal with candidate found in DB and company association', async () => {
      const deal = {
        id: 'deal-hs-1',
        properties: { hs_object_id: 'deal-hs-1' },
      };

      // 1. fetch deals
      axiosMock.post
        .mockResolvedValueOnce({ data: { results: [deal], paging: null } })
        // 2. VA associations batch
        .mockResolvedValueOnce({
          data: {
            results: [{ from: { id: 'deal-hs-1' }, to: [{ id: 'cand-hs-1' }] }],
          },
        })
        // 3. company associations batch
        .mockResolvedValueOnce({
          data: {
            results: [{ from: { id: 'deal-hs-1' }, to: [{ id: 'org-hs-1' }] }],
          },
        });

      mockPrisma.candidate.findUnique.mockResolvedValue({ id: 'cand-db-1' });
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org-db-1' });
      mockPrisma.staff.createMany.mockResolvedValue({ count: 1 });

      const result = await service.populateDbFromHubspot();

      expect(mockPrisma.candidate.findUnique).toHaveBeenCalled();
      expect(mockPrisma.staff.createMany).toHaveBeenCalled();
      expect(result).toContain('1 deals');
    });

    it('should create candidate via objectCreation when not found, then associate', async () => {
      const deal = {
        id: 'deal-hs-2',
        properties: { hs_object_id: 'deal-hs-2' },
      };

      axiosMock.post
        .mockResolvedValueOnce({ data: { results: [deal], paging: null } })
        .mockResolvedValueOnce({
          data: {
            results: [{ from: { id: 'deal-hs-2' }, to: [{ id: 'cand-hs-2' }] }],
          },
        })
        .mockResolvedValueOnce({ data: { results: [] } });

      mockPrisma.candidate.findUnique
        .mockResolvedValueOnce(null) // not found initially
        .mockResolvedValueOnce({ id: 'cand-db-2' }); // found after creation
      HandlerObjectCreationMock.execute.mockResolvedValue({});
      mockPrisma.staff.createMany.mockResolvedValue({ count: 1 });

      await service.populateDbFromHubspot();

      expect(HandlerObjectCreationMock.execute).toHaveBeenCalledWith({
        objectId: 'cand-hs-2',
      });
      expect(mockPrisma.staff.createMany).toHaveBeenCalled();
    });

    it('should handle pagination by following paging.next.after', async () => {
      const deal1 = { id: 'deal-1', properties: { hs_object_id: 'deal-1' } };
      const deal2 = { id: 'deal-2', properties: { hs_object_id: 'deal-2' } };

      axiosMock.post
        // first page with paging.next.after
        .mockResolvedValueOnce({
          data: { results: [deal1], paging: { next: { after: 'cursor-1' } } },
        })
        // second page, no more paging
        .mockResolvedValueOnce({ data: { results: [deal2], paging: null } })
        // VA associations for batch of 2
        .mockResolvedValueOnce({ data: { results: [] } })
        // company associations for batch of 2
        .mockResolvedValueOnce({ data: { results: [] } });

      mockPrisma.staff.createMany.mockResolvedValue({ count: 2 });

      const result = await service.populateDbFromHubspot();

      expect(result).toContain('2 deals');
    });

    it('should handle error thrown during association batch lookup and continue', async () => {
      const deal = { id: 'deal-err', properties: { hs_object_id: 'deal-err' } };

      axiosMock.post
        .mockResolvedValueOnce({ data: { results: [deal], paging: null } })
        .mockRejectedValueOnce(new Error('Association error'))
        .mockResolvedValueOnce({ data: { results: [] } });

      const result = await service.populateDbFromHubspot();

      expect(result).toContain('0 deals');
    });
  });
});
