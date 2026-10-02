import {
  getEmailFooter,
  getEmailLogoCss,
  getEmailLogoImg,
} from '../../../common/utils/email-templates/components';
import { EmailTheme } from '../../../common/utils/email-templates/theme';
import { FRONTEND_ROUTES } from '../../../common/utils/frontend-routes';

export interface CommissionSummaryItem {
  commissionId: string;
  organizationName: string;
  affiliateName: string;
  commissionAmount: number;
}

export interface AdminCommissionPendingSummaryPayload {
  commissions: CommissionSummaryItem[];
  totalAmount: number;
  reportDate: Date;
}

export function adminCommissionPendingSummaryTemplate(
  payload: AdminCommissionPendingSummaryPayload,
  theme?: EmailTheme,
): string {
  const primaryColor = theme?.primaryColor || '#01546B';
  const primaryColorHover = theme?.primaryColorHover || '#013A4F';
  const companyName = theme?.companyName || 'MedVirtual';
  const buttonColor = theme?.buttonColor || primaryColor;
  const buttonTextColor = theme?.buttonTextColor || '#ffffff';
  const ctaLink = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminCommissions}`;

  const formattedDate = payload.reportDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const rows = payload.commissions
    .map(
      (c) => `
    <tr>
      <td>${c.organizationName}</td>
      <td>${c.affiliateName}</td>
      <td style="text-align:right;">$${c.commissionAmount.toFixed(2)}</td>
      <td style="font-size:12px;color:#888888;">${c.commissionId}</td>
    </tr>`,
    )
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Daily Commission Review — ${formattedDate}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
    .email-wrapper { background-color: #f4f4f4; padding: 20px; min-height: 100vh; }
    .container { max-width: 640px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
    .content { padding: 40px 30px; }
${getEmailLogoCss()}
    .main-message { color: #333333; font-size: 16px; line-height: 1.5; margin-bottom: 20px; }
    .summary-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
    .summary-table th { background-color: #f4f4f4; color: #555555; font-weight: 600; padding: 10px 8px; text-align: left; border-bottom: 2px solid #e0e0e0; }
    .summary-table th:last-child { text-align: left; }
    .summary-table td { padding: 10px 8px; border-bottom: 1px solid #e9ecef; color: #333333; vertical-align: top; }
    .summary-table tr:last-child td { border-bottom: none; }
    .totals-row { background-color: #f8f8f8; font-weight: 700; font-size: 15px; }
    .totals-row td { padding: 12px 8px; border-top: 2px solid #e0e0e0; }
    .highlight-box { background-color: #f0faf8; border-left: 4px solid ${primaryColor}; padding: 14px 18px; border-radius: 4px; margin: 24px 0; }
    .highlight-box .amount { font-size: 22px; font-weight: 700; color: ${primaryColor}; }
    .highlight-box .label { font-size: 13px; color: #666666; margin-top: 2px; }
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
        <div class="main-message">
          <p>The following <strong>${payload.commissions.length} commission${payload.commissions.length !== 1 ? 's' : ''}</strong> are pending your review as of <strong>${formattedDate}</strong>.</p>
        </div>
        <div class="highlight-box">
          <div class="amount">$${payload.totalAmount.toFixed(2)}</div>
          <div class="label">Total pending review</div>
        </div>
        <table class="summary-table">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Partner</th>
              <th>Amount</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
          <tfoot>
            <tr class="totals-row">
              <td colspan="2">Total</td>
              <td>$${payload.totalAmount.toFixed(2)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
        <div style="text-align: left; margin: 30px 0;">
          <a href="${ctaLink}" class="cta-button">Review Commissions</a>
        </div>
        <div class="closing">Best,</div>
        <div class="sender"><strong>${companyName}</strong> team</div>
      </div>
      ${getEmailFooter(theme)}
    </div>
  </div>
</body>
</html>
`;
}
