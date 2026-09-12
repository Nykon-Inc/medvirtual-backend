import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { PreviewEmailTemplateDto } from './dto/preview-email-template.dto';
import { TestSendEmailTemplateDto } from './dto/test-send-email-template.dto';
import { EmailTheme } from '../common/utils/email-templates/theme';
import {
  getEmailLogoCss,
  getEmailLogoImg,
  getLogoUrl,
} from '../common/utils/email-templates/components';
import { renderOfferPanelCandidateCardsShowcase } from '../common/utils/email-templates/offer-panel-candidate-cards-showcase';

// Sample data used when filling placeholders for preview / test-send
const SAMPLE_DATA: Record<string, string> = {
  '{{inviteLink}}': 'https://app.medvirtual.ai/invite/sample-token',
  '{{resetLink}}': 'https://app.medvirtual.ai/reset/sample-token',
  '{{verificationCode}}': '482951',
  '{{verificationUrl}}': 'https://app.medvirtual.ai/verify/sample-token',
  '{{userName}}': 'Jane Smith',
  '{{companyName}}': 'MedVirtual',
  '{{organizationName}}': 'Bright Dental Clinic',
  '{{partnerName}}': 'Allied Health Partners',
  '{{positionCount}}': '3',
  '{{platformUrl}}': 'https://app.medvirtual.ai',
  '{{reportUrl}}': 'https://app.medvirtual.ai/reports/sample',
  '{{quarter}}': 'Q1',
  '{{year}}': '2026',
  '{{totalEarnings}}': '$1,250.00',
  '{{paidOut}}': '$900.00',
  '{{pendingAmount}}': '$350.00',
  '{{date}}': new Date().toLocaleDateString('en-US'),
  '{{userList}}': '- john@example.com\n- mary@example.com',
  '{{companiesList}}': '- Bright Dental Clinic\n- Sunrise Medical',
  '{{reportContent}}': 'Active staff: 42 | Open requests: 8 | Tickets: 3',
  '{{jobName}}': 'daily-sync',
  '{{errorTime}}': new Date().toISOString(),
  '{{errorMessage}}': 'Connection timeout after 30s',
  '{{operationName}}': 'upload-candidate-document',
  '{{accountEmail}}': 'integration@medvirtual.ai',
  '{{currentUsage}}': '95%',
  '{{quotaLimit}}': '100%',
  // ── Offer panel ───────────────────────────────────────────────────────────
  '{{candidateLabel}}': '3 candidates',
  '{{createdByName}}': 'Paulo',
  '{{candidateCount}}': '3',
  '{{panelLink}}':
    'https://app.medvirtual.ai/modules/public/offer-panel/sample-token',
  '{{offerTitle}}': 'Senior RN Opening',
  '{{offerDescription}}':
    'A quick note on why these candidates stood out for your team.',
  // Filled in at preview time by `sampleCandidateCards()` so the grid picks up
  // the previewed business unit's own branding instead of a fixed brand.
  '{{candidateCards}}': '',
};

/**
 * Stand-in candidates for previewing / test-sending `offer-panel-created`.
 * Deliberately covers the three cases that look different: a rate above the
 * promo threshold (struck), a rate below it (never struck), and a candidate
 * with no photo (initials tile instead of a broken image).
 */
const SAMPLE_OFFER_PANEL_CANDIDATES = [
  {
    first_name: 'Ana',
    last_name: 'Silva',
    country: 'Brazil',
    avatar_url: null,
    employment_type: 'Full Time',
    approved_positions_pairing: ['Medical Assistant', 'Front Desk'],
    skills: [{ skill_name: 'EMR / EHR' }, { skill_name: 'Scheduling' }],
    bill_rate_monthly: 2500,
  },
  {
    first_name: 'Carlos',
    last_name: 'Mendes',
    country: 'Philippines',
    avatar_url: null,
    employment_type: 'Full Time',
    approved_positions_pairing: ['Medical Scribe'],
    skills: [{ skill_name: 'Athena' }, { skill_name: 'Documentation' }],
    bill_rate_monthly: 2200,
  },
  {
    first_name: 'Joana',
    last_name: 'Pereira',
    country: 'Colombia',
    avatar_url: null,
    employment_type: 'Full Time',
    approved_positions_pairing: ['Patient Coordinator'],
    skills: [{ skill_name: 'Kareo' }],
    bill_rate_monthly: 1650,
  },
];

// Per-variable defaults applied when a caller's runtimeValues map omits a
// placeholder the template declares — keeps the copy readable (e.g. "Hello,
// there!") instead of leaking the raw token when data is missing or a caller
// used the wrong key name.
const PLACEHOLDER_FALLBACKS: Record<string, string> = {
  '{{firstName}}': 'there',
  '{{userName}}': 'there',
  '{{partnerName}}': 'there',
  '{{companyName}}': 'your company',
  '{{organizationName}}': 'your organization',
};

@Injectable()
export class EmailTemplatesService {
  private readonly logger = new Logger(EmailTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // ── getTemplateContent (used by other services) ───────────────────────────
  // Returns { subject, html } resolved from the DB, falling back to the
  // original hardcoded template function when the DB record is missing.

  async getTemplateContent(
    key: string,
    runtimeValues: Record<string, string>,
    theme: EmailTheme,
    businessUnit?: string | null,
  ): Promise<{ subject: string; html: string }> {
    // Prefer a BU-scoped active row; fall back to the global (null) row so
    // callers that pass a business unit still resolve templates seeded globally.
    const dbTemplate =
      (await this.prisma.emailTemplate.findFirst({
        where: { key, business_unit: businessUnit ?? null, is_active: true },
      })) ??
      (businessUnit
        ? await this.prisma.emailTemplate.findFirst({
            where: { key, business_unit: null, is_active: true },
          })
        : null);

    if (!dbTemplate) {
      return null as unknown as { subject: string; html: string };
    }

    const subject = this.applyPlaceholders(dbTemplate.subject, runtimeValues);
    const html = this.renderHtml(
      dbTemplate.body,
      dbTemplate.headline ?? '',
      {
        primaryColor: theme.primaryColor,
        primaryColorHover: theme.primaryColorHover,
        companyName: theme.companyName,
        logoUrl: theme.logoUrl,
        layoutPreset: theme.layoutPreset ?? 'default',
        buttonColor: theme.buttonColor,
        buttonTextColor: theme.buttonTextColor,
      },
      runtimeValues,
      dbTemplate.button_label,
      dbTemplate.button_url,
    );

    return { subject, html };
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async findAll(
    page = 1,
    perPage = 25,
    search = '',
    businessUnit?: string,
    category?: string,
    functionality?: string,
  ) {
    const skip = (page - 1) * perPage;

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { key: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (businessUnit !== undefined) {
      where.business_unit = businessUnit === 'global' ? null : businessUnit;
    }
    if (category !== undefined) {
      where.category = category;
    }
    if (functionality !== undefined) {
      where.functionality = functionality;
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.emailTemplate.findMany({
        where,
        orderBy: { key: 'asc' },
        skip,
        take: perPage,
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          subject: true,
          headline: true,
          button_label: true,
          business_unit: true,
          is_active: true,
          placeholders: true,
          updated_at: true,
          updated_by: true,
          category: true,
          functionality: true,
        },
      }),
      this.prisma.emailTemplate.count({ where }),
    ]);

    const enriched = await this.withUpdatedByName(data);

    return {
      status: 200,
      data: enriched,
      meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
    };
  }

  // Resolves `updated_by` (a raw USER id, or the 'sync' sentinel) into a display
  // name, mirroring the lookup already used for template history entries — there
  // is no Prisma relation from `updated_by` to USER, so this must be a manual join.
  private async withUpdatedByName<T extends { updated_by: string | null }>(
    rows: T[],
  ): Promise<(T & { updated_by_name: string | null })[]> {
    const userIds = [
      ...new Set(
        rows
          .map((r) => r.updated_by)
          .filter((id): id is string => !!id && id !== 'sync'),
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

    return rows.map((r) => ({
      ...r,
      updated_by_name:
        r.updated_by === null
          ? null
          : r.updated_by === 'sync'
            ? 'Auto-sync'
            : (userMap[r.updated_by] ?? r.updated_by),
    }));
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  async findOne(key: string, businessUnit?: string) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: businessUnit ?? null },
    });
    if (!template) throw new NotFoundException(`Template "${key}" not found`);
    return { status: 200, data: template };
  }

  // ── Update (wording) ──────────────────────────────────────────────────────

  async update(
    key: string,
    dto: UpdateEmailTemplateDto,
    userId: string,
    businessUnit?: string,
  ) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: businessUnit ?? null },
    });
    if (!template) throw new NotFoundException(`Template "${key}" not found`);

    this.validatePlaceholders(dto.body, template.placeholders as string[]);

    // Snapshot current state into history before overwriting
    await this.prisma.emailTemplateHistory.create({
      data: {
        template_id: template.id,
        subject: template.subject,
        headline: template.headline ?? '',
        body: template.body,
        button_label: template.button_label ?? '',
        button_url: template.button_url ?? '',
        category: template.category ?? '',
        functionality: template.functionality ?? '',
        changed_by: userId,
        reason: dto.reason ?? 'Manual edit',
      },
    });

    // Uses `!== undefined` (not `??`) so a field explicitly sent as null/empty
    // overwrites, while an omitted field keeps the previously saved value.
    const updated = await this.prisma.emailTemplate.update({
      where: { id: template.id },
      data: {
        subject: dto.subject,
        headline: dto.headline !== undefined ? dto.headline : template.headline,
        body: dto.body,
        button_label:
          dto.button_label !== undefined
            ? dto.button_label
            : template.button_label,
        button_url:
          dto.button_url !== undefined ? dto.button_url : template.button_url,
        category: dto.category !== undefined ? dto.category : template.category,
        functionality:
          dto.functionality !== undefined
            ? dto.functionality
            : template.functionality,
        updated_by: userId,
      },
    });

    // Fire-and-forget sync to peer environment
    this.syncToPeer(key, updated, userId).catch((err) =>
      this.logger.error(
        `Sync to peer failed for template "${key}": ${err.message}`,
      ),
    );

    return { status: 200, data: updated };
  }

  // ── History ───────────────────────────────────────────────────────────────

  async getHistory(key: string, businessUnit?: string) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: businessUnit ?? null },
      select: { id: true },
    });
    if (!template) throw new NotFoundException(`Template "${key}" not found`);

    const history = await this.prisma.emailTemplateHistory.findMany({
      where: { template_id: template.id },
      orderBy: { changed_at: 'desc' },
      take: 50,
    });

    // Resolve user display names for history entries that have a real user id
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

  // ── Functionality options ────────────────────────────────────────────────

  async getFunctionalityOptions() {
    const rows = await this.prisma.emailTemplate.findMany({
      where: { functionality: { not: null } },
      select: { functionality: true },
      distinct: ['functionality'],
      orderBy: { functionality: 'asc' },
    });

    const data = rows
      .map((r) => r.functionality)
      .filter((v): v is string => !!v && v.trim().length > 0);

    return { status: 200, data };
  }

  // ── Rollback ──────────────────────────────────────────────────────────────

  async rollback(
    key: string,
    historyId: string,
    userId: string,
    businessUnit?: string,
  ) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: businessUnit ?? null },
    });
    if (!template) throw new NotFoundException(`Template "${key}" not found`);

    const snapshot = await this.prisma.emailTemplateHistory.findUnique({
      where: { id: historyId },
    });
    if (!snapshot || snapshot.template_id !== template.id) {
      throw new NotFoundException('History entry not found for this template');
    }

    // Save current state to history before rolling back
    await this.prisma.emailTemplateHistory.create({
      data: {
        template_id: template.id,
        subject: template.subject,
        headline: template.headline ?? '',
        body: template.body,
        button_label: template.button_label ?? '',
        button_url: template.button_url ?? '',
        category: template.category ?? '',
        functionality: template.functionality ?? '',
        changed_by: userId,
        reason: `Rollback to version from ${snapshot.changed_at.toISOString()}`,
      },
    });

    const updated = await this.prisma.emailTemplate.update({
      where: { id: template.id },
      data: {
        subject: snapshot.subject,
        headline: snapshot.headline,
        body: snapshot.body,
        button_label: snapshot.button_label,
        button_url: snapshot.button_url,
        category: snapshot.category,
        functionality: snapshot.functionality,
        updated_by: userId,
      },
    });

    // Sync rollback to peer as well
    this.syncToPeer(key, updated, userId).catch((err) =>
      this.logger.error(
        `Sync to peer failed for rollback "${key}": ${err.message}`,
      ),
    );

    return { status: 200, data: updated };
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  async preview(
    key: string,
    dto: PreviewEmailTemplateDto,
    businessUnit?: string,
  ) {
    const buSlug = dto.business_unit ?? businessUnit ?? null;
    const template = await this.findTemplateForBranding(key, buSlug);
    if (!template) throw new NotFoundException(`Template "${key}" not found`);

    const body = dto.body ?? template.body;
    const subject = dto.subject ?? template.subject;

    const baseBranding = await this.resolveBranding(buSlug);
    const branding = this.applyBrandingOverrides(baseBranding, dto);
    const html = this.renderHtml(
      body,
      template.headline ?? '',
      branding,
      this.sampleOverridesFor(key, branding),
      template.button_label,
      template.button_url,
    );
    const renderedSubject = this.applyPlaceholders(subject);

    return { status: 200, data: { subject: renderedSubject, html } };
  }

  /**
   * Per-template sample values that depend on the branding being previewed.
   *
   * `SAMPLE_DATA` is a flat static map, but the offer-panel candidate cards have
   * to be rendered with the previewed business unit's own colour and logo —
   * otherwise "preview as <BU>" would show another brand's cards.
   */
  private sampleOverridesFor(
    key: string,
    branding: {
      primaryColor: string;
      primaryColorHover: string;
      companyName: string;
      logoUrl?: string;
      buttonColor?: string;
      buttonTextColor?: string;
    },
  ): Record<string, string> | undefined {
    if (key !== 'offer-panel-created') return undefined;

    return {
      '{{candidateCards}}': renderOfferPanelCandidateCardsShowcase(
        SAMPLE_OFFER_PANEL_CANDIDATES,
        {
          primaryColor: branding.primaryColor,
          primaryColorHover: branding.primaryColorHover,
          secondaryColor: '#F8F9FA',
          accentColor: branding.primaryColor,
          companyName: branding.companyName,
          logoUrl: branding.logoUrl,
          // The card's filled footer takes the Button Color, so the preview
          // must carry it or it would show a different colour than the send.
          buttonColor: branding.buttonColor,
          buttonTextColor: branding.buttonTextColor,
        },
        // Preview the promo treatment — it is the variant worth eyeballing,
        // and the sample rates deliberately straddle the threshold.
        true,
      ),
    };
  }

  // ── Test Send ─────────────────────────────────────────────────────────────

  async testSend(
    key: string,
    dto: TestSendEmailTemplateDto,
    userId: string,
    userEmail: string,
    businessUnit?: string,
  ) {
    const buSlug = dto.business_unit ?? businessUnit ?? null;
    const template = await this.findTemplateForBranding(key, buSlug);
    if (!template) throw new NotFoundException(`Template "${key}" not found`);

    const baseBranding = await this.resolveBranding(buSlug);
    const branding = this.applyBrandingOverrides(baseBranding, dto);
    const html = this.renderHtml(
      template.body,
      template.headline ?? '',
      branding,
      this.sampleOverridesFor(key, branding),
      template.button_label,
      template.button_url,
    );
    const subject = this.applyPlaceholders(template.subject);

    await this.mail.sendMail({
      from: `${branding.companyName} <noreply@medvirtual.ai>`,
      to: userEmail,
      subject: `[TEST] ${subject}`,
      html,
    });

    this.logger.log(
      `Test email sent for template "${key}" to ${userEmail} by user ${userId}`,
    );
    return { status: 200, message: `Test email sent to ${userEmail}` };
  }

  // ── Sync receiver (called by peer environment) ────────────────────────────

  async receiveSyncFromPeer(
    key: string,
    payload: {
      subject: string;
      headline?: string;
      body: string;
      button_label?: string;
      button_url?: string;
      category?: string;
      functionality?: string;
    },
    originEnv: string,
  ) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: null },
    });
    if (!template) {
      this.logger.warn(`Sync received for unknown template "${key}" — ignored`);
      return;
    }

    await this.prisma.emailTemplateHistory.create({
      data: {
        template_id: template.id,
        subject: template.subject,
        headline: template.headline ?? '',
        body: template.body,
        button_label: template.button_label ?? '',
        button_url: template.button_url ?? '',
        category: template.category ?? '',
        functionality: template.functionality ?? '',
        changed_by: 'sync',
        reason: `Auto-sync from ${originEnv}`,
      },
    });

    await this.prisma.emailTemplate.update({
      where: { id: template.id },
      data: {
        subject: payload.subject,
        headline:
          payload.headline !== undefined ? payload.headline : template.headline,
        body: payload.body,
        button_label:
          payload.button_label !== undefined
            ? payload.button_label
            : template.button_label,
        button_url:
          payload.button_url !== undefined
            ? payload.button_url
            : template.button_url,
        category:
          payload.category !== undefined ? payload.category : template.category,
        functionality:
          payload.functionality !== undefined
            ? payload.functionality
            : template.functionality,
        updated_by: 'sync',
      },
    });

    this.logger.log(`Template "${key}" synced from ${originEnv}`);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  validatePlaceholders(body: string, allowedPlaceholders: string[]) {
    const used = body.match(/\{\{[^}]+\}\}/g) ?? [];
    const invalid = used.filter((p) => !allowedPlaceholders.includes(p));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid placeholder(s): ${invalid.join(', ')}. Allowed: ${allowedPlaceholders.join(', ')}`,
      );
    }
  }

  applyPlaceholders(text: string, overrides?: Record<string, string>): string {
    const data = { ...SAMPLE_DATA, ...overrides };
    return text.replace(/\{\{[^}]+\}\}/g, (match) => {
      if (data[match] !== undefined) return data[match];
      if (PLACEHOLDER_FALLBACKS[match] !== undefined) {
        this.logger.warn(
          `Missing placeholder value for ${match}, using fallback`,
        );
        return PLACEHOLDER_FALLBACKS[match];
      }
      return match;
    });
  }

  // Falls back to the default (null) template row when the requested business
  // unit has no dedicated override, so "preview as <BU>" never 404s just
  // because that BU hasn't customized this template's content.
  private async findTemplateForBranding(key: string, buSlug: string | null) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: buSlug },
    });
    if (template || buSlug === null) return template;

    return this.prisma.emailTemplate.findFirst({
      where: { key, business_unit: null },
    });
  }

  private async resolveBranding(buSlug: string | null) {
    if (buSlug) {
      const branding = await this.prisma.emailBranding.findUnique({
        where: { business_unit: buSlug },
      });
      if (branding) {
        return {
          primaryColor: branding.primary_color,
          primaryColorHover: branding.secondary_color ?? '#013A4F',
          companyName: branding.company_name,
          logoUrl: branding.logo_url ?? undefined,
          buttonColor: branding.button_color ?? undefined,
          buttonTextColor: branding.button_text_color ?? undefined,
          layoutPreset: branding.layout_preset,
        };
      }
    }
    return {
      primaryColor: '#01546B',
      primaryColorHover: '#013A4F',
      companyName: 'MedVirtual',
      logoUrl: undefined,
      buttonColor: undefined,
      buttonTextColor: undefined,
      layoutPreset: 'default',
    };
  }

  // Merges optional per-request branding overrides (unsaved modal edits) on top of the
  // resolved DB/default branding. Uses `!== undefined` checks (not `??`) so an explicitly
  // sent empty string overrides to empty, while an absent field falls back to the saved value.
  private applyBrandingOverrides<
    T extends {
      primaryColor: string;
      primaryColorHover: string;
      companyName: string;
      logoUrl?: string;
      buttonColor?: string;
      buttonTextColor?: string;
      layoutPreset: string;
    },
  >(
    branding: T,
    overrides?: {
      primary_color?: string;
      secondary_color?: string;
      logo_url?: string;
      company_name?: string;
      layout_preset?: string;
      button_color?: string;
      button_text_color?: string;
    },
  ): T {
    if (!overrides) return branding;
    return {
      ...branding,
      ...(overrides.primary_color !== undefined && {
        primaryColor: overrides.primary_color,
      }),
      ...(overrides.secondary_color !== undefined && {
        primaryColorHover: overrides.secondary_color,
      }),
      ...(overrides.logo_url !== undefined && {
        logoUrl: overrides.logo_url,
      }),
      ...(overrides.company_name !== undefined && {
        companyName: overrides.company_name,
      }),
      ...(overrides.layout_preset !== undefined && {
        layoutPreset: overrides.layout_preset,
      }),
      ...(overrides.button_color !== undefined && {
        buttonColor: overrides.button_color,
      }),
      ...(overrides.button_text_color !== undefined && {
        buttonTextColor: overrides.button_text_color,
      }),
    };
  }

  private renderHtml(
    body: string,
    headline: string,
    branding: {
      primaryColor: string;
      primaryColorHover: string;
      companyName: string;
      logoUrl?: string;
      buttonColor?: string;
      buttonTextColor?: string;
      layoutPreset: string;
    },
    overrides?: Record<string, string>,
    buttonLabel?: string | null,
    buttonUrl?: string | null,
  ): string {
    const filledBody = this.applyPlaceholders(body, overrides);
    const filledHeadline = this.applyPlaceholders(headline, overrides);
    const filledButtonUrl = buttonUrl
      ? this.applyPlaceholders(buttonUrl, overrides)
      : buttonUrl;
    const filledButtonLabel = buttonLabel
      ? this.applyPlaceholders(buttonLabel, overrides)
      : buttonLabel;
    const logoUrl = getLogoUrl({
      logoUrl: branding.logoUrl,
      companyName: branding.companyName,
    });

    const htmlBody = filledBody.replace(/\n/g, '<br>');

    const buttonBackgroundColor = branding.buttonColor ?? branding.primaryColor;
    const buttonTextColor = branding.buttonTextColor ?? '#ffffff';

    const buttonHtml =
      filledButtonLabel && filledButtonUrl
        ? `<div style="text-align:left;margin:30px 0;">
        <a href="${filledButtonUrl}" class="cta-button">
          ${filledButtonLabel}
        </a>
       </div>`
        : '';

    // layout_preset is a raw Prisma String (not an enum), so any unrecognized/legacy
    // value safely falls back to the "default" structure.
    const knownPresets = ['default', 'minimal', 'hero'];
    const preset = knownPresets.includes(branding.layoutPreset)
      ? branding.layoutPreset
      : 'default';

    const headerHtml = this.renderHeaderForPreset(preset, branding, logoUrl);
    const inlineLogoHtml =
      preset === 'minimal'
        ? `<div class="logo">${getEmailLogoImg({
            logoUrl,
            companyName: branding.companyName,
          })}</div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${filledHeadline || branding.companyName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
    .email-wrapper { background-color: #f4f4f4; padding: 20px; min-height: 100vh; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
    .content { padding: 40px 30px; }${getEmailLogoCss()}
    .headline { color: #333333; font-size: 22px; font-weight: 700; margin-bottom: 20px; }
    .body-text { color: #333333; font-size: 16px; line-height: 1.6; margin-bottom: 20px; }
    .footer { border-top: 1px solid #e9ecef; padding: 20px 30px; margin-top: 30px; }
    .footer p { color: #666666; font-size: 13px; margin: 0; }
    .cta-button {
      display: inline-block;
      background-color: ${buttonBackgroundColor};
      color: ${buttonTextColor} !important;
      padding: 14px 28px;
      text-decoration: none;
      border-radius: 30px;
      font-weight: 600;
      font-size: 16px;
      transition: background-color 0.2s ease;
    }
    .cta-button:hover {
      background-color: ${branding.primaryColorHover};
      color: ${buttonTextColor} !important;
    }
    .cta-button:visited { color: ${buttonTextColor} !important; }
    .cta-button:link { color: ${buttonTextColor} !important; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="container">
      ${headerHtml}
      <div class="content">
        ${inlineLogoHtml}
        ${filledHeadline ? `<div class="headline">${filledHeadline}</div>` : ''}
        <div class="body-text">${htmlBody}</div>
        ${buttonHtml}
      </div>
      <div class="footer">
        <p>${branding.companyName} &copy; ${new Date().getFullYear()}. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  // Returns only the pre-content header section for the given layout preset — the
  // content/footer skeleton in renderHtml() stays identical across all presets.
  private renderHeaderForPreset(
    preset: string,
    branding: { primaryColor: string; companyName: string },
    logoUrl: string,
  ): string {
    const logoImg = getEmailLogoImg({
      logoUrl,
      companyName: branding.companyName,
    });

    switch (preset) {
      case 'minimal':
        // No banner section — the logo is rendered inline inside .content instead.
        return '';

      case 'hero':
        return `<div style="background:${branding.primaryColor}33;padding:48px 20px;text-align:center;">
        <div style="height:4px;width:64px;background:${branding.primaryColor};margin:0 auto 20px;border-radius:2px;"></div>
        <div style="display:inline-block;">${logoImg}</div>
      </div>`;

      case 'default':
      default:
        return `<div style="background:${branding.primaryColor};padding:30px 20px;text-align:center;">
        <div style="display:inline-block;">${logoImg}</div>
      </div>`;
    }
  }

  private async syncToPeer(
    key: string,
    template: {
      subject: string;
      headline?: string | null;
      body: string;
      button_label?: string | null;
      button_url?: string | null;
      category?: string | null;
      functionality?: string | null;
    },
    userId: string,
  ) {
    const peerUrl = process.env.PEER_ENV_API_URL;
    const secret = process.env.INTER_ENV_SYNC_SECRET;
    const currentEnv = process.env.ENVIRONMENT ?? 'DEV';

    if (!peerUrl || !secret) return;

    await fetch(`${peerUrl}/email-templates/${key}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Secret': secret,
        'X-Sync-Origin': currentEnv,
        'X-Sync-By': userId,
      },
      body: JSON.stringify({
        subject: template.subject,
        headline: template.headline,
        body: template.body,
        button_label: template.button_label,
        button_url: template.button_url,
        category: template.category,
        functionality: template.functionality,
      }),
    });

    this.logger.log(`Template "${key}" synced to peer (${peerUrl})`);
  }
}
