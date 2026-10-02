import { getEmailFooter, getEmailLogoCss, getEmailLogoImg } from './components';
import { EmailTheme } from './theme';
import { FRONTEND_ROUTES } from '../frontend-routes';

export function MedAllianceInvitation(
  firstName: string,
  theme?: EmailTheme,
): string {
  const primaryColor = theme?.primaryColor || '#01546B';
  const primaryColorHover = theme?.primaryColorHover || '#013A4F';
  const companyName = theme?.companyName || 'MedVirtual';
  const buttonColor = theme?.buttonColor || primaryColor;
  const buttonTextColor = theme?.buttonTextColor || '#ffffff';
  const ctaLink = `${process.env.FRONTEND_URL}${FRONTEND_ROUTES.alliance}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You've been invited to join the Med Alliance Program</title>
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
      min-height: 100vh;
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
      background-color: ${primaryColorHover};
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
    .note {
      color: #666666;
      font-size: 14px;
      margin-top: 20px;
      line-height: 1.5;
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

        <div class="greeting">Hello, ${firstName}!</div>

        <div class="main-message">
          <p>Great news — you have been added to the <strong>Med Alliance Program</strong> by ${companyName}.</p>
          <p>As a Med Alliance Partner, your dashboard is ready. Here's what you now have access to:</p>
          <ul style="margin: 16px 0; padding-left: 20px; line-height: 2;">
            <li>Commission earnings on every successful referral</li>
            <li>A dedicated partner dashboard with real-time tracking</li>
            <li>Transparent payout history and on-demand payout requests</li>
            <li>Full visibility into the organizations you've referred</li>
          </ul>
          <p>Your partner profile is active. Log in to start tracking your referrals and commissions.</p>
        </div>

        <div style="text-align: left; margin: 30px 0;">
          <a href="${ctaLink}" class="cta-button">
            Go to My Partner Dashboard
          </a>
        </div>

        <p class="note">If you have any questions, please contact our support team.</p>

        <div class="closing">Best,</div>
        <div class="sender">
          <strong>${companyName}</strong> team
        </div>
      </div>
      ${getEmailFooter(theme)}
    </div>
  </div>
</body>
</html>
`;
}
