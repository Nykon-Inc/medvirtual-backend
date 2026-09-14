import { Test, TestingModule } from '@nestjs/testing';
import { HandlerInvoiceAssociationChange } from './invoiceAssociationChange';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerOrganizationCreation } from './organizationCreation';
import { HandlerInvoiceCreation } from './invoiceCreation';
import { AllianceNotificationsService } from '../../med-alliance/notifications/notifications.service';

const prismaMock = {
  organization: {
    findUnique: jest.fn(),
  },
  hubspotInvoiceSnapshot: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const organizationCreationMock = { execute: jest.fn() };
const invoiceCreationMock = { execute: jest.fn() };
const notificationsMock = { notifyAdminInvoiceReassociated: jest.fn() };

describe('HandlerInvoiceAssociationChange', () => {
  let handler: HandlerInvoiceAssociationChange;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerInvoiceAssociationChange,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: HandlerOrganizationCreation,
          useValue: organizationCreationMock,
        },
        { provide: HandlerInvoiceCreation, useValue: invoiceCreationMock },
        { provide: AllianceNotificationsService, useValue: notificationsMock },
      ],
    }).compile();

    handler = module.get<HandlerInvoiceAssociationChange>(
      HandlerInvoiceAssociationChange,
    );
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  describe('COMPANY_TO_INVOICE', () => {
    const event = {
      associationType: 'COMPANY_TO_INVOICE',
      fromObjectId: 100, // company
      toObjectId: 200, // invoice
    };

    it('notifies the admin and updates the snapshot when the invoice moves to a different org', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        id: 'org-new',
        name: 'New Org',
        referredByAffiliate: { first_name: 'Yara', last_name: 'Y' },
      });
      prismaMock.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        invoice_number: 'INV-9',
        organization_id: 'org-old',
        organization: {
          id: 'org-old',
          name: 'Old Org',
          referredByAffiliate: { first_name: 'Xavier', last_name: 'X' },
        },
      });

      await handler.execute(event);

      expect(
        notificationsMock.notifyAdminInvoiceReassociated,
      ).toHaveBeenCalledTimes(1);
      expect(
        notificationsMock.notifyAdminInvoiceReassociated,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceHubspotId: '200',
          invoiceNumber: 'INV-9',
          oldOrganizationName: 'Old Org',
          newOrganizationName: 'New Org',
          oldAffiliateName: 'Xavier X',
          newAffiliateName: 'Yara Y',
        }),
      );
      expect(prismaMock.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith({
        where: { hubspot_id: '200' },
        data: { organization_id: 'org-new' },
      });
    });

    it('does NOT notify when the invoice already points at the same org (webhook replay)', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Org',
        referredByAffiliate: null,
      });
      prismaMock.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        invoice_number: null,
        organization_id: 'org-1',
        organization: { id: 'org-1', name: 'Org', referredByAffiliate: null },
      });

      await handler.execute(event);

      expect(
        notificationsMock.notifyAdminInvoiceReassociated,
      ).not.toHaveBeenCalled();
      expect(prismaMock.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith({
        where: { hubspot_id: '200' },
        data: { organization_id: 'org-1' },
      });
    });

    it('returns early when the organization cannot be found or created', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(null);
      organizationCreationMock.execute.mockResolvedValue(undefined);

      await handler.execute(event);

      expect(
        notificationsMock.notifyAdminInvoiceReassociated,
      ).not.toHaveBeenCalled();
      expect(prismaMock.hubspotInvoiceSnapshot.update).not.toHaveBeenCalled();
    });
  });

  describe('INVOICE_TO_COMPANY', () => {
    it('resolves company from toObjectId and invoice from fromObjectId', async () => {
      const event = {
        associationType: 'INVOICE_TO_COMPANY',
        fromObjectId: 200, // invoice
        toObjectId: 100, // company
      };

      prismaMock.organization.findUnique.mockResolvedValue({
        id: 'org-new',
        name: 'New Org',
        referredByAffiliate: null,
      });
      prismaMock.hubspotInvoiceSnapshot.findUnique.mockResolvedValue({
        id: 'snap-1',
        invoice_number: 'INV-1',
        organization_id: 'org-old',
        organization: {
          id: 'org-old',
          name: 'Old Org',
          referredByAffiliate: null,
        },
      });

      await handler.execute(event);

      expect(prismaMock.organization.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { hubspot_id: '100' } }),
      );
      expect(
        notificationsMock.notifyAdminInvoiceReassociated,
      ).toHaveBeenCalledTimes(1);
      expect(prismaMock.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith({
        where: { hubspot_id: '200' },
        data: { organization_id: 'org-new' },
      });
    });
  });

  it('creates the invoice snapshot when it does not exist yet, then treats it as first association (no notification)', async () => {
    const event = {
      associationType: 'COMPANY_TO_INVOICE',
      fromObjectId: 100,
      toObjectId: 200,
    };

    prismaMock.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      name: 'Org',
      referredByAffiliate: null,
    });
    // First lookup: not found. invoiceCreation succeeds. Second lookup: found with null org.
    prismaMock.hubspotInvoiceSnapshot.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'snap-1',
        invoice_number: 'INV-1',
        organization_id: null,
        organization: null,
      });
    invoiceCreationMock.execute.mockResolvedValue(true);

    await handler.execute(event);

    expect(invoiceCreationMock.execute).toHaveBeenCalled();
    expect(
      notificationsMock.notifyAdminInvoiceReassociated,
    ).not.toHaveBeenCalled();
    expect(prismaMock.hubspotInvoiceSnapshot.update).toHaveBeenCalledWith({
      where: { hubspot_id: '200' },
      data: { organization_id: 'org-1' },
    });
  });
});
