import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OfferPanelAuditSource,
  OfferPanelRecipientType,
  OrganizationStatus,
  USER,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  HubspotContactSummary,
  HubspotService,
} from '../hubspot/hubspot.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { OrganizationService } from '../organization/organization.service';
import { UpdateOrganizationDto } from '../organization/dto/updateOrganization.dto';
import { UserService } from '../user/user.service';
import {
  OfferPanelsAuditService,
  OFFER_PANEL_AUDIT_EVENTS,
  OFFER_PANEL_AUDIT_ORIGINS,
  buildActorLabel,
} from './offer-panels-audit.service';
import { AddRecipientAsUserDto } from './dto/add-recipient-as-user.dto';

const ORG_USER_ROLES = ['organization_admin', 'organization_super_admin'];

/**
 * Existing accounts in these states cannot receive offer panels, so the panel
 * must not be linked to them. Reactivating the user (Client Users) lifts the block.
 */
const UNLINKABLE_USER_STATUSES = ['inactive', 'deleted', 'suspended'];

export interface AddAsUserOrganization {
  id: string;
  name: string;
  status: OrganizationStatus;
  business_unit: string | null;
  hubspot_id: string | null;
  is_primary: boolean;
  will_activate: boolean;
}

interface ExistingUserSummary {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  organization: {
    id: string;
    name: string;
    business_unit: string | null;
  } | null;
}

/**
 * Result of resolving an offer panel recipient into "who would we invite, and
 * where". Discriminated on `status` — the frontend renders one state per value.
 */
export type AddAsUserPreview =
  | { status: 'panel_already_linked'; user_id: string | null }
  | {
      status: 'already_user';
      user: ExistingUserSummary;
      can_link: boolean;
      reason: string | null;
    }
  | { status: 'contact_not_found'; email: string }
  | { status: 'no_company'; contact: HubspotContactSummary }
  | {
      status: 'company_not_synced';
      contact: HubspotContactSummary;
      companies: { id: string; name: string | null; domain: string | null }[];
    }
  | {
      status: 'org_deleted';
      contact: HubspotContactSummary;
      organizations: AddAsUserOrganization[];
    }
  | {
      status: 'bu_mismatch';
      contact: HubspotContactSummary;
      panel_business_unit: string;
      organizations: AddAsUserOrganization[];
    }
  | {
      status: 'ready' | 'needs_selection';
      email: string;
      contact: HubspotContactSummary;
      organizations: AddAsUserOrganization[];
      /** Pre-selected org: the only match or the HubSpot primary. null → admin must pick. */
      suggested_organization_id: string | null;
    };

/**
 * "Add as user" for offer panels sent to a raw email / company contact.
 *
 * Resolution chain: panel recipient_email → HubSpot contact → associated
 * companies → our Organization rows (by hubspot_id). The preview is read-only;
 * the execute path re-runs the same resolution server-side so a stale or
 * tampered client selection can never invite into an unrelated organization.
 */
@Injectable()
export class OfferPanelRecipientInviteService {
  private readonly logger = new Logger(OfferPanelRecipientInviteService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => HubspotService))
    private readonly hubspot: HubspotService,
    private readonly businessUnitContext: BusinessUnitContext,
    @Inject(forwardRef(() => OrganizationService))
    private readonly organizationService: OrganizationService,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    private readonly panelAudit: OfferPanelsAuditService,
  ) {}

  async preview(panelId: string): Promise<AddAsUserPreview> {
    return (await this.resolve(panelId)).preview;
  }

  async addAsUser(
    panelId: string,
    dto: AddRecipientAsUserDto,
    actor: USER,
  ): Promise<{
    user: { id: string; email: string; first_name: string; last_name: string };
    organization: { id: string; name: string };
    activated: boolean;
  }> {
    const { panel, preview, localContactId } = await this.resolve(panelId);

    if (preview.status !== 'ready' && preview.status !== 'needs_selection') {
      throw new BadRequestException(blockedMessage(preview));
    }

    const org = preview.organizations.find((o) => o.id === dto.organization_id);
    if (!org) {
      throw new BadRequestException(
        "The selected organization is not associated with this contact's HubSpot companies",
      );
    }

    // Activate first: inviteUserToOrganization rejects inactive organizations.
    let activated = false;
    if (org.status === OrganizationStatus.inactive) {
      // update() with only `status` runs the standard reactivation path: restores
      // users deactivated with the org, writes their audit entries, syncs HubSpot.
      await this.organizationService.update(
        org.id,
        { status: OrganizationStatus.active } as UpdateOrganizationDto,
        actor.id,
      );
      activated = true;
    }

    try {
      await this.userService.inviteUserToOrganization(
        org.id,
        {
          email: panel.recipient_email,
          first_name: dto.first_name.trim(),
          last_name: dto.last_name.trim(),
          job_title: dto.job_title?.trim() || undefined,
          phone: dto.phone?.trim() || undefined,
          role: dto.role,
          contact_id: localContactId ?? undefined,
        },
        actor,
        { existingHubspotContactId: preview.contact.id },
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to invite user';
      if (activated) {
        // The activation already committed and is a legitimate outcome on its own —
        // say so rather than implying nothing happened.
        throw new BadRequestException(
          `${org.name} was activated, but the invite failed: ${message}`,
        );
      }
      throw err;
    }

    const newUser = await this.prisma.uSER.findFirst({
      where: {
        email: { equals: panel.recipient_email.trim(), mode: 'insensitive' },
      },
      select: { id: true, email: true, first_name: true, last_name: true },
    });
    if (!newUser) {
      // inviteUserToOrganization returned without throwing, so this is unreachable
      // in practice — guard anyway rather than relinking to nothing.
      throw new BadRequestException('Invited user could not be found');
    }

    await this.relinkPanel(panel, newUser, org);

    await this.panelAudit.log({
      offerPanelId: panel.id,
      actorUserId: actor.id,
      actorLabel: buildActorLabel(actor),
      event: OFFER_PANEL_AUDIT_EVENTS.RECIPIENT_INVITED_AS_USER,
      source: OfferPanelAuditSource.user,
      before: {
        recipient_type: panel.recipient_type,
        recipient_user_id: panel.recipient_user_id,
        recipient_company_id: panel.recipient_company_id,
      },
      after: {
        recipient_type: OfferPanelRecipientType.client_user,
        recipient_user_id: newUser.id,
        recipient_company_id: org.id,
      },
      metadata: {
        origin: OFFER_PANEL_AUDIT_ORIGINS.ADMIN_ADD_AS_USER,
        recipientEmail: panel.recipient_email,
        organization_id: org.id,
        organization_name: org.name,
        hubspot_contact_id: preview.contact.id,
        organization_activated: activated,
        role: dto.role,
      },
    });

    return {
      user: newUser,
      organization: { id: org.id, name: org.name },
      activated,
    };
  }

  /** Recipient already has a user account → relink the panel, no invite. */
  async linkExistingUser(
    panelId: string,
    actor: USER,
  ): Promise<{ user_id: string; organization_id: string }> {
    const { panel, preview } = await this.resolve(panelId);
    if (preview.status !== 'already_user') {
      throw new BadRequestException(
        'The recipient does not have a user account yet',
      );
    }
    if (!preview.can_link || !preview.user.organization) {
      throw new BadRequestException(
        preview.reason ?? 'This user cannot be linked to the panel',
      );
    }

    const org = preview.user.organization;
    await this.relinkPanel(panel, preview.user, org);

    await this.panelAudit.log({
      offerPanelId: panel.id,
      actorUserId: actor.id,
      actorLabel: buildActorLabel(actor),
      event: OFFER_PANEL_AUDIT_EVENTS.RECIPIENT_LINKED_TO_USER,
      source: OfferPanelAuditSource.user,
      before: {
        recipient_type: panel.recipient_type,
        recipient_user_id: panel.recipient_user_id,
        recipient_company_id: panel.recipient_company_id,
      },
      after: {
        recipient_type: OfferPanelRecipientType.client_user,
        recipient_user_id: preview.user.id,
        recipient_company_id: org.id,
      },
      metadata: {
        origin: OFFER_PANEL_AUDIT_ORIGINS.ADMIN_ADD_AS_USER,
        recipientEmail: panel.recipient_email,
        organization_id: org.id,
        organization_name: org.name,
      },
    });

    return { user_id: preview.user.id, organization_id: org.id };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async resolve(panelId: string) {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: {
        id: true,
        recipient_type: true,
        recipient_user_id: true,
        recipient_company_id: true,
        recipient_email: true,
        business_unit: true,
      },
    });
    if (!panel) throw new NotFoundException('Offer panel not found');

    const done = (
      preview: AddAsUserPreview,
      localContactId?: string | null,
    ) => ({
      panel,
      preview,
      localContactId: localContactId ?? null,
    });

    if (
      panel.recipient_type === OfferPanelRecipientType.client_user ||
      panel.recipient_user_id
    ) {
      return done({
        status: 'panel_already_linked',
        user_id: panel.recipient_user_id,
      });
    }

    const email = panel.recipient_email.toLowerCase().trim();

    // USER.email is globally unique, so an existing account (any role, any org)
    // means we can never invite this address — at most relink the panel.
    const existing = await this.prisma.uSER.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        role: true,
        status: true,
        organization: {
          select: { id: true, name: true, business_unit: true, status: true },
        },
      },
    });
    if (existing) {
      const reason = await this.linkBlockReason(existing, panel.business_unit);
      return done({
        status: 'already_user',
        user: {
          id: existing.id,
          email: existing.email,
          first_name: existing.first_name,
          last_name: existing.last_name,
          role: existing.role,
          status: existing.status,
          organization: existing.organization
            ? {
                id: existing.organization.id,
                name: existing.organization.name,
                business_unit: existing.organization.business_unit,
              }
            : null,
        },
        can_link: reason === null,
        reason,
      });
    }

    const contact = await this.hubspotCall(() =>
      this.hubspot.findContactByEmail(email),
    );
    if (!contact) return done({ status: 'contact_not_found', email });

    const associations = await this.hubspotCall(() =>
      this.hubspot.getContactCompanyAssociations(contact.id),
    );
    if (associations.length === 0) {
      return done({ status: 'no_company', contact });
    }

    const primaryIds = new Set(
      associations.filter((a) => a.isPrimary).map((a) => a.companyId),
    );
    const orgRows = await this.prisma.organization.findMany({
      where: { hubspot_id: { in: associations.map((a) => a.companyId) } },
      select: {
        id: true,
        name: true,
        status: true,
        business_unit: true,
        hubspot_id: true,
      },
      orderBy: { name: 'asc' },
    });

    if (orgRows.length === 0) {
      let companies = associations.map((a) => ({
        id: a.companyId,
        name: null as string | null,
        domain: null as string | null,
      }));
      try {
        const summaries = await this.hubspot.getCompanySummaries(
          associations.map((a) => a.companyId),
        );
        if (summaries.length > 0) companies = summaries;
      } catch (err) {
        // Names are only for the message; ids are enough to act on.
        this.logger.warn(
          `Could not load HubSpot company names for contact ${contact.id}: ${(err as Error).message}`,
        );
      }
      return done({ status: 'company_not_synced', contact, companies });
    }

    const organizations: AddAsUserOrganization[] = orgRows.map((o) => ({
      ...o,
      is_primary: !!o.hubspot_id && primaryIds.has(o.hubspot_id),
      will_activate: o.status === OrganizationStatus.inactive,
    }));

    const live = organizations.filter(
      (o) => o.status !== OrganizationStatus.deleted,
    );
    if (live.length === 0) {
      return done({ status: 'org_deleted', contact, organizations });
    }

    const sameBu: AddAsUserOrganization[] = [];
    for (const org of live) {
      if (await this.sameBusinessUnit(org.business_unit, panel.business_unit)) {
        sameBu.push(org);
      }
    }
    if (sameBu.length === 0) {
      return done({
        status: 'bu_mismatch',
        contact,
        panel_business_unit: panel.business_unit,
        organizations: live,
      });
    }

    const primaries = sameBu.filter((o) => o.is_primary);
    const suggested =
      sameBu.length === 1
        ? sameBu[0].id
        : primaries.length === 1
          ? primaries[0].id
          : null;

    // A local Contact row mirroring this HubSpot contact gets linked to the new user.
    const localContact = await this.prisma.contact.findUnique({
      where: { hubspot_id: contact.id },
      select: { id: true, user_id: true },
    });

    return done(
      {
        status: suggested ? 'ready' : 'needs_selection',
        email,
        contact,
        organizations: sameBu,
        suggested_organization_id: suggested,
      },
      localContact && !localContact.user_id ? localContact.id : null,
    );
  }

  /**
   * Relinks the panel to the (new or existing) user. Guarded on
   * recipient_user_id IS NULL so two concurrent requests cannot both relink.
   * The public token is kept — the link already emailed must keep working.
   */
  private async relinkPanel(
    panel: { id: string },
    user: { id: string; first_name: string | null; last_name: string | null },
    org: { id: string; name: string },
  ): Promise<void> {
    const name = [user.first_name, user.last_name]
      .filter((p): p is string => !!p && !!p.trim())
      .join(' ');

    const result = await this.prisma.offerPanel.updateMany({
      where: { id: panel.id, recipient_user_id: null },
      data: {
        recipient_type: OfferPanelRecipientType.client_user,
        recipient_user_id: user.id,
        recipient_company_id: org.id,
        recipient_org_name: org.name,
        ...(name && { recipient_name: name }),
      },
    });
    if (result.count === 0) {
      throw new BadRequestException(
        'This offer panel was already linked to a user',
      );
    }

    // A panel accepted through the public link before the org was known created a
    // ticket with no organization — attach it now.
    await this.prisma.ticket.updateMany({
      where: { offer_panel_id: panel.id, org_id: null },
      data: { org_id: org.id },
    });
  }

  private async linkBlockReason(
    user: {
      role: string;
      status: string;
      organization: {
        business_unit: string | null;
        status: OrganizationStatus;
      } | null;
    },
    panelBusinessUnit: string,
  ): Promise<string | null> {
    if (!ORG_USER_ROLES.includes(user.role) || !user.organization) {
      return 'This email belongs to a non-client account (system or affiliate user) and cannot added as user';
    }
    if (UNLINKABLE_USER_STATUSES.includes(user.status)) {
      return `This email already has a user account with status "${user.status}". Reactivate it in Client Users before sending offers to it`;
    }
    if (user.organization.status === OrganizationStatus.deleted) {
      return "This user's organization has been deleted";
    }
    if (
      !(await this.sameBusinessUnit(
        user.organization.business_unit,
        panelBusinessUnit,
      ))
    ) {
      return `This user's organization belongs to a different business unit (${user.organization.business_unit})`;
    }
    return null;
  }

  /**
   * Compares an org BU against the panel BU. Both are resolved through the
   * BusinessUnit table (hubspot_value / name / slug) so aliases like
   * "Med Virtual" vs "MedVirtual" match. Orgs with no BU are legacy MedVirtual
   * rows and are not blocked.
   */
  private async sameBusinessUnit(
    orgBu: string | null,
    panelBu: string,
  ): Promise<boolean> {
    if (!orgBu) return true;
    const [a, b] = await Promise.all([
      this.businessUnitContext.resolveByHubspotValue(orgBu),
      this.businessUnitContext.resolveByHubspotValue(panelBu),
    ]);
    if (a && b) return a.slug === b.slug;
    return (
      this.businessUnitContext.normalizeBusinessUnit(orgBu) ===
      this.businessUnitContext.normalizeBusinessUnit(panelBu)
    );
  }

  private async hubspotCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // The SDK error can carry request details — log the message only and never
      // echo it to the client.
      this.logger.error(
        `HubSpot lookup failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      throw new ServiceUnavailableException(
        'HubSpot is unavailable right now. Please try again in a moment.',
      );
    }
  }
}

function blockedMessage(preview: AddAsUserPreview): string {
  switch (preview.status) {
    case 'panel_already_linked':
      return 'This offer panel is already linked to a user';
    case 'already_user':
      return 'A user with this email already exists';
    case 'contact_not_found':
      return 'No HubSpot contact exists with this email';
    case 'no_company':
      return 'The HubSpot contact is not associated with any company';
    case 'company_not_synced':
      return "The contact's HubSpot company is not synced to the platform yet";
    case 'org_deleted':
      return "The contact's organization has been deleted";
    case 'bu_mismatch':
      return "The contact's organization belongs to a different business unit";
    default:
      return 'This recipient cannot be added as a user';
  }
}
