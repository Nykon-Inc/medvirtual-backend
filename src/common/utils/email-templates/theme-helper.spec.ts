import { getUserEmailTheme, getBusinessUnitEmailTheme } from './theme-helper';

const BRANDING = {
  id: 'brand-1',
  business_unit: 'medvirtual',
  primary_color: '#01546B',
  secondary_color: '#013A4F',
  logo_url: 'https://staging.medvirtual.ai/logo.png',
  company_name: 'MedVirtual',
  button_color: null,
  button_text_color: null,
  layout_preset: 'hero',
  updated_by: null,
  updated_at: new Date('2026-01-01'),
};

const USER = {
  id: 'user-1',
  organization_id: 'org-1',
  role: 'organization_admin',
};

const ORGANIZATION = {
  business_unit: 'MedVirtual',
  status: 'active',
};

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    uSER: {
      findUnique: jest.fn().mockResolvedValue(USER),
    },
    organization: {
      findMany: jest.fn().mockResolvedValue([ORGANIZATION]),
    },
    emailBranding: {
      findUnique: jest.fn().mockResolvedValue(BRANDING),
    },
    ...overrides,
  } as any;
}

describe('theme-helper.getUserEmailTheme', () => {
  it('includes layoutPreset from the DB branding row in the resolved theme', async () => {
    const prisma = makePrisma();
    const theme = await getUserEmailTheme(prisma, 'user-1');
    expect(theme?.layoutPreset).toBe('hero');
  });

  it('falls back to the hardcoded theme (no layoutPreset drop) when no branding row exists', async () => {
    const prisma = makePrisma({
      emailBranding: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const theme = await getUserEmailTheme(prisma, 'user-1');
    expect(theme?.companyName).toBe('MedVirtual');
    expect(theme?.layoutPreset).toBe('default');
  });
});

describe('theme-helper.getUserEmailTheme — MMVA (new BU, no code change)', () => {
  const MMVA_USER = {
    id: 'user-mmva-1',
    organization_id: 'org-mmva-1',
    role: 'organization_admin',
  };

  const MMVA_ORGANIZATION = {
    business_unit: 'MMVA',
    status: 'active',
  };

  const MMVA_BRANDING = {
    id: 'brand-mmva',
    business_unit: 'mmva',
    primary_color: '#6D28D9',
    secondary_color: '#4C1D95',
    logo_url: 'https://staging.medvirtual.ai/logo-mmva.png',
    company_name: 'My Medical VA',
    button_color: '#6D28D9',
    button_text_color: '#ffffff',
    layout_preset: 'default',
    updated_by: null,
    updated_at: new Date('2026-01-01'),
  };

  it('resolves MMVA branding from its EmailBranding DB row with no code change', async () => {
    const prisma = makePrisma({
      uSER: { findUnique: jest.fn().mockResolvedValue(MMVA_USER) },
      organization: {
        findMany: jest.fn().mockResolvedValue([MMVA_ORGANIZATION]),
      },
      emailBranding: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BRANDING),
      },
    });

    const theme = await getUserEmailTheme(prisma, 'user-mmva-1');

    expect(prisma.emailBranding.findUnique).toHaveBeenCalledWith({
      where: { business_unit: 'mmva' },
    });
    expect(theme?.companyName).toBe('My Medical VA');
    expect(theme?.primaryColor).toBe('#6D28D9');
    expect(theme?.logoUrl).toBe('https://staging.medvirtual.ai/logo-mmva.png');
  });

  it('falls back to the hardcoded MedVirtual theme for MMVA when no EmailBranding row exists yet', async () => {
    const prisma = makePrisma({
      uSER: { findUnique: jest.fn().mockResolvedValue(MMVA_USER) },
      organization: {
        findMany: jest.fn().mockResolvedValue([MMVA_ORGANIZATION]),
      },
      emailBranding: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    const theme = await getUserEmailTheme(prisma, 'user-mmva-1');

    // No dedicated MMVA case in the hardcoded switch, so it falls back to the
    // default branch (MedVirtual) — acceptable last-resort fallback per spec.
    expect(theme?.companyName).toBe('MedVirtual');
  });
});

describe('theme-helper.getBusinessUnitEmailTheme', () => {
  it('returns DB branding for the org business_unit, including button colors', async () => {
    const prisma = makePrisma({
      emailBranding: {
        findUnique: jest.fn().mockResolvedValue({
          ...BRANDING,
          button_color: '#123456',
          button_text_color: '#abcdef',
          layout_preset: 'minimal',
        }),
      },
    });

    const theme = await getBusinessUnitEmailTheme(prisma, 'MedVirtual');

    // Confirms the org display value was mapped to the "medvirtual" slug.
    expect(prisma.emailBranding.findUnique).toHaveBeenCalledWith({
      where: { business_unit: 'medvirtual' },
    });
    expect(theme.buttonColor).toBe('#123456');
    expect(theme.buttonTextColor).toBe('#abcdef');
    expect(theme.layoutPreset).toBe('minimal');
  });

  it('maps a multi-word business_unit to its slug (Berry Virtual → berry-virtual)', async () => {
    const prisma = makePrisma({
      emailBranding: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    await getBusinessUnitEmailTheme(prisma, 'Berry Virtual');

    expect(prisma.emailBranding.findUnique).toHaveBeenCalledWith({
      where: { business_unit: 'berry-virtual' },
    });
  });

  it('falls back to the hardcoded theme when no branding row exists', async () => {
    const prisma = makePrisma({
      emailBranding: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    const theme = await getBusinessUnitEmailTheme(prisma, 'Berry Virtual');

    expect(theme.companyName).toBe('Berry Virtual');
    expect(theme.primaryColor).toBe('#FD7171');
    expect(theme.layoutPreset).toBe('default');
  });
});
