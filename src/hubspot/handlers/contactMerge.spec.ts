import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HandlerContactMerge } from './contactMerge';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { UserAuditService } from '../../user-audit/user-audit.service';

const txMock = {
  contact: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  uSER: {
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  },
  affiliateProfile: {
    updateMany: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn((cb) => cb(txMock)),
};

const auditMock = { log: jest.fn() };

const userAuditServiceMock = {
  log: jest.fn().mockResolvedValue(undefined),
  logOrThrow: jest.fn().mockResolvedValue(undefined),
  logMany: jest.fn().mockResolvedValue(undefined),
  logUpdate: jest.fn().mockResolvedValue(undefined),
  logBulkUpdate: jest.fn().mockResolvedValue(undefined),
  buildUpdateEntries: jest.fn().mockReturnValue([]),
};

describe('HandlerContactMerge', () => {
  let handler: HandlerContactMerge;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: UserAuditService, useValue: userAuditServiceMock },
        HandlerContactMerge,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    handler = module.get<HandlerContactMerge>(HandlerContactMerge);

    prismaMock.$transaction.mockClear();
    txMock.contact.findUnique.mockReset();
    txMock.contact.findMany.mockReset();
    txMock.contact.update.mockReset();
    txMock.uSER.update.mockReset();
    txMock.affiliateProfile.updateMany.mockReset();
    auditMock.log.mockReset();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  it('should throw when the primary contact is not found locally', async () => {
    txMock.contact.findUnique.mockResolvedValue(null);

    await expect(
      handler.execute({
        primaryObjectId: 'hs-primary',
        mergedObjectIds: ['hs-primary', 'hs-loser'],
        newObjectId: 'hs-new',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(txMock.contact.update).not.toHaveBeenCalled();
  });

  it('should re-point the primary contact and linked user when there are no local merged rows', async () => {
    txMock.contact.findUnique.mockResolvedValue({
      id: 'contact-primary',
      hubspot_id: 'hs-primary',
      user_id: 'user-primary',
    });
    txMock.contact.findMany.mockResolvedValue([]);
    txMock.contact.update.mockResolvedValue({});
    txMock.uSER.update.mockResolvedValue({});

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary'],
      newObjectId: 'hs-new',
    });

    expect(txMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-primary' },
      data: { hubspot_id: 'hs-new' },
    });
    expect(txMock.uSER.update).toHaveBeenCalledWith({
      where: { id: 'user-primary' },
      data: { hubspot_contact_id: 'hs-new' },
    });
    expect(txMock.affiliateProfile.updateMany).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          primaryContactId: 'contact-primary',
          mergedContactIds: [],
          newHubspotId: 'hs-new',
        }),
      }),
    );
  });

  it('should cascade AffiliateProfile links and clear losing contact/user pointers on merge', async () => {
    txMock.contact.findUnique.mockResolvedValue({
      id: 'contact-primary',
      hubspot_id: 'hs-primary',
      user_id: 'user-primary',
    });
    txMock.contact.findMany.mockResolvedValue([
      {
        id: 'contact-loser',
        hubspot_id: 'hs-loser',
        user_id: 'user-loser',
      },
    ]);
    txMock.contact.update.mockResolvedValue({});
    txMock.uSER.update.mockResolvedValue({});
    txMock.affiliateProfile.updateMany.mockResolvedValue({ count: 1 });

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary', 'hs-loser'],
      newObjectId: 'hs-new',
    });

    expect(txMock.affiliateProfile.updateMany).toHaveBeenCalledWith({
      where: { contact_id: 'contact-loser' },
      data: { contact_id: 'contact-primary' },
    });
    expect(txMock.uSER.update).toHaveBeenCalledWith({
      where: { id: 'user-loser' },
      data: { hubspot_contact_id: null },
    });
    expect(txMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-loser' },
      data: { hubspot_id: null, hubspot_id_before_deletion: 'hs-loser' },
    });
    // Primary re-point still happens alongside the loser cleanup.
    expect(txMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-primary' },
      data: { hubspot_id: 'hs-new' },
    });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          mergedContactIds: ['contact-loser'],
        }),
      }),
    );
  });

  it('should skip the linked-user update for merged contacts without a user_id', async () => {
    txMock.contact.findUnique.mockResolvedValue({
      id: 'contact-primary',
      hubspot_id: 'hs-primary',
      user_id: null,
    });
    txMock.contact.findMany.mockResolvedValue([
      { id: 'contact-loser', hubspot_id: 'hs-loser', user_id: null },
    ]);
    txMock.contact.update.mockResolvedValue({});
    txMock.affiliateProfile.updateMany.mockResolvedValue({ count: 0 });

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary', 'hs-loser'],
      newObjectId: 'hs-new',
    });

    expect(txMock.uSER.update).not.toHaveBeenCalled();
  });

  it('should wrap unexpected errors in a BadRequestException', async () => {
    txMock.contact.findUnique.mockRejectedValue(new Error('db down'));

    await expect(
      handler.execute({
        primaryObjectId: 'hs-primary',
        mergedObjectIds: ['hs-primary'],
        newObjectId: 'hs-new',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
