import { Test, TestingModule } from '@nestjs/testing';
import { UserAuditSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  UserAuditService,
  auditActor,
  diffUser,
  pickTrackedFields,
  snapshotUser,
} from './user-audit.service';

describe('UserAuditService', () => {
  let service: UserAuditService;
  let prismaMock: {
    userAuditLog: Record<string, jest.Mock>;
  };

  beforeEach(async () => {
    prismaMock = {
      userAuditLog: {
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserAuditService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = module.get(UserAuditService);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const subject = {
    id: 'u-1',
    email: 'jane@clinic.com',
    first_name: 'Jane',
    last_name: 'Doe',
    role: 'organization_admin',
    organization_id: 'org-1',
    organization_name: 'Clinic',
  };

  describe('helpers', () => {
    it('pickTrackedFields never copies secrets', () => {
      const picked = pickTrackedFields({
        email: 'a@b.com',
        password: 'hash',
        billcom_session_id: 'secret',
        workos_id: 'w',
      } as never);
      expect(picked).toEqual({ email: 'a@b.com' });
    });

    it('snapshotUser serializes dates and keeps creation provenance', () => {
      const snap = snapshotUser({
        id: 'u-1',
        email: 'a@b.com',
        status: 'invited',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        createdByMethod: 'admin_invite',
        createdByUserId: 'admin-1',
      });
      expect(snap).toEqual({
        id: 'u-1',
        email: 'a@b.com',
        status: 'invited',
        createdAt: '2026-01-01T00:00:00.000Z',
        createdByMethod: 'admin_invite',
        createdByUserId: 'admin-1',
      });
    });

    it('diffUser only reports fields present on `after` that changed', () => {
      expect(
        diffUser(
          { first_name: 'Jane', role: 'organization_admin', phone: '1' },
          { first_name: 'Jane', role: 'organization_super_admin' },
        ),
      ).toEqual(['role']);
    });

    it('auditActor builds id + label', () => {
      expect(
        auditActor({
          id: 'a-1',
          first_name: 'Ann',
          last_name: 'Lee',
          email: 'x',
        }),
      ).toEqual({ actorUserId: 'a-1', actorLabel: 'Ann Lee' });
      expect(auditActor(null)).toEqual({ actorUserId: null, actorLabel: null });
    });
  });

  describe('log', () => {
    it('writes denormalized subject fields', async () => {
      await service.log({
        subject,
        event: 'invited',
        source: UserAuditSource.admin,
      });
      expect(prismaMock.userAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          subject_user_id: 'u-1',
          subject_email: 'jane@clinic.com',
          subject_label: 'Jane Doe',
          subject_role: 'organization_admin',
          organization_name: 'Clinic',
          event: 'invited',
          source: 'admin',
        }),
      });
    });

    it('swallows write failures', async () => {
      prismaMock.userAuditLog.create.mockRejectedValue(new Error('down'));
      await expect(
        service.log({ subject, event: 'logout' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('logOrThrow', () => {
    it('propagates failures and uses the transaction client', async () => {
      const tx = {
        userAuditLog: {
          create: jest.fn().mockRejectedValue(new Error('down')),
        },
      };
      await expect(
        service.logOrThrow({ subject, event: 'deleted' }, tx as never),
      ).rejects.toThrow('down');
      expect(prismaMock.userAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('buildUpdateEntries', () => {
    it('splits an update into one entry per concern', () => {
      const entries = service.buildUpdateEntries({
        before: { ...subject, status: 'active', phone: '1' },
        after: {
          role: 'organization_super_admin',
          status: 'inactive',
          phone: '2',
        },
        source: UserAuditSource.admin,
      });
      expect(entries.map((e) => e.event)).toEqual([
        'role_changed',
        'deactivated',
        'profile_updated',
      ]);
      const status = entries.find((e) => e.event === 'deactivated');
      expect(status).toMatchObject({
        oldStatus: 'active',
        newStatus: 'inactive',
        before: { status: 'active' },
        after: { status: 'inactive' },
      });
      // subject reflects the post-update state
      expect(entries[0].subject.role).toBe('organization_super_admin');
    });

    it('classifies inactive → active as reactivated', () => {
      const [entry] = service.buildUpdateEntries({
        before: { ...subject, status: 'inactive' },
        after: { status: 'active' },
      });
      expect(entry.event).toBe('reactivated');
    });

    it('returns nothing when no tracked field changed', () => {
      expect(
        service.buildUpdateEntries({
          before: { ...subject },
          after: { first_name: 'Jane' },
        }),
      ).toEqual([]);
    });
  });

  describe('logBulkUpdate', () => {
    it('writes one row per affected user', async () => {
      await service.logBulkUpdate(
        [
          { ...subject, status: 'active' },
          { ...subject, id: 'u-2', email: 'b@c.com', status: 'active' },
        ],
        { status: 'inactive' },
        { source: UserAuditSource.cron },
      );
      const { data } = prismaMock.userAuditLog.createMany.mock.calls[0][0];
      expect(data).toHaveLength(2);
      expect(data[1]).toMatchObject({
        subject_user_id: 'u-2',
        event: 'deactivated',
        source: 'cron',
      });
    });
  });

  describe('findAllLogs', () => {
    it('filters and paginates', async () => {
      prismaMock.userAuditLog.count.mockResolvedValue(45);
      const result = await service.findAllLogs({
        page: 2,
        limit: 20,
        event: 'invite_expired_deleted',
        search: 'jane',
      });
      const args = prismaMock.userAuditLog.findMany.mock.calls[0][0];
      expect(args.skip).toBe(20);
      expect(args.where.event).toBe('invite_expired_deleted');
      expect(args.where.OR).toEqual(
        expect.arrayContaining([
          { subject_email: { contains: 'jane', mode: 'insensitive' } },
        ]),
      );
      expect(result.meta).toEqual({
        total: 45,
        page: 2,
        limit: 20,
        totalPages: 3,
      });
    });
  });
});
