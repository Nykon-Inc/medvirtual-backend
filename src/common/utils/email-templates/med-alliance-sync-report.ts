import { getEmailHeader, getEmailFooter } from './components';

export interface SyncReportEntry {
  organizationId: string;
  organizationName: string;
  outcome: string;
  hubspotCompanyId?: string;
  invoices?: { created: number; updated: number; skipped: number };
  // Per-collaborator line-item outcomes (StaffMatchingService), added alongside the
  // per-collaborator commission rewrite (spec doc §4.5) — gives immediate visibility into
  // unmatched/ambiguous collaborator payments without opening the review-case dashboard.
  lineItems?: {
    created: number;
    matched: number;
    unmatched: number;
    ambiguous: number;
  };
  commissions?: { created: number; skipped: number };
  error?: string;
}

export default function medAllianceSyncReport(
  processed: number,
  allEntries: SyncReportEntry[],
  needsAttention: SyncReportEntry[],
  totals: {
    invoicesCreated: number;
    commissionsCreated: number;
    lineItemsUnmatched: number;
    lineItemsAmbiguous: number;
  },
  runAt: Date,
): string {
  const formattedDate = runAt.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const attentionRows = needsAttention
    .map(
      (e) => `
      <tr>
        <td style="border:1px solid #f5c6cb;padding:10px 12px;font-size:14px;font-weight:600;color:#721c24;">${e.organizationName}</td>
        <td style="border:1px solid #f5c6cb;padding:10px 12px;font-size:11px;color:#888;font-family:monospace;">${e.organizationId}</td>
        <td style="border:1px solid #f5c6cb;padding:10px 12px;font-size:14px;color:#555;text-align:center;">${e.outcome}</td>
        <td style="border:1px solid #f5c6cb;padding:10px 12px;font-size:13px;color:#721c24;">${e.error ?? '-'}</td>
      </tr>`,
    )
    .join('');

  const allRows = allEntries
    .map((e) => {
      const lineItemsCell = e.lineItems
        ? `${e.lineItems.matched} matched${e.lineItems.unmatched || e.lineItems.ambiguous ? ` / <span style="color:#bf360c;font-weight:600;">${e.lineItems.unmatched} unmatched, ${e.lineItems.ambiguous} ambiguous</span>` : ''}`
        : '-';
      return `
      <tr>
        <td style="border:1px solid #dee2e6;padding:10px 12px;font-size:14px;font-weight:600;">${e.organizationName}</td>
        <td style="border:1px solid #dee2e6;padding:10px 12px;font-size:14px;color:#555;text-align:center;">${e.outcome}</td>
        <td style="border:1px solid #dee2e6;padding:10px 12px;font-size:11px;color:#888;font-family:monospace;">${e.hubspotCompanyId ?? '-'}</td>
        <td style="border:1px solid #dee2e6;padding:10px 12px;font-size:13px;color:#555;text-align:center;">${e.invoices ? `${e.invoices.created} / ${e.invoices.updated} / ${e.invoices.skipped}` : '-'}</td>
        <td style="border:1px solid #dee2e6;padding:10px 12px;font-size:13px;color:#555;text-align:center;">${lineItemsCell}</td>
        <td style="border:1px solid #dee2e6;padding:10px 12px;font-size:13px;color:#555;text-align:center;">${e.commissions ? `${e.commissions.created} / ${e.commissions.skipped}` : '-'}</td>
      </tr>`;
    })
    .join('');

  const nothingToDoSection =
    processed === 0
      ? `<p style="color:#888;font-size:14px;margin-top:24px;">No referred organizations were found to process in this run.</p>`
      : '';

  const attentionSection =
    needsAttention.length > 0
      ? `
      <h3 style="color:#721c24;margin-top:32px;margin-bottom:12px;">Needs Attention (${needsAttention.length})</h3>
      <p style="color:#721c24;font-size:14px;margin-bottom:16px;">The following organizations had a matching error, multiple HubSpot matches, or an unhandled sync failure. Please review them manually.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
        <thead>
          <tr style="background-color:#f8d7da;">
            <th style="border:1px solid #f5c6cb;padding:10px 12px;text-align:left;font-size:13px;">Company</th>
            <th style="border:1px solid #f5c6cb;padding:10px 12px;text-align:left;font-size:13px;">Org ID</th>
            <th style="border:1px solid #f5c6cb;padding:10px 12px;text-align:center;font-size:13px;">Outcome</th>
            <th style="border:1px solid #f5c6cb;padding:10px 12px;text-align:left;font-size:13px;">Error</th>
          </tr>
        </thead>
        <tbody>${attentionRows}</tbody>
      </table>`
      : '';

  const allSection =
    allEntries.length > 0
      ? `
      <h3 style="color:#181D27;margin-top:32px;margin-bottom:12px;">All Organizations Processed (${allEntries.length})</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
        <thead>
          <tr style="background-color:#f4f4f4;">
            <th style="border:1px solid #dee2e6;padding:10px 12px;text-align:left;font-size:13px;">Company</th>
            <th style="border:1px solid #dee2e6;padding:10px 12px;text-align:center;font-size:13px;">Outcome</th>
            <th style="border:1px solid #dee2e6;padding:10px 12px;text-align:left;font-size:13px;">HubSpot Company ID</th>
            <th style="border:1px solid #dee2e6;padding:10px 12px;text-align:center;font-size:13px;">Invoices (created / updated / skipped)</th>
            <th style="border:1px solid #dee2e6;padding:10px 12px;text-align:center;font-size:13px;">Line Items (matched / unmatched / ambiguous)</th>
            <th style="border:1px solid #dee2e6;padding:10px 12px;text-align:center;font-size:13px;">Commissions (created / skipped)</th>
          </tr>
        </thead>
        <tbody>${allRows}</tbody>
      </table>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Med Alliance — HubSpot Sync Report</title>
</head>
<body style="margin:0;padding:0;width:100%!important;background-color:#f4f4f4;">
  <div style="max-width:700px;margin:0 auto;background-color:#ffffff;">
    ${getEmailHeader()}

    <div style="padding:32px 24px;">
      <h2 style="color:#181D27;font-size:22px;margin-bottom:4px;">Med Alliance — HubSpot Sync Report</h2>
      <p style="color:#666;font-size:14px;margin-top:0;margin-bottom:24px;">Cron run on ${formattedDate}</p>

      <div style="display:flex;gap:16px;margin-bottom:8px;" align="center">
        <div style="flex:1;background:#f5f5f5;border-radius:8px;padding:16px;text-align:center;margin:0 8px;">
          <p style="margin:0;font-size:13px;color:#757575;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Processed</p>
          <p style="margin:8px 0 0;font-size:28px;font-weight:700;color:#9e9e9e;">${processed}</p>
        </div>
        <div style="flex:1;background:${needsAttention.length > 0 ? '#fff3e0' : '#f5f5f5'};border-radius:8px;padding:16px;text-align:center;margin:0 8px;">
          <p style="margin:0;font-size:13px;color:${needsAttention.length > 0 ? '#e65100' : '#757575'};font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Needs Attention</p>
          <p style="margin:8px 0 0;font-size:28px;font-weight:700;color:${needsAttention.length > 0 ? '#bf360c' : '#9e9e9e'};">${needsAttention.length}</p>
        </div>
        <div style="flex:1;background:#f5f5f5;border-radius:8px;padding:16px;text-align:center;margin:0 8px;">
          <p style="margin:0;font-size:13px;color:#757575;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Invoices Created</p>
          <p style="margin:8px 0 0;font-size:28px;font-weight:700;color:#9e9e9e;">${totals.invoicesCreated}</p>
        </div>
        <div style="flex:1;background:#f5f5f5;border-radius:8px;padding:16px;text-align:center;margin:0 8px;">
          <p style="margin:0;font-size:13px;color:#757575;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Commissions Created</p>
          <p style="margin:8px 0 0;font-size:28px;font-weight:700;color:#9e9e9e;">${totals.commissionsCreated}</p>
        </div>
        <div style="flex:1;background:${totals.lineItemsUnmatched + totals.lineItemsAmbiguous > 0 ? '#fff3e0' : '#f5f5f5'};border-radius:8px;padding:16px;text-align:center;margin:0 8px;">
          <p style="margin:0;font-size:13px;color:${totals.lineItemsUnmatched + totals.lineItemsAmbiguous > 0 ? '#e65100' : '#757575'};font-weight:600;text-transform:uppercase;letter-spacing:.5px;">Unmatched / Ambiguous</p>
          <p style="margin:8px 0 0;font-size:28px;font-weight:700;color:${totals.lineItemsUnmatched + totals.lineItemsAmbiguous > 0 ? '#bf360c' : '#9e9e9e'};">${totals.lineItemsUnmatched} / ${totals.lineItemsAmbiguous}</p>
        </div>
      </div>

      ${nothingToDoSection}
      ${attentionSection}
      ${allSection}
    </div>

    ${getEmailFooter()}
  </div>
</body>
</html>`;
}
