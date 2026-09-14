import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { CandidatesService } from '../candidate/candidates.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { HireRequestService } from '../hire-request/hire-request.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import {
  USER,
  TicketAuditSource,
  OfferPanelStatus,
  OfferPanelAuditSource,
} from '@prisma/client';
import {
  TicketAuditService,
  TICKET_AUDIT_EVENTS,
  TICKET_AUDIT_ORIGINS,
  buildActorLabel,
} from '../ticket/ticket-audit.service';
import {
  OfferPanelsAuditService,
  OFFER_PANEL_AUDIT_EVENTS,
  OFFER_PANEL_AUDIT_ORIGINS,
  recipientActorLabel,
} from './offer-panels-audit.service';
import {
  OFFER_PANEL_PROMO_PRICE_LABEL,
  offerPanelPromoMetadata,
} from '../common/constant/offer-panel-promo.constant';
import { QueryOfferPanelsDto } from './dto/query-offer-panels.dto';
import { OfferPanelStatsQueryDto } from './dto/offer-panel-stats.dto';
import {
  CreateOfferPanelDto,
  RecipientDto,
} from './dto/create-offer-panel.dto';
import { buildHireRequestTitle } from '../common/utils/hireRequestTitle.util';

/** Panel tally per lifecycle status, one entry per status tab in the UI. */
export type OfferPanelStatusCounts = Record<OfferPanelStatus, number>;

/** A zeroed tally, so statuses with no rows still report 0 rather than absent. */
function emptyOfferPanelStatusCounts(): OfferPanelStatusCounts {
  return Object.values(OfferPanelStatus).reduce(
    (acc, status) => ({ ...acc, [status]: 0 }),
    {} as OfferPanelStatusCounts,
  );
}

// ── Offer-panel analytics (Operational Dashboard) ───────────────────────────

/** A panel with no view after this many days counts as awaiting a response. */
const AWAITING_RESPONSE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface OfferPanelSenderStats {
  userId: string;
  name: string;
  email: string;
  sent: number;
  viewed: number;
  accepted: number;
  declined: number;
  total: number;
  acceptedPct: number;
  declinedPct: number;
  totalCandidates: number;
  lastSentAt: string | null;
}

export interface OfferPanelTopSender {
  userId: string;
  name: string;
  count: number;
}

export interface OfferPanelMonthlyBucket {
  month: string;
  sent: number;
  accepted: number;
  declined: number;
}

export interface OfferPanelStats {
  totals: {
    sent: number;
    viewed: number;
    accepted: number;
    declined: number;
    total: number;
  };
  rates: { acceptanceRate: number; declineRate: number; viewRate: number };
  speed: {
    avgTimeToViewHours: number;
    avgTimeToDecisionHours: number;
    awaitingResponse: number;
  };
  funnel: { sent: number; viewed: number; decided: number; accepted: number };
  topSenders: {
    mostSent: OfferPanelTopSender | null;
    mostAccepted: OfferPanelTopSender | null;
    mostDeclined: OfferPanelTopSender | null;
  };
  senders: OfferPanelSenderStats[];
  monthly: OfferPanelMonthlyBucket[];
}

/** Mutable per-sender tally, collapsed into `OfferPanelSenderStats` at the end. */
interface SenderAccumulator {
  userId: string;
  counts: OfferPanelStatusCounts;
  viewed: number;
  totalCandidates: number;
  total: number;
  lastSentAt: Date | null;
}

/**
 * A percentage rounded to one decimal. An empty denominator yields 0, never
 * NaN or Infinity — the dashboard renders these directly.
 */
function percentage(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Mean of a set of millisecond durations, expressed in hours; 0 when empty. */
function averageHours(durationsMs: number[]): number {
  if (!durationsMs.length) return 0;
  const total = durationsMs.reduce((sum, ms) => sum + ms, 0);
  return round1(total / durationsMs.length / MS_PER_HOUR);
}

/** The leading sender by some measure, or null when nobody scores above zero. */
function topSender(
  senders: OfferPanelSenderStats[],
  measure: (sender: OfferPanelSenderStats) => number,
): OfferPanelTopSender | null {
  let best: OfferPanelSenderStats | null = null;
  for (const sender of senders) {
    if (measure(sender) > 0 && (!best || measure(sender) > measure(best))) {
      best = sender;
    }
  }
  if (!best) return null;
  return { userId: best.userId, name: best.name, count: measure(best) };
}

/** The zero state, shared by the empty-result and unresolvable-BU paths. */
function emptyOfferPanelStats(): OfferPanelStats {
  return {
    totals: { sent: 0, viewed: 0, accepted: 0, declined: 0, total: 0 },
    rates: { acceptanceRate: 0, declineRate: 0, viewRate: 0 },
    speed: {
      avgTimeToViewHours: 0,
      avgTimeToDecisionHours: 0,
      awaitingResponse: 0,
    },
    funnel: { sent: 0, viewed: 0, decided: 0, accepted: 0 },
    topSenders: { mostSent: null, mostAccepted: null, mostDeclined: null },
    senders: [],
    monthly: [],
  };
}

const CANDIDATE_CARD_SELECT = {
  id: true,
  hubspot_id: true,
  first_name: true,
  last_name: true,
  name: true,
  country: true,
  employment_type: true,
  hourly_pay_rate: true,
  years_of_experience: true,
  about_me: true,
  specialization: true,
  tools: true,
  medical_tools: true,
  avatar_url: true,
  gender: true,
  shift_block: true,
  video_link: true,
  approved_positions_pairing: true,
  business_unit: true,
  active_listening_and_comprehension_demonstrated: true,
  adaptability_to_different_client_personalities_and_workflows: true,
  can_articulate_experience_clearly_to_clients: true,
  can_multitask_between_systems_or_windows_efficiently: true,
  client_readiness___fit_evaluator_notes: true,
  comfortable_with_basic_tools__google_workspace__zoom__ehr_software_: true,
  comfortable_with_camera_on_setup: true,
  communication_skills_evaluator_notes: true,
  confident_on_video_and_phone_calls: true,
  cultural_alignment_with_us_healthcare_environment: true,
  demonstrates_problem_solving_and_tech_adaptability: true,
  demonstrates_stability_and_commitment: true,
  demonstrates_understanding_of_medical_terminology_and_procedures: true,
  exhibits_confidence_and_empathy_in_roleplay_scenarios: true,
  familiarity_with_emr_ehr_systems__kareo__athena__eclinicalworks__etc__: true,
  for_bilinguals__fluent_and_accurate_in_both_english_and_spanish: true,
  grammar__vocabulary__and_tone_are_appropriate_for_us_clients: true,
  handles_feedback_constructively: true,
  has_functioning_headset__webcam__and_backup_device: true,
  knowledge_of_hipaa_compliance_and_confidentiality: true,
  medical_knowledge_evaluator_notes: true,
  no_medical_industry_experience: true,
  positive_attitude_and_professional_demeanor: true,
  prior_experience_in_healthcare_or_medical_va_roles: true,
  professionalism___work_readiness_evaluator_notes: true,
  punctual_and_responsive_during_recruitment_stages: true,
  remote_work_discipline_and_time_management: true,
  speaks_clearly_and_professionally: true,
  stable_internet_connection__min__20_mbps_: true,
  technical_competence_evaluator_notes: true,
  tier_level: true,
  total_points: true,
  understands_workflow_in_medical_offices___telehealth_environments: true,
  languages: { select: { name: true } },
  skills: { select: { skill_name: true, skill_type: true } },
  educations: { select: { institution: true, degree: true, year: true } },
  experiences: {
    orderBy: { start_date: 'desc' as const },
    select: {
      company: true,
      position: true,
      start_date: true,
      end_date: true,
      responsabilities: true,
    },
  },
} as const;

const OFFER_PANEL_INCLUDE = {
  createdBy: {
    select: { id: true, first_name: true, last_name: true, email: true },
  },
  recipientUser: {
    select: { id: true, first_name: true, last_name: true, email: true },
  },
  recipientCompany: {
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
  candidates: {
    select: {
      id: true,
      candidate_id: true,
      createdAt: true,
      candidate: { select: CANDIDATE_CARD_SELECT },
    },
  },
  hireRequest: {
    select: { id: true, status: true, title: true, createdAt: true },
  },
} as const;

@Injectable()
export class OfferPanelsService {
  private readonly logger = new Logger(OfferPanelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => CandidatesService))
    private readonly candidatesService: CandidatesService,
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => HubspotService))
    private readonly hubspot: HubspotService,
    @Inject(forwardRef(() => HireRequestService))
    private readonly hireRequestService: HireRequestService,
    private readonly businessUnitContext: BusinessUnitContext,
    private readonly ticketAudit: TicketAuditService,
    private readonly panelAudit: OfferPanelsAuditService,
  ) {}

  /**
   * Maps the flat recipient_* columns onto the nested `recipient` shape the
   * frontend expects (OfferPanelRecipient in lib/offer-panels/types.ts).
   *
   * Also the single choke point for `public_token` exposure. The token is the panel's
   * ONLY access credential — anyone holding it can view, accept or decline without
   * authenticating. Every read path spreads the whole Prisma row through here (the
   * queries use `include`, not `select`), so the token is stripped unless the viewer
   * holds a system role.
   *
   * Public/unauthenticated reads (findByToken) pass `viewerRole: null`: the caller
   * already has the token, so echoing it back only puts a live credential into browser
   * logs and screenshots for no benefit.
   */
  private withRecipient<T extends Record<string, any>>(
    panel: T,
    viewerRole?: string | null,
  ): T & { recipient: Record<string, any> } {
    const isSystemRole =
      viewerRole === 'system_admin' || viewerRole === 'system_super_admin';
    const { public_token: _public_token, ...withoutToken } = panel as T & {
      public_token?: string | null;
    };

    return {
      ...((isSystemRole ? panel : withoutToken) as T),
      recipient: {
        recipient_type: panel.recipient_type,
        id: panel.recipient_user_id ?? null,
        user_id: panel.recipient_user_id ?? null,
        company_id: panel.recipient_company_id ?? null,
        company_name: panel.recipient_org_name ?? null,
        name: panel.recipient_name,
        email: panel.recipient_email,
        organization: panel.recipientCompany
          ? {
              id: panel.recipientCompany.id,
              name: panel.recipientCompany.name,
              business_unit: panel.recipientCompany.business_unit ?? null,
              organization_role:
                panel.recipientCompany.organization_role ?? null,
              status: panel.recipientCompany.status ?? null,
              admin: panel.recipientCompany.admin
                ? {
                    id: panel.recipientCompany.admin.id,
                    first_name: panel.recipientCompany.admin.first_name,
                    last_name: panel.recipientCompany.admin.last_name,
                  }
                : null,
            }
          : null,
      },
    };
  }

  // Loads the full TalentPoolCandidate shape (rates, avatar URL, labels...)
  // for a list of candidate IDs, matching what findOne/findByToken already do.
  private async enrichCandidates(candidateIds: string[]): Promise<any[]> {
    return Promise.all(
      candidateIds.map((id) =>
        this.candidatesService.getTalentPoolCandidateById(id),
      ),
    );
  }

  // Returns the number of other active offer panels (sent or viewed) that also
  // contain this candidate, excluding the current panel.
  private async countOtherPanels(
    candidateId: string,
    excludePanelId: string,
  ): Promise<number> {
    return this.prisma.offerPanelCandidate.count({
      where: {
        candidate_id: candidateId,
        offer_panel_id: { not: excludePanelId },
        offerPanel: { status: { in: ['sent', 'viewed'] } },
      },
    });
  }

  private async retryHubspot<T>(
    fn: () => Promise<T>,
    retries = 3,
    delay = 500,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        retries > 0 &&
        axios.isAxiosError(err) &&
        err.response?.status === 429
      ) {
        await new Promise((r) => setTimeout(r, delay));
        return this.retryHubspot(fn, retries - 1, delay * 2);
      }
      throw err;
    }
  }

  private async warnIfNoHubspotOwner(userId: string): Promise<void> {
    const user = await this.prisma.uSER.findUnique({
      where: { id: userId },
      select: { hubspot_id: true },
    });
    if (!user?.hubspot_id) {
      this.logger.warn(
        `R11 E11: user ${userId} has no hubspot_id — HireRequest HubSpot ticket will have no owner`,
      );
    }
  }

  async searchContacts(q: string, businessUnit: string): Promise<any[]> {
    const term = q.trim();
    businessUnit =
      businessUnit === 'BerryVirtual'
        ? 'Berry Virtual'
        : businessUnit === 'Med Virtual'
          ? 'MedVirtual'
          : businessUnit;
    const tokens = term.split(/\s+/).filter(Boolean);
    const makeTokenFilter = (extra: string[] = []) =>
      tokens.map((t) => ({
        OR: [
          { first_name: { contains: t, mode: 'insensitive' as const } },
          { last_name: { contains: t, mode: 'insensitive' as const } },
          { email: { contains: t, mode: 'insensitive' as const } },
          ...extra.map((f) => ({
            [f]: { contains: t, mode: 'insensitive' as const },
          })),
        ],
      }));
    const [users, contacts] = await Promise.all([
      this.prisma.uSER.findMany({
        where: {
          role: { in: ['organization_admin', 'organization_super_admin'] },
          organization: { business_unit: businessUnit },
          AND: makeTokenFilter(),
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          organization: { select: { id: true, name: true } },
        },
        take: 20,
      }),
      this.prisma.contact.findMany({
        where: {
          user_id: { not: null },
          user: {
            role: { in: ['organization_admin', 'organization_super_admin'] },
            organization: { business_unit: businessUnit },
          },
          AND: makeTokenFilter(['company_name']),
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          company_name: true,
          user_id: true,
          organization: { select: { id: true, name: true } },
        },
        take: 20,
      }),
    ]);

    // Users take priority; track emails already covered
    const seenEmails = new Set<string>();
    const results: any[] = [];

    for (const u of users) {
      if (!u.email) continue;
      seenEmails.add(u.email.toLowerCase());
      results.push({
        id: u.id,
        name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
        email: u.email,
        company_name: u.organization?.name ?? null,
        company_id: u.organization?.id ?? null,
        recipient_type: 'client_user',
        user_id: u.id,
      });
    }

    for (const c of contacts) {
      if (!c.email) continue;
      if (seenEmails.has(c.email.toLowerCase())) continue;
      seenEmails.add(c.email.toLowerCase());
      results.push({
        id: c.id,
        name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(),
        email: c.email,
        company_name: c.company_name ?? c.organization?.name ?? null,
        company_id: c.organization?.id ?? null,
        recipient_type: c.user_id ? 'client_user' : 'company_contact',
        user_id: c.user_id ?? null,
      });
    }

    return results.slice(0, 20);
  }

  async create(dto: CreateOfferPanelDto, adminUser: USER): Promise<any[]> {
    // --- Validation phase (no DB writes yet) ---
    const errors: string[] = [];

    // Validate business_unit against the currently visible BU set. Kept out
    // of the DTO (class-validator decorators can't do async DB lookups)
    // so new BUs (e.g. MMVA) become valid the moment they're made visible,
    // with no code change.
    const isBusinessUnitAllowed =
      await this.businessUnitContext.isAllowedHubspotValue(dto.business_unit);
    if (!isBusinessUnitAllowed) {
      errors.push(
        `business_unit '${dto.business_unit}' is not a visible business unit`,
      );
    }

    // Validate candidates exist
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: dto.candidateIds } },
      select: { id: true },
    });
    const foundCandidateIds = new Set(candidates.map((c) => c.id));
    const missingCandidates = dto.candidateIds.filter(
      (id) => !foundCandidateIds.has(id),
    );
    if (missingCandidates.length > 0) {
      errors.push(`Candidates not found: ${missingCandidates.join(', ')}`);
    }

    // Validate recipients and collect org names
    const emailsSeen = new Set<string>();
    const recipientMeta: Array<{
      orgName: string | null;
      resolvedUserId: string | null;
    }> = [];

    for (let i = 0; i < dto.recipients.length; i++) {
      const r = dto.recipients[i];
      const label = `Recipient ${i + 1} (${r.email})`;

      // Duplicate email check
      const emailKey = r.email.toLowerCase();
      if (emailsSeen.has(emailKey)) {
        errors.push(`${label}: duplicate email in batch`);
      }
      emailsSeen.add(emailKey);

      let orgName: string | null = null;
      let resolvedUserId: string | null = null;

      if (r.recipient_type === 'client_user') {
        if (!r.user_id) {
          errors.push(`${label}: user_id is required for type client_user`);
          recipientMeta.push({ orgName: null, resolvedUserId: null });
          continue;
        }
        const user = await this.prisma.uSER.findUnique({
          where: { id: r.user_id },
          select: {
            id: true,
            role: true,
            organization: { select: { name: true } },
          },
        });
        if (!user) {
          errors.push(`${label}: user_id ${r.user_id} not found`);
        } else if (
          user.role !== 'organization_admin' &&
          user.role !== 'organization_super_admin'
        ) {
          errors.push(
            `${label}: user must be an organization admin, got role '${user.role}'`,
          );
        } else {
          orgName = user.organization?.name ?? null;
          resolvedUserId = user.id;
        }
      } else if (r.recipient_type === 'company_contact') {
        if (!r.company_id) {
          errors.push(
            `${label}: company_id is required for type company_contact`,
          );
          recipientMeta.push({ orgName: null, resolvedUserId: null });
          continue;
        }
        const org = await this.prisma.organization.findUnique({
          where: { id: r.company_id },
          select: { name: true },
        });
        if (!org) {
          errors.push(`${label}: company_id ${r.company_id} not found`);
        } else {
          orgName = org.name;
        }
      }
      // type === 'email': no id needed, orgName stays null

      recipientMeta.push({ orgName, resolvedUserId });
    }

    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

    // --- Creation phase ---
    const createdPanels = await this.prisma.$transaction(async (tx) => {
      const panels: any[] = [];

      for (let i = 0; i < dto.recipients.length; i++) {
        const r: RecipientDto = dto.recipients[i];
        const { orgName } = recipientMeta[i];
        const isPublic = r.recipient_type !== 'client_user';

        const panel = await tx.offerPanel.create({
          data: {
            title: dto.title,
            description: dto.description ?? null,
            business_unit: dto.business_unit,
            recipient_type: r.recipient_type,
            recipient_user_id:
              r.recipient_type === 'client_user' ? r.user_id : null,
            recipient_company_id:
              r.recipient_type === 'company_contact' ? r.company_id : null,
            recipient_name: r.name,
            recipient_email: r.email,
            recipient_org_name: orgName,
            is_public: isPublic,
            public_token: isPublic ? randomUUID() : null,
            promo_enabled: dto.promo_enabled ?? false,
            created_by_user_id: adminUser.id,
            candidates: {
              create: dto.candidateIds.map((cid) => ({ candidate_id: cid })),
            },
          },
        });
        panels.push(panel);
      }

      return panels;
    });

    // Awaited on purpose: Lambda freezes the container once the handler's
    // response resolves, so a floating promise here never reaches Resend.
    // Creation must still succeed if a send fails, hence allSettled + logging.
    const notificationResults = await Promise.allSettled(
      (createdPanels as { id: string; is_public: boolean }[]).map((panel) =>
        panel.is_public
          ? this.notificationsService.notifyOfferPanelCreatedPublic(panel.id)
          : this.notificationsService.notifyOfferPanelCreatedClient(panel.id),
      ),
    );

    notificationResults.forEach((result, i) => {
      const { id, recipient_email } = createdPanels[i] as {
        id: string;
        recipient_email: string;
      };
      if (result.status === 'rejected') {
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.logger.error(
          `[offer-panel] notification failed for panel ${id} ` +
            `(${recipient_email}): ${reason}`,
        );
      } else if (result.value === false) {
        // notify* returns false when the panel or its public_token can't be
        // resolved — silent by design, so surface it here.
        this.logger.warn(
          `[offer-panel] notification skipped for panel ${id} (${recipient_email})`,
        );
      }
    });

    // Audited AFTER the transaction commits: `log()` swallows its own failures, and a
    // swallowed failure inside a Postgres transaction leaves it aborted. Awaited for
    // the same reason the notifications above are — under Lambda a floating promise
    // can be frozen before it reaches the database.
    const creatorLabel = buildActorLabel(adminUser);
    await Promise.all(
      createdPanels.map((panel) =>
        this.panelAudit.log({
          offerPanelId: panel.id,
          actorUserId: adminUser.id,
          actorLabel: creatorLabel,
          event: OFFER_PANEL_AUDIT_EVENTS.CREATED,
          source: OfferPanelAuditSource.user,
          newStatus: panel.status,
          after: {
            status: panel.status,
            title: panel.title,
            business_unit: panel.business_unit,
            is_public: panel.is_public,
            recipient_type: panel.recipient_type,
            promo_enabled: panel.promo_enabled,
            candidate_count: dto.candidateIds.length,
          },
          metadata: {
            origin: OFFER_PANEL_AUDIT_ORIGINS.ADMIN_CREATE,
            recipientEmail: panel.recipient_email,
            recipientName: panel.recipient_name,
            candidateIds: dto.candidateIds,
            ...offerPanelPromoMetadata(panel.promo_enabled),
          },
        }),
      ),
    );

    const enrichedCandidates = await this.enrichCandidates(dto.candidateIds);

    return createdPanels.map((panel) =>
      this.withRecipient(
        { ...panel, candidates: enrichedCandidates },
        adminUser.role,
      ),
    );
  }

  async findByToken(token: string): Promise<any> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { public_token: token },
      include: OFFER_PANEL_INCLUDE,
    });

    if (!panel) {
      throw new NotFoundException('Offer panel not found');
    }

    const enrichedCandidates = await Promise.all(
      panel.candidates.map(async (pc) => {
        const enriched =
          await this.candidatesService.getTalentPoolCandidateById(
            pc.candidate_id,
          );
        const howManyClientsAreViewing = await this.countOtherPanels(
          pc.candidate_id,
          panel.id,
        );
        return { ...enriched, howManyClientsAreViewing };
      }),
    );

    // The public recipient is unauthenticated and can't call the auth-only
    // /business-units/branding endpoint, so resolve this panel's BU branding
    // server-side and ship it with the payload — the public page themes off it
    // (color/logo/favicon) for ANY BU (incl. MMVA), not just Berry/Med. `null`
    // for an unknown/legacy BU; the frontend falls back to MedVirtual.
    const branding = await this.businessUnitContext.brandingFor(
      panel.business_unit,
    );

    // No authenticated viewer: the caller already holds the token, so it is not
    // echoed back into the response.
    return this.withRecipient(
      {
        ...panel,
        candidates: enrichedCandidates,
        branding,
      },
      null,
    );
  }

  async findOne(id: string, user: USER): Promise<any> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id },
      include: OFFER_PANEL_INCLUDE,
    });

    if (!panel) {
      throw new NotFoundException('Offer panel not found');
    }

    this.assertAccess(panel, user);

    const enrichedCandidates = await Promise.all(
      panel.candidates.map(async (pc) => {
        const enriched =
          await this.candidatesService.getTalentPoolCandidateById(
            pc.candidate_id,
          );
        const howManyClientsAreViewing = await this.countOtherPanels(
          pc.candidate_id,
          panel.id,
        );
        return { ...enriched, howManyClientsAreViewing };
      }),
    );

    return this.withRecipient(
      {
        ...panel,
        candidates: enrichedCandidates,
      },
      user.role,
    );
  }

  async findForClientUser(clientUser: USER): Promise<any[]> {
    const panels = await this.prisma.offerPanel.findMany({
      where: {
        recipient_user_id: clientUser.id,
        status: { notIn: ['declined'] },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
        candidates: {
          select: { candidate_id: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { candidates: true } },
        hireRequest: {
          select: { id: true, status: true, title: true, createdAt: true },
        },
      },
    });

    const candidateIds = panels.flatMap((panel) =>
      panel.candidates.map((pc) => pc.candidate_id),
    );

    // Both the candidate payloads and the "other active panels" counts are
    // resolved in bulk here — doing either per candidate meant a query per
    // candidate per panel.
    const [candidatesById, activePanelsByCandidate] = await Promise.all([
      this.candidatesService.getTalentPoolCandidatesByIds(candidateIds),
      this.countActivePanelsByCandidate(candidateIds),
    ]);

    return panels.map((panel) =>
      this.withRecipient(
        {
          ...panel,
          candidates: panel.candidates
            .map((pc) => {
              const candidate = candidatesById.get(pc.candidate_id);
              if (!candidate) return null;
              // Exclude the panel being rendered, matching countOtherPanels.
              const activePanels =
                activePanelsByCandidate.get(pc.candidate_id) ??
                new Set<string>();
              const howManyClientsAreViewing =
                activePanels.size - (activePanels.has(panel.id) ? 1 : 0);
              return { ...candidate, howManyClientsAreViewing };
            })
            .filter((candidate) => !!candidate),
        },
        clientUser.role,
      ),
    );
  }

  /**
   * Maps each candidate id to the set of active (sent/viewed) offer panels that
   * include it, in one query. Callers subtract the panel they are rendering to
   * get the same number `countOtherPanels` returns for a single candidate.
   */
  private async countActivePanelsByCandidate(
    candidateIds: string[],
  ): Promise<Map<string, Set<string>>> {
    const uniqueIds = Array.from(new Set(candidateIds));
    if (uniqueIds.length === 0) return new Map();

    const rows = await this.prisma.offerPanelCandidate.findMany({
      where: {
        candidate_id: { in: uniqueIds },
        offerPanel: { status: { in: ['sent', 'viewed'] } },
      },
      select: { candidate_id: true, offer_panel_id: true },
    });

    const byCandidate = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byCandidate.get(row.candidate_id) ?? new Set<string>();
      set.add(row.offer_panel_id);
      byCandidate.set(row.candidate_id, set);
    }
    return byCandidate;
  }

  // R17 — called explicitly by POST /viewed endpoints; not inline in GET
  async trackView(panelId: string, user?: USER): Promise<void> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: { status: true, recipient_user_id: true },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (
      user &&
      panel.recipient_user_id &&
      panel.recipient_user_id !== user.id
    ) {
      throw new ForbiddenException('Access denied to this offer panel');
    }

    // Only the sent -> viewed transition is audited, not every view. `view_count`
    // above already answers "how many times", this endpoint is called on every page
    // mount, and the public variant is throttled at 60/min per IP — a row per view
    // would bury `accepted`/`declined` under refresh noise for no added information.
    const wasFirstView = panel.status === 'sent';

    const now = new Date();
    await this.prisma.offerPanel.update({
      where: { id: panelId },
      data: {
        last_viewed_at: now,
        view_count: { increment: 1 },
        ...(panel.status === 'sent'
          ? { status: 'viewed', viewed_at: now }
          : {}),
      },
    });

    if (wasFirstView) {
      await this.panelAudit.log({
        offerPanelId: panelId,
        actorUserId: user?.id ?? null,
        actorLabel: user ? buildActorLabel(user) : null,
        event: OFFER_PANEL_AUDIT_EVENTS.VIEWED,
        source: user
          ? OfferPanelAuditSource.user
          : OfferPanelAuditSource.system,
        oldStatus: 'sent',
        newStatus: 'viewed',
        metadata: { origin: OFFER_PANEL_AUDIT_ORIGINS.CLIENT_DASHBOARD },
      });
    }
  }

  async trackViewByToken(token: string): Promise<void> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { public_token: token },
      select: { id: true, status: true, recipient_name: true },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    // First view only — see the note in trackView.
    const wasFirstView = panel.status === 'sent';

    const now = new Date();
    await this.prisma.offerPanel.update({
      where: { id: panel.id },
      data: {
        last_viewed_at: now,
        view_count: { increment: 1 },
        ...(panel.status === 'sent'
          ? { status: 'viewed', viewed_at: now }
          : {}),
      },
    });

    if (wasFirstView) {
      await this.panelAudit.log({
        offerPanelId: panel.id,
        actorUserId: null,
        actorLabel: recipientActorLabel(panel.recipient_name),
        event: OFFER_PANEL_AUDIT_EVENTS.VIEWED,
        source: OfferPanelAuditSource.system,
        oldStatus: 'sent',
        newStatus: 'viewed',
        metadata: { origin: OFFER_PANEL_AUDIT_ORIGINS.PUBLIC_TOKEN },
      });
    }
  }

  async removeCandidate(
    panelId: string,
    candidateId: string,
    clientUser: USER,
  ): Promise<{ deleted: boolean; panel?: any }> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: { status: true, recipient_user_id: true, title: true },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (panel.recipient_user_id !== clientUser.id) {
      throw new ForbiddenException('Access denied to this offer panel');
    }
    if (panel.status === 'accepted' || panel.status === 'declined') {
      throw new BadRequestException('Cannot modify a decided offer panel');
    }

    const deleted = await this.prisma.offerPanelCandidate.deleteMany({
      where: { offer_panel_id: panelId, candidate_id: candidateId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('Candidate not in this panel');
    }

    const remaining = await this.prisma.offerPanelCandidate.count({
      where: { offer_panel_id: panelId },
    });

    if (remaining === 0) {
      // Removing the last candidate hard-deletes the panel. That is a compliance
      // event: logOrThrow inside the transaction, before the delete, so the record
      // of why the panel vanished commits with the deletion or not at all.
      await this.prisma.$transaction(async (tx) => {
        await this.panelAudit.logOrThrow(
          {
            offerPanelId: panelId,
            actorUserId: clientUser.id,
            actorLabel: buildActorLabel(clientUser),
            event: OFFER_PANEL_AUDIT_EVENTS.DELETED,
            source: OfferPanelAuditSource.user,
            oldStatus: panel.status,
            reason: 'Last candidate removed by the recipient',
            before: { status: panel.status, title: panel.title },
            metadata: {
              origin: OFFER_PANEL_AUDIT_ORIGINS.CLIENT_DASHBOARD,
              removedCandidateId: candidateId,
            },
          },
          tx,
        );
        await tx.offerPanel.delete({ where: { id: panelId } });
      });
      return { deleted: true };
    }

    await this.panelAudit.log({
      offerPanelId: panelId,
      actorUserId: clientUser.id,
      actorLabel: buildActorLabel(clientUser),
      event: OFFER_PANEL_AUDIT_EVENTS.CANDIDATE_REMOVED,
      source: OfferPanelAuditSource.user,
      metadata: {
        origin: OFFER_PANEL_AUDIT_ORIGINS.CLIENT_DASHBOARD,
        candidateId,
        remainingCount: remaining,
      },
    });

    const updated = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      include: {
        createdBy: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
        recipientUser: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
        recipientCompany: { select: { id: true, name: true } },
        candidates: { select: { candidate_id: true } },
      },
    });
    if (!updated) throw new NotFoundException('Offer panel not found');

    const enrichedCandidates = await this.enrichCandidates(
      updated.candidates.map((pc) => pc.candidate_id),
    );

    return {
      deleted: false,
      panel: this.withRecipient(
        { ...updated, candidates: enrichedCandidates },
        clientUser.role,
      ),
    };
  }

  async removeCandidateFromAllPanels(candidateId: string): Promise<void> {
    // The panel columns are selected alongside the link so that emptied panels can be
    // audited before they are deleted — otherwise a candidate deletion would make
    // panels disappear with no trace of why.
    const panelLinks = await this.prisma.offerPanelCandidate.findMany({
      where: { candidate_id: candidateId },
      select: {
        offer_panel_id: true,
        offerPanel: { select: { status: true, title: true } },
      },
    });

    for (const { offer_panel_id, offerPanel } of panelLinks) {
      await this.prisma.offerPanelCandidate.deleteMany({
        where: { offer_panel_id, candidate_id: candidateId },
      });

      const remaining = await this.prisma.offerPanelCandidate.count({
        where: { offer_panel_id },
      });

      if (remaining === 0) {
        // Cascade from a candidate deletion — no acting user. Compliance event, so
        // the tombstone and the delete commit together.
        await this.prisma.$transaction(async (tx) => {
          await this.panelAudit.logOrThrow(
            {
              offerPanelId: offer_panel_id,
              actorUserId: null,
              actorLabel: null,
              event: OFFER_PANEL_AUDIT_EVENTS.DELETED,
              source: OfferPanelAuditSource.system,
              oldStatus: offerPanel?.status ?? null,
              reason: 'Candidate removed from the system',
              before: {
                status: offerPanel?.status ?? null,
                title: offerPanel?.title ?? null,
              },
              metadata: {
                origin: OFFER_PANEL_AUDIT_ORIGINS.CANDIDATE_CASCADE,
                removedCandidateId: candidateId,
              },
            },
            tx,
          );
          await tx.offerPanel.delete({ where: { id: offer_panel_id } });
        });
      }
    }
  }

  async decline(panelId: string, clientUser: USER): Promise<void> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: { status: true, recipient_user_id: true },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (panel.recipient_user_id !== clientUser.id) {
      throw new ForbiddenException('Access denied to this offer panel');
    }
    if (panel.status === 'declined') return; // idempotent (E8)
    if (panel.status === 'accepted') {
      throw new BadRequestException(
        'Cannot decline an already accepted offer panel',
      );
    }

    await this.prisma.offerPanel.update({
      where: { id: panelId },
      data: { status: 'declined', decided_at: new Date() },
    });

    // The early return above makes decline idempotent, so this never double-writes.
    await this.panelAudit.log({
      offerPanelId: panelId,
      actorUserId: clientUser.id,
      actorLabel: buildActorLabel(clientUser),
      event: OFFER_PANEL_AUDIT_EVENTS.DECLINED,
      source: OfferPanelAuditSource.user,
      oldStatus: panel.status,
      newStatus: 'declined',
      metadata: { origin: OFFER_PANEL_AUDIT_ORIGINS.CLIENT_DASHBOARD },
    });

    setImmediate(() => {
      this.notificationsService
        .notifyAdminOfferPanelDeclined(panelId)
        .catch(() => {});
    });
  }

  async declineByToken(token: string): Promise<void> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { public_token: token },
      select: { id: true, status: true, recipient_name: true },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (panel.status === 'declined') return; // idempotent (E8)
    if (panel.status === 'accepted') {
      throw new BadRequestException(
        'Cannot decline an already accepted offer panel',
      );
    }

    await this.prisma.offerPanel.update({
      where: { id: panel.id },
      data: { status: 'declined', decided_at: new Date() },
    });

    // Declined through a public token, so there is no authenticated user — the
    // recipient named on the panel is the actor.
    await this.panelAudit.log({
      offerPanelId: panel.id,
      actorUserId: null,
      actorLabel: recipientActorLabel(panel.recipient_name),
      event: OFFER_PANEL_AUDIT_EVENTS.DECLINED,
      source: OfferPanelAuditSource.system,
      oldStatus: panel.status,
      newStatus: 'declined',
      metadata: { origin: OFFER_PANEL_AUDIT_ORIGINS.PUBLIC_TOKEN },
    });

    setImmediate(() => {
      this.notificationsService
        .notifyAdminOfferPanelDeclined(panel.id)
        .catch(() => {});
    });
  }

  private pickMostCommonApprovedPosition(
    approvedPositionsByCandidate: (string[] | null)[],
  ): string | null {
    const positions = approvedPositionsByCandidate.flatMap(
      (positions) => positions ?? [],
    );

    const counts = new Map<string, number>();
    for (const position of positions) {
      if (!position) continue;
      counts.set(position, (counts.get(position) ?? 0) + 1);
    }

    let best: string | null = null;
    let bestCount = 0;
    for (const position of positions) {
      if (!position) continue;
      const count = counts.get(position) ?? 0;
      if (count > bestCount) {
        bestCount = count;
        best = position;
      }
    }

    return best;
  }

  // va_type is a closed HubSpot picklist — approved_positions_pairing values don't always
  // match it exactly, so we validate against HubSpot's live options before sending.
  private async resolveHubspotVaType(
    approvedPosition: string | null,
  ): Promise<string | null> {
    if (!approvedPosition) return null;

    try {
      const vaTypes: Array<{ label: string; value: string }> =
        await this.hireRequestService.getVATypes();
      const isValidOption = vaTypes.some(
        (option) =>
          option.value === approvedPosition ||
          option.label === approvedPosition,
      );
      return isValidOption ? approvedPosition : null;
    } catch (err) {
      this.logger.warn(
        `Failed to fetch HubSpot va_type options: ${(err as Error)?.message}`,
      );
      return null;
    }
  }

  async acceptByClientUser(
    panelId: string,
    clientUser: USER,
  ): Promise<{ hireRequest: any }> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: {
        status: true,
        recipient_user_id: true,
        title: true,
        description: true,
        created_by_user_id: true,
        promo_enabled: true,
      },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (panel.recipient_user_id !== clientUser.id) {
      throw new ForbiddenException('Access denied to this offer panel');
    }
    if (panel.status === 'declined') {
      throw new BadRequestException('Cannot accept a declined offer panel');
    }

    // Idempotency (E8): return existing hire request if already accepted
    if (panel.status === 'accepted') {
      const existing = await this.prisma.hireRequest.findFirst({
        where: { offer_panel_id: panelId },
      });
      return { hireRequest: existing };
    }

    const candidateRows = await this.prisma.offerPanelCandidate.findMany({
      where: { offer_panel_id: panelId },
      select: {
        candidate_id: true,
        candidate: { select: { approved_positions_pairing: true } },
      },
    });

    const hubspot_role_type = this.pickMostCommonApprovedPosition(
      candidateRows.map((r) => r.candidate.approved_positions_pairing),
    );
    const hubspot_numberVA = candidateRows.length;

    const [org, activeStaffCount] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: clientUser.organization_id ?? '' },
        select: {
          name: true,
          hubspot_id: true,
          business_unit: true,
          website_url: true,
        },
      }),
      this.prisma.staff.count({
        where: {
          organization_id: clientUser.organization_id ?? undefined,
          status: { notIn: ['terminated', 'inactive'] },
          terminated_date: null,
        },
      }),
    ]);

    const pairingRequestType = activeStaffCount > 0 ? 'Upsell Agent' : null;

    const title = buildHireRequestTitle({
      hubspot_pairing_request_type: pairingRequestType,
      hubspot_numberVA,
      hubspot_role_type,
      availability: 'Full-time',
      organization: { name: org?.name ?? '' },
    });

    const hireRequest = await this.prisma.$transaction(async (tx) => {
      const hr = await tx.hireRequest.create({
        data: {
          org_id: clientUser.organization_id ?? '',
          title,
          availability: 'Full-time',
          status: 'panel_ready',
          createdByUserId: panel.created_by_user_id,
          assign_user_id: panel.created_by_user_id,
          hubspot_role_type,
          hubspot_numberVA,
          hubspot_pairing_request_type: pairingRequestType,
          offer_panel_id: panelId,
          panels: {
            create: {
              status: 'created',
              readable: true,
              panelCandidates: {
                create: candidateRows.map((r) => ({
                  candidate_id: r.candidate_id,
                  status: 'selected',
                  createdByUserId: panel.created_by_user_id,
                })),
              },
            },
          },
        },
      });

      await tx.offerPanel.update({
        where: { id: panelId },
        data: { status: 'accepted', decided_at: new Date() },
      });

      return hr;
    });

    await this.panelAudit.log({
      offerPanelId: panelId,
      actorUserId: clientUser.id,
      actorLabel: buildActorLabel(clientUser),
      event: OFFER_PANEL_AUDIT_EVENTS.ACCEPTED,
      source: OfferPanelAuditSource.user,
      oldStatus: panel.status,
      newStatus: 'accepted',
      metadata: {
        origin: OFFER_PANEL_AUDIT_ORIGINS.CLIENT_DASHBOARD,
        hireRequestId: hireRequest.id,
        candidateCount: candidateRows.length,
        ...offerPanelPromoMetadata(panel.promo_enabled),
      },
    });

    setImmediate(() => {
      this.notificationsService
        .notifyAdminOfferPanelAccepted(panelId)
        .catch(() => {});
    });

    // R11 — sync HireRequest to HubSpot with correct owner (fire-and-forget)
    setImmediate(async () => {
      try {
        await this.warnIfNoHubspotOwner(panel.created_by_user_id);

        const hubspot_va_type =
          await this.resolveHubspotVaType(hubspot_role_type);

        const payload = {
          id: hireRequest.id,
          title,
          description: panel.description ?? '',
          availability: 'Full-time',
          priority: 'medium',
          hubspot_role_type: hubspot_va_type,
          hubspot_numberVA,
          hubspot_pairing_request_type: pairingRequestType,
          // No hardcoded BU default: if the caller's organization couldn't be
          // resolved we don't know its business unit, so we send `null`
          // rather than silently assuming MedVirtual (which would misfile
          // Berry/MMVA/future-BU hire requests in HubSpot).
          organization: org ?? {
            name: '',
            hubspot_id: null,
            business_unit: null,
            website_url: '',
          },
          assign_user_id: [{ id: panel.created_by_user_id }],
        };

        await this.retryHubspot(() =>
          this.hubspot.createHireRequestInHubspot(
            payload as any,
            panel.created_by_user_id,
            'HireRequest created from offer panel accept',
          ),
        );
      } catch (err) {
        this.logger.error(
          `R11: HubSpot sync failed for HR ${hireRequest.id}: ${err?.message}`,
        );
      }
    });

    return { hireRequest };
  }

  async acceptByToken(token: string): Promise<{ ticket: any }> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { public_token: token },
      select: {
        id: true,
        status: true,
        title: true,
        recipient_name: true,
        recipient_email: true,
        recipient_company_id: true,
        created_by_user_id: true,
        promo_enabled: true,
      },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (panel.status === 'declined') {
      throw new BadRequestException('Cannot accept a declined offer panel');
    }

    // Idempotency (E8)
    if (panel.status === 'accepted') {
      const existing = await this.prisma.ticket.findFirst({
        where: { offer_panel_id: panel.id, deleted_at: null },
        orderBy: { createdAt: 'desc' },
      });
      return { ticket: existing };
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.create({
        data: {
          type: 'offer_panel',
          title: 'Offer panel accepted',
          // The promotional rate is named in the description because the ticket
          // carries no price columns — this is what makes the discount visible to
          // whoever picks the ticket up.
          description:
            `The offer panel ${panel.title} was accepted by ${panel.recipient_name}` +
            (panel.promo_enabled
              ? ` — ${OFFER_PANEL_PROMO_PRICE_LABEL}/month promotional rate applied.`
              : ''),
          priority: 'medium',
          offer_panel_id: panel.id,
          org_id: panel.recipient_company_id ?? null,
          created_by: panel.created_by_user_id,
          user_id: panel.created_by_user_id,
        },
      });

      await tx.offerPanel.update({
        where: { id: panel.id },
        data: { status: 'accepted', decided_at: new Date() },
      });

      return t;
    });

    // Accepted through a public token, so there is no authenticated user — the recipient
    // named on the panel is the actor.
    //
    // Awaited rather than fire-and-forget: under Lambda the container is frozen once
    // the handler resolves, so a floating promise here may never reach the database.
    // `log()` swallows its own failures, so awaiting cannot fail the accept.
    await this.ticketAudit.log({
      ticketId: ticket.id,
      actorUserId: null,
      actorLabel: recipientActorLabel(panel.recipient_name),
      event: TICKET_AUDIT_EVENTS.CREATED,
      source: TicketAuditSource.system,
      newStatus: ticket.status,
      after: {
        status: ticket.status,
        type: ticket.type,
        priority: ticket.priority,
        org_id: ticket.org_id,
        user_id: ticket.user_id,
        offer_panel_id: ticket.offer_panel_id,
        title: ticket.title,
      },
      metadata: {
        origin: TICKET_AUDIT_ORIGINS.OFFER_PANEL_ACCEPTED,
        offerPanelId: panel.id,
        recipientEmail: panel.recipient_email ?? null,
        panelCreatedBy: panel.created_by_user_id ?? null,
        // Promo state is persisted on the ticket's audit trail rather than as a
        // ticket column — see the requirements' "audit metadata + description" decision.
        ...offerPanelPromoMetadata(panel.promo_enabled),
      },
    });

    await this.panelAudit.log({
      offerPanelId: panel.id,
      actorUserId: null,
      actorLabel: recipientActorLabel(panel.recipient_name),
      event: OFFER_PANEL_AUDIT_EVENTS.ACCEPTED,
      source: OfferPanelAuditSource.system,
      oldStatus: panel.status,
      newStatus: 'accepted',
      metadata: {
        origin: OFFER_PANEL_AUDIT_ORIGINS.PUBLIC_TOKEN,
        ticketId: ticket.id,
        recipientEmail: panel.recipient_email ?? null,
        ...offerPanelPromoMetadata(panel.promo_enabled),
      },
    });

    setImmediate(() => {
      this.notificationsService
        .notifyAdminOfferPanelAccepted(panel.id)
        .catch(() => {});
    });

    return { ticket };
  }

  async update(
    id: string,
    dto: { title?: string; description?: string },
    adminUser: USER,
  ): Promise<any> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id },
      select: { id: true, title: true, description: true, status: true },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    const updated = await this.prisma.offerPanel.update({
      where: { id },
      data: dto,
      include: {
        candidates: { select: { candidate_id: true } },
      },
    });

    // Only record the fields that actually moved — an "Updated" entry whose
    // before and after are identical is noise in the timeline.
    const changedFields: string[] = [];
    if (dto.title !== undefined && dto.title !== panel.title) {
      changedFields.push('title');
    }
    if (
      dto.description !== undefined &&
      dto.description !== panel.description
    ) {
      changedFields.push('description');
    }

    if (changedFields.length > 0) {
      await this.panelAudit.log({
        offerPanelId: id,
        actorUserId: adminUser.id,
        actorLabel: buildActorLabel(adminUser),
        event: OFFER_PANEL_AUDIT_EVENTS.UPDATED,
        source: OfferPanelAuditSource.user,
        before: { title: panel.title, description: panel.description },
        after: { title: updated.title, description: updated.description },
        metadata: {
          origin: OFFER_PANEL_AUDIT_ORIGINS.ADMIN_CONSOLE,
          changedFields,
        },
      });
    }

    const enrichedCandidates = await this.enrichCandidates(
      updated.candidates.map((pc) => pc.candidate_id),
    );

    return this.withRecipient(
      { ...updated, candidates: enrichedCandidates },
      adminUser.role,
    );
  }

  async remove(id: string, adminUser: USER): Promise<void> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        status: true,
        business_unit: true,
        is_public: true,
        promo_enabled: true,
        recipient_email: true,
        recipient_name: true,
        created_by_user_id: true,
      },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    // Compliance event: the panel row is HARD deleted, so this audit entry is the
    // only surviving evidence it ever existed. logOrThrow inside the transaction,
    // written BEFORE the delete, so a failing audit aborts before the destructive
    // statement rather than losing the record silently.
    await this.prisma.$transaction(async (tx) => {
      await this.panelAudit.logOrThrow(
        {
          offerPanelId: id,
          actorUserId: adminUser.id,
          actorLabel: buildActorLabel(adminUser),
          event: OFFER_PANEL_AUDIT_EVENTS.DELETED,
          source: OfferPanelAuditSource.user,
          oldStatus: panel.status,
          before: {
            title: panel.title,
            status: panel.status,
            business_unit: panel.business_unit,
            is_public: panel.is_public,
            promo_enabled: panel.promo_enabled,
          },
          metadata: {
            origin: OFFER_PANEL_AUDIT_ORIGINS.ADMIN_CONSOLE,
            recipientEmail: panel.recipient_email,
            recipientName: panel.recipient_name,
            createdByUserId: panel.created_by_user_id,
          },
        },
        tx,
      );
      await tx.offerPanel.delete({ where: { id } });
    });
  }

  /**
   * Re-sends the tokenized panel link to a public recipient.
   *
   * Client-user panels have no token and no public page — their recipient sees the
   * panel on the authenticated dashboard, so there is nothing to re-send. That is a
   * 400 rather than a silent no-op.
   *
   * The existing token is reused, not rotated, so any link already shared keeps working.
   */
  async resendPublicLink(
    id: string,
    adminUser: USER,
  ): Promise<{ sentTo: string }> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        is_public: true,
        public_token: true,
        recipient_email: true,
        recipient_name: true,
      },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    if (!panel.is_public || !panel.public_token) {
      throw new BadRequestException(
        'Only public offer panels have a shareable link to resend',
      );
    }

    // Deliberately NOT blocked on accepted/declined. Recipients routinely ask for
    // the link again after deciding — to re-read the shortlist, or to forward it to
    // a colleague — and the public page already renders a read-only "already
    // decided" state, so a resend cannot produce a second accept. Blocking here
    // would create a support path with no safety benefit.

    const sent =
      await this.notificationsService.notifyOfferPanelCreatedPublic(id);
    // Surface a real failure rather than reporting a false success to the admin.
    if (!sent) {
      throw new BadRequestException('Failed to resend the offer panel email');
    }

    await this.panelAudit.log({
      offerPanelId: id,
      actorUserId: adminUser.id,
      actorLabel: buildActorLabel(adminUser),
      event: OFFER_PANEL_AUDIT_EVENTS.RESENT,
      source: OfferPanelAuditSource.user,
      metadata: {
        origin: OFFER_PANEL_AUDIT_ORIGINS.ADMIN_RESEND,
        recipientEmail: panel.recipient_email,
        panelStatus: panel.status,
      },
    });

    return { sentTo: panel.recipient_email };
  }

  async findAll(
    query: QueryOfferPanelsDto,
    // The endpoint is @Roles('system_admin','system_super_admin'), but the viewer is
    // threaded through rather than assumed so `public_token` stays correctly gated if
    // those roles are ever widened.
    viewer?: USER,
  ): Promise<{ data: any[]; counts: OfferPanelStatusCounts; pagination: any }> {
    const {
      search,
      status,
      recipient_type,
      client,
      created_by,
      business_unit,
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
    } = query;
    const skip = (page - 1) * limit;

    // Conditions are collected in an array rather than assigned onto a single
    // `where` object: both search and the business-unit filter need their own
    // OR group, and a plain `where.OR` would let one silently overwrite the
    // other.
    const baseConditions: any[] = [];

    if (recipient_type) baseConditions.push({ recipient_type });
    if (client)
      baseConditions.push({
        recipient_org_name: { contains: client, mode: 'insensitive' },
      });

    // `createdBy` is the USER relation; the filterable scalar is the FK
    // `created_by_user_id`. Filtering on the relation with a raw id string
    // makes Prisma reject the query (expects USERWhereInput).
    if (created_by)
      baseConditions.push({
        created_by_user_id: created_by,
      });

    if (business_unit) {
      const resolved =
        await this.businessUnitContext.resolveByHubspotValue(business_unit);
      // An unrecognized BU must narrow to nothing, never widen to everything.
      if (!resolved) {
        return {
          data: [],
          counts: emptyOfferPanelStatusCounts(),
          pagination: { page, limit, total: 0, totalPages: 0 },
        };
      }
      // Rows have been written with several spellings over time ("Berry
      // Virtual" vs "BerryVirtual"). `mode: 'insensitive'` covers casing but
      // not whitespace, so match every variant explicitly.
      const variants = new Set(
        [resolved.hubspot_value, resolved.name, resolved.slug]
          .filter((value): value is string => !!value)
          .flatMap((value) => [value, value.replace(/\s+/g, '')]),
      );
      baseConditions.push({
        OR: [...variants].map((value) => ({
          business_unit: { equals: value, mode: 'insensitive' as const },
        })),
      });
    }

    // Period filter. A panel is created at the moment it is sent, so the
    // creation date is also the sent date. `dateTo` covers the whole day (not
    // midnight) so an end date the user picked is inclusive — same UTC bounds
    // as getStats(), so the list and the dashboard stats agree.
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (dateFrom) createdAt.gte = new Date(`${dateFrom}T00:00:00.000Z`);
    if (dateTo) createdAt.lte = new Date(`${dateTo}T23:59:59.999Z`);
    if (dateFrom || dateTo) baseConditions.push({ createdAt });

    if (search) {
      baseConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { recipient_name: { contains: search, mode: 'insensitive' } },
          { recipient_email: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    // The status tabs show a count each, so the counts must reflect every
    // filter EXCEPT status — otherwise the selected tab would be the only
    // non-zero one.
    const countsWhere = { AND: baseConditions };
    const where = status
      ? { AND: [...baseConditions, { status }] }
      : countsWhere;

    // Built separately so Prisma keeps each call's precise payload type — the
    // $transaction([...]) array overload widens the tuple otherwise.
    const pageQuery = this.prisma.offerPanel.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        },
        recipientUser: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        },
        candidates: {
          select: { candidate_id: true },
          orderBy: { createdAt: 'asc' },
        },
        recipientCompany: { select: { id: true, name: true } },
        _count: { select: { candidates: true } },
        hireRequest: {
          select: { id: true, status: true, title: true, createdAt: true },
        },
      },
    });

    // One grouped count replaces both the old count() and any per-tab request,
    // and shares a consistent snapshot with the page above.
    const countsQuery = this.prisma.offerPanel.groupBy({
      by: ['status'],
      where: countsWhere,
      orderBy: { status: 'asc' },
      // Counting the (non-nullable) grouping column is equivalent to _all here,
      // and keeps the result precisely typed.
      _count: { status: true },
    });

    const [data, grouped] = await this.prisma.$transaction([
      pageQuery,
      countsQuery,
    ]);

    const counts = emptyOfferPanelStatusCounts();
    for (const group of grouped) {
      counts[group.status] = group._count.status;
    }

    // With a status filter the page is that bucket; without one it spans them
    // all — either way the total comes from the same grouped counts.
    const total = status
      ? counts[status]
      : Object.values(counts).reduce((sum, value) => sum + value, 0);

    // Enhance the result to align with frontend types. Candidates for the whole
    // page are loaded in a single batch — enriching them per panel issued one
    // query (plus a full PositionRateConfig read) per candidate, which is what
    // made this endpoint slow enough to freeze the admin list.
    const candidatesById =
      await this.candidatesService.getTalentPoolCandidatesByIds(
        data.flatMap((panel) => panel.candidates.map((pc) => pc.candidate_id)),
      );

    const enhancedData = data.map((panel) =>
      this.withRecipient(
        {
          ...panel,
          candidates: panel.candidates
            .map((pc) => candidatesById.get(pc.candidate_id))
            // A panel row may reference a since-deleted candidate; skip it rather
            // than failing the whole list.
            .filter((candidate) => !!candidate),
        },
        viewer?.role,
      ),
    );

    return {
      data: enhancedData,
      counts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Offer-panel analytics for the Operational Dashboard, aggregated by sender
   * (`created_by_user_id`).
   *
   * Two reads are needed and they are deliberate: `groupBy` gives the per-sender
   * status tallies straight from the index, but Prisma cannot compute date
   * *differences*, so the duration metrics (time-to-view, time-to-decision) come
   * from a narrowly-selected `findMany` reduced in JS — the same approach as
   * `CronService.weeklyOfferPanelReport`.
   */
  async getStats(query: OfferPanelStatsQueryDto): Promise<OfferPanelStats> {
    const { dateFrom, dateTo, business_unit } = query;

    const conditions: any[] = [];

    const createdAt: { gte?: Date; lte?: Date } = {};
    if (dateFrom) createdAt.gte = new Date(`${dateFrom}T00:00:00.000Z`);
    // The range is inclusive of its final day: a bare `new Date('2026-08-12')`
    // is midnight, which would silently drop everything sent that day.
    if (dateTo) createdAt.lte = new Date(`${dateTo}T23:59:59.999Z`);
    if (dateFrom || dateTo) conditions.push({ createdAt });

    if (business_unit) {
      const resolved =
        await this.businessUnitContext.resolveByHubspotValue(business_unit);
      // An unrecognized BU must narrow to nothing, never widen to everything.
      if (!resolved) return emptyOfferPanelStats();
      // Rows have been written with several spellings over time ("Berry
      // Virtual" vs "BerryVirtual"). `mode: 'insensitive'` covers casing but
      // not whitespace, so match every variant explicitly.
      const variants = new Set(
        [resolved.hubspot_value, resolved.name, resolved.slug]
          .filter((value): value is string => !!value)
          .flatMap((value) => [value, value.replace(/\s+/g, '')]),
      );
      conditions.push({
        OR: [...variants].map((value) => ({
          business_unit: { equals: value, mode: 'insensitive' as const },
        })),
      });
    }

    const where = conditions.length ? { AND: conditions } : {};

    const groupedQuery = this.prisma.offerPanel.groupBy({
      by: ['created_by_user_id', 'status'],
      where,
      _count: { status: true },
      orderBy: { created_by_user_id: 'asc' },
    });

    // Only the columns the derived metrics need — pulling whole rows with
    // relations here is what made the admin list slow enough to freeze.
    const rowsQuery = this.prisma.offerPanel.findMany({
      where,
      select: {
        created_by_user_id: true,
        status: true,
        createdAt: true,
        viewed_at: true,
        decided_at: true,
        _count: { select: { candidates: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const [grouped, rows] = await this.prisma.$transaction([
      groupedQuery,
      rowsQuery,
    ]);

    if (!rows.length) return emptyOfferPanelStats();

    // ── Per-sender accumulation ──────────────────────────────────────────────
    const accumulators = new Map<string, SenderAccumulator>();
    const accumulatorFor = (userId: string): SenderAccumulator => {
      let acc = accumulators.get(userId);
      if (!acc) {
        acc = {
          userId,
          counts: emptyOfferPanelStatusCounts(),
          viewed: 0,
          totalCandidates: 0,
          total: 0,
          lastSentAt: null,
        };
        accumulators.set(userId, acc);
      }
      return acc;
    };

    // Status tallies come from the grouped query rather than the row scan: it is
    // the authoritative count and stays correct even as the select above changes.
    for (const group of grouped) {
      const acc = accumulatorFor(group.created_by_user_id);
      acc.counts[group.status] = group._count.status;
      acc.total += group._count.status;
    }

    const totals = emptyOfferPanelStatusCounts();
    let viewedEver = 0;
    let awaitingResponse = 0;
    const timesToView: number[] = [];
    const timesToDecision: number[] = [];
    const monthlyBuckets = new Map<string, OfferPanelMonthlyBucket>();
    const staleBefore = Date.now() - AWAITING_RESPONSE_DAYS * MS_PER_DAY;

    for (const row of rows) {
      const acc = accumulatorFor(row.created_by_user_id);
      totals[row.status] += 1;

      acc.totalCandidates += row._count.candidates;
      if (!acc.lastSentAt || row.createdAt > acc.lastSentAt) {
        acc.lastSentAt = row.createdAt;
      }

      const createdMs = row.createdAt.getTime();

      // `viewed` is a terminal status, not a cumulative one: an accepted panel
      // was also viewed but no longer says so. Counting `viewed_at` instead of
      // `status === 'viewed'` is what keeps the view rate and the funnel honest.
      if (row.viewed_at) {
        viewedEver += 1;
        acc.viewed += 1;
        timesToView.push(row.viewed_at.getTime() - createdMs);
      } else if (
        row.status === OfferPanelStatus.sent &&
        createdMs < staleBefore
      ) {
        awaitingResponse += 1;
      }

      if (row.decided_at) {
        timesToDecision.push(row.decided_at.getTime() - createdMs);
      }

      // Outcomes are bucketed by creation month, so each month's accepted and
      // declined bars stay a subset of that month's sent bar.
      const monthKey = `${row.createdAt.getUTCFullYear()}-${String(
        row.createdAt.getUTCMonth() + 1,
      ).padStart(2, '0')}`;
      let bucket = monthlyBuckets.get(monthKey);
      if (!bucket) {
        bucket = { month: monthKey, sent: 0, accepted: 0, declined: 0 };
        monthlyBuckets.set(monthKey, bucket);
      }
      bucket.sent += 1;
      if (row.status === OfferPanelStatus.accepted) bucket.accepted += 1;
      if (row.status === OfferPanelStatus.declined) bucket.declined += 1;
    }

    // ── Sender identities ────────────────────────────────────────────────────
    const creators = await this.prisma.uSER.findMany({
      where: { id: { in: [...accumulators.keys()] } },
      select: { id: true, first_name: true, last_name: true, email: true },
    });
    const creatorsById = new Map(creators.map((user) => [user.id, user]));

    const senders: OfferPanelSenderStats[] = [...accumulators.values()]
      .map((acc) => {
        const creator = creatorsById.get(acc.userId);
        const accepted = acc.counts[OfferPanelStatus.accepted];
        const declined = acc.counts[OfferPanelStatus.declined];
        return {
          userId: acc.userId,
          name:
            [creator?.first_name, creator?.last_name]
              .filter(Boolean)
              .join(' ')
              .trim() ||
            creator?.email ||
            'Unknown user',
          email: creator?.email ?? '',
          sent: acc.counts[OfferPanelStatus.sent],
          viewed: acc.viewed,
          accepted,
          declined,
          total: acc.total,
          acceptedPct: percentage(accepted, accepted + declined),
          declinedPct: percentage(declined, accepted + declined),
          totalCandidates: acc.totalCandidates,
          lastSentAt: acc.lastSentAt ? acc.lastSentAt.toISOString() : null,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    const total = rows.length;
    const accepted = totals[OfferPanelStatus.accepted];
    const declined = totals[OfferPanelStatus.declined];
    const decided = accepted + declined;

    return {
      totals: {
        sent: totals[OfferPanelStatus.sent],
        viewed: totals[OfferPanelStatus.viewed],
        accepted,
        declined,
        total,
      },
      rates: {
        // Acceptance is measured against panels that were actually decided —
        // against `total` a sender would look bad merely for having panels
        // still in flight.
        acceptanceRate: percentage(accepted, decided),
        declineRate: percentage(declined, decided),
        viewRate: percentage(viewedEver, total),
      },
      speed: {
        avgTimeToViewHours: averageHours(timesToView),
        avgTimeToDecisionHours: averageHours(timesToDecision),
        awaitingResponse,
      },
      // Cumulative stages, so the funnel is monotonically non-increasing.
      funnel: { sent: total, viewed: viewedEver, decided, accepted },
      topSenders: {
        mostSent: topSender(senders, (s) => s.total),
        mostAccepted: topSender(senders, (s) => s.accepted),
        mostDeclined: topSender(senders, (s) => s.declined),
      },
      senders,
      monthly: [...monthlyBuckets.values()].sort((a, b) =>
        a.month.localeCompare(b.month),
      ),
    };
  }

  async findByCandidateId(candidateId: string) {
    return this.prisma.offerPanel.findMany({
      where: {
        candidates: { some: { candidate_id: candidateId } },
      },
      select: {
        id: true,
        title: true,
        status: true,
        recipient_name: true,
        recipient_type: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Allows admin to see any panel; client can only see panels addressed to them.
  private assertAccess(panel: any, user: USER): void {
    const isAdmin =
      user.role === 'system_admin' || user.role === 'system_super_admin';
    if (isAdmin) return;

    const isRecipient = panel.recipient_user_id === user.id;

    if (!isRecipient) {
      throw new ForbiddenException('Access denied to this offer panel');
    }
  }
}
