import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { mapContactToDb } from '../../common/utils/hubspot.util';
import { contactToDbDictionary } from '../../common/dictionaries/contact-dictionary';
import { PrismaService } from '../../prisma/prisma.service';
import { CommissionStatus, USER } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { buildCommissionIdempotencyKey } from '../../common/utils/commission-idempotency';
import { CreateAffiliateProfileDto } from './dto/create-affiliate-profile.dto';
import {
  JoinProgramDto,
  LinkOrganizationDto,
  UpdateAffiliatePayoutPreferencesDto,
  UpdateAffiliateProfileDto,
} from './dto/update-affiliate-profile.dto';
import { ListAffiliatesDto } from './dto/list-affiliates.dto';
import { MailService } from '../../mail/mail.service';

import { getUserEmailTheme } from '../../common/utils/email-templates/theme-helper';
import { AffiliateCreationService } from '../../hubspot/create/affiliate';
import { AffiliateUpdateService } from '../../hubspot/update/affiliate';
import { HubspotService } from '../../hubspot/hubspot.service';
import { InvoiceIngestionService } from '../sync/invoice-ingestion.service';
import { CreateUserAndAffiliateProfileDto } from './dto/create-user-and-affiliate.dto';
import { InviteUserForAffiliateDto } from './dto/invite-user-for-affiliate.dto';
import { organizationIndustryToDbDictionary } from '../../common/dictionaries/organizationIndustry-dictionary';

import * as jwt from 'jsonwebtoken';
import { MedAllianceInvitation } from '../../common/utils/email-templates/med-alliance-invitation';
import { MedAllianceInvitationForOrgUsers } from '../../common/utils/email-templates/med-alliance-invitation-for-org-users';
import { MedAllianceInviteSignup } from '../../common/utils/email-templates/med-alliance-invite-signup';
import { AFFILIATE_VISIBLE_STATUSES } from '../../common/constant/commissions';
import { AllianceNotificationsService } from '../notifications/notifications.service';
import { EmailTemplatesService } from '../../email-templates/email-templates.service';

// Fields returned for the linked user — never expose password or sensitive tokens.
const USER_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  organization_id: true,
  role: true,
  status: true,
  status_before_deactivation: true,
};

@Injectable()
export class AffiliatesService {
  private readonly logger = new Logger(AffiliatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly affiliateCreationService: AffiliateCreationService,
    private readonly affiliateUpdateService: AffiliateUpdateService,
    private readonly hubspot: HubspotService,
    private readonly invoiceIngestion: InvoiceIngestionService,
    private readonly allianceNotifications: AllianceNotificationsService,
    private readonly emailTemplates: EmailTemplatesService,
  ) {}

  // Shared helper: ensure a user has an active AffiliateProfile.
  // Used by other services (commissions, payout-requests).
  async requireActiveProfile(userId: string) {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: userId },
    });
    if (!profile) {
      throw new ForbiddenException('Affiliate profile not found');
    }
    if (profile.status !== 'active') {
      throw new ForbiddenException('Affiliate profile is inactive');
    }
    return profile;
  }

  async create(dto: CreateAffiliateProfileDto, adminUser: USER) {
    const user = await this.prisma.uSER.findUnique({
      where: { id: dto.user_id },
      select: USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Prevent duplicate profile — give a clear message before hitting DB constraint.
    const existing = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: dto.user_id },
    });
    if (existing) {
      throw new ConflictException('This user already has an affiliate profile');
    }

    const profile = await this.prisma.affiliateProfile.create({
      data: {
        user_id: dto.user_id,
        hubspot_id: dto.hubspot_id ?? null,
        commission_percent_default: dto.commission_percent_default,
        payout_preference_method: dto.payout_preference_method ?? null,
        payout_preference_reference: dto.payout_preference_reference ?? null,
        payout_preference_notes: dto.payout_preference_notes ?? null,
        payout_details: dto.payout_details ?? undefined,
        created_by: adminUser.id,
      },
    });

    const newAffiliateData = await this.findOne(profile.id);

    // => Create Growth Partner in Hubspot
    try {
      await this.affiliateCreationService.execute(newAffiliateData);
      this.logger.log(
        `[Hubspot] Growth Partner created in Hubspot for affiliate profile ID: ${profile.id}`,
      );
    } catch (error) {
      await this.prisma.affiliateProfile.delete({ where: { id: profile.id } });
      this.logger.error(`Failed to create Growth Partner in Hubspot: ${error}`);
      throw new BadRequestException(
        error.message ||
          'Failed to create Growth Partner in Hubspot. The affiliate profile has not been created. Please try again later.',
      );
    }

    try {
      const theme = await getUserEmailTheme(this.prisma, dto.user_id);
      const fallbackSubject = `You're now a ${theme?.companyName || 'MedVirtual'} Med Alliance Partner — here's what's next`;
      const fallbackHtml = MedAllianceInvitation(
        user.first_name,
        theme ?? undefined,
      );
      const tpl = await this.emailTemplates.getTemplateContent(
        'med-alliance-invitation',
        {
          '{{firstName}}': user.first_name,
          '{{companyName}}': theme?.companyName || 'MedVirtual',
        },
        theme || {
          primaryColor: '#01546B',
          primaryColorHover: '#013A4F',
          secondaryColor: '#F8F9FA',
          accentColor: '#00B2E2',
          companyName: 'MedVirtual',
        },
      );
      await this.mailService.sendMail({
        from: `${theme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
        to: user.email,
        subject: tpl?.subject ?? fallbackSubject,
        html: tpl?.html ?? fallbackHtml,
      });
    } catch (emailError) {
      this.logger.error(
        `Failed to send Med Alliance invitation email: ${emailError}`,
      );
    }

    const partnerName =
      `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email;
    void this.allianceNotifications.notifyAdminPartnerRegistered({
      partnerName,
      partnerEmail: user.email,
      affiliateProfileId: newAffiliateData.id,
    });

    return newAffiliateData;
  }

  async createUserandAffiliate(
    dto: CreateUserAndAffiliateProfileDto,
    adminUser: USER,
  ) {
    //1. Create user
    const user = await this.prisma.uSER.create({
      data: {
        email: dto.email,
        first_name: dto.first_name,
        last_name: dto.last_name,
        phone: dto.phone_number ?? '',
        avatar: '',
        organization_name: '',
        role: dto.role,
        job_title: '',
        workos_id: '',
        password: '',
        authentication_method: 'OwnSign',
        status: 'invited',
      },
    });

    // Generate invitation token
    const code = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: '48h',
    });

    // Theme is resolved from the admin's org since the new user has no org yet
    const emailTheme = await getUserEmailTheme(this.prisma, adminUser.id);
    const baseInviteLink = `${process.env.FRONTEND_URL}/invite-signup?code=${code}`;
    const inviteLink =
      emailTheme?.companyName === 'Berry Virtual'
        ? `${baseInviteLink}&company=berry`
        : baseInviteLink;

    const fallbackSubject = `Welcome to ${emailTheme?.companyName || 'MedVirtual'} - Complete Your Affiliate Account Setup`;
    const fallbackHtml = MedAllianceInviteSignup(
      inviteLink,
      emailTheme || undefined,
      dto.first_name,
    );
    const tpl = await this.emailTemplates.getTemplateContent(
      'med-alliance-invite-signup',
      {
        '{{inviteLink}}': inviteLink,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
        '{{firstName}}': dto.first_name,
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: dto.email,
      subject: tpl?.subject ?? fallbackSubject,
      html: tpl?.html ?? fallbackHtml,
      headers: {
        'X-Mailer': `${emailTheme?.companyName || 'MedVirtual'} Platform`,
        'X-Priority': '3',
        'List-Unsubscribe': '<mailto:unsubscribe@medvirtual.ai>',
        'X-Entity-Ref-ID': `invite-${user.id}`,
      },
    });

    if (!mailSent) {
      throw new BadRequestException('Failed to send invitation email');
    }

    // Store the verification code in the database with an expiration time
    const codeExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours - same time as JWT
    const storeCode = await this.prisma.emailInvitation.create({
      data: {
        userId: user.id,
        email_from: dto.email,
        code: code,
        expiresAt: codeExpiresAt,
      },
    });
    if (!storeCode) {
      throw new BadRequestException('Failed to store invite code');
    }
    // End Create user

    // Prevent duplicate profile — give a clear message before hitting DB constraint.
    const existing = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: user.id },
    });
    if (existing) {
      throw new ConflictException('This user already has an affiliate profile');
    }

    const profile = await this.prisma.affiliateProfile.create({
      data: {
        user_id: user.id,
        hubspot_id: null,
        commission_percent_default: 7,
        payout_preference_method: null,
        payout_preference_reference: null,
        payout_preference_notes: null,
        payout_details: undefined,
        created_by: adminUser.id,
        status: 'invited',
      },
    });

    // Create a DB Contact record for the affiliate so phone/company are stored and linked
    await this.prisma.contact
      .create({
        data: {
          user_id: user.id,
          first_name: dto.first_name,
          last_name: dto.last_name,
          email: dto.email,
          phone: dto.phone_number ?? null,
          company_name: dto.company_name ?? null,
          referral_source: 'Referral - Partner',
        },
      })
      .catch(() => {}); // silently skip if a contact already exists for this user

    const newAffiliateData = await this.findOne(profile.id);

    // => Create Growth Partner in Hubspot
    try {
      await this.affiliateCreationService.execute(newAffiliateData);
      this.logger.log(
        `[Hubspot] Growth Partner created in Hubspot for affiliate profile ID: ${profile.id}`,
      );
    } catch (error) {
      await this.prisma.affiliateProfile.delete({ where: { id: profile.id } });
      this.logger.error(`Failed to create Growth Partner in Hubspot: ${error}`);
      throw new BadRequestException(
        error.message ||
          'Failed to create Growth Partner in Hubspot. The affiliate profile has not been created. Please try again later.',
      );
    }

    const partnerName =
      `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email;
    void this.allianceNotifications.notifyAdminPartnerRegistered({
      partnerName,
      partnerEmail: user.email,
      affiliateProfileId: newAffiliateData.id,
    });

    return newAffiliateData;
  }

  // Admin: invite a new user and link them to an existing affiliate that has no connected user.
  // Used when a growth partner was created in HubSpot without an associated contact.
  async inviteUserForAffiliate(
    id: string,
    dto: InviteUserForAffiliateDto,
    adminUserId: string,
  ) {
    const affiliate = await this.prisma.affiliateProfile.findUnique({
      where: { id },
    });
    if (!affiliate) throw new NotFoundException('Affiliate profile not found');
    if (affiliate.user_id)
      throw new BadRequestException(
        'This affiliate already has a connected user',
      );

    const emailInUse = await this.prisma.uSER.findUnique({
      where: { email: dto.email },
    });
    if (emailInUse)
      throw new ConflictException('A user with this email already exists');

    // 1. Create USER with status 'invited'
    const user = await this.prisma.uSER.create({
      data: {
        email: dto.email,
        first_name: dto.first_name,
        last_name: dto.last_name,
        phone: dto.phone_number ?? '',
        avatar: '',
        organization_name: '',
        role: 'affiliate',
        job_title: dto.job_title ?? '',
        workos_id: '',
        password: '',
        authentication_method: 'OwnSign',
        status: 'invited',
      },
    });

    // 2. Generate JWT invite token and send email
    const code = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: '48h',
    });
    // Theme is resolved from the admin's org since the new user has no org yet
    const emailTheme = await getUserEmailTheme(this.prisma, adminUserId);
    const baseInviteLink = `${process.env.FRONTEND_URL}/invite-signup?code=${code}`;
    const inviteLink =
      emailTheme?.companyName === 'Berry Virtual'
        ? `${baseInviteLink}&company=berry`
        : baseInviteLink;

    const fallbackSubject2 = `Welcome to ${emailTheme?.companyName || 'MedVirtual'} - Complete Your Affiliate Account Setup`;
    const tpl2 = await this.emailTemplates.getTemplateContent(
      'med-alliance-invite-signup',
      {
        '{{inviteLink}}': inviteLink,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
        '{{firstName}}': dto.first_name,
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: dto.email,
      subject: tpl2?.subject ?? fallbackSubject2,
      html:
        tpl2?.html ??
        MedAllianceInviteSignup(
          inviteLink,
          emailTheme || undefined,
          dto.first_name,
        ),
    });
    if (!mailSent)
      throw new BadRequestException('Failed to send invitation email');

    const codeExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await this.prisma.emailInvitation.create({
      data: {
        userId: user.id,
        email_from: dto.email,
        code,
        expiresAt: codeExpiresAt,
      },
    });

    // 3. Create Contact in DB
    await this.prisma.contact
      .create({
        data: {
          user_id: user.id,
          first_name: dto.first_name,
          last_name: dto.last_name,
          email: dto.email,
          phone: dto.phone_number ?? null,
          job_title: dto.job_title ?? null,
          company_name: dto.company_name ?? null,
          referral_source: 'Referral - Partner',
        },
      })
      .catch(() => {}); // skip silently if contact constraint is violated

    // 4. Link user to the affiliate profile
    await this.prisma.affiliateProfile.update({
      where: { id },
      data: { user_id: user.id },
    });

    // 5. Create HubSpot contact and link to existing Growth Partner (non-blocking)
    this.affiliateCreationService
      .createContactAndLinkToGrowthPartner(
        user.id,
        dto.first_name,
        dto.last_name,
        dto.email,
        affiliate.hubspot_id ?? null,
        dto.phone_number,
        dto.company_name,
      )
      .catch((err) =>
        this.logger.error(
          `[HubSpot] invite-user-for-affiliate background task failed: ${err}`,
        ),
      );

    return this.findOneEnriched(id);
  }

  async reInviteAffiliateUser(
    affiliateId: string,
    adminUserId: string,
  ): Promise<string> {
    const affiliate = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateId },
      include: { user: true },
    });
    if (!affiliate) throw new NotFoundException('Affiliate profile not found');
    if (!affiliate.user_id || !affiliate.user)
      throw new BadRequestException('Affiliate has no connected user');

    const user = affiliate.user;
    const code = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: '48h',
    });
    const emailTheme = await getUserEmailTheme(this.prisma, adminUserId);
    const baseInviteLink = `${process.env.FRONTEND_URL}/invite-signup?code=${code}`;
    const inviteLink =
      emailTheme?.companyName === 'Berry Virtual'
        ? `${baseInviteLink}&company=berry`
        : baseInviteLink;

    const fallbackSubjectReinvite = `Welcome to ${emailTheme?.companyName || 'MedVirtual'} - Complete Your Affiliate Account Setup`;
    const tplReinvite = await this.emailTemplates.getTemplateContent(
      'med-alliance-invite-signup',
      {
        '{{inviteLink}}': inviteLink,
        '{{companyName}}': emailTheme?.companyName || 'MedVirtual',
        '{{firstName}}': user.first_name,
      },
      emailTheme || {
        primaryColor: '#01546B',
        primaryColorHover: '#013A4F',
        secondaryColor: '#F8F9FA',
        accentColor: '#00B2E2',
        companyName: 'MedVirtual',
      },
    );
    const mailSent = await this.mailService.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: user.email,
      subject: tplReinvite?.subject ?? fallbackSubjectReinvite,
      html:
        tplReinvite?.html ??
        MedAllianceInviteSignup(
          inviteLink,
          emailTheme || undefined,
          user.first_name,
        ),
    });
    if (!mailSent)
      throw new BadRequestException('Failed to send re-invitation email');

    await this.prisma.emailInvitation.create({
      data: {
        userId: user.id,
        email_from: user.email,
        code,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    });

    return `Re-invitation sent successfully to ${user.email}`;
  }

  async findByUserId(userId: string) {
    return this.prisma.affiliateProfile.findUnique({
      where: { user_id: userId },
      include: {
        user: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            role: true,
            status: true,
          },
        },
      },
    });
  }

  async findAll(dto: ListAffiliatesDto) {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      banking,
      organization,
      payable,
      sortOrder = 'desc',
    } = dto;
    const skip = (page - 1) * limit;

    // Build where clause — search applies to the linked user's name/email.
    const where: any = {};
    if (status) where.status = status;

    // Each filter below pushes an independent condition into `andConditions`
    // rather than assigning to `where.OR` directly — banking, search, and
    // payable all need their own OR clause, and writing them straight to
    // `where.OR` would let the last one silently clobber the others.
    const andConditions: any[] = [];

    // Banking filter: complete = affiliate has a hubspot_billcom_vendor_id on their contact
    // (either the direct AffiliateProfile.contact or their user.contact — mirrors banking_complete in findOwn).
    if (banking === 'complete') {
      andConditions.push({
        OR: [
          { contact: { hubspot_billcom_vendor_id: { not: null } } },
          { user: { contact: { hubspot_billcom_vendor_id: { not: null } } } },
        ],
      });
    } else if (banking === 'incomplete') {
      andConditions.push(
        {
          OR: [
            { contact: { is: null } },
            { contact: { hubspot_billcom_vendor_id: null } },
          ],
        },
        {
          OR: [
            { user: { is: null } },
            { user: { contact: { is: null } } },
            { user: { contact: { hubspot_billcom_vendor_id: null } } },
          ],
        },
      );
    }

    if (search) {
      andConditions.push({
        OR: [
          { full_name: { contains: search.trim(), mode: 'insensitive' } },
          {
            user: { email: { contains: search.trim(), mode: 'insensitive' } },
          },
        ],
      });
    }

    if (organization === 'with_org') {
      where.user = { organization_id: { not: null } };
    } else if (organization === 'without_org') {
      where.user = { organization_id: null };
    }

    // Payable = affiliate can have a payout request created right now: at
    // least one eligible commission and a known Bill.com vendor id.
    if (payable) {
      andConditions.push(
        { commissions: { some: { status: 'eligible' } } },
        {
          OR: [
            { contact: { hubspot_billcom_vendor_id: { not: null } } },
            {
              user: { contact: { hubspot_billcom_vendor_id: { not: null } } },
            },
          ],
        },
      );
    }

    if (andConditions.length) where.AND = andConditions;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.affiliateProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: sortOrder },
        include: {
          contact: {
            select: { hubspot_billcom_vendor_id: true },
          },
          user: {
            select: {
              ...USER_SELECT,
              organization: {
                select: {
                  id: true,
                  name: true,
                  business_unit: true,
                  organization_role: true,
                  status: true,
                  admin: {
                    select: { id: true, first_name: true, last_name: true },
                  },
                },
              },
              _count: { select: { referredOrganizations: true } },
              contact: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  email: true,
                  job_title: true,
                  hubspot_billcom_vendor_id: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.affiliateProfile.count({ where }),
    ]);

    return { data, pagination: { page, limit, total } };
  }

  async getAdminDashboardStats() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      openPayouts,
      underReviewAgg,
      activeAffiliates,
      newReferrals,
      payoutGroups,
      requestedGroups,
    ] = await Promise.all([
      this.prisma.affiliatePayoutRequest.count({
        where: { status: 'requested' },
      }),
      this.prisma.affiliatePayoutRequest.aggregate({
        _sum: { requested_amount: true },
        where: { status: 'under_review' },
      }),
      this.prisma.affiliateProfile.count({ where: { status: 'active' } }),
      this.prisma.organization.count({
        where: {
          referred_by_affiliate_id: { not: null },
          createdAt: { gte: thirtyDaysAgo },
        },
      }),
      this.prisma.affiliatePayoutRequest.groupBy({
        by: ['status'],
        _count: { id: true },
        where: {
          status: { in: ['requested', 'under_review', 'paid', 'rejected'] },
        },
      }),
      // Fetch all affiliate groups with 'requested' payouts — filter for >1 in JS
      this.prisma.affiliatePayoutRequest.groupBy({
        by: ['affiliate_id'],
        _count: { id: true },
        where: { status: 'requested' },
      }),
    ]);

    const payoutSummaryMap: Record<string, number> = {};
    for (const row of payoutGroups) {
      payoutSummaryMap[row.status] = row._count.id;
    }

    const duplicateRiskFlags = requestedGroups.filter(
      (r) => r._count.id > 1,
    ).length;

    return {
      open_payout_requests: openPayouts,
      under_review_amount: Number(underReviewAgg._sum.requested_amount ?? 0),
      active_affiliates: activeAffiliates,
      new_referred_companies_30d: newReferrals,
      duplicate_risk_flags: duplicateRiskFlags,
      payout_summary: {
        submitted: payoutSummaryMap['requested'] ?? 0,
        under_review: payoutSummaryMap['under_review'] ?? 0,
        paid: payoutSummaryMap['paid'] ?? 0,
        rejected: payoutSummaryMap['rejected'] ?? 0,
      },
    };
  }

  async getMyStats(currentUser: USER) {
    await this.requireActiveProfile(currentUser.id);

    const [totalAgg, eligibleAgg, requestedAgg, lastPayout, recentCommissions] =
      await Promise.all([
        this.prisma.affiliateCommission.aggregate({
          _sum: { commission_amount: true },
          where: {
            affiliate_id: currentUser.id,
            status: { in: AFFILIATE_VISIBLE_STATUSES as CommissionStatus[] },
          },
        }),
        this.prisma.affiliateCommission.aggregate({
          _sum: { commission_amount: true },
          where: { affiliate_id: currentUser.id, status: 'eligible' },
        }),
        this.prisma.affiliatePayoutRequest.aggregate({
          _sum: { requested_amount: true },
          where: {
            affiliate_id: currentUser.id,
            status: { in: ['requested', 'under_review'] },
          },
        }),
        this.prisma.affiliatePayoutRequest.findFirst({
          where: { affiliate_id: currentUser.id, status: 'paid' },
          orderBy: { paid_at: 'desc' },
          select: { paid_amount: true, paid_at: true },
        }),
        this.prisma.affiliateCommission.findMany({
          where: {
            affiliate_id: currentUser.id,
            status: { in: AFFILIATE_VISIBLE_STATUSES as CommissionStatus[] },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            organization: { select: { id: true, name: true } },
            hubspotInvoiceSnapshot: {
              select: { hubspot_id: true, invoice_number: true },
            },
          },
        }),
      ]);

    return {
      total_earnings: Number(totalAgg._sum.commission_amount ?? 0),
      eligible_amount: Number(eligibleAgg._sum.commission_amount ?? 0),
      requested_amount: Number(requestedAgg._sum.requested_amount ?? 0),
      last_payout: lastPayout
        ? {
            paid_at: lastPayout.paid_at?.toISOString() ?? null,
            amount: Number(lastPayout.paid_amount ?? 0),
          }
        : null,
      recent_commissions: recentCommissions.map((c) => ({
        id: c.id,
        organization_id: c.organization_id,
        organization_name: c.organization?.name ?? '',
        invoice_number: c.hubspotInvoiceSnapshot?.invoice_number ?? null,
        invoice_hubspot_id: c.hubspotInvoiceSnapshot?.hubspot_id ?? null,
        base_amount: Number(c.base_amount_snapshot),
        commission_percentage: Number(c.commission_percent_snapshot),
        commission_amount: Number(c.commission_amount),
        status: c.status,
        created_at: c.createdAt.toISOString(),
      })),
    };
  }

  async findOne(id: string) {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id },
      include: {
        contact: {
          select: { hubspot_billcom_vendor_id: true },
        },
        user: {
          select: {
            ...USER_SELECT,
            hubspot_contact_id: true,
            referredOrganizations: {
              where: { status: { not: 'deleted' } },
              select: {
                id: true,
                name: true,
                email: true,
                status: true,
                med_alliance_referral_status: true,
                referral_stage: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'desc' as const },
            },
            phone: true,
            contact: {
              select: {
                company_name: true,
                hubspot_billcom_vendor_id: true,
              },
            },
            organization: {
              select: {
                id: true,
                name: true,
                business_unit: true,
                hubspot_id: true,
                organization_role: true,
                status: true,
                admin: {
                  select: { id: true, first_name: true, last_name: true },
                },
              },
            },
          },
        },
        commissions: {
          select: {
            id: true,
            status: true,
            commission_amount: true,
            createdAt: true,
            organization: { select: { id: true, name: true } },
            hubspot_invoice_snapshot_id: true,
            hubspotInvoiceSnapshot: {
              select: { hubspot_id: true, invoice_number: true },
            },
          },
          orderBy: { createdAt: 'desc' as const },
          take: 50,
        },
      },
    });
    if (!profile) throw new NotFoundException('Affiliate profile not found');
    return profile;
  }

  async update(id: string, dto: UpdateAffiliateProfileDto) {
    const existing = await this.findOne(id); // ensures it exists

    const updated = await this.prisma.affiliateProfile.update({
      where: { id },
      data: {
        ...(dto.commission_percent_default !== undefined && {
          commission_percent_default: dto.commission_percent_default,
        }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.payout_preference_method !== undefined && {
          payout_preference_method: dto.payout_preference_method,
        }),
        ...(dto.payout_preference_reference !== undefined && {
          payout_preference_reference: dto.payout_preference_reference,
        }),
        ...(dto.payout_preference_notes !== undefined && {
          payout_preference_notes: dto.payout_preference_notes,
        }),
        ...(dto.payout_details !== undefined && {
          payout_details: dto.payout_details ?? undefined,
        }),
      },
      include: { user: { select: USER_SELECT } },
    });

    if (existing.hubspot_id) {
      if (dto.commission_percent_default !== undefined) {
        try {
          await this.affiliateUpdateService.updateCommission(
            existing.hubspot_id,
            dto.commission_percent_default,
            undefined,
            undefined,
            `Affiliate commission percentage updated`,
          );
        } catch (err) {
          this.logger.error(`[HubSpot] Failed to sync commission: ${err}`);
        }
      }

      if (dto.payout_details !== undefined) {
        const details = dto.payout_details as Record<string, unknown> | null;
        if (
          details?.method === 'bill_com' &&
          details.account_name &&
          details.account_number
        ) {
          try {
            await this.affiliateUpdateService.updateBankingData(
              existing.hubspot_id,
              String(details.account_name),
              String(details.account_number),
              undefined,
              undefined,
              `Affiliate banking details updated`,
            );
          } catch (err) {
            this.logger.error(`[HubSpot] Failed to sync banking data: ${err}`);
          }
        } else if (details?.method === 'will_be_provided_later') {
          try {
            await this.affiliateUpdateService.clearBankingData(
              existing.hubspot_id,
              undefined,
              undefined,
              `Affiliate banking details cleared`,
            );
          } catch (err) {
            this.logger.error(`[HubSpot] Failed to clear banking data: ${err}`);
          }
        }
      }
    }

    return updated;
  }

  async findOwn(currentUser: USER) {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: currentUser.id },
      include: {
        contact: { select: { hubspot_billcom_vendor_id: true } },
        user: {
          select: {
            ...USER_SELECT,
            contact: { select: { hubspot_billcom_vendor_id: true } },
          },
        },
      },
    });
    if (!profile) throw new NotFoundException('Affiliate profile not found');

    const vendorId =
      profile.contact?.hubspot_billcom_vendor_id ??
      profile.user?.contact?.hubspot_billcom_vendor_id ??
      null;

    const mappedfields = {
      ...profile,
      banking_complete: !!vendorId,
      payout_details: {
        billcom_vendor_id: vendorId,
      },
    };
    return mappedfields;
  }

  // Self-enrollment: organization admin joins the Med Alliance Program.
  async joinProgram(currentUser: USER, dto: JoinProgramDto = {}) {
    if (
      !['organization_admin', 'organization_super_admin'].includes(
        currentUser.role,
      )
    ) {
      throw new ForbiddenException(
        'Only organization admins can join the Med Alliance Program',
      );
    }

    const existing = await this.prisma.affiliateProfile.findUnique({
      where: { user_id: currentUser.id },
    });
    if (existing) {
      throw new ConflictException('You already have an affiliate profile');
    }

    const profile = await this.prisma.affiliateProfile.create({
      data: {
        full_name: `${currentUser.first_name} ${currentUser.last_name}`,
        user_id: currentUser.id,
        commission_percent_default: 7,
        status: 'active',
        created_by: currentUser.id,
        payout_details: dto.payout_details ?? undefined,
      },
    });

    const newAffiliateData = await this.findOne(profile.id);

    // => Create Growth Partner in Hubspot
    try {
      await this.affiliateCreationService.execute(newAffiliateData);
      this.logger.log(
        `[Hubspot] Growth Partner created in Hubspot for affiliate profile ID: ${profile.id}`,
      );
    } catch (error) {
      await this.prisma.affiliateProfile.delete({ where: { id: profile.id } });
      throw new BadRequestException(
        error.message ||
          'Failed to create Growth Partner in Hubspot. The affiliate profile has not been created. Please try again later.',
      );
    }

    try {
      const theme = await getUserEmailTheme(this.prisma, currentUser.id);
      const fallbackSubjectOrg = `Welcome to the Med Alliance Program, ${currentUser.first_name}`;
      const fallbackHtmlOrg = MedAllianceInvitationForOrgUsers(
        currentUser.first_name,
        theme ?? undefined,
      );
      const tplOrg = await this.emailTemplates.getTemplateContent(
        'med-alliance-org-invitation',
        {
          '{{firstName}}': currentUser.first_name,
          '{{companyName}}': theme?.companyName || 'MedVirtual',
        },
        theme || {
          primaryColor: '#01546B',
          primaryColorHover: '#013A4F',
          secondaryColor: '#F8F9FA',
          accentColor: '#00B2E2',
          companyName: 'MedVirtual',
        },
      );
      await this.mailService.sendMail({
        from: `${theme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
        to: currentUser.email,
        subject: tplOrg?.subject ?? fallbackSubjectOrg,
        html: tplOrg?.html ?? fallbackHtmlOrg,
      });
    } catch (emailError) {
      this.logger.error(
        `Failed to send Med Alliance invitation email: ${emailError}`,
      );
    }

    return newAffiliateData;
  }

  // Admin: search for platform users that don't have an affiliate profile yet.
  async searchEligibleUsers(email: string) {
    if (!email || email.length < 3) return [];
    return this.prisma.uSER.findMany({
      where: {
        email: { contains: email, mode: 'insensitive' },
        //affiliateProfile: null,
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
      },
      take: 10,
    });
  }

  // Admin: list active organization_admin / organization_super_admin users
  // that do not yet have an affiliate profile — used to populate the
  // "Use an existing user" dropdown in the Create Affiliate modal.
  async findEligibleOrgUsers(search?: string) {
    const where: any = {
      status: 'active',
      role: { in: ['organization_admin', 'organization_super_admin'] },
      affiliateProfile: null,
    };

    if (search && search.trim().length > 0) {
      where.OR = [
        { first_name: { contains: search.trim(), mode: 'insensitive' } },
        { last_name: { contains: search.trim(), mode: 'insensitive' } },
        { email: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    return this.prisma.uSER.findMany({
      where,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
      },
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
      //take: 100,
    });
  }

  // Admin: get enriched affiliate detail — adds financial aggregates + payout history.
  // Keeps findOne() lightweight for internal use (create / joinProgram).
  async findOneEnriched(id: string) {
    const profile = await this.findOne(id);
    const userId = profile.user_id;
    const user = profile.user as any;

    // Affiliate with no connected user yet — return empty financial aggregates.
    if (!userId) {
      return {
        profile,
        pendingAgg: { _sum: { requested_amount: null } },
        lifetimeAgg: { _sum: { commission_amount: null } },
        payoutHistory: [],
        commsByOrg: [],
      };
    }

    const [pendingAgg, lifetimeAgg, payoutHistory, commsByOrg] =
      await Promise.all([
        this.prisma.affiliatePayoutRequest.aggregate({
          _sum: { requested_amount: true },
          where: {
            affiliate_id: userId,
            status: { in: ['requested', 'under_review'] },
          },
        }),
        this.prisma.affiliateCommission.aggregate({
          _sum: { commission_amount: true },
          where: {
            affiliate_id: userId,
            status: { notIn: ['void', 'rejected'] },
          },
        }),
        this.prisma.affiliatePayoutRequest.findMany({
          where: { affiliate_id: userId },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            paid_amount: true,
            paid_at: true,
            payment_method: true,
            transaction_reference: true,
            requested_amount: true,
          },
        }),
        this.prisma.affiliateCommission.groupBy({
          by: ['organization_id'],
          where: {
            affiliate_id: userId,
            status: { notIn: ['void', 'rejected'] },
          },
          _sum: { commission_amount: true },
        }),
      ]);
    return {
      profile,
      pendingAgg,
      lifetimeAgg,
      payoutHistory,
      commsByOrg,
      user,
    };
  }

  // Admin: deactivate an affiliate profile (and optionally the user account).
  // - If the user's role is 'affiliate': deactivates both the user account and the profile.
  // - If the user's role is 'organization_admin' or 'organization_super_admin': deactivates only the profile.
  async deactivate(id: string) {
    const profile = await this.findOne(id);
    const user = profile.user as any;

    await this.prisma.affiliateProfile.update({
      where: { id },
      data: { status: 'inactive' },
    });

    if (profile.user_id && user?.role === 'affiliate') {
      await this.prisma.uSER.update({
        where: { id: profile.user_id },
        data: {
          status: 'inactive',
          status_before_deactivation: user.status,
        },
      });
    }

    if (profile.hubspot_id) {
      await this.affiliateUpdateService.deactivate(
        profile.hubspot_id,
        undefined,
        undefined,
        `Affiliate growth partner profile deactivated`,
      );
    }
  }

  // Admin: delete an invited affiliate profile (only allowed for status='invited').
  // - If the user's role is 'affiliate': soft-deletes the user account AND hard-deletes the profile.
  // - If the user's role is 'organization_admin' or 'organization_super_admin': deletes only the profile.
  async deleteInvited(id: string) {
    const profile = await this.findOne(id);
    const user = profile.user as any;

    if (profile.status !== 'invited') {
      throw new BadRequestException('Only invited affiliates can be deleted');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliateProfile.delete({ where: { id } });
      if (profile.user_id && user?.id) {
        await tx.emailInvitation.deleteMany({ where: { userId: user.id } });
        await tx.uSER.delete({ where: { id: user.id } });
      }
    });
  }

  // Admin: reactivate an inactive affiliate profile (and user account if role is 'affiliate').
  // - If the user's role is 'affiliate': restores user status (from status_before_deactivation or 'active') AND profile status → 'active'.
  // - If the user's role is 'organization_admin' or 'organization_super_admin': reactivates profile only.
  async reactivate(id: string) {
    const profile = await this.findOne(id);
    const user = profile.user as any;

    if (profile.status !== 'inactive') {
      throw new BadRequestException(
        'Only inactive affiliates can be reactivated',
      );
    }

    // Always reactivate the affiliate profile
    await this.prisma.affiliateProfile.update({
      where: { id },
      data: { status: 'active' },
    });

    // If user role is 'affiliate', restore the user account status
    if (profile.user_id && user?.role === 'affiliate') {
      await this.prisma.uSER.update({
        where: { id: profile.user_id },
        data: {
          status: user.status_before_deactivation ?? 'active',
          status_before_deactivation: null,
        },
      });
    }

    if (profile.hubspot_id) {
      // Growth Partner still exists in HubSpot (deactivated via app) — just update the stage.
      await this.affiliateUpdateService.reactivate(
        profile.hubspot_id,
        undefined,
        undefined,
        `Affiliate growth partner profile reactivated`,
      );
    } else {
      // Growth Partner was deleted in HubSpot — recreate it with all associations.
      // Fetch again so execute() receives status='active' for the correct pipeline stage.
      const updatedProfile = await this.findOne(id);
      try {
        await this.affiliateCreationService.execute(updatedProfile);
      } catch (error) {
        this.logger.error(
          `[HubSpot] Failed to recreate Growth Partner on reactivation: ${error}`,
        );
      }
    }
  }

  // Admin: link the affiliate's connected user to an existing organization.
  async linkOrganization(id: string, dto: LinkOrganizationDto) {
    const profile = await this.findOne(id); // ensures profile exists
    if (!profile.user_id)
      throw new BadRequestException('Affiliate has no connected user');

    const org = await this.prisma.organization.findUnique({
      where: { id: dto.organization_id },
      select: { id: true },
    });
    if (!org) throw new NotFoundException('Organization not found');

    await this.prisma.uSER.update({
      where: { id: profile.user_id },
      data: { organization_id: dto.organization_id },
    });

    return this.findOne(id);
  }

  // Admin: preview what an association would produce (org info + invoice snapshots + projected eligibility).
  async previewAssociation(affiliateProfileId: string, organizationId: string) {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateProfileId },
      select: { commission_percent_default: true },
    });
    if (!profile) throw new NotFoundException('Affiliate profile not found');

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        status: true,
        email: true,
        industry: true,
        location: true,
        hubspot_id: true,
        contact_first_name: true,
        contact_last_name: true,
        contact_email: true,
        med_alliance_referral_status: true,
        eligibility_start_at: true,
        first_paid_invoice_at: true,
        deployment_date: true,
      },
    });
    if (!org) throw new NotFoundException('Organization not found');

    const invoices = await this.prisma.hubspotInvoiceSnapshot.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        hubspot_id: true,
        invoice_amount: true,
        invoice_status: true,
        payment_status: true,
        currency: true,
        paid_at: true,
        createdAt: true,
        hubspot_pdf_link: true,
      },
      orderBy: { paid_at: 'asc' },
    });

    // Canonical candidate-invoice rule (must match InvoicesService.computeIsCandidateInput
    // and _backfillOnAssociation) — deliberately does NOT require paid_at, which frequently
    // fails to resolve during HubSpot sync even for genuinely paid invoices.
    const candidateInvoices = invoices.filter(
      (i) =>
        i.invoice_status === 'paid' &&
        new Decimal(i.invoice_amount ?? 0).gt(0) &&
        (i.payment_status === null || i.payment_status === 'succeeded'),
    );

    const firstCandidate = candidateInvoices[0];
    // Prefer HubSpot's deployment_date as the eligibility anchor; otherwise use the earliest
    // candidate invoice's paid_at, falling back to its created_at when paid_at never resolved
    // so a real candidate invoice doesn't collapse the anchor back to null.
    const deploymentDate =
      org.deployment_date ??
      firstCandidate?.paid_at ??
      firstCandidate?.createdAt ??
      null;
    const now = new Date();
    const daysSince =
      deploymentDate != null
        ? (now.getTime() - deploymentDate.getTime()) / (1000 * 60 * 60 * 24)
        : null;

    // Mirrors _backfillOnAssociation: decisions are available immediately once deployed,
    // no 30-day stabilization tier. More than 365 days since deployment, the org expires.
    let eligibilityWindow: 'no_invoices' | 'pending' | 'expired';
    let commissionStatus: 'detected' | null;
    if (daysSince === null) {
      eligibilityWindow = 'no_invoices';
      commissionStatus = null;
    } else if (daysSince > 365) {
      eligibilityWindow = 'expired';
      commissionStatus = null;
    } else {
      eligibilityWindow = 'pending';
      commissionStatus = 'detected';
    }

    // Once expired, the backfill creates zero commissions (early return before
    // the commission-creation loop) — the preview must mirror that exactly,
    // both in the projected count and in the invoice list shown to the admin.
    const eligibleInvoicesForResponse =
      eligibilityWindow === 'expired' ? [] : candidateInvoices;

    return {
      first_paid_invoice_at: deploymentDate?.toISOString() ?? null,
      organization: {
        ...org,
        industry: org.industry
          ? (organizationIndustryToDbDictionary[org.industry] ?? org.industry)
          : null,
        eligibility_start_at: org.eligibility_start_at?.toISOString() ?? null,
        first_paid_invoice_at: org.first_paid_invoice_at?.toISOString() ?? null,
        deployment_date: org.deployment_date?.toISOString() ?? null,
      },
      invoices: eligibleInvoicesForResponse.map((i) => ({
        id: i.id,
        hubspot_id: i.hubspot_id,
        invoice_amount: i.invoice_amount?.toString() ?? '0',
        invoice_status: i.invoice_status,
        currency: i.currency,
        paid_at: i.paid_at?.toISOString() ?? null,
        created_at: i.createdAt.toISOString(),
        hubspot_pdf_link: i.hubspot_pdf_link ?? null,
      })),
      projection: {
        deployment_date: deploymentDate?.toISOString() ?? null,
        days_since_deployment:
          daysSince !== null ? Math.floor(daysSince) : null,
        eligibility_window: eligibilityWindow,
        commission_status: commissionStatus,
        projected_commission_count: eligibleInvoicesForResponse.length,
        affiliate_commission_percent:
          profile.commission_percent_default.toNumber(),
      },
    };
  }

  // Admin: associate an existing organization as a referral for this affiliate.
  async associateCompany(
    affiliateId: string,
    organizationId: string,
    adminUser: USER,
  ) {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateId },
      select: { id: true, user_id: true, status: true },
    });
    if (!profile) throw new NotFoundException('Affiliate profile not found');

    if (!profile.user_id)
      throw new BadRequestException(
        'Affiliate has no connected user. Please invite this Partner as user first before associating referred companies.',
      );

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, referred_by_affiliate_id: true },
    });
    if (!org) throw new NotFoundException('Organization not found');
    if (org.referred_by_affiliate_id !== null)
      throw new BadRequestException(
        'This company already has an affiliate referral',
      );

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { referred_by_affiliate_id: profile.user_id },
    });

    // Backfill: detect existing paid invoices and create commissions retroactively.
    await this._backfillOnAssociation(
      affiliateId,
      profile.user_id,
      organizationId,
      adminUser,
    );

    void this.hubspot.setCompanyAffiliateReferral(
      organizationId,
      profile.user_id,
      adminUser.id,
    );

    return this.findOne(affiliateId);
  }

  private async _backfillOnAssociation(
    affiliateProfileId: string,
    affiliateUserId: string,
    organizationId: string,
    adminUser: USER,
  ): Promise<void> {
    const orgData = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { hubspot_id: true, deployment_date: true },
    });

    if (orgData?.hubspot_id) {
      await this.invoiceIngestion.run(organizationId, orgData.hubspot_id);
    }

    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const now = new Date();

    const snapshots = await this.prisma.hubspotInvoiceSnapshot.findMany({
      where: {
        organization_id: organizationId,
        invoice_status: 'paid',
        invoice_amount: { gt: 0 },
      },
      select: {
        id: true,
        hubspot_id: true,
        invoice_amount: true,
        payment_status: true,
        paid_at: true,
      },
      orderBy: { paid_at: 'asc' },
    });

    const candidates = snapshots.filter(
      (s) => s.payment_status === null || s.payment_status === 'succeeded',
    );

    if (candidates.length === 0 && !orgData?.deployment_date) return;

    const firstInvoiceDate = candidates[0]?.paid_at ?? now;
    // Prefer deployment_date from HubSpot as the anchor for eligibility calculations.
    const anchorDate = orgData?.deployment_date ?? firstInvoiceDate;
    const daysSinceDeployment =
      (now.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24);

    // Decisions are available immediately once deployed — no 30-day stabilization tier.
    // More than 365 days since deployment_date, the org expires directly.
    const isExpired = daysSinceDeployment > 365;

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        referral_stage: 'deployed',
        // Only set first_paid_invoice_at when there is an actual invoice (audit field — never set to synthetic 'now')
        ...(candidates.length > 0 && {
          first_paid_invoice_at: firstInvoiceDate,
        }),
        eligibility_start_at: anchorDate,
        med_alliance_block_reason: null,
        med_alliance_referral_status: (isExpired
          ? 'expired'
          : 'pending_confirmation') as any,
      },
    });

    await this.prisma.medAllianceAuditLog.create({
      data: {
        entity_type: 'referred_company',
        entity_id: organizationId,
        event: 'stage_changed',
        old_status: 'pending_confirmation',
        new_status: isExpired ? 'expired' : 'pending_confirmation',
        reason:
          'Company associated by admin — retroactive deployment date set from first paid invoice',
        source: 'admin_action',
        actor_user_id: adminUser.id,
        metadata: {
          referral_stage: 'deployed',
          eligibility_start_at: anchorDate.toISOString(),
          days_since_first_invoice: Math.floor(daysSinceDeployment),
          result: isExpired ? 'expired' : 'pending_confirmation',
        } as any,
      },
    });

    if (isExpired) return;

    const affiliateProfile = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateProfileId },
      select: { id: true, commission_percent_default: true, status: true },
    });

    if (!affiliateProfile || affiliateProfile.status !== 'active') return;

    // Company just landed on pending_confirmation (not yet confirmed eligible), so backfilled
    // commissions start as 'detected' and wait for an admin decision.
    const commissionStatus = 'detected';
    const auditEvent = 'commission_detected';

    for (const snapshot of candidates) {
      const idempotencyKey = buildCommissionIdempotencyKey({
        affiliateId: affiliateUserId,
        hubspotInvoiceId: snapshot.hubspot_id,
      });

      try {
        const commissionAmount = new Decimal(snapshot.invoice_amount)
          .mul(affiliateProfile.commission_percent_default)
          .div(100)
          .toDecimalPlaces(2);

        await this.prisma.affiliateCommission.create({
          data: {
            affiliate_id: affiliateUserId,
            affiliate_profile_id: affiliateProfileId,
            organization_id: organizationId,
            hubspot_invoice_snapshot_id: snapshot.id,
            commission_percent_snapshot:
              affiliateProfile.commission_percent_default,
            base_amount_snapshot: snapshot.invoice_amount,
            commission_amount: commissionAmount,
            status: commissionStatus as CommissionStatus,
            idempotency_key: idempotencyKey,
          },
        });

        await this.prisma.medAllianceAuditLog.create({
          data: {
            entity_type: 'commission',
            entity_id: idempotencyKey,
            event: auditEvent,
            old_status: null,
            new_status: commissionStatus,
            reason: 'Created via admin company association backfill',
            source: 'admin_action',
            actor_user_id: adminUser.id,
            metadata: {
              organization_id: organizationId,
              hubspot_invoice_id: snapshot.hubspot_id,
            } as any,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') continue;
        this.logger.error(
          `Backfill commission failed for invoice ${snapshot.id}: ${err?.message}`,
        );
      }
    }
  }

  // Affiliate: update only payout preferences on own profile.
  async updateOwn(currentUser: USER, dto: UpdateAffiliatePayoutPreferencesDto) {
    const profile = await this.requireActiveProfile(currentUser.id);

    const updated = await this.prisma.affiliateProfile.update({
      where: { id: profile.id },
      data: {
        ...(dto.payout_preference_method !== undefined && {
          payout_preference_method: dto.payout_preference_method,
        }),
        ...(dto.payout_preference_reference !== undefined && {
          payout_preference_reference: dto.payout_preference_reference,
        }),
        ...(dto.payout_preference_notes !== undefined && {
          payout_preference_notes: dto.payout_preference_notes,
        }),
        ...(dto.payout_details !== undefined && {
          payout_details: dto.payout_details ?? null,
        }),
      },
      include: { user: { select: USER_SELECT } },
    });

    if (profile.hubspot_id && dto.payout_details !== undefined) {
      const details = dto.payout_details as Record<string, unknown> | null;
      if (details?.method === 'will_be_provided_later') {
        try {
          await this.affiliateUpdateService.clearBankingData(
            profile.hubspot_id,
            undefined,
            undefined,
            `Affiliate banking details cleared during profile reset`,
          );
        } catch (err) {
          this.logger.error(`[HubSpot] Failed to clear banking data: ${err}`);
        }
      }
    }

    return updated;
  }
}
