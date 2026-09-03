import { getEmailHeader, getEmailFooter } from './components';
import { getEmailThemeByBusinessUnit } from './theme';

export interface InvoiceEmailVariables {
  fullName: string;
  invoiceReference: string;
  amount: string;
  dueDate: string;
  businessUnit: string | null;
  invoiceId: string;
}

export const INVOICE_APPROVED_TEMPLATE = `
  <p>Hi {{fullName}},</p>
  <p>We are writing to inform you that your invoice <strong>{{invoiceReference}}</strong> has been approved. The upcoming payment of <strong>{{amount}}</strong> is scheduled for <strong>{{dueDate}}</strong>.</p>
  <p>Please find the attached PDF copy of the invoice for your reference.</p>
`;

export const INVOICE_PUBLISHED_TEMPLATE = `
  <p>Hi {{fullName}},</p>
  <p>Your invoice <strong>{{invoiceReference}}</strong> has been published. A payment of <strong>{{amount}}</strong> is due by <strong>{{dueDate}}</strong>.</p>
  <p>Please find the attached PDF copy of the invoice for your reference.</p>
`;

export const INVOICE_PAID_TEMPLATE = `
  <p>Hi {{fullName}},</p>
  <p>Thank you for your payment! This email confirms that invoice <strong>{{invoiceReference}}</strong> for <strong>{{amount}}</strong> has been successfully paid.</p>
  <p>Please find the attached PDF copy of the invoice for your records.</p>
`;

export const INVOICE_FAILED_TEMPLATE = `
  <p>Hi {{fullName}},</p>
  <p>We wanted to let you know that the payment attempt for invoice <strong>{{invoiceReference}}</strong> for <strong>{{amount}}</strong> has failed. Please review your billing details and retry the payment.</p>
  <p>Please find the attached PDF copy of the invoice for your reference.</p>
`;

export const INVOICE_DEFAULT_TEMPLATE = `
  <p>Hi {{fullName}},</p>
  <p>Your invoice <strong>{{invoiceReference}}</strong> status has been updated to <strong>{{status}}</strong>.</p>
  <p>Please find the attached PDF copy of the invoice for your reference.</p>
`;

export function replaceInvoiceVariables(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

export function getInvoiceEmail(status: string, variables: InvoiceEmailVariables) {
  const theme = getEmailThemeByBusinessUnit(variables.businessUnit);
  const header = getEmailHeader(theme);
  const footer = getEmailFooter(theme);

  let subject = '';
  let title = '';
  let selectedTemplate = '';

  const { fullName, invoiceReference, amount, dueDate, invoiceId } = variables;

  const replaceMap: Record<string, string> = {
    fullName,
    invoiceReference,
    amount,
    dueDate,
    status,
  };

  switch (status.toLowerCase()) {
    case 'approved':
      subject = `Upcoming Payment: Invoice ${invoiceReference}`;
      title = 'Upcoming Payment Notification';
      selectedTemplate = INVOICE_APPROVED_TEMPLATE;
      break;
    case 'published':
      subject = `New Invoice: ${invoiceReference}`;
      title = 'New Invoice Available';
      selectedTemplate = INVOICE_PUBLISHED_TEMPLATE;
      break;
    case 'paid':
      subject = `Payment Confirmation: Invoice ${invoiceReference}`;
      title = 'Payment Received';
      selectedTemplate = INVOICE_PAID_TEMPLATE;
      break;
    case 'failed':
      subject = `Payment Failed: Invoice ${invoiceReference}`;
      title = 'Payment Failed';
      selectedTemplate = INVOICE_FAILED_TEMPLATE;
      break;
    default:
      subject = `Invoice Update: ${invoiceReference}`;
      title = 'Invoice Status Update';
      selectedTemplate = INVOICE_DEFAULT_TEMPLATE;
      break;
  }

  const innerHtml = replaceInvoiceVariables(selectedTemplate, replaceMap);
  const frontendUrl = process.env.FRONTEND_URL || 'https://staging.medvirtual.ai';

  const html = `
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100&display=swap" rel="stylesheet">
  <style>
    * {
      font-family: "Be Vietnam Pro", sans-serif;
      font-style: normal;
    }
  </style>
  <title>${subject}</title>
</head>

<body style="margin:0;padding:0;width:100%!important;min-width:100%;background-color:#f4f4f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:8px;overflow:hidden;margin-top:20px;margin-bottom:20px;box-shadow:0 4px 10px rgba(0,0,0,0.05);">
    ${header}

    <div style="padding:40px 30px;text-align:left;">
      <h2 style="color:${theme.primaryColor};font-size:22px;margin-top:0;margin-bottom:20px;font-weight:600;">${title}</h2>
      
      <div style="color:#333333;font-size:16px;line-height:1.6;margin-bottom:24px;">
        ${innerHtml}
      </div>

      <div style="text-align: left; margin: 30px 0;">
        <a href="${frontendUrl}/modules/talent/client/invoices?invoice_id=${invoiceId}" style="display: inline-block; background-color: ${theme.primaryColor}; color: #ffffff !important; padding: 14px 28px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; transition: background-color 0.2s ease;">
          View Invoice
        </a>
      </div>
    </div>
    ${footer}
  </div>
</body>
</html>
`;

  return { subject, html };
}
