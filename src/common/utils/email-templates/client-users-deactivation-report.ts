import { EmailHeader, EmailFooter } from './components';

type ReportUser = {
  email: string;
  first_name: string;
  last_name: string;
  organization_name: string;
};

export default function clientUsersDeactivationReport(
  deactivatedUsers: ReportUser[],
  deletedUsers: ReportUser[],
  runAt: Date,
  failedDeletions: ReportUser[] = [],
) {
  const formatDate = (d: Date) =>
    d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const buildRows = (users: ReportUser[]) => {
    if (users.length === 0) {
      return `<tr><td colspan="3" style="border:1px solid #ccc;padding:12px;text-align:center;color:#888;">No records</td></tr>`;
    }
    return users
      .map(
        (u) => `
            <tr>
                <td style="border:1px solid #ccc;padding:8px;">${u.first_name} ${u.last_name}</td>
                <td style="border:1px solid #ccc;padding:8px;">${u.email}</td>
                <td style="border:1px solid #ccc;padding:8px;">${u.organization_name}</td>
            </tr>
        `,
      )
      .join('');
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100&display=swap" rel="stylesheet">
  <style>* { font-family: "Be Vietnam Pro", font-style: normal }</style>
  <title>Client Users Deactivation Report</title>
</head>
<body style="margin:0;padding:0;width:100%!important;min-width:100%;background-color:#f4f4f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="max-width:650px;margin:0 auto;background-color:#ffffff;">
    ${EmailHeader}

    <div style="padding:24px 24px 8px;">
      <p style="color:#181D27;font-size:18px;line-height:1.6;margin:0;">
        Hi there, below is the report for the <strong>Client Users Deactivation</strong> cron job run on <strong>${formatDate(runAt)}</strong>.
      </p>
      <p style="color:#555;font-size:14px;margin-top:8px;">
        This job targets clients with <strong>no staff</strong> and processes users created <strong>more than 60 days ago</strong>.
      </p>
    </div>

    <div style="display:flex;justify-content:center;flex-wrap:wrap;text-align:center;padding:16px 0;" align="center">
      <div style="width:35%;border-radius:8px;margin:12px;background-color:#e8f5e9;text-align:center;padding:16px;">
        <p style="color:#181D27;font-size:16px;margin-bottom:12px;">Users Deactivated</p>
        <div style="display:inline-block;background-color:#2e7d32;color:#ffffff;padding:10px 24px;border-radius:8px;font-size:22px;font-weight:700;">
          ${deactivatedUsers.length}
        </div>
      </div>
      <div style="width:35%;border-radius:8px;margin:12px;background-color:#fce4ec;text-align:center;padding:16px;">
        <p style="color:#181D27;font-size:16px;margin-bottom:12px;">Invited Users Removed</p>
        <div style="display:inline-block;background-color:#c62828;color:#ffffff;padding:10px 24px;border-radius:8px;font-size:22px;font-weight:700;">
          ${deletedUsers.length}
        </div>
      </div>
    </div>

    <div style="padding:16px 24px;">
      <h3 style="color:#181D27;margin-bottom:8px;">Deactivated Users</h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background-color:#f4f4f4;">
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Name</th>
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Email</th>
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Organization</th>
          </tr>
        </thead>
        <tbody>${buildRows(deactivatedUsers)}</tbody>
      </table>
    </div>

    <div style="padding:16px 24px 32px;">
      <h3 style="color:#181D27;margin-bottom:8px;">Removed Invited Users</h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background-color:#f4f4f4;">
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Name</th>
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Email</th>
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Organization</th>
          </tr>
        </thead>
        <tbody>${buildRows(deletedUsers)}</tbody>
      </table>
    </div>

    ${
      failedDeletions.length > 0
        ? `<div style="padding:0 24px 32px;">
      <h3 style="color:#c62828;margin-bottom:8px;">Failed Removals (${failedDeletions.length})</h3>
      <p style="color:#555;font-size:14px;margin-top:0;">These invited users could not be removed and will be retried on the next run.</p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background-color:#f4f4f4;">
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Name</th>
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Email</th>
            <th style="border:1px solid #ccc;padding:8px;text-align:left;">Organization</th>
          </tr>
        </thead>
        <tbody>${buildRows(failedDeletions)}</tbody>
      </table>
    </div>`
        : ''
    }

    ${EmailFooter}
  </div>
</body>
</html>`;
}
