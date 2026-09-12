import { getEmailFooter, getEmailLogoCss, getEmailLogoImg } from './components';
import { escapeEmailHtml } from './escape';
import { EmailTheme } from './theme';

export interface OfferPanelReportRow {
  panelId: string;
  title: string;
  recipientLabel: string;
  recipientSub: string;
  businessUnit: string;
  status: string;
  isPublic: boolean;
  candidateCount: number;
  createdAtLabel: string;
  viewedAtLabel: string | null;
  decidedAtLabel: string | null;
  timeToViewLabel: string | null;
  timeToDecisionLabel: string | null;
  viewCount: number;
}

export interface OfferPanelReportSection {
  creatorId: string;
  creatorName: string;
  creatorEmail: string;
  panels: OfferPanelReportRow[];
}

export interface OfferPanelWeeklyReportPayload {
  weekStartLabel: string;
  weekEndLabel: string;
  generatedAtLabel: string;
  totalPanels: number;
  totalCreators: number;
  statusTotals: {
    sent: number;
    viewed: number;
    accepted: number;
    declined: number;
  };
  sections: OfferPanelReportSection[];
  offScheduleNote: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  sent: '#6c757d',
  viewed: '#0d6efd',
  accepted: '#198754',
  declined: '#dc3545',
};

// This report renders more free-text, user-controlled data (org names, panel
// titles, recipient names) than any other email in the codebase, so every
// interpolated DB string is escaped before it reaches the markup.
const esc = escapeEmailHtml;

const EMPTY_CELL = '<span style="color:#999999;">&mdash;</span>';

function statusPill(status: string): string {
  const color = STATUS_COLORS[status] ?? '#6c757d';
  const label = status.charAt(0).toUpperCase() + status.slice(1);

  return `<span class="status-pill" style="background-color:${color};">${esc(label)}</span>`;
}

// Timestamp on the first line, elapsed-since-creation on a muted second line.
function trackerCell(label: string | null, elapsed: string | null): string {
  if (!label) return EMPTY_CELL;

  const elapsedLine = elapsed
    ? `<div style="font-size:11px;color:#888888;">+${esc(elapsed)}</div>`
    : '';

  return `${esc(label)}${elapsedLine}`;
}

function renderRow(row: OfferPanelReportRow): string {
  const publicChip = row.isPublic
    ? '<div style="font-size:11px;color:#888888;">Public link</div>'
    : '';

  const repeatViews =
    row.viewCount > 1
      ? ` <span style="font-size:11px;color:#888888;">(&times;${row.viewCount})</span>`
      : '';

  return `
    <tr>
      <td>
        <strong>${esc(row.recipientLabel)}</strong>
        <div style="font-size:12px;color:#888888;">${esc(row.recipientSub)}</div>
        <div style="font-size:12px;color:#555555;">${esc(row.title)}</div>
        ${publicChip}
      </td>
      <td>${esc(row.businessUnit)}</td>
      <td style="text-align:center;">${row.candidateCount}</td>
      <td>${statusPill(row.status)}</td>
      <td>${esc(row.createdAtLabel)}</td>
      <td>${trackerCell(row.viewedAtLabel, row.timeToViewLabel)}${repeatViews}</td>
      <td>${trackerCell(row.decidedAtLabel, row.timeToDecisionLabel)}</td>
    </tr>`;
}

function renderSection(section: OfferPanelReportSection): string {
  const count = section.panels.length;

  return `
    <h3 class="creator-header">
      ${esc(section.creatorName)}
      <span class="creator-count">${count} panel${count !== 1 ? 's' : ''}</span>
    </h3>
    <table class="summary-table">
      <thead>
        <tr>
          <th>Recipient</th>
          <th>Business Unit</th>
          <th style="text-align:center;">Candidates</th>
          <th>Status</th>
          <th>Created</th>
          <th>Viewed</th>
          <th>Decided</th>
        </tr>
      </thead>
      <tbody>
        ${section.panels.map(renderRow).join('')}
      </tbody>
    </table>`;
}

export default function offerPanelWeeklyReport(
  payload: OfferPanelWeeklyReportPayload,
  theme?: EmailTheme,
): string {
  const primaryColor = theme?.primaryColor || '#01546B';
  const primaryColorHover = theme?.primaryColorHover || '#013A4F';
  const companyName = theme?.companyName || 'MedVirtual';
  const buttonColor = theme?.buttonColor || primaryColor;
  const buttonTextColor = theme?.buttonTextColor || '#ffffff';
  // Fall back to the production URL when FRONTEND_URL is unset (e.g. CI) so the
  // CTA never renders a literal "undefined/offer-panels" link — matching the
  // defensive `FRONTEND_URL || ...` pattern used elsewhere (email-test.service).
  const frontendUrl = (
    process.env.FRONTEND_URL || 'https://app.medvirtual.ai'
  ).replace(/\/+$/, '');
  const ctaLink = `${frontendUrl}/offer-panels`;

  const { sent, viewed, accepted, declined } = payload.statusTotals;

  const offScheduleBlock = payload.offScheduleNote
    ? `<div class="notice-box">${esc(payload.offScheduleNote)}</div>`
    : '';

  const body = payload.sections.length
    ? payload.sections.map(renderSection).join('')
    : `<div class="empty-state">
         No offer panels were created between ${esc(payload.weekStartLabel)} and ${esc(payload.weekEndLabel)}.
       </div>`;

  const ctaBlock = payload.sections.length
    ? `<div style="text-align:left;margin:30px 0;">
         <a href="${ctaLink}" class="cta-button">View Offer Panels</a>
       </div>`
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Offer Panel Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
    .email-wrapper { background-color: #f4f4f4; padding: 20px; min-height: 100vh; }
    .container { max-width: 860px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
    .content { padding: 40px 30px; }
${getEmailLogoCss()}
    .main-message { color: #333333; font-size: 16px; line-height: 1.5; margin-bottom: 20px; }
    .summary-table { width: 100%; border-collapse: collapse; margin: 12px 0 32px 0; font-size: 13px; }
    .summary-table th { background-color: #f4f4f4; color: #555555; font-weight: 600; padding: 10px 8px; text-align: left; border-bottom: 2px solid #e0e0e0; }
    .summary-table td { padding: 10px 8px; border-bottom: 1px solid #e9ecef; color: #333333; vertical-align: top; }
    .summary-table tr:last-child td { border-bottom: none; }
    .highlight-box { background-color: #f0faf8; border-left: 4px solid ${primaryColor}; padding: 14px 18px; border-radius: 4px; margin: 24px 0; }
    .highlight-box .amount { font-size: 22px; font-weight: 700; color: ${primaryColor}; }
    .highlight-box .label { font-size: 13px; color: #666666; margin-top: 2px; }
    .notice-box { background-color: #fff8e6; border-left: 4px solid #f0ad4e; padding: 12px 18px; border-radius: 4px; margin: 20px 0; font-size: 14px; color: #6b5300; }
    .empty-state { background-color: #f8f9fa; border-radius: 6px; padding: 28px; text-align: center; color: #666666; font-size: 15px; }
    .creator-header { color: ${primaryColor}; font-size: 16px; margin: 28px 0 0 0; padding-bottom: 6px; border-bottom: 2px solid #e9ecef; }
    .creator-count { color: #888888; font-size: 13px; font-weight: 500; }
    .status-pill { display: inline-block; color: #ffffff; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 12px; white-space: nowrap; }
    .cta-button { display: inline-block; background-color: ${buttonColor}; color: ${buttonTextColor} !important; padding: 14px 28px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; margin: 20px 0; }
    .cta-button:hover { background-color: ${primaryColorHover}; }
    .closing { color: #333333; font-size: 16px; margin: 30px 0 10px 0; }
    .sender { color: #333333; font-size: 16px; }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="container">
      <div class="content">
        <div class="logo">
          ${getEmailLogoImg(theme)}
        </div>
        ${offScheduleBlock}
        <div class="main-message">
          <p>Offer panel activity for <strong>${esc(payload.weekStartLabel)}</strong> through <strong>${esc(payload.weekEndLabel)}</strong> (America/Los_Angeles).</p>
        </div>
        <div class="highlight-box">
          <div class="amount">${payload.totalPanels}</div>
          <div class="label">
            Panel${payload.totalPanels !== 1 ? 's' : ''} created by ${payload.totalCreators} user${payload.totalCreators !== 1 ? 's' : ''}
            &nbsp;&middot;&nbsp; Sent ${sent} &nbsp;&middot;&nbsp; Viewed ${viewed} &nbsp;&middot;&nbsp; Accepted ${accepted} &nbsp;&middot;&nbsp; Declined ${declined}
          </div>
        </div>
        ${body}
        ${ctaBlock}
        <div class="closing">Best,</div>
        <div class="sender"><strong>${esc(companyName)}</strong> team</div>
        <div style="color:#999999;font-size:12px;margin-top:24px;">Generated ${esc(payload.generatedAtLabel)}</div>
      </div>
      ${getEmailFooter(theme)}
    </div>
  </div>
</body>
</html>
`;
}
