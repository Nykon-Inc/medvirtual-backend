import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_PIPELINE_STAFF_WHERE } from '../common/constant/activeDealPipelines';
import { MailService } from '../mail/mail.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { UserAuditService } from '../user-audit/user-audit.service';

const userAuditServiceMock = {
  log: jest.fn().mockResolvedValue(undefined),
  logOrThrow: jest.fn().mockResolvedValue(undefined),
  logMany: jest.fn().mockResolvedValue(undefined),
  logUpdate: jest.fn().mockResolvedValue(undefined),
  logBulkUpdate: jest.fn().mockResolvedValue(undefined),
  buildUpdateEntries: jest.fn().mockReturnValue([]),
};

describe('UserService', () => {
  let service: UserService;

  const prismaMock = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    uSER: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    session: {
      deleteMany: jest.fn(),
    },
    emailVerification: {
      deleteMany: jest.fn(),
    },
    emailInvitation: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    ticketNotes: {
      deleteMany: jest.fn(),
    },
    hireRequest: {
      updateMany: jest.fn(),
    },
    ticket: {
      updateMany: jest.fn(),
    },
    affiliateProfile: {
      updateMany: jest.fn(),
    },
    // Resolve the array of query promises just like a real interactive transaction
    $transaction: jest.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };

  const mailServiceMock = {
    sendMail: jest.fn(),
  };

  const hubspotServiceMock = {
    createContactInHubspot: jest.fn(),
    deleteContactInHubspot: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: UserAuditService, useValue: userAuditServiceMock },
        UserService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MailService, useValue: mailServiceMock },
        { provide: HubspotService, useValue: hubspotServiceMock },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('inviteUserToOrganization', () => {
    const currentUser: any = { id: 'admin-1', role: 'system_admin' };
    const inviteData: any = {
      email: 'new@test.com',
      role: 'organization_admin',
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException when inviting user to an inactive organization', async () => {
      prismaMock.uSER.findFirst.mockResolvedValue(null);
      prismaMock.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Test Org',
        status: 'inactive',
      });

      await expect(
        service.inviteUserToOrganization('org-1', inviteData, currentUser),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot invite users to an inactive organization',
        ),
      );
    });

    it('should throw NotFoundException when organization does not exist', async () => {
      prismaMock.uSER.findFirst.mockResolvedValue(null);
      prismaMock.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.inviteUserToOrganization(
          'org-missing',
          inviteData,
          currentUser,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when user email already exists', async () => {
      prismaMock.uSER.findFirst.mockResolvedValue({ id: 'existing-user' });

      await expect(
        service.inviteUserToOrganization('org-1', inviteData, currentUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should detect an existing user case-insensitively and not create a duplicate', async () => {
      const mixedCaseInvite: any = {
        email: 'New@Test.com',
        role: 'organization_admin',
      };
      prismaMock.uSER.findFirst.mockResolvedValue({ id: 'existing-user' });

      await expect(
        service.inviteUserToOrganization('org-1', mixedCaseInvite, currentUser),
      ).rejects.toThrow(BadRequestException);

      expect(prismaMock.uSER.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'new@test.com', mode: 'insensitive' } },
      });
      expect(prismaMock.uSER.create).not.toHaveBeenCalled();
    });

    it('should persist the invited user email normalized to lowercase', async () => {
      const mixedCaseInvite: any = {
        email: 'New@Test.com',
        role: 'organization_admin',
      };
      prismaMock.uSER.findFirst.mockResolvedValue(null);
      prismaMock.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Test Org',
        status: 'active',
      });

      // Capture the create() payload directly and short-circuit right after,
      // so this test only depends on the code path up to the normalized
      // email being persisted — not on the rest of the invite pipeline
      // (email theme lookup, mail sending, HubSpot sync), which is covered
      // by its own tests/mocks elsewhere.
      let createCallArgs: any;
      const sentinel = new Error('stop-after-create');
      prismaMock.uSER.create.mockImplementationOnce((args: any) => {
        createCallArgs = args;
        throw sentinel;
      });

      await expect(
        service.inviteUserToOrganization('org-1', mixedCaseInvite, currentUser),
      ).rejects.toThrow(BadRequestException);

      expect(createCallArgs).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'new@test.com' }),
        }),
      );
    });
  });

  describe('create', () => {
    it('should persist the email normalized to lowercase', async () => {
      prismaMock.uSER.create.mockResolvedValue({ id: 'new-user' });

      await service.create({
        email: 'Mixed@Case.com',
        password: 'plain-password',
        organization_name: 'Test Org',
        first_name: 'Test',
        last_name: 'User',
      } as any);

      expect(prismaMock.uSER.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'mixed@case.com' }),
        }),
      );
    });
  });

  describe('getAllSystemUsers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should apply the status filter to both findMany and count so meta.total reflects the filtered set', async () => {
      const invitedUsers = [
        {
          id: 'u1',
          email: 'invited@test.com',
          first_name: 'Inv',
          last_name: 'Ited',
          job_title: 'Admin',
          role: 'system_admin',
          status: 'invited',
          createdAt: new Date(),
          sessions: [],
        },
      ];
      prismaMock.uSER.findMany.mockResolvedValue(invitedUsers);
      prismaMock.uSER.count.mockResolvedValue(1);

      const result = await service.getAllSystemUsers(
        undefined,
        1,
        10,
        'invited',
      );

      // The where clause passed to findMany must include the status filter
      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.status).toBe('invited');

      // The where clause passed to count must include the same status filter,
      // otherwise meta.total would count the unfiltered set and break pagination
      const countArgs = prismaMock.uSER.count.mock.calls[0][0];
      expect(countArgs.where.status).toBe('invited');

      expect(result.meta.total).toBe(1);
      expect(result.data).toEqual(invitedUsers);
    });

    it('should NOT apply any status filter when status is omitted (no regression)', async () => {
      prismaMock.uSER.findMany.mockResolvedValue([
        {
          id: 'u1',
          email: 'a@test.com',
          first_name: 'A',
          last_name: 'B',
          job_title: 'Admin',
          role: 'system_admin',
          status: 'active',
          createdAt: new Date(),
          sessions: [],
        },
      ]);
      prismaMock.uSER.count.mockResolvedValue(1);

      await service.getAllSystemUsers();

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.status).toBeUndefined();

      const countArgs = prismaMock.uSER.count.mock.calls[0][0];
      expect(countArgs.where.status).toBeUndefined();
    });

    it('should AND each whitespace-separated token so a complete full name matches across first_name and last_name', async () => {
      prismaMock.uSER.findMany.mockResolvedValue([]);
      prismaMock.uSER.count.mockResolvedValue(0);

      await service.getAllSystemUsers('Barbi Teste', 1, 10).catch(() => {});

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.AND).toEqual([
        {
          OR: [
            { first_name: { contains: 'Barbi', mode: 'insensitive' } },
            { last_name: { contains: 'Barbi', mode: 'insensitive' } },
            { email: { contains: 'Barbi', mode: 'insensitive' } },
            { job_title: { contains: 'Barbi', mode: 'insensitive' } },
          ],
        },
        {
          OR: [
            { first_name: { contains: 'Teste', mode: 'insensitive' } },
            { last_name: { contains: 'Teste', mode: 'insensitive' } },
            { email: { contains: 'Teste', mode: 'insensitive' } },
            { job_title: { contains: 'Teste', mode: 'insensitive' } },
          ],
        },
      ]);
    });
  });

  describe('searchOrganizationUsers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.uSER.findMany.mockResolvedValue([]);
    });

    it('should AND each whitespace-separated token so a complete full name matches across first_name and last_name', async () => {
      await service.searchOrganizationUsers({ search: 'Jane Doe' } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.AND).toEqual([
        {
          OR: [
            { first_name: { contains: 'Jane', mode: 'insensitive' } },
            { last_name: { contains: 'Jane', mode: 'insensitive' } },
            { email: { contains: 'Jane', mode: 'insensitive' } },
            { job_title: { contains: 'Jane', mode: 'insensitive' } },
          ],
        },
        {
          OR: [
            { first_name: { contains: 'Doe', mode: 'insensitive' } },
            { last_name: { contains: 'Doe', mode: 'insensitive' } },
            { email: { contains: 'Doe', mode: 'insensitive' } },
            { job_title: { contains: 'Doe', mode: 'insensitive' } },
          ],
        },
      ]);
    });

    it('should still match a single-word search (email, partial name, or job title)', async () => {
      await service.searchOrganizationUsers({
        search: 'jane@test.com',
      } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.AND).toEqual([
        {
          OR: [
            { first_name: { contains: 'jane@test.com', mode: 'insensitive' } },
            { last_name: { contains: 'jane@test.com', mode: 'insensitive' } },
            { email: { contains: 'jane@test.com', mode: 'insensitive' } },
            { job_title: { contains: 'jane@test.com', mode: 'insensitive' } },
          ],
        },
      ]);
    });

    it('should not add any AND/OR filter when search is omitted', async () => {
      await service.searchOrganizationUsers({} as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.AND).toBeUndefined();
      expect(findManyArgs.where.OR).toBeUndefined();
      expect(findManyArgs.where.role).toEqual({
        in: ['organization_admin', 'organization_super_admin'],
      });
    });

    it('should collapse extra whitespace and not produce empty-token conditions', async () => {
      await service.searchOrganizationUsers({
        search: '  Jane   Doe  ',
      } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.AND).toHaveLength(2);
      expect(findManyArgs.where.AND[0].OR[0]).toEqual({
        first_name: { contains: 'Jane', mode: 'insensitive' },
      });
      expect(findManyArgs.where.AND[1].OR[0]).toEqual({
        first_name: { contains: 'Doe', mode: 'insensitive' },
      });
    });

    it('should restrict to organizations with active staff (dashboard definition)', async () => {
      await service.searchOrganizationUsers({
        staff_status: 'with_active_staff',
      } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.organization).toEqual({
        staff: { some: ACTIVE_PIPELINE_STAFF_WHERE },
      });
    });

    it('should restrict to organizations without active staff', async () => {
      await service.searchOrganizationUsers({
        staff_status: 'without_active_staff',
      } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.organization).toEqual({
        staff: { none: ACTIVE_PIPELINE_STAFF_WHERE },
      });
    });

    it('should not filter by organization staff when staff_status is omitted', async () => {
      await service.searchOrganizationUsers({} as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.organization).toBeUndefined();
      expect(findManyArgs.where.createdAt).toBeUndefined();
    });

    it('should filter createdAt with inclusive UTC day bounds', async () => {
      await service.searchOrganizationUsers({
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30',
      } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.createdAt).toEqual({
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-30T23:59:59.999Z'),
      });
    });

    it('should support an open-ended createdAt range', async () => {
      await service.searchOrganizationUsers({ dateFrom: '2026-09-01' } as any);

      const findManyArgs = prismaMock.uSER.findMany.mock.calls[0][0];
      expect(findManyArgs.where.createdAt).toEqual({
        gte: new Date('2026-09-01T00:00:00.000Z'),
      });
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      jest.clearAllMocks();

      // delete() uses callback-style interactive transactions
      // (this.prisma.$transaction(async (tx) => {...})), unlike the
      // array-style mock used elsewhere in this file. Override locally so the
      // callback receives the prismaMock itself as the transaction client.
      prismaMock.$transaction.mockImplementation(((
        cb: (tx: typeof prismaMock) => unknown,
      ) => cb(prismaMock)) as any);

      prismaMock.organization.findMany.mockResolvedValue([]);
      prismaMock.session.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.emailVerification.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.emailInvitation.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.ticketNotes.deleteMany.mockResolvedValue({ count: 0 });
      prismaMock.organization.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.hireRequest.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.affiliateProfile.updateMany.mockResolvedValue({ count: 0 });
      hubspotServiceMock.deleteContactInHubspot.mockResolvedValue(undefined);
    });

    const baseUser: any = {
      id: 'user-1',
      email: 'affiliate@test.com',
      role: 'organization_admin',
      status: 'invited',
      hubspot_contact_id: null,
    };

    it('should reset the linked AffiliateProfile status to "pending" when deleting a user with an affiliate profile', async () => {
      prismaMock.uSER.findUnique.mockResolvedValue(baseUser);
      prismaMock.affiliateProfile.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.uSER.delete.mockResolvedValue(baseUser);

      await service.delete('user-1', 'actor-1');

      expect(prismaMock.affiliateProfile.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        data: { status: 'pending' },
      });
      expect(prismaMock.uSER.delete).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });

    it('should not fail when deleting a user with no affiliate profile', async () => {
      prismaMock.uSER.findUnique.mockResolvedValue(baseUser);
      // updateMany with no matching profile is a no-op (count: 0)
      prismaMock.affiliateProfile.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.uSER.delete.mockResolvedValue(baseUser);

      await expect(service.delete('user-1', 'actor-1')).resolves.toEqual(
        baseUser,
      );

      expect(prismaMock.affiliateProfile.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        data: { status: 'pending' },
      });
      expect(prismaMock.uSER.delete).toHaveBeenCalledTimes(1);
    });

    it('writes the deleted tombstone inside the transaction, before the delete', async () => {
      const order: string[] = [];
      prismaMock.uSER.findUnique.mockResolvedValue(baseUser);
      prismaMock.uSER.delete.mockImplementation((() => {
        order.push('delete');
        return Promise.resolve(baseUser);
      }) as any);
      userAuditServiceMock.logOrThrow.mockImplementation(() => {
        order.push('audit');
        return Promise.resolve();
      });

      await service.delete('user-1', 'actor-1');

      expect(userAuditServiceMock.logOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'deleted',
          actorUserId: 'actor-1',
          subject: baseUser,
          before: expect.objectContaining({
            id: 'user-1',
            email: 'affiliate@test.com',
          }),
        }),
        prismaMock,
      );
      expect(order).toEqual(['audit', 'delete']);
    });

    it('does not delete the user when the tombstone cannot be written', async () => {
      prismaMock.uSER.findUnique.mockResolvedValue(baseUser);
      userAuditServiceMock.logOrThrow.mockRejectedValueOnce(
        new Error('audit down'),
      );

      await expect(service.delete('user-1', 'actor-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.uSER.delete).not.toHaveBeenCalled();
      userAuditServiceMock.logOrThrow.mockReset();
    });

    it('should throw NotFoundException when the user does not exist', async () => {
      prismaMock.uSER.findUnique.mockResolvedValue(null);

      await expect(service.delete('missing', 'actor-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaMock.uSER.delete).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when deleting an active super admin', async () => {
      prismaMock.uSER.findUnique.mockResolvedValue({
        ...baseUser,
        role: 'system_super_admin',
        status: 'active',
      });

      await expect(service.delete('user-1', 'actor-1')).rejects.toThrow(
        new BadRequestException(
          'Cannot delete Admin users for security reasons',
        ),
      );
      expect(prismaMock.uSER.delete).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when the user is the only admin/owner of an organization', async () => {
      prismaMock.uSER.findUnique
        .mockResolvedValueOnce(baseUser) // findById
        .mockResolvedValue([]); // handled below via findMany
      prismaMock.organization.findMany.mockResolvedValue([
        { id: 'org-1', name: 'Solo Org', owner_id: 'user-1' },
      ]);
      // No other admins in the org
      prismaMock.uSER.findMany.mockResolvedValue([]);

      await expect(service.delete('user-1', 'actor-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.uSER.delete).not.toHaveBeenCalled();
    });
  });
});
