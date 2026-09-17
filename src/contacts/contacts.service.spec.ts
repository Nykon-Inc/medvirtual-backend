import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactService } from './contacts.service';
import { PrismaService } from '../prisma/prisma.service';

jest.mock('axios');

const mockPrisma = {
  uSER: {
    findUnique: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
  contact: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('ContactService', () => {
  let service: ContactService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ContactService>(ContactService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // createForOrganization
  // ---------------------------------------------------------------------------
  describe('createForOrganization', () => {
    const mockOrg = {
      id: 'org-1',
      name: 'Acme Corp',
      hubspot_id: 'hs-org-1',
      contact_first_name: 'John',
      contact_last_name: 'Doe',
      contact_email: 'john@acme.com',
      phone: '555-1234',
      business_unit: 'MedVirtual',
      owner: {
        id: 'owner-1',
        first_name: 'Owner',
        last_name: 'User',
        email: 'owner@acme.com',
        phone: '555-5678',
        job_title: 'CEO',
      },
      admin: { hubspot_id: 'hs-admin-1' },
    };

    it('should throw NotFoundException when organization does not exist', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(null);

      await expect(service.createForOrganization('org-99')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should create contact and sync to HubSpot successfully', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(mockOrg);
      const createdContact = {
        id: 'contact-1',
        hubspot_id: null,
        organization_id: 'org-1',
      };
      mockPrisma.contact.create.mockResolvedValue(createdContact);
      mockPrisma.contact.update.mockResolvedValue({
        ...createdContact,
        hubspot_id: 'hs-c-1',
      });

      const axiosMock = jest.requireMock('axios');
      axiosMock.post.mockResolvedValue({ data: { id: 'hs-c-1' } });

      const result = await service.createForOrganization('org-1');

      expect(mockPrisma.contact.create).toHaveBeenCalled();
      expect(axiosMock.post).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockPrisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'contact-1' },
        data: { hubspot_id: 'hs-c-1' },
      });
      expect(result?.hubspot_id).toBe('hs-c-1');
    });

    it('should return contact without hubspot_id when HubSpot call fails', async () => {
      const orgNoHubspot = { ...mockOrg, hubspot_id: null };
      mockPrisma.organization.findUnique.mockResolvedValue(orgNoHubspot);
      const createdContact = { id: 'contact-1', hubspot_id: null };
      mockPrisma.contact.create.mockResolvedValue(createdContact);

      const axiosMock = jest.requireMock('axios');
      axiosMock.post.mockRejectedValue(new Error('HubSpot error'));

      const result = await service.createForOrganization('org-1');

      expect(result?.hubspot_id).toBeNull();
    });

    it('should handle CONFLICT error by extracting existing HubSpot ID and creating association', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(mockOrg);
      const createdContact = { id: 'contact-1', hubspot_id: null };
      mockPrisma.contact.create.mockResolvedValue(createdContact);
      mockPrisma.contact.update.mockResolvedValue({
        ...createdContact,
        hubspot_id: '99999',
      });

      const conflictError: any = new Error('CONFLICT');
      conflictError.response = {
        data: {
          category: 'CONFLICT',
          message: 'Contact already exists. Existing ID: 99999',
        },
      };

      const axiosMock = jest.requireMock('axios');
      axiosMock.post.mockRejectedValue(conflictError);
      axiosMock.put.mockResolvedValue({});

      const result = await service.createForOrganization('org-1');

      expect(result?.hubspot_id).toBe('99999');
      expect(mockPrisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'contact-1' },
        data: { hubspot_id: '99999' },
      });
      expect(axiosMock.put).toHaveBeenCalled();
    });

    it('should throw BadRequestException when contact creation in DB fails', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(mockOrg);
      mockPrisma.contact.create.mockRejectedValue(new Error('DB error'));

      await expect(service.createForOrganization('org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // createForReferredCompany
  // ---------------------------------------------------------------------------
  describe('createForReferredCompany', () => {
    const mockOrgData = {
      id: 'org-1',
      name: 'Referral Corp',
      email: 'contact@referral.com',
      contact_first_name: 'Jane',
      contact_last_name: 'Doe',
      contact_email: 'jane@referral.com',
      phone: '555-9999',
      website_url: 'https://referral.com',
      job_title: 'CEO',
      hubspot_id: 'hs-org-1',
      business_unit: 'Med Virtual',
      owner_id: 'owner-1',
      referToUser: { hubspot_id: 'hs-sales-1' },
      admin: { hubspot_id: 'hs-admin-1' },
      referredByAffiliate: {
        email: 'affiliate@example.com',
        affiliateProfile: {
          hubspot_id: 'hs-aff-1',
          full_name: 'Affiliate Name',
          commission_percent_default: 7,
          payout_preference_method: 'bank_transfer',
        },
        organization: { name: 'Affiliate Org', email: 'org@affiliate.com' },
      },
    };

    it('should create contact in DB and sync to HubSpot', async () => {
      const createdContact = { id: 'contact-1', hubspot_id: null };
      mockPrisma.contact.create.mockResolvedValue(createdContact);
      mockPrisma.contact.update.mockResolvedValue({
        ...createdContact,
        hubspot_id: 'hs-c-1',
      });

      const axiosMock = jest.requireMock('axios');
      axiosMock.post.mockResolvedValue({ data: { id: 'hs-c-1' } });

      const result = await service.createForReferredCompany(mockOrgData);

      expect(result.contact?.hubspot_id).toBe('hs-c-1');
      expect(result.hubspotId).toBe('hs-c-1');
      expect(mockPrisma.contact.create).toHaveBeenCalled();
    });

    it('should skip DB contact creation when org has no owner_id', async () => {
      const orgNoOwner = { ...mockOrgData, owner_id: null };
      const axiosMock = jest.requireMock('axios');
      axiosMock.post.mockResolvedValue({ data: { id: 'hs-c-2' } });

      const result = await service.createForReferredCompany(orgNoOwner);

      expect(mockPrisma.contact.create).not.toHaveBeenCalled();
      expect(result.hubspotId).toBe('hs-c-2');
    });

    it('should rollback DB contact and rethrow when HubSpot call fails', async () => {
      const createdContact = { id: 'contact-1', hubspot_id: null };
      mockPrisma.contact.create.mockResolvedValue(createdContact);
      mockPrisma.contact.delete.mockResolvedValue({});

      const axiosMock = jest.requireMock('axios');
      axiosMock.post.mockRejectedValue(new Error('HubSpot down'));

      await expect(
        service.createForReferredCompany(mockOrgData),
      ).rejects.toThrow('HubSpot down');
      expect(mockPrisma.contact.delete).toHaveBeenCalledWith({
        where: { id: 'contact-1' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // deleteById
  // ---------------------------------------------------------------------------
  describe('deleteById', () => {
    it('should delete the contact by id', async () => {
      mockPrisma.contact.delete.mockResolvedValue({});

      await service.deleteById('contact-1');

      expect(mockPrisma.contact.delete).toHaveBeenCalledWith({
        where: { id: 'contact-1' },
      });
    });

    it('should silently ignore errors when delete fails', async () => {
      mockPrisma.contact.delete.mockRejectedValue(new Error('Not found'));

      await expect(service.deleteById('contact-999')).resolves.toBeUndefined();
    });
  });
});
