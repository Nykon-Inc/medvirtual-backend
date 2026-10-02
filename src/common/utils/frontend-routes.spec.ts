import * as fs from 'fs';
import * as path from 'path';
import { FRONTEND_ROUTES } from './frontend-routes';
import { MedAllianceInvitation } from './email-templates/med-alliance-invitation';
import { adminMarkPaidErrorTemplate } from '../../med-alliance/notifications/templates/admin-markpaid-error';

describe('FRONTEND_ROUTES', () => {
  it('points every link at the modules shell of the frontend', () => {
    for (const route of Object.values(FRONTEND_ROUTES)) {
      expect(route.startsWith('/modules/')).toBe(true);
      expect(route.endsWith('/')).toBe(false);
    }
  });

  it('maps each destination to its module page', () => {
    expect(FRONTEND_ROUTES).toEqual({
      hireRequests: '/modules/talent/hire-requests',
      adminTickets: '/modules/talent/admin/tickets',
      profile: '/modules/profile',
      clientInterviewPanels: '/modules/talent/client/interview-panels',
      adminOfferPanels: '/modules/talent/admin/offer-panels',
      alliance: '/modules/alliance',
      allianceAdminPipeline: '/modules/alliance/admin/pipeline',
      allianceAdminCommissions: '/modules/alliance/admin/commissions',
      allianceAdminPayoutRequests: '/modules/alliance/admin/payout-requests',
      allianceAdminPartners: '/modules/alliance/admin/partners',
    });
  });
});

describe('rendered email links', () => {
  const original = process.env.FRONTEND_URL;
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.example.com';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  });

  it('sends the Med Alliance invitation to the Alliance hub', () => {
    const html = MedAllianceInvitation('Ana');
    expect(html).toContain('href="https://app.example.com/modules/alliance"');
    expect(html).not.toContain('https://app.example.com/med-alliance');
  });

  it('deep-links the mark-paid error email to the payout request', () => {
    const html = adminMarkPaidErrorTemplate({
      payoutRequestId: 'pay-1',
      adminName: 'Ana',
      errorPhase: 'mark_paid',
      errorMessage: 'boom',
    });
    expect(html).toContain(
      'https://app.example.com/modules/alliance/admin/payout-requests?payout=pay-1',
    );
  });
});

/**
 * Regression guard: the legacy frontend pages were removed, so no email or
 * notification may link to them again. Scans every non-test source file for a
 * frontend base URL followed by a legacy path.
 */
describe('no legacy frontend links in the source', () => {
  const SRC = path.join(__dirname, '..', '..');
  const LEGACY_PATHS = [
    'hire-requests',
    'tickets',
    'profile',
    'interview-panels',
    'offer-panels',
    'med-alliance',
    'admin/med-alliance',
    'dashboard',
    'candidates',
    'clients',
    'staff',
    'invoices',
    'panels',
  ];
  const LEGACY_LINK = new RegExp(
    `(?:FRONTEND_URL|frontendUrl)[^\\n]*?\\}/(?:${LEGACY_PATHS.join('|')})(?![\\w-])`,
  );
  // `const path = isClient ? '/profile' : '/tickets'` style: a bare legacy path literal.
  const LEGACY_LITERAL = new RegExp(
    `['"\`]/(?:${LEGACY_PATHS.join('|')})['"\`]`,
  );

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.controller.ts')
      )
        out.push(full);
    }
    return out;
  }

  it('finds none', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments
        if (LEGACY_LINK.test(line) || LEGACY_LITERAL.test(line))
          offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
