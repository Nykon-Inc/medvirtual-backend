import { BusinessUnitContext } from './business-unit-context.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// NOTE(Task03): `hubspot_value` / `is_visible` / `candidate_pool` do not exist on
// the BusinessUnit model yet (added in Task 03). These fixtures include them
// anyway to describe the intended shape once the migration lands — the
// service falls back to `name`/`slug` matching when they're undefined.

const MEDVIRTUAL = {
  id: 'bu-1',
  slug: 'medvirtual',
  name: 'MedVirtual',
  is_active: true,
  hubspot_value: 'MedVirtual',
  is_visible: true,
  candidate_pool: 'medical',
};

const BERRY = {
  id: 'bu-2',
  slug: 'berry-virtual',
  name: 'Berry Virtual',
  is_active: true,
  hubspot_value: 'Berry Virtual',
  is_visible: true,
  candidate_pool: 'non_medical',
};

const MMVA_DORMANT = {
  id: 'bu-3',
  slug: 'mmva',
  name: 'MMVA',
  is_active: true,
  hubspot_value: 'MMVA',
  is_visible: false,
  candidate_pool: 'medical',
  primary_color: '#7C3AED',
  primary_hover: '#6d28d9',
  logo_url: 'https://cdn.example.com/mmva-logo.png',
  favicon_url: 'https://cdn.example.com/mmva.ico',
};

const ALL_BUS = [MEDVIRTUAL, BERRY, MMVA_DORMANT];

function makePrisma(rows: unknown[] = ALL_BUS) {
  return {
    businessUnit: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
}

function makeContext(rows: unknown[] = ALL_BUS) {
  const prisma = makePrisma(rows);
  const ctx = new (BusinessUnitContext as any)(prisma) as BusinessUnitContext;
  return { ctx, prisma };
}

// ── isAllowedHubspotValue ──────────────────────────────────────────────────

describe('BusinessUnitContext.isAllowedHubspotValue', () => {
  it('returns true for a visible BU (exact hubspot_value match)', async () => {
    const { ctx } = makeContext();
    await expect(ctx.isAllowedHubspotValue('MedVirtual')).resolves.toBe(true);
  });

  it('returns false for a dormant BU (known but not visible)', async () => {
    const { ctx } = makeContext();
    await expect(ctx.isAllowedHubspotValue('MMVA')).resolves.toBe(false);
  });

  it('returns false for a completely unknown value', async () => {
    const { ctx } = makeContext();
    await expect(ctx.isAllowedHubspotValue('Some Other Company')).resolves.toBe(
      false,
    );
  });

  it('returns false for null/empty input', async () => {
    const { ctx } = makeContext();
    await expect(ctx.isAllowedHubspotValue('')).resolves.toBe(false);
    await expect(
      ctx.isAllowedHubspotValue(null as unknown as string),
    ).resolves.toBe(false);
  });
});

// ── normalization: "BerryVirtual" vs "Berry Virtual" ──────────────────────

describe('BusinessUnitContext — spacing/case normalization', () => {
  it('resolves "BerryVirtual" and "Berry Virtual" to the same BU', async () => {
    const { ctx } = makeContext();
    const a = await ctx.resolveByHubspotValue('BerryVirtual');
    const b = await ctx.resolveByHubspotValue('Berry Virtual');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.slug).toBe(BERRY.slug);
    expect(b?.slug).toBe(BERRY.slug);
  });

  it('is case-insensitive ("berryvirtual", "BERRY VIRTUAL")', async () => {
    const { ctx } = makeContext();
    const a = await ctx.resolveByHubspotValue('berryvirtual');
    const b = await ctx.resolveByHubspotValue('BERRY VIRTUAL');
    expect(a?.slug).toBe(BERRY.slug);
    expect(b?.slug).toBe(BERRY.slug);
  });

  it('treats "BerryVirtual" as allowed just like "Berry Virtual"', async () => {
    const { ctx } = makeContext();
    await expect(ctx.isAllowedHubspotValue('BerryVirtual')).resolves.toBe(true);
  });
});

// ── getVisibleHubspotValues ────────────────────────────────────────────────

describe('BusinessUnitContext.getVisibleHubspotValues', () => {
  it('returns only the hubspot_value of visible BUs', async () => {
    const { ctx } = makeContext();
    const values = await ctx.getVisibleHubspotValues();
    expect(values.sort()).toEqual(['Berry Virtual', 'MedVirtual'].sort());
    expect(values).not.toContain('MMVA');
  });

  it('reflects an empty visible set when none are visible', async () => {
    const { ctx } = makeContext([{ ...MMVA_DORMANT }]);
    const values = await ctx.getVisibleHubspotValues();
    expect(values).toEqual([]);
  });
});

// ── resolveByHubspotValue ──────────────────────────────────────────────────

describe('BusinessUnitContext.resolveByHubspotValue', () => {
  it('returns null for an unknown value', async () => {
    const { ctx } = makeContext();
    await expect(ctx.resolveByHubspotValue('Unknown Co')).resolves.toBeNull();
  });

  it('resolves a dormant BU row too (existence, not visibility)', async () => {
    const { ctx } = makeContext();
    const bu = await ctx.resolveByHubspotValue('MMVA');
    expect(bu?.slug).toBe('mmva');
  });
});

// ── brandingFor ────────────────────────────────────────────────────────────

describe('BusinessUnitContext.brandingFor', () => {
  it('returns the visual branding fields for a known BU (incl. dormant)', async () => {
    const { ctx } = makeContext();
    const branding = await ctx.brandingFor('MMVA');
    expect(branding).toEqual({
      slug: 'mmva',
      name: 'MMVA',
      primary_color: '#7C3AED',
      primary_hover: '#6d28d9',
      logo_url: 'https://cdn.example.com/mmva-logo.png',
      favicon_url: 'https://cdn.example.com/mmva.ico',
    });
  });

  it('returns null for an unknown BU value', async () => {
    const { ctx } = makeContext();
    await expect(ctx.brandingFor('Unknown Co')).resolves.toBeNull();
  });

  it('nulls out missing branding fields rather than returning undefined', async () => {
    const { ctx } = makeContext([
      {
        id: 'x',
        slug: 'medvirtual',
        name: 'MedVirtual',
        hubspot_value: 'MedVirtual',
      },
    ]);
    const branding = await ctx.brandingFor('MedVirtual');
    expect(branding).toEqual({
      slug: 'medvirtual',
      name: 'MedVirtual',
      primary_color: null,
      primary_hover: null,
      logo_url: null,
      favicon_url: null,
    });
  });
});

// ── poolFor ─────────────────────────────────────────────────────────────────

describe('BusinessUnitContext.poolFor', () => {
  it('returns candidate_pool for a matching BU by hubspot_value', async () => {
    const { ctx } = makeContext();
    await expect(ctx.poolFor('Berry Virtual')).resolves.toBe('non_medical');
  });

  it('returns candidate_pool for a matching BU by slug', async () => {
    const { ctx } = makeContext();
    await expect(ctx.poolFor('medvirtual')).resolves.toBe('medical');
  });

  it('returns null for an unknown BU', async () => {
    const { ctx } = makeContext();
    await expect(ctx.poolFor('Unknown Co')).resolves.toBeNull();
  });
});

// ── displayToSlug ───────────────────────────────────────────────────────────

describe('BusinessUnitContext.displayToSlug', () => {
  it('lowercases and hyphenates a display value', () => {
    const { ctx } = makeContext();
    expect(ctx.displayToSlug('Berry Virtual')).toBe('berry-virtual');
    expect(ctx.displayToSlug('MedVirtual')).toBe('medvirtual');
  });

  it('returns null-safe result (null in, null out)', () => {
    const { ctx } = makeContext();
    expect(ctx.displayToSlug(null as unknown as string)).toBeNull();
  });
});

// ── fallback shape: schema columns not yet present (Task03 not landed) ─────

describe('BusinessUnitContext — fallback when hubspot_value/is_visible/candidate_pool are absent', () => {
  const LEGACY_ROWS = [
    { id: 'bu-1', slug: 'medvirtual', name: 'MedVirtual', is_active: true },
    {
      id: 'bu-2',
      slug: 'berry-virtual',
      name: 'Berry Virtual',
      is_active: true,
    },
  ];

  it('treats MedVirtual & Berry Virtual as visible by name/slug fallback', async () => {
    const { ctx } = makeContext(LEGACY_ROWS);
    await expect(ctx.isAllowedHubspotValue('MedVirtual')).resolves.toBe(true);
    await expect(ctx.isAllowedHubspotValue('Berry Virtual')).resolves.toBe(
      true,
    );
    await expect(ctx.isAllowedHubspotValue('BerryVirtual')).resolves.toBe(true);
  });

  it('rejects an unknown BU under the fallback', async () => {
    const { ctx } = makeContext(LEGACY_ROWS);
    await expect(ctx.isAllowedHubspotValue('MMVA')).resolves.toBe(false);
  });

  it('getVisibleHubspotValues falls back to display names for Med/Berry', async () => {
    const { ctx } = makeContext(LEGACY_ROWS);
    const values = await ctx.getVisibleHubspotValues();
    expect(values.sort()).toEqual(['Berry Virtual', 'MedVirtual'].sort());
  });
});

// ── caching ─────────────────────────────────────────────────────────────────

describe('BusinessUnitContext — in-memory cache', () => {
  it('does not re-query prisma within the TTL window', async () => {
    const { ctx, prisma } = makeContext();
    await ctx.isAllowedHubspotValue('MedVirtual');
    await ctx.isAllowedHubspotValue('Berry Virtual');
    await ctx.getVisibleHubspotValues();
    expect(prisma.businessUnit.findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries prisma after bustCache() is called', async () => {
    const { ctx, prisma } = makeContext();
    await ctx.isAllowedHubspotValue('MedVirtual');
    ctx.bustCache();
    await ctx.isAllowedHubspotValue('MedVirtual');
    expect(prisma.businessUnit.findMany).toHaveBeenCalledTimes(2);
  });
});
