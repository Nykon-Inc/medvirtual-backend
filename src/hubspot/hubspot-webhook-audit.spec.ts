/**
 * Validates that changeDataFromHubspot() correctly logs every inbound webhook
 * event to HubspotAuditLog, both on success (handler completes) and on failure
 * (handler throws).
 *
 * Covered scenarios (from resolveWebhookMeta + switch logic):
 *   object.*  → candidate (2-5922196) | affiliate (2-54072002) | invoice (0-53)
 *   company.* → organization
 *   deal.*    → deal
 *   ticket.*  → hire_request
 *   contact.* → contact
 *   owners.*  → owner
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HubspotService } from './hubspot.service';
import { PrismaService } from '../prisma/prisma.service';
import { HubspotAuditService } from './hubspot-audit.service';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
} from '@prisma/client';
import { CandidatesService } from '../candidate/candidates.service';
import { CandidateAuditService } from '../candidate/candidate-audit.service';

import { HandlerObjectCreation } from './handlers/objectCreation';
import { HandlerObjectPropertyChange } from './handlers/objectPropertyChange';
import { HandlerObjectDeletion } from './handlers/objectDeletion';
import { HandlerObjectMerge } from './handlers/objectMerge';
import { HandlerOrganizationCreation } from './handlers/organizationCreation';
import { HandlerOrganizationPropertyChange } from './handlers/organizationPropertyChange';
import { HandlerOrganizationDeletion } from './handlers/organizationDeletion';
import { HandlerOrganizationRestore } from './handlers/organizationRestore';
import { HandlerOrganizationMerge } from './handlers/organizationMerge';
import { HandlerOrganizationAssociationChange } from './handlers/organizationAssociationChange';
import { HandlerOwnerCreation } from './handlers/ownerCreation';
import { HandlerOwnerDeletion } from './handlers/ownerDeletion';
import { HandlerOwnerPropertyChange } from './handlers/ownerPropertyChange';
import { HandlerDealCreation } from './handlers/dealCreation';
import { HandlerDealPropertyChange } from './handlers/dealPropertyChange';
import { HandlerDealDeletion } from './handlers/dealDeletion';
import { HandlerDealAssociationChange } from './handlers/dealAssociationChange';
import { HireRequestCreationService } from './create/hireRequest';
import { HireRequestUpdateService } from './update/hireRequest';
import { HandlerTicketCreation } from './handlers/ticketCreation';
import { HandlerTicketDeletion } from './handlers/ticketDeletion';
import { HandlerTicketRestore } from './handlers/ticketRestore';
import { HandlerTicketPropertyChange } from './handlers/ticketPropertyChange';
import { OrganizationCreationService } from './create/Organization';
import { OrganizationUpdateService } from './update/organization';
import { OwnerCreationService } from './create/Owner';
import { ContactCreationService } from './create/contact';
import { ContactFromCompanyCreationService } from './create/contactFromCompany';
import { ContactUpdateService } from './update/contact';
import { ContactDeleteService } from './delete/contact';
import { CompanyDeleteService } from './delete/company';
import { HandlerAffiliateCreation } from './handlers/affiliateCreation';
import { HandlerAffiliatePropertyChange } from './handlers/affiliatePropertyChange';
import { HandlerAffiliateDeletion } from './handlers/affiliateDeletion';
import { HandlerAffiliateAssociationChange } from './handlers/affiliateAssociationChange';
import { HandlerInvoiceCreation } from './handlers/invoiceCreation';
import { HandlerInvoicePropertyChange } from './handlers/invoicePropertyChange';
import { HandlerInvoiceAssociationChange } from './handlers/invoiceAssociationChange';
import { HandlerComissionCreation } from './handlers/comissionCreation';
import { AffiliateCreationService } from './create/affiliate';
import { AffiliateUpdateService } from './update/affiliate';
import { HandlerContactCreation } from './handlers/contactCreation';
import { HandlerContactPropertyChange } from './handlers/contactPropertyChange';
import { HandlerContactDeletion } from './handlers/contactDeletion';
import { HandlerContactMerge } from './handlers/contactMerge';

jest.mock('axios');
jest.mock('@hubspot/api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    crm: {
      objects: {
        searchApi: { doSearch: jest.fn() },
        batchApi: { update: jest.fn() },
        basicApi: { update: jest.fn() },
      },
    },
  })),
}));
jest.mock('../common/utils/hubspot.util', () => ({
  extractDriveFileId: jest.fn(),
  mapHubspotToDb: jest.fn(),
}));

const makeMock = () => ({ execute: jest.fn() });

const auditMock = { log: jest.fn() };
const prismaMock = { candidate: { findUnique: jest.fn() } };
const candidateMock = { processData: jest.fn() };
const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

const handlers = {
  objectCreation: makeMock(),
  objectPropertyChange: makeMock(),
  objectDeletion: makeMock(),
  objectMerge: makeMock(),
  organizationCreation: makeMock(),
  organizationPropertyChange: makeMock(),
  organizationDeletion: makeMock(),
  organizationRestore: makeMock(),
  organizationMerge: makeMock(),
  organizationAssociationChange: makeMock(),
  ownerCreation: makeMock(),
  ownerDeletion: makeMock(),
  ownerPropertyChange: makeMock(),
  dealCreation: makeMock(),
  dealPropertyChange: makeMock(),
  dealDeletion: makeMock(),
  dealAssociationChange: makeMock(),
  ticketCreation: makeMock(),
  ticketDeletion: makeMock(),
  ticketRestore: makeMock(),
  ticketPropertyChange: makeMock(),
  affiliateCreation: makeMock(),
  affiliatePropertyChange: makeMock(),
  affiliateDeletion: makeMock(),
  affiliateAssociationChange: makeMock(),
  invoiceCreation: makeMock(),
  invoicePropertyChange: makeMock(),
  invoiceAssociationChange: makeMock(),
  comissionCreation: makeMock(),
  contactCreation: makeMock(),
  contactPropertyChange: makeMock(),
  contactDeletion: makeMock(),
  contactMerge: makeMock(),
  hireRequestCreation: makeMock(),
  hireRequestUpdate: makeMock(),
  organizationCreationService: makeMock(),
  organizationUpdateService: makeMock(),
  ownerCreationService: makeMock(),
  contactCreationService: makeMock(),
  contactFromCompanyService: makeMock(),
  affiliateCreationService: makeMock(),
  affiliateUpdateService: { deactivate: jest.fn() },
  contactUpdateService: makeMock(),
  contactDeleteService: makeMock(),
  companyDeleteService: makeMock(),
};

async function buildModule(): Promise<HubspotService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      HubspotService,
      { provide: PrismaService, useValue: prismaMock },
      { provide: HubspotAuditService, useValue: auditMock },
      { provide: CandidatesService, useValue: candidateMock },
      { provide: CandidateAuditService, useValue: candidateAuditMock },
      { provide: HandlerObjectCreation, useValue: handlers.objectCreation },
      {
        provide: HandlerObjectPropertyChange,
        useValue: handlers.objectPropertyChange,
      },
      { provide: HandlerObjectDeletion, useValue: handlers.objectDeletion },
      { provide: HandlerObjectMerge, useValue: handlers.objectMerge },
      {
        provide: HandlerOrganizationCreation,
        useValue: handlers.organizationCreation,
      },
      {
        provide: HandlerOrganizationPropertyChange,
        useValue: handlers.organizationPropertyChange,
      },
      {
        provide: HandlerOrganizationDeletion,
        useValue: handlers.organizationDeletion,
      },
      {
        provide: HandlerOrganizationRestore,
        useValue: handlers.organizationRestore,
      },
      {
        provide: HandlerOrganizationMerge,
        useValue: handlers.organizationMerge,
      },
      {
        provide: HandlerOrganizationAssociationChange,
        useValue: handlers.organizationAssociationChange,
      },
      { provide: HandlerOwnerCreation, useValue: handlers.ownerCreation },
      { provide: HandlerOwnerDeletion, useValue: handlers.ownerDeletion },
      {
        provide: HandlerOwnerPropertyChange,
        useValue: handlers.ownerPropertyChange,
      },
      { provide: HandlerDealCreation, useValue: handlers.dealCreation },
      {
        provide: HandlerDealPropertyChange,
        useValue: handlers.dealPropertyChange,
      },
      { provide: HandlerDealDeletion, useValue: handlers.dealDeletion },
      {
        provide: HandlerDealAssociationChange,
        useValue: handlers.dealAssociationChange,
      },
      {
        provide: HireRequestCreationService,
        useValue: handlers.hireRequestCreation,
      },
      {
        provide: HireRequestUpdateService,
        useValue: handlers.hireRequestUpdate,
      },
      { provide: HandlerTicketCreation, useValue: handlers.ticketCreation },
      { provide: HandlerTicketDeletion, useValue: handlers.ticketDeletion },
      { provide: HandlerTicketRestore, useValue: handlers.ticketRestore },
      {
        provide: HandlerTicketPropertyChange,
        useValue: handlers.ticketPropertyChange,
      },
      {
        provide: OrganizationCreationService,
        useValue: handlers.organizationCreationService,
      },
      {
        provide: OrganizationUpdateService,
        useValue: handlers.organizationUpdateService,
      },
      {
        provide: OwnerCreationService,
        useValue: handlers.ownerCreationService,
      },
      {
        provide: ContactCreationService,
        useValue: handlers.contactCreationService,
      },
      {
        provide: ContactFromCompanyCreationService,
        useValue: handlers.contactFromCompanyService,
      },
      {
        provide: AffiliateCreationService,
        useValue: handlers.affiliateCreationService,
      },
      {
        provide: AffiliateUpdateService,
        useValue: handlers.affiliateUpdateService,
      },
      {
        provide: ContactUpdateService,
        useValue: handlers.contactUpdateService,
      },
      {
        provide: ContactDeleteService,
        useValue: handlers.contactDeleteService,
      },
      {
        provide: CompanyDeleteService,
        useValue: handlers.companyDeleteService,
      },
      {
        provide: HandlerAffiliateCreation,
        useValue: handlers.affiliateCreation,
      },
      {
        provide: HandlerAffiliatePropertyChange,
        useValue: handlers.affiliatePropertyChange,
      },
      {
        provide: HandlerAffiliateDeletion,
        useValue: handlers.affiliateDeletion,
      },
      {
        provide: HandlerAffiliateAssociationChange,
        useValue: handlers.affiliateAssociationChange,
      },
      { provide: HandlerInvoiceCreation, useValue: handlers.invoiceCreation },
      {
        provide: HandlerInvoicePropertyChange,
        useValue: handlers.invoicePropertyChange,
      },
      {
        provide: HandlerInvoiceAssociationChange,
        useValue: handlers.invoiceAssociationChange,
      },
      {
        provide: HandlerComissionCreation,
        useValue: handlers.comissionCreation,
      },
      { provide: HandlerContactCreation, useValue: handlers.contactCreation },
      {
        provide: HandlerContactPropertyChange,
        useValue: handlers.contactPropertyChange,
      },
      { provide: HandlerContactDeletion, useValue: handlers.contactDeletion },
      { provide: HandlerContactMerge, useValue: handlers.contactMerge },
    ],
  }).compile();

  return module.get<HubspotService>(HubspotService);
}

describe('HubspotService => changeDataFromHubspot (webhook audit logging)', () => {
  let service: HubspotService;

  beforeAll(async () => {
    service = await buildModule();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset all handler mocks to resolve by default
    Object.values(handlers).forEach((h) => {
      if ('execute' in h) (h as any).execute.mockResolvedValue(undefined);
    });
  });

  // ── appId guard ──────────────────────────────────────────────────────────────

  describe('appId filtering', () => {
    it('ignores events from an unexpected appId and writes no audit log', async () => {
      process.env.HUBSPOT_APP_ID = '99999';
      await service.changeDataFromHubspot([
        { appId: 11111, subscriptionType: 'company.creation', objectId: 100 },
      ]);
      expect(auditMock.log).not.toHaveBeenCalled();
      delete process.env.HUBSPOT_APP_ID;
    });
  });

  // ── Outbound event logging (success) ─────────────────────────────────────────

  describe('company.* events → entity_type=organization', () => {
    it('company.creation → logs CREATE with actor_label=WebhookHubspot, source=webhook', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'company.creation', objectId: 200 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.organization,
          hubspotObjectType: 'companies',
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.webhook,
          success: true,
          entityId: '200',
          hubspotObjectId: '200',
        }),
      );
    });

    it('company.propertyChange → logs UPDATE', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'company.propertyChange',
          objectId: 201,
          propertyName: 'name',
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });

    it('company.deletion → logs DELETE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'company.deletion', objectId: 202 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          action: HubspotAuditAction.DELETE,
          success: true,
        }),
      );
    });

    it('company.merge → logs SYNC', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'company.merge', objectId: 203 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          action: HubspotAuditAction.SYNC,
          success: true,
        }),
      );
    });

    it('company.associationChange → logs UPDATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'company.associationChange', objectId: 204 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.organization,
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });
  });

  describe('deal.* events → entity_type=deal', () => {
    it('deal.creation → logs CREATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'deal.creation', objectId: 300 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.deal,
          hubspotObjectType: 'deals',
          action: HubspotAuditAction.CREATE,
          success: true,
        }),
      );
    });

    it('deal.propertyChange → logs UPDATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'deal.propertyChange', objectId: 301 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.deal,
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });

    it('deal.deletion → logs DELETE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'deal.deletion', objectId: 302 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.deal,
          action: HubspotAuditAction.DELETE,
          success: true,
        }),
      );
    });
  });

  describe('ticket.* events → entity_type=hire_request', () => {
    it('ticket.deletion → logs DELETE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'ticket.deletion', objectId: 400 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.hire_request,
          hubspotObjectType: 'tickets',
          action: HubspotAuditAction.DELETE,
          success: true,
        }),
      );
    });

    it('ticket.propertyChange → logs UPDATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'ticket.propertyChange', objectId: 401 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.hire_request,
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });
  });

  describe('contact.* events → entity_type=contact', () => {
    it('contact.creation → logs CREATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'contact.creation', objectId: 500 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.contact,
          hubspotObjectType: 'contacts',
          action: HubspotAuditAction.CREATE,
          success: true,
        }),
      );
    });

    it('contact.propertyChange → logs UPDATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'contact.propertyChange', objectId: 501 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });

    it('contact.deletion → logs DELETE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'contact.deletion', objectId: 502 },
      ]);

      expect(handlers.contactDeletion.execute).toHaveBeenCalledTimes(1);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          action: HubspotAuditAction.DELETE,
          success: true,
        }),
      );
    });

    it('contact.merge → logs SYNC', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'contact.merge', objectId: 503 },
      ]);

      expect(handlers.contactMerge.execute).toHaveBeenCalledTimes(1);
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.contact,
          action: HubspotAuditAction.SYNC,
          success: true,
        }),
      );
    });
  });

  describe('owners.* events → entity_type=owner', () => {
    it('owners.creation → logs CREATE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'owners.creation', objectId: 600 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.owner,
          hubspotObjectType: 'owners',
          action: HubspotAuditAction.CREATE,
          success: true,
        }),
      );
    });

    it('owners.deletion → logs DELETE', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'owners.deletion', objectId: 601 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.owner,
          action: HubspotAuditAction.DELETE,
          success: true,
        }),
      );
    });
  });

  describe('object.* events → entity_type based on objectTypeId', () => {
    it('object.creation with objectTypeId=2-5922196 → entity_type=candidate', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.creation',
          objectTypeId: '2-5922196',
          objectId: 700,
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.candidate,
          action: HubspotAuditAction.CREATE,
          success: true,
        }),
      );
    });

    it('object.deletion with objectTypeId=2-5922196 → logs DELETE for candidate', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.deletion',
          objectTypeId: '2-5922196',
          objectId: 701,
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.candidate,
          action: HubspotAuditAction.DELETE,
          success: true,
        }),
      );
    });

    it('object.merge with objectTypeId=2-5922196 → logs SYNC for candidate', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.merge',
          objectTypeId: '2-5922196',
          objectId: 702,
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.candidate,
          action: HubspotAuditAction.SYNC,
          success: true,
        }),
      );
    });

    it('object.creation with objectTypeId=2-54072002 → entity_type=affiliate', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.creation',
          objectTypeId: '2-54072002',
          objectId: 710,
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.affiliate,
          hubspotObjectType: 'p20630393_growth_partners',
          action: HubspotAuditAction.CREATE,
          success: true,
        }),
      );
    });

    it('object.creation with objectTypeId=0-53 → entity_type=invoice', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.creation',
          objectTypeId: '0-53',
          objectId: 720,
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.invoice,
          hubspotObjectType: '0-53',
          action: HubspotAuditAction.CREATE,
          success: true,
        }),
      );
    });

    it('object.associationChange with associationTypeId=179 → entity_type=invoice, action=UPDATE', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.associationChange',
          associationTypeId: '179',
          objectId: 721,
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.invoice,
          action: HubspotAuditAction.UPDATE,
          success: true,
        }),
      );
    });

    it('object.* with unknown objectTypeId → no audit log written', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'object.creation',
          objectTypeId: '99-UNKNOWN',
          objectId: 730,
        },
      ]);

      expect(auditMock.log).not.toHaveBeenCalled();
    });
  });

  // ── Failure path: handler throws → audit success=false + error re-thrown ─────

  describe('handler failure', () => {
    it('logs success=false with error details when company.creation handler throws', async () => {
      handlers.organizationCreation.execute.mockRejectedValueOnce(
        Object.assign(new Error('DB write failed'), { status: 500 }),
      );

      await expect(
        service.changeDataFromHubspot([
          { subscriptionType: 'company.creation', objectId: 800 },
        ]),
      ).rejects.toThrow('DB write failed');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorLabel: 'WebhookHubspot',
          entityType: HubspotEntityType.organization,
          action: HubspotAuditAction.CREATE,
          source: HubspotAuditSource.webhook,
          success: false,
          errorMessage: 'DB write failed',
        }),
      );
    });

    it('logs success=false when deal.deletion handler throws', async () => {
      handlers.dealDeletion.execute.mockRejectedValueOnce(
        new Error('Deal not found'),
      );

      await expect(
        service.changeDataFromHubspot([
          { subscriptionType: 'deal.deletion', objectId: 801 },
        ]),
      ).rejects.toThrow('Deal not found');

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: HubspotEntityType.deal,
          action: HubspotAuditAction.DELETE,
          success: false,
          errorMessage: 'Deal not found',
        }),
      );
    });

    it('re-throws the original handler error so the caller gets the real exception', async () => {
      const originalError = new Error('Something broke');
      handlers.ticketDeletion.execute.mockRejectedValueOnce(originalError);

      await expect(
        service.changeDataFromHubspot([
          { subscriptionType: 'ticket.deletion', objectId: 802 },
        ]),
      ).rejects.toThrow(originalError);
    });

    it('does NOT write an audit log when event meta cannot be resolved (unknown type + throws)', async () => {
      // An event with unknown subscriptionType that somehow throws inside the switch default
      // Since there's no matching case, no handler runs and meta=null → no log written.
      await service.changeDataFromHubspot([
        { subscriptionType: 'unknown.event', objectId: 900 },
      ]);

      expect(auditMock.log).not.toHaveBeenCalled();
    });
  });

  // ── actor fields ─────────────────────────────────────────────────────────────

  describe('actor fields for webhook events', () => {
    it('always sets actor_label=WebhookHubspot and actor_user_id is not present', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'company.propertyChange', objectId: 1000 },
      ]);

      const callArgs = auditMock.log.mock.calls[0][0];
      expect(callArgs.actorLabel).toBe('WebhookHubspot');
      expect(callArgs.actorUserId).toBeUndefined();
    });

    it('includes subscriptionType and objectId in the audit payload', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'deal.creation', objectId: 1001 },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subscriptionType: 'deal.creation',
            objectId: 1001,
          }),
        }),
      );
    });

    it('includes propertyName in payload for propertyChange events', async () => {
      await service.changeDataFromHubspot([
        {
          subscriptionType: 'company.propertyChange',
          objectId: 1002,
          propertyName: 'address',
        },
      ]);

      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ propertyName: 'address' }),
        }),
      );
    });
  });

  // ── multiple events in one batch ─────────────────────────────────────────────

  describe('batch processing', () => {
    it('logs one audit entry per event when multiple events arrive', async () => {
      await service.changeDataFromHubspot([
        { subscriptionType: 'company.creation', objectId: 1100 },
        { subscriptionType: 'deal.deletion', objectId: 1101 },
      ]);

      expect(auditMock.log).toHaveBeenCalledTimes(2);
    });

    it('continues processing remaining events even when one succeeds and the next would have been logged', async () => {
      // Both handlers succeed; both should be audited
      await service.changeDataFromHubspot([
        { subscriptionType: 'ticket.deletion', objectId: 1200 },
        { subscriptionType: 'ticket.propertyChange', objectId: 1201 },
      ]);

      const calls = auditMock.log.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[0][0].action).toBe(HubspotAuditAction.DELETE);
      expect(calls[1][0].action).toBe(HubspotAuditAction.UPDATE);
    });
  });
});
