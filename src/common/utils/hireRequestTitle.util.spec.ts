import { buildHireRequestTitle } from './hireRequestTitle.util';

describe('buildHireRequestTitle', () => {
  let savedEnvironment: string | undefined;

  beforeEach(() => {
    savedEnvironment = process.env.ENVIRONMENT;
    delete process.env.ENVIRONMENT;
  });

  afterEach(() => {
    if (savedEnvironment === undefined) {
      delete process.env.ENVIRONMENT;
    } else {
      process.env.ENVIRONMENT = savedEnvironment;
    }
  });

  it('builds full title: TEST HR - OrgName - NVAs - Role - Availability', () => {
    const title = buildHireRequestTitle({
      hubspot_pairing_request_type: null,
      hubspot_numberVA: 2,
      hubspot_role_type: 'Medical Scribe',
      availability: 'full-time',
      organization: { name: 'Acme Health' },
    });
    expect(title).toBe(
      'TEST HR - Acme Health - 2 - Medical Scribe - Full-Time',
    );
  });

  it('adds UPS prefix for Upsell Agent request type', () => {
    const title = buildHireRequestTitle({
      hubspot_pairing_request_type: 'Upsell Agent',
      hubspot_numberVA: 1,
      hubspot_role_type: 'RN',
      availability: 'full-time',
      organization: { name: 'Acme Health' },
    });
    expect(title).toMatch(/^UPS TEST HR/);
  });

  it('adds REP prefix for Agent Replacement request type', () => {
    const title = buildHireRequestTitle({
      hubspot_pairing_request_type: 'Agent Replacement',
      hubspot_numberVA: 1,
      hubspot_role_type: 'RN',
      availability: 'full-time',
      organization: { name: 'Acme Health' },
    });
    expect(title).toMatch(/^REP TEST HR/);
  });

  it('uses HR prefix in production', () => {
    process.env.ENVIRONMENT = 'PROD';
    const title = buildHireRequestTitle({
      organization: { name: 'Acme Health' },
    });
    expect(title).toMatch(/^HR/);
  });

  it('omits missing optional fields without leaving empty segments', () => {
    const title = buildHireRequestTitle({
      organization: { name: 'Acme Health' },
    });
    expect(title).toBe('TEST HR - Acme Health');
  });

  it('formats hyphenated availability with capitalized words', () => {
    const title = buildHireRequestTitle({
      availability: 'part-time',
      organization: { name: 'Acme Health' },
    });
    expect(title).toContain('Part-Time');
  });
});
