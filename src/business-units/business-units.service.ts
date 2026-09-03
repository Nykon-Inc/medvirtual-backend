import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import {
  HubspotAuditAction,
  HubspotAuditSource,
  HubspotEntityType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBusinessUnitDto } from './dto/create-business-unit.dto';
import { UpdateBusinessUnitDto } from './dto/update-business-unit.dto';
import { UpdateBrandingDto } from './dto/update-branding.dto';
import { HubspotAuditService } from '../hubspot/hubspot-audit.service';
import { BusinessUnitContext } from './business-unit-context.service';
import {
  mapOrganizationToDb,
  mapContactToDb,
} from '../common/utils/hubspot.util';
import { organizationToDbDictionary } from '../common/dictionaries/organization-dictionary';
import { contactToDbDictionary } from '../common/dictionaries/contact-dictionary';
import { candidadeToDbDictionary } from '../common/dictionaries/candidate-dictionary';
import { affiliateToDbDictionary } from '../common/dictionaries/affiliate-dictionary';
import {
  OrganizationStatus,
  AffiliateStatus,
  CandidateAuditFieldGroup,
  CandidateAuditSource,
} from '@prisma/client';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../candidate/candidate-audit.service';

/**
 * Normalizes an arbitrary value into a `string[]` suitable for a Prisma
 * scalar-list (`String[]`) column, which rejects `null`.
 * - string  → split on comma + trim, dropping empty entries
 * - array   → returned as-is
 * - else    → `[]` (covers null/undefined and unexpected types)
 */
function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(value)) {
    return value as string[];
  }
  return [];
}

@Injectable()
export class BusinessUnitsService {
  private readonly logger = new Logger(BusinessUnitsService.name);

  // Concurrency guard for backfillFromHubspot — in-memory Set of slugs
  // currently being backfilled. Simple and sufficient for a single-instance
  // (or per-instance) guard; a stray concurrent run for the same slug is
  // rejected rather than silently interleaving two imports of the same data.
  private readonly backfillsInProgress = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubspotAudit: HubspotAuditService,
    private readonly businessUnitContext: BusinessUnitContext,
    private readonly candidateAudit: CandidateAuditService,
  ) {}

  // ── List ──────────────────────────────────────────────────────────────────

  async findAll() {
    const data = await this.prisma.businessUnit.findMany({
      orderBy: { name: 'asc' },
      include: { branding: true },
    });
    return { status: 200, data };
  }

  /**
   * Visual-branding-only list for ANY authenticated user (org users included),
   * exposed via the auth-only `GET /business-units/branding` route so the app
   * brand resolver (color/logo/favicon) works for non-admins. Returns ONLY the
   * `is_visible=true` BUs and ONLY the app-branding fields — deliberately no
   * `candidate_pool`, `is_active`, `created_by`, or email `branding` — so this
   * endpoint never leaks admin/config data to organization users.
   */
  async findAllBranding() {
    const data = await this.prisma.businessUnit.findMany({
      where: { is_visible: true },
      orderBy: { name: 'asc' },
      select: {
        slug: true,
        name: true,
        hubspot_value: true,
        primary_color: true,
        primary_hover: true,
        logo_url: true,
        favicon_url: true,
      },
    });
    return { status: 200, data };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(dto: CreateBusinessUnitDto, userId: string) {
    const existing = await this.prisma.businessUnit.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException(
        `A business unit with slug "${dto.slug}" already exists`,
      );
    }

    // Create BU and its default EmailBranding in a single transaction
    const [bu] = await this.prisma.$transaction([
      this.prisma.businessUnit.create({
        data: { slug: dto.slug, name: dto.name, created_by: userId },
      }),
      this.prisma.emailBranding.create({
        data: {
          business_unit: dto.slug,
          primary_color: '#01546B',
          secondary_color: '#013A4F',
          logo_url: 'https://staging.medvirtual.ai/logo.png',
          company_name: dto.name,
          layout_preset: 'default',
          button_color: null,
          button_text_color: null,
          updated_by: userId,
        },
      }),
    ]);

    return { status: 201, data: bu };
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async update(slug: string, dto: UpdateBusinessUnitDto) {
    const before = await this.findOneOrThrow(slug);

    const updated = await this.prisma.businessUnit.update({
      where: { slug },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        ...(dto.is_visible !== undefined && { is_visible: dto.is_visible }),
        ...(dto.primary_color !== undefined && {
          primary_color: dto.primary_color,
        }),
        ...(dto.primary_hover !== undefined && {
          primary_hover: dto.primary_hover,
        }),
        ...(dto.logo_url !== undefined && { logo_url: dto.logo_url }),
        ...(dto.favicon_url !== undefined && { favicon_url: dto.favicon_url }),
        ...(dto.candidate_pool !== undefined && {
          candidate_pool: dto.candidate_pool,
        }),
      },
      include: { branding: true },
    });

    // Deactivation transition (true→false): cascade the same soft-delete the
    // cron decommission path performs — soft-delete Organizations for this BU,
    // deactivate their USERs, tag Candidates, and set Affiliates inactive, all
    // tagged `deactivated_by_bu=slug` so a later reactivation can restore exactly
    // this set. Runs synchronously (awaited) before returning.
    const wasDeactivated =
      before.is_visible === true && updated.is_visible === false;
    if (wasDeactivated) {
      try {
        await this.deactivateByBu(slug, updated.hubspot_value ?? updated.name);
        void this.hubspotAudit.log({
          entityType: HubspotEntityType.organization,
          entityId: slug,
          hubspotObjectType: 'business_unit_deactivate',
          action: HubspotAuditAction.SYNC,
          source: HubspotAuditSource.user_action,
          success: true,
          payload: { slug, trigger: 'deactivation' },
        });
      } catch (err) {
        const error = err as Error;
        this.logger.error(
          `deactivateByBu failed for "${slug}" after deactivation: ${error.message}`,
        );
        void this.hubspotAudit.log({
          entityType: HubspotEntityType.organization,
          entityId: slug,
          hubspotObjectType: 'business_unit_deactivate',
          action: HubspotAuditAction.SYNC,
          source: HubspotAuditSource.user_action,
          success: false,
          payload: { slug, trigger: 'deactivation' },
          errorMessage: error.message,
        });
        throw err;
      }

      return { status: 200, data: updated };
    }

    // Activation transition (false→true): reactivate whatever was tagged
    // deactivated_by_bu for this slug, THEN fire the multi-object backfill
    // fire-and-forget (does not block this response). Any other transition
    // (true→true, false→false) is a no-op here.
    const wasActivated =
      before.is_visible === false && updated.is_visible === true;
    if (wasActivated) {
      await this.reactivateDeactivatedByBu(
        slug,
        updated.hubspot_value ?? updated.name,
      );

      this.backfillFromHubspot(slug)
        .then((result) => {
          void this.hubspotAudit.log({
            entityType: HubspotEntityType.organization,
            entityId: slug,
            hubspotObjectType: 'business_unit_backfill',
            action: HubspotAuditAction.SYNC,
            source: HubspotAuditSource.user_action,
            success: true,
            payload: { slug, trigger: 'activation' },
            response: result as unknown as Record<string, unknown>,
          });
        })
        .catch((err: Error) => {
          this.logger.error(
            `backfillFromHubspot failed for "${slug}" after activation: ${err.message}`,
          );
          void this.hubspotAudit.log({
            entityType: HubspotEntityType.organization,
            entityId: slug,
            hubspotObjectType: 'business_unit_backfill',
            action: HubspotAuditAction.SYNC,
            source: HubspotAuditSource.user_action,
            success: false,
            payload: { slug, trigger: 'activation' },
            errorMessage: err.message,
          });
        });
    }

    return { status: 200, data: updated };
  }

  // ── Deactivate (soft delete) ──────────────────────────────────────────────

  async deactivate(slug: string) {
    await this.findOneOrThrow(slug);

    const updated = await this.prisma.businessUnit.update({
      where: { slug },
      data: { is_active: false },
    });

    return { status: 200, data: updated };
  }

  // ── Branding ──────────────────────────────────────────────────────────────

  async getBranding(slug: string) {
    const bu = await this.findOneOrThrow(slug);

    const branding = await this.ensureBranding(slug, bu.name);

    return { status: 200, data: branding };
  }

  async updateBranding(slug: string, dto: UpdateBrandingDto, userId: string) {
    const bu = await this.findOneOrThrow(slug);

    // Self-heal: BUs discovered from HubSpot (cron intake) may not yet have a
    // companion EmailBranding row. Create a default one on demand so editing a
    // just-activated BU's design never 404s. Only ever creates for a BU that
    // actually exists (findOneOrThrow above guarantees a real slug).
    const current = await this.ensureBranding(slug, bu.name);

    // Snapshot to history before overwriting
    await this.prisma.emailBrandingHistory.create({
      data: {
        branding_id: current.id,
        snapshot: {
          primary_color: current.primary_color,
          secondary_color: current.secondary_color,
          logo_url: current.logo_url,
          company_name: current.company_name,
          layout_preset: current.layout_preset,
          button_color: current.button_color,
          button_text_color: current.button_text_color,
        },
        changed_by: userId,
      },
    });

    const updated = await this.prisma.emailBranding.update({
      where: { business_unit: slug },
      data: {
        ...(dto.primary_color !== undefined && {
          primary_color: dto.primary_color,
        }),
        ...(dto.secondary_color !== undefined && {
          secondary_color: dto.secondary_color,
        }),
        ...(dto.logo_url !== undefined && { logo_url: dto.logo_url }),
        ...(dto.company_name !== undefined && {
          company_name: dto.company_name,
        }),
        ...(dto.layout_preset !== undefined && {
          layout_preset: dto.layout_preset,
        }),
        ...(dto.button_color !== undefined && {
          button_color: dto.button_color,
        }),
        ...(dto.button_text_color !== undefined && {
          button_text_color: dto.button_text_color,
        }),
        updated_by: userId,
      },
    });

    // Fire-and-forget sync to peer environment
    this.syncBrandingToPeer(slug, updated, userId).catch((err) =>
      this.logger.error(
        `Branding sync to peer failed for "${slug}": ${err.message}`,
      ),
    );

    return { status: 200, data: updated };
  }

  async getBrandingHistory(slug: string) {
    const bu = await this.findOneOrThrow(slug);

    const branding = await this.ensureBranding(slug, bu.name);

    const history = await this.prisma.emailBrandingHistory.findMany({
      where: { branding_id: branding.id },
      orderBy: { changed_at: 'desc' },
      take: 50,
    });

    // Resolve user display names, mirroring EmailTemplatesService.getHistory() —
    // changed_by is a raw USER id or the 'sync' sentinel, with no Prisma relation.
    const userIds = [
      ...new Set(
        history.map((h) => h.changed_by).filter((id) => id !== 'sync'),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.uSER.findMany({
          where: { id: { in: userIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const userMap = Object.fromEntries(
      users.map((u) => [u.id, `${u.first_name} ${u.last_name}`]),
    );

    const enriched = history.map((h) => ({
      ...h,
      changed_by_name:
        h.changed_by === 'sync'
          ? 'Auto-sync'
          : (userMap[h.changed_by] ?? h.changed_by),
    }));

    return { status: 200, data: enriched };
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  async receiveBrandingSyncFromPeer(
    slug: string,
    payload: {
      primary_color?: string;
      secondary_color?: string;
      logo_url?: string;
      company_name?: string;
      layout_preset?: string;
      button_color?: string;
      button_text_color?: string;
    },
    originEnv: string,
  ) {
    const branding = await this.prisma.emailBranding.findUnique({
      where: { business_unit: slug },
    });
    if (!branding) {
      this.logger.warn(
        `Branding sync received for unknown BU "${slug}" — ignored`,
      );
      return;
    }

    await this.prisma.emailBrandingHistory.create({
      data: {
        branding_id: branding.id,
        snapshot: {
          primary_color: branding.primary_color,
          secondary_color: branding.secondary_color,
          logo_url: branding.logo_url,
          company_name: branding.company_name,
          layout_preset: branding.layout_preset,
          button_color: branding.button_color,
          button_text_color: branding.button_text_color,
        },
        changed_by: 'sync',
      },
    });

    await this.prisma.emailBranding.update({
      where: { business_unit: slug },
      data: {
        ...(payload.primary_color !== undefined && {
          primary_color: payload.primary_color,
        }),
        ...(payload.secondary_color !== undefined && {
          secondary_color: payload.secondary_color,
        }),
        ...(payload.logo_url !== undefined && { logo_url: payload.logo_url }),
        ...(payload.company_name !== undefined && {
          company_name: payload.company_name,
        }),
        ...(payload.layout_preset !== undefined && {
          layout_preset: payload.layout_preset,
        }),
        ...(payload.button_color !== undefined && {
          button_color: payload.button_color,
        }),
        ...(payload.button_text_color !== undefined && {
          button_text_color: payload.button_text_color,
        }),
        updated_by: 'sync',
      },
    });

    this.logger.log(`Branding for "${slug}" synced from ${originEnv}`);
  }

  private async syncBrandingToPeer(
    slug: string,
    branding: {
      primary_color: string;
      secondary_color?: string | null;
      logo_url?: string | null;
      company_name: string;
      layout_preset: string;
      button_color?: string | null;
      button_text_color?: string | null;
    },
    userId: string,
  ) {
    const peerUrl = process.env.PEER_ENV_API_URL;
    const secret = process.env.INTER_ENV_SYNC_SECRET;
    const currentEnv = process.env.ENVIRONMENT ?? 'DEV';

    if (!peerUrl || !secret) return;

    await fetch(`${peerUrl}/business-units/${slug}/branding/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Secret': secret,
        'X-Sync-Origin': currentEnv,
        'X-Sync-By': userId,
      },
      body: JSON.stringify({
        primary_color: branding.primary_color,
        secondary_color: branding.secondary_color,
        logo_url: branding.logo_url,
        company_name: branding.company_name,
        layout_preset: branding.layout_preset,
        button_color: branding.button_color,
        button_text_color: branding.button_text_color,
      }),
    });

    this.logger.log(`Branding for "${slug}" synced to peer (${peerUrl})`);
  }

  // ── Backfill (Task 06) ───────────────────────────────────────────────────

  /**
   * Multi-object, non-destructive backfill for a BU: pulls pre-existing
   * HubSpot objects for `bu.hubspot_value` across all 4 types and upserts
   * them by `hubspot_id` (never deletes). Safe to re-run (idempotent) and
   * guarded against concurrent runs for the same slug.
   *
   * Reuses the same mapping dictionaries/helpers as the webhook handlers:
   * - companies      → `mapOrganizationToDb` / `organizationToDbDictionary` (organizationCreation.ts)
   * - contacts       → `mapContactToDb` / `contactToDbDictionary` (contactCreation.ts)
   * - VA custom obj  → `candidadeToDbDictionary` (objectCreation.ts)
   * - Growth Partner → `affiliateToDbDictionary` (affiliateCreation.ts / syncGrowthPartnersFromHubspot)
   */
  async backfillFromHubspot(slug: string): Promise<{
    organizations: number;
    contacts: number;
    candidates: number;
    affiliates: number;
    failures?: string[];
  }> {
    const bu = await this.findOneOrThrow(slug);

    if (this.backfillsInProgress.has(slug)) {
      throw new BadRequestException(
        `A backfill is already in progress for business unit "${slug}"`,
      );
    }
    this.backfillsInProgress.add(slug);

    try {
      const businessUnitValue = bu.hubspot_value ?? bu.name;

      // `allSettled`, not `all`: the four object types are independent imports,
      // and a failure on one (e.g. HubSpot rejecting a search) must not discard
      // the records the other three already upserted. Each failure degrades to a
      // count of 0 and is surfaced in the returned `failures` list, so a partial
      // run is visible rather than looking like a clean success. The whole
      // backfill is idempotent, so re-running after a partial failure is safe.
      const settled = await Promise.allSettled([
        this.backfillOrganizations(businessUnitValue),
        this.backfillContacts(businessUnitValue),
        this.backfillCandidates(businessUnitValue),
        this.backfillAffiliates(businessUnitValue),
      ]);

      const labels = [
        'organizations',
        'contacts',
        'candidates',
        'affiliates',
      ] as const;

      const counts = {
        organizations: 0,
        contacts: 0,
        candidates: 0,
        affiliates: 0,
      };
      const failures: string[] = [];

      settled.forEach((outcome, index) => {
        const label = labels[index];
        if (outcome.status === 'fulfilled') {
          counts[label] = outcome.value;
        } else {
          const reason = outcome.reason as Error;
          failures.push(`${label}: ${reason.message}`);
          this.logger.error(
            `backfillFromHubspot("${slug}") failed for ${label}: ${reason.message}`,
          );
        }
      });

      this.logger.log(
        `backfillFromHubspot("${slug}"): organizations=${counts.organizations}, contacts=${counts.contacts}, candidates=${counts.candidates}, affiliates=${counts.affiliates}`,
      );

      return { ...counts, ...(failures.length > 0 && { failures }) };
    } finally {
      this.backfillsInProgress.delete(slug);
    }
  }

  private async searchHubspotByBusinessUnit(
    objectType: string,
    businessUnitValue: string,
    properties: string[],
    filterPropertyName = 'business_unit',
  ): Promise<Array<{ id: string; properties: Record<string, any> }>> {
    const results: Array<{ id: string; properties: Record<string, any> }> = [];
    let after: string | undefined;

    do {
      const body: Record<string, unknown> = {
        filterGroups: [
          {
            filters: [
              {
                propertyName: filterPropertyName,
                operator: 'EQ',
                value: businessUnitValue,
              },
            ],
          },
        ],
        properties,
        limit: 100,
        ...(after && { after }),
      };

      let response: { data?: any };
      try {
        response = await axios.post(
          `https://api.hubapi.com/crm/v3/objects/${objectType}/search`,
          body,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );
      } catch (err) {
        // Never let a raw AxiosError escape: its `config` carries the
        // `Authorization: Bearer <token>` header, and anything that serializes
        // the error (Nest's default exception handler, a console dump) would
        // write the HubSpot private app token to CloudWatch in plaintext.
        // Re-throw a compact error with only what's needed to debug: the
        // status, HubSpot's own message and correlationId (what their support
        // asks for), and which search failed.
        throw this.toSafeHubspotError(err, objectType, filterPropertyName);
      }

      results.push(...(response.data?.results ?? []));
      after = response.data?.paging?.next?.after;
    } while (after);

    return results;
  }

  /**
   * Reduces a HubSpot request failure to a single-line, token-free Error.
   */
  private toSafeHubspotError(
    err: unknown,
    objectType: string,
    filterPropertyName: string,
  ): Error {
    const axiosError = err as {
      response?: {
        status?: number;
        data?: { message?: string; correlationId?: string };
      };
      message?: string;
    };

    const status = axiosError?.response?.status;
    const hubspotMessage = axiosError?.response?.data?.message;
    const correlationId = axiosError?.response?.data?.correlationId;

    const details = [
      `objectType=${objectType}`,
      `filterProperty=${filterPropertyName}`,
      status !== undefined ? `status=${status}` : undefined,
      hubspotMessage ? `hubspotMessage="${hubspotMessage}"` : undefined,
      correlationId ? `correlationId=${correlationId}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');

    return new Error(
      `HubSpot search failed (${details})` +
        (status === undefined && axiosError?.message
          ? `: ${axiosError.message}`
          : ''),
    );
  }

  private async backfillOrganizations(
    businessUnitValue: string,
  ): Promise<number> {
    const properties = Object.keys(organizationToDbDictionary);
    const companies = await this.searchHubspotByBusinessUnit(
      'companies',
      businessUnitValue,
      properties,
    );

    let count = 0;
    for (const company of companies) {
      const hubspotId = String(company.id);
      const organizationData = mapOrganizationToDb(company.properties);

      // Prisma scalar-list (`String[]`) columns reject `null`. `mapOrganizationToDb`
      // maps generically and can yield `null` for list-typed fields (e.g. `specialties`)
      // when HubSpot returns no value, which crashes the upsert. Normalize any
      // list-typed field to a real array before sending it to Prisma — mirroring the
      // proven normalization in organization.service.ts create().
      const listFieldOverrides = {
        specialties: toStringArray((organizationData as any).specialties),
        // `services` is not currently produced by mapOrganizationToDb, but is also a
        // `String[]` column — normalize defensively if it ever appears.
        ...((organizationData as any).services !== undefined
          ? { services: toStringArray((organizationData as any).services) }
          : {}),
      };

      await this.prisma.organization.upsert({
        where: { hubspot_id: hubspotId },
        create: {
          ...(organizationData as any),
          ...listFieldOverrides,
          hubspot_id: hubspotId,
          name: organizationData.name ?? company.properties.name ?? 'Unknown',
          status: OrganizationStatus.inactive,
        },
        update: {
          ...(organizationData as any),
          ...listFieldOverrides,
        },
      });
      count++;
    }
    return count;
  }

  private async backfillContacts(businessUnitValue: string): Promise<number> {
    const properties = Object.keys(contactToDbDictionary);
    const contacts = await this.searchHubspotByBusinessUnit(
      'contacts',
      businessUnitValue,
      properties,
    );

    let count = 0;
    for (const contact of contacts) {
      const hubspotId = String(contact.id);
      const contactData = mapContactToDb(contact.properties);

      await this.prisma.contact.upsert({
        where: { hubspot_id: hubspotId },
        create: { ...contactData, hubspot_id: hubspotId },
        update: { ...contactData },
      });
      count++;
    }
    return count;
  }

  private async backfillCandidates(businessUnitValue: string): Promise<number> {
    const objectType = process.env.HUBSPOT_CUSTOM_OBJECT ?? '2-5922196';
    const properties = Object.keys(candidadeToDbDictionary);
    // The VA custom object names this property `business_units` (plural) — the
    // other three object types use the singular `business_unit`. Filtering on
    // the singular name here makes HubSpot reject the whole search with a 400.
    const candidates = await this.searchHubspotByBusinessUnit(
      objectType,
      businessUnitValue,
      properties,
      'business_units',
    );

    let count = 0;
    for (const candidate of candidates) {
      const hubspotId = String(candidate.id);
      const candidateData: Record<string, any> = {};

      for (const [hubspotKey, dbField] of Object.entries(
        candidadeToDbDictionary,
      )) {
        const value = candidate.properties[hubspotKey];
        if (value === undefined) continue;

        if (Array.isArray(dbField)) {
          dbField.forEach((field) => {
            candidateData[field] = value;
          });
        } else {
          candidateData[dbField] = value;
        }
      }

      // Lightweight pre-lookup: tells the audit log whether this iteration is a
      // create or an update (upsert alone doesn't say which branch fired) and
      // supplies the "before" diff for the update case.
      const existingCandidate = await this.prisma.candidate.findUnique({
        where: { hubspot_id: hubspotId },
        select: { id: true },
      });

      const upsertedCandidate = await this.prisma.candidate.upsert({
        where: { hubspot_id: hubspotId },
        create: {
          ...candidateData,
          hubspot_id: hubspotId,
          // HubSpot's VA object always carries `email` (mapped above via
          // candidadeToDbDictionary) — same assumption objectCreation.ts
          // makes for webhook-driven candidate creation.
          email: candidateData.email ?? `unknown+${hubspotId}@medvirtual.ai`,
          processing_status: 'pending',
          pipeline_status_origin: candidateData.pipeline_status,
        } as Prisma.CandidateCreateInput,
        update: { ...candidateData },
      });

      await this.candidateAudit.log({
        candidateId: upsertedCandidate.id,
        hubspotId,
        event: existingCandidate
          ? CANDIDATE_AUDIT_EVENTS.PROFILE_UPDATED
          : CANDIDATE_AUDIT_EVENTS.CANDIDATE_CREATED,
        fieldGroup: existingCandidate
          ? CandidateAuditFieldGroup.hubspot_sync
          : CandidateAuditFieldGroup.lifecycle,
        before: existingCandidate ? null : undefined,
        after: candidateData,
        source: CandidateAuditSource.webhook,
      });

      count++;
    }
    return count;
  }

  private async backfillAffiliates(businessUnitValue: string): Promise<number> {
    const objectType =
      process.env.HUBSPOT_GROWTH_PARTNER_CUSTOM_OBJECT ?? '2-54072002';
    const properties = Object.keys(affiliateToDbDictionary);
    const affiliates = await this.searchHubspotByBusinessUnit(
      objectType,
      businessUnitValue,
      properties,
    );

    let count = 0;
    for (const affiliate of affiliates) {
      const hubspotId = String(affiliate.id);
      const affiliateData: Record<string, any> = {};

      for (const [hubspotKey, dbField] of Object.entries(
        affiliateToDbDictionary,
      )) {
        const value = affiliate.properties[hubspotKey];
        if (value === undefined) continue;
        affiliateData[dbField] = value;
      }

      await this.prisma.affiliateProfile.upsert({
        where: { hubspot_id: hubspotId },
        create: {
          full_name: affiliateData.full_name ?? null,
          hubspot_pipeline: affiliateData.hubspot_pipeline ?? null,
          hubspot_pipeline_stage: affiliateData.hubspot_pipeline_stage ?? null,
          business_unit: affiliateData.business_unit ?? businessUnitValue,
          commission_percent_default:
            affiliateData.commission_percent_default ?? 7,
          hubspot_id: hubspotId,
          status: AffiliateStatus.pending,
        },
        update: {
          full_name: affiliateData.full_name ?? undefined,
          hubspot_pipeline: affiliateData.hubspot_pipeline ?? undefined,
          hubspot_pipeline_stage:
            affiliateData.hubspot_pipeline_stage ?? undefined,
          business_unit: affiliateData.business_unit ?? undefined,
        },
      });
      count++;
    }
    return count;
  }

  /**
   * Deactivation cascade — the exact soft-delete the cron decommission path
   * performs, extracted so BOTH the cron (`syncBusinessUnits`) and the manual
   * `PUT /business-units/:slug` deactivation (`update` true→false) share one
   * implementation.
   *
   * Per BU (matched by its `business_unit` value = hubspot_value ?? name):
   *  - flip the BU row `is_visible=false` (done here so it happens exactly once
   *    across both callers),
   *  - soft-delete Organizations (status=deleted) + tag `deactivated_by_bu=slug`,
   *  - deactivate those orgs' USERs (status=inactive) + tag,
   *  - tag Candidates `deactivated_by_bu=slug`,
   *  - set AffiliateProfiles inactive + tag.
   *
   * Everything is tagged `deactivated_by_bu=slug` so `reactivateDeactivatedByBu`
   * can later restore exactly this set (round-trip symmetry). Busts the
   * BusinessUnitContext cache at the end so visibility checks re-read the DB.
   */
  async deactivateByBu(slug: string, businessUnitValue: string): Promise<void> {
    await this.prisma.businessUnit.update({
      where: { slug },
      data: { is_visible: false },
    });

    // Organizations tagged with this BU — soft-delete + tag.
    const affectedOrgs = await this.prisma.organization.findMany({
      where: { business_unit: businessUnitValue },
      select: { id: true },
    });
    const affectedOrgIds = affectedOrgs.map((o) => o.id);

    await this.prisma.organization.updateMany({
      where: { business_unit: businessUnitValue },
      data: { status: OrganizationStatus.deleted, deactivated_by_bu: slug },
    });

    // Users belong to organizations (no direct business_unit field on USER) —
    // deactivate every user of every affected organization.
    if (affectedOrgIds.length > 0) {
      await this.prisma.uSER.updateMany({
        where: { organization_id: { in: affectedOrgIds } },
        data: { status: 'inactive', deactivated_by_bu: slug },
      });
    }

    // updateMany only returns a count — fetch the affected rows first so the
    // audit log can capture per-candidate before/after state.
    const candidatesBeforeDeactivation = await this.prisma.candidate.findMany(
      {
        where: { business_unit: businessUnitValue },
        select: { id: true, hubspot_id: true, deactivated_by_bu: true },
      },
    );

    await this.prisma.candidate.updateMany({
      where: { business_unit: businessUnitValue },
      data: { deactivated_by_bu: slug },
    });

    await this.candidateAudit.logMany(
      candidatesBeforeDeactivation.map((c) => ({
        candidateId: c.id,
        hubspotId: c.hubspot_id,
        event: CANDIDATE_AUDIT_EVENTS.DEACTIVATED_BY_BU,
        fieldGroup: CandidateAuditFieldGroup.business_unit,
        before: { deactivated_by_bu: c.deactivated_by_bu },
        after: { deactivated_by_bu: slug },
        source: CandidateAuditSource.system,
      })),
    );

    await this.prisma.affiliateProfile.updateMany({
      where: { business_unit: businessUnitValue },
      data: { status: AffiliateStatus.inactive, deactivated_by_bu: slug },
    });

    this.businessUnitContext.bustCache();

    this.logger.log(
      `deactivateByBu("${slug}"): is_visible=false, cascaded soft-delete tagged deactivated_by_bu="${slug}" for business_unit="${businessUnitValue}"`,
    );
  }

  /**
   * Reactivation half of the activation flow — restores the set of rows that
   * were soft-deleted for BU reasons across all 4 object types, and clears
   * their tags. Always runs BEFORE the backfill kicks off.
   *
   * There are TWO soft-delete paths that must both be undone here:
   *  1. Cron decommission (cron.service.ts) — tags rows `deactivated_by_bu=slug`.
   *  2. Webhook deletion (organizationDeletion.ts) — when a company's HubSpot
   *     `business_unit` is changed to a BU that is not visible on our side, the
   *     org is set `status=deleted` + `deletedAt`, but WITHOUT any
   *     `deactivated_by_bu` marker. A marker-only match would leave these orgs
   *     invisible forever after the BU is activated (the reported bug).
   *
   * For Organizations we therefore broaden the match to the union of both
   * paths, scoped to THIS BU only:
   *   deactivated_by_bu = slug
   *     OR (status = deleted AND business_unit = <this BU's hubspot_value>)
   * and restore to `inactive` (NOT active — same rule as organizationReactivation
   * and organizationCreation: a human/deal must activate), clearing `deletedAt`.
   */
  private async reactivateDeactivatedByBu(
    slug: string,
    businessUnitValue: string,
  ): Promise<void> {
    // Organizations: union of cron-marked and webhook-deleted rows, scoped to
    // this BU. Restore to `inactive` and clear both the marker and `deletedAt`
    // (mirrors organizationReactivation.ts for the webhook-deleted set).
    await this.prisma.organization.updateMany({
      where: {
        OR: [
          { deactivated_by_bu: slug },
          {
            status: OrganizationStatus.deleted,
            business_unit: businessUnitValue,
          },
        ],
      },
      data: {
        status: OrganizationStatus.inactive,
        deactivated_by_bu: null,
        deletedAt: null,
      },
    });

    // Users belong to organizations (no business_unit field on USER). The cron
    // cascade tagged them `deactivated_by_bu=slug`, so those we can safely
    // reactivate by marker.
    //
    // SAFETY NOTE (webhook path): organizationDeletion.ts cascaded users of the
    // deleted org to `status=inactive` WITHOUT any marker. Those users are now
    // indistinguishable from users made inactive for unrelated reasons, so we
    // deliberately do NOT blanket-reactivate them here — flipping them to
    // `active` could wrongly re-enable accounts. This is acceptable because the
    // org itself is restored to `inactive` above and the org listing shows both
    // `active` and `inactive` orgs, so the company reappears regardless. Those
    // users remain `inactive` (their correct post-restore state) and are
    // re-activated by the normal login/deal flow, exactly like a freshly
    // reactivated org from organizationReactivation.ts.
    await this.prisma.uSER.updateMany({
      where: { deactivated_by_bu: slug },
      data: { status: 'inactive', deactivated_by_bu: null },
    });

    // updateMany only returns a count — fetch the affected rows first so the
    // audit log can capture per-candidate before/after state.
    const candidatesBeforeReactivation = await this.prisma.candidate.findMany(
      {
        where: { deactivated_by_bu: slug },
        select: { id: true, hubspot_id: true, deactivated_by_bu: true },
      },
    );

    await this.prisma.candidate.updateMany({
      where: { deactivated_by_bu: slug },
      data: { deactivated_by_bu: null },
    });

    await this.candidateAudit.logMany(
      candidatesBeforeReactivation.map((c) => ({
        candidateId: c.id,
        hubspotId: c.hubspot_id,
        event: CANDIDATE_AUDIT_EVENTS.REACTIVATED_BY_BU,
        fieldGroup: CandidateAuditFieldGroup.business_unit,
        before: { deactivated_by_bu: c.deactivated_by_bu },
        after: { deactivated_by_bu: null },
        source: CandidateAuditSource.system,
      })),
    );

    // Affiliates: marker-based only. The cron decommission set these to
    // `inactive` and tagged them; restoring to `active` returns them to their
    // pre-decommission state. There is no webhook path that mass-deletes
    // affiliates by BU, so no broadening is needed here.
    await this.prisma.affiliateProfile.updateMany({
      where: { deactivated_by_bu: slug },
      data: { status: AffiliateStatus.active, deactivated_by_bu: null },
    });

    this.logger.log(
      `reactivateDeactivatedByBu("${slug}"): restored marker-tagged rows and webhook-deleted orgs for business_unit="${businessUnitValue}"`,
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async findOneOrThrow(slug: string) {
    const bu = await this.prisma.businessUnit.findUnique({ where: { slug } });
    if (!bu) throw new NotFoundException(`Business unit "${slug}" not found`);
    return bu;
  }

  /**
   * Returns the EmailBranding row for `slug`, creating a default one if it does
   * not exist yet.
   *
   * Every BU is supposed to have exactly one companion EmailBranding row (see
   * `create()` and `seed.ts`), but BUs that enter the table via the HubSpot
   * intake cron (`syncBusinessUnits`) historically did not get one — so opening
   * or saving their "Customize Design" branding threw `NotFoundException`. This
   * lazily backfills the missing row using the same default shape as `create()`,
   * repairing pre-existing rows (e.g. MMVA) with no data migration. Callers must
   * have already validated the BU exists (`findOneOrThrow`).
   */
  private async ensureBranding(slug: string, name: string) {
    const existing = await this.prisma.emailBranding.findUnique({
      where: { business_unit: slug },
    });
    if (existing) return existing;

    return this.prisma.emailBranding.create({
      data: {
        business_unit: slug,
        primary_color: '#01546B',
        secondary_color: '#013A4F',
        logo_url: 'https://staging.medvirtual.ai/logo.png',
        company_name: name,
        layout_preset: 'default',
        button_color: null,
        button_text_color: null,
        updated_by: 'system',
      },
    });
  }
}
