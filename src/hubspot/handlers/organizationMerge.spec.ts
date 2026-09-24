import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HandlerOrganizationMerge } from './organizationMerge';
import { PrismaService } from '../../prisma/prisma.service';
import { UserAuditService } from '../../user-audit/user-audit.service';

const txMock = {
  organization: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  staff: {
    updateMany: jest.fn(),
  },
  candidate: {
    updateMany: jest.fn(),
  },
  uSER: {
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn(),
  },
  hireRequest: {
    updateMany: jest.fn(),
  },
  ticket: {
    updateMany: jest.fn(),
  },
  contact: {
    updateMany: jest.fn(),
  },
  organizationCandidate: {
    updateMany: jest.fn(),
  },
  hubspotInvoiceSnapshot: {
    updateMany: jest.fn(),
  },
  affiliateCommission: {
    updateMany: jest.fn(),
  },
  invoice: {
    updateMany: jest.fn(),
  },
  invoiceLineReconciliation: {
    updateMany: jest.fn(),
  },
  billingLedgerEntry: {
    updateMany: jest.fn(),
  },
  medAllianceAdminReviewCase: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  invoiceConfiguration: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn((cb) => cb(txMock)),
};

function resetAllMocks() {
  prismaMock.$transaction.mockClear();
  for (const model of Object.values(txMock)) {
    for (const fn of Object.values(model)) {
      fn.mockReset();
    }
  }
}

function mockHappyPathDefaults() {
  txMock.staff.updateMany.mockResolvedValue({ count: 0 });
  txMock.candidate.updateMany.mockResolvedValue({ count: 0 });
  txMock.uSER.findMany.mockResolvedValue([]);
  txMock.uSER.updateMany.mockResolvedValue({ count: 0 });
  txMock.hireRequest.updateMany.mockResolvedValue({ count: 0 });
  txMock.ticket.updateMany.mockResolvedValue({ count: 0 });
  txMock.contact.updateMany.mockResolvedValue({ count: 0 });
  txMock.organizationCandidate.updateMany.mockResolvedValue({ count: 0 });
  txMock.hubspotInvoiceSnapshot.updateMany.mockResolvedValue({ count: 0 });
  txMock.affiliateCommission.updateMany.mockResolvedValue({ count: 0 });
  txMock.invoice.updateMany.mockResolvedValue({ count: 0 });
  txMock.invoiceLineReconciliation.updateMany.mockResolvedValue({ count: 0 });
  txMock.billingLedgerEntry.updateMany.mockResolvedValue({ count: 0 });
  txMock.medAllianceAdminReviewCase.findMany.mockResolvedValue([]);
  txMock.invoiceConfiguration.findUnique.mockResolvedValue(null);
  txMock.invoiceConfiguration.updateMany.mockResolvedValue({ count: 0 });
  txMock.invoiceConfiguration.deleteMany.mockResolvedValue({ count: 0 });
  txMock.organization.deleteMany.mockResolvedValue({ count: 1 });
  txMock.organization.update.mockResolvedValue({});
}

const userAuditServiceMock = {
  log: jest.fn().mockResolvedValue(undefined),
  logOrThrow: jest.fn().mockResolvedValue(undefined),
  logMany: jest.fn().mockResolvedValue(undefined),
  logUpdate: jest.fn().mockResolvedValue(undefined),
  logBulkUpdate: jest.fn().mockResolvedValue(undefined),
  buildUpdateEntries: jest.fn().mockReturnValue([]),
};

describe('HandlerOrganizationMerge', () => {
  let handler: HandlerOrganizationMerge;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: UserAuditService, useValue: userAuditServiceMock },
        HandlerOrganizationMerge,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    handler = module.get<HandlerOrganizationMerge>(HandlerOrganizationMerge);

    resetAllMocks();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  it('should throw when the primary organization is not found locally', async () => {
    txMock.organization.findUnique.mockResolvedValue(null);

    await expect(
      handler.execute({
        primaryObjectId: 'hs-primary',
        mergedObjectIds: ['hs-primary', 'hs-loser'],
        newObjectId: 'hs-new',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(txMock.organization.update).not.toHaveBeenCalled();
  });

  it('should throw when no merged organizations are found locally', async () => {
    txMock.organization.findUnique.mockResolvedValue({
      id: 'org-primary',
      hubspot_id: 'hs-primary',
    });
    txMock.organization.findMany.mockResolvedValue([]);

    await expect(
      handler.execute({
        primaryObjectId: 'hs-primary',
        mergedObjectIds: ['hs-primary', 'hs-loser'],
        newObjectId: 'hs-new',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(txMock.organization.update).not.toHaveBeenCalled();
  });

  it('should merge, backfill, re-point hubspot_id and cascade all related records', async () => {
    mockHappyPathDefaults();
    txMock.organization.findUnique.mockResolvedValue({
      id: 'org-primary',
      hubspot_id: 'hs-primary',
      name: 'Primary Org',
    });
    txMock.organization.findMany.mockResolvedValue([
      { id: 'org-loser', hubspot_id: 'hs-loser', name: 'Loser Org' },
    ]);

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary', 'hs-loser'],
      newObjectId: 'hs-new',
    });

    expect(txMock.organization.update).toHaveBeenCalledWith({
      where: { hubspot_id: 'hs-primary' },
      data: { hubspot_id: 'hs-new' },
    });
    expect(txMock.staff.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: {
        organization_id: 'org-primary',
        hubspot_organization_id: 'hs-new',
      },
    });
    expect(txMock.candidate.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.uSER.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: {
        organization_id: 'org-primary',
        organization_name: 'Primary Org',
      },
    });
    expect(txMock.hireRequest.updateMany).toHaveBeenCalledWith({
      where: { org_id: 'org-loser' },
      data: { org_id: 'org-primary' },
    });
    expect(txMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { org_id: 'org-loser' },
      data: { org_id: 'org-primary' },
    });
    expect(txMock.contact.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.organizationCandidate.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.hubspotInvoiceSnapshot.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.affiliateCommission.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.invoice.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.invoiceLineReconciliation.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.billingLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.invoiceConfiguration.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
      data: { organization_id: 'org-primary' },
    });
    expect(txMock.organization.deleteMany).toHaveBeenCalledWith({
      where: { hubspot_id: { in: ['hs-loser'] } },
    });
  });

  it('should handle mergedObjectIds sent by HubSpot as a serialized string instead of an array', async () => {
    mockHappyPathDefaults();
    txMock.organization.findUnique.mockResolvedValue({
      id: 'org-primary',
      hubspot_id: '58295583232',
      name: 'Primary Org',
    });
    txMock.organization.findMany.mockResolvedValue([
      { id: 'org-loser', hubspot_id: '53716508978', name: 'Loser Org' },
    ]);

    await handler.execute({
      primaryObjectId: '58295583232',
      mergedObjectIds: '[ 58295583232, 53716508978 ]',
      newObjectId: '58339066990',
    });

    expect(txMock.organization.findMany).toHaveBeenCalledWith({
      where: { hubspot_id: { in: ['53716508978'] } },
    });
    expect(txMock.organization.deleteMany).toHaveBeenCalledWith({
      where: { hubspot_id: { in: ['53716508978'] } },
    });
  });

  it('should skip reassigning a review case that would collide with an existing open case on the primary org', async () => {
    mockHappyPathDefaults();
    txMock.organization.findUnique.mockResolvedValue({
      id: 'org-primary',
      hubspot_id: 'hs-primary',
      name: 'Primary Org',
    });
    txMock.organization.findMany.mockResolvedValue([
      { id: 'org-loser', hubspot_id: 'hs-loser', name: 'Loser Org' },
    ]);
    txMock.medAllianceAdminReviewCase.findMany.mockResolvedValue([
      {
        id: 'case-1',
        reason_code: 'multiple_hubspot_matches',
        status: 'open',
        hubspot_line_item_snapshot_id: null,
      },
    ]);
    txMock.medAllianceAdminReviewCase.findFirst.mockResolvedValue({
      id: 'case-existing-on-primary',
    });

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary', 'hs-loser'],
      newObjectId: 'hs-new',
    });

    expect(txMock.medAllianceAdminReviewCase.findFirst).toHaveBeenCalledWith({
      where: {
        organization_id: 'org-primary',
        reason_code: 'multiple_hubspot_matches',
        status: 'open',
        hubspot_line_item_snapshot_id: null,
      },
    });
    expect(txMock.medAllianceAdminReviewCase.update).not.toHaveBeenCalled();
  });

  it('should reassign a review case when there is no collision on the primary org', async () => {
    mockHappyPathDefaults();
    txMock.organization.findUnique.mockResolvedValue({
      id: 'org-primary',
      hubspot_id: 'hs-primary',
      name: 'Primary Org',
    });
    txMock.organization.findMany.mockResolvedValue([
      { id: 'org-loser', hubspot_id: 'hs-loser', name: 'Loser Org' },
    ]);
    txMock.medAllianceAdminReviewCase.findMany.mockResolvedValue([
      {
        id: 'case-1',
        reason_code: 'soft_duplicate',
        status: 'open',
        hubspot_line_item_snapshot_id: null,
      },
    ]);
    txMock.medAllianceAdminReviewCase.findFirst.mockResolvedValue(null);

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary', 'hs-loser'],
      newObjectId: 'hs-new',
    });

    expect(txMock.medAllianceAdminReviewCase.update).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: { organization_id: 'org-primary' },
    });
  });

  it('should drop the merged organization invoice configuration when the primary already has one', async () => {
    mockHappyPathDefaults();
    txMock.organization.findUnique.mockResolvedValue({
      id: 'org-primary',
      hubspot_id: 'hs-primary',
      name: 'Primary Org',
    });
    txMock.organization.findMany.mockResolvedValue([
      { id: 'org-loser', hubspot_id: 'hs-loser', name: 'Loser Org' },
    ]);
    txMock.invoiceConfiguration.findUnique.mockResolvedValue({
      id: 'config-primary',
      organization_id: 'org-primary',
    });

    await handler.execute({
      primaryObjectId: 'hs-primary',
      mergedObjectIds: ['hs-primary', 'hs-loser'],
      newObjectId: 'hs-new',
    });

    expect(txMock.invoiceConfiguration.deleteMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-loser' },
    });
    expect(txMock.invoiceConfiguration.updateMany).not.toHaveBeenCalled();
  });

  it('should wrap unexpected errors in a BadRequestException', async () => {
    txMock.organization.findUnique.mockRejectedValue(new Error('db down'));

    await expect(
      handler.execute({
        primaryObjectId: 'hs-primary',
        mergedObjectIds: ['hs-primary'],
        newObjectId: 'hs-new',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
