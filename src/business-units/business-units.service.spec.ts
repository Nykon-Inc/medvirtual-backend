import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AffiliateStatus, OrganizationStatus } from '@prisma/client';
import axios from 'axios';
import { BusinessUnitsService } from './business-units.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BU = {
  id: 'bu-1',
  slug: 'medvirtual',
  name: 'MedVirtual',
  is_active: true,
  created_at: new Date('2026-01-01'),
  created_by: 'user-1',
};

const BRANDING = {
  id: 'brand-1',
  business_unit: 'medvirtual',
  primary_color: '#01546B',
  secondary_color: '#013A4F',
  logo_url: 'https://staging.medvirtual.ai/logo.png',
  company_name: 'MedVirtual',
  layout_preset: 'default',
  button_color: null,
  button_text_color: null,
  updated_by: 'user-1',
  updated_at: new Date('2026-01-01'),
};

const BRANDING_HISTORY = {
  id: 'bh-1',
  branding_id: 'brand-1',
  snapshot: { primary_color: '#01546B' },
  changed_by: 'user-1',
  changed_at: new Date('2026-01-01'),
};

// ── Mock factory ──────────────────────────────────────────────────────────────

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    $transaction: jest.fn((ops: unknown[]) =>
      Promise.all(ops as Promise<unknown>[]),
    ),
    businessUnit: {
      findUnique: jest.fn().mockResolvedValue(BU),
      findMany: jest.fn().mockResolvedValue([BU]),
      create: jest.fn().mockResolvedValue(BU),
      update: jest.fn().mockResolvedValue({ ...BU }),
    },
    emailBranding: {
      findUnique: jest.fn().mockResolvedValue(BRANDING),
      create: jest.fn().mockResolvedValue(BRANDING),
      update: jest.fn().mockResolvedValue(BRANDING),
    },
    emailBrandingHistory: {
      create: jest.fn().mockResolvedValue(BRANDING_HISTORY),
      findMany: jest.fn().mockResolvedValue([BRANDING_HISTORY]),
    },
    organization: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    uSER: {
      updateMany: jest.fn(),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'user-1', first_name: 'Jane', last_name: 'Doe' },
        ]),
    },
    candidate: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(),
      upsert: jest.fn().mockResolvedValue({ id: 'candidate-upsert-id' }),
    },
    affiliateProfile: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    contact: {
      upsert: jest.fn(),
    },
    ...overrides,
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeBuContext() {
  return { bustCache: jest.fn() };
}

const candidateAuditMock = {
  log: jest.fn().mockResolvedValue(undefined),
  logOrThrow: jest.fn().mockResolvedValue(undefined),
  logMany: jest.fn().mockResolvedValue(undefined),
};

function makeService(
  prismaOverrides: Record<string, unknown> = {},
  auditOverride?: Record<string, unknown>,
) {
  const prisma = makePrisma(prismaOverrides);
  const audit = auditOverride ?? makeAudit();
  const buContext = makeBuContext();
  const service = new (BusinessUnitsService as any)(
    prisma,
    audit,
    buContext,
    candidateAuditMock,
  );
  return { service: service as BusinessUnitsService, prisma, audit, buContext };
}

// ── findAll ────────────────────────────────────────────────────────────────────

describe('BusinessUnitsService.findAll', () => {
  it('returns all business units with branding included', async () => {
    const { service } = makeService();
    const result = await service.findAll();
    expect(result.status).toBe(200);
    expect(Array.isArray(result.data)).toBe(true);
  });
});

// ── create ─────────────────────────────────────────────────────────────────────

describe('BusinessUnitsService.findAllBranding', () => {
  it('queries only is_visible=true BUs and selects only visual fields', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(BU),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.findAllBranding();

    expect(prisma.businessUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { is_visible: true },
        select: {
          slug: true,
          name: true,
          hubspot_value: true,
          primary_color: true,
          primary_hover: true,
          logo_url: true,
          favicon_url: true,
        },
      }),
    );
  });

  it('does NOT select candidate_pool / is_active / email branding (no admin data leak)', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(BU),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.findAllBranding();

    const call = prisma.businessUnit.findMany.mock.calls[0][0];
    expect(call.select).not.toHaveProperty('candidate_pool');
    expect(call.select).not.toHaveProperty('is_active');
    expect(call.select).not.toHaveProperty('is_visible');
    // The email branding relation must never be included on this public route.
    expect(call).not.toHaveProperty('include');
  });

  it('returns { status: 200, data } with the visible rows', async () => {
    const rows = [
      { slug: 'mmva', name: 'My Medical VA', primary_color: '#7C3AED' },
    ];
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(BU),
        findMany: jest.fn().mockResolvedValue(rows),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    const result = await service.findAllBranding();
    expect(result).toEqual({ status: 200, data: rows });
  });
});

describe('BusinessUnitsService.create', () => {
  const dto = { slug: 'mmva', name: 'MMVA' };

  it('creates the BU and its default EmailBranding in a single transaction', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null), // no existing BU
        create: jest
          .fn()
          .mockResolvedValue({ ...BU, slug: 'mmva', name: 'MMVA' }),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.create(dto, 'user-1');

    expect(prisma.$transaction).toHaveBeenCalled();
    const txArgs = (prisma.$transaction as jest.Mock).mock
      .calls[0][0] as unknown[];
    expect(txArgs).toHaveLength(2);
  });

  it('auto-creates EmailBranding with the BU name as company_name', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ ...BU, slug: 'mmva', name: 'MMVA' }),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.create(dto, 'user-1');

    expect(prisma.emailBranding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          company_name: 'MMVA',
          business_unit: 'mmva',
        }),
      }),
    );
  });

  it('throws BadRequestException when slug already exists', async () => {
    const { service } = makeService(); // findUnique returns BU by default
    await expect(service.create(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });
});

// ── update ─────────────────────────────────────────────────────────────────────

describe('BusinessUnitsService.update', () => {
  it('updates name when provided', async () => {
    const { service, prisma } = makeService();
    await service.update('medvirtual', { name: 'MedVirtual Renamed' });
    expect(prisma.businessUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'medvirtual' },
        data: expect.objectContaining({ name: 'MedVirtual Renamed' }),
      }),
    );
  });

  it('throws NotFoundException for unknown slug', async () => {
    const { service } = makeService({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(service.update('ghost', { name: 'X' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('persists app-branding fields (colors, logo, favicon, candidate_pool) when provided', async () => {
    const { service, prisma } = makeService();
    await service.update('medvirtual', {
      primary_color: '#077999',
      primary_hover: '#066685',
      logo_url: 'https://staging.medvirtual.ai/logo.png',
      favicon_url: 'https://staging.medvirtual.ai/favicon.ico',
      candidate_pool: 'non_medical',
    });
    expect(prisma.businessUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'medvirtual' },
        data: expect.objectContaining({
          primary_color: '#077999',
          primary_hover: '#066685',
          logo_url: 'https://staging.medvirtual.ai/logo.png',
          favicon_url: 'https://staging.medvirtual.ai/favicon.ico',
          candidate_pool: 'non_medical',
        }),
      }),
    );
  });

  it('does not touch app-branding fields when they are absent from the dto', async () => {
    const { service, prisma } = makeService();
    await service.update('medvirtual', { name: 'MedVirtual Renamed' });
    const data = prisma.businessUnit.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('primary_color');
    expect(data).not.toHaveProperty('primary_hover');
    expect(data).not.toHaveProperty('logo_url');
    expect(data).not.toHaveProperty('favicon_url');
    expect(data).not.toHaveProperty('candidate_pool');
  });
});

// ── deactivate ─────────────────────────────────────────────────────────────────

describe('BusinessUnitsService.deactivate', () => {
  it('sets is_active to false', async () => {
    const { service, prisma } = makeService();
    await service.deactivate('medvirtual');
    expect(prisma.businessUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { is_active: false } }),
    );
  });

  it('throws NotFoundException for unknown slug', async () => {
    const { service } = makeService({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(service.deactivate('ghost')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ── updateBranding ─────────────────────────────────────────────────────────────

describe('BusinessUnitsService.updateBranding', () => {
  const dto = { primary_color: '#FD7171', company_name: 'Berry Virtual' };

  it('snapshots current branding to history before overwriting', async () => {
    const { service, prisma } = makeService();
    await service.updateBranding('medvirtual', dto, 'user-1');
    expect(prisma.emailBrandingHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branding_id: BRANDING.id,
          changed_by: 'user-1',
          snapshot: expect.objectContaining({
            primary_color: BRANDING.primary_color,
          }),
        }),
      }),
    );
  });

  it('applies only the fields present in dto (partial update)', async () => {
    const { service, prisma } = makeService();
    await service.updateBranding(
      'medvirtual',
      { primary_color: '#FF0000' },
      'user-1',
    );
    expect(prisma.emailBranding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          primary_color: '#FF0000',
          updated_by: 'user-1',
        }),
      }),
    );
    // secondary_color should NOT be in the update payload
    const updateCall = prisma.emailBranding.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('secondary_color');
  });

  it('applies button_color and button_text_color and snapshots their previous values', async () => {
    const { service, prisma } = makeService();
    await service.updateBranding(
      'medvirtual',
      { button_color: '#112233', button_text_color: '#F0F0F0' },
      'user-1',
    );
    expect(prisma.emailBranding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          button_color: '#112233',
          button_text_color: '#F0F0F0',
        }),
      }),
    );
    expect(prisma.emailBrandingHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            button_color: BRANDING.button_color,
            button_text_color: BRANDING.button_text_color,
          }),
        }),
      }),
    );
  });

  it('throws NotFoundException when BU does not exist', async () => {
    const { service } = makeService({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(
      service.updateBranding('ghost', dto, 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('self-heals: creates a default branding row then applies the update when none exists', async () => {
    const { service, prisma } = makeService({
      emailBranding: {
        // No branding row yet (BU came from HubSpot cron intake).
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(BRANDING),
        update: jest.fn().mockResolvedValue(BRANDING),
      },
    });
    await expect(
      service.updateBranding('medvirtual', dto, 'user-1'),
    ).resolves.toBeDefined();
    // A default branding row was created for the BU...
    expect(prisma.emailBranding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          business_unit: 'medvirtual',
          layout_preset: 'default',
        }),
      }),
    );
    // ...and the requested update was still applied afterwards.
    expect(prisma.emailBranding.update).toHaveBeenCalled();
  });
});

// ── sync bidirecional ──────────────────────────────────────────────────────────

describe('BusinessUnitsService — sync bidirecional', () => {
  const updatedBranding = { ...BRANDING, primary_color: '#FF0000' };

  afterEach(() => {
    delete process.env.PEER_ENV_API_URL;
    delete process.env.INTER_ENV_SYNC_SECRET;
  });

  it('calls syncBrandingToPeer after updateBranding when env vars are set', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;
    process.env.PEER_ENV_API_URL = 'https://peer.example.com';
    process.env.INTER_ENV_SYNC_SECRET = 'secret123';

    const prisma = makePrisma({
      emailBranding: {
        findUnique: jest.fn().mockResolvedValue(BRANDING),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(updatedBranding),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.updateBranding(
      'medvirtual',
      { primary_color: '#FF0000' },
      'user-1',
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledWith(
      'https://peer.example.com/business-units/medvirtual/branding/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Sync-Secret': 'secret123' }),
      }),
    );
  });

  it('does NOT call fetch when PEER_ENV_API_URL is not set', async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch;
    delete process.env.PEER_ENV_API_URL;

    const { service } = makeService();
    await service.updateBranding(
      'medvirtual',
      { primary_color: '#FF0000' },
      'user-1',
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('BusinessUnitsService.receiveBrandingSyncFromPeer', () => {
  const payload = { primary_color: '#FD7171', company_name: 'Berry Virtual' };

  it('snapshots the current branding with changed_by = "sync"', async () => {
    const { service, prisma } = makeService();
    await service.receiveBrandingSyncFromPeer('medvirtual', payload, 'PROD');
    expect(prisma.emailBrandingHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ changed_by: 'sync' }),
      }),
    );
  });

  it('applies the payload fields to the branding record', async () => {
    const { service, prisma } = makeService();
    await service.receiveBrandingSyncFromPeer('medvirtual', payload, 'PROD');
    expect(prisma.emailBranding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          primary_color: '#FD7171',
          company_name: 'Berry Virtual',
          updated_by: 'sync',
        }),
      }),
    );
  });

  it('does NOT call syncBrandingToPeer after receiving (anti-loop guarantee)', async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch;
    process.env.PEER_ENV_API_URL = 'https://peer.example.com';
    process.env.INTER_ENV_SYNC_SECRET = 'secret123';

    const { service } = makeService();
    await service.receiveBrandingSyncFromPeer('medvirtual', payload, 'PROD');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).not.toHaveBeenCalled();

    delete process.env.PEER_ENV_API_URL;
    delete process.env.INTER_ENV_SYNC_SECRET;
  });

  it('ignores sync for an unknown BU slug without throwing', async () => {
    const { service } = makeService({
      emailBranding: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    await expect(
      service.receiveBrandingSyncFromPeer('ghost', payload, 'PROD'),
    ).resolves.not.toThrow();
  });
});

// ── getBranding ──────────────────────────────────────────────────────────────

describe('BusinessUnitsService.getBranding', () => {
  it('returns the existing branding row', async () => {
    const { service, prisma } = makeService();
    const result = await service.getBranding('medvirtual');
    expect(result.status).toBe(200);
    expect(result.data).toEqual(BRANDING);
    expect(prisma.emailBranding.create).not.toHaveBeenCalled();
  });

  it('self-heals: creates and returns a default branding row when none exists', async () => {
    const { service, prisma } = makeService({
      emailBranding: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(BRANDING),
        update: jest.fn(),
      },
    });
    const result = await service.getBranding('medvirtual');
    expect(result.status).toBe(200);
    expect(prisma.emailBranding.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ business_unit: 'medvirtual' }),
      }),
    );
  });

  it('throws NotFoundException for an unknown BU slug (does not auto-create)', async () => {
    const { service, prisma } = makeService({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(service.getBranding('ghost')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.emailBranding.create).not.toHaveBeenCalled();
  });
});

// ── getBrandingHistory ─────────────────────────────────────────────────────────

describe('BusinessUnitsService.getBrandingHistory', () => {
  it('returns branding history ordered by most recent first', async () => {
    const { service } = makeService();
    const result = await service.getBrandingHistory('medvirtual');
    expect(result.status).toBe(200);
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('resolves changed_by into a display name via a USER lookup', async () => {
    const { service, prisma } = makeService({
      emailBrandingHistory: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...BRANDING_HISTORY, changed_by: 'user-1' }]),
      },
    });
    const result = await service.getBrandingHistory('medvirtual');
    expect(result.data[0]).toMatchObject({
      changed_by: 'user-1',
      changed_by_name: 'Jane Doe',
    });
    expect(prisma.uSER.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['user-1'] } } }),
    );
  });

  it('labels sync-originated rows as "Auto-sync" without a USER lookup', async () => {
    const { service, prisma } = makeService({
      emailBrandingHistory: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...BRANDING_HISTORY, changed_by: 'sync' }]),
      },
    });
    const result = await service.getBrandingHistory('medvirtual');
    expect(result.data[0]).toMatchObject({
      changed_by: 'sync',
      changed_by_name: 'Auto-sync',
    });
    expect(prisma.uSER.findMany).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for unknown slug', async () => {
    const { service } = makeService({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(service.getBrandingHistory('ghost')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ── backfillFromHubspot (Task 06) ───────────────────────────────────────────

const MMVA_BU = {
  id: 'bu-mmva',
  slug: 'mmva',
  name: 'MMVA',
  is_active: true,
  is_visible: true,
  hubspot_value: 'MMVA',
  candidate_pool: 'medical',
};

function emptySearch() {
  return { data: { results: [], paging: undefined } };
}

describe('BusinessUnitsService.backfillFromHubspot', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.get.mockReset();
  });

  it('throws NotFoundException for an unknown slug', async () => {
    const { service } = makeService({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    });
    await expect(service.backfillFromHubspot('ghost')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('upserts companies, contacts, candidates and affiliates by hubspot_id', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'company-1',
              properties: {
                hs_object_id: 'company-1',
                name: 'Acme Co',
                business_unit: 'MMVA',
              },
            },
          ],
        },
      }) // companies
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'contact-1',
              properties: {
                hs_object_id: 'contact-1',
                email: 'a@b.com',
                business_unit: 'MMVA',
              },
            },
          ],
        },
      }) // contacts
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'va-1',
              properties: {
                hs_object_id: 'va-1',
                email: 'va@b.com',
                business_unit: 'MMVA',
              },
            },
          ],
        },
      }) // candidates (VA custom object)
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'gp-1',
              properties: {
                hs_object_id: 'gp-1',
                growth_partner_name: 'Jane',
                business_unit: 'MMVA',
              },
            },
          ],
        },
      }); // affiliates (Growth Partner)

    const result = await service.backfillFromHubspot('mmva');

    expect(prisma.organization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hubspot_id: 'company-1' },
      }),
    );
    expect(prisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hubspot_id: 'contact-1' } }),
    );
    expect(prisma.candidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hubspot_id: 'va-1' } }),
    );
    expect(prisma.affiliateProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hubspot_id: 'gp-1' } }),
    );
    expect(result.organizations).toBe(1);
    expect(result.contacts).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.affiliates).toBe(1);
  });

  it('is non-destructive — never calls deleteMany/delete for any of the 4 object types', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post.mockResolvedValue(emptySearch());

    await service.backfillFromHubspot('mmva');

    const p = prisma as any;
    expect(p.organization.deleteMany).toBeUndefined();
    expect(p.contact.deleteMany).toBeUndefined();
    expect(p.candidate.deleteMany).toBeUndefined();
    expect(p.affiliateProfile.deleteMany).toBeUndefined();
  });

  it('is idempotent — running twice upserts (never creates duplicates)', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post.mockResolvedValue({
      data: {
        results: [
          {
            id: 'company-1',
            properties: {
              hs_object_id: 'company-1',
              name: 'Acme Co',
              business_unit: 'MMVA',
            },
          },
        ],
      },
    });

    await service.backfillFromHubspot('mmva');
    await service.backfillFromHubspot('mmva');

    // upsert (not create) called both runs — no duplicate rows possible
    expect(prisma.organization.upsert).toHaveBeenCalledTimes(2);
    expect((prisma.organization as any).create).toBeUndefined();
  });

  it('guards against concurrent runs for the same slug', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    let resolvePost: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolvePost = resolve;
    });
    mockedAxios.post.mockReturnValue(pending as any);

    const firstRun = service.backfillFromHubspot('mmva');
    // second call while the first is still in-flight must be rejected/skip immediately
    await expect(service.backfillFromHubspot('mmva')).rejects.toThrow(
      BadRequestException,
    );

    resolvePost!(emptySearch());
    mockedAxios.post.mockResolvedValue(emptySearch());
    await firstRun;
  });

  it('allows a new run for the same slug after the previous run finished', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post.mockResolvedValue(emptySearch());

    await service.backfillFromHubspot('mmva');
    await expect(service.backfillFromHubspot('mmva')).resolves.toBeDefined();
  });

  // ── specialties (String[] list column) normalization ────────────────────────
  // Regression: HubSpot returning no `specialty` made mapOrganizationToDb yield
  // `specialties: null`, which Prisma rejects for a `String[]` column and crashed
  // the whole backfill. The backfill must never send `null` for a list field.

  function backfillWithCompanyProps(properties: Record<string, unknown>) {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post
      .mockResolvedValueOnce({
        data: { results: [{ id: 'company-1', properties }] },
      })
      .mockResolvedValue(emptySearch()); // contacts, candidates, affiliates
    return { prisma, run: () => service.backfillFromHubspot('mmva') };
  }

  it('never sends null specialties to Prisma when HubSpot returns none (create + update are [])', async () => {
    const { prisma, run } = backfillWithCompanyProps({
      hs_object_id: 'company-1',
      name: 'Acme Co',
      business_unit: 'MMVA',
      specialty: null,
    });

    await run();

    const call = prisma.organization.upsert.mock.calls[0][0];
    expect(call.create.specialties).toEqual([]);
    expect(call.update.specialties).toEqual([]);
    expect(call.create.specialties).not.toBeNull();
    expect(call.update.specialties).not.toBeNull();
    expect(Array.isArray(call.create.specialties)).toBe(true);
    expect(Array.isArray(call.update.specialties)).toBe(true);
  });

  it('splits a comma-separated specialties string into an array', async () => {
    const { prisma, run } = backfillWithCompanyProps({
      hs_object_id: 'company-1',
      name: 'Acme Co',
      business_unit: 'MMVA',
      specialty: 'Cardiology, Neurology , Oncology',
    });

    await run();

    const call = prisma.organization.upsert.mock.calls[0][0];
    expect(call.create.specialties).toEqual([
      'Cardiology',
      'Neurology',
      'Oncology',
    ]);
    expect(call.update.specialties).toEqual([
      'Cardiology',
      'Neurology',
      'Oncology',
    ]);
  });

  it('preserves specialties that are already an array', async () => {
    const { prisma, run } = backfillWithCompanyProps({
      hs_object_id: 'company-1',
      name: 'Acme Co',
      business_unit: 'MMVA',
      specialty: ['Cardiology', 'Neurology'],
    });

    await run();

    const call = prisma.organization.upsert.mock.calls[0][0];
    expect(call.create.specialties).toEqual(['Cardiology', 'Neurology']);
    expect(call.update.specialties).toEqual(['Cardiology', 'Neurology']);
  });

  // ── HubSpot search filter property name ───────────────────────────────────

  function filterPropertyOfCall(callIndex: number): string {
    const body = mockedAxios.post.mock.calls[callIndex][1] as any;
    return body.filterGroups[0].filters[0].propertyName;
  }

  it('REGRESSION: filters the VA custom object on `business_units` (plural), not `business_unit`', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post.mockResolvedValue(emptySearch());

    await service.backfillFromHubspot('mmva');

    // Calls are issued in order: companies, contacts, candidates, affiliates.
    const candidatesCall = mockedAxios.post.mock.calls.findIndex(
      (call) =>
        String(call[0]).includes('Virtual_Assistant') ||
        String(call[0]).includes('2-5922196'),
    );
    expect(candidatesCall).toBeGreaterThanOrEqual(0);
    expect(filterPropertyOfCall(candidatesCall)).toBe('business_units');
  });

  it('filters companies, contacts and Growth Partners on the singular `business_unit`', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post.mockResolvedValue(emptySearch());

    await service.backfillFromHubspot('mmva');

    mockedAxios.post.mock.calls.forEach((call, index) => {
      const isVaObject =
        String(call[0]).includes('Virtual_Assistant') ||
        String(call[0]).includes('2-5922196');
      if (!isVaObject) {
        expect(filterPropertyOfCall(index)).toBe('business_unit');
      }
    });
  });

  // ── Partial-failure isolation + error sanitization ────────────────────────

  function hubspot400(message = 'There was a problem with the request.') {
    return {
      response: {
        status: 400,
        data: { status: 'error', message, correlationId: 'corr-abc-123' },
      },
      config: {
        headers: { Authorization: 'Bearer pat-na1-super-secret-token' },
      },
      message: 'Request failed with status code 400',
    };
  }

  it('one failing object type does not discard the counts of the other three', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'company-1',
              properties: { hs_object_id: 'company-1', name: 'Acme Co' },
            },
          ],
        },
      }) // companies
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'contact-1',
              properties: { hs_object_id: 'contact-1', email: 'a@b.com' },
            },
          ],
        },
      }) // contacts
      .mockRejectedValueOnce(hubspot400()) // candidates → HubSpot 400
      .mockResolvedValueOnce({
        data: {
          results: [
            {
              id: 'gp-1',
              properties: { hs_object_id: 'gp-1', growth_partner_name: 'Jane' },
            },
          ],
        },
      }); // affiliates

    const result = await service.backfillFromHubspot('mmva');

    expect(result.organizations).toBe(1);
    expect(result.contacts).toBe(1);
    expect(result.affiliates).toBe(1);
    expect(result.candidates).toBe(0);
    expect(result.failures).toEqual([expect.stringContaining('candidates')]);
  });

  it('never leaks the HubSpot access token in the surfaced error', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;
    mockedAxios.post.mockRejectedValue(hubspot400());

    const result = await service.backfillFromHubspot('mmva');

    const serialized = JSON.stringify(result.failures);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('pat-na1-super-secret-token');
    expect(serialized).not.toContain('Authorization');
    // ...but it still carries what's needed to debug the failure.
    expect(serialized).toContain('status=400');
    expect(serialized).toContain('corr-abc-123');
  });
});

// ── update() — is_visible false→true reactivation + backfill trigger ───────

describe('BusinessUnitsService.update — activation flow', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue(emptySearch());
  });

  it('reactivates deactivated_by_bu-tagged rows and fires backfill when is_visible flips false→true', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }]);
    const audit = makeAudit();
    const service = new (BusinessUnitsService as any)(
      prisma,
      audit,
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    expect(prisma.organization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ deactivated_by_bu: 'mmva' }]),
        }),
        data: expect.objectContaining({
          deactivated_by_bu: null,
          deletedAt: null,
        }),
      }),
    );
    expect(prisma.uSER.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deactivated_by_bu: 'mmva' },
        data: expect.objectContaining({ deactivated_by_bu: null }),
      }),
    );
    expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deactivated_by_bu: 'mmva' },
        data: expect.objectContaining({ deactivated_by_bu: null }),
      }),
    );
    expect(prisma.affiliateProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deactivated_by_bu: 'mmva' },
        data: expect.objectContaining({ deactivated_by_bu: null }),
      }),
    );
    expect(audit.log).toHaveBeenCalled();
  });

  it('PRIMARY REGRESSION: restores a webhook-deleted org (status=deleted, deactivated_by_bu=null, matching business_unit) to inactive with deletedAt cleared', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    // The webhook-deleted org: no marker, but belongs to the BU's hubspot_value.
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-webhook-1' }]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    // Organizations must be restored via a broadened match that includes
    // webhook-deleted rows (status=deleted + matching business_unit), not just
    // the marker. It must set status=inactive, clear the marker AND deletedAt.
    const orgCalls = prisma.organization.updateMany.mock.calls;
    const broadenedCall = orgCalls.find((call) => {
      const where = call[0]?.where ?? {};
      return Array.isArray(where.OR);
    });
    expect(broadenedCall).toBeDefined();
    expect(broadenedCall[0].where.OR).toEqual(
      expect.arrayContaining([
        { deactivated_by_bu: 'mmva' },
        {
          status: OrganizationStatus.deleted,
          business_unit: MMVA_BU.hubspot_value,
        },
      ]),
    );
    expect(broadenedCall[0].data).toEqual(
      expect.objectContaining({
        status: OrganizationStatus.inactive,
        deactivated_by_bu: null,
        deletedAt: null,
      }),
    );
  });

  it('still restores a cron-decommissioned org (deactivated_by_bu=slug) — no regression', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    prisma.organization.findMany.mockResolvedValue([]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    const orgCalls = prisma.organization.updateMany.mock.calls;
    const broadenedCall = orgCalls.find((call) =>
      Array.isArray(call[0]?.where?.OR),
    );
    expect(broadenedCall).toBeDefined();
    // The marker branch is present in the OR.
    expect(broadenedCall[0].where.OR).toEqual(
      expect.arrayContaining([{ deactivated_by_bu: 'mmva' }]),
    );
  });

  it('does NOT touch an org deleted for an UNRELATED business_unit', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    prisma.organization.findMany.mockResolvedValue([]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    const orgCalls = prisma.organization.updateMany.mock.calls;
    const broadenedCall = orgCalls.find((call) =>
      Array.isArray(call[0]?.where?.OR),
    );
    expect(broadenedCall).toBeDefined();
    // The broadened branch is scoped to THIS BU's hubspot_value only — an
    // unrelated BU's value ("OTHER_BU") is never part of the match.
    const serialized = JSON.stringify(broadenedCall[0].where.OR);
    expect(serialized).toContain(MMVA_BU.hubspot_value);
    expect(serialized).not.toContain('OTHER_BU');
  });

  it('still fires the backfill after reactivation (existing behavior preserved)', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    prisma.organization.findMany.mockResolvedValue([]);
    const audit = makeAudit();
    const service = new (BusinessUnitsService as any)(
      prisma,
      audit,
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    // backfill issues HubSpot search calls (axios.post) for the 4 object types.
    expect(mockedAxios.post).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalled();
  });

  it('does NOT reactivate or backfill when is_visible stays true→true', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU), // already visible
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(MMVA_BU),
      },
    });
    const audit = makeAudit();
    const service = new (BusinessUnitsService as any)(
      prisma,
      audit,
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    expect(prisma.organization.updateMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does NOT reactivate, deactivate or backfill on a false→false no-op transition', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu), // already hidden
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(dormantBu),
      },
    });
    const audit = makeAudit();
    const service = new (BusinessUnitsService as any)(
      prisma,
      audit,
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });
    await new Promise((r) => setTimeout(r, 10));

    expect(prisma.organization.updateMany).not.toHaveBeenCalled();
    expect(prisma.uSER.updateMany).not.toHaveBeenCalled();
    expect(prisma.candidate.updateMany).not.toHaveBeenCalled();
    expect(prisma.affiliateProfile.updateMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does NOT run the deactivation cascade on an activation (false→true) transition', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    prisma.organization.findMany.mockResolvedValue([]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: true });
    await new Promise((r) => setTimeout(r, 10));

    // Activation restores (clears) tags — it must NEVER set status=deleted or
    // re-tag rows with deactivated_by_bu.
    const orgDeactivations = prisma.organization.updateMany.mock.calls.filter(
      (c) => c[0]?.data?.deactivated_by_bu === 'mmva',
    );
    expect(orgDeactivations).toHaveLength(0);
    const affiliateDeactivations =
      prisma.affiliateProfile.updateMany.mock.calls.filter(
        (c) => c[0]?.data?.deactivated_by_bu === 'mmva',
      );
    expect(affiliateDeactivations).toHaveLength(0);
  });

  it('does not block the update() response on the backfill (fire-and-forget)', async () => {
    const dormantBu = { ...MMVA_BU, is_visible: false };
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(dormantBu),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...dormantBu, is_visible: true }),
      },
    });
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    // backfill's axios call never resolves during this test
    mockedAxios.post.mockReturnValue(new Promise(() => {}) as any);

    const result = await service.update('mmva', { is_visible: true });
    expect(result.status).toBe(200);
  });
});

// ── update() — is_visible true→false deactivation cascade ──────────────────
// The reported bug: deactivating a BU (true→false) left its Organizations,
// USERs, Candidates and Affiliates untouched. It must now cascade the exact
// same soft-delete the cron decommission path performs.

describe('BusinessUnitsService.update — deactivation flow', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockedAxios.post.mockResolvedValue(emptySearch());
  });

  function makeVisibleBuPrisma() {
    return makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU), // currently visible
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...MMVA_BU, is_visible: false }),
      },
    });
  }

  it('soft-deletes Organizations for the BU (status=deleted + deactivated_by_bu=slug)', async () => {
    const prisma = makeVisibleBuPrisma();
    prisma.organization.findMany.mockResolvedValue([
      { id: 'org-1' },
      { id: 'org-2' },
    ]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });

    expect(prisma.organization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_unit: MMVA_BU.hubspot_value },
        data: expect.objectContaining({
          status: OrganizationStatus.deleted,
          deactivated_by_bu: 'mmva',
        }),
      }),
    );
  });

  it('deactivates the USERs of the affected organizations (inactive + tagged)', async () => {
    const prisma = makeVisibleBuPrisma();
    prisma.organization.findMany.mockResolvedValue([
      { id: 'org-1' },
      { id: 'org-2' },
    ]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });

    expect(prisma.uSER.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: { in: ['org-1', 'org-2'] } },
        data: expect.objectContaining({
          status: 'inactive',
          deactivated_by_bu: 'mmva',
        }),
      }),
    );
  });

  it('tags Candidates for the BU with deactivated_by_bu=slug', async () => {
    const prisma = makeVisibleBuPrisma();
    prisma.organization.findMany.mockResolvedValue([]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });

    expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_unit: MMVA_BU.hubspot_value },
        data: expect.objectContaining({ deactivated_by_bu: 'mmva' }),
      }),
    );
  });

  it('sets AffiliateProfiles for the BU to inactive + tagged', async () => {
    const prisma = makeVisibleBuPrisma();
    prisma.organization.findMany.mockResolvedValue([]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });

    expect(prisma.affiliateProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_unit: MMVA_BU.hubspot_value },
        data: expect.objectContaining({
          status: AffiliateStatus.inactive,
          deactivated_by_bu: 'mmva',
        }),
      }),
    );
  });

  it('does NOT run the reactivation backfill (no HubSpot search) on deactivation', async () => {
    const prisma = makeVisibleBuPrisma();
    prisma.organization.findMany.mockResolvedValue([]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('busts the BusinessUnitContext cache and audit-logs the deactivation', async () => {
    const prisma = makeVisibleBuPrisma();
    prisma.organization.findMany.mockResolvedValue([]);
    const audit = makeAudit();
    const buContext = makeBuContext();
    const service = new (BusinessUnitsService as any)(
      prisma,
      audit,
      buContext,
      candidateAuditMock,
    ) as BusinessUnitsService;

    await service.update('mmva', { is_visible: false });

    expect(buContext.bustCache).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        payload: expect.objectContaining({ trigger: 'deactivation' }),
      }),
    );
  });
});

// ── Round-trip symmetry: deactivateByBu ⇄ reactivateDeactivatedByBu ─────────
// Everything deactivateByBu tags with deactivated_by_bu=slug must be exactly
// the set reactivateDeactivatedByBu restores (marker-based), proving the two
// halves are symmetric.

describe('BusinessUnitsService — deactivate/reactivate round-trip symmetry', () => {
  it('deactivate tags every object type with deactivated_by_bu=slug; reactivate restores exactly that tagged set', async () => {
    const prisma = makePrisma({
      businessUnit: {
        findUnique: jest.fn().mockResolvedValue(MMVA_BU),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(MMVA_BU),
      },
    });
    prisma.organization.findMany.mockResolvedValue([{ id: 'org-1' }]);
    const service = new (BusinessUnitsService as any)(
      prisma,
      makeAudit(),
      makeBuContext(),
      candidateAuditMock,
    ) as BusinessUnitsService;

    // ── Deactivate: tag everything deactivated_by_bu='mmva' ──
    await service.deactivateByBu('mmva', MMVA_BU.hubspot_value);

    for (const model of [
      'organization',
      'uSER',
      'candidate',
      'affiliateProfile',
    ] as const) {
      const calls = prisma[model].updateMany.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // Every deactivation write tags with the slug.
      expect(calls.some((c) => c[0]?.data?.deactivated_by_bu === 'mmva')).toBe(
        true,
      );
    }

    // Reset call history, then reactivate.
    prisma.organization.updateMany.mockClear();
    prisma.uSER.updateMany.mockClear();
    prisma.candidate.updateMany.mockClear();
    prisma.affiliateProfile.updateMany.mockClear();

    // ── Reactivate: restore exactly the marker-tagged set ──
    await (service as any).reactivateDeactivatedByBu(
      'mmva',
      MMVA_BU.hubspot_value,
    );

    // Organizations: broadened match includes the marker; restored to inactive,
    // marker + deletedAt cleared.
    const orgCall = prisma.organization.updateMany.mock.calls[0][0];
    expect(orgCall.where.OR).toEqual(
      expect.arrayContaining([{ deactivated_by_bu: 'mmva' }]),
    );
    expect(orgCall.data).toEqual(
      expect.objectContaining({
        status: OrganizationStatus.inactive,
        deactivated_by_bu: null,
        deletedAt: null,
      }),
    );

    // USERs: marker-scoped, tag cleared.
    expect(prisma.uSER.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deactivated_by_bu: 'mmva' },
        data: expect.objectContaining({ deactivated_by_bu: null }),
      }),
    );
    // Candidates: marker-scoped, tag cleared.
    expect(prisma.candidate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deactivated_by_bu: 'mmva' },
        data: expect.objectContaining({ deactivated_by_bu: null }),
      }),
    );
    // Affiliates: marker-scoped, restored to active, tag cleared.
    expect(prisma.affiliateProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deactivated_by_bu: 'mmva' },
        data: expect.objectContaining({
          status: AffiliateStatus.active,
          deactivated_by_bu: null,
        }),
      }),
    );
  });
});
