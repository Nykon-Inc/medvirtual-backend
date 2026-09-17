import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { HubspotMatchingService } from './hubspot-matching.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { EligibilityCheckService } from '../referred-companies/eligibility-check.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockPrisma = {
  organization: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  emailBranding: {
    findUnique: jest.fn().mockResolvedValue(null),
  },
};

const mockMailService = { sendMail: jest.fn() };
const mockEligibilityCheck = { runAndPersist: jest.fn() };
const mockReviewCases = { openOrSkip: jest.fn() };
const mockEmailTemplates = {
  getTemplateContent: jest.fn().mockResolvedValue(null),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const makeOrg = (overrides: Partial<any> = {}) => ({
  id: 'org-1',
  name: 'Acme Corp',
  email: 'contact@acme.com',
  website_url: 'https://acme.com',
  hubspot_id: null,
  referred_by_affiliate_id: 'user-1',
  referredByAffiliate: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
  },
  ...overrides,
});

const hubspotSearchResponse = (results: Array<{ id: string }>) => ({
  data: { results },
});

describe('HubspotMatchingService', () => {
  let service: HubspotMatchingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HubspotMatchingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMailService },
        { provide: EligibilityCheckService, useValue: mockEligibilityCheck },
        { provide: ReviewCasesService, useValue: mockReviewCases },
        { provide: EmailTemplatesService, useValue: mockEmailTemplates },
      ],
    }).compile();

    service = module.get<HubspotMatchingService>(HubspotMatchingService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // already_matched
  // -------------------------------------------------------------------------
  describe('already matched', () => {
    it('should return already_matched and skip HubSpot call when hubspot_id is set', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ hubspot_id: 'hs-existing' }),
      );

      const result = await service.run('org-1');

      expect(result.outcome).toBe('already_matched');
      expect(result.hubspotCompanyId).toBe('hs-existing');
      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // org not found
  // -------------------------------------------------------------------------
  it('should return error when organization does not exist', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    const result = await service.run('non-existent');

    expect(result.outcome).toBe('error');
    expect(result.error).toBe('Organization not found');
  });

  // -------------------------------------------------------------------------
  // no_match
  // -------------------------------------------------------------------------
  describe('no_match', () => {
    it('should set hubspot_sync_status=no_match when HubSpot returns 0 results', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(hubspotSearchResponse([]));
      mockPrisma.organization.update.mockResolvedValue({});

      const result = await service.run('org-1');

      expect(result.outcome).toBe('no_match');
      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ hubspot_sync_status: 'no_match' }),
        }),
      );
      expect(mockEligibilityCheck.runAndPersist).not.toHaveBeenCalled();
    });

    it('should return no_match when org has no name, email, or website_url', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ name: '', email: null, website_url: null }),
      );
      mockPrisma.organization.update.mockResolvedValue({});

      const result = await service.run('org-1');

      // No filters built → no HubSpot call → no_match
      expect(result.outcome).toBe('no_match');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // synced (1 match)
  // -------------------------------------------------------------------------
  describe('synced — single match', () => {
    it('should store hubspot_id and NOT re-run MA-004 automatically (disabled — §4.6, sync-triggered eligibility checks are no longer automatic)', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-company-1' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockEligibilityCheck.runAndPersist.mockResolvedValue({});

      const result = await service.run('org-1');

      expect(result.outcome).toBe('synced');
      expect(result.hubspotCompanyId).toBe('hs-company-1');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hubspot_id: 'hs-company-1',
            hubspot_sync_status: 'synced',
            hubspot_sync_error: null,
          }),
        }),
      );

      // MA-004 sync-triggered auto re-run is disabled (§4.6) — it remains available via
      // the admin-triggered recheck endpoint and the user-triggered submission-time check,
      // just not from this automatic sync path.
      expect(mockEligibilityCheck.runAndPersist).not.toHaveBeenCalled();
    });

    it('should include domain from website_url in HubSpot search filters', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ website_url: 'https://www.acme.com' }),
      );
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockEligibilityCheck.runAndPersist.mockResolvedValue({});

      await service.run('org-1');

      const payload = mockedAxios.post.mock.calls[0][1] as any;
      const domainFilter = payload.filterGroups.find((g: any) =>
        g.filters.some(
          (f: any) => f.propertyName === 'domain' && f.value === 'acme.com',
        ),
      );
      expect(domainFilter).toBeDefined();
    });

    it('should include email domain as a fallback filter', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(
        makeOrg({ website_url: null, email: 'info@globalcorp.com' }),
      );
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockEligibilityCheck.runAndPersist.mockResolvedValue({});

      await service.run('org-1');

      const payload = mockedAxios.post.mock.calls[0][1] as any;
      const emailDomainFilter = payload.filterGroups.find((g: any) =>
        g.filters.some(
          (f: any) =>
            f.propertyName === 'domain' && f.value === 'globalcorp.com',
        ),
      );
      expect(emailDomainFilter).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // multiple_matches
  // -------------------------------------------------------------------------
  describe('multiple_matches', () => {
    it('should NOT set med_alliance_referral_status (manual-only per §4.6) and send email when 2+ matches are found', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }, { id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.run('org-1');

      expect(result.outcome).toBe('multiple_matches');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hubspot_sync_status: 'multiple_matches',
          }),
        }),
      );
      expect(
        mockPrisma.organization.update.mock.calls[0][0].data
          .med_alliance_referral_status,
      ).toBeUndefined();

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'paulo@regenta.ai',
          subject: expect.stringContaining('Multiple HubSpot Matches'),
        }),
      );

      // MA-004 must NOT be re-run — pipeline is halted
      expect(mockEligibilityCheck.runAndPersist).not.toHaveBeenCalled();
    });

    it('should include org name and affiliate info in the admin notification email', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }, { id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockMailService.sendMail.mockResolvedValue(true);

      await service.run('org-1');

      const emailCall = mockMailService.sendMail.mock.calls[0][0];
      expect(emailCall.html).toContain('Acme Corp');
      expect(emailCall.html).toContain('org-1');
      expect(emailCall.html).toContain('Jane Doe');
    });

    it('should resolve the med-alliance-multiple-hubspot-matches template', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }, { id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockMailService.sendMail.mockResolvedValue(true);

      await service.run('org-1');

      expect(mockEmailTemplates.getTemplateContent).toHaveBeenCalledWith(
        'med-alliance-multiple-hubspot-matches',
        expect.objectContaining({
          '{{orgName}}': 'Acme Corp',
          '{{organizationId}}': 'org-1',
          '{{affiliateName}}': expect.stringContaining('Jane Doe'),
          '{{reviewLink}}': expect.stringContaining('org-1'),
        }),
        expect.anything(),
      );
    });

    it('resolves the admin-review email theme from the DB EmailBranding row (medvirtual) instead of the hardcoded switch', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }, { id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockMailService.sendMail.mockResolvedValue(true);
      mockPrisma.emailBranding.findUnique.mockResolvedValue({
        business_unit: 'medvirtual',
        primary_color: '#123456',
        secondary_color: '#654321',
        company_name: 'MedVirtual DB Branding',
        logo_url: 'https://db.example.com/logo.png',
        button_color: '#111111',
        button_text_color: '#ffffff',
        layout_preset: 'custom',
      });

      await service.run('org-1');

      expect(mockPrisma.emailBranding.findUnique).toHaveBeenCalledWith({
        where: { business_unit: 'medvirtual' },
      });
      const [, , theme] = mockEmailTemplates.getTemplateContent.mock.calls[0];
      expect(theme.companyName).toBe('MedVirtual DB Branding');
      expect(theme.primaryColor).toBe('#123456');
      expect(theme.logoUrl).toBe('https://db.example.com/logo.png');
    });

    it('falls back to the hardcoded MedVirtual theme when no EmailBranding row exists', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }, { id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockMailService.sendMail.mockResolvedValue(true);
      mockPrisma.emailBranding.findUnique.mockResolvedValue(null);

      await service.run('org-1');

      const [, , theme] = mockEmailTemplates.getTemplateContent.mock.calls[0];
      expect(theme.companyName).toBe('MedVirtual');
      expect(theme.primaryColor).toBe('#01546B');
    });

    it('should use the template subject/html when the template exists', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockResolvedValue(
        hubspotSearchResponse([{ id: 'hs-1' }, { id: 'hs-2' }]),
      );
      mockPrisma.organization.update.mockResolvedValue({});
      mockMailService.sendMail.mockResolvedValue(true);
      mockEmailTemplates.getTemplateContent.mockResolvedValueOnce({
        subject: 'Templated subject',
        html: '<p>Templated body</p>',
      });

      await service.run('org-1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Templated subject',
          html: '<p>Templated body</p>',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('should set hubspot_sync_status=error and return error outcome on HubSpot API failure', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockRejectedValue(new Error('HubSpot API timeout'));
      mockPrisma.organization.update.mockResolvedValue({});

      const result = await service.run('org-1');

      expect(result.outcome).toBe('error');
      expect(result.error).toBe('HubSpot API timeout');

      expect(mockPrisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            hubspot_sync_status: 'error',
            hubspot_sync_error: 'HubSpot API timeout',
          }),
        }),
      );
    });

    it('should not re-run MA-004 on error', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue(makeOrg());
      mockedAxios.post.mockRejectedValue(new Error('network error'));
      mockPrisma.organization.update.mockResolvedValue({});

      await service.run('org-1');

      expect(mockEligibilityCheck.runAndPersist).not.toHaveBeenCalled();
    });
  });
});
