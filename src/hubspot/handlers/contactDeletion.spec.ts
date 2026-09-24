import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HubspotAuditSource } from '@prisma/client';
import { HandlerContactDeletion } from './contactDeletion';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotAuditService } from '../hubspot-audit.service';
import { UserAuditService } from '../../user-audit/user-audit.service';

const prismaMock = {
  contact: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  uSER: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
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

describe('HandlerContactDeletion', () => {
  let handler: HandlerContactDeletion;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: UserAuditService, useValue: userAuditServiceMock },
        HandlerContactDeletion,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotAuditService, useValue: auditMock },
      ],
    }).compile();

    handler = module.get<HandlerContactDeletion>(HandlerContactDeletion);

    prismaMock.contact.findUnique.mockReset();
    prismaMock.contact.update.mockReset();
    prismaMock.uSER.findUnique.mockReset();
    prismaMock.uSER.update.mockReset();
    auditMock.log.mockReset();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  it('should no-op when neither a contact nor a user is found locally', async () => {
    prismaMock.contact.findUnique.mockResolvedValue(null);
    prismaMock.uSER.findUnique.mockResolvedValue(null);

    await handler.execute({ objectId: 'hs-1' });

    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.uSER.update).not.toHaveBeenCalled();
    expect(auditMock.log).not.toHaveBeenCalled();
  });

  it('should clear only the contact pointer when only a Contact row is found', async () => {
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-1',
      hubspot_id: 'hs-1',
    });
    prismaMock.uSER.findUnique.mockResolvedValue(null);
    prismaMock.contact.update.mockResolvedValue({});

    await handler.execute({ objectId: 'hs-1' });

    expect(prismaMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: { hubspot_id: null, hubspot_id_before_deletion: 'hs-1' },
    });
    expect(prismaMock.uSER.update).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          contactId: 'contact-1',
          userId: null,
          clearedStaleId: 'hs-1',
        },
        source: HubspotAuditSource.webhook,
      }),
    );
  });

  it('should clear only the user pointer when only a USER row is found', async () => {
    prismaMock.contact.findUnique.mockResolvedValue(null);
    prismaMock.uSER.findUnique.mockResolvedValue({
      id: 'user-1',
      hubspot_contact_id: 'hs-1',
    });
    prismaMock.uSER.update.mockResolvedValue({});

    await handler.execute({ objectId: 'hs-1' });

    expect(prismaMock.contact.update).not.toHaveBeenCalled();
    expect(prismaMock.uSER.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { hubspot_contact_id: null },
    });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { contactId: null, userId: 'user-1', clearedStaleId: 'hs-1' },
      }),
    );
  });

  it('should clear both pointers and log once when both a Contact and USER row are found', async () => {
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-1',
      hubspot_id: 'hs-1',
    });
    prismaMock.uSER.findUnique.mockResolvedValue({
      id: 'user-1',
      hubspot_contact_id: 'hs-1',
    });
    prismaMock.contact.update.mockResolvedValue({});
    prismaMock.uSER.update.mockResolvedValue({});

    await handler.execute({ objectId: 'hs-1' });

    expect(prismaMock.contact.update).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: { hubspot_id: null, hubspot_id_before_deletion: 'hs-1' },
    });
    expect(prismaMock.uSER.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { hubspot_contact_id: null },
    });
    expect(auditMock.log).toHaveBeenCalledTimes(1);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          contactId: 'contact-1',
          userId: 'user-1',
          clearedStaleId: 'hs-1',
        },
      }),
    );
  });

  it('should respect an explicit audit source override (e.g. cron sweep)', async () => {
    prismaMock.contact.findUnique.mockResolvedValue({
      id: 'contact-1',
      hubspot_id: 'hs-1',
    });
    prismaMock.uSER.findUnique.mockResolvedValue(null);
    prismaMock.contact.update.mockResolvedValue({});

    await handler.execute({ objectId: 'hs-1' }, HubspotAuditSource.cron);

    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ source: HubspotAuditSource.cron }),
    );
  });

  it('should wrap unexpected errors in a BadRequestException', async () => {
    prismaMock.contact.findUnique.mockRejectedValue(new Error('db down'));

    await expect(handler.execute({ objectId: 'hs-1' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
