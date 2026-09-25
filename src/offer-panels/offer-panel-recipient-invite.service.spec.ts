import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OfferPanelRecipientInviteService } from './offer-panel-recipient-invite.service';
import { PrismaService } from '../prisma/prisma.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { OrganizationService } from '../organization/organization.service';
import { UserService } from '../user/user.service';
import { OfferPanelsAuditService } from './offer-panels-audit.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const admin: any = {
  id: 'admin-1',
  role: 'system_admin',
  first_name: 'Ada',
  last_name: 'Admin',
  email: 'ada@medvirtual.com',
};

function makePanel(overrides: Record<string, any> = {}) {
  return {
    id: 'panel-1',
    recipient_type: 'email',
    recipient_user_id: null,
    recipient_company_id: null,
    recipient_email: ' John@Clinic.com ',
    business_unit: 'MedVirtual',
    ...overrides,
  };
}

function makeOrg(overrides: Record<string, any> = {}) {
  return {
    id: 'org-1',
    name: 'Sunrise Clinic',
    status: 'active',
    business_unit: 'MedVirtual',
    hubspot_id: 'hs-co-1',
    ...overrides,
  };
}

const contact = {
  id: 'hs-contact-1',
  email: 'john@clinic.com',
  first_name: 'John',
  last_name: 'Doe',
  phone: '555',
  job_title: 'Manager',
};

const dto = {
  organization_id: 'org-1',
  first_name: 'John',
  last_name: 'Doe',
  role: 'organization_admin' as const,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = {
  offerPanel: { findUnique: jest.fn(), updateMany: jest.fn() },
  uSER: { findFirst: jest.fn() },
  organization: { findMany: jest.fn() },
  contact: { findUnique: jest.fn() },
  ticket: { updateMany: jest.fn() },
};

const mockHubspot = {
  findContactByEmail: jest.fn(),
  getContactCompanyAssociations: jest.fn(),
  getCompanySummaries: jest.fn(),
};

const BUS: Record<string, { slug: string }> = {
  medvirtual: { slug: 'medvirtual' },
  berryvirtual: { slug: 'berry-virtual' },
};
const mockBu = {
  resolveByHubspotValue: jest.fn((v: string) =>
    Promise.resolve(BUS[v.toLowerCase().replace(/\s+/g, '')] ?? null),
  ),
  normalizeBusinessUnit: jest.fn((v?: string | null) =>
    (v ?? '').trim().toLowerCase().replace(/\s+/g, ''),
  ),
};

const mockOrgService = { update: jest.fn() };
const mockUserService = { inviteUserToOrganization: jest.fn() };
const mockAudit = { log: jest.fn() };

describe('OfferPanelRecipientInviteService', () => {
  let service: OfferPanelRecipientInviteService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OfferPanelRecipientInviteService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: HubspotService, useValue: mockHubspot },
        { provide: BusinessUnitContext, useValue: mockBu },
        { provide: OrganizationService, useValue: mockOrgService },
        { provide: UserService, useValue: mockUserService },
        { provide: OfferPanelsAuditService, useValue: mockAudit },
      ],
    }).compile();
    service = module.get(OfferPanelRecipientInviteService);

    // Happy-path defaults; individual tests override. mockReset (not just clear)
    // drops any unconsumed mockResolvedValueOnce queue from a previous test.
    mockPrisma.offerPanel.findUnique.mockResolvedValue(makePanel());
    mockPrisma.uSER.findFirst.mockReset().mockResolvedValue(null);
    mockOrgService.update.mockReset().mockResolvedValue(undefined);
    mockUserService.inviteUserToOrganization
      .mockReset()
      .mockResolvedValue('ok');
    mockHubspot.findContactByEmail.mockResolvedValue(contact);
    mockHubspot.getContactCompanyAssociations.mockResolvedValue([
      { companyId: 'hs-co-1', isPrimary: true },
    ]);
    mockPrisma.organization.findMany.mockResolvedValue([makeOrg()]);
    mockPrisma.contact.findUnique.mockResolvedValue(null);
    mockPrisma.offerPanel.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.ticket.updateMany.mockResolvedValue({ count: 0 });
  });

  // -------------------------------------------------------------------------
  describe('preview', () => {
    it('throws 404 for an unknown panel', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(null);
      await expect(service.preview('x')).rejects.toThrow(NotFoundException);
    });

    it('returns panel_already_linked for client_user panels', async () => {
      mockPrisma.offerPanel.findUnique.mockResolvedValue(
        makePanel({ recipient_type: 'client_user', recipient_user_id: 'u1' }),
      );
      const r = await service.preview('panel-1');
      expect(r.status).toBe('panel_already_linked');
      expect(mockHubspot.findContactByEmail).not.toHaveBeenCalled();
    });

    it('returns already_user (linkable) for an org user in the same BU', async () => {
      mockPrisma.uSER.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'john@clinic.com',
        first_name: 'John',
        last_name: 'Doe',
        role: 'organization_admin',
        status: 'active',
        organization: makeOrg(),
      });
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({ status: 'already_user', can_link: true });
      expect(mockHubspot.findContactByEmail).not.toHaveBeenCalled();
    });

    it('returns already_user (not linkable) for a system/affiliate account', async () => {
      mockPrisma.uSER.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'john@clinic.com',
        role: 'affiliate',
        status: 'active',
        organization: null,
      });
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({ status: 'already_user', can_link: false });
    });

    it('normalizes the email before looking up HubSpot', async () => {
      await service.preview('panel-1');
      expect(mockHubspot.findContactByEmail).toHaveBeenCalledWith(
        'john@clinic.com',
      );
    });

    it('returns contact_not_found', async () => {
      mockHubspot.findContactByEmail.mockResolvedValue(null);
      expect((await service.preview('panel-1')).status).toBe(
        'contact_not_found',
      );
    });

    it('returns no_company when the contact has no associations', async () => {
      mockHubspot.getContactCompanyAssociations.mockResolvedValue([]);
      expect((await service.preview('panel-1')).status).toBe('no_company');
    });

    it('returns company_not_synced with HubSpot company names', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([]);
      mockHubspot.getCompanySummaries.mockResolvedValue([
        { id: 'hs-co-1', name: 'Sunrise', domain: 'sunrise.com' },
      ]);
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({
        status: 'company_not_synced',
        companies: [{ id: 'hs-co-1', name: 'Sunrise' }],
      });
    });

    it('still returns company_not_synced when company names cannot be loaded', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([]);
      mockHubspot.getCompanySummaries.mockRejectedValue(new Error('boom'));
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({
        status: 'company_not_synced',
        companies: [{ id: 'hs-co-1', name: null }],
      });
    });

    it('returns org_deleted when every match is deleted', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg({ status: 'deleted' }),
      ]);
      expect((await service.preview('panel-1')).status).toBe('org_deleted');
    });

    it('returns bu_mismatch when the org belongs to another BU', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg({ business_unit: 'Berry Virtual' }),
      ]);
      expect((await service.preview('panel-1')).status).toBe('bu_mismatch');
    });

    it('matches BU aliases ("Med Virtual" vs "MedVirtual")', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg({ business_unit: 'Med Virtual' }),
      ]);
      expect((await service.preview('panel-1')).status).toBe('ready');
    });

    it('returns ready with the single match and flags will_activate', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg({ status: 'inactive' }),
      ]);
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({
        status: 'ready',
        suggested_organization_id: 'org-1',
        organizations: [{ id: 'org-1', will_activate: true }],
      });
    });

    it('suggests the HubSpot primary when several orgs match', async () => {
      mockHubspot.getContactCompanyAssociations.mockResolvedValue([
        { companyId: 'hs-co-1', isPrimary: false },
        { companyId: 'hs-co-2', isPrimary: true },
      ]);
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg(),
        makeOrg({ id: 'org-2', hubspot_id: 'hs-co-2' }),
      ]);
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({
        status: 'ready',
        suggested_organization_id: 'org-2',
      });
    });

    it('returns needs_selection when several orgs match and none is primary', async () => {
      mockHubspot.getContactCompanyAssociations.mockResolvedValue([
        { companyId: 'hs-co-1', isPrimary: false },
        { companyId: 'hs-co-2', isPrimary: false },
      ]);
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg(),
        makeOrg({ id: 'org-2', hubspot_id: 'hs-co-2' }),
      ]);
      const r = await service.preview('panel-1');
      expect(r).toMatchObject({
        status: 'needs_selection',
        suggested_organization_id: null,
      });
    });

    it('maps HubSpot failures to 503', async () => {
      mockHubspot.findContactByEmail.mockRejectedValue(new Error('429'));
      await expect(service.preview('panel-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('addAsUser', () => {
    beforeEach(() => {
      // First findFirst = "existing user?" check (none); second = the new user.
      mockPrisma.uSER.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'new-user',
          email: 'john@clinic.com',
          first_name: 'John',
          last_name: 'Doe',
        });
    });

    it('invites, relinks the panel, backfills tickets and audits', async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({
        id: 'local-contact',
        user_id: null,
      });

      const r = await service.addAsUser('panel-1', dto, admin);

      expect(mockOrgService.update).not.toHaveBeenCalled();
      expect(mockUserService.inviteUserToOrganization).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          email: ' John@Clinic.com ',
          role: 'organization_admin',
          contact_id: 'local-contact',
        }),
        admin,
        { existingHubspotContactId: 'hs-contact-1' },
      );
      expect(mockPrisma.offerPanel.updateMany).toHaveBeenCalledWith({
        where: { id: 'panel-1', recipient_user_id: null },
        data: expect.objectContaining({
          recipient_type: 'client_user',
          recipient_user_id: 'new-user',
          recipient_company_id: 'org-1',
          recipient_org_name: 'Sunrise Clinic',
        }),
      });
      expect(mockPrisma.ticket.updateMany).toHaveBeenCalledWith({
        where: { offer_panel_id: 'panel-1', org_id: null },
        data: { org_id: 'org-1' },
      });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'recipient_invited_as_user' }),
      );
      expect(r).toMatchObject({ activated: false, user: { id: 'new-user' } });
    });

    it('activates an inactive org BEFORE inviting', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg({ status: 'inactive' }),
      ]);
      const order: string[] = [];
      mockOrgService.update.mockImplementation(() => {
        order.push('activate');
        return Promise.resolve();
      });
      mockUserService.inviteUserToOrganization.mockImplementation(() => {
        order.push('invite');
        return Promise.resolve();
      });

      const r = await service.addAsUser('panel-1', dto, admin);

      expect(mockOrgService.update).toHaveBeenCalledWith(
        'org-1',
        { status: 'active' },
        'admin-1',
      );
      expect(order).toEqual(['activate', 'invite']);
      expect(r.activated).toBe(true);
    });

    it('reports a partial result when the invite fails after activation', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([
        makeOrg({ status: 'inactive' }),
      ]);
      mockUserService.inviteUserToOrganization.mockRejectedValue(
        new BadRequestException('Failed to send invitation email'),
      );
      await expect(service.addAsUser('panel-1', dto, admin)).rejects.toThrow(
        /was activated, but the invite failed/,
      );
      expect(mockPrisma.offerPanel.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an organization outside the resolved set', async () => {
      await expect(
        service.addAsUser(
          'panel-1',
          { ...dto, organization_id: 'org-evil' },
          admin,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockUserService.inviteUserToOrganization).not.toHaveBeenCalled();
    });

    it('rejects blocked states (e.g. company not synced)', async () => {
      mockPrisma.organization.findMany.mockResolvedValue([]);
      mockHubspot.getCompanySummaries.mockResolvedValue([]);
      await expect(service.addAsUser('panel-1', dto, admin)).rejects.toThrow(
        /not synced/,
      );
    });

    it('fails when a concurrent request already relinked the panel', async () => {
      mockPrisma.offerPanel.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.addAsUser('panel-1', dto, admin)).rejects.toThrow(
        /already linked/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('linkExistingUser', () => {
    it('relinks the panel to an eligible existing user', async () => {
      mockPrisma.uSER.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'john@clinic.com',
        first_name: 'John',
        last_name: 'Doe',
        role: 'organization_super_admin',
        status: 'active',
        organization: makeOrg(),
      });
      const r = await service.linkExistingUser('panel-1', admin);
      expect(r).toEqual({ user_id: 'u1', organization_id: 'org-1' });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'recipient_linked_to_user' }),
      );
    });

    it('refuses a user from another BU', async () => {
      mockPrisma.uSER.findFirst.mockResolvedValue({
        id: 'u1',
        email: 'john@clinic.com',
        role: 'organization_admin',
        status: 'active',
        organization: makeOrg({ business_unit: 'Berry Virtual' }),
      });
      await expect(service.linkExistingUser('panel-1', admin)).rejects.toThrow(
        /different business unit/,
      );
    });

    it('refuses when the recipient has no account', async () => {
      await expect(service.linkExistingUser('panel-1', admin)).rejects.toThrow(
        /does not have a user account/,
      );
    });
  });
});
