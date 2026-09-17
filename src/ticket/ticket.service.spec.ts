import { Test, TestingModule } from '@nestjs/testing';
import { TicketService } from './ticket.service';
import { TicketAuditService } from './ticket-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Priority } from '@prisma/client';
import { ticketTypeDictionary } from '../common/dictionaries/ticket-type';

const userfake = {
  id: '1',
  organization_id: 'org1',
  role: 'organization_admin',
  email: 'test@test.com',
  password: '',
  organization_name: 'Default Organization',
  first_name: 'John',
  last_name: 'Doe',
  phone: '',
  avatar: '',
  job_title: '',
  workos_id: '',
  authentication_method: 'OwnSign',
  status: 'active',
  is_organization_owner: false,
  verified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByMethod: 'self_signup',
  createdByUserId: null,
  hubspot_id: '1',
  hubspot_contact_id: '1',
  status_before_deactivation: null,
  activatedAt: null,
  billcom_session_id: null,
  billcom_session_expires: null,
  billcom_pending_session_id: null,
  billcom_remember_me_id: null,
  billcom_device: null,
  deactivated_by_bu: null,
  onboarding_tour_dismissed: false,
};

const systemAdminUser = {
  ...userfake,
  id: 'admin1',
  role: 'system_admin',
  organization_id: null,
};
const systemSuperAdminUser = {
  ...userfake,
  id: 'sadmin1',
  role: 'system_super_admin',
  organization_id: null,
};
const orgSuperAdminUser = {
  ...userfake,
  id: 'osa1',
  role: 'organization_super_admin',
  organization_id: 'org1',
};

describe('TicketService', () => {
  let service: TicketService;
  let prisma: PrismaService;

  const mockPrisma = {
    ticket: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      // Soft delete forces non-unique `deleted_at` into where clauses, which findUnique
      // rejects in Prisma 6 — every guarded read is a findFirst.
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    bonus: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    ticketNotes: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    ticketAuditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    uSER: {
      findUnique: jest.fn(),
    },
    staff: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    candidate: {
      findUnique: jest.fn(),
    },
    hireRequest: {
      findUnique: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  };

  const mockTicketAuditService = {
    log: jest.fn(),
    logOrThrow: jest.fn(),
    findAllLogs: jest.fn(),
    findByTicket: jest.fn(),
    findLastDeletedEvent: jest.fn(),
  };

  const mockNotificationsService = {
    sendNotification: jest.fn(),
    createNotification: jest.fn(),
    getNotifications: jest.fn(),
    markAsRead: jest.fn(),
    deleteNotification: jest.fn(),
    notifyTicketEvent: jest.fn(),
    notifyTicketStatusChangeToCreator: jest.fn(),
    notifyTicketReopened: jest.fn(),
    notifyTicketNoteAddedToAssignee: jest.fn(),
    notifyTicketNoteAddedToCreator: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: TicketAuditService, useValue: mockTicketAuditService },
      ],
    }).compile();

    service = module.get<TicketService>(TicketService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe.skip('Create', () => {
    const dto = {
      client_id: 'client1',
      type: 'issue',
      title: 'Ticket title',
      description: 'Ticket description',
      priority: 'HIGH' as Priority,
      assigned_user_id: ['user1'],
    };

    const mockTicket = {
      id: '1',
      ...dto,
      type: ticketTypeDictionary[dto.type] ?? null,
    };
    const mockTicketFull = { id: '1', title: 'Ticket title', status: 'open' };

    beforeEach(() => {
      jest.clearAllMocks();
      (service as any).findOne = jest.fn().mockResolvedValue(mockTicketFull);
    });

    it('should create a ticket successfully and return full ticket', async () => {
      mockPrisma.ticket.create.mockResolvedValue(mockTicket);

      const result = await service.create(dto, userfake);

      expect(result).toEqual(mockTicketFull);
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith({
        data: {
          organization: { connect: { id: dto.client_id } },
          type: ticketTypeDictionary[dto.type] ?? null,
          title: dto.title,
          description: dto.description,
          priority: dto.priority,
          user: { connect: { id: dto.assigned_user_id } },
        },
      });
      expect((service as any).findOne).toHaveBeenCalledWith('1');
    });

    it('should create a ticket with type=null if type is invalid', async () => {
      const dtoInvalidType = { ...dto, type: 'invalid_type' };
      const mockTicketInvalid = { id: '2', ...dtoInvalidType, type: null };
      mockPrisma.ticket.create.mockResolvedValue(mockTicketInvalid);

      const result = await service.create(dtoInvalidType, userfake);

      expect(result).toEqual(mockTicketFull);
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: null }),
        }),
      );
    });

    it('should create a ticket without assigned user', async () => {
      const dtoNoUser = { ...dto, assigned_user_id: [''] };
      const mockTicketNoUser = {
        id: '3',
        ...dtoNoUser,
        type: ticketTypeDictionary[dto.type] ?? null,
      };
      mockPrisma.ticket.create.mockResolvedValue(mockTicketNoUser);

      const result = await service.create(dtoNoUser, userfake);

      expect(result).toEqual(mockTicketFull);
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith({
        data: {
          organization: { connect: { id: dto.client_id } },
          type: ticketTypeDictionary[dto.type] ?? null,
          title: dto.title,
          description: dto.description,
          priority: dto.priority,
          user: undefined,
        },
      });
    });

    it('should throw BadRequestException if ticket is null', async () => {
      mockPrisma.ticket.create.mockResolvedValue(null);

      await expect(service.create(dto, userfake)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if Prisma throws error', async () => {
      mockPrisma.ticket.create.mockRejectedValue(new Error('DB error'));

      await expect(service.create(dto, userfake)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if findOne returns null', async () => {
      mockPrisma.ticket.create.mockResolvedValue(mockTicket);
      (service as any).findOne = jest.fn().mockResolvedValue(null);

      await expect(service.create(dto, userfake)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findAll', () => {
    const mockTickets = [
      { id: 1, title: 'Ticket 1', candidate: null, staff: null },
    ];

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return all tickets without filters', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      const result = await service.findAll(
        userfake,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      expect(result).toEqual(mockTickets);

      // Calculate expected 30 days ago date for comparison
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith({
        where: {
          type: undefined,
          priority: undefined,
          deleted_at: null,
          created_by: '1',
          // Exclude tickets that are closed and were last updated more than 30 days ago
          NOT: {
            AND: [
              { status: 'closed' },
              { updatedAt: { lt: expect.any(Date) } },
            ],
          },
        },
        select: {
          id: true,
          type: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          deleted_at: true,
          deleted_by: true,
          deletion_reason: true,
          createdAt: true,
          created_by: true,
          createdBy: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              job_title: true,
              role: true,
              status: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
              email: true,
              business_unit: true,
              organization_role: true,
              status: true,
              admin_id: true,
              admin: {
                select: { id: true, first_name: true, last_name: true },
              },
            },
          },
          user: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              job_title: true,
              role: true,
              status: true,
              email: true,
            },
          },
          candidate: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              name: true,
              specialization: true,
              years_of_experience: true,
              country: true,
              gender: true,
              avatar_url: true,
            },
          },
          staff: {
            select: {
              id: true,
              status: true,
              salary: true,
              start_date: true,
              terminated_date: true,
              candidate: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  email: true,
                  name: true,
                  specialization: true,
                  years_of_experience: true,
                  country: true,
                  gender: true,
                  avatar_url: true,
                },
              },
            },
          },
          offerPanel: {
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              business_unit: true,
              recipient_name: true,
              recipient_email: true,
              recipient_org_name: true,
              recipient_type: true,
              recipient_company_id: true,
              recipientCompany: {
                select: {
                  id: true,
                  name: true,
                  business_unit: true,
                  organization_role: true,
                  status: true,
                  admin: {
                    select: { id: true, first_name: true, last_name: true },
                  },
                },
              },
              view_count: true,
              viewed_at: true,
              decided_at: true,
              public_token: true,
              is_public: true,
              createdAt: true,
            },
          },
        },
      });
    });

    it('should apply type filter', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(userfake, 'bug', undefined, undefined, undefined);

      expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: 'bug' }),
        }),
      );
    });

    it('should apply priority filter', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(userfake, undefined, 'high', undefined, undefined);

      expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ priority: 'high' }),
        }),
      );
    });

    it('should apply assigned_user_id filter', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(
        userfake,
        undefined,
        undefined,
        'user-123',
        undefined,
      );

      expect(mockPrisma.ticket.findMany).toHaveBeenCalled();
    });

    it('should apply search filter to organization and title', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(userfake, undefined, undefined, undefined, 'test');

      expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              {
                organization: {
                  name: { contains: 'test', mode: 'insensitive' },
                },
              },
              { title: { contains: 'test', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('should throw BadRequestException if tickets is null', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(null);

      await expect(
        service.findAll(userfake, undefined, undefined, undefined, undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if Prisma findMany fails', async () => {
      mockPrisma.ticket.findMany.mockRejectedValue(new Error('DB error'));

      await expect(
        service.findAll(userfake, undefined, undefined, undefined, undefined),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('reassign', () => {
    const dto = { assigned_user_id: 'user1' };
    const ticketId = 'ticket123';
    const currentTicketmock = { status: 'open' };
    const mockTicketUpdated = { id: ticketId };
    const mockTicketFinal = {
      id: ticketId,
      organization: { id: 'org1', name: 'Org 1' },
      user: {
        id: 'user1',
        first_name: 'John',
        last_name: 'Doe',
        job_title: 'Dev',
        role: 'Admin',
        status: 'ACTIVE',
        email: 'john@example.com',
      },
      candidate: null,
      staff: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException if ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce(null);

      await expect(service.reassing(ticketId, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.ticket.findFirst).toHaveBeenCalledWith({
        where: { id: ticketId, deleted_at: null },
        // user_id is selected so the audit event can record the previous assignee.
        select: { status: true, user_id: true },
      });
    });

    it('should throw BadRequestException if reassigning to unassigned for non-new ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce({ status: 'open' });

      await expect(
        service.reassing(ticketId, { assigned_user_id: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if ticket update fails', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce(currentTicketmock);
      mockPrisma.ticket.update.mockResolvedValueOnce(null);

      await expect(service.reassing(ticketId, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: ticketId },
        data: { user: { connect: { id: dto.assigned_user_id } } },
      });
    });

    it('should throw BadRequestException if fetching reassigned ticket fails', async () => {
      // 1ª chamada: currentTicket
      // 2ª chamada: findOne -> retorna null
      mockPrisma.ticket.findFirst
        .mockImplementationOnce(() => Promise.resolve(currentTicketmock))
        .mockImplementationOnce(() => Promise.resolve(null));

      mockPrisma.ticket.update.mockResolvedValueOnce(mockTicketUpdated);

      await expect(service.reassing(ticketId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reassign ticket successfully', async () => {
      mockPrisma.ticket.findFirst
        .mockImplementationOnce(() => Promise.resolve(currentTicketmock)) // currentTicket
        .mockImplementationOnce(() => Promise.resolve(mockTicketFinal)); // findOne

      mockPrisma.ticket.update.mockResolvedValueOnce(mockTicketUpdated);

      const result = await service.reassing(ticketId, dto);

      expect(result).toEqual(mockTicketFinal);
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: ticketId },
        data: { user: { connect: { id: dto.assigned_user_id } } },
      });
    });

    it('should throw BadRequestException if Prisma throws error', async () => {
      mockPrisma.ticket.findFirst.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.reassing(ticketId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should record who reassigned the ticket and who held it before', async () => {
      mockPrisma.ticket.findFirst
        .mockImplementationOnce(() =>
          Promise.resolve({ ...currentTicketmock, user_id: 'previous-user' }),
        )
        .mockImplementationOnce(() => Promise.resolve(mockTicketFinal));
      mockPrisma.ticket.update.mockResolvedValueOnce(mockTicketUpdated);

      await service.reassing(ticketId, dto, systemAdminUser as any);

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId,
          event: 'reassigned',
          actorUserId: systemAdminUser.id,
          actorLabel: 'John Doe',
          before: { user_id: 'previous-user' },
          after: { user_id: dto.assigned_user_id },
          metadata: expect.objectContaining({
            actorRole: 'system_admin',
            previousAssignee: 'previous-user',
            unassigned: false,
          }),
        }),
      );
    });

    it('should flag an unassignment in the audit metadata', async () => {
      mockPrisma.ticket.findFirst
        .mockImplementationOnce(() =>
          Promise.resolve({ status: 'new', user_id: 'previous-user' }),
        )
        .mockImplementationOnce(() => Promise.resolve(mockTicketFinal));
      mockPrisma.ticket.update.mockResolvedValueOnce(mockTicketUpdated);

      await service.reassing(
        ticketId,
        { assigned_user_id: null } as any,
        systemAdminUser as any,
      );

      const params = mockTicketAuditService.log.mock.calls[0][0];
      expect(params.metadata.unassigned).toBe(true);
      expect(params.after.user_id).toBeNull();
    });
  });

  describe('updateStatus', () => {
    const ticketId = 'ticket123';
    const newStatus = 'in_progress';
    const mockTicketUpdated = { id: ticketId, status: newStatus };
    const mockTicketFinal = {
      id: 'ticket123',
      status: 'in_progress',
      type: 'termination',
      staff: { id: 'staff1', candidate: null },
      user: { id: 'user1' },
      candidate: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw if ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.updateStatus(ticketId, { status: newStatus }),
      ).rejects.toThrow('Ticket not found');
    });

    it('should throw if status is the same', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ status: newStatus });

      await expect(
        service.updateStatus(ticketId, { status: newStatus }),
      ).rejects.toThrow(`Ticket is already in status: ${newStatus}`);
    });

    it('should throw if changing from closed to resolved', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({ status: 'closed' });

      await expect(
        service.updateStatus(ticketId, { status: 'resolved' }),
      ).rejects.toThrow('Cannot change status from CLOSED to RESOLVED');
    });

    it('should throw if going new→in_progress without assigned user', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        status: 'new',
        user: null,
      });

      await expect(
        service.updateStatus(ticketId, { status: 'in_progress' }),
      ).rejects.toThrow(
        'Please assign a user to the ticket before changing status to IN PROGRESS',
      );
    });

    it('should throw if going new→resolved without assigned user', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        status: 'new',
        user: null,
      });

      await expect(
        service.updateStatus(ticketId, { status: 'resolved' }),
      ).rejects.toThrow(
        'Please assign a user to the ticket before changing status to RESOLVED',
      );
    });

    it('should terminate staff when resolving termination ticket', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({
          status: 'open',
          type: 'termination',
          staff: { id: 'staff1' },
          user: { id: 'user1' },
        })
        .mockResolvedValueOnce(mockTicketFinal);
      mockPrisma.staff.update.mockResolvedValue({
        id: 'staff1',
        status: 'terminated',
      });
      mockPrisma.ticket.update.mockResolvedValue(mockTicketUpdated);

      const result = await service.updateStatus(ticketId, {
        status: 'resolved',
      });

      expect(mockPrisma.staff.update).toHaveBeenCalledWith({
        where: { id: 'staff1' },
        data: expect.objectContaining({ status: 'terminated' }),
      });
      expect(result).toEqual(mockTicketFinal);
    });

    it('should throw if ticket update returns null', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        status: 'open',
        user: { id: 'u1' },
      });
      mockPrisma.ticket.update.mockResolvedValue(null);

      await expect(
        service.updateStatus(ticketId, { status: newStatus }),
      ).rejects.toThrow('Error updating ticket status');
    });

    it('should throw if findOne returns null after update', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({ status: 'open', user: { id: 'u1' } })
        .mockResolvedValueOnce(null);
      mockPrisma.ticket.update.mockResolvedValue(mockTicketUpdated);

      await expect(
        service.updateStatus(ticketId, { status: newStatus }),
      ).rejects.toThrow('Error updating ticket status');
    });

    it('should update ticket successfully', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({ status: 'open', user: { id: 'u1' } })
        .mockResolvedValueOnce({
          id: ticketId,
          status: newStatus,
          user: { id: 'u1' },
        });

      mockPrisma.ticket.update.mockResolvedValue(mockTicketUpdated);

      const result = await service.updateStatus(ticketId, {
        status: newStatus,
      });

      expect(result).toMatchObject({
        id: 'ticket123',
        status: 'in_progress',
      });
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: ticketId },
        data: { status: newStatus },
      });
    });

    it('should record who changed the status and the transition', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({
          status: 'open',
          type: 'support',
          user: { id: 'u1' },
        })
        .mockResolvedValueOnce({
          id: ticketId,
          status: newStatus,
          type: 'support',
          user: { id: 'u1' },
        });
      mockPrisma.ticket.update.mockResolvedValue(mockTicketUpdated);

      await service.updateStatus(
        ticketId,
        { status: newStatus },
        systemSuperAdminUser as any,
      );

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId,
          event: 'status_changed',
          actorUserId: systemSuperAdminUser.id,
          actorLabel: 'John Doe',
          oldStatus: 'open',
          newStatus,
          before: { status: 'open' },
          after: { status: newStatus },
          metadata: expect.objectContaining({
            actorRole: 'system_super_admin',
            staffTerminated: false,
          }),
        }),
      );
    });

    it('should flag in the audit when the status change terminated a staff member', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({
          status: 'open',
          type: 'termination',
          staff: { id: 'staff1' },
          user: { id: 'user1' },
        })
        .mockResolvedValueOnce(mockTicketFinal);
      mockPrisma.staff.update.mockResolvedValue({
        id: 'staff1',
        status: 'terminated',
      });
      mockPrisma.ticket.update.mockResolvedValue(mockTicketUpdated);

      await service.updateStatus(
        ticketId,
        { status: 'resolved' },
        systemAdminUser as any,
      );

      const params = mockTicketAuditService.log.mock.calls[0][0];
      expect(params.metadata.staffTerminated).toBe(true);
      expect(params.actorUserId).toBe(systemAdminUser.id);
    });

    it('should throw BadRequestException if Prisma throws error', async () => {
      // ticket encontrado normalmente
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
      });

      // mas update falha
      mockPrisma.ticket.update.mockRejectedValue(new Error('DB error'));

      await expect(
        service.updateStatus(ticketId, { status: newStatus }),
      ).rejects.toThrow('Error updating ticket status');
    });

    it('should notify status change to in_progress', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({ status: 'open', user: { id: 'u1' } })
        .mockResolvedValueOnce({ id: ticketId, status: 'in_progress' });
      mockPrisma.ticket.update.mockResolvedValue({
        id: ticketId,
        status: 'in_progress',
      });
      mockNotificationsService.notifyTicketStatusChangeToCreator.mockResolvedValue(
        undefined,
      );

      await service.updateStatus(ticketId, { status: 'in_progress' });

      expect(
        mockNotificationsService.notifyTicketStatusChangeToCreator,
      ).toHaveBeenCalledWith(expect.anything(), 'in_progress');
    });

    it('should notify ticket reopened when transitioning from closed to new', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({ status: 'closed', user: { id: 'u1' } })
        .mockResolvedValueOnce({ id: ticketId, status: 'new' });
      mockPrisma.ticket.update.mockResolvedValue({
        id: ticketId,
        status: 'new',
      });
      mockNotificationsService.notifyTicketReopened.mockResolvedValue(
        undefined,
      );

      await service.updateStatus(ticketId, { status: 'new' });

      expect(mockNotificationsService.notifyTicketReopened).toHaveBeenCalled();
    });

    it('should swallow notification errors without failing', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({ status: 'open', user: { id: 'u1' } })
        .mockResolvedValueOnce({ id: ticketId, status: 'resolved' });
      mockPrisma.ticket.update.mockResolvedValue({
        id: ticketId,
        status: 'resolved',
      });
      mockNotificationsService.notifyTicketStatusChangeToCreator.mockRejectedValue(
        new Error('mail error'),
      );

      await expect(
        service.updateStatus(ticketId, { status: 'resolved' }),
      ).resolves.toBeDefined();
    });
  });

  describe('findOne', () => {
    const ticketId = 'ticket1';
    const baseTicket = {
      id: ticketId,
      type: 'support',
      title: 'Test',
      description: 'desc',
      status: 'open',
      priority: 'HIGH',
      createdAt: new Date(),
      created_by: '1',
      organization: {
        id: 'org1',
        name: 'Org',
        email: 'o@o.com',
        business_unit: 'MedVirtual',
        status: 'active',
        admin_id: 'a1',
      },
      user: null,
      createdBy: null,
      candidate: null,
      staff: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return a ticket by id without user access check', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicket);

      const result = await service.findOne(ticketId);

      expect(result).toEqual(baseTicket);
      expect(mockPrisma.ticket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ticketId, deleted_at: null } }),
      );
    });

    it('should throw BadRequestException when ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(service.findOne(ticketId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow organization_admin to view their own ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicket,
        created_by: '1',
      });

      const result = await service.findOne(ticketId, userfake as any);

      expect(result).toBeDefined();
    });

    it('should throw ForbiddenException when organization_admin views another users ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicket,
        created_by: 'other-user',
      });

      await expect(service.findOne(ticketId, userfake as any)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow organization_super_admin to view ticket from their org', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicket,
        created_by: 'other-user',
        organization: { ...baseTicket.organization, id: 'org1' },
      });

      const result = await service.findOne(ticketId, orgSuperAdminUser as any);

      expect(result).toBeDefined();
    });

    it('should throw ForbiddenException when organization_super_admin views ticket from different org', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicket,
        created_by: 'other-user',
        organization: { ...baseTicket.organization, id: 'other-org' },
      });

      await expect(
        service.findOne(ticketId, orgSuperAdminUser as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow system admin to view any ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicket,
        created_by: 'other-user',
      });

      const result = await service.findOne(ticketId, systemAdminUser as any);

      expect(result).toBeDefined();
    });
  });

  describe('create', () => {
    const baseDto = {
      type: 'Support',
      title: 'Test Ticket',
      description: 'Test description',
      priority: 'HIGH' as Priority,
      client_id: 'org1',
      assigned_user_id: ['user1'],
    };

    const mockCreatedTicket = { id: 'ticket-new' };
    const mockFullTicket = {
      id: 'ticket-new',
      type: 'support',
      title: 'Test Ticket',
      status: 'open',
      candidate: null,
      staff: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should record who created the ticket, from where, and with what context', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org1' });
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user1' });
      mockPrisma.ticket.create.mockResolvedValue({
        id: 'ticket-new',
        status: 'new',
        type: 'support',
        title: 'Test Ticket',
        priority: 'HIGH',
        org_id: 'org1',
        user_id: 'user1',
        staff_id: null,
        candidate_id: null,
        hireRequest_id: null,
        offer_panel_id: null,
      });
      mockPrisma.ticket.findFirst.mockResolvedValue(mockFullTicket);

      await service.create(baseDto as any, systemAdminUser as any);

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: 'ticket-new',
          event: 'created',
          actorUserId: systemAdminUser.id,
          actorLabel: 'John Doe',
          metadata: expect.objectContaining({
            origin: 'ticket_endpoint',
            actorRole: 'system_admin',
            actorOrganizationId: null,
            requestedType: 'Support',
            assignedAtCreation: 'user1',
          }),
        }),
      );
    });

    it('should not store a user-authored support title in the created audit event', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org1' });
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user1' });
      mockPrisma.ticket.create.mockResolvedValue({
        id: 'ticket-new',
        status: 'new',
        type: 'support',
        title: 'Patient Jane Roe cannot log in',
        priority: 'HIGH',
        org_id: 'org1',
      });
      mockPrisma.ticket.findFirst.mockResolvedValue(mockFullTicket);

      await service.create(baseDto as any, systemAdminUser as any);

      const params = mockTicketAuditService.log.mock.calls[0][0];
      expect(params.after.title).toBeUndefined();
      expect(params.after.titleLength).toBe(
        'Patient Jane Roe cannot log in'.length,
      );
    });

    it('should throw BadRequestException when Interview Request has no candidate_id', async () => {
      await expect(
        service.create(
          { ...baseDto, type: 'Interview Request' } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when Bonus ticket has no staff_id', async () => {
      await expect(
        service.create({ ...baseDto, type: 'Bonus' } as any, userfake as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when Termination ticket has no staff_id', async () => {
      await expect(
        service.create(
          { ...baseDto, type: 'Termination' } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when hire_request_cancellation has no hireRequest_id', async () => {
      await expect(
        service.create(
          { ...baseDto, type: 'hire_request_cancellation' } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when candidate_id provided but candidate not found', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            ...baseDto,
            type: 'Interview Request',
            candidate_id: 'cand1',
          } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when staff_id provided but staff not found', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          { ...baseDto, type: 'Bonus', staff_id: 'staff1' } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when staff belongs to different org for organization user', async () => {
      mockPrisma.staff.findUnique.mockResolvedValue({
        id: 'staff1',
        hireRequest: { org_id: 'other-org' },
      });

      await expect(
        service.create(
          { ...baseDto, type: 'Bonus', staff_id: 'staff1' } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when hireRequest_id provided but hireRequest not found', async () => {
      mockPrisma.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          {
            ...baseDto,
            type: 'hire_request_cancellation',
            hireRequest_id: 'hr1',
          } as any,
          userfake as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when organization_admin user has no organization_id', async () => {
      const userNoOrg = {
        ...userfake,
        organization_id: null,
        role: 'organization_admin',
      };

      await expect(
        service.create(
          {
            type: 'Termination',
            title: 'T',
            description: 'D',
            priority: 'HIGH' as Priority,
            staff_id: 's1',
          } as any,
          userNoOrg as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when organization not found for org user', async () => {
      const orgUserDto = {
        type: 'Termination',
        title: 'T',
        description: 'D',
        priority: 'HIGH' as Priority,
        staff_id: 'staff1',
      };
      mockPrisma.staff.findUnique.mockResolvedValue({
        id: 'staff1',
        hireRequest: { org_id: 'org1' },
      });
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.create(orgUserDto as any, userfake as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when creator user not found', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.create(baseDto as any, userfake as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when assigned user not found', async () => {
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: '1' })
        .mockResolvedValueOnce(null);

      await expect(
        service.create(baseDto as any, userfake as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create Support ticket successfully for system_admin', async () => {
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'admin1' })
        .mockResolvedValueOnce({ id: 'user1' });
      mockPrisma.ticket.create.mockResolvedValue(mockCreatedTicket);
      mockPrisma.ticket.findFirst.mockResolvedValue(mockFullTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.create(
        baseDto as any,
        systemAdminUser as any,
      );

      expect(result).toEqual(mockFullTicket);
      expect(mockPrisma.ticket.create).toHaveBeenCalled();
    });

    it('should create ticket for organization_admin using org admin_id as assignee', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({
        id: 'org1',
        admin_id: 'admin1',
      });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: '1' })
        .mockResolvedValueOnce({ id: 'admin1' });
      mockPrisma.ticket.create.mockResolvedValue(mockCreatedTicket);
      mockPrisma.ticket.findFirst.mockResolvedValue(mockFullTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.create(
        {
          type: 'Termination',
          title: 'T',
          description: 'D',
          priority: 'HIGH' as Priority,
          staff_id: 's1',
        } as any,
        { ...userfake, role: 'organization_admin' } as any,
      );

      expect(result).toBeDefined();
    });

    it('should swallow notification error and still return ticket', async () => {
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'admin1' })
        .mockResolvedValueOnce({ id: 'user1' });
      mockPrisma.ticket.create.mockResolvedValue(mockCreatedTicket);
      mockPrisma.ticket.findFirst.mockResolvedValue(mockFullTicket);
      mockNotificationsService.notifyTicketEvent.mockRejectedValue(
        new Error('mail error'),
      );

      const result = await service.create(
        baseDto as any,
        systemAdminUser as any,
      );

      expect(result).toEqual(mockFullTicket);
    });
  });

  describe('findAll role branches', () => {
    const mockTickets = [{ id: '1', title: 'T', candidate: null, staff: null }];

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should apply no user filter for system_super_admin', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(
        systemSuperAdminUser as any,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const call = mockPrisma.ticket.findMany.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('created_by');
      expect(call.where).not.toHaveProperty('OR');
    });

    it('should filter by assigned or created for system_admin', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(
        systemAdminUser as any,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const call = mockPrisma.ticket.findMany.mock.calls[0][0];
      expect(call.where.OR).toBeDefined();
    });

    it('should filter by organization for organization_super_admin', async () => {
      mockPrisma.ticket.findMany.mockResolvedValue(mockTickets);

      await service.findAll(
        orgSuperAdminUser as any,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const call = mockPrisma.ticket.findMany.mock.calls[0][0];
      expect(call.where.organization).toBeDefined();
    });

    it('should map avatar_url for candidate in results', async () => {
      const ticketsWithCandidate = [
        {
          id: '1',
          title: 'T',
          candidate: { id: 'c1', avatar_url: 'avatar.png' },
          staff: null,
        },
      ];
      process.env.AVATAR_URL = 'https://cdn.example.com/';
      mockPrisma.ticket.findMany.mockResolvedValue(ticketsWithCandidate);

      const result = (await service.findAll(
        userfake as any,
        undefined,
        undefined,
        undefined,
        undefined,
      )) as any[];

      expect(result[0].candidate.avatar).toBe(
        'https://cdn.example.com/avatar.png',
      );
    });

    it('should map staff candidate avatar_url', async () => {
      const ticketsWithStaff = [
        {
          id: '1',
          title: 'T',
          candidate: null,
          staff: { id: 's1', candidate: { avatar_url: 'staff-avatar.png' } },
        },
      ];
      process.env.AVATAR_URL = 'https://cdn.example.com/';
      mockPrisma.ticket.findMany.mockResolvedValue(ticketsWithStaff);

      const result = (await service.findAll(
        userfake as any,
        undefined,
        undefined,
        undefined,
        undefined,
      )) as any[];

      expect(result[0].staff.candidate.avatar).toBe(
        'https://cdn.example.com/staff-avatar.png',
      );
    });
  });

  describe('delete', () => {
    const ticketId = 'ticket1';

    /** Builds a tx double and exposes it so assertions can inspect the calls. */
    const makeTx = (opts: { bonusIds?: string[]; noteIds?: string[] } = {}) => {
      const tx = {
        ticket: {
          update: jest.fn().mockResolvedValue({ id: ticketId }),
          delete: jest.fn().mockResolvedValue({ id: ticketId }),
        },
        bonus: {
          findMany: jest
            .fn()
            .mockResolvedValue((opts.bonusIds ?? []).map((id) => ({ id }))),
          updateMany: jest
            .fn()
            .mockResolvedValue({ count: opts.bonusIds?.length ?? 0 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        ticketNotes: {
          findMany: jest
            .fn()
            .mockResolvedValue((opts.noteIds ?? []).map((id) => ({ id }))),
          updateMany: jest
            .fn()
            .mockResolvedValue({ count: opts.noteIds?.length ?? 0 }),
        },
        ticketAuditLog: { create: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(
        async (cb: (t: any) => Promise<any>) => cb(tx),
      );
      return tx;
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException for non-system admin users', async () => {
      await expect(service.delete(ticketId, userfake as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.delete(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not find an already soft-deleted ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.delete(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.ticket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ticketId, deleted_at: null } }),
      );
    });

    it('should delete ticket successfully', async () => {
      const ticketRecord = {
        id: ticketId,
        status: 'open',
        type: 'support',
        staff_id: 'staff1',
        created_by: 'user1',
        description: 'desc',
      };
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRecord);
      makeTx();

      const result = (await service.delete(
        ticketId,
        systemAdminUser as any,
      )) as any;

      expect(result.message).toBe('Ticket deleted successfully');
      expect(result.deletedTicket.id).toBe(ticketId);
    });

    it('should soft delete rather than hard delete', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        staff_id: 'staff1',
        created_by: 'user1',
        description: 'desc',
      });
      const tx = makeTx();

      await service.delete(ticketId, systemAdminUser as any, 'wrong ticket');

      expect(tx.ticket.delete).not.toHaveBeenCalled();
      expect(tx.ticket.update).toHaveBeenCalledWith({
        where: { id: ticketId },
        data: expect.objectContaining({
          deleted_at: expect.any(Date),
          deleted_by: systemAdminUser.id,
          deletion_reason: 'wrong ticket',
        }),
      });
    });

    it('should soft delete the associated bonuses and notes', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'bonus',
        staff_id: 'staff1',
        created_by: 'user1',
        description: 'desc',
      });
      const tx = makeTx({ bonusIds: ['b1', 'b2'], noteIds: ['n1'] });

      const result = (await service.delete(
        ticketId,
        systemAdminUser as any,
      )) as any;

      expect(tx.bonus.deleteMany).not.toHaveBeenCalled();
      expect(tx.bonus.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['b1', 'b2'] } },
        data: { deleted_at: expect.any(Date) },
      });
      expect(tx.ticketNotes.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['n1'] } },
        data: { deleted_at: expect.any(Date) },
      });
      expect(result.bonusesDeleted).toBe(2);
      expect(result.notesDeleted).toBe(1);
    });

    it('should capture the affected ids into the audit metadata', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'bonus',
        staff_id: 'staff1',
        created_by: 'user1',
        description: 'desc',
      });
      const tx = makeTx({ bonusIds: ['b1'], noteIds: ['n1', 'n2'] });

      await service.delete(ticketId, systemAdminUser as any);

      expect(mockTicketAuditService.logOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'deleted',
          ticketId,
          actorUserId: systemAdminUser.id,
          metadata: expect.objectContaining({
            actorRole: 'system_admin',
            bonusIds: ['b1'],
            noteIds: ['n1', 'n2'],
          }),
        }),
        tx,
      );
    });

    it('should exclude a user-authored support title from the audit snapshot', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        title: 'Patient John needs help',
        staff_id: null,
        created_by: 'user1',
        description: null,
      });
      makeTx();

      await service.delete(ticketId, systemAdminUser as any);

      const params = mockTicketAuditService.logOrThrow.mock.calls[0][0];
      expect(params.before.title).toBeUndefined();
      expect(params.before.titleLength).toBe('Patient John needs help'.length);
    });

    it('should keep a system-generated title in the audit snapshot', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'bonus',
        title: 'Bonus Added: $100',
        staff_id: 's1',
        created_by: 'user1',
        description: null,
      });
      makeTx();

      await service.delete(ticketId, systemAdminUser as any);

      const params = mockTicketAuditService.logOrThrow.mock.calls[0][0];
      expect(params.before.title).toBe('Bonus Added: $100');
    });

    it('should skip the bonus lookup when the ticket has no staff_id', async () => {
      // Talent-pool/support tickets have no staff. Passing a null staff_id into the query
      // makes Prisma throw "Argument `staff_id` must not be null".
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'new',
        type: 'talent_pool',
        staff_id: null,
        created_by: 'user1',
        description: 'Talent Pool Lead Information',
      });
      const tx = makeTx();

      const result = (await service.delete(
        ticketId,
        systemAdminUser as any,
      )) as any;

      expect(tx.bonus.findMany).not.toHaveBeenCalled();
      expect(tx.bonus.updateMany).not.toHaveBeenCalled();
      expect(result.bonusesDeleted).toBe(0);
      expect(result.message).toBe('Ticket deleted successfully');
    });

    it('should skip the bonus lookup when the ticket has no created_by', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'new',
        type: 'offer_panel',
        staff_id: 'staff1',
        created_by: null,
        description: null,
      });
      const tx = makeTx();

      const result = (await service.delete(
        ticketId,
        systemAdminUser as any,
      )) as any;

      expect(tx.bonus.findMany).not.toHaveBeenCalled();
      expect(result.bonusesDeleted).toBe(0);
    });

    it('should look up bonuses without a description filter when description is null', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'new',
        type: 'bonus',
        staff_id: 'staff1',
        created_by: 'user1',
        description: null,
      });
      const tx = makeTx({ bonusIds: ['b1'] });

      await service.delete(ticketId, systemAdminUser as any);

      expect(tx.bonus.findMany).toHaveBeenCalledWith({
        where: { staff_id: 'staff1', created_by: 'user1', deleted_at: null },
        select: { id: true },
      });
    });

    it('should reject the delete when the audit write fails', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        staff_id: null,
        created_by: 'user1',
        description: null,
      });
      makeTx();
      mockTicketAuditService.logOrThrow.mockRejectedValueOnce(
        new Error('audit down'),
      );

      await expect(
        service.delete(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when prisma delete fails', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        staff_id: null,
        created_by: 'user1',
        description: null,
      });
      mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));

      await expect(
        service.delete(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow system_super_admin to delete', async () => {
      const ticketRecord = {
        id: ticketId,
        status: 'open',
        type: 'support',
        staff_id: null,
        created_by: 'user1',
        description: null,
      };
      mockPrisma.ticket.findFirst.mockResolvedValue(ticketRecord);
      makeTx();

      const result = (await service.delete(
        ticketId,
        systemSuperAdminUser as any,
      )) as any;

      expect(result.message).toBe('Ticket deleted successfully');
    });
  });

  describe('restore', () => {
    const ticketId = 'ticket1';

    const makeTx = () => {
      const tx = {
        ticket: { update: jest.fn().mockResolvedValue({ id: ticketId }) },
        bonus: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        ticketNotes: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        ticketAuditLog: { create: jest.fn().mockResolvedValue({}) },
      };
      mockPrisma.$transaction.mockImplementation(
        async (cb: (t: any) => Promise<any>) => cb(tx),
      );
      return tx;
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException for non-system admin users', async () => {
      await expect(service.restore(ticketId, userfake as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when the ticket is not deleted', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.restore(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.ticket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ticketId, deleted_at: { not: null } },
        }),
      );
    });

    it('should clear all three soft delete columns', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        deleted_at: new Date(),
        deleted_by: 'admin1',
        deletion_reason: 'oops',
      });
      mockTicketAuditService.findLastDeletedEvent.mockResolvedValue({
        id: 'log1',
        metadata: {},
      });
      const tx = makeTx();

      await service.restore(ticketId, systemAdminUser as any);

      expect(tx.ticket.update).toHaveBeenCalledWith({
        where: { id: ticketId },
        data: { deleted_at: null, deleted_by: null, deletion_reason: null },
      });
    });

    it('should restore exactly the ids recorded by the delete event', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'bonus',
        deleted_at: new Date(),
        deleted_by: 'admin1',
        deletion_reason: null,
      });
      mockTicketAuditService.findLastDeletedEvent.mockResolvedValue({
        id: 'log1',
        metadata: { bonusIds: ['b1'], noteIds: ['n1', 'n2'] },
      });
      const tx = makeTx();

      const result = (await service.restore(
        ticketId,
        systemAdminUser as any,
      )) as any;

      expect(tx.bonus.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['b1'] } },
        data: { deleted_at: null },
      });
      expect(tx.ticketNotes.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['n1', 'n2'] } },
        data: { deleted_at: null },
      });
      expect(result.bonusesRestored).toBe(1);
      expect(result.notesRestored).toBe(2);
    });

    it('should not touch bonuses or notes when the delete event has no manifest', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        deleted_at: new Date(),
        deleted_by: 'admin1',
        deletion_reason: null,
      });
      mockTicketAuditService.findLastDeletedEvent.mockResolvedValue(null);
      const tx = makeTx();

      await service.restore(ticketId, systemAdminUser as any);

      expect(tx.bonus.updateMany).not.toHaveBeenCalled();
      expect(tx.ticketNotes.updateMany).not.toHaveBeenCalled();
      const params = mockTicketAuditService.logOrThrow.mock.calls[0][0];
      expect(params.metadata.idsUnavailable).toBe(true);
    });

    it('should write a restored audit event inside the transaction', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        deleted_at: new Date(),
        deleted_by: 'admin1',
        deletion_reason: 'oops',
      });
      mockTicketAuditService.findLastDeletedEvent.mockResolvedValue({
        id: 'log1',
        metadata: {},
      });
      const tx = makeTx();

      await service.restore(ticketId, systemAdminUser as any, 'false positive');

      expect(mockTicketAuditService.logOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'restored',
          ticketId,
          reason: 'false positive',
        }),
        tx,
      );
    });

    it('should reject when the audit write fails', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        deleted_at: new Date(),
        deleted_by: 'admin1',
        deletion_reason: null,
      });
      mockTicketAuditService.findLastDeletedEvent.mockResolvedValue({
        id: 'log1',
        metadata: {},
      });
      makeTx();
      mockTicketAuditService.logOrThrow.mockRejectedValueOnce(
        new Error('audit down'),
      );

      await expect(
        service.restore(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow system_super_admin to restore', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: 'open',
        type: 'support',
        deleted_at: new Date(),
        deleted_by: 'admin1',
        deletion_reason: null,
      });
      mockTicketAuditService.findLastDeletedEvent.mockResolvedValue({
        id: 'log1',
        metadata: {},
      });
      makeTx();

      const result = (await service.restore(
        ticketId,
        systemSuperAdminUser as any,
      )) as any;

      expect(result.message).toBe('Ticket restored successfully');
    });
  });

  describe('update', () => {
    const ticketId = 'ticket1';
    const baseTicketRecord = {
      id: ticketId,
      created_by: '1',
      organization: { id: 'org1' },
    };
    const updatedTicket = {
      id: ticketId,
      title: 'Updated',
      status: 'open',
      candidate: null,
      staff: null,
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should record who updated the ticket and the previous values of changed fields', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({
          ...baseTicketRecord,
          type: 'bonus',
          title: 'Bonus Added: $100',
          priority: 'low',
          org_id: 'org1',
          user_id: 'u1',
        })
        .mockResolvedValueOnce(updatedTicket);
      mockPrisma.ticket.update.mockResolvedValue(updatedTicket);

      await service.update(
        ticketId,
        { priority: 'high' as Priority },
        systemAdminUser as any,
      );

      expect(mockTicketAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId,
          event: 'updated',
          actorUserId: systemAdminUser.id,
          before: { priority: 'low' },
          after: { priority: 'high' },
          metadata: expect.objectContaining({
            actorRole: 'system_admin',
            changedFields: ['priority'],
          }),
        }),
      );
    });

    it('should throw when ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.update(
          ticketId,
          { title: 'New Title' },
          systemAdminUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException when organization_admin updates ticket they did not create', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce({
        ...baseTicketRecord,
        created_by: 'other-user',
      });

      await expect(
        service.update(ticketId, { title: 'New' }, userfake as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when organization_super_admin updates ticket from different org', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce({
        ...baseTicketRecord,
        created_by: 'other-user',
        organization: { id: 'other-org' },
      });

      await expect(
        service.update(ticketId, { title: 'New' }, orgSuperAdminUser as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return findOne result when no updatable fields provided by system_admin', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce(baseTicketRecord)
        .mockResolvedValueOnce(updatedTicket);

      const result = await service.update(ticketId, {}, systemAdminUser as any);

      expect(result).toEqual(updatedTicket);
      expect(mockPrisma.ticket.update).not.toHaveBeenCalled();
    });

    it('should update title and description for organization_admin', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce(baseTicketRecord)
        .mockResolvedValueOnce(updatedTicket);
      mockPrisma.ticket.update.mockResolvedValue(updatedTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.update(
        ticketId,
        { title: 'New Title', description: 'New Desc' },
        userfake as any,
      );

      expect(result).toEqual(updatedTicket);
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'New Title',
            description: 'New Desc',
          }),
        }),
      );
    });

    it('should throw BadRequestException for invalid ticket type when system_admin updates', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce(baseTicketRecord);

      await expect(
        service.update(
          ticketId,
          { type: 'invalid_type' },
          systemAdminUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when org not found during system_admin update with client_id', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce(baseTicketRecord);
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.update(
          ticketId,
          { client_id: 'bad-org' },
          systemAdminUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when assigned user not found during system_admin update', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValueOnce(baseTicketRecord);
      mockPrisma.uSER.findUnique.mockResolvedValue(null);

      await expect(
        service.update(
          ticketId,
          { assigned_user_id: 'bad-user' },
          systemAdminUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update type, client_id, and assigned_user_id for system_admin', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce(baseTicketRecord)
        .mockResolvedValueOnce(updatedTicket);
      mockPrisma.organization.findUnique.mockResolvedValue({ id: 'org2' });
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'user2' });
      mockPrisma.ticket.update.mockResolvedValue(updatedTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.update(
        ticketId,
        { type: 'Support', client_id: 'org2', assigned_user_id: 'user2' },
        systemAdminUser as any,
      );

      expect(result).toEqual(updatedTicket);
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'support',
            organization: { connect: { id: 'org2' } },
            user: { connect: { id: 'user2' } },
          }),
        }),
      );
    });

    it('should swallow notification error and still return updated ticket', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce(baseTicketRecord)
        .mockResolvedValueOnce(updatedTicket);
      mockPrisma.ticket.update.mockResolvedValue(updatedTicket);
      mockNotificationsService.notifyTicketEvent.mockRejectedValue(
        new Error('mail error'),
      );

      const result = await service.update(
        ticketId,
        { title: 'X' },
        userfake as any,
      );

      expect(result).toEqual(updatedTicket);
    });

    it('should allow organization_super_admin to update their own orgs ticket', async () => {
      mockPrisma.ticket.findFirst
        .mockResolvedValueOnce({
          ...baseTicketRecord,
          created_by: 'other',
          organization: { id: 'org1' },
        })
        .mockResolvedValueOnce(updatedTicket);
      mockPrisma.ticket.update.mockResolvedValue(updatedTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.update(
        ticketId,
        { title: 'New' },
        orgSuperAdminUser as any,
      );

      expect(result).toEqual(updatedTicket);
    });
  });

  describe('addNote', () => {
    const ticketId = 'ticket1';
    const noteDto = { content: 'A note', is_internal: false };
    const baseTicketRecord = {
      id: ticketId,
      created_by: '1',
      organization: { id: 'org1' },
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException when ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.addNote(ticketId, noteDto, userfake as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException when organization_admin adds note to someone elses ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicketRecord,
        created_by: 'other-user',
      });

      await expect(
        service.addNote(ticketId, noteDto, userfake as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when organization_super_admin adds note to ticket from other org', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicketRecord,
        created_by: 'other-user',
        organization: { id: 'other-org' },
      });

      await expect(
        service.addNote(ticketId, noteDto, orgSuperAdminUser as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when non-system-admin tries to create internal note', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);

      await expect(
        service.addNote(
          ticketId,
          { content: 'internal', is_internal: true },
          userfake as any,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create note using ticketNotes.create when available (non-creator notifies creator)', async () => {
      // Ticket created by 'other-creator'; note added by systemAdminUser whose id is 'admin1'
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicketRecord,
        created_by: 'other-creator',
      });
      const mockNote = {
        id: 'note1',
        content: noteDto.content,
        is_internal: false,
        USER: {
          id: 'admin1',
          first_name: 'Admin',
          last_name: 'User',
          email: 'admin@test.com',
          role: 'system_admin',
        },
      };
      (mockPrisma as any).ticketNotes = {
        create: jest.fn().mockResolvedValue(mockNote),
      };
      mockNotificationsService.notifyTicketNoteAddedToCreator.mockResolvedValue(
        undefined,
      );

      const result = await service.addNote(
        ticketId,
        noteDto,
        systemAdminUser as any,
      );

      expect(result).toEqual(mockNote);
      expect(
        mockNotificationsService.notifyTicketNoteAddedToCreator,
      ).toHaveBeenCalledWith(
        ticketId,
        expect.objectContaining({ content: noteDto.content }),
      );
    });

    it('should notify assignee when creator adds a note', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      const mockNote = {
        id: 'note1',
        content: noteDto.content,
        is_internal: false,
        USER: {
          id: '1',
          first_name: 'John',
          last_name: 'Doe',
          email: 'test@test.com',
          role: 'organization_admin',
        },
      };
      (mockPrisma as any).ticketNotes = {
        create: jest.fn().mockResolvedValue(mockNote),
      };
      mockNotificationsService.notifyTicketNoteAddedToAssignee.mockResolvedValue(
        undefined,
      );

      await service.addNote(ticketId, noteDto, userfake as any);

      expect(
        mockNotificationsService.notifyTicketNoteAddedToAssignee,
      ).toHaveBeenCalledWith(
        ticketId,
        expect.objectContaining({ content: noteDto.content }),
      );
    });

    it('should allow system_admin to create internal note', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      const mockNote = {
        id: 'note1',
        content: 'internal',
        is_internal: true,
        USER: {
          id: 'admin1',
          first_name: 'Admin',
          last_name: 'User',
          email: 'admin@test.com',
          role: 'system_admin',
        },
      };
      (mockPrisma as any).ticketNotes = {
        create: jest.fn().mockResolvedValue(mockNote),
      };

      const result = await service.addNote(
        ticketId,
        { content: 'internal', is_internal: true },
        systemAdminUser as any,
      );

      expect(result).toEqual(mockNote);
    });

    it('should swallow notification errors and still return note', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      const mockNote = {
        id: 'note1',
        content: 'A note',
        is_internal: false,
        USER: {
          id: '1',
          first_name: 'J',
          last_name: 'D',
          email: 'e@e.com',
          role: 'org',
        },
      };
      (mockPrisma as any).ticketNotes = {
        create: jest.fn().mockResolvedValue(mockNote),
      };
      mockNotificationsService.notifyTicketNoteAddedToAssignee.mockRejectedValue(
        new Error('err'),
      );

      const result = await service.addNote(ticketId, noteDto, userfake as any);

      expect(result).toEqual(mockNote);
    });

    it('should use $executeRawUnsafe fallback when ticketNotes model not available', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      delete (mockPrisma as any).ticketNotes;
      mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        {
          id: 'note1',
          content: 'A note',
          is_internal: false,
          ticket_id: ticketId,
          user_id: '1',
          first_name: 'John',
          last_name: 'Doe',
          email: 'test@test.com',
          role: 'organization_admin',
        },
      ]);
      mockNotificationsService.notifyTicketNoteAddedToAssignee.mockResolvedValue(
        undefined,
      );

      const result = await service.addNote(ticketId, noteDto, userfake as any);

      expect(result).toBeDefined();
      expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();
    });
  });

  describe('soft delete filtering', () => {
    const ticketId = 'ticket1';

    beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.ticket.findMany.mockResolvedValue([]);
    });

    it('should exclude deleted tickets from findAll by default', async () => {
      await service.findAll(systemSuperAdminUser as any);

      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where.deleted_at).toBeNull();
    });

    it('should list only tombstones when a super admin asks for deleted', async () => {
      await service.findAll(
        systemSuperAdminUser as any,
        undefined,
        undefined,
        undefined,
        undefined,
        'deleted',
      );

      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where.deleted_at).toEqual({ not: null });
    });

    it('should ignore deleted_status for a system_admin', async () => {
      await service.findAll(
        systemAdminUser as any,
        undefined,
        undefined,
        undefined,
        undefined,
        'deleted',
      );

      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where.deleted_at).toBeNull();
    });

    it('should ignore deleted_status for organization roles', async () => {
      await service.findAll(
        orgSuperAdminUser as any,
        undefined,
        undefined,
        undefined,
        undefined,
        'deleted',
      );

      const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
      expect(where.deleted_at).toBeNull();
    });

    it('should refuse to add a note to a deleted ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.addNote(ticketId, { content: 'hi' }, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.ticket.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ticketId, deleted_at: null } }),
      );
    });

    it('should refuse to list notes of a deleted ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.listNotes(ticketId, systemAdminUser as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should filter deleted notes on the raw SQL fallback path', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        created_by: '1',
        organization: { id: 'org1' },
      });
      const prismaAny = mockPrisma as any;
      const savedTicketNotes = prismaAny.ticketNotes;
      // Force the raw-SQL branch, which the service reaches when the delegate is absent.
      delete prismaAny.ticketNotes;
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      try {
        await service.listNotes(ticketId, systemAdminUser as any);

        const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0] as string;
        expect(sql).toContain('tn.deleted_at IS NULL');
      } finally {
        prismaAny.ticketNotes = savedTicketNotes;
      }
    });
  });

  describe('listNotes', () => {
    const ticketId = 'ticket1';
    const baseTicketRecord = {
      id: ticketId,
      created_by: '1',
      organization: { id: 'org1' },
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException when ticket not found', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.listNotes(ticketId, userfake as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException when organization_admin lists notes for others ticket', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicketRecord,
        created_by: 'other',
      });

      await expect(
        service.listNotes(ticketId, userfake as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when organization_super_admin accesses other orgs ticket notes', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        ...baseTicketRecord,
        created_by: 'other',
        organization: { id: 'other-org' },
      });

      await expect(
        service.listNotes(ticketId, orgSuperAdminUser as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return notes using ticketNotes.findMany for system admin (can see internal)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      const mockNotes = [
        {
          id: 'n1',
          content: 'public',
          is_internal: false,
          USER: {
            id: '1',
            first_name: 'John',
            last_name: 'Doe',
            email: 'e@e.com',
            role: 'system_admin',
          },
        },
        {
          id: 'n2',
          content: 'private',
          is_internal: true,
          USER: {
            id: '1',
            first_name: 'John',
            last_name: 'Doe',
            email: 'e@e.com',
            role: 'system_admin',
          },
        },
      ];
      (mockPrisma as any).ticketNotes = {
        findMany: jest.fn().mockResolvedValue(mockNotes),
      };

      const result = await service.listNotes(ticketId, systemAdminUser as any);

      expect(result).toHaveLength(2);
      expect(result[0].author_name).toBe('John Doe');
      expect(result[0].author_role).toBe('system_admin');
    });

    it('should filter internal notes for non-system-admin using ticketNotes.findMany', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      const mockNotes = [
        {
          id: 'n1',
          content: 'public',
          is_internal: false,
          USER: {
            id: '1',
            first_name: 'Jane',
            last_name: 'Doe',
            email: 'j@j.com',
            role: 'org',
          },
        },
      ];
      (mockPrisma as any).ticketNotes = {
        findMany: jest.fn().mockResolvedValue(mockNotes),
      };

      const result = await service.listNotes(ticketId, userfake as any);

      expect(result).toHaveLength(1);
      const findManyCall = (mockPrisma as any).ticketNotes.findMany.mock
        .calls[0][0];
      expect(findManyCall.where).toEqual(
        expect.objectContaining({ is_internal: false, deleted_at: null }),
      );
    });

    it('should use $queryRawUnsafe fallback when ticketNotes model not available', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(baseTicketRecord);
      delete (mockPrisma as any).ticketNotes;
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        {
          id: 'n1',
          content: 'public',
          is_internal: false,
          ticket_id: ticketId,
          user_id: '1',
          first_name: 'John',
          last_name: 'Doe',
          email: 'test@test.com',
          role: 'organization_admin',
        },
      ]);

      const result = await service.listNotes(ticketId, userfake as any);

      expect(result).toHaveLength(1);
      expect(result[0].author_name).toBe('John Doe');
    });
  });

  describe('create — additional branches', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should build data with candidate_id when creating Interview Request ticket', async () => {
      const candidateId = 'cand1';
      mockPrisma.candidate.findUnique.mockResolvedValue({ id: candidateId });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'admin1' })
        .mockResolvedValueOnce({ id: 'user1' });
      const createdTicket = { id: 'new-ticket' };
      const fullTicket = {
        id: 'new-ticket',
        type: 'interview',
        candidate: { id: candidateId },
      };
      mockPrisma.ticket.create.mockResolvedValue(createdTicket);
      mockPrisma.ticket.findFirst.mockResolvedValue(fullTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.create(
        {
          type: 'Interview Request',
          candidate_id: candidateId,
          title: 'T',
          description: 'D',
          priority: 'HIGH' as Priority,
          client_id: 'org1',
          assigned_user_id: ['user1'],
        } as any,
        systemAdminUser as any,
      );

      expect(result).toEqual({
        ...fullTicket,
        candidate: { id: candidateId, avatar: null },
        staff: null,
      });
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            candidate: { connect: { id: candidateId } },
          }),
        }),
      );
    });

    it('should build data with staff_id and hireRequest_id for Termination ticket by system admin', async () => {
      const staffId = 'staff1';
      const hrId = 'hr1';
      mockPrisma.staff.findUnique.mockResolvedValue({
        id: staffId,
        hireRequest: { org_id: 'org1' },
      });
      mockPrisma.hireRequest.findUnique.mockResolvedValue({ id: hrId });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'admin1' })
        .mockResolvedValueOnce({ id: 'user1' });
      const createdTicket = { id: 'new-ticket2' };
      const fullTicket = { id: 'new-ticket2', type: 'termination' };
      mockPrisma.ticket.create.mockResolvedValue(createdTicket);
      mockPrisma.ticket.findFirst.mockResolvedValue(fullTicket);
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.create(
        {
          type: 'Termination',
          staff_id: staffId,
          hireRequest_id: hrId,
          title: 'T',
          description: 'D',
          priority: 'HIGH' as Priority,
          client_id: 'org1',
          assigned_user_id: ['user1'],
        } as any,
        systemAdminUser as any,
      );

      expect(result).toEqual({ ...fullTicket, candidate: null, staff: null });
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            staff: { connect: { id: staffId } },
            hireRequest: { connect: { id: hrId } },
          }),
        }),
      );
    });

    it('should throw when findOne returns null after ticket.create', async () => {
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'admin1' })
        .mockResolvedValueOnce({ id: 'user1' });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'new' });
      // findOne calls ticket.findUnique — return null to trigger !ticketFull path
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.create(
          {
            type: 'Support',
            title: 'T',
            description: 'D',
            priority: 'HIGH' as Priority,
            client_id: 'org1',
            assigned_user_id: ['user1'],
          } as any,
          systemAdminUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should use assigned_user_id directly when system admin uses non-Support ticket type', async () => {
      // system admin (non-org role) + non-Support type => goes to the else branch (lines 228-229)
      const staffId = 'staff1';
      mockPrisma.staff.findUnique.mockResolvedValue({
        id: staffId,
        hireRequest: { org_id: 'org1' },
      });
      mockPrisma.uSER.findUnique
        .mockResolvedValueOnce({ id: 'admin1' })
        .mockResolvedValueOnce({ id: 'user1' });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'new3' });
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: 'new3',
        type: 'termination',
      });
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.create(
        {
          type: 'Termination',
          staff_id: staffId,
          title: 'T',
          description: 'D',
          priority: 'HIGH' as Priority,
          client_id: 'org1',
          assigned_user_id: ['user1'],
        } as any,
        systemAdminUser as any,
      );

      expect(result).toBeDefined();
    });
  });

  describe('isSystemAdmin (via create context)', () => {
    it('should recognise system_admin role as system admin', async () => {
      mockPrisma.uSER.findUnique.mockResolvedValue({ id: 'admin1' });
      mockPrisma.ticket.create.mockResolvedValue({ id: 'new' });
      mockPrisma.ticket.findFirst.mockResolvedValue({ id: 'new', title: 'T' });
      mockNotificationsService.notifyTicketEvent.mockResolvedValue(undefined);

      const result = await service.create(
        {
          type: 'Support',
          title: 'T',
          description: 'D',
          priority: 'HIGH' as Priority,
          client_id: 'org1',
        } as any,
        systemAdminUser as any,
      );

      expect(result).toBeDefined();
    });
  });
});
