import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { OrganizationStatus } from '@prisma/client';
import { HandlerOrganizationCreation } from './organizationCreation';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizationService } from '../../organization/organization.service';
import { BusinessUnitContext } from '../../business-units/business-unit-context.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  uSER: {
    findUnique: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
};

const organizationServiceMock = {
  create: jest.fn(),
};

const businessUnitContextMock = {
  isAllowedHubspotValue: jest.fn(),
};

function hubspotCompanyResponse(properties: Record<string, unknown>) {
  return {
    data: {
      results: [{ properties }],
    },
  };
}

describe('HandlerOrganizationCreation', () => {
  let handler: HandlerOrganizationCreation;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerOrganizationCreation,
        { provide: PrismaService, useValue: prismaMock },
        { provide: OrganizationService, useValue: organizationServiceMock },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
      ],
    }).compile();

    handler = module.get<HandlerOrganizationCreation>(
      HandlerOrganizationCreation,
    );

    jest.clearAllMocks();
    prismaMock.uSER.findUnique.mockReset();
    prismaMock.organization.findUnique.mockReset();
    organizationServiceMock.create.mockReset();
    businessUnitContextMock.isAllowedHubspotValue.mockReset();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  it('creates the organization when business_unit is an allowed (visible) BU', async () => {
    mockedAxios.post.mockResolvedValue(
      hubspotCompanyResponse({
        business_unit: 'MedVirtual',
        name: 'Acme Health',
      }),
    );
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);
    prismaMock.organization.findUnique.mockResolvedValue(null);
    prismaMock.uSER.findUnique.mockResolvedValue(null);
    organizationServiceMock.create.mockResolvedValue({ id: 'org-1' });

    const result = await handler.execute({ objectId: 1 });

    expect(businessUnitContextMock.isAllowedHubspotValue).toHaveBeenCalledWith(
      'MedVirtual',
    );
    expect(organizationServiceMock.create).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('creates the organization for a third, newly-visible BU (e.g. MMVA)', async () => {
    mockedAxios.post.mockResolvedValue(
      hubspotCompanyResponse({ business_unit: 'MMVA', name: 'MMVA Client' }),
    );
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);
    prismaMock.organization.findUnique.mockResolvedValue(null);
    prismaMock.uSER.findUnique.mockResolvedValue(null);
    organizationServiceMock.create.mockResolvedValue({ id: 'org-2' });

    const result = await handler.execute({ objectId: 2 });

    expect(organizationServiceMock.create).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('rejects creation when business_unit is dormant (known but not visible)', async () => {
    mockedAxios.post.mockResolvedValue(
      hubspotCompanyResponse({ business_unit: 'MMVA', name: 'MMVA Client' }),
    );
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(false);

    await expect(handler.execute({ objectId: 3 })).rejects.toThrow(
      'Organization is not a client of MedVirtual',
    );
    expect(organizationServiceMock.create).not.toHaveBeenCalled();
  });

  it('rejects creation when business_unit is completely unknown', async () => {
    mockedAxios.post.mockResolvedValue(
      hubspotCompanyResponse({ business_unit: 'Some Other Co', name: 'X' }),
    );
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(false);

    await expect(handler.execute({ objectId: 4 })).rejects.toThrow(
      'Organization is not a client of MedVirtual',
    );
    expect(organizationServiceMock.create).not.toHaveBeenCalled();
  });

  it('rejects when the organization already exists in the database', async () => {
    mockedAxios.post.mockResolvedValue(
      hubspotCompanyResponse({ business_unit: 'MedVirtual', name: 'Acme' }),
    );
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);
    prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-1' });

    await expect(handler.execute({ objectId: 5 })).rejects.toThrow(
      'Organization already exists on the database',
    );
    expect(organizationServiceMock.create).not.toHaveBeenCalled();
  });

  it('sets status to inactive on newly-created organizations regardless of BU', async () => {
    mockedAxios.post.mockResolvedValue(
      hubspotCompanyResponse({
        business_unit: 'Berry Virtual',
        name: 'Berry Co',
      }),
    );
    businessUnitContextMock.isAllowedHubspotValue.mockResolvedValue(true);
    prismaMock.organization.findUnique.mockResolvedValue(null);
    prismaMock.uSER.findUnique.mockResolvedValue(null);
    organizationServiceMock.create.mockResolvedValue({ id: 'org-6' });

    await handler.execute({ objectId: 6 });

    const passedData = organizationServiceMock.create.mock.calls[0][0];
    expect(passedData.status).toBe(OrganizationStatus.inactive);
  });
});
