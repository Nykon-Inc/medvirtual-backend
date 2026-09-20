import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

// ts-node does not load .env on its own (unlike `nest start`, which goes
// through @nestjs/config) — without this, process.env.DATABASE_URL is
// undefined here and Prisma silently falls back to whatever URL was baked
// in at the last `prisma generate`, which can point at the wrong database.
dotenv.config();

const prisma = new PrismaClient();

// Hide credentials, show which database this run will actually write to.
const getHost = (url?: string) => {
  if (!url) return 'undefined';
  const parts = url.split('@');
  return parts.length > 1 ? parts[1] : url;
};
console.log(`🌱 Seeding target: ${getHost(process.env.PROD_DATABASE_URL)}`);

async function main() {
  // ─── Business Units ──────────────────────────────────────────────────────────
  // Multi Business Unit (MMVA): BU intake is HubSpot-only — this seed only
  // guarantees the 3 BUs we know about today exist with correct app branding.
  // `hubspot_value` must match the exact label of the HubSpot `business_unit`
  // company property option. `is_visible` gates whether the BU is allowed to
  // operate (see requirements.md — isAllowedHubspotValue).
  const businessUnits = [
    {
      slug: 'medvirtual',
      name: 'MedVirtual',
      hubspot_value: 'MedVirtual',
      candidate_pool: 'medical',
      is_visible: true,
      primary_color: '#077999',
      primary_hover: '#065f7a',
      logo_url: 'https://staging.medvirtual.ai/logo.png',
      favicon_url: 'https://staging.medvirtual.ai/favicon.ico',
    },
    {
      slug: 'berry-virtual',
      name: 'Berry Virtual',
      hubspot_value: 'Berry Virtual',
      candidate_pool: 'non_medical',
      is_visible: true,
      primary_color: '#FD7171',
      primary_hover: '#e55a5a',
      logo_url: 'https://staging.medvirtual.ai/logobv.png',
      favicon_url: 'https://staging.medvirtual.ai/faviconbv.ico',
    },
    {
      // MMVA (My Medical VA) — 3rd BU, dormant until a super-admin activates it
      // from the Business Unit Management screen (triggers reactivation + backfill).
      // NOTE: final color is a Phase-0 stakeholder input — #7C3AED is a placeholder violet.
      slug: 'mmva',
      name: 'My Medical VA',
      hubspot_value: 'MMVA',
      candidate_pool: 'medical',
      is_visible: false,
      primary_color: '#7C3AED',
      primary_hover: '#6d28d9',
      logo_url: 'https://staging.medvirtual.ai/logommva.png',
      favicon_url: 'https://staging.medvirtual.ai/faviconmmva.ico',
    },
  ];

  for (const bu of businessUnits) {
    await prisma.businessUnit.upsert({
      where: { slug: bu.slug },
      update: {
        name: bu.name,
        hubspot_value: bu.hubspot_value,
        candidate_pool: bu.candidate_pool,
        is_visible: bu.is_visible,
        primary_color: bu.primary_color,
        primary_hover: bu.primary_hover,
        logo_url: bu.logo_url,
        favicon_url: bu.favicon_url,
      },
      create: {
        slug: bu.slug,
        name: bu.name,
        hubspot_value: bu.hubspot_value,
        candidate_pool: bu.candidate_pool,
        is_visible: bu.is_visible,
        primary_color: bu.primary_color,
        primary_hover: bu.primary_hover,
        logo_url: bu.logo_url,
        favicon_url: bu.favicon_url,
      },
    });
  }

  console.log(`🏢 BusinessUnits seeded: ${businessUnits.length}`);

  // ─── Email Branding ───────────────────────────────────────────────────────────
  const brandings = [
    {
      business_unit: 'medvirtual',
      primary_color: '#01546B',
      secondary_color: '#013A4F',
      logo_url: 'https://staging.medvirtual.ai/logo.png',
      company_name: 'MedVirtual',
      layout_preset: 'default',
    },
    {
      business_unit: 'berry-virtual',
      primary_color: '#FD7171',
      secondary_color: '#E55A5A',
      logo_url: 'https://staging.medvirtual.ai/logobv.png',
      company_name: 'Berry Virtual',
      layout_preset: 'default',
    },
    {
      // Placeholder default branding row for MMVA — matches the app violet
      // placeholder above; will be refined once Phase-0 stakeholder inputs land.
      business_unit: 'mmva',
      primary_color: '#7C3AED',
      secondary_color: '#6D28D9',
      logo_url: 'https://staging.medvirtual.ai/logommva.png',
      company_name: 'My Medical VA',
      layout_preset: 'default',
    },
  ];

  for (const branding of brandings) {
    await prisma.emailBranding.upsert({
      where: { business_unit: branding.business_unit },
      update: {},
      create: branding,
    });
  }

  console.log(`🎨 EmailBranding seeded: ${brandings.length}`);

  // ─── Email Templates ─────────────────────────────────────────────────────────
  // business_unit: null = global template (applies to all BUs)
  // The loop below uses findFirst + create/update so the seed is safe to run
  // on both empty and already-populated databases (idempotent).
  const emailTemplates = [
    // ── Auth / Signup / Recovery ───────────────────────────────────────────
    {
      key: 'invite-signup',
      name: 'User Invitation',
      description: 'Sent when a user is invited to the platform.',
      subject: '{{companyName}} Platform Invitation',
      headline: 'Hi,',
      body: 'You have been invited to join the {{companyName}} platform. Please click the button below to easily and securely activate your account.\n\nOnce activated, you can manage your hired staff, submit new hire requests, and explore our candidate pool to source the right support for your team.\n\n⏰ Important: This invitation will expire in 48 hours for security reasons.',
      button_label: 'Activate My Account',
      button_url: '{{inviteLink}}',
      placeholders: ['{{inviteLink}}', '{{companyName}}'],
    },
    // ── Auth / Signup / Recovery ─────────────────────────────────────────────
    {
      key: 'reset-password',
      name: 'Password Reset',
      description: 'Sent when a user requests a password reset.',
      subject: 'Password Reset - {{companyName}} Platform',
      headline: 'Hi {{userName}},',
      body: "We received a request to reset your password for your {{companyName}} account. Just click the button below to easily and securely create a new password :)\n\n⏰ Important: This password reset link will expire in 10 minutes for security reasons.\n\nIf you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.",
      button_label: 'Reset My Password',
      button_url: '{{resetLink}}',
      placeholders: ['{{userName}}', '{{resetLink}}', '{{companyName}}'],
    },
    {
      key: 'verification-code',
      name: 'Email Verification Code',
      description: 'Sent with the OTP code during account sign-up.',
      subject: 'Verify Your {{companyName}} Account',
      headline: 'Hi,',
      body: 'Here is your verification code. Just enter the code below to easily and securely verify your account :)\n\nYour code: {{verificationCode}}\n\n⏰ Important: This code will expire in 10 minutes for security reasons.',
      button_label: 'Verify Account',
      button_url: '{{verificationUrl}}',
      placeholders: [
        '{{verificationCode}}',
        '{{verificationUrl}}',
        '{{companyName}}',
      ],
    },
    {
      key: 'schedule-interview',
      name: 'Schedule Interview',
      description: 'Sent to invite a candidate to schedule an interview.',
      subject: '{{companyName}} Platform Invitation',
      headline: 'Hi,',
      body: 'You have been invited to join our healthcare platform. Just click the button below to easily and securely create your account :)\n\n⏰ Important: This invitation will expire in 48 hours for security reasons.',
      button_label: 'Activate My Account',
      button_url: '{{inviteLink}}',
      placeholders: ['{{inviteLink}}', '{{companyName}}'],
    },
    // ── Med Alliance — invite ────────────────────────────────────────────────
    {
      key: 'med-alliance-invite-signup',
      name: 'Med Alliance — Affiliate Invitation (New User)',
      description:
        'Sent to invite a new affiliate to the Med Alliance program (requires account setup).',
      subject: 'Med Alliance Partner Account Setup',
      headline: 'Hello, {{firstName}}!',
      body: "Thank you for becoming a {{companyName}} Alliance Partner. Please click the button below to securely set your password and activate your account.\n\nOnce you're in, you can refer clients, track your referral status, and manage your commissions all in one place.\n\nYou'll also have access to our talent pool if you'd like to recommend specific virtual staff to your referrals.\n\nImportant: This invitation expires in 48 hours. If it has expired, contact our support team to request a new one.",
      button_label: 'Activate My Account and Get Started',
      button_url: '{{inviteLink}}',
      placeholders: ['{{inviteLink}}', '{{firstName}}', '{{companyName}}'],
    },
    {
      key: 'med-alliance-invitation',
      name: 'Med Alliance — Partner Invitation (Existing User)',
      description:
        'Sent to existing users invited to become Med Alliance partners.',
      subject: "You've been invited to join the Med Alliance Program",
      headline: 'Hello, {{firstName}}!',
      body: "Great news — you have been added to the Med Alliance Program by {{companyName}}.\n\nAs a Med Alliance Partner, your dashboard is ready. Here's what you now have access to:\n- Commission earnings on every successful referral\n- A dedicated partner dashboard with real-time tracking\n- Transparent payout history and on-demand payout requests\n- Full visibility into the organizations you've referred\n\nYour partner profile is active. Log in to start tracking your referrals and commissions.\n\nIf you have any questions, please contact our support team.",
      button_label: 'Go to My Partner Dashboard',
      button_url: '{{platformUrl}}',
      placeholders: ['{{firstName}}', '{{companyName}}', '{{platformUrl}}'],
    },
    {
      key: 'med-alliance-org-invitation',
      name: 'Med Alliance — Organization User Invitation',
      description:
        'Sent to organization users enrolled in the Med Alliance program.',
      subject: "You've been invited to join the Med Alliance Program",
      headline: 'Hello, {{firstName}}!',
      body: "Your Med Alliance Partner profile is now active.\n\nBy joining the Med Alliance Program with {{companyName}}, you've unlocked a new revenue stream directly from your existing network. Here's what's available to you right now:\n- Commission earnings on every successful referral you make\n- A dedicated partner dashboard with real-time referral tracking\n- Transparent payout history and on-demand payout requests\n- Full visibility into the organizations you've referred\n\nYour dashboard is live — head over to review your partner profile and start sharing your referral link.\n\nIf you have any questions, please contact our support team.",
      button_label: 'View My Partner Dashboard',
      button_url: '{{platformUrl}}',
      placeholders: ['{{firstName}}', '{{companyName}}', '{{platformUrl}}'],
    },
    // ── Hire Requests ────────────────────────────────────────────────────────
    {
      key: 'hr-placement-completed',
      name: 'Hire Request — Placement Completed',
      description:
        'Sent to assignees when a hire request is marked as placement completed.',
      subject: 'Placement completed: {{hrTitle}}',
      headline: 'Placement Completed',
      body: 'The hire request has been marked as placement completed.\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}\nSalary Range: {{salaryRange}}\nExpected Start Date: {{startDate}}\n\nSelected Candidates:\n{{selectedCandidates}}\n\nPlease proceed with onboarding steps.',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{salaryRange}}',
        '{{startDate}}',
        '{{selectedCandidates}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-interview-scheduled',
      name: 'Hire Request — Interview Scheduled',
      description:
        'Sent to all active organization users when an interview is scheduled.',
      subject: 'Interview Invite: {{roleType}} - {{availability}}',
      headline: 'You have been invited to an Interview.',
      body: 'Title: {{hrTitle}}\nCompany: {{orgName}}\nExpected Start Date: {{startDate}}\nPairing Date: {{interviewDate}}\n{{pairingLinkLine}}',
      button_label: '{{ctaLabel}}',
      button_url: '{{ctaUrl}}',
      placeholders: [
        '{{roleType}}',
        '{{availability}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{startDate}}',
        '{{interviewDate}}',
        '{{pairingLinkLine}}',
        '{{ctaLabel}}',
        '{{ctaUrl}}',
      ],
    },
    {
      key: 'hr-client-change',
      name: 'Hire Request — Edited or Canceled by Client',
      description:
        'Sent to assignees when a client edits or cancels a hire request.',
      subject: 'Hire Request {{action}}: {{hrTitle}}',
      headline: 'Hire Request {{actionUpper}}',
      body: 'The hire request was {{action}} by the client.\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{action}}',
        '{{actionUpper}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-sourcing-assigned',
      name: 'Hire Request — Sourcing Assigned',
      description:
        'Sent to the assigned sourcer when a hire request moves to sourcing stage.',
      subject: 'Hire Request sourcing: {{hrTitle}}',
      headline: 'Hire Request Moved to Sourcing',
      body: 'Hi {{assigneeName}},\n\nThe hire request was updated to Start to sourcing stage.\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{assigneeName}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-concierge-assigned',
      name: 'Hire Request — Ready for Review',
      description:
        'Sent to assignees when a hire request is ready for concierge review.',
      subject: 'Hire Request For Review: {{hrTitle}}',
      headline: 'Hire Request Ready For Review',
      body: 'Hi {{assigneeName}},\n\nThis request requires your attention:\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{assigneeName}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-created',
      name: 'Hire Request — Assigned to User',
      description: 'Sent when a hire request is created and assigned.',
      subject: 'Hire Request Assigned: {{hrTitle}}',
      headline: '{{assignmentType}}',
      body: 'Hi {{assigneeName}},\n\nYou have been assigned {{assignmentRole}} this hire request:\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}\nAvailability: {{availability}}\nSalary Range: {{salaryRange}}\nExpected Start Date: {{startDate}}\nStatus: {{hrStatus}}\n\nPlease review the details and take appropriate action.',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{assigneeName}}',
        '{{assignmentType}}',
        '{{assignmentRole}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{availability}}',
        '{{salaryRange}}',
        '{{startDate}}',
        '{{hrStatus}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-back-to-sourcing',
      name: 'Hire Request — Back to Sourcing',
      description:
        'Sent to the assigned sourcer when a hire request is sent back to sourcing.',
      subject: 'Hire Request Back to sourcing: {{hrTitle}}',
      headline: 'Back to Sourcing',
      body: 'Hi {{assigneeName}},\n\nA hire request requires your attention since it has been put back to sourcing:\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}\nAvailability: {{availability}}\nSalary Range: {{salaryRange}}\nExpected Start Date: {{startDate}}\nStatus: {{hrStatus}}\n\nPlease review the details and take appropriate action.',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{assigneeName}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{availability}}',
        '{{salaryRange}}',
        '{{startDate}}',
        '{{hrStatus}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-panel-ready-client',
      name: 'Hire Request — Candidate Panel Ready (Client)',
      description:
        'Sent to all active organization users when the candidate panel is ready for their review.',
      subject: 'Your candidate panel is ready: {{hrTitle}}',
      headline: 'Your candidate panel is ready for review!',
      body: 'The panel for the following hire request has been reviewed and is now ready for your follow-up:\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}\nAvailability: {{availability}}\nSalary Range: {{salaryRange}}\nExpected Start Date: {{startDate}}\n\nPlease review the details and candidates within this panel.',
      button_label: 'View Candidates',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{availability}}',
        '{{salaryRange}}',
        '{{startDate}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-panel-ready-internal',
      name: 'Hire Request — Panel Reviewed and Ready (Internal)',
      description:
        'Sent to the assigned sourcer when the panel has been reviewed and is ready.',
      subject: 'Panel Reviewed and Ready: {{hrTitle}}',
      headline: 'Panel Ready',
      body: 'Hi {{assigneeName}},\n\nThe panel of the following hire request has been reviewed and now it is ready:\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}\nAvailability: {{availability}}\nSalary Range: {{salaryRange}}\nExpected Start Date: {{startDate}}\nStatus: {{hrStatus}}\n\nPlease review the details and take appropriate action.',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{assigneeName}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{availability}}',
        '{{salaryRange}}',
        '{{startDate}}',
        '{{hrStatus}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-candidates-endorsed',
      name: 'Hire Request — New Candidates Endorsed',
      description:
        'Sent to assignees when new candidates are added to a hire request.',
      subject: 'New candidates in Hire Request: {{hrTitle}}',
      headline: 'New Candidates in Hire Request',
      body: 'Hi {{assigneeName}},\n\nThe hire request received new candidates.\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{assigneeName}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-panel-candidate-blocked',
      name: 'Hire Request — Panel Candidate Addition Blocked (48h Lead Time)',
      description:
        'Sent to assignees when a client user is blocked from adding candidates to a panel because the scheduled interview is less than 48 hours away.',
      subject: 'Action needed: candidate addition blocked on {{hrTitle}}',
      headline: 'Candidate Addition Blocked',
      body: 'Hello,\n\n{{attemptedByName}} tried to add the following candidate(s) to a panel, but the action was blocked because the scheduled interview is less than 48 hours away:\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nCandidate(s): {{candidateNames}}',
      button_label: 'View Hire Request Details',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{attemptedByName}}',
        '{{candidateNames}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-winner-selected',
      name: 'Hire Request — Completed (Winner Selected)',
      description:
        'Sent to organization admins when a candidate is selected and the hire request is completed.',
      subject: 'Hire Request Completed: {{roleType}} - {{availability}}.',
      headline: 'Hire Request Completed',
      body: 'Your hire request has been completed.\n\nTitle: {{hrTitle}}\nOrganization: {{orgName}}\nDescription: {{hrDescription}}\nSalary Range: {{salaryRange}}\nExpected Start Date: {{startDate}}\nSelected Candidate: {{winnerName}}\n\nPlease review the details and proceed with the next steps.',
      button_label: 'Review Hire Request',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{roleType}}',
        '{{availability}}',
        '{{hrTitle}}',
        '{{orgName}}',
        '{{hrDescription}}',
        '{{salaryRange}}',
        '{{startDate}}',
        '{{winnerName}}',
        '{{hrLink}}',
      ],
    },
    {
      key: 'hr-awaiting-decision',
      name: 'Hire Request — Awaiting Decision',
      description:
        'Sent to organization admins when a hire request is marked as awaiting decision.',
      subject:
        'Your hire request has been marked as awaiting decision: {{roleType}} - {{availability}}',
      headline: 'Hire Request Awaiting Decision',
      body: 'Your hire request has been marked as awaiting decision.\n\nScheduled Date: {{scheduledDate}}\n\nPlease review and make your decision.',
      button_label: 'Review Hire Request',
      button_url: '{{hrLink}}',
      placeholders: [
        '{{roleType}}',
        '{{availability}}',
        '{{scheduledDate}}',
        '{{hrLink}}',
      ],
    },
    // ── Tickets ──────────────────────────────────────────────────────────────
    {
      key: 'ticket-status-changed',
      name: 'Ticket — Status Changed',
      description: 'Sent to the ticket creator when the ticket status changes.',
      subject: 'Your ticket changed to {{status}} status: {{ticketTitle}}',
      headline: 'Ticket Status Updated',
      body: 'Your ticket has been updated to {{status}} status.\n\nTitle: {{ticketTitle}}\nOrganization: {{orgName}}\nType: {{ticketType}}\nStatus: {{status}}\nCreated: {{createdDate}}\n\nDescription:\n{{ticketDescription}}',
      button_label: 'View Ticket Details',
      button_url: '{{ticketLink}}',
      placeholders: [
        '{{status}}',
        '{{ticketTitle}}',
        '{{orgName}}',
        '{{ticketType}}',
        '{{createdDate}}',
        '{{ticketDescription}}',
        '{{ticketLink}}',
      ],
    },
    {
      key: 'ticket-reopened',
      name: 'Ticket — Reopened',
      description: 'Sent to the ticket creator when a ticket is reopened.',
      subject: 'Your ticket has been reopened: {{ticketTitle}}',
      headline: 'Ticket Reopened',
      body: 'Your ticket has been reopened.\n\nTitle: {{ticketTitle}}\nOrganization: {{orgName}}\nType: {{ticketType}}\nCreated: {{createdDate}}\n\nDescription:\n{{ticketDescription}}',
      button_label: 'View Ticket Details',
      button_url: '{{ticketLink}}',
      placeholders: [
        '{{ticketTitle}}',
        '{{orgName}}',
        '{{ticketType}}',
        '{{createdDate}}',
        '{{ticketDescription}}',
        '{{ticketLink}}',
      ],
    },
    {
      key: 'ticket-event',
      name: 'Ticket — Event Notification',
      description:
        'Sent when a ticket event occurs (created, assigned, updated, resolved, closed).',
      subject: 'Ticket {{event}}: {{ticketTitle}}',
      headline: 'Ticket {{event}}',
      body: 'A ticket has been {{event}}.\n\nTitle: {{ticketTitle}}\nOrganization: {{orgName}}\nType: {{ticketType}}\nDescription:\n{{ticketDescription}}',
      button_label: 'View Ticket Details',
      button_url: '{{ticketLink}}',
      placeholders: [
        '{{event}}',
        '{{ticketTitle}}',
        '{{orgName}}',
        '{{ticketType}}',
        '{{ticketDescription}}',
        '{{ticketLink}}',
      ],
    },
    {
      key: 'ticket-created-admin',
      name: 'Ticket — Created (Admin)',
      description:
        'Sent to system admins when a new ticket is created, with the admin-oriented layout.',
      subject: '{{emailTitle}}',
      headline: '{{emailTitle}}',
      body: 'Type: {{ticketType}}\nTitle: {{ticketTitle}}\nOrganization: {{orgName}}\n{{staffLine}}{{candidateLine}}{{descriptionBlock}}',
      button_label: 'View Ticket Details',
      button_url: '{{ticketLink}}',
      placeholders: [
        '{{emailTitle}}',
        '{{ticketType}}',
        '{{ticketTitle}}',
        '{{orgName}}',
        '{{staffLine}}',
        '{{candidateLine}}',
        '{{descriptionBlock}}',
        '{{ticketLink}}',
      ],
    },
    {
      key: 'ticket-assigned',
      name: 'Ticket — Assigned',
      description:
        'Sent to the assignee/creator when a ticket is assigned via the Reassign action.',
      subject: 'Ticket assigned: {{ticketTitle}}',
      headline: 'Ticket Assigned',
      body: 'The ticket was assigned.\n\nTitle: {{ticketTitle}}\nOrganization: {{orgName}}\nType: {{ticketType}}\n{{staffLine}}{{candidateLine}}{{descriptionBlock}}',
      button_label: 'View Ticket Details',
      button_url: '{{ticketLink}}',
      placeholders: [
        '{{ticketTitle}}',
        '{{orgName}}',
        '{{ticketType}}',
        '{{staffLine}}',
        '{{candidateLine}}',
        '{{descriptionBlock}}',
        '{{ticketLink}}',
      ],
    },
    {
      key: 'ticket-note-added',
      name: 'Ticket — New Response / Note Added',
      description:
        'Sent to the ticket assignee or creator when a new note/response is added.',
      subject: 'You received a response on your ticket: {{ticketTitle}}',
      headline: 'New Response on Your Ticket',
      body: 'You received a new response on your ticket.\n\nTicket: {{ticketTitle}}\nOrganization: {{orgName}}\nResponse from: {{authorName}}\n\n{{noteContent}}',
      button_label: 'View Ticket Details',
      button_url: '{{ticketLink}}',
      placeholders: [
        '{{ticketTitle}}',
        '{{orgName}}',
        '{{authorName}}',
        '{{noteContent}}',
        '{{ticketLink}}',
      ],
    },
    // ── Offer Panels / Talent Pool ────────────────────────────────────────────
    {
      key: 'offer-panel-created',
      name: 'Offer Panel — Candidates Selected for You',
      description:
        'Sent to the client when candidates are pre-selected in an offer panel.',
      subject: '{{candidateLabel}} picked for you — {{companyName}}',
      headline: 'Candidates selected for you',
      // {{candidateCards}} expands to the pre-rendered candidate grid. Remove it
      // and the email still sends — just without the cards.
      body: 'Hi,\n\n{{createdByName}} from {{companyName}} has handpicked {{candidateCount}} candidate(s) specifically for you.\n\n{{offerTitle}}\n{{offerDescription}}\n\n{{candidateCards}}\nReview them at your convenience and let us know your thoughts.',
      button_label: 'View Candidates',
      button_url: '{{panelLink}}',
      placeholders: [
        '{{candidateLabel}}',
        '{{companyName}}',
        '{{createdByName}}',
        '{{candidateCount}}',
        '{{panelLink}}',
        '{{candidateCards}}',
        '{{offerTitle}}',
        '{{offerDescription}}',
      ],
    },
    {
      key: 'offer-panel-accepted',
      name: 'Offer Panel — Accepted by Client',
      description:
        'Sent to the panel creator when the client accepts the offer panel.',
      subject: 'Your offer was accepted',
      headline: 'Offer Panel Accepted',
      body: 'Great news! Your offer panel has been accepted.\n\nRecipient: {{recipientName}}\nOrganization: {{recipientOrg}}\nEmail: {{recipientEmail}}\nPanel Title: {{panelTitle}}',
      button_label: null,
      button_url: null,
      placeholders: [
        '{{recipientName}}',
        '{{recipientOrg}}',
        '{{recipientEmail}}',
        '{{panelTitle}}',
      ],
    },
    {
      key: 'offer-panel-declined',
      name: 'Offer Panel — Declined by Client',
      description:
        'Sent to the panel creator when the client declines the offer panel.',
      subject: 'Your offer was declined',
      headline: 'Offer Panel Declined',
      body: 'Your offer panel has been declined.\n\nRecipient: {{recipientName}}\nOrganization: {{recipientOrg}}\nEmail: {{recipientEmail}}\nPanel Title: {{panelTitle}}',
      button_label: null,
      button_url: null,
      placeholders: [
        '{{recipientName}}',
        '{{recipientOrg}}',
        '{{recipientEmail}}',
        '{{panelTitle}}',
      ],
    },
    {
      key: 'talent-pool-lead-new',
      name: 'Talent Pool — New Lead',
      description:
        'Sent to the owner when a new lead is submitted via the talent pool.',
      subject: 'New talent pool lead: {{leadName}} — {{organization}}',
      headline: 'New Talent Pool Lead',
      body: 'A new lead has been submitted via the talent pool.\n\nName: {{leadName}}\nEmail: {{leadEmail}}\nOrganization: {{organization}}\nWebsite: {{websiteUrl}}\nLanguage Preference: {{languagePreference}}\nMain Need: {{mainNeed}}\nAdditional Details: {{additionalDetails}}',
      button_label: null,
      button_url: null,
      placeholders: [
        '{{leadName}}',
        '{{leadEmail}}',
        '{{organization}}',
        '{{websiteUrl}}',
        '{{languagePreference}}',
        '{{mainNeed}}',
        '{{additionalDetails}}',
      ],
    },
    // ── Med Alliance — Affiliate (partner-facing) ────────────────────────────
    {
      key: 'alliance-commission-eligible',
      name: 'Med Alliance — Commission Eligible',
      description:
        'Sent to the affiliate when a commission becomes eligible for payout.',
      subject:
        'Your commission is ready — ${{commissionAmount}} from {{organizationName}}',
      headline: 'Great news! Your commission is now eligible for payout.',
      body: "Hi {{firstName}},\n\nYour commission from {{organizationName}} is now eligible for payout. This means you can request a transfer to your account whenever you're ready.\n\nCommission amount: ${{commissionAmount}}\nCommission rate: {{commissionPercent}}% from {{organizationName}}\n\nHead to your earnings dashboard to request your payout — it only takes a moment.",
      button_label: 'View My Earnings',
      button_url: '{{earningsUrl}}',
      placeholders: [
        '{{firstName}}',
        '{{organizationName}}',
        '{{commissionAmount}}',
        '{{commissionPercent}}',
        '{{earningsUrl}}',
      ],
    },
    {
      key: 'alliance-payout-cancelled',
      name: 'Med Alliance — Payout Cancelled',
      description:
        'Sent to the affiliate when their payout request is cancelled.',
      subject: 'Update on your payout request of ${{totalAmount}}',
      headline: 'Your payout request has been cancelled.',
      body: 'Hi {{firstName}},\n\nWe wanted to let you know that your recent payout request has been cancelled by our team.\n\nCancelled payout amount: ${{totalAmount}}\n\n{{cancellationReason}}\n\nThe good news: all commissions from this request have been returned to your available balance. You can submit a new payout request for them at any time from your dashboard.',
      button_label: 'View My Payouts',
      button_url: '{{payoutsUrl}}',
      placeholders: [
        '{{firstName}}',
        '{{totalAmount}}',
        '{{cancellationReason}}',
        '{{payoutsUrl}}',
      ],
    },
    {
      key: 'alliance-payout-processing',
      name: 'Med Alliance — Payout Processing',
      description:
        'Sent to the affiliate when their payout is being processed.',
      subject: 'Your payout of ${{totalAmount}} is being processed',
      headline:
        "We've received your payout request and it's currently being processed.",
      body: "Hi {{firstName}},\n\nWe've received your payout request and it's currently being processed. You'll receive a confirmation once the payment is on its way.\n\nAmount: ${{totalAmount}}\nSubmitted on: {{processedDate}}\n\nIn the meantime, you can track the status of all your payouts in your partner dashboard.",
      button_label: 'View My Payouts',
      button_url: '{{payoutsUrl}}',
      placeholders: [
        '{{firstName}}',
        '{{totalAmount}}',
        '{{processedDate}}',
        '{{payoutsUrl}}',
      ],
    },
    {
      key: 'alliance-payout-paid',
      name: 'Med Alliance — Payout Sent',
      description: 'Sent to the affiliate when their payout has been sent.',
      subject:
        'Your payout of ${{totalAmount}} has been sent — money is on its way!',
      headline: 'Your payout has been sent!',
      body: "Hi {{firstName}},\n\nThe funds are on their way and should arrive according to your payout method's typical timeline.\n\nAmount sent: ${{totalAmount}}\nSent on: {{paidDate}}\n\nYou can view this payment and your full payout history in your partner dashboard.",
      button_label: 'View My Payouts',
      button_url: '{{payoutsUrl}}',
      placeholders: [
        '{{firstName}}',
        '{{totalAmount}}',
        '{{paidDate}}',
        '{{payoutsUrl}}',
      ],
    },
    {
      key: 'alliance-referral-stage-changed',
      name: 'Med Alliance — Referral Stage Changed',
      description:
        'Sent to the affiliate when a referred company moves to a new pipeline stage.',
      subject: 'Pipeline update: {{organizationName}} is now at "{{newStage}}"',
      headline: '{{organizationName}} has moved to a new stage',
      body: 'Hi {{firstName}},\n\nGood news — {{organizationName}} has progressed to a new stage in the Med Alliance pipeline!\n\nPrevious stage: {{previousStage}}\nNew stage: {{newStage}}\n\nLog in to your partner dashboard to see the full status of all your referred companies and track their progress toward deployment.',
      button_label: 'View My Referrals',
      button_url: '{{referralsUrl}}',
      placeholders: [
        '{{firstName}}',
        '{{organizationName}}',
        '{{previousStage}}',
        '{{newStage}}',
        '{{referralsUrl}}',
      ],
    },
    // ── Med Alliance — Admin (internal) ──────────────────────────────────────
    {
      key: 'med-alliance-multiple-hubspot-matches',
      name: 'Med Alliance — Multiple HubSpot Matches',
      description:
        'Sent to admins when a referral has multiple HubSpot company matches and needs manual review.',
      subject: '[Med Alliance] Multiple HubSpot Matches — Review Required',
      headline: 'Med Alliance — Admin Review Required',
      body: 'A referral requires manual review because multiple HubSpot company records were found.\n\nCompany: {{orgName}}\nOrganization ID: {{organizationId}}\nReferred by: {{affiliateName}}',
      button_label: 'Review this referral',
      button_url: '{{reviewLink}}',
      placeholders: [
        '{{orgName}}',
        '{{organizationId}}',
        '{{affiliateName}}',
        '{{reviewLink}}',
      ],
    },
    {
      key: 'alliance-admin-payout-requested',
      name: 'Med Alliance — Admin: New Payout Request',
      description: 'Sent to admins when an affiliate submits a payout request.',
      subject: 'Payout request from {{affiliateName}} — ${{totalAmount}}',
      headline:
        'A partner has submitted a new payout request that requires your review.',
      body: 'Partner: {{affiliateName}}\nTotal Amount: ${{totalAmount}}\nCommissions Included: {{commissionCount}}\nRequest ID: {{payoutRequestId}}',
      button_label: 'Review Payout Requests',
      button_url: '{{payoutRequestsUrl}}',
      placeholders: [
        '{{affiliateName}}',
        '{{totalAmount}}',
        '{{commissionCount}}',
        '{{payoutRequestId}}',
        '{{payoutRequestsUrl}}',
      ],
    },
    {
      key: 'alliance-admin-commission-pending',
      name: 'Med Alliance — Admin: Commission Pending Review',
      description: 'Sent to admins when a commission is ready for review.',
      subject: 'Commission ready for review — {{organizationName}}',
      headline:
        "A new commission is ready for your review. Please approve or reject it to keep the partner's earnings up to date.",
      body: 'Organization: {{organizationName}}\nAffiliate: {{affiliateName}}\nCommission Amount: ${{commissionAmount}}\nCommission ID: {{commissionId}}',
      button_label: 'Review Commissions',
      button_url: '{{commissionsUrl}}',
      placeholders: [
        '{{organizationName}}',
        '{{affiliateName}}',
        '{{commissionAmount}}',
        '{{commissionId}}',
        '{{commissionsUrl}}',
      ],
    },
    {
      key: 'alliance-admin-commission-reverted',
      name: 'Med Alliance — Admin: Commission Reverted to Pending',
      description:
        'Sent to admins when a commission is reverted back to pending status.',
      subject: 'Commission reverted to Pending — {{organizationName}}',
      headline:
        'An admin has reverted a commission back to pending review. Please check the details below and take action.',
      body: 'Organization: {{organizationName}}\nAffiliate: {{affiliateName}}\nCommission Amount: ${{commissionAmount}}\nCommission ID: {{commissionId}}\nReverted by: {{revertedByName}}',
      button_label: 'Review Commissions',
      button_url: '{{commissionsUrl}}',
      placeholders: [
        '{{organizationName}}',
        '{{affiliateName}}',
        '{{commissionAmount}}',
        '{{commissionId}}',
        '{{revertedByName}}',
        '{{commissionsUrl}}',
      ],
    },
    {
      key: 'alliance-admin-referral-new',
      name: 'Med Alliance — Admin: New Referral',
      description:
        'Sent to admins when a new company is referred through the Med Alliance program.',
      subject: 'New referral: {{organizationName}}',
      headline:
        'A new company has been referred through the Med Alliance program.',
      body: 'Company: {{organizationName}}\nReferred by / Performed by: {{affiliateName}}\nCompany ID: {{referredCompanyId}}',
      button_label: 'View Pipeline',
      button_url: '{{pipelineUrl}}',
      placeholders: [
        '{{organizationName}}',
        '{{affiliateName}}',
        '{{referredCompanyId}}',
        '{{pipelineUrl}}',
      ],
    },
    {
      key: 'alliance-admin-partner-registered',
      name: 'Med Alliance — Admin: New Partner Registered',
      description:
        'Sent to admins when a new Growth Partner joins the Med Alliance program.',
      subject: 'New Alliance partner registered: {{partnerName}}',
      headline: 'A new Growth Partner has joined the Med Alliance program.',
      body: 'Name: {{partnerName}}\nEmail: {{partnerEmail}}\nProfile ID: {{affiliateProfileId}}',
      button_label: 'View Partners',
      button_url: '{{partnersUrl}}',
      placeholders: [
        '{{partnerName}}',
        '{{partnerEmail}}',
        '{{affiliateProfileId}}',
        '{{partnersUrl}}',
      ],
    },
    {
      key: 'alliance-admin-payment-failed',
      name: 'Med Alliance — Admin: Bill.com Payment Failed',
      description: 'Sent to admins when a Bill.com payment fails.',
      subject: 'Bill.com payment failed — {{partnerName}} (${{amount}})',
      headline: 'Action required: a Bill.com payment has failed',
      body: 'A payout payment failed and requires your immediate attention.\n\nPartner: {{partnerName}}\nAmount: ${{amount}}\nBill.com Payment ID: {{billIds}}\nPayout Request ID: {{payoutRequestId}}\nError: {{errorMsg}}',
      button_label: 'Review Payout Requests',
      button_url: '{{payoutRequestsUrl}}',
      placeholders: [
        '{{partnerName}}',
        '{{amount}}',
        '{{billIds}}',
        '{{payoutRequestId}}',
        '{{errorMsg}}',
        '{{payoutRequestsUrl}}',
      ],
    },
    {
      key: 'alliance-admin-remember-me-expired',
      name: 'Med Alliance — Admin: Bill.com Session Expired',
      description:
        'Sent to admins when the Bill.com rememberMeId expires and needs renewal.',
      subject: 'Bill.com rememberMeId expired',
      headline: 'Alert: Bill.com rememberMeId has expired (BDC_1109)',
      body: 'The Bill.com rememberMeId stored in the database has expired. All payment initiations are failing because the API session cannot be established with MFA trust.\n\nSteps to resolve:\n1. Call POST /v3/mfa/challenge to trigger an SMS token\n2. Call POST /v3/mfa/challenge/validate with the challengeId\n3. Update the BillComCredential record in the database with the new rememberMeId\n\nNote: The rememberMeId is valid for 180 days from the date of issue.',
      button_label: null,
      button_url: null,
      placeholders: [],
    },
  ];

  // Idempotent upsert: creates new records or updates existing ones.
  // Prisma does not support upsert on composite unique with a nullable field,
  // so we use findFirst + create/update manually.
  let created = 0;
  let updated = 0;
  for (const template of emailTemplates) {
    const existing = await prisma.emailTemplate.findFirst({
      where: { key: template.key, business_unit: null },
      select: { id: true },
    });
    if (existing) {
      await prisma.emailTemplate.update({
        where: { id: existing.id },
        data: {
          name: template.name,
          description: template.description ?? null,
          subject: template.subject,
          headline: template.headline,
          body: template.body,
          button_label: template.button_label ?? null,
          button_url: template.button_url ?? null,
          placeholders: template.placeholders,
        },
      });
      updated++;
    } else {
      await prisma.emailTemplate.create({
        data: {
          key: template.key,
          name: template.name,
          description: template.description ?? null,
          subject: template.subject,
          headline: template.headline,
          body: template.body,
          button_label: template.button_label ?? null,
          button_url: template.button_url ?? null,
          placeholders: template.placeholders,
          business_unit: null,
          is_active: true,
        },
      });
      created++;
    }
  }

  console.log(
    `📧 EmailTemplates: ${created} created, ${updated} updated (total: ${emailTemplates.length})`,
  );
  console.log('✅ Editable Emails seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
