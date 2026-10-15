import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import {
  buildConfigMap,
  computeCandidateRates,
  CandidatePool,
} from '../common/utils/salary.util';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { changeLabelAvailability } from '../common/utils/hubspot.util';
import { dbToStageDictionary } from '../common/dictionaries/stage-dictionary';
import { getApprovedPositionLabel } from '../common/dictionaries/approved-positions-pairing-dictionary';
import { OfferPanelEmailCandidate } from '../common/utils/email-templates/offer-panel-candidate-cards';
import { renderOfferPanelCandidateCardsShowcase } from '../common/utils/email-templates/offer-panel-candidate-cards-showcase';
import {
  getUserEmailTheme,
  getBusinessUnitEmailTheme,
  orgBusinessUnitToSlug,
} from '../common/utils/email-templates/theme-helper';
import { ticketTypeReverseDictionary } from '../common/dictionaries/ticket-type';
import {
  getEmailThemeByBusinessUnit,
  EmailTheme,
} from '../common/utils/email-templates/theme';
import {
  getEmailLogoCss,
  getEmailLogoImg,
} from '../common/utils/email-templates/components';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { FRONTEND_ROUTES } from '../common/utils/frontend-routes';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailTemplates: EmailTemplatesService,
    private readonly positionRateConfig: PositionRateConfigService,
    private readonly businessUnitContext: BusinessUnitContext,
  ) {}

  // ── EmailTemplatesService fallback helper ─────────────────────────────────
  // Tries to load the template from the DB; returns { subject, html } if found,
  // or null if not — allowing each method to fall back to buildEmail().
  private async getTplContent(
    key: string,
    runtimeValues: Record<string, string>,
    theme: ReturnType<typeof getEmailThemeByBusinessUnit> | null,
    businessUnit?: string | null,
  ): Promise<{ subject: string; html: string } | null> {
    try {
      if (!theme) return null;
      // Callers pass the Organization/OfferPanel display value ("MedVirtual" /
      // "Berry Virtual"), but EmailTemplate.business_unit is stored as a slug.
      // Convert before the lookup so a BU-scoped template can actually match;
      // getTemplateContent falls back to the global (null) row when none exists.
      const businessUnitSlug = orgBusinessUnitToSlug(businessUnit ?? null);
      return await this.emailTemplates.getTemplateContent(
        key,
        runtimeValues,
        theme,
        businessUnitSlug,
      );
    } catch {
      return null;
    }
  }

  // Helper function to decode HTML entities
  private decodeHtmlEntities = (text: string): string => {
    if (!text) return '';
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&#x2f;/g, '/')
      .replace(/&#47;/g, '/');
  };

  /**
   *
   * Builds the correct ticket detail URL based on user role
   * Clients (organization admins) open the ticket in their profile, system admins in the tickets board
   */
  private getTicketDetailUrl(ticketId: string, userRole?: string): string {
    const isClient =
      userRole === 'organization_admin' ||
      userRole === 'organization_super_admin';
    const path = isClient
      ? FRONTEND_ROUTES.profile
      : FRONTEND_ROUTES.adminTickets;
    return `${process.env.FRONTEND_URL}${path}?ticket=${ticketId}`;
  }

  private buildEmail(
    htmlInner: string,
    theme?: Partial<EmailTheme> | null,
    greeting?: string,
    closing?: string,
  ): string {
    const primaryColor = theme?.primaryColor || '#01546B';
    const companyName = theme?.companyName || 'MedVirtual';
    // Honor the saved custom design (EmailBranding) in the fallback too, so the
    // CTA button matches what getTemplateContent/renderHtml would produce.
    const buttonColor = theme?.buttonColor || primaryColor;
    const buttonTextColor = theme?.buttonTextColor || '#ffffff';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${companyName} Notification</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    .email-wrapper {
      background-color: #f4f4f4;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }
    .content {
      padding: 40px 30px;
    }
${getEmailLogoCss()}
    .greeting {
      color: #333333;
      font-size: 16px;
      margin-bottom: 20px;
    }
    .main-message {
      color: #333333;
      font-size: 16px;
      line-height: 1.5;
      margin-bottom: 30px;
    }
    .cta-button {
      display: inline-block;
      background-color: ${buttonColor};
      color: ${buttonTextColor} !important;
      padding: 14px 28px;
      text-decoration: none;
      border-radius: 30px;
      font-weight: 600;
      font-size: 16px;
      margin: 20px 0;
      transition: background-color 0.2s ease;
    }
    .cta-button:hover {
      background-color: ${theme?.primaryColorHover || '#013A4F'};
      color: ${buttonTextColor} !important;
    }
    .cta-button:visited {
      color: ${buttonTextColor} !important;
    }
    .cta-button:link {
      color: ${buttonTextColor} !important;
    }
    .closing {
      color: #333333;
      font-size: 16px;
      margin: 30px 0 10px 0;
    }
    .sender {
      color: #333333;
      font-size: 16px;
    }
    .footer {
      border-top: 1px solid #e9ecef;
      padding: 20px 30px;
      margin-top: 30px;
    }
    .footer-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .support-text {
      color: #666666;
      font-size: 14px;
      margin: 0;
    }
    .support-email {
      color: ${primaryColor};
      text-decoration: none;
      font-size: 14px;
    }
    .support-email-highlight {
      background-color: #fff3cd;
      padding: 1px 3px;
      border-radius: 2px;
    }
    
  </style>
</head>

<body>
  <div class="email-wrapper">
    <div class="container">
      <div class="content">
        <div class="logo">
              ${getEmailLogoImg(theme)}
        </div>
      
      <div class="greeting">${greeting ?? 'Hi,'}</div>
      
      <div class="main-message">
        ${htmlInner}
      </div>
      
      <div class="closing">${closing ?? 'Best,'}</div>
      <div class="sender">
        <strong>${companyName}</strong> team
      </div>
    </div>
    
    
  </div>
</body>
</html>`;
  }

  async notifyHireRequestPlacementCompleted(
    hireRequestId: string,
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        createdBy: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        assign_user_id: true,
        assigned_sourcing: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        organization: {
          select: { name: true, business_unit: true },
        },
        panels: {
          select: {
            id: true,
            panelCandidates: {
              where: { status: 'selected_by_client' }, //get all selected candidates since right now we can have mmore than one
              select: {
                candidate: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    name: true,
                    country: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const userIds = hr?.assign_user_id
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });

    if (!users || users.length === 0 || !users[0].email)
      throw new BadRequestException('Hire request has no assignee email');

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;
    const salaryRange =
      hr.salary_range_from && hr.salary_range_to
        ? `$${hr.salary_range_from} - $${hr.salary_range_to}`
        : 'Not specified';
    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    // Get winner candidate name
    const winners =
      hr.panels?.[0]?.panelCandidates.length > 0
        ? hr.panels?.[0].panelCandidates
            .map(
              (pa) =>
                `<p><div style='margin-left:3px; border-radius:8px; background-color:#CCC; padding:3px;'>
        <strong>${pa.candidate.name || `${pa.candidate.first_name || ''} ${pa.candidate.last_name || ''}`.trim()}</strong><br/>
        Location: <strong>${pa.candidate.country || 'Location not specified'}</strong>
        </div></p>`,
            )
            .join('')
        : '';
    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const recipients = [
      ...users.map((user) => user.email),
      hr.assigned_sourcing?.email,
      hr.createdBy?.email,
    ].filter((email): email is string => Boolean(email));

    if (recipients.length === 0) {
      throw new BadRequestException('No valid recipient emails found');
    }

    const fallbackHtml = this.buildEmail(
      `<h2>Placement Completed</h2>
      <p>The hire request has been marked as <strong>placement completed</strong>.</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
         <p><strong>Salary Range:</strong> ${salaryRange}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
         <p><strong>Selected Candidates:</strong> </p>
         ${winners}
       </div>

        <p>Please proceed with onboarding steps.</p>
        <div style="text-align: left; margin: 30px 0;">
          <a href="${detailUrl}" class="cta-button">
            View Hire Request Details
          </a>
        </div>`,
      emailTheme,
    );

    const tpl = await this.getTplContent(
      'hr-placement-completed',
      {
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{salaryRange}}': salaryRange,
        '{{startDate}}': startDate,
        '{{selectedCandidates}}':
          hr.panels?.[0]?.panelCandidates
            ?.map(
              (pc) =>
                pc.candidate.name ||
                `${pc.candidate.first_name || ''} ${pc.candidate.last_name || ''}`.trim(),
            )
            .join(', ') || '',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: recipients,
      subject: tpl?.subject ?? `Placement completed: ${hr.title}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyInterviewScheduled(hireRequestId: string): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        hubspot_role_type: true,
        availability: true,
        assign_user_id: true,
        organization: {
          select: { name: true, id: true, business_unit: true },
        },
        panels: {
          select: {
            id: true,
            interviews: {
              select: {
                id: true,
                scheduled_date: true,
                link: true,
              },
            },
            panelCandidates: {
              select: {
                candidate: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    name: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const userIds = hr?.assign_user_id
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });
    if (!users || users.length === 0 || !users[0].email)
      throw new BadRequestException('Hire request has no assignee email');

    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    // Get the link and date of the scheduled interview
    const interviewDate = hr.panels?.[0]?.interviews?.[0]?.scheduled_date;
    const interviewLink = hr.panels?.[0]?.interviews?.[0]?.link || '#';
    const interviewDateFormatted = interviewDate
      ? new Date(interviewDate).toLocaleString()
      : 'Not specified';

    const bodyLine =
      interviewLink !== '#'
        ? `<p><strong>Pairing Link:</strong> <a href="${interviewLink}">${interviewLink}</a></p>`
        : '';
    // Plain-text line for the DB template body (rendered through renderHtml's
    // \n→<br>). Empty when there is no link, so the line disappears entirely.
    const pairingLinkLine =
      interviewLink !== '#' ? `Pairing Link: ${interviewLink}` : '';
    // CTA fallback: with a link → "Join meeting" to the pairing URL; without a
    // link → send the user to the platform login so they still have a next step.
    const hasLink = interviewLink !== '#';
    const ctaLabel = hasLink ? 'Join meeting' : 'Go to platform';
    const ctaUrl = hasLink
      ? interviewLink
      : `${process.env.FRONTEND_URL}/login`;
    const bodyLink = `<div style="text-align: left; margin: 30px 0;">
          <a href="${ctaUrl}" class="cta-button">
            ${ctaLabel}
          </a>
        </div>`;

    //get all users from organization for send emails to them
    const emailsUsers = await this.prisma.uSER.findMany({
      where: {
        organization_id: hr.organization.id,
        status: 'active',
      },
      select: {
        email: true,
      },
    });

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtml = this.buildEmail(
      `<p>You have been invited to an <strong>Interview</strong>.</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Position Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Company:</strong> ${hr.organization.name}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
         <p><strong>Pairing Date:</strong> ${interviewDateFormatted}</p>
         ${bodyLine}
       </div>

       ${bodyLink}`,
      emailTheme,
    );
    const tpl = await this.getTplContent(
      'hr-interview-scheduled',
      {
        '{{roleType}}': hr.hubspot_role_type || '',
        '{{availability}}': hr.availability || '',
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{startDate}}': startDate,
        '{{interviewDate}}': interviewDateFormatted,
        '{{pairingLinkLine}}': pairingLinkLine,
        // The button always renders now: pairing link when present, else the
        // platform login as a fallback so the email is never a dead end.
        '{{ctaLabel}}': ctaLabel,
        '{{ctaUrl}}': ctaUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );
    return await this.mail.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: emailsUsers.map((u) => u.email),
      subject:
        tpl?.subject ??
        `Interview Invite: ${hr.hubspot_role_type} - ${hr.availability}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyHireRequestClientChange(
    hireRequestId: string,
    action: 'edited' | 'canceled',
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        assign_user_id: true,
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const userIds = hr?.assign_user_id
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });
    if (!users || users.length === 0 || !users[0].email)
      throw new BadRequestException('Hire request has no assignee email');

    const verb = action === 'edited' ? 'edited' : 'canceled';
    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtml = this.buildEmail(
      `<h2>Hire Request ${verb.toUpperCase()}</h2>
       <p>The hire request was ${verb} by the client.</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
       </div>

       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );
    const tpl = await this.getTplContent(
      'hr-client-change',
      {
        '{{action}}': verb,
        '{{actionUpper}}': verb.toUpperCase(),
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: users.map((user) => user.email),
      subject: tpl?.subject ?? `Hire Request ${verb}: ${hr.title}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyHireRequestSourcingAssignee(
    hireRequestId: string,
    action: 'sourcing',
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        assigned_sourcing: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    if (!hr.assigned_sourcing?.email)
      throw new BadRequestException('Hire request has no assignee email');

    const verb = action;
    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const assigneeName =
      `${hr.assigned_sourcing.first_name ?? ''} ${hr.assigned_sourcing.last_name ?? ''}`.trim();
    const fallbackHtml = this.buildEmail(
      `<p>${assigneeName}</p>
       <p>The hire request was updated to Start to sourcing stage.</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
       </div>

       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );
    const tpl = await this.getTplContent(
      'hr-sourcing-assigned',
      {
        '{{assigneeName}}': assigneeName,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [hr.assigned_sourcing.email],
      subject: tpl?.subject ?? `Hire Request ${verb}: ${hr.title}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyHireRequestConciergeAssigned(
    hireRequestId: string,
    action: 'for_review',
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        assign_user_id: true,
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const userIds = hr?.assign_user_id
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });
    if (!users || users.length === 0 || !users[0].email)
      throw new BadRequestException('Hire request has no assignee email');

    const verb = action === 'for_review' ? 'For Review' : action;
    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const conciergeAssigneeName = users[0].first_name ?? '';
    const fallbackHtml = this.buildEmail(
      `<p>${conciergeAssigneeName}</p>
       <p><strong>Hire Request Ready For Review</strong></p>
       <p>This request requires your attention:</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
       </div>

       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );
    const tpl = await this.getTplContent(
      'hr-concierge-assigned',
      {
        '{{assigneeName}}': conciergeAssigneeName,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: users.map((user) => user.email).filter(Boolean),
      subject: tpl?.subject ?? `Hire Request ${verb}: ${hr.title}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyHireRequestCreated(
    hireRequestId: string,
    type?: string,
    from?: string,
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        availability: true,
        assign_user_id: true,
        assigned_sourcing: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        assigned_staffing: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');

    let userIds: string[] = [];
    if (type === 'sourcing') {
      if (!hr.assigned_sourcing?.email)
        throw new BadRequestException('Hire request has no assignee email');
      userIds = [hr.assigned_sourcing.id];
    } else if (type === 'staffing_coordinator') {
      if (!hr.assigned_staffing?.email)
        throw new BadRequestException('Hire request has no assignee email');
      userIds = [hr.assigned_staffing.id];
    } else {
      if (!hr.assign_user_id)
        throw new BadRequestException('Hire request has no assignee');
      userIds = hr.assign_user_id
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    }
    if (userIds.length === 0)
      throw new BadRequestException('No valid user IDs to notify');

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });
    const emails = users.map((u) => u.email).filter(Boolean);
    if (emails.length === 0)
      throw new BadRequestException('No assignee emails found');

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;
    const salaryRange =
      hr.salary_range_from && hr.salary_range_to
        ? `$${hr.salary_range_from} - $${hr.salary_range_to}`
        : 'Not specified';
    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtml = this.buildEmail(
      `<p>${users.map((u) => `${u.first_name || ''} ${u.last_name || ''}`).join(', ')}</p>
      ${type === 'sourcing' ? `<p><strong>Sourcing Assignment to a Hire Request</strong></p>` : type === 'staffing_coordinator' ? `<p><strong>Staffing Coordinator Assignment to a Hire Request</strong></p>` : `<p><strong>Assignment to a Hire Request</strong></p>`}
       <p>You have been assigned ${type === 'sourcing' ? `to source` : type === 'staffing_coordinator' ? `as a staffing coordinator` : `to`} this hire request:</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
         <p><strong>Availability:</strong> ${hr.availability}</p>
         <p><strong>Salary Range:</strong> ${salaryRange}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
         <p><strong>Status:</strong> ${hr.status}</p>
       </div>

       <p>Please review the details and take appropriate action.</p>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>
       ${from === 'panel_request_flow' ? `<p>This hire request was created from Panel Request Flow.</p>` : ''}`,
      emailTheme,
    );
    const assignmentType =
      type === 'sourcing'
        ? 'Sourcing Assignment to a Hire Request'
        : type === 'staffing_coordinator'
          ? 'Staffing Coordinator Assignment to a Hire Request'
          : 'Assignment to a Hire Request';
    const assignmentRole =
      type === 'sourcing'
        ? 'to source'
        : type === 'staffing_coordinator'
          ? 'as a staffing coordinator'
          : 'to';
    const tpl = await this.getTplContent(
      'hr-created',
      {
        '{{assigneeName}}': users
          .map((u) => `${u.first_name || ''} ${u.last_name || ''}`)
          .join(', '),
        '{{assignmentType}}': assignmentType,
        '{{assignmentRole}}': assignmentRole,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{availability}}': hr.availability || '',
        '{{salaryRange}}': salaryRange,
        '{{startDate}}': startDate,
        '{{hrStatus}}': hr.status || '',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: emails,
      subject: tpl?.subject ?? `Hire Request Assigned: ${hr.title}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyHireRequestBackToSourcing(
    hireRequestId: string,
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        availability: true,
        assign_user_id: true,
        assigned_sourcing: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const destin = hr.assigned_sourcing;

    if (!destin?.email)
      throw new BadRequestException('Hire request has no assignee email');

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;
    const salaryRange =
      hr.salary_range_from && hr.salary_range_to
        ? `$${hr.salary_range_from} - $${hr.salary_range_to}`
        : 'Not specified';
    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtml = this.buildEmail(
      `<p>${destin.first_name && destin.first_name} ${destin.last_name && destin.last_name}</p>
       <p><strong>Back to sourcing</strong></p>
       <p>A hire request requires your attention since it has been put back to sourcing:</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
         <p><strong>Availability:</strong> ${hr.availability}</p>
         <p><strong>Salary Range:</strong> ${salaryRange}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
         <p><strong>Status:</strong> ${hr.status}</p>
       </div>

       <p>Please review the details and take appropriate action.</p>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );
    const backToSourcingName =
      `${destin.first_name || ''} ${destin.last_name || ''}`.trim();
    const tplBTS = await this.getTplContent(
      'hr-back-to-sourcing',
      {
        '{{assigneeName}}': backToSourcingName,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{availability}}': hr.availability || '',
        '{{salaryRange}}': salaryRange,
        '{{startDate}}': startDate,
        '{{hrStatus}}': hr.status || '',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [destin.email],
      subject: tplBTS?.subject ?? `Hire Request Assigned: ${hr.title}`,
      html: tplBTS?.html ?? fallbackHtml,
    });
  }

  async notifyClientPanelReady(hireRequestId: string): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        availability: true,
        organization: {
          select: {
            id: true,
            name: true,
            business_unit: true,
          },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');

    const orgUsers = await this.prisma.uSER.findMany({
      where: {
        organization_id: hr.organization.id,
        status: 'active',
      },
      select: { email: true },
    });

    const emails = orgUsers.map((u) => u.email).filter(Boolean);
    if (emails.length === 0)
      throw new BadRequestException(
        'No active organization users found to notify',
      );

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;
    const salaryRange =
      hr.salary_range_from && hr.salary_range_to
        ? `$${hr.salary_range_from} - $${hr.salary_range_to}`
        : 'Not specified';
    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtmlPanelClient = this.buildEmail(
      `<p><strong>Your candidate panel is ready for review!</strong></p>
       <p>The panel for the following hire request has been reviewed and is now ready for your follow-up:</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
         <p><strong>Availability:</strong> ${hr.availability}</p>
         <p><strong>Salary Range:</strong> ${salaryRange}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
       </div>

       <p>Please review the details and candidates within this panel.</p>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Candidates
         </a>
       </div>`,
      emailTheme,
    );
    const tplPanelClient = await this.getTplContent(
      'hr-panel-ready-client',
      {
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{availability}}': hr.availability || '',
        '{{salaryRange}}': salaryRange,
        '{{startDate}}': startDate,
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: emails,
      subject:
        tplPanelClient?.subject ?? `Your candidate panel is ready: ${hr.title}`,
      html: tplPanelClient?.html ?? fallbackHtmlPanelClient,
    });
  }

  async notifyHireRequestPanelReady(hireRequestId: string): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        availability: true,
        assign_user_id: true,
        assigned_sourcing: {
          select: { id: true, email: true, first_name: true, last_name: true },
        },
        organization: {
          select: {
            name: true,
            business_unit: true,
          },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const destin = hr.assigned_sourcing;

    if (!destin?.email)
      throw new BadRequestException('Hire request has no assignee email');

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;
    const salaryRange =
      hr.salary_range_from && hr.salary_range_to
        ? `$${hr.salary_range_from} - $${hr.salary_range_to}`
        : 'Not specified';
    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    // Get email theme by organization business unit
    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const panelReadyName =
      `${destin.first_name || ''} ${destin.last_name || ''}`.trim();
    const fallbackHtmlPanelInternal = this.buildEmail(
      `<p>${panelReadyName}</p>
       <p><strong>Panel Ready</strong></p>
       <p>The panel of the following hire request has been reviewed and now it is ready:</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
         <p><strong>Availability:</strong> ${hr.availability}</p>
         <p><strong>Salary Range:</strong> ${salaryRange}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
         <p><strong>Status:</strong> ${hr.status}</p>
       </div>

       <p>Please review the details and take appropriate action.</p>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );
    const tplPanelInternal = await this.getTplContent(
      'hr-panel-ready-internal',
      {
        '{{assigneeName}}': panelReadyName,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{availability}}': hr.availability || '',
        '{{salaryRange}}': salaryRange,
        '{{startDate}}': startDate,
        '{{hrStatus}}': hr.status || '',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization?.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [destin.email],
      subject:
        tplPanelInternal?.subject ?? `Panel Reviewed and Ready: ${hr.title}`,
      html: tplPanelInternal?.html ?? fallbackHtmlPanelInternal,
    });
  }

  async notifyEndorseCandidates(hireRequestId: string): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        assign_user_id: true,
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');
    const userIds = hr?.assign_user_id
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });
    if (!users || users.length === 0 || !users[0].email)
      throw new BadRequestException('Hire request has no assignee email');

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const endorseName =
      `${users[0].first_name || ''} ${users[0].last_name || ''}`.trim();
    const fallbackHtmlEndorse = this.buildEmail(
      `<p>${endorseName}</p>
       <p>The hire request received new candidates.</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
       </div>

       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );
    const tplEndorse = await this.getTplContent(
      'hr-candidates-endorsed',
      {
        '{{assigneeName}}': endorseName,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: users.map((user) => user.email),
      subject:
        tplEndorse?.subject ?? `New candidates in Hire Request: ${hr.title}`,
      html: tplEndorse?.html ?? fallbackHtmlEndorse,
    });
  }

  // Fires when the 48h panel-candidate minimum lead-time rule blocks an
  // organization user from adding candidates to a panel. Best-effort side
  // effect from inside a blocking validation path — must never throw, so the
  // caller's BadRequestException always reaches the user unaffected.
  async notifyPanelCandidateBlocked(
    hireRequestId: string,
    attemptedByUserId: string,
    candidateIds: string[],
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        assign_user_id: true,
        organization: {
          select: { name: true, business_unit: true },
        },
      },
    });
    if (!hr) throw new NotFoundException('Hire request not found');

    const userIds = hr?.assign_user_id
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    // get all users to notify
    const users = await this.prisma.uSER.findMany({
      where: { id: { in: userIds } },
      select: { email: true, first_name: true, last_name: true, id: true },
    });
    if (!users || users.length === 0 || !users[0].email) {
      this.logger.warn(
        `notifyPanelCandidateBlocked: hire request ${hireRequestId} has no assignee email to notify`,
      );
      return false;
    }

    let attemptedByName = 'A user';
    try {
      const attemptedByUser = await this.prisma.uSER.findUnique({
        where: { id: attemptedByUserId },
        select: { first_name: true, last_name: true, email: true },
      });
      if (attemptedByUser) {
        attemptedByName =
          `${attemptedByUser.first_name || ''} ${attemptedByUser.last_name || ''}`.trim() ||
          attemptedByUser.email ||
          attemptedByName;
      }
    } catch (err) {
      this.logger.warn(
        `notifyPanelCandidateBlocked: failed to load attempting user ${attemptedByUserId}`,
        err?.message || err,
      );
    }

    let candidateNames = 'a candidate';
    try {
      const candidates = await this.prisma.candidate.findMany({
        where: { id: { in: candidateIds } },
        select: { id: true, first_name: true, last_name: true },
      });
      if (candidates && candidates.length > 0) {
        const names = candidates
          .map((c) => `${c.first_name || ''} ${c.last_name || ''}`.trim())
          .filter(Boolean);
        if (names.length > 0) candidateNames = names.join(', ');
      }
    } catch (err) {
      this.logger.warn(
        `notifyPanelCandidateBlocked: failed to load candidates ${candidateIds.join(', ')}`,
        err?.message || err,
      );
    }

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtml = this.buildEmail(
      `<p>Hello,</p>
       <p><strong>${attemptedByName}</strong> tried to add the following candidate(s) to a panel, but the action was blocked because the scheduled interview is less than 48 hours away:</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Candidate(s):</strong> ${candidateNames}</p>
         <p><strong>Reason:</strong> Interview is scheduled within the next 48 hours</p>
       </div>

       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Hire Request Details
         </a>
       </div>`,
      emailTheme,
    );

    const tpl = await this.getTplContent(
      'hr-panel-candidate-blocked',
      {
        '{{attemptedByName}}': attemptedByName,
        '{{candidateNames}}': candidateNames,
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );

    return await this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: users.map((user) => user.email),
      subject:
        tpl?.subject ??
        `Action needed: candidate addition blocked on ${hr.title}`,
      html: tpl?.html ?? fallbackHtml,
    });
  }

  async notifyHireRequestSelectWinner(hireRequestId: string): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        salary_range_from: true,
        salary_range_to: true,
        expected_start_date: true,
        hubspot_role_type: true,
        availability: true,
        organization: {
          select: {
            id: true,
            name: true,
            business_unit: true,
            admin: {
              select: {
                id: true,
                email: true,
                first_name: true,
                last_name: true,
              },
            },
            owner: {
              select: {
                id: true,
                email: true,
                first_name: true,
                last_name: true,
              },
            },
          },
        },
        panels: {
          select: {
            id: true,
            panelCandidates: {
              where: { status: 'selected_by_client' },
              select: {
                candidate: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!hr) throw new NotFoundException('Hire request not found');

    // Get organization admin and super admin users
    const organizationAdmins = await this.prisma.uSER.findMany({
      where: {
        organization_id: hr.organization.id,
        role: { in: ['organization_admin', 'organization_super_admin'] },
        status: 'active',
      },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        role: true,
      },
    });

    // Also include organization admin and owner if they exist
    const additionalRecipients: any[] = [];
    if (hr.organization.admin && hr.organization.admin.email) {
      additionalRecipients.push(hr.organization.admin);
    }
    if (hr.organization.owner && hr.organization.owner.email) {
      additionalRecipients.push(hr.organization.owner);
    }

    // Combine all recipients and remove duplicates
    const allRecipients = [...organizationAdmins, ...additionalRecipients];
    const uniqueRecipients = allRecipients.filter(
      (recipient, index, self) =>
        index === self.findIndex((r) => r.email === recipient.email),
    );

    if (uniqueRecipients.length === 0) {
      throw new BadRequestException('No organization admins found to notify');
    }

    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.hireRequests}?request=${hr.id}`;
    const salaryRange =
      hr.salary_range_from && hr.salary_range_to
        ? `$${hr.salary_range_from} - $${hr.salary_range_to}`
        : 'Not specified';
    const startDate = hr.expected_start_date
      ? new Date(hr.expected_start_date).toLocaleDateString()
      : 'Not specified';

    // Get winner candidate name
    const winnerCandidate = hr.panels?.[0]?.panelCandidates?.[0]?.candidate;
    const winnerName = winnerCandidate
      ? winnerCandidate.name ||
        `${winnerCandidate.first_name || ''} ${winnerCandidate.last_name || ''}`.trim() ||
        'Unknown'
      : 'Not specified';

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtmlWinner = this.buildEmail(
      `<p>Your hire request has been completed.</p>

       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Hire Request Details</h3>
         <p><strong>Title:</strong> ${hr.title}</p>
         <p><strong>Organization:</strong> ${hr.organization.name}</p>
         <p><strong>Description:</strong>
         <span style="font-size: 0.875rem; line-height: 1.625; white-space: pre-wrap;">${hr.description || 'No description provided'}</span>
         </p>
         <p><strong>Salary Range:</strong> ${salaryRange}</p>
         <p><strong>Expected Start Date:</strong> ${startDate}</p>
         <p><strong>Selected Candidate:</strong> ${winnerName}</p>
       </div>

       <p>Please review the details and proceed with the next steps.</p>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           Review Hire Request
         </a>
       </div>`,
      emailTheme,
    );
    const tplWinner = await this.getTplContent(
      'hr-winner-selected',
      {
        '{{roleType}}': hr.hubspot_role_type || '',
        '{{availability}}': hr.availability || '',
        '{{hrTitle}}': hr.title,
        '{{orgName}}': hr.organization.name,
        '{{hrDescription}}': hr.description || 'No description provided',
        '{{salaryRange}}': salaryRange,
        '{{startDate}}': startDate,
        '{{winnerName}}': winnerName,
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );
    const results = this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: uniqueRecipients.map((r) => r.email),
      subject:
        tplWinner?.subject ??
        `Hire Request Completed: ${hr.hubspot_role_type} - ${hr.availability}.`,
      html: tplWinner?.html ?? fallbackHtmlWinner,
    });

    // Return true if at least one email was sent successfully
    return results;
  }

  async notifyHireRequestAwaitingDecision(
    hireRequestId: string,
  ): Promise<boolean> {
    const hr = await this.prisma.hireRequest.findUnique({
      where: { id: hireRequestId },
      select: {
        id: true,
        title: true,
        hubspot_role_type: true,
        availability: true,
        status: true,
        panels: {
          where: {
            status: 'decision_pending',
          },
          select: {
            id: true,
            status: true,
            scheduled_date: true,
          },
          take: 1,
        },
        organization: {
          select: {
            id: true,
            name: true,
            business_unit: true,
          },
        },
      },
    });

    if (!hr) throw new NotFoundException('Hire request not found');

    // Get organization admin and super admin users (clients)
    const organizationAdmins = await this.prisma.uSER.findMany({
      where: {
        organization_id: hr.organization.id,
        role: { in: ['organization_admin', 'organization_super_admin'] },
        status: 'active',
      },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        role: true,
      },
    });

    // Remove duplicates by email
    const uniqueRecipients = organizationAdmins.filter(
      (recipient, index, self) =>
        index === self.findIndex((r) => r.email === recipient.email),
    );

    if (uniqueRecipients.length === 0) {
      throw new BadRequestException('No organization admins found to notify');
    }

    //removed on 2025-11-13 asked by Pauli on medvirtual group
    //const detailUrl = `${process.env.FRONTEND_URL}/hire-requests?request=${hr.id}`;
    const detailUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.clientInterviewPanels}`;

    // Get panel information
    const panel = hr.panels?.[0];
    const scheduledDate = panel?.scheduled_date
      ? new Date(panel.scheduled_date).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'Not specified';

    const emailTheme = await getBusinessUnitEmailTheme(
      this.prisma,
      hr.organization.business_unit,
    );

    const fallbackHtmlAwaiting = this.buildEmail(
      `<p>Your hire request has been marked as <strong>awaiting decision</strong>.</p>

      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
        <p><strong>Scheduled Date:</strong> ${scheduledDate}</p>
      </div>

      <div style="text-align: left; margin: 30px 0;">
        <a href="${detailUrl}" class="cta-button">
          Review Hire Request
        </a>
      </div>`,
      emailTheme,
    );
    const tplAwaiting = await this.getTplContent(
      'hr-awaiting-decision',
      {
        '{{roleType}}': hr.hubspot_role_type || '',
        '{{availability}}': hr.availability || '',
        '{{scheduledDate}}': scheduledDate,
        '{{hrLink}}': detailUrl,
      },
      emailTheme,
      hr.organization.business_unit,
    );
    const results = this.mail.sendMail({
      from: `${hr.organization.business_unit || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: uniqueRecipients.map((r) => r.email),
      subject:
        tplAwaiting?.subject ??
        `Your hire request has been marked as awaiting decision: ${hr.hubspot_role_type} - ${hr.availability}`,
      html: tplAwaiting?.html ?? fallbackHtmlAwaiting,
    });

    // Return true if at least one email was sent successfully
    return results;
  }
  // ======== Tickets ========

  async notifyTicketStatusChangeToCreator(
    ticket: any,
    newStatus: 'in_progress' | 'resolved' | 'closed',
  ): Promise<boolean> {
    if (!ticket) throw new NotFoundException('Ticket not found');

    // Only notify the creator
    let creatorEmail: string | undefined;
    let emailThemeUserId: string | undefined;
    let creatorRole: string | undefined;

    if (ticket.created_by) {
      const creator = await this.prisma.uSER.findUnique({
        where: { id: ticket.created_by },
        select: { id: true, email: true, role: true },
      });
      if (creator?.email) {
        creatorEmail = creator.email;
        emailThemeUserId = creator.id;
        creatorRole = creator.role;
      }
    } else if (ticket.id) {
      // Fallback to fetch created_by
      const withCreator = await this.prisma.ticket.findFirst({
        where: { id: ticket.id, deleted_at: null },
        select: { created_by: true },
      });
      if (withCreator?.created_by) {
        const creator = await this.prisma.uSER.findUnique({
          where: { id: withCreator.created_by },
          select: { id: true, email: true, role: true },
        });
        if (creator?.email) {
          creatorEmail = creator.email;
          emailThemeUserId = creator.id;
          creatorRole = creator.role;
        }
      }
    }

    if (!creatorEmail)
      throw new BadRequestException('Ticket creator has no email');

    // Filter: Only send to clients (organization admins) if ticket type is "Support"
    // System admins always receive notifications for all ticket types
    const isSystemAdmin =
      creatorRole === 'system_admin' || creatorRole === 'system_super_admin';
    const isClient = !isSystemAdmin; // Organization admins are considered clients
    const ticketType = ticket.type?.toLowerCase();
    const isSupportTicket = ticketType === 'support';

    // Skip notification if creator is a client and ticket is not a Support ticket
    if (isClient && !isSupportTicket) {
      return false; // Don't send notification to clients for non-Support tickets
    }

    const detailUrl = this.getTicketDetailUrl(ticket.id, creatorRole);
    const createdDate = new Date(ticket.createdAt).toLocaleDateString();

    // Get user email theme
    const emailTheme = emailThemeUserId
      ? await getUserEmailTheme(this.prisma, emailThemeUserId)
      : null;

    // Format status for display
    const statusDisplay = newStatus.replace('_', ' ').toUpperCase();

    // Check if ticket type is Referral to use "Candidate Details" instead of "Description"
    const isReferralTicket = ticket.type?.toLowerCase() === 'referral';
    const descriptionLabel = isReferralTicket
      ? 'Candidate Details'
      : 'Description';

    // Parse Referral ticket description format
    let descriptionContent = '';
    if (isReferralTicket && ticket.description) {
      descriptionContent = this.formatReferralDescription(ticket.description);
    }

    const html = this.buildEmail(
      `
       <p>Your ticket has been updated to <strong>${statusDisplay}</strong> status.</p>
       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Ticket Details</h3>
         <p><strong>Title:</strong> ${ticket.title}</p>
         <p><strong>Organization:</strong> ${ticket.organization?.name || 'N/A'}</p>
         ${isReferralTicket ? '' : `<p><strong>${descriptionLabel}:</strong> <br>${this.formatDescription(ticket.description)}</p>`}
         <p><strong>Type:</strong> ${ticket.type}</p>
         <p><strong>Status:</strong> ${statusDisplay}</p>
         <p><strong>Created:</strong> ${createdDate}</p>
       </div>
       ${isReferralTicket ? descriptionContent : ''}
       
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Ticket Details
         </a>
       </div>
       <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; font-size: 12px; color: #666;">
         <p style="margin: 0 0 5px 0;"><strong>Or copy this link:</strong></p>
         <a href="${detailUrl}" style="color: #01546B; word-break: break-all; text-decoration: none;">${detailUrl}</a>
       </div>`,
      emailTheme,
    );

    const tplTicketStatus = await this.getTplContent(
      'ticket-status-changed',
      {
        '{{status}}': statusDisplay,
        '{{ticketTitle}}': ticket.title,
        '{{orgName}}': ticket.organization?.name || 'N/A',
        '{{ticketType}}': ticket.type || '',
        '{{createdDate}}': createdDate,
        '{{ticketDescription}}': ticket.description || '',
        '{{ticketLink}}': detailUrl,
      },
      emailTheme,
    );

    return await this.mail.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [creatorEmail],
      subject:
        tplTicketStatus?.subject ??
        `Your ticket changed to ${statusDisplay} status: ${ticket.title}`,
      html: tplTicketStatus?.html ?? html,
    });
  }

  async notifyTicketReopened(ticket: any): Promise<boolean> {
    if (!ticket) throw new NotFoundException('Ticket not found');

    // Only notify the creator
    let creatorEmail: string | undefined;
    let emailThemeUserId: string | undefined;
    let creatorRole: string | undefined;

    if (ticket.created_by) {
      const creator = await this.prisma.uSER.findUnique({
        where: { id: ticket.created_by },
        select: { id: true, email: true, role: true },
      });
      if (creator?.email) {
        creatorEmail = creator.email;
        emailThemeUserId = creator.id;
        creatorRole = creator.role;
      }
    } else if (ticket.id) {
      // Fallback to fetch created_by
      const withCreator = await this.prisma.ticket.findFirst({
        where: { id: ticket.id, deleted_at: null },
        select: { created_by: true },
      });
      if (withCreator?.created_by) {
        const creator = await this.prisma.uSER.findUnique({
          where: { id: withCreator.created_by },
          select: { id: true, email: true, role: true },
        });
        if (creator?.email) {
          creatorEmail = creator.email;
          emailThemeUserId = creator.id;
          creatorRole = creator.role;
        }
      }
    }

    if (!creatorEmail)
      throw new BadRequestException('Ticket creator has no email');

    // Filter: Only send to clients (organization admins) if ticket type is "Support"
    // System admins always receive notifications for all ticket types
    const isSystemAdmin =
      creatorRole === 'system_admin' || creatorRole === 'system_super_admin';
    const isClient = !isSystemAdmin; // Organization admins are considered clients
    const ticketType = ticket.type?.toLowerCase();
    const isSupportTicket = ticketType === 'support';

    // Skip notification if creator is a client and ticket is not a Support ticket
    if (isClient && !isSupportTicket) {
      return false; // Don't send notification to clients for non-Support tickets
    }

    const detailUrl = this.getTicketDetailUrl(ticket.id, creatorRole);
    const createdDate = new Date(ticket.createdAt).toLocaleDateString();

    // Get user email theme
    const emailTheme = emailThemeUserId
      ? await getUserEmailTheme(this.prisma, emailThemeUserId)
      : null;

    // Check if ticket type is Referral to use "Candidate Details" instead of "Description"
    const isReferralTicket = ticket.type?.toLowerCase() === 'referral';
    const descriptionLabel = isReferralTicket
      ? 'Candidate Details'
      : 'Description';

    // Parse Referral ticket description format
    let descriptionContent = '';
    if (isReferralTicket && ticket.description) {
      descriptionContent = this.formatReferralDescription(ticket.description);
    }

    const html = this.buildEmail(
      `
       <p>Your ticket has been <strong>reopened</strong> and is now back to <strong>NEW</strong> status.</p>
       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Ticket Details</h3>
         <p><strong>Title:</strong> ${ticket.title}</p>
         <p><strong>Organization:</strong> ${ticket.organization?.name || 'N/A'}</p>
         ${isReferralTicket ? '' : `<p><strong>${descriptionLabel}:</strong> <br>${this.formatDescription(ticket.description)}</p>`}
         <p><strong>Type:</strong> ${ticket.type}</p>
         <p><strong>Status:</strong> NEW</p>
         <p><strong>Created:</strong> ${createdDate}</p>
       </div>
       ${isReferralTicket ? descriptionContent : ''}
       
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">
           View Ticket Details
         </a>
       </div>
       <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; font-size: 12px; color: #666;">
         <p style="margin: 0 0 5px 0;"><strong>Or copy this link:</strong></p>
         <a href="${detailUrl}" style="color: #01546B; word-break: break-all; text-decoration: none;">${detailUrl}</a>
       </div>`,
      emailTheme,
    );

    const tplReopened = await this.getTplContent(
      'ticket-reopened',
      {
        '{{ticketTitle}}': ticket.title,
        '{{orgName}}': ticket.organization?.name || 'N/A',
        '{{ticketType}}': ticket.type || '',
        '{{createdDate}}': createdDate,
        '{{ticketDescription}}': ticket.description || '',
        '{{ticketLink}}': detailUrl,
      },
      emailTheme,
    );

    return await this.mail.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [creatorEmail],
      subject:
        tplReopened?.subject ??
        `Your ticket has been reopened: ${ticket.title}`,
      html: tplReopened?.html ?? html,
    });
  }

  async notifyTicketEvent(
    ticket: any,
    event: 'created' | 'assigned' | 'updated' | 'resolved' | 'closed',
  ): Promise<boolean> {
    if (!ticket) throw new NotFoundException('Ticket not found');

    // Get ticket type early to check if it's Support
    const ticketType = ticket.type?.toLowerCase();
    const isSupportTicket = ticketType === 'support';

    // Get created_by ID (from ticket object or fetch if needed)
    let createdById: string | null = null;
    if (ticket.created_by) {
      createdById = ticket.created_by;
    } else if (ticket.id) {
      const ticketData = await this.prisma.ticket.findFirst({
        where: { id: ticket.id, deleted_at: null },
        select: { created_by: true, user_id: true },
      });
      createdById = ticketData?.created_by || null;
      // Also update ticket.user_id if not available in ticket object
      if (!ticket.user_id && ticketData?.user_id) {
        ticket.user_id = ticketData.user_id;
      }
    }

    // Get assigned user ID
    const assignedUserId = ticket.user?.id || ticket.user_id;

    // Check if creator and assignee are the same user - if so, don't send notification
    if (createdById && assignedUserId && createdById === assignedUserId) {
      // Creator and assignee are the same, skip notification
      return false;
    }

    // Determine recipients: include creator (requested) and keep assignee if present
    const recipients: { email: string; isSystemAdmin: boolean }[] = [];

    // Creator - only add if ticket is Support OR creator is system admin
    let emailThemeUserId: string | undefined = undefined;
    if (ticket.created_by) {
      const creator = await this.prisma.uSER.findUnique({
        where: { id: ticket.created_by },
        select: { id: true, email: true, role: true },
      });
      if (creator?.email) {
        const isSystemAdmin =
          creator.role === 'system_admin' ||
          creator.role === 'system_super_admin';
        // Only add creator if ticket is Support OR creator is system admin
        if (isSupportTicket || isSystemAdmin) {
          recipients.push({ email: creator.email, isSystemAdmin });
          emailThemeUserId = emailThemeUserId || creator.id;
        }
      }
    } else if (ticket.id) {
      // Fallback to fetch created_by
      const withCreator = await this.prisma.ticket.findFirst({
        where: { id: ticket.id, deleted_at: null },
        select: { created_by: true },
      });
      if (withCreator?.created_by) {
        const creator = await this.prisma.uSER.findUnique({
          where: { id: withCreator.created_by },
          select: { id: true, email: true, role: true },
        });
        if (creator?.email) {
          const isSystemAdmin =
            creator.role === 'system_admin' ||
            creator.role === 'system_super_admin';
          // Only add creator if ticket is Support OR creator is system admin
          if (isSupportTicket || isSystemAdmin) {
            recipients.push({ email: creator.email, isSystemAdmin });
            emailThemeUserId = emailThemeUserId || creator.id;
          }
        }
      }
    }

    // Assignee (kept for backwards compatibility)
    // Only add assignee if it's different from creator
    if (
      ticket.user?.email &&
      (!createdById || ticket.user.id !== createdById)
    ) {
      const isSystemAdmin =
        ticket.user.role === 'system_admin' ||
        ticket.user.role === 'system_super_admin';
      recipients.push({ email: ticket.user.email, isSystemAdmin });
      emailThemeUserId = emailThemeUserId || ticket.user.id;
    }

    // Remove duplicates but keep system admin flag
    const uniqueRecipients = recipients.filter(
      (recipient, index, self) =>
        index === self.findIndex((r) => r.email === recipient.email),
    );

    // Filter: For status change events (resolved, closed), only send to clients if ticket type is "Support"
    // System admins always receive notifications for all ticket types
    // Note: 'in_progress' status changes are handled by notifyTicketStatusChangeToCreator
    const isStatusChangeEvent = event === 'resolved' || event === 'closed';

    let filteredRecipients = uniqueRecipients;
    if (isStatusChangeEvent && !isSupportTicket) {
      // Filter out client recipients (non-system-admins) for non-Support ticket status changes
      filteredRecipients = uniqueRecipients.filter(
        (recipient) => recipient.isSystemAdmin,
      );
    }

    // Always notify fixed email for Support tickets
    if (
      isSupportTicket &&
      !filteredRecipients.some((r) => r.email === 'paulo@regenta.ai')
    ) {
      filteredRecipients = [
        ...filteredRecipients,
        { email: 'paulo@regenta.ai', isSystemAdmin: true },
      ];
    }

    if (filteredRecipients.length === 0)
      throw new BadRequestException('Ticket has no recipient email');

    const createdDate = new Date(ticket.createdAt).toLocaleDateString();

    // Get user email theme (based on creator or assignee, in that order)
    const emailTheme = emailThemeUserId
      ? await getUserEmailTheme(this.prisma, emailThemeUserId)
      : null;

    // Get ticket type display name
    const ticketTypeDisplay =
      ticketTypeReverseDictionary[ticket.type] || ticket.type;

    // Check if ticket type is Referral to use "Candidate Details" instead of "Description"
    const isReferralTicket = ticket.type?.toLowerCase() === 'referral';
    const descriptionLabel = isReferralTicket
      ? 'Candidate Details'
      : 'Description';

    // Build staff member name (only name, no email)
    const staffName = ticket.staff?.candidate?.name?.trim() || null;

    // Build candidate name if available
    const candidateName =
      ticket.candidate?.name?.trim() ||
      (ticket.candidate?.first_name && ticket.candidate?.last_name
        ? `${ticket.candidate.first_name} ${ticket.candidate.last_name}`.trim()
        : null);

    // Send emails to each recipient with appropriate formatting
    const emailPromises = filteredRecipients.map(async (recipient) => {
      const isSystemAdmin = recipient.isSystemAdmin;

      // Get recipient role to build correct URL
      const recipientUser = await this.prisma.uSER.findUnique({
        where: { email: recipient.email },
        select: { role: true },
      });
      const recipientRole = recipientUser?.role;
      const detailUrl = this.getTicketDetailUrl(ticket.id, recipientRole);

      // Parse Referral ticket description format
      let descriptionContent = '';
      if (isReferralTicket && ticket.description) {
        descriptionContent = this.formatReferralDescription(ticket.description);
      }

      // For system admins and "created" event, use enhanced format
      if (isSystemAdmin && event === 'created') {
        // Build descriptive title based on ticket type
        let emailTitle = '';
        let emailSubject = '';

        if (
          ticketTypeDisplay === 'Bonus' &&
          staffName &&
          ticket.organization?.name
        ) {
          emailTitle = `Bonus Ticket Created for ${ticket.organization.name}`;
          emailSubject = `Bonus Ticket Created for ${ticket.organization.name}`;
        } else if (ticketTypeDisplay === 'Bonus' && staffName) {
          emailTitle = `Bonus Ticket Created for ${staffName}`;
          emailSubject = `Bonus Ticket Created for ${staffName}`;
        } else if (ticket.organization?.name) {
          emailTitle = `${ticketTypeDisplay} Ticket Created for ${ticket.organization.name}`;
          emailSubject = `${ticketTypeDisplay} Ticket Created for ${ticket.organization.name}`;
        } else {
          emailTitle = `${ticketTypeDisplay} Ticket Created`;
          emailSubject = `${ticketTypeDisplay} Ticket Created`;
        }

        // Build type badge
        const typeBadge = `<span style="display: inline-block; background-color: #01546B; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-bottom: 10px;">${ticketTypeDisplay}</span>`;

        // Build staff info if available (only name)
        let staffInfo = '';
        if (staffName) {
          staffInfo = `<p><strong>Staff Member:</strong> ${staffName}</p>`;
        }

        // Build candidate info if available
        let candidateInfo = '';
        if (candidateName) {
          candidateInfo = `<p><strong>Candidate:</strong> ${candidateName}</p>`;
        }

        const fallbackHtml = this.buildEmail(
          `<h2>${emailTitle}</h2>
           <div style="margin-bottom: 20px;">
             ${typeBadge}
           </div>

           <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
             <h3 style="margin-top: 0; color: #333;">Ticket Details</h3>
             <p><strong>Title:</strong> ${ticket.title}</p>
             ${isReferralTicket ? '' : `<p><strong>${descriptionLabel}:</strong> ${this.formatDescription(ticket.description)}</p>`}
             <p><strong>Organization:</strong> ${ticket.organization?.name || 'N/A'}</p>
             ${staffInfo}
             ${candidateInfo}
           </div>
           ${isReferralTicket ? descriptionContent : ''}

           <div style="text-align: left; margin: 30px 0;">
             <a href="${detailUrl}" class="cta-button">
               View Ticket Details
             </a>
           </div>
           <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; font-size: 12px; color: #666;">
             <p style="margin: 0 0 5px 0;"><strong>Or copy this link:</strong></p>
             <a href="${detailUrl}" style="color: #01546B; word-break: break-all; text-decoration: none;">${detailUrl}</a>
           </div>`,
          emailTheme,
        );

        // Pre-assemble the optional/conditional fragments so the DB template can
        // stay a plain-substitution string (the engine has no {{#if}} support).
        const staffLine = staffName ? `Staff Member: ${staffName}\n` : '';
        const candidateLine = candidateName
          ? `Candidate: ${candidateName}\n`
          : '';
        const descriptionBlock = isReferralTicket
          ? ''
          : `${descriptionLabel}: ${this.formatDescription(ticket.description)}`;

        const tplCreatedAdmin = await this.getTplContent(
          'ticket-created-admin',
          {
            '{{emailTitle}}': emailTitle,
            '{{ticketType}}': ticketTypeDisplay,
            '{{ticketTitle}}': ticket.title,
            '{{orgName}}': ticket.organization?.name || 'N/A',
            '{{staffLine}}': staffLine,
            '{{candidateLine}}': candidateLine,
            '{{descriptionBlock}}': descriptionBlock,
            '{{ticketLink}}': detailUrl,
          },
          emailTheme,
        );

        return this.mail.sendMail({
          from: `${isSystemAdmin ? 'MedVirtual' : emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
          to: [recipient.email],
          subject: tplCreatedAdmin?.subject ?? emailSubject,
          html: tplCreatedAdmin?.html ?? fallbackHtml,
        });
      } else {
        // Standard format for non-system admins or other events
        // Build staff member details if available (without email)
        let staffDetails = '';
        if (staffName) {
          staffDetails = `<p><strong>Staff Member:</strong> ${staffName}</p>`;
        }

        // Build candidate details if available
        let candidateDetails = '';
        if (candidateName) {
          candidateDetails = `<p><strong>Candidate:</strong> ${candidateName}</p>`;
        }

        const html = this.buildEmail(
          `<p>The ticket was <strong>${event}</strong>.</p>
           
           <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
             <h3 style="margin-top: 0; color: #333;">Ticket Details</h3>
             <p><strong>Title:</strong> ${ticket.title}</p>
             <p><strong>Organization:</strong> ${ticket.organization?.name || 'N/A'}</p>
             ${isReferralTicket ? '' : `<p><strong>${descriptionLabel}:</strong> ${this.formatDescription(this.decodeHtmlEntities(ticket.description))}</p>`}
             <p><strong>Type:</strong> ${ticketTypeDisplay}</p>
             ${staffDetails}${candidateDetails}
           </div>
           ${isReferralTicket ? descriptionContent : ''}
           
           <div style="text-align: left; margin: 30px 0;">
             <a href="${detailUrl}" class="cta-button">
               View Ticket Details
             </a>
           </div>
           <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; font-size: 12px; color: #666;">
             <p style="margin: 0 0 5px 0;"><strong>Or copy this link:</strong></p>
             <a href="${detailUrl}" style="color: #01546B; word-break: break-all; text-decoration: none;">${detailUrl}</a>
           </div>`,
          emailTheme,
        );

        // 'assigned' (the Reassign action) has its own dedicated template so it
        // can be edited independently of updated/resolved/closed; every other
        // event stays on the shared 'ticket-event' key.
        const tplKey =
          event === 'assigned' ? 'ticket-assigned' : 'ticket-event';

        // Pre-assembled fragments consumed only by 'ticket-assigned'; harmless
        // for 'ticket-event' (unknown placeholders are left untouched).
        const staffLine = staffName ? `Staff Member: ${staffName}\n` : '';
        const candidateLine = candidateName
          ? `Candidate: ${candidateName}\n`
          : '';
        const descriptionBlock = isReferralTicket
          ? ''
          : `${descriptionLabel}: ${this.formatDescription(this.decodeHtmlEntities(ticket.description))}`;

        const tplEvent = await this.getTplContent(
          tplKey,
          {
            '{{event}}': event,
            '{{ticketTitle}}': ticket.title,
            '{{orgName}}': ticket.organization?.name || 'N/A',
            '{{ticketType}}': ticketTypeDisplay,
            '{{ticketDescription}}': ticket.description || '',
            '{{staffLine}}': staffLine,
            '{{candidateLine}}': candidateLine,
            '{{descriptionBlock}}': descriptionBlock,
            '{{ticketLink}}': detailUrl,
          },
          emailTheme,
        );

        return this.mail.sendMail({
          from: `${isSystemAdmin ? 'MedVirtual' : emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
          to: [recipient.email],
          subject: tplEvent?.subject ?? `Ticket ${event}: ${ticket.title}`,
          html: tplEvent?.html ?? html,
        });
      }
    });

    // Wait for all emails to be sent
    const results = await Promise.all(emailPromises);

    // Return true if at least one email was sent successfully
    return results.some((result) => result === true);
  }

  async notifyTicketNoteAddedToAssignee(
    ticketId: string,
    note: {
      content: string;
      author?: {
        id?: string;
        first_name?: string;
        last_name?: string;
        email?: string;
      };
    },
  ): Promise<boolean> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deleted_at: null },
      select: {
        id: true,
        title: true,
        organization: { select: { name: true } },
        user_id: true,
        user: {
          select: {
            id: true,
            email: true,
            first_name: true,
            last_name: true,
          },
        },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    if (!ticket.user_id || !ticket.user?.email) {
      throw new BadRequestException('Ticket has no assigned user with email');
    }

    // Get user role to build correct URL
    const assigneeUser = await this.prisma.uSER.findUnique({
      where: { id: ticket.user.id },
      select: { role: true },
    });
    const detailUrl = this.getTicketDetailUrl(ticket.id, assigneeUser?.role);

    const emailTheme = await getUserEmailTheme(this.prisma, ticket.user.id);

    const authorName =
      `${note.author?.first_name ?? ''} ${note.author?.last_name ?? ''}`.trim() ||
      'A user';

    const html = this.buildEmail(
      `<h2>You Received a Response on Your Ticket</h2>
       <p>You received a response on your ticket from <strong>${authorName}</strong>.</p>
       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Ticket</h3>
         <p><strong>Title:</strong> ${ticket.title}</p>
         <p><strong>Organization:</strong> ${ticket.organization?.name || 'N/A'}</p>
       </div>
       <div style="background-color: #fff; border: 1px solid #eee; padding: 15px; border-radius: 8px;">
         <h3 style="margin-top: 0; color: #333;">Response</h3>
         <p style="white-space: pre-wrap;">${note.content}</p>
       </div>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">View Ticket</a>
       </div>
       <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; font-size: 12px; color: #666;">
         <p style="margin: 0 0 5px 0;"><strong>Or copy this link:</strong></p>
         <a href="${detailUrl}" style="color: #01546B; word-break: break-all; text-decoration: none;">${detailUrl}</a>
       </div>`,
      emailTheme,
    );

    const tplNoteAssignee = await this.getTplContent(
      'ticket-note-added',
      {
        '{{ticketTitle}}': ticket.title,
        '{{orgName}}': ticket.organization?.name || 'N/A',
        '{{authorName}}': authorName,
        '{{noteContent}}': note.content,
        '{{ticketLink}}': detailUrl,
      },
      emailTheme,
    );

    return await this.mail.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [ticket.user.email],
      subject:
        tplNoteAssignee?.subject ??
        `You received a response on your ticket: ${ticket.title}`,
      html: tplNoteAssignee?.html ?? html,
    });
  }

  async notifyTicketNoteAddedToCreator(
    ticketId: string,
    note: {
      content: string;
      author?: {
        id?: string;
        first_name?: string;
        last_name?: string;
        email?: string;
      };
    },
  ): Promise<boolean> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, deleted_at: null },
      select: {
        id: true,
        title: true,
        organization: { select: { name: true } },
        created_by: true,
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    if (!ticket.created_by)
      throw new BadRequestException('Ticket has no creator');

    const creator = await this.prisma.uSER.findUnique({
      where: { id: ticket.created_by },
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        role: true,
      },
    });
    if (!creator?.email)
      throw new BadRequestException('Ticket creator has no email');

    const detailUrl = this.getTicketDetailUrl(ticket.id, creator.role);

    const emailTheme = await getUserEmailTheme(this.prisma, creator.id);

    const authorName =
      `${note.author?.first_name ?? ''} ${note.author?.last_name ?? ''}`.trim() ||
      'A user';

    const html = this.buildEmail(
      `<h2>You Received a Response on Your Ticket</h2>
       <p>You received a response on your ticket from <strong>${authorName}</strong>.</p>
       <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
         <h3 style="margin-top: 0; color: #333;">Ticket</h3>
         <p><strong>Title:</strong> ${ticket.title}</p>
         <p><strong>Organization:</strong> ${ticket.organization?.name || 'N/A'}</p>
       </div>
       <div style="background-color: #fff; border: 1px solid #eee; padding: 15px; border-radius: 8px;">
         <h3 style="margin-top: 0; color: #333;">Response</h3>
         <p style="white-space: pre-wrap;">${note.content}</p>
       </div>
       <div style="text-align: left; margin: 30px 0;">
         <a href="${detailUrl}" class="cta-button">View Ticket</a>
       </div>
       <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; font-size: 12px; color: #666;">
         <p style="margin: 0 0 5px 0;"><strong>Or copy this link:</strong></p>
         <a href="${detailUrl}" style="color: #01546B; word-break: break-all; text-decoration: none;">${detailUrl}</a>
       </div>`,
      emailTheme,
    );

    const tplNoteCreator = await this.getTplContent(
      'ticket-note-added',
      {
        '{{ticketTitle}}': ticket.title,
        '{{orgName}}': ticket.organization?.name || 'N/A',
        '{{authorName}}': authorName,
        '{{noteContent}}': note.content,
        '{{ticketLink}}': detailUrl,
      },
      emailTheme,
    );

    return await this.mail.sendMail({
      from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: [creator.email],
      subject:
        tplNoteCreator?.subject ??
        `You received a response on your ticket: ${ticket.title}`,
      html: tplNoteCreator?.html ?? html,
    });
  }

  /**
   * Formats a plain text description to preserve formatting in HTML emails.
   * Preserves line breaks, spaces, and indentation using white-space: pre-wrap.
   * Also escapes HTML special characters to prevent XSS.
   */
  private formatDescription(description: string | null | undefined): string {
    if (!description) {
      return '';
    }

    // Escape HTML special characters to prevent XSS
    const escaped = description
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    // Return formatted description with white-space: pre-wrap to preserve formatting
    return `<span style="white-space: pre-wrap;">${escaped}</span>`;
  }

  private formatReferralDescription(description: string): string {
    // Parse the format: Name: ...\nEmail: ...\nMessage: ...
    const lines = description.split('\n');
    const parsed: { name?: string; email?: string; message?: string } = {};

    let currentField: 'name' | 'email' | 'message' | null = null;
    let messageLines: string[] = [];

    lines.forEach((line) => {
      const trimmed = line.trim();

      if (trimmed.toLowerCase().startsWith('name:')) {
        // Save previous field if exists
        if (currentField === 'message' && messageLines.length > 0) {
          parsed.message = messageLines.join('\n').trim();
        }
        currentField = 'name';
        parsed.name = trimmed.replace(/^name:\s*/i, '').trim();
        messageLines = [];
      } else if (trimmed.toLowerCase().startsWith('email:')) {
        // Save previous field if exists
        if (currentField === 'message' && messageLines.length > 0) {
          parsed.message = messageLines.join('\n').trim();
        }
        currentField = 'email';
        parsed.email = trimmed.replace(/^email:\s*/i, '').trim();
        messageLines = [];
      } else if (trimmed.toLowerCase().startsWith('message:')) {
        // Save previous field if exists
        if (currentField === 'message' && messageLines.length > 0) {
          parsed.message = messageLines.join('\n').trim();
        }
        currentField = 'message';
        const messageContent = trimmed.replace(/^message:\s*/i, '').trim();
        if (messageContent) {
          messageLines.push(messageContent);
        }
      } else if (currentField === 'message') {
        messageLines.push(trimmed);
      }
    });

    // Save final message if we were collecting it
    if (currentField === 'message' && messageLines.length > 0) {
      parsed.message = messageLines.join('\n').trim();
    }

    // Build simple formatted HTML
    let html =
      '<div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">';
    html += '<h3 style="margin-top: 0; color: #333;">Candidate Details</h3>';

    if (parsed.name) {
      html += `<p><strong>Name:</strong> ${parsed.name}</p>`;
    }

    if (parsed.email) {
      html += `<p><strong>Email:</strong> <a href="mailto:${parsed.email}" style="color: #01546B; text-decoration: none;">${parsed.email}</a></p>`;
    }

    if (parsed.message) {
      html += `<p><strong>Message:</strong></p>`;
      html += `<p style="white-space: pre-wrap; margin-top: 5px;">${parsed.message}</p>`;
    }

    html += '</div>';

    return html;
  }

  async notifyTalentPoolLeadNew(payload: {
    ownerEmail: string;
    leadName: string;
    email: string;
    organization: string;
    websiteUrl: string;
    languagePreference: string;
    businessUnit: string;
    hasCandidate: boolean;
    mainNeed?: string;
    additionalDetails?: string;
  }): Promise<void> {
    try {
      const theme = await getBusinessUnitEmailTheme(
        this.prisma,
        payload.businessUnit,
      );
      const inquiryType = payload.hasCandidate
        ? 'Viewed candidate'
        : 'General inquiry';
      const websiteDisplay = payload.websiteUrl.replace(/&#x2F;/g, '/');

      const optionalRows = [
        payload.mainNeed
          ? `<tr>
               <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666; width: 45%;">Main need</td>
               <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${payload.mainNeed}</td>
             </tr>`
          : '',
        payload.additionalDetails
          ? `<tr>
               <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666; width: 45%;">Additional details</td>
               <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${payload.additionalDetails}</td>
             </tr>`
          : '',
      ].join('');

      const ctaLink = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.adminTickets}`;

      const html = this.buildEmail(
        `<h2>New Talent Pool Lead</h2>
         <p>A new inquiry was submitted through the ${payload.businessUnit} talent pool page.</p>
         <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
           <tr>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666; width: 45%;">Name</td>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${payload.leadName}</td>
           </tr>
           <tr>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666;">Email</td>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${payload.email}</td>
           </tr>
           <tr>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666;">Organization</td>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${payload.organization}</td>
           </tr>
           <tr>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666;">Website</td>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${websiteDisplay}</td>
           </tr>
           <tr>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666;">Bilingual EN/ES</td>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${payload.languagePreference === 'yes' ? 'Yes' : 'No'}</td>
           </tr>
           <tr>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #666666;">Inquiry type</td>
             <td style="padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; font-weight: 600;">${inquiryType}</td>
           </tr>
           ${optionalRows}
         </table>
         <div style="text-align: left; margin: 30px 0;">
           <a href="${ctaLink}" class="cta-button">View Lead</a>
         </div>`,
        theme,
      );

      const tplLead = await this.getTplContent(
        'talent-pool-lead-new',
        {
          '{{leadName}}': payload.leadName,
          '{{leadEmail}}': payload.email,
          '{{organization}}': payload.organization,
          '{{websiteUrl}}': websiteDisplay,
          '{{languagePreference}}':
            payload.languagePreference === 'yes' ? 'Yes' : 'No',
          '{{mainNeed}}': payload.mainNeed || 'N/A',
          '{{additionalDetails}}': payload.additionalDetails || 'N/A',
        },
        theme,
        payload.businessUnit,
      );

      await this.mail.sendMail({
        from: `${theme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
        to: [payload.ownerEmail],
        subject:
          tplLead?.subject ??
          `New talent pool lead: ${payload.leadName} — ${payload.organization}`,
        html: tplLead?.html ?? html,
      });
    } catch (err) {
      console.warn(
        `[talent-pool-lead] Failed to send new lead notification to ${payload.ownerEmail}:`,
        err?.message || err,
      );
    }
  }

  /**
   * CC the panel creator on the recipient-facing email, so the admin who sent the
   * panel holds the exact copy the client received (same branding, same link).
   *
   * Returns undefined rather than an empty array when the CC would be redundant or
   * invalid: Resend treats `cc: []` inconsistently across SDK versions, and CC'ing
   * the recipient's own address would deliver the same mail twice.
   */
  private offerPanelCreatorCc(
    creatorEmail: string | null | undefined,
    recipientEmail: string,
  ): string | undefined {
    const cc = creatorEmail?.trim();
    if (!cc) return undefined;
    if (cc.toLowerCase() === recipientEmail.trim().toLowerCase()) {
      return undefined;
    }
    return cc;
  }

  private static readonly VERIFIED_SENDER_DOMAINS = [
    'medvirtual.ai',
    'berryvirtual.com',
  ];

  /**
   * Resend only allows `from` on domains verified in the account. When the
   * panel creator's email is on one of those domains, send as them so the
   * recipient sees a real teammate instead of a no-reply address; otherwise
   * fall back to the shared noreply address, which is always verified.
   */
  private offerPanelSenderAddress(
    creatorEmail: string | null | undefined,
  ): string {
    const trimmedEmail = creatorEmail?.trim();
    const domain = trimmedEmail?.split('@')[1]?.toLowerCase();
    const isVerified =
      !!domain && NotificationsService.VERIFIED_SENDER_DOMAINS.includes(domain);
    return isVerified ? (trimmedEmail as string) : 'noreply@medvirtual.ai';
  }

  /**
   * BCC the HubSpot logging address on the recipient-facing offer-panel email so
   * the send is recorded on the contact's CRM timeline.
   *
   * Requires BOTH the address (HUBSPOT_BCC_EMAIL) and PROD. The address alone is
   * not the switch: it is present in local .env too, and logging a staging or
   * local test send onto a real customer's timeline pollutes the CRM with
   * records that are tedious to remove.
   *
   * Read at call time, not module load, so the environment is never captured too
   * early — same reason as getOfferPanelReportRecipients in CronService.
   *
   * Returns undefined rather than an empty string when disabled, matching
   * offerPanelCreatorCc: Resend treats empty recipient values inconsistently
   * across SDK versions. The trim also covers a blank or whitespace-only var.
   */
  private hubspotLoggingBcc(): string | undefined {
    if (process.env.ENVIRONMENT !== 'PROD') return undefined;
    return process.env.HUBSPOT_BCC_EMAIL?.trim() || undefined;
  }

  /**
   * Loads the panel's candidates in the shape the email card needs.
   *
   * Deliberately does NOT go through `CandidatesService.getTalentPoolCandidatesByIds`,
   * which returns the same payload: `CandidatesModule` already imports
   * `NotificationsModule`, so injecting it here would be a circular dependency
   * requiring forwardRef, and it would pull S3/OpenAI/HubSpot/Drive into the mail
   * path. Instead this reads Prisma directly and reuses the two *pure* rate
   * helpers, with `PositionRateConfigService` (a Prisma-only leaf module).
   *
   * Two queries total regardless of candidate count — the position-rate config is
   * read once for the whole batch, not once per candidate.
   *
   * Returns [] on failure: a broken card block must never stop the email from
   * being sent, and the surrounding copy still stands on its own.
   */
  private async loadOfferPanelEmailCandidates(
    candidateIds: string[],
  ): Promise<OfferPanelEmailCandidate[]> {
    const ids = Array.from(new Set(candidateIds.filter(Boolean)));
    if (ids.length === 0) return [];

    try {
      const [candidates, positionConfigs] = await Promise.all([
        this.prisma.candidate.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            first_name: true,
            last_name: true,
            name: true,
            country: true,
            avatar_url: true,
            gender: true,
            employment_type: true,
            hourly_pay_rate: true,
            business_unit: true,
            approved_positions_pairing: true,
            languages: { select: { name: true } },
            skills: { select: { skill_name: true } },
          },
        }),
        this.positionRateConfig.findAllUnpaginated(),
      ]);

      const configMap = buildConfigMap(positionConfigs);
      const avatarBase =
        process.env.AVATAR_URL ??
        'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/';

      const distinctBUs = Array.from(
        new Set(
          candidates
            .map((c) => c.business_unit)
            .filter((bu): bu is string => !!bu),
        ),
      );
      const poolEntries = await Promise.all(
        distinctBUs.map(
          async (bu) =>
            [bu, (await this.businessUnitContext.poolFor(bu)) ?? 'medical'] as [
              string,
              CandidatePool,
            ],
        ),
      );
      const poolMap = new Map(poolEntries);

      // A panel can mix candidates from several BUs, while the email itself is
      // themed by the panel's BU. Each card's logo must name the BU the
      // candidate actually belongs to, so it is resolved per candidate BU here
      // through the same EmailBranding path the panel theme uses.
      const brandEntries = await Promise.all(
        distinctBUs.map(
          async (bu) =>
            [bu, await getBusinessUnitEmailTheme(this.prisma, bu)] as [
              string,
              EmailTheme,
            ],
        ),
      );
      const brandMap = new Map(brandEntries);

      // Preserve the order the panel stores them in.
      const byId = new Map(candidates.map((c) => [c.id, c]));

      return ids
        .map((id) => byId.get(id))
        .filter((c): c is (typeof candidates)[number] => !!c)
        .map((candidate) => {
          // Rates first: computeCandidateRates reads the RAW employment_type and
          // unlabelled positions, so normalizing either one before this point
          // yields silently wrong billing.
          const rates = computeCandidateRates(
            candidate,
            configMap,
            poolMap.get(candidate.business_unit ?? '') ?? 'medical',
          );
          const brand = brandMap.get(candidate.business_unit ?? '');

          return {
            id: candidate.id,
            first_name: candidate.first_name,
            last_name: candidate.last_name,
            name: candidate.name,
            country: candidate.country,
            // avatar_url is a bare S3 key in the DB; an inbox needs it absolute.
            avatar_url: candidate.avatar_url
              ? `${avatarBase}${candidate.avatar_url}`
              : null,
            employment_type:
              changeLabelAvailability(
                dbToStageDictionary[Number(candidate.employment_type)],
              ) || null,
            approved_positions_pairing: (
              candidate.approved_positions_pairing ?? []
            ).map(getApprovedPositionLabel),
            skills: candidate.skills,
            languages: candidate.languages,
            bill_rate_monthly: rates.bill_rate_monthly,
            bill_rate_hourly: rates.bill_rate_hourly,
            brand_logo_url: brand?.logoUrl ?? null,
            brand_name: brand?.companyName ?? null,
          };
        });
    } catch (err) {
      this.logger.error(
        `Failed to load offer-panel email candidates: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  async notifyOfferPanelCreatedClient(panelId: string): Promise<boolean> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: {
        id: true,
        title: true,
        description: true,
        business_unit: true,
        recipient_name: true,
        recipient_email: true,
        recipient_org_name: true,
        promo_enabled: true,
        recipientUser: { select: { first_name: true } },
        createdBy: {
          select: { first_name: true, last_name: true, email: true },
        },
        candidates: { select: { candidate_id: true } },
        _count: { select: { candidates: true } },
      },
    });
    if (!panel) return false;

    const theme = await getBusinessUnitEmailTheme(
      this.prisma,
      panel.business_unit,
    );
    const panelUrl = `${process.env.FRONTEND_URL}/modules/talent/client`;
    const candidateCount = panel._count.candidates;
    const candidateCards = renderOfferPanelCandidateCardsShowcase(
      await this.loadOfferPanelEmailCandidates(
        panel.candidates.map((c) => c.candidate_id),
      ),
      theme,
      panel.promo_enabled,
      panelUrl,
    );
    const candidateLabel = `${candidateCount} candidate${candidateCount !== 1 ? 's' : ''}`;
    const greeting = panel.recipientUser?.first_name
      ? `Hi ${panel.recipientUser.first_name},`
      : `Hi ${panel.recipient_name},`;

    const fallbackHtmlOfferClient = this.buildEmail(
      `<p><strong>${panel.createdBy.first_name}</strong>, from <strong>${theme.companyName}</strong>, handpicked ${candidateLabel} we think are a great match for your team.</p>
      ${panel.title ? `<p style="font-size: 16px;"><strong>${panel.title}</strong></p>` : ''}
      ${panel.description ? `<p style="color: #555555;">${panel.description}</p>` : ''}
      <p>Take a look at their profiles whenever you're ready.</p>
      ${candidateCards}
      <div style="text-align: left; margin: 30px 0;">
        <a href="${panelUrl}" class="cta-button">View candidates</a>
      </div>
      <p style="color: #555555; font-size: 15px;">Like what you see? Let us know who you'd like to move forward with, right from the panel. Prefer to pass? You can decline there too.</p>`,
      theme,
      greeting,
      'Cheers,',
    );
    const tplOfferClient = await this.getTplContent(
      'offer-panel-created',
      {
        '{{candidateLabel}}': candidateLabel,
        '{{companyName}}': theme.companyName,
        '{{createdByName}}': panel.createdBy.first_name || '',
        '{{candidateCount}}': String(candidateCount),
        '{{panelLink}}': panelUrl,
        '{{candidateCards}}': candidateCards,
        '{{offerTitle}}': panel.title || '',
        '{{offerDescription}}': panel.description || '',
      },
      theme,
      panel.business_unit,
    );

    return this.mail.sendMail({
      from: `${theme?.companyName || 'MedVirtual'} <${this.offerPanelSenderAddress(panel.createdBy.email)}>`,
      to: panel.recipient_email,
      cc: this.offerPanelCreatorCc(
        panel.createdBy.email,
        panel.recipient_email,
      ),
      bcc: this.hubspotLoggingBcc(),
      subject:
        tplOfferClient?.subject ??
        `${candidateLabel} picked for you — ${theme.companyName}`,
      html: tplOfferClient?.html ?? fallbackHtmlOfferClient,
    });
  }

  async notifyOfferPanelCreatedPublic(panelId: string): Promise<boolean> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: {
        id: true,
        title: true,
        description: true,
        business_unit: true,
        recipient_name: true,
        recipient_email: true,
        public_token: true,
        promo_enabled: true,
        createdBy: { select: { first_name: true, email: true } },
        candidates: { select: { candidate_id: true } },
        _count: { select: { candidates: true } },
      },
    });
    if (!panel || !panel.public_token) return false;

    const theme = await getBusinessUnitEmailTheme(
      this.prisma,
      panel.business_unit,
    );
    const panelUrl = `${process.env.FRONTEND_URL}/modules/public/offer-panel/${panel.public_token}`;
    const candidateCount = panel._count.candidates;
    const candidateLabel = `${candidateCount} candidate${candidateCount !== 1 ? 's' : ''}`;
    const candidateCards = renderOfferPanelCandidateCardsShowcase(
      await this.loadOfferPanelEmailCandidates(
        panel.candidates.map((c) => c.candidate_id),
      ),
      theme,
      panel.promo_enabled,
      panelUrl,
    );

    const html = this.buildEmail(
      `<p><strong>${panel.createdBy.first_name}</strong>, from <strong>${theme.companyName}</strong>, handpicked ${candidateLabel} we think are a great match for your team.</p>
      ${panel.title ? `<p style="font-size: 16px;"><strong>${panel.title}</strong></p>` : ''}
      ${panel.description ? `<p style="color: #555555;">${panel.description}</p>` : ''}
      <p>Take a look at their profiles whenever you're ready.</p>
      ${candidateCards}
      <div style="text-align: left; margin: 30px 0;">
        <a href="${panelUrl}" class="cta-button">View candidates</a>
      </div>
      <p style="color: #555555; font-size: 15px;">Like what you see? Let us know who you'd like to move forward with, right from the panel. Prefer to pass? You can decline there too.</p>`,
      theme,
      'Hi there,',
      'Cheers,',
    );

    const tplOfferPublic = await this.getTplContent(
      'offer-panel-created',
      {
        '{{candidateLabel}}': candidateLabel,
        '{{companyName}}': theme.companyName,
        '{{createdByName}}': panel.createdBy.first_name || '',
        '{{candidateCount}}': String(candidateCount),
        '{{panelLink}}': panelUrl,
        '{{candidateCards}}': candidateCards,
        '{{offerTitle}}': panel.title || '',
        '{{offerDescription}}': panel.description || '',
      },
      theme,
      panel.business_unit,
    );

    return this.mail.sendMail({
      from: `${theme?.companyName || 'MedVirtual'} <${this.offerPanelSenderAddress(panel.createdBy.email)}>`,
      to: panel.recipient_email,
      // Both the cc and the bcc also apply to the resend path, which reuses this
      // method: a resend is the same email reaching the client, so it belongs on
      // the CRM timeline too.
      cc: this.offerPanelCreatorCc(
        panel.createdBy.email,
        panel.recipient_email,
      ),
      bcc: this.hubspotLoggingBcc(),
      subject:
        tplOfferPublic?.subject ??
        `${candidateLabel} picked for you — ${theme.companyName}`,
      html: tplOfferPublic?.html ?? html,
    });
  }

  async notifyAdminOfferPanelAccepted(panelId: string): Promise<boolean> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: {
        id: true,
        title: true,
        business_unit: true,
        recipient_name: true,
        recipient_email: true,
        recipient_org_name: true,
        createdBy: { select: { email: true, first_name: true } },
      },
    });
    if (!panel?.createdBy?.email) return false;

    const theme = await getBusinessUnitEmailTheme(
      this.prisma,
      panel.business_unit,
    );
    const panelUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.adminOfferPanels}?panel=${panel.id}`;
    const orgLabel = panel.recipient_org_name
      ? ` from ${panel.recipient_org_name}`
      : '';

    const fallbackHtmlAccepted = this.buildEmail(
      `<p><strong>${panel.recipient_name}</strong>${orgLabel} has <strong>accepted</strong> the offer panel you sent.</p>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
        <p><strong>Panel:</strong> ${panel.title}</p>
        <p><strong>Recipient:</strong> ${panel.recipient_name} (${panel.recipient_email})</p>
      </div>
      <div style="text-align: left; margin: 30px 0;">
        <a href="${panelUrl}" class="cta-button">View Offer Panel</a>
      </div>`,
      theme,
    );
    const tplAccepted = await this.getTplContent(
      'offer-panel-accepted',
      {
        '{{recipientName}}': panel.recipient_name || '',
        '{{recipientOrg}}': panel.recipient_org_name || 'N/A',
        '{{recipientEmail}}': panel.recipient_email || '',
        '{{panelTitle}}': panel.title || '',
      },
      theme,
      panel.business_unit,
    );

    return this.mail.sendMail({
      from: `${theme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: panel.createdBy.email,
      subject: tplAccepted?.subject ?? `Your offer was accepted`,
      html: tplAccepted?.html ?? fallbackHtmlAccepted,
    });
  }

  async notifyAdminOfferPanelDeclined(panelId: string): Promise<boolean> {
    const panel = await this.prisma.offerPanel.findUnique({
      where: { id: panelId },
      select: {
        id: true,
        title: true,
        business_unit: true,
        recipient_name: true,
        recipient_email: true,
        recipient_org_name: true,
        createdBy: { select: { email: true, first_name: true } },
      },
    });
    if (!panel?.createdBy?.email) return false;

    const theme = await getBusinessUnitEmailTheme(
      this.prisma,
      panel.business_unit,
    );
    const panelUrl = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.adminOfferPanels}?panel=${panel.id}`;
    const orgLabel = panel.recipient_org_name
      ? ` from ${panel.recipient_org_name}`
      : '';

    const html = this.buildEmail(
      `<p><strong>${panel.recipient_name}</strong>${orgLabel} has <strong>declined</strong> the offer panel you sent.</p>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
        <p><strong>Panel:</strong> ${panel.title}</p>
        <p><strong>Recipient:</strong> ${panel.recipient_name} (${panel.recipient_email})</p>
      </div>
      <div style="text-align: left; margin: 30px 0;">
        <a href="${panelUrl}" class="cta-button">View Offer Panel</a>
      </div>`,
      theme,
    );
    const tplDeclined = await this.getTplContent(
      'offer-panel-declined',
      {
        '{{recipientName}}': panel.recipient_name || '',
        '{{recipientOrg}}': panel.recipient_org_name || 'N/A',
        '{{recipientEmail}}': panel.recipient_email || '',
        '{{panelTitle}}': panel.title || '',
      },
      theme,
      panel.business_unit,
    );

    return this.mail.sendMail({
      from: `${theme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
      to: panel.createdBy.email,
      subject: tplDeclined?.subject ?? `Your offer was declined`,
      html: tplDeclined?.html ?? html,
    });
  }
}
