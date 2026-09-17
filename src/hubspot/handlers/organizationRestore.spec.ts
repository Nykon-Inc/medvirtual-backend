import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OrganizationStatus } from '@prisma/client';
import { HandlerOrganizationRestore } from './organizationRestore';
import { HandlerOrganizationCreation } from './organizationCreation';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgDeletionService } from '../../med-alliance/org-deletion/org-deletion.service';

const prismaMock = {
  organization: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const organizationCreationMock = {
  execute: jest.fn(),
};

const orgDeletionMock = {
  onOrganizationRestored: jest.fn(),
};

describe('HandlerOrganizationRestore', () => {
  let handler: HandlerOrganizationRestore;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerOrganizationRestore,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: HandlerOrganizationCreation,
          useValue: organizationCreationMock,
        },
        {
          provide: OrgDeletionService,
          useValue: orgDeletionMock,
        },
      ],
    }).compile();

    handler = module.get<HandlerOrganizationRestore>(
      HandlerOrganizationRestore,
    );
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  it('should restore a deleted organization to inactive and clear deletedAt', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    prismaMock.organization.update.mockResolvedValue({});

    await handler.execute({ objectId: 1 });

    expect(prismaMock.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: {
        status: OrganizationStatus.inactive,
        deletedAt: null,
      },
    });
    expect(organizationCreationMock.execute).not.toHaveBeenCalled();
    expect(orgDeletionMock.onOrganizationRestored).toHaveBeenCalledWith(
      'org-1',
    );
  });

  it('should delegate to the creation handler when the organization was never synced', async () => {
    prismaMock.organization.findUnique.mockResolvedValue(null);
    organizationCreationMock.execute.mockResolvedValue(true);

    await handler.execute({ objectId: 99 });

    expect(organizationCreationMock.execute).toHaveBeenCalledWith({
      objectId: 99,
    });
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
  });

  it('should be a no-op when the organization is already active', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.active,
    });

    await handler.execute({ objectId: 1 });

    expect(prismaMock.organization.update).not.toHaveBeenCalled();
    expect(organizationCreationMock.execute).not.toHaveBeenCalled();
    expect(orgDeletionMock.onOrganizationRestored).not.toHaveBeenCalled();
  });

  it('should be a no-op when the organization is inactive', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.inactive,
    });

    await handler.execute({ objectId: 1 });

    expect(prismaMock.organization.update).not.toHaveBeenCalled();
    expect(orgDeletionMock.onOrganizationRestored).not.toHaveBeenCalled();
  });

  it('should wrap update failures as BadRequestException', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      status: OrganizationStatus.deleted,
    });
    prismaMock.organization.update.mockRejectedValue(new Error('db down'));

    await expect(handler.execute({ objectId: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
