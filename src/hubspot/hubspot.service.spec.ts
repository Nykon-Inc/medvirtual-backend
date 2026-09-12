import { Test, TestingModule } from '@nestjs/testing';
import { HubspotService } from './hubspot.service';
import { GoogledriveService } from '../googledrive/googledrive.service';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { HandlerObjectCreation } from './handlers/objectCreation';
import { HandlerObjectPropertyChange } from './handlers/objectPropertyChange';
import { HandlerObjectDeletion } from './handlers/objectDeletion';
import { CandidatesService } from '../candidate/candidates.service';
import { HandlerOrganizationCreation } from './handlers/organizationCreation';
import { HandlerOrganizationPropertyChange } from './handlers/organizationPropertyChange';
import { HandlerOrganizationDeletion } from './handlers/organizationDeletion';
import { HandlerOrganizationRestore } from './handlers/organizationRestore';
import { HandlerOrganizationAssociationChange } from './handlers/organizationAssociationChange';
import { HandlerOrganizationMerge } from './handlers/organizationMerge';
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

import { HandlerAffiliateCreation } from './handlers/affiliateCreation';
import { HandlerAffiliatePropertyChange } from './handlers/affiliatePropertyChange';
import { HandlerAffiliateDeletion } from './handlers/affiliateDeletion';
import { HandlerAffiliateAssociationChange } from './handlers/affiliateAssociationChange';

import { HandlerInvoiceCreation } from './handlers/invoiceCreation';
import { HandlerInvoicePropertyChange } from './handlers/invoicePropertyChange';
import { HandlerInvoiceAssociationChange } from './handlers/invoiceAssociationChange';

import { HandlerComissionCreation } from './handlers/comissionCreation';

import { OrganizationCreationService } from './create/Organization';
import { HandlerObjectMerge } from './handlers/objectMerge';
import { OwnerCreationService } from './create/Owner';
import { AffiliateCreationService } from './create/affiliate';
import { AffiliateUpdateService } from './update/affiliate';

import { OrganizationUpdateService } from './update/organization';
import { ContactCreationService } from './create/contact';
import { ContactFromCompanyCreationService } from './create/contactFromCompany';
import { ContactUpdateService } from './update/contact';
import { ContactDeleteService } from './delete/contact';
import { CompanyDeleteService } from './delete/company';
import { HandlerContactCreation } from './handlers/contactCreation';
import { HandlerContactPropertyChange } from './handlers/contactPropertyChange';
import { HandlerContactDeletion } from './handlers/contactDeletion';
import { HandlerContactMerge } from './handlers/contactMerge';
import { HubspotAuditService } from './hubspot-audit.service';
import { CandidateAuditService } from '../candidate/candidate-audit.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    patch: jest.fn(),
    get: jest.fn(),
  },
}));

const doSearchMock = jest.fn();
const clientMock = {
  crm: {
    objects: {
      searchApi: {
        doSearch: doSearchMock,
      },
    },
  },
};
jest.mock('@hubspot/api-client', () => {
  return {
    Client: jest.fn().mockImplementation(() => clientMock),
  };
});

const googleMock = {
  downloadFile: jest.fn(),
};

const prismaMock = {
  candidate: {
    findUnique: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
};

const candidateMock = {
  processData: jest.fn(),
};

const handlerObjectCreationMock = {
  execute: jest.fn(),
};

const handlerObjectPropertyChangeMock = {
  execute: jest.fn(),
};

const handlerObjectDeletionmock = {
  execute: jest.fn(),
};

const HandlerObjectMergeMock = {
  execute: jest.fn(),
};

const HandlerOrganizationCreationMock = {
  execute: jest.fn(),
};

const HandlerOrganizationPropertyChangeMock = {
  execute: jest.fn(),
};

const HandlerOrganizationAssociationChangeMock = {
  execute: jest.fn(),
};

const HandlerOrganizationDeletionMock = {
  execute: jest.fn(),
};

const HandlerOrganizationRestoreMock = {
  execute: jest.fn(),
};

const HandlerOrganizationMergeMock = {
  execute: jest.fn(),
};

const HandlerObjectDeletionMock = {
  execute: jest.fn(),
};

const HandlerOwnerCreationMock = {
  execute: jest.fn(),
};

const HandlerOwnerPropertyChangeMock = {
  execute: jest.fn(),
};

const HandlerOwnerDeletionMock = {
  execute: jest.fn(),
};

const HandlerDealCreationMock = {
  execute: jest.fn(),
};

const HandlerDealPropertyChangeMock = {
  execute: jest.fn(),
};

const HandlerDealDeletionMock = {
  execute: jest.fn(),
};

const HandlerDealAssociationChangeMock = {
  execute: jest.fn(),
};

const HandlerTicketCreationMock = {
  execute: jest.fn(),
};

const HandlerTicketRestoreMock = {
  execute: jest.fn(),
};

const HandlerTicketDeletionMock = {
  execute: jest.fn(),
};

const HandlerTicketPropertyChangeMock = {
  execute: jest.fn(),
};

const HandlerAffiliateCreationMock = {
  execute: jest.fn(),
};

const HandlerAffiliatePropertyChangeMock = {
  execute: jest.fn(),
};

const HandlerAffiliateDeletionMock = {
  execute: jest.fn(),
};

const HandlerAffiliateAssociationChangeMock = {
  execute: jest.fn(),
};

const hireRequestCreationServiceMock = {
  execute: jest.fn(),
};

const hireRequestUpdateServiceMock = {
  execute: jest.fn(),
};

const organizationCreationServiceMock = {
  execute: jest.fn(),
};

const organizationUpdateServiceMock = {
  execute: jest.fn(),
};

const ownerCreationServiceMock = {
  execute: jest.fn(),
};

const contactCreationServiceMock = {
  execute: jest.fn(),
};

const contactCreationFromCompanyServiceMock = {
  execute: jest.fn(),
};

const affiliateCreationServiceMock = {
  execute: jest.fn(),
};

const AffiliateUpdateServiceMock = {
  deactivate: jest.fn(),
};

const updateContactServiceMock = {
  execute: jest.fn(),
};

const deleteContactServiceMock = {
  execute: jest.fn(),
};

const companyDeleteServiceMock = {
  execute: jest.fn(),
};

const HandlerInvoiceCreationMock = {
  execute: jest.fn(),
};

const HandlerInvoicePropertyChangeMock = {
  execute: jest.fn(),
};

const HandlerInvoiceAssociationChangeMock = {
  execute: jest.fn(),
};

const HandlerComissionCreationMock = {
  execute: jest.fn(),
};

const handlerContactCreationMock = {
  execute: jest.fn(),
};

const handlerContactPropertyChangeMock = {
  execute: jest.fn(),
};

const handlerContactDeletionMock = {
  execute: jest.fn(),
};

const handlerContactMergeMock = {
  execute: jest.fn(),
};

const auditServiceMock = {
  log: jest.fn(),
};

const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

jest.mock('../common/utils/hubspot.util', () => ({
  extractDriveFileId: jest.fn(),
  mapHubspotToDb: jest.fn((props: Record<string, unknown>) => ({ ...props })),
  mapOrganizationToDbHubspot: jest.fn((props: Record<string, unknown>) => ({
    ...props,
  })),
  mapContactToDb: jest.fn((props: Record<string, unknown>) => ({ ...props })),
}));

describe('HubspotService => GetCandidates', () => {
  let service: HubspotService;

  const dataFake = {
    virtualAssistant: '12345',
    filters: [
      { field: 'status', value: 'active' },
      { field: 'location', value: 'remote' },
    ],
    properties: ['name', 'email'],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HubspotService,
        { provide: GoogledriveService, useValue: googleMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: HandlerObjectCreation, useValue: handlerObjectCreationMock },
        {
          provide: HandlerObjectPropertyChange,
          useValue: handlerObjectPropertyChangeMock,
        },
        { provide: HandlerObjectDeletion, useValue: handlerObjectDeletionmock },
        { provide: HandlerObjectMerge, useValue: HandlerObjectMergeMock },
        {
          provide: HandlerOrganizationCreation,
          useValue: HandlerOrganizationCreationMock,
        },
        {
          provide: HandlerOrganizationPropertyChange,
          useValue: HandlerOrganizationPropertyChangeMock,
        },
        {
          provide: HandlerOrganizationAssociationChange,
          useValue: HandlerOrganizationAssociationChangeMock,
        },
        {
          provide: HandlerOrganizationDeletion,
          useValue: HandlerOrganizationDeletionMock,
        },
        {
          provide: HandlerOrganizationRestore,
          useValue: HandlerOrganizationRestoreMock,
        },
        {
          provide: HandlerOrganizationMerge,
          useValue: HandlerOrganizationMergeMock,
        },
        { provide: HandlerOwnerCreation, useValue: HandlerOwnerCreationMock },
        { provide: HandlerOwnerDeletion, useValue: HandlerOwnerDeletionMock },
        {
          provide: HandlerOwnerPropertyChange,
          useValue: HandlerOwnerPropertyChangeMock,
        },
        { provide: CandidatesService, useValue: candidateMock },
        { provide: HandlerDealCreation, useValue: HandlerDealCreationMock },
        {
          provide: HandlerDealPropertyChange,
          useValue: HandlerDealPropertyChangeMock,
        },
        { provide: HandlerDealDeletion, useValue: HandlerDealDeletionMock },
        {
          provide: HandlerDealAssociationChange,
          useValue: HandlerDealAssociationChangeMock,
        },
        {
          provide: HireRequestCreationService,
          useValue: hireRequestCreationServiceMock,
        },
        {
          provide: HireRequestUpdateService,
          useValue: hireRequestUpdateServiceMock,
        },
        { provide: HandlerTicketCreation, useValue: HandlerTicketCreationMock },
        { provide: HandlerTicketDeletion, useValue: HandlerTicketDeletionMock },
        { provide: HandlerTicketRestore, useValue: HandlerTicketRestoreMock },
        {
          provide: HandlerTicketPropertyChange,
          useValue: HandlerTicketPropertyChangeMock,
        },
        {
          provide: OrganizationCreationService,
          useValue: organizationCreationServiceMock,
        },
        {
          provide: OrganizationUpdateService,
          useValue: organizationUpdateServiceMock,
        },
        { provide: OwnerCreationService, useValue: ownerCreationServiceMock },
        {
          provide: ContactCreationService,
          useValue: contactCreationServiceMock,
        },
        {
          provide: ContactFromCompanyCreationService,
          useValue: contactCreationFromCompanyServiceMock,
        },
        { provide: ContactUpdateService, useValue: updateContactServiceMock },
        { provide: ContactDeleteService, useValue: deleteContactServiceMock },
        { provide: CompanyDeleteService, useValue: companyDeleteServiceMock },
        {
          provide: HandlerAffiliateCreation,
          useValue: HandlerAffiliateCreationMock,
        },
        {
          provide: HandlerAffiliatePropertyChange,
          useValue: HandlerAffiliatePropertyChangeMock,
        },
        {
          provide: HandlerAffiliateDeletion,
          useValue: HandlerAffiliateDeletionMock,
        },
        {
          provide: HandlerAffiliateAssociationChange,
          useValue: HandlerAffiliateAssociationChangeMock,
        },
        {
          provide: HandlerInvoiceCreation,
          useValue: HandlerInvoiceCreationMock,
        },
        {
          provide: HandlerInvoicePropertyChange,
          useValue: HandlerInvoicePropertyChangeMock,
        },
        {
          provide: HandlerInvoiceAssociationChange,
          useValue: HandlerInvoiceAssociationChangeMock,
        },
        {
          provide: HandlerComissionCreation,
          useValue: HandlerComissionCreationMock,
        },
        {
          provide: AffiliateCreationService,
          useValue: affiliateCreationServiceMock,
        },
        {
          provide: AffiliateUpdateService,
          useValue: AffiliateUpdateServiceMock,
        },
        {
          provide: HandlerContactCreation,
          useValue: handlerContactCreationMock,
        },
        {
          provide: HandlerContactPropertyChange,
          useValue: handlerContactPropertyChangeMock,
        },
        {
          provide: HandlerContactDeletion,
          useValue: handlerContactDeletionMock,
        },
        { provide: HandlerContactMerge, useValue: handlerContactMergeMock },
        { provide: HubspotAuditService, useValue: auditServiceMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    service = module.get<HubspotService>(HubspotService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return 400 if the vitual Assistant is not provided', async () => {
    const dataFakeWithoutData = {
      virtualAssistant: '',
      filters: [
        { field: 'status', value: 'active' },
        { field: 'location', value: 'remote' },
      ],
      properties: ['name', 'email'],
    };

    await expect(service.getCandidates(dataFakeWithoutData)).rejects.toThrow(
      'Virtual Assistant identifier is required',
    );
  });

  it('should return 400 if the fetch candidates fails', async () => {
    const mockError = new Error('Hubspot API error');
    doSearchMock.mockRejectedValue(mockError);

    await expect(service.getCandidates(dataFake)).rejects.toThrow(
      'Error fetching candidates',
    );
  });
});

// test HubspotService => changeDataFromHubspot

describe('HubspotService => changeDataToHubspot', () => {
  let service: HubspotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HubspotService,
        { provide: GoogledriveService, useValue: googleMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: HandlerObjectCreation, useValue: handlerObjectCreationMock },
        {
          provide: HandlerObjectPropertyChange,
          useValue: handlerObjectPropertyChangeMock,
        },
        { provide: HandlerObjectDeletion, useValue: handlerObjectDeletionmock },
        { provide: HandlerObjectMerge, useValue: HandlerObjectMergeMock },
        {
          provide: HandlerOrganizationCreation,
          useValue: HandlerOrganizationCreationMock,
        },
        {
          provide: HandlerOrganizationPropertyChange,
          useValue: HandlerOrganizationPropertyChangeMock,
        },
        {
          provide: HandlerOrganizationAssociationChange,
          useValue: HandlerOrganizationAssociationChangeMock,
        },
        {
          provide: HandlerOrganizationDeletion,
          useValue: HandlerOrganizationDeletionMock,
        },
        {
          provide: HandlerOrganizationRestore,
          useValue: HandlerOrganizationRestoreMock,
        },
        {
          provide: HandlerOrganizationMerge,
          useValue: HandlerOrganizationMergeMock,
        },
        { provide: HandlerOwnerCreation, useValue: HandlerOwnerCreationMock },
        { provide: HandlerOwnerDeletion, useValue: HandlerOwnerDeletionMock },
        {
          provide: HandlerOwnerPropertyChange,
          useValue: HandlerOwnerPropertyChangeMock,
        },
        { provide: CandidatesService, useValue: candidateMock },
        { provide: HandlerDealCreation, useValue: HandlerDealCreationMock },
        {
          provide: HandlerDealPropertyChange,
          useValue: HandlerDealPropertyChangeMock,
        },
        { provide: HandlerDealDeletion, useValue: HandlerDealDeletionMock },
        {
          provide: HandlerDealAssociationChange,
          useValue: HandlerDealAssociationChangeMock,
        },
        {
          provide: HireRequestCreationService,
          useValue: hireRequestCreationServiceMock,
        },
        {
          provide: HireRequestUpdateService,
          useValue: hireRequestUpdateServiceMock,
        },
        { provide: HandlerTicketCreation, useValue: HandlerTicketCreationMock },
        { provide: HandlerTicketDeletion, useValue: HandlerTicketDeletionMock },
        { provide: HandlerTicketRestore, useValue: HandlerTicketRestoreMock },
        {
          provide: HandlerTicketPropertyChange,
          useValue: HandlerTicketPropertyChangeMock,
        },
        {
          provide: OrganizationCreationService,
          useValue: organizationCreationServiceMock,
        },
        {
          provide: OrganizationUpdateService,
          useValue: organizationUpdateServiceMock,
        },
        { provide: OwnerCreationService, useValue: ownerCreationServiceMock },
        {
          provide: ContactCreationService,
          useValue: contactCreationServiceMock,
        },
        {
          provide: ContactFromCompanyCreationService,
          useValue: contactCreationFromCompanyServiceMock,
        },
        { provide: ContactUpdateService, useValue: updateContactServiceMock },
        { provide: ContactDeleteService, useValue: deleteContactServiceMock },
        { provide: CompanyDeleteService, useValue: companyDeleteServiceMock },
        {
          provide: HandlerAffiliateCreation,
          useValue: HandlerAffiliateCreationMock,
        },
        {
          provide: HandlerAffiliatePropertyChange,
          useValue: HandlerAffiliatePropertyChangeMock,
        },
        {
          provide: HandlerAffiliateDeletion,
          useValue: HandlerAffiliateDeletionMock,
        },
        {
          provide: HandlerAffiliateAssociationChange,
          useValue: HandlerAffiliateAssociationChangeMock,
        },
        {
          provide: HandlerInvoiceCreation,
          useValue: HandlerInvoiceCreationMock,
        },
        {
          provide: HandlerInvoicePropertyChange,
          useValue: HandlerInvoicePropertyChangeMock,
        },
        {
          provide: HandlerInvoiceAssociationChange,
          useValue: HandlerInvoiceAssociationChangeMock,
        },
        {
          provide: HandlerComissionCreation,
          useValue: HandlerComissionCreationMock,
        },
        {
          provide: AffiliateCreationService,
          useValue: affiliateCreationServiceMock,
        },
        {
          provide: AffiliateUpdateService,
          useValue: AffiliateUpdateServiceMock,
        },
        {
          provide: HandlerContactCreation,
          useValue: handlerContactCreationMock,
        },
        {
          provide: HandlerContactPropertyChange,
          useValue: handlerContactPropertyChangeMock,
        },
        {
          provide: HandlerContactDeletion,
          useValue: handlerContactDeletionMock,
        },
        { provide: HandlerContactMerge, useValue: handlerContactMergeMock },
        { provide: HubspotAuditService, useValue: auditServiceMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    service = module.get<HubspotService>(HubspotService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return 400 if data is not provided', async () => {
    const dataFake = {
      properties: [{ field: 'status', value: 'active' }],
    };
    await expect(service.changeDataToHubspot('', dataFake)).rejects.toThrow(
      'Object ID is required',
    );
  });

  it('Should return true if data is changed successfully', async () => {
    const dataFake = {
      properties: [{ field: 'status', value: 'active' }],
    };

    (axios.patch as jest.Mock).mockResolvedValue({ status: 200 });

    const result = await service.changeDataToHubspot('12345', dataFake);
    expect(result).toBe(true);
  });

  it('should throw BadRequestException when axios.patch fails', async () => {
    const dataFake = {
      properties: [{ field: 'status', value: 'active' }],
    };

    (axios.patch as jest.Mock).mockRejectedValue(new Error('Network error'));

    await expect(
      service.changeDataToHubspot('12345', dataFake),
    ).rejects.toThrow('Error updating data in HubSpot');
  });
});

// ─── Shared module setup helper ──────────────────────────────────────────────

function buildProviders(): any[] {
  return [
    HubspotService,
    { provide: GoogledriveService, useValue: googleMock },
    { provide: PrismaService, useValue: prismaMock },
    { provide: HandlerObjectCreation, useValue: handlerObjectCreationMock },
    {
      provide: HandlerObjectPropertyChange,
      useValue: handlerObjectPropertyChangeMock,
    },
    { provide: HandlerObjectDeletion, useValue: handlerObjectDeletionmock },
    { provide: HandlerObjectMerge, useValue: HandlerObjectMergeMock },
    {
      provide: HandlerOrganizationCreation,
      useValue: HandlerOrganizationCreationMock,
    },
    {
      provide: HandlerOrganizationPropertyChange,
      useValue: HandlerOrganizationPropertyChangeMock,
    },
    {
      provide: HandlerOrganizationAssociationChange,
      useValue: HandlerOrganizationAssociationChangeMock,
    },
    {
      provide: HandlerOrganizationDeletion,
      useValue: HandlerOrganizationDeletionMock,
    },
    {
      provide: HandlerOrganizationRestore,
      useValue: HandlerOrganizationRestoreMock,
    },
    {
      provide: HandlerOrganizationMerge,
      useValue: HandlerOrganizationMergeMock,
    },
    { provide: HandlerOwnerCreation, useValue: HandlerOwnerCreationMock },
    { provide: HandlerOwnerDeletion, useValue: HandlerOwnerDeletionMock },
    {
      provide: HandlerOwnerPropertyChange,
      useValue: HandlerOwnerPropertyChangeMock,
    },
    { provide: CandidatesService, useValue: candidateMock },
    { provide: HandlerDealCreation, useValue: HandlerDealCreationMock },
    {
      provide: HandlerDealPropertyChange,
      useValue: HandlerDealPropertyChangeMock,
    },
    { provide: HandlerDealDeletion, useValue: HandlerDealDeletionMock },
    {
      provide: HandlerDealAssociationChange,
      useValue: HandlerDealAssociationChangeMock,
    },
    {
      provide: HireRequestCreationService,
      useValue: hireRequestCreationServiceMock,
    },
    {
      provide: HireRequestUpdateService,
      useValue: hireRequestUpdateServiceMock,
    },
    { provide: HandlerTicketCreation, useValue: HandlerTicketCreationMock },
    { provide: HandlerTicketDeletion, useValue: HandlerTicketDeletionMock },
    { provide: HandlerTicketRestore, useValue: HandlerTicketRestoreMock },
    {
      provide: HandlerTicketPropertyChange,
      useValue: HandlerTicketPropertyChangeMock,
    },
    {
      provide: OrganizationCreationService,
      useValue: organizationCreationServiceMock,
    },
    {
      provide: OrganizationUpdateService,
      useValue: organizationUpdateServiceMock,
    },
    { provide: OwnerCreationService, useValue: ownerCreationServiceMock },
    { provide: ContactCreationService, useValue: contactCreationServiceMock },
    {
      provide: ContactFromCompanyCreationService,
      useValue: contactCreationFromCompanyServiceMock,
    },
    { provide: ContactUpdateService, useValue: updateContactServiceMock },
    { provide: ContactDeleteService, useValue: deleteContactServiceMock },
    { provide: CompanyDeleteService, useValue: companyDeleteServiceMock },
    {
      provide: HandlerAffiliateCreation,
      useValue: HandlerAffiliateCreationMock,
    },
    {
      provide: HandlerAffiliatePropertyChange,
      useValue: HandlerAffiliatePropertyChangeMock,
    },
    {
      provide: HandlerAffiliateDeletion,
      useValue: HandlerAffiliateDeletionMock,
    },
    {
      provide: HandlerAffiliateAssociationChange,
      useValue: HandlerAffiliateAssociationChangeMock,
    },
    { provide: HandlerInvoiceCreation, useValue: HandlerInvoiceCreationMock },
    {
      provide: HandlerInvoicePropertyChange,
      useValue: HandlerInvoicePropertyChangeMock,
    },
    {
      provide: HandlerInvoiceAssociationChange,
      useValue: HandlerInvoiceAssociationChangeMock,
    },
    {
      provide: HandlerComissionCreation,
      useValue: HandlerComissionCreationMock,
    },
    {
      provide: AffiliateCreationService,
      useValue: affiliateCreationServiceMock,
    },
    { provide: AffiliateUpdateService, useValue: AffiliateUpdateServiceMock },
    { provide: HandlerContactCreation, useValue: handlerContactCreationMock },
    {
      provide: HandlerContactPropertyChange,
      useValue: handlerContactPropertyChangeMock,
    },
    { provide: HandlerContactDeletion, useValue: handlerContactDeletionMock },
    { provide: HandlerContactMerge, useValue: handlerContactMergeMock },
    { provide: HubspotAuditService, useValue: auditServiceMock },
    { provide: CandidateAuditService, useValue: candidateAuditMock },
  ];
}

// ─── getCandidates happy path ─────────────────────────────────────────────────

describe('HubspotService => getCandidates happy path', () => {
  let service: HubspotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  it('should return response from HubSpot when candidates are found', async () => {
    const fakeResponse = {
      results: [{ id: '1', properties: { name: 'Jane' } }],
    };
    doSearchMock.mockResolvedValue(fakeResponse);

    const result = await service.getCandidates({
      virtualAssistant: 'p20630393_Virtual_Assistant',
      filters: [{ field: 'hs_pipeline_stage', value: '1' }],
      properties: ['name'],
    });

    expect(result).toEqual(fakeResponse);
  });
});

// ─── changeDataFromHubspot ────────────────────────────────────────────────────

describe('HubspotService => changeDataFromHubspot', () => {
  let service: HubspotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
    auditServiceMock.log.mockResolvedValue(undefined);
  });

  it('should skip webhook when appId does not match expected', async () => {
    process.env.HUBSPOT_APP_ID = '9999';
    const data = [
      { appId: 1111, subscriptionType: 'company.creation', objectId: '1' },
    ];
    const result = await service.changeDataFromHubspot(data);
    expect(result).toBeUndefined();
    delete process.env.HUBSPOT_APP_ID;
  });

  it('should process object.creation for Virtual Assistant (2-5922196)', async () => {
    handlerObjectCreationMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.creation',
        objectTypeId: '2-5922196',
        objectId: '42',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(handlerObjectCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.restore for Virtual Assistant (2-5922196)', async () => {
    handlerObjectCreationMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.restore',
        objectTypeId: '2-5922196',
        objectId: '42',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(handlerObjectCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.creation for Growth Partner (2-54072002)', async () => {
    HandlerAffiliateCreationMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.creation',
        objectTypeId: '2-54072002',
        objectId: '43',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerAffiliateCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.creation for Invoice (0-53)', async () => {
    HandlerInvoiceCreationMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.creation',
        objectTypeId: '0-53',
        objectId: '44',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerInvoiceCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.propertyChange for Virtual Assistant', async () => {
    handlerObjectPropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.propertyChange',
        objectTypeId: '2-5922196',
        objectId: '42',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(handlerObjectPropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process object.propertyChange for Growth Partner', async () => {
    HandlerAffiliatePropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.propertyChange',
        objectTypeId: '2-54072002',
        objectId: '43',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerAffiliatePropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process object.propertyChange for Invoice (0-53)', async () => {
    HandlerInvoicePropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.propertyChange',
        objectTypeId: '0-53',
        objectId: '44',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerInvoicePropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process object.deletion for Virtual Assistant', async () => {
    handlerObjectDeletionmock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.deletion',
        objectTypeId: '2-5922196',
        objectId: '42',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(handlerObjectDeletionmock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.deletion for Growth Partner', async () => {
    HandlerAffiliateDeletionMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.deletion',
        objectTypeId: '2-54072002',
        objectId: '43',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerAffiliateDeletionMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.merge for Virtual Assistant', async () => {
    HandlerObjectMergeMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.merge',
        objectTypeId: '2-5922196',
        objectId: '42',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerObjectMergeMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process object.associationChange for invoice association (179)', async () => {
    HandlerInvoiceAssociationChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.associationChange',
        associationTypeId: '179',
        objectId: '50',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerInvoiceAssociationChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process object.associationChange for invoice association (180)', async () => {
    HandlerInvoiceAssociationChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.associationChange',
        associationTypeId: '180',
        objectId: '50',
      },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerInvoiceAssociationChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process owners.creation', async () => {
    HandlerOwnerCreationMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'owners.creation', objectId: '60' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOwnerCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process owners.restore', async () => {
    HandlerOwnerCreationMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'owners.restore', objectId: '60' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOwnerCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process owners.deletion', async () => {
    HandlerOwnerDeletionMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'owners.deletion', objectId: '61' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOwnerDeletionMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process owners.propertyChange', async () => {
    HandlerOwnerPropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      { subscriptionType: 'owners.propertyChange', objectId: '62' },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerOwnerPropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process company.creation', async () => {
    HandlerOrganizationCreationMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'company.creation', objectId: '70' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOrganizationCreationMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process company.restore with the restore handler, not the creation handler', async () => {
    HandlerOrganizationRestoreMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'company.restore', objectId: '70' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOrganizationRestoreMock.execute).toHaveBeenCalledWith(
      data[0],
    );
    expect(HandlerOrganizationCreationMock.execute).not.toHaveBeenCalled();
  });

  it('should process company.propertyChange', async () => {
    HandlerOrganizationPropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      { subscriptionType: 'company.propertyChange', objectId: '71' },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerOrganizationPropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process company.deletion', async () => {
    HandlerOrganizationDeletionMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'company.deletion', objectId: '72' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOrganizationDeletionMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process company.merge', async () => {
    HandlerOrganizationMergeMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'company.merge', objectId: '73' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerOrganizationMergeMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process company.associationChange', async () => {
    HandlerOrganizationAssociationChangeMock.execute.mockResolvedValue(
      undefined,
    );
    const data = [
      { subscriptionType: 'company.associationChange', objectId: '74' },
    ];
    await service.changeDataFromHubspot(data);
    expect(
      HandlerOrganizationAssociationChangeMock.execute,
    ).toHaveBeenCalledWith(data[0]);
  });

  it('should process deal.creation', async () => {
    HandlerDealCreationMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'deal.creation', objectId: '80' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerDealCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process deal.restore', async () => {
    HandlerDealCreationMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'deal.restore', objectId: '80' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerDealCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process deal.propertyChange', async () => {
    HandlerDealPropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'deal.propertyChange', objectId: '81' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerDealPropertyChangeMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process deal.deletion', async () => {
    HandlerDealDeletionMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'deal.deletion', objectId: '82' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerDealDeletionMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process deal.associationChange', async () => {
    HandlerDealAssociationChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      { subscriptionType: 'deal.associationChange', objectId: '83' },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerDealAssociationChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process ticket.deletion', async () => {
    HandlerTicketDeletionMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'ticket.deletion', objectId: '90' }];
    await service.changeDataFromHubspot(data);
    expect(HandlerTicketDeletionMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process ticket.propertyChange', async () => {
    HandlerTicketPropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      { subscriptionType: 'ticket.propertyChange', objectId: '91' },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerTicketPropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process contact.creation', async () => {
    handlerContactCreationMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'contact.creation', objectId: '100' }];
    await service.changeDataFromHubspot(data);
    expect(handlerContactCreationMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process contact.propertyChange', async () => {
    handlerContactPropertyChangeMock.execute.mockResolvedValue(undefined);
    const data = [
      { subscriptionType: 'contact.propertyChange', objectId: '101' },
    ];
    await service.changeDataFromHubspot(data);
    expect(handlerContactPropertyChangeMock.execute).toHaveBeenCalledWith(
      data[0],
    );
  });

  it('should process contact.deletion', async () => {
    handlerContactDeletionMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'contact.deletion', objectId: '102' }];
    await service.changeDataFromHubspot(data);
    expect(handlerContactDeletionMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should process contact.merge', async () => {
    handlerContactMergeMock.execute.mockResolvedValue(undefined);
    const data = [{ subscriptionType: 'contact.merge', objectId: '103' }];
    await service.changeDataFromHubspot(data);
    expect(handlerContactMergeMock.execute).toHaveBeenCalledWith(data[0]);
  });

  it('should sort multiple events before processing', async () => {
    handlerObjectCreationMock.execute.mockResolvedValue(undefined);
    HandlerDealCreationMock.execute.mockResolvedValue(undefined);
    const data = [
      {
        subscriptionType: 'object.creation',
        objectTypeId: '2-5922196',
        objectId: '1',
      },
      { subscriptionType: 'deal.creation', objectId: '2' },
    ];
    await service.changeDataFromHubspot(data);
    expect(handlerObjectCreationMock.execute).toHaveBeenCalled();
    expect(HandlerDealCreationMock.execute).toHaveBeenCalled();
  });

  it('should log audit failure and rethrow when handler throws', async () => {
    const handlerError = new Error('handler failure');
    HandlerOrganizationCreationMock.execute.mockRejectedValue(handlerError);
    auditServiceMock.log.mockResolvedValue(undefined);

    const data = [{ subscriptionType: 'company.creation', objectId: '70' }];
    await expect(service.changeDataFromHubspot(data)).rejects.toThrow(
      'handler failure',
    );
  });

  it('should handle unknown subscriptionType gracefully (no handler called)', async () => {
    const data = [{ subscriptionType: 'unknown.event', objectId: '999' }];
    await expect(service.changeDataFromHubspot(data)).resolves.toBeUndefined();
  });
});

// ─── updateManyCandidatesFromHireRequest ─────────────────────────────────────

describe('HubspotService => updateManyCandidatesFromHireRequest', () => {
  let service: HubspotService;

  const batchUpdateMock = jest.fn();

  beforeEach(async () => {
    const extendedClientMock = {
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: batchUpdateMock },
          basicApi: { update: jest.fn() },
        },
      },
    };
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => extendedClientMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
    auditServiceMock.log.mockResolvedValue(undefined);
  });

  it('should return true when batch update succeeds', async () => {
    process.env.HUBSPOT_CUSTOM_OBJECT = '2-5922196';
    batchUpdateMock.mockResolvedValue({});

    const candidates = [{ hubspot_id: 'hs1' }, { hubspot_id: 'hs2' }];
    const result = await service.updateManyCandidatesFromHireRequest(
      candidates,
      'stage1',
      'user-1',
      'hr-1',
    );

    expect(result).toBe(true);
    expect(batchUpdateMock).toHaveBeenCalled();
  });

  it('should throw BadRequestException when batch update fails', async () => {
    process.env.HUBSPOT_CUSTOM_OBJECT = '2-5922196';
    batchUpdateMock.mockRejectedValue(new Error('batch error'));

    const candidates = [{ hubspot_id: 'hs1' }];
    await expect(
      service.updateManyCandidatesFromHireRequest(candidates, 'stage1'),
    ).rejects.toThrow('Error updating data in HubSpot');
  });

  it('should throw NotFoundException when HUBSPOT_CUSTOM_OBJECT is not set', async () => {
    delete process.env.HUBSPOT_CUSTOM_OBJECT;

    const candidates = [{ hubspot_id: 'hs1' }];
    await expect(
      service.updateManyCandidatesFromHireRequest(candidates, 'stage1'),
    ).rejects.toThrow('Custom Object is not defined');
  });
});

// ─── updateOneCandidateFromHireRequest ───────────────────────────────────────

describe('HubspotService => updateOneCandidateFromHireRequest', () => {
  let service: HubspotService;

  const basicUpdateMock = jest.fn();

  beforeEach(async () => {
    const extendedClientMock = {
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: basicUpdateMock },
        },
      },
    };
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => extendedClientMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
    auditServiceMock.log.mockResolvedValue(undefined);
  });

  it('should return true when single candidate update succeeds', async () => {
    process.env.HUBSPOT_CUSTOM_OBJECT = '2-5922196';
    basicUpdateMock.mockResolvedValue({});

    const result = await service.updateOneCandidateFromHireRequest(
      'hs-42',
      'stage2',
      'user-1',
    );

    expect(result).toBe(true);
    expect(basicUpdateMock).toHaveBeenCalled();
  });

  it('should throw BadRequestException when single candidate update fails', async () => {
    process.env.HUBSPOT_CUSTOM_OBJECT = '2-5922196';
    basicUpdateMock.mockRejectedValue(new Error('update error'));

    await expect(
      service.updateOneCandidateFromHireRequest('hs-42', 'stage2'),
    ).rejects.toThrow('Error updating data in HubSpot');
  });

  it('should throw NotFoundException when HUBSPOT_CUSTOM_OBJECT is not set', async () => {
    delete process.env.HUBSPOT_CUSTOM_OBJECT;

    await expect(
      service.updateOneCandidateFromHireRequest('hs-42', 'stage2'),
    ).rejects.toThrow('Custom Object is not defined');
  });
});

// ─── Delegation methods ───────────────────────────────────────────────────────

describe('HubspotService => delegation methods', () => {
  let service: HubspotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  it('createHireRequestInHubspot should delegate to hireRequestCreationService', async () => {
    hireRequestCreationServiceMock.execute.mockResolvedValue({
      id: 'hs-ticket-1',
    });
    const result = await service.createHireRequestInHubspot(
      { title: 'req' },
      'user-1',
    );
    expect(result).toEqual({ id: 'hs-ticket-1' });
    expect(hireRequestCreationServiceMock.execute).toHaveBeenCalledWith(
      { title: 'req' },
      'user-1',
      undefined,
    );
  });

  it('updateHireRequestInHubspot should delegate to hireRequestUpdateService', async () => {
    hireRequestUpdateServiceMock.execute.mockResolvedValue({
      id: 'hs-ticket-1',
    });
    const result = await service.updateHireRequestInHubspot(
      { id: 'r1' },
      'status',
      'user-1',
    );
    expect(result).toEqual({ id: 'hs-ticket-1' });
    expect(hireRequestUpdateServiceMock.execute).toHaveBeenCalledWith(
      { id: 'r1' },
      'status',
      'user-1',
      undefined,
    );
  });

  it('createOrganizationInHubspot should delegate to organizationCreationService', async () => {
    organizationCreationServiceMock.execute.mockResolvedValue({
      id: 'hs-co-1',
    });
    const result = await service.createOrganizationInHubspot(
      { name: 'Clinic' },
      'user-1',
    );
    expect(result).toEqual({ id: 'hs-co-1' });
    expect(organizationCreationServiceMock.execute).toHaveBeenCalledWith(
      { name: 'Clinic' },
      'user-1',
      undefined,
    );
  });

  it('updateOrganizationInHubspot should delegate to organizationUpdateService', async () => {
    organizationUpdateServiceMock.execute.mockResolvedValue(undefined);
    await service.updateOrganizationInHubspot({ id: 'org-1' }, 'user-1');
    expect(organizationUpdateServiceMock.execute).toHaveBeenCalledWith(
      { id: 'org-1' },
      'user-1',
      undefined,
    );
  });

  it('createContactInHubspot should delegate to contactCreationService', async () => {
    contactCreationServiceMock.execute.mockResolvedValue({ id: 'hs-ct-1' });
    const result = await service.createContactInHubspot(
      { email: 'a@b.com' },
      'user-1',
    );
    expect(result).toEqual({ id: 'hs-ct-1' });
    expect(contactCreationServiceMock.execute).toHaveBeenCalledWith(
      { email: 'a@b.com' },
      'user-1',
      undefined,
    );
  });

  it('createContactFromReferredCompanyInHubspot should delegate to contactCreationFromCompanyService', async () => {
    contactCreationFromCompanyServiceMock.execute.mockResolvedValue({
      id: 'hs-ct-2',
    });
    const result = await service.createContactFromReferredCompanyInHubspot(
      { companyId: 'c1' },
      'user-1',
    );
    expect(result).toEqual({ id: 'hs-ct-2' });
    expect(contactCreationFromCompanyServiceMock.execute).toHaveBeenCalledWith(
      { companyId: 'c1' },
      'user-1',
    );
  });

  it('updateContactInHubspot should delegate to contactUpdateService', async () => {
    updateContactServiceMock.execute.mockResolvedValue(undefined);
    await service.updateContactInHubspot({ id: 'ct-1' }, 'user-1');
    expect(updateContactServiceMock.execute).toHaveBeenCalledWith(
      { id: 'ct-1' },
      'user-1',
      undefined,
    );
  });

  it('deleteContactInHubspot should delegate to contactDeleteService', async () => {
    deleteContactServiceMock.execute.mockResolvedValue(undefined);
    await service.deleteContactInHubspot({ id: 'ct-1' }, 'user-1');
    expect(deleteContactServiceMock.execute).toHaveBeenCalledWith(
      { id: 'ct-1' },
      'user-1',
      undefined,
    );
  });

  it('deleteCompanyInHubspot should delegate to companyDeleteService', async () => {
    companyDeleteServiceMock.execute.mockResolvedValue(true);
    const result = await service.deleteCompanyInHubspot(
      'hs-co-1',
      'user-1',
      'org-1',
    );
    expect(result).toBe(true);
    expect(companyDeleteServiceMock.execute).toHaveBeenCalledWith(
      'hs-co-1',
      'user-1',
      'org-1',
      undefined,
    );
  });
});

// ─── createCandidates ─────────────────────────────────────────────────────────

describe('HubspotService => createCandidates', () => {
  let service: HubspotService;

  beforeEach(async () => {
    const extendedClientMock = {
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    };
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => extendedClientMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders(),
        {
          provide: PrismaService,
          useValue: {
            candidate: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
            },
            candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
            candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
            organization: { findMany: jest.fn(), update: jest.fn() },
            contact: { findUnique: jest.fn(), create: jest.fn() },
            uSER: {
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
    auditServiceMock.log.mockResolvedValue(undefined);
  });

  it('should throw BadRequestException when no candidates found in HubSpot', async () => {
    doSearchMock.mockResolvedValue({ results: [], total: 0 });
    await expect(service.createCandidates('stage1')).rejects.toThrow(
      'No candidates data found',
    );
  });

  it('should create candidate when not found in DB and return success message', async () => {
    const fakePrisma = {
      candidate: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-id' }),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
      candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
      organization: { findMany: jest.fn(), update: jest.fn() },
      contact: { findUnique: jest.fn(), create: jest.fn() },
      uSER: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const extendedClientMock = {
      crm: {
        objects: {
          searchApi: {
            doSearch: jest.fn().mockResolvedValue({
              results: [
                {
                  properties: {
                    hs_object_id: '111',
                    name: 'Test VA',
                    career_highlights_relevant_job_experiences: 'skill1;skill2',
                    language_spoken: 'English&Spanish',
                  },
                },
              ],
              total: 1,
            }),
          },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    };
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => extendedClientMock);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    const svc = module.get<HubspotService>(HubspotService);

    const result = await svc.createCandidates('stage1');
    expect(result).toBe('Candidates created successfully');
    expect(fakePrisma.candidate.create).toHaveBeenCalled();
    expect(fakePrisma.candidateSkill.create).toHaveBeenCalledTimes(2);
    expect(fakePrisma.candidateLanguage.create).toHaveBeenCalledTimes(2);
  });

  it('should skip creation when candidate already exists in DB', async () => {
    const fakePrisma = {
      candidate: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing-id' }),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
      candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
      organization: { findMany: jest.fn(), update: jest.fn() },
      contact: { findUnique: jest.fn(), create: jest.fn() },
      uSER: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const localDoSearch = jest.fn().mockResolvedValue({
      results: [{ properties: { hs_object_id: '111', name: 'Existing VA' } }],
      total: 1,
    });

    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: localDoSearch },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    const svc = module.get<HubspotService>(HubspotService);

    const result = await svc.createCandidates('stage1');
    expect(result).toBe('Candidates created successfully');
    expect(fakePrisma.candidate.create).not.toHaveBeenCalled();
  });
});

// ─── updateCandidates ─────────────────────────────────────────────────────────

describe('HubspotService => updateCandidates', () => {
  let service: HubspotService;

  let fakePrisma: any;

  beforeEach(async () => {
    fakePrisma = {
      candidate: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
      candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
      organization: { findMany: jest.fn(), update: jest.fn() },
      contact: { findUnique: jest.fn(), create: jest.fn() },
      uSER: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const localDoSearch = jest.fn().mockResolvedValue({
      results: [
        {
          properties: {
            hs_object_id: '111',
            name: 'Test VA',
            career_highlights_relevant_job_experiences: 'skill1;skill2',
            language_spoken: 'English&Spanish',
            approved_positions_pairing: 'pos1;pos2',
          },
        },
      ],
    });

    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: localDoSearch },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  it('should update each candidate found in DB and HubSpot', async () => {
    fakePrisma.candidate.findMany.mockResolvedValue([
      { id: 'c1', first_name: 'Test', hubspot_id: '111', resume_url: null },
    ]);
    fakePrisma.candidate.update.mockResolvedValue({});
    fakePrisma.candidateSkill.deleteMany.mockResolvedValue({});
    fakePrisma.candidateSkill.create.mockResolvedValue({});
    fakePrisma.candidateLanguage.deleteMany.mockResolvedValue({});
    fakePrisma.candidateLanguage.create.mockResolvedValue({});

    await service.updateCandidates('stage1');

    expect(fakePrisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' } }),
    );
  });

  it('should skip candidate when HubSpot returns no results', async () => {
    fakePrisma.candidate.findMany.mockResolvedValue([
      { id: 'c2', first_name: 'Ghost', hubspot_id: '999', resume_url: null },
    ]);

    const localDoSearch = jest.fn().mockResolvedValue({ results: [] });
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: localDoSearch },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    }));

    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    const svc2 = module2.get<HubspotService>(HubspotService);

    await svc2.updateCandidates('stage1');
    expect(fakePrisma.candidate.update).not.toHaveBeenCalled();
  });
});

// ─── alignOwners ──────────────────────────────────────────────────────────────

describe('HubspotService => alignOwners', () => {
  let service: HubspotService;
  let fakePrisma: any;

  beforeEach(async () => {
    fakePrisma = {
      candidate: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
      candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
      organization: { findMany: jest.fn(), update: jest.fn() },
      contact: { findUnique: jest.fn(), create: jest.fn() },
      uSER: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  it('should return true and update matching users', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [{ id: 'owner-1', email: 'owner@example.com' }],
      },
    });

    fakePrisma.uSER.findUnique.mockResolvedValue({ id: 'user-1' });
    fakePrisma.uSER.update.mockResolvedValue({});

    const result = await service.alignOwners();

    expect(result).toBe(true);
    expect(fakePrisma.uSER.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { hubspot_id: 'owner-1' } }),
    );
  });

  it('should skip update when owner email does not match any user', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [{ id: 'owner-2', email: 'nobody@example.com' }],
      },
    });

    fakePrisma.uSER.findUnique.mockResolvedValue(null);

    const result = await service.alignOwners();
    expect(result).toBe(true);
    expect(fakePrisma.uSER.update).not.toHaveBeenCalled();
  });

  it('should throw BadRequestException when axios.get returns falsy', async () => {
    (axios.get as jest.Mock).mockResolvedValue(null);
    await expect(service.alignOwners()).rejects.toThrow('No object data found');
  });
});

// ─── populateContactsFromHubspot ─────────────────────────────────────────────

describe('HubspotService => populateContactsFromHubspot', () => {
  let service: HubspotService;
  let fakePrisma: any;

  beforeEach(async () => {
    fakePrisma = {
      candidate: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
      candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
      organization: {
        findMany: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      contact: { findUnique: jest.fn(), create: jest.fn() },
      uSER: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
      },
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  it('should create contacts for lifecyclestage=customer and return counts', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [
          {
            id: 'ct-1',
            properties: {
              lifecyclestage: 'customer',
              email: 'doc@clinic.com',
              firstname: 'Doc',
              lastname: 'Smith',
            },
            associations: { companies: { results: [{ id: 'co-1' }] } },
          },
        ],
        paging: null,
      },
    });

    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.uSER.findFirst.mockResolvedValue(null);
    fakePrisma.organization.findUnique.mockResolvedValue({ id: 'org-1' });
    fakePrisma.contact.create.mockResolvedValue({ id: 'new-ct' });

    const result = await service.populateContactsFromHubspot();

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(fakePrisma.contact.create).toHaveBeenCalled();
  });

  it('should skip existing contacts', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [
          {
            id: 'ct-2',
            properties: {
              lifecyclestage: 'customer',
              email: 'existing@clinic.com',
            },
            associations: {},
          },
        ],
        paging: null,
      },
    });

    fakePrisma.contact.findUnique.mockResolvedValue({ id: 'existing' });

    const result = await service.populateContactsFromHubspot();

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should skip contacts with lifecycle stage other than customer', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [
          {
            id: 'ct-3',
            properties: { lifecyclestage: 'lead', email: 'lead@clinic.com' },
            associations: {},
          },
        ],
        paging: null,
      },
    });

    const result = await service.populateContactsFromHubspot();

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
    expect(fakePrisma.contact.create).not.toHaveBeenCalled();
  });

  it('should count errors when contact creation throws', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [
          {
            id: 'ct-4',
            properties: { lifecyclestage: 'customer', email: 'err@clinic.com' },
            associations: {},
          },
        ],
        paging: null,
      },
    });

    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.uSER.findFirst.mockResolvedValue(null);
    fakePrisma.contact.create.mockRejectedValue(new Error('DB error'));

    const result = await service.populateContactsFromHubspot();

    expect(result.errors).toBe(1);
    expect(result.created).toBe(0);
  });

  it('should link user_id when matching user found with no existing contact', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        results: [
          {
            id: 'ct-5',
            properties: {
              lifecyclestage: 'customer',
              email: 'linked@clinic.com',
            },
            associations: {},
          },
        ],
        paging: null,
      },
    });

    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.uSER.findFirst.mockResolvedValue({
      id: 'user-99',
      contact: null,
    });
    fakePrisma.contact.create.mockResolvedValue({ id: 'new-ct-linked' });

    const result = await service.populateContactsFromHubspot();

    expect(result.created).toBe(1);
    expect(fakePrisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: 'user-99' }),
      }),
    );
  });
});

// ─── updateOrganizations ─────────────────────────────────────────────────────

describe('HubspotService => updateOrganizations', () => {
  let service: HubspotService;
  let fakePrisma: any;

  beforeEach(async () => {
    fakePrisma = {
      candidate: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
      },
      candidateSkill: { create: jest.fn(), deleteMany: jest.fn() },
      candidateLanguage: { create: jest.fn(), deleteMany: jest.fn() },
      organization: {
        findMany: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      contact: { findUnique: jest.fn(), create: jest.fn() },
      uSER: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const companySearchMock = jest.fn();
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
        companies: { searchApi: { doSearch: companySearchMock } },
      },
      _companySearchMock: companySearchMock,
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  it('should skip organizations without hubspot_id', async () => {
    fakePrisma.organization.findMany.mockResolvedValue([
      { id: 'org-no-hs', hubspot_id: null, name: 'No HS Org', owner_id: null },
    ]);

    await service.updateOrganizations();

    expect(fakePrisma.organization.update).not.toHaveBeenCalled();
  });

  it('should update organization type when HubSpot returns data', async () => {
    fakePrisma.organization.findMany.mockResolvedValue([
      {
        id: 'org-1',
        hubspot_id: 'hs-co-1',
        name: 'Test Clinic',
        owner_id: null,
      },
    ]);
    fakePrisma.organization.update.mockResolvedValue({});

    const companySearchFn = jest.fn().mockResolvedValue({
      results: [
        {
          properties: {
            hs_object_id: 'hs-co-1',
            name: 'Test Clinic',
            hs_object_type: 'prospect',
            industry: 'healthcare',
            specialties: 'cardiology,oncology',
            number_of_employees: '50',
            email: 'test@clinic.com',
            organization_role: 'Prospect',
          },
        },
      ],
    });

    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
        companies: { searchApi: { doSearch: companySearchFn } },
      },
    }));

    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    const svc2 = module2.get<HubspotService>(HubspotService);

    await svc2.updateOrganizations();

    expect(fakePrisma.organization.update).toHaveBeenCalled();
  });

  it('should skip organization when HubSpot returns no results for its hubspot_id', async () => {
    fakePrisma.organization.findMany.mockResolvedValue([
      {
        id: 'org-2',
        hubspot_id: 'hs-co-2',
        name: 'Ghost Clinic',
        owner_id: null,
      },
    ]);

    const emptySearchFn = jest.fn().mockResolvedValue({ results: [] });
    const { Client } = jest.requireMock('@hubspot/api-client');
    Client.mockImplementation(() => ({
      crm: {
        objects: {
          searchApi: { doSearch: doSearchMock },
          batchApi: { update: jest.fn() },
          basicApi: { update: jest.fn() },
        },
        companies: { searchApi: { doSearch: emptySearchFn } },
      },
    }));

    const module3: TestingModule = await Test.createTestingModule({
      providers: [
        ...buildProviders().filter((p) => p.provide !== PrismaService),
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    const svc3 = module3.get<HubspotService>(HubspotService);

    await svc3.updateOrganizations();
    expect(fakePrisma.organization.update).not.toHaveBeenCalled();
  });
});

// ─── changeDataFromHubspot sort and edge cases ────────────────────────────────

describe('HubspotService => changeDataFromHubspot sort edge cases', () => {
  let service: HubspotService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
    auditServiceMock.log.mockResolvedValue(undefined);
  });

  it('should sort two events where second event type is alphabetically first', async () => {
    handlerObjectCreationMock.execute.mockResolvedValue(undefined);
    HandlerOrganizationCreationMock.execute.mockResolvedValue(undefined);
    // 'company.creation' < 'object.creation' alphabetically, so sorting should handle both orders
    const data = [
      {
        subscriptionType: 'object.creation',
        objectTypeId: '2-5922196',
        objectId: '1',
      },
      { subscriptionType: 'company.creation', objectId: '2' },
    ];
    await service.changeDataFromHubspot(data);
    expect(HandlerOrganizationCreationMock.execute).toHaveBeenCalled();
    expect(handlerObjectCreationMock.execute).toHaveBeenCalled();
  });

  it('should handle resolveWebhookMeta returning null for unrecognized objectTypeId in object event', async () => {
    // object.creation with unknown objectTypeId — meta is null, no audit call needed
    const data = [
      {
        subscriptionType: 'object.creation',
        objectTypeId: '9-unknown',
        objectId: '42',
      },
    ];
    await expect(service.changeDataFromHubspot(data)).resolves.toBeUndefined();
  });
});
// ─── fetchPropertiesAndCandidates ─────────────────────────────────────────────

describe('HubspotService => fetchPropertiesAndCandidates', () => {
  let service: HubspotService;
  const originalEnv = process.env.HUBSPOT_CUSTOM_OBJECT;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: buildProviders(),
    }).compile();
    service = module.get<HubspotService>(HubspotService);
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.HUBSPOT_CUSTOM_OBJECT = originalEnv;
  });

  it('should throw NotFoundException if HUBSPOT_CUSTOM_OBJECT is not defined', async () => {
    delete process.env.HUBSPOT_CUSTOM_OBJECT;
    await expect(service.fetchPropertiesAndCandidates()).rejects.toThrow(
      'Custom Object is not defined on the environment variables',
    );
  });

  it('should fetch candidates successfully with vaid in properties', async () => {
    process.env.HUBSPOT_CUSTOM_OBJECT = 'custom_obj';
    doSearchMock
      .mockResolvedValueOnce({
        results: [{ id: '1', properties: {} }],
        paging: { next: { after: 'next_page' } },
      })
      .mockResolvedValueOnce({
        results: [{ id: '2', properties: {} }],
        paging: undefined,
      });

    const result = await service.fetchPropertiesAndCandidates();
    expect(result).toEqual({
      candidates: [
        { id: '1', properties: {} },
        { id: '2', properties: {} },
      ],
    });

    expect(doSearchMock).toHaveBeenCalledTimes(2);
    expect(doSearchMock).toHaveBeenNthCalledWith(
      1,
      'custom_obj',
      expect.objectContaining({
        properties: expect.arrayContaining(['vaid']),
      }),
    );
  });
});
