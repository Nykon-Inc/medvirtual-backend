import {
  getEmailFooter,
  getEmailLogoCss,
  getEmailLogoImg,
} from '../../../common/utils/email-templates/components';
import { EmailTheme } from '../../../common/utils/email-templates/theme';
import { FRONTEND_ROUTES } from '../../../common/utils/frontend-routes';

export interface AdminPaymentFailedPayload {
  partnerName: string;
  amount: number;
  billIds: string;
  errorMsg: string;
  payoutRequestId: string;
}

export function adminPaymentFailedTemplate(
  payload: AdminPaymentFailedPayload,
  theme?: EmailTheme,
): string {
  const primaryColor = theme?.primaryColor || '#01546B';
  const primaryColorHover = theme?.primaryColorHover || '#013A4F';
  const companyName = theme?.companyName || 'MedVirtual';
  const buttonColor = theme?.buttonColor || primaryColor;
  const buttonTextColor = theme?.buttonTextColor || '#ffffff';
  const ctaLink = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.allianceAdminPayoutRequests}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bill.com payment failed — ${payload.partnerName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
    .email-wrapper { background-color: #f4f4f4; padding: 20px; min-height: 100vh; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
    .content { padding: 40px 30px; }
${getEmailLogoCss()}
    .main-message { color: #333333; font-size: 16px; line-height: 1.5; margin-bottom: 30px; }
    .alert-banner { background-color: #fff5f5; border-left: 4px solid #e03131; padding: 14px 18px; border-radius: 0 8px 8px 0; margin-bottom: 20px; color: #c92a2a; font-weight: 600; font-size: 15px; }
    .detail-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .detail-table td { padding: 10px 0; border-bottom: 1px solid #e9ecef; font-size: 15px; color: #333333; }
    .detail-table td:first-child { color: #666666; width: 45%; }
    .detail-table td:last-child { font-weight: 600; }
    .error-msg { background-color: #f8f9fa; border-radius: 6px; padding: 12px 16px; font-family: monospace; font-size: 13px; color: #495057; margin-top: 4px; word-break: break-all; }
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
        <div class="alert-banner">Action required: a Bill.com payment has failed</div>
        <div class="main-message">
          <p>A payout payment failed and requires your immediate attention.</p>
          <table class="detail-table">
            <tr><td>Partner</td><td>${payload.partnerName}</td></tr>
            <tr><td>Amount</td><td>$${payload.amount.toFixed(2)}</td></tr>
            <tr><td>Bill.com Payment ID</td><td>${payload.billIds}</td></tr>
            <tr><td>Payout Request ID</td><td>${payload.payoutRequestId}</td></tr>
            <tr>
              <td style="vertical-align: top; padding-top: 12px;">Error</td>
              <td><div class="error-msg">${payload.errorMsg}</div></td>
            </tr>
          </table>
        </div>
        <div style="text-align: left; margin: 30px 0;">
          <a href="${ctaLink}" class="cta-button">Review Payout Requests</a>
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
