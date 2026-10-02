import {
  getEmailFooter,
  getEmailLogoCss,
  getEmailLogoImg,
} from '../../../common/utils/email-templates/components';
import { EmailTheme } from '../../../common/utils/email-templates/theme';
import { FRONTEND_ROUTES } from '../../../common/utils/frontend-routes';

export interface AdminReferredOrgDeletedPayload {
  organizationName: string;
  affiliateName: string;
  commissionsVoided: number;
  commissionsInPendingPayout: number;
}

export function adminReferredOrgDeletedTemplate(
  payload: AdminReferredOrgDeletedPayload,
  theme?: EmailTheme,
): string {
  const primaryColor = theme?.primaryColor || '#01546B';
  const primaryColorHover = theme?.primaryColorHover || '#013A4F';
  const companyName = theme?.companyName || 'MedVirtual';
  const buttonColor = theme?.buttonColor || primaryColor;
  const buttonTextColor = theme?.buttonTextColor || '#ffffff';
  const ctaLink = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPipeline}`;

  const pendingPayoutNotice =
    payload.commissionsInPendingPayout > 0
      ? `<p style="color:#b45309;font-weight:600;">${payload.commissionsInPendingPayout} commission(s) sit inside a pending payout request — a review case was opened so you can decide whether to pay or void them.</p>`
      : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Referred company deleted — ${payload.organizationName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
    .email-wrapper { background-color: #f4f4f4; padding: 20px; min-height: 100vh; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
    .content { padding: 40px 30px; }
${getEmailLogoCss()}
    .main-message { color: #333333; font-size: 16px; line-height: 1.5; margin-bottom: 30px; }
    .detail-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .detail-table td { padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; }
    .detail-table td:first-child { color: #666666; width: 45%; }
    .detail-table td:last-child { font-weight: 600; }
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
          <p>A referred company was deleted in HubSpot. Its Med Alliance data was updated automatically — please review the details below.</p>
          <table class="detail-table">
            <tr><td>Organization</td><td>${payload.organizationName}</td></tr>
            <tr><td>Referred by</td><td>${payload.affiliateName}</td></tr>
            <tr><td>Commissions voided</td><td>${payload.commissionsVoided}</td></tr>
            <tr><td>Commissions in pending payout</td><td>${payload.commissionsInPendingPayout}</td></tr>
          </table>
          ${pendingPayoutNotice}
          <a href="${ctaLink}" class="cta-button">Open Companies Pipeline</a>
        </div>
        <p class="closing">Best regards,</p>
        <p class="sender">The ${companyName} Team</p>
      </div>
      ${getEmailFooter(theme)}
    </div>
  </div>
</body>
</html>
`;
}
