import { Test, TestingModule } from '@nestjs/testing';
import { TicketAuditSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TicketAuditService,
  TICKET_AUDIT_EVENTS,
  buildActorLabel,
} from './ticket-audit.service';

describe('TicketAuditService', () => {
  let service: TicketAuditService;

  const mockPrisma = {
    ticketAuditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketAuditService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TicketAuditService>(TicketAuditService);
    jest.clearAllMocks();
  });

  const baseParams = {
    ticketId: 'ticket-1',
    actorUserId: 'user-1',
    actorLabel: 'John Doe',
    event: TICKET_AUDIT_EVENTS.UPDATED,
  };

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('log', () => {
    it('should write the audit row with defaults applied', async () => {
      mockPrisma.ticketAuditLog.create.mockResolvedValue({ id: 'log-1' });

      await service.log(baseParams);

      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ticket_id: 'ticket-1',
          actor_user_id: 'user-1',
          actor_label: 'John Doe',
          event: 'updated',
          source: TicketAuditSource.user,
          old_status: null,
          new_status: null,
          reason: null,
        }),
      });
    });

    it('should pass json blobs as undefined when absent so the column stays absent', async () => {
      mockPrisma.ticketAuditLog.create.mockResolvedValue({ id: 'log-1' });

      await service.log(baseParams);

      const data = mockPrisma.ticketAuditLog.create.mock.calls[0][0].data;
      expect(data.before).toBeUndefined();
      expect(data.after).toBeUndefined();
      expect(data.metadata).toBeUndefined();
    });

    it('should swallow prisma errors so a failed audit never breaks the operation', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockPrisma.ticketAuditLog.create.mockRejectedValue(new Error('DB down'));

      await expect(service.log(baseParams)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  describe('logOrThrow', () => {
    it('should propagate prisma errors', async () => {
      mockPrisma.ticketAuditLog.create.mockRejectedValue(new Error('DB down'));

      await expect(
        service.logOrThrow({
          ...baseParams,
          event: TICKET_AUDIT_EVENTS.DELETED,
        }),
      ).rejects.toThrow('DB down');
    });

    it('should use the transaction client when one is provided', async () => {
      const tx = {
        ticketAuditLog: { create: jest.fn().mockResolvedValue({}) },
      };

      await service.logOrThrow(
        { ...baseParams, event: TICKET_AUDIT_EVENTS.DELETED },
        tx as any,
      );

      expect(tx.ticketAuditLog.create).toHaveBeenCalled();
      expect(mockPrisma.ticketAuditLog.create).not.toHaveBeenCalled();
    });

    it('should fall back to the base client when no transaction is provided', async () => {
      mockPrisma.ticketAuditLog.create.mockResolvedValue({});

      await service.logOrThrow({
        ...baseParams,
        event: TICKET_AUDIT_EVENTS.RESTORED,
      });

      expect(mockPrisma.ticketAuditLog.create).toHaveBeenCalled();
    });
  });

  describe('findAllLogs', () => {
    beforeEach(() => {
      mockPrisma.ticketAuditLog.count.mockResolvedValue(45);
      mockPrisma.ticketAuditLog.findMany.mockResolvedValue([]);
    });

    it('should compute skip/take and totalPages', async () => {
      const result = await service.findAllLogs({ page: 3, limit: 20 });

      expect(mockPrisma.ticketAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
      expect(result.meta).toEqual({
        total: 45,
        page: 3,
        limit: 20,
        totalPages: 3,
      });
    });

    it('should default to page 1 / limit 20', async () => {
      await service.findAllLogs({});

      expect(mockPrisma.ticketAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('should widen date_to to the end of the day', async () => {
      await service.findAllLogs({ date_to: '2024-12-31' });

      const where = mockPrisma.ticketAuditLog.findMany.mock.calls[0][0].where;
      const lte = where.createdAt.lte as Date;
      expect(lte.getHours()).toBe(23);
      expect(lte.getMinutes()).toBe(59);
      expect(lte.getSeconds()).toBe(59);
    });

    it('should build a search OR across ticket_id, actor_label and reason', async () => {
      await service.findAllLogs({ search: 'abc' });

      const where = mockPrisma.ticketAuditLog.findMany.mock.calls[0][0].where;
      expect(where.OR).toHaveLength(3);
    });

    it('should apply scalar filters when provided', async () => {
      await service.findAllLogs({
        ticket_id: 't1',
        event: 'deleted',
        source: TicketAuditSource.user,
        actor_user_id: 'u1',
      });

      const where = mockPrisma.ticketAuditLog.findMany.mock.calls[0][0].where;
      expect(where).toEqual(
        expect.objectContaining({
          ticket_id: 't1',
          event: 'deleted',
          source: TicketAuditSource.user,
          actor_user_id: 'u1',
        }),
      );
    });
  });

  describe('findByTicket', () => {
    it('should return the timeline ordered oldest first', async () => {
      mockPrisma.ticketAuditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);

      const result = await service.findByTicket('ticket-1');

      expect(mockPrisma.ticketAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticket_id: 'ticket-1' },
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(result).toEqual([{ id: 'log-1' }]);
    });
  });

  describe('findLastDeletedEvent', () => {
    it('should read the most recent deleted event', async () => {
      mockPrisma.ticketAuditLog.findFirst.mockResolvedValue({
        id: 'log-9',
        metadata: { bonusIds: ['b1'] },
      });

      const result = await service.findLastDeletedEvent('ticket-1');

      expect(mockPrisma.ticketAuditLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ticket_id: 'ticket-1', event: 'deleted' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result?.metadata).toEqual({ bonusIds: ['b1'] });
    });
  });

  describe('buildActorLabel', () => {
    it('should join first and last name', () => {
      expect(
        buildActorLabel({
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@x.com',
        } as any),
      ).toBe('Ada Lovelace');
    });

    it('should fall back to email when names are empty', () => {
      expect(
        buildActorLabel({
          first_name: '',
          last_name: '',
          email: 'ada@x.com',
        } as any),
      ).toBe('ada@x.com');
    });

    it('should return null when there is no user', () => {
      expect(buildActorLabel(null)).toBeNull();
    });
  });
});
