import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailTemplatesService } from './email-templates.service';
import { EmailTheme } from '../common/utils/email-templates/theme';

// ── Shared fixtures ────────────────────────────────────────────────────────────

const TEMPLATE = {
  id: 'tpl-1',
  key: 'invite-signup',
  name: 'User Invitation',
  description: null,
  subject: 'You have been invited to {{companyName}}',
  headline: 'Welcome!',
  body: 'Hi, click here: {{inviteLink}}',
  button_label: 'Activate',
  button_url: '{{inviteLink}}',
  category: 'talent',
  functionality: 'Onboarding',
  placeholders: ['{{inviteLink}}', '{{companyName}}'],
  business_unit: null,
  is_active: true,
  updated_by: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const HISTORY_ENTRY = {
  id: 'hist-1',
  template_id: 'tpl-1',
  subject: 'Old subject',
  headline: 'Old headline',
  body: 'Old body',
  button_label: 'Old button',
  category: 'talent',
  functionality: 'Onboarding',
  changed_by: 'user-42',
  changed_at: new Date('2026-01-01T10:00:00Z'),
  reason: 'Manual edit',
};

const BRANDING = {
  id: 'brand-1',
  business_unit: 'medvirtual',
  primary_color: '#01546B',
  secondary_color: '#013A4F',
  logo_url: 'https://staging.medvirtual.ai/logo.png',
  company_name: 'MedVirtual',
  layout_preset: 'default',
  updated_by: null,
  updated_at: new Date('2026-01-01'),
};

// ── Mock factories ─────────────────────────────────────────────────────────────

const makePrisma = (overrides: Record<string, unknown> = {}) => ({
  $transaction: jest.fn((ops: unknown[]) =>
    Promise.all(ops as Promise<unknown>[]),
  ),
  emailTemplate: {
    findFirst: jest.fn().mockResolvedValue(TEMPLATE),
    findMany: jest.fn().mockResolvedValue([TEMPLATE]),
    count: jest.fn().mockResolvedValue(1),
    update: jest
      .fn()
      .mockResolvedValue({ ...TEMPLATE, subject: 'Updated subject' }),
  },
  emailTemplateHistory: {
    create: jest.fn().mockResolvedValue(HISTORY_ENTRY),
    findMany: jest.fn().mockResolvedValue([HISTORY_ENTRY]),
    findUnique: jest.fn().mockResolvedValue(HISTORY_ENTRY),
  },
  emailBranding: {
    findUnique: jest.fn().mockResolvedValue(BRANDING),
  },
  uSER: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  ...overrides,
});

const makeMail = () => ({
  sendMail: jest.fn().mockResolvedValue(true),
});

async function buildService(prismaOverrides: Record<string, unknown> = {}) {
  const prisma = makePrisma(prismaOverrides);
  const mail = makeMail();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      EmailTemplatesService,
      { provide: 'PrismaService', useValue: prisma },
      { provide: 'MailService', useValue: mail },
    ],
  })
    .overrideProvider(EmailTemplatesService)
    .useFactory({
      factory: () => {
        const svc = new (EmailTemplatesService as any)(prisma, mail);
        return svc;
      },
    })
    .compile();

  return {
    service: module.get<EmailTemplatesService>(EmailTemplatesService),
    prisma,
    mail,
  };
}

// ── validatePlaceholders ───────────────────────────────────────────────────────

describe('EmailTemplatesService.validatePlaceholders', () => {
  let service: EmailTemplatesService;

  beforeAll(async () => {
    ({ service } = await buildService());
  });

  it('passes when body has no placeholders', () => {
    expect(() =>
      service.validatePlaceholders('Hello world', ['{{inviteLink}}']),
    ).not.toThrow();
  });

  it('passes when all used placeholders are in the allowed list', () => {
    expect(() =>
      service.validatePlaceholders('Click {{inviteLink}} and {{companyName}}', [
        '{{inviteLink}}',
        '{{companyName}}',
      ]),
    ).not.toThrow();
  });

  it('throws BadRequestException for a single undeclared placeholder', () => {
    expect(() =>
      service.validatePlaceholders('Hello {{userName}}', ['{{inviteLink}}']),
    ).toThrow(BadRequestException);
  });

  it('throws BadRequestException and lists all invalid placeholders', () => {
    try {
      service.validatePlaceholders('{{badOne}} and {{badTwo}}', [
        '{{inviteLink}}',
      ]);
      fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).message).toContain('{{badOne}}');
      expect((e as BadRequestException).message).toContain('{{badTwo}}');
    }
  });
});

// ── applyPlaceholders ──────────────────────────────────────────────────────────

describe('EmailTemplatesService.applyPlaceholders', () => {
  let service: EmailTemplatesService;

  beforeAll(async () => {
    ({ service } = await buildService());
  });

  it('replaces a known placeholder with sample data', () => {
    const result = service.applyPlaceholders('Hello {{userName}}');
    expect(result).toBe('Hello Jane Smith');
  });

  it('replaces multiple placeholders in a single call', () => {
    const result = service.applyPlaceholders('{{companyName}} — {{userName}}');
    expect(result).toBe('MedVirtual — Jane Smith');
  });

  it('leaves unknown placeholders unchanged', () => {
    const result = service.applyPlaceholders('Hello {{unknownField}}');
    expect(result).toBe('Hello {{unknownField}}');
  });

  it('allows caller overrides to take precedence over sample data', () => {
    const result = service.applyPlaceholders('Hi {{userName}}', {
      '{{userName}}': 'Dr. House',
    });
    expect(result).toBe('Hi Dr. House');
  });

  it('falls back to a friendly default when {{firstName}} is missing from overrides', () => {
    const result = service.applyPlaceholders('Hello, {{firstName}}!', {
      '{{companyName}}': 'Acme',
    });
    expect(result).toBe('Hello, there!');
  });

  it('logs a warning when a fallback is used', () => {
    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation();
    service.applyPlaceholders('Hello, {{firstName}}!', {});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('{{firstName}}'),
    );
    warnSpy.mockRestore();
  });

  it('does not use a fallback (or warn) when the override value is provided', () => {
    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation();
    const result = service.applyPlaceholders('Hello, {{firstName}}!', {
      '{{firstName}}': 'Jane',
    });
    expect(result).toBe('Hello, Jane!');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── findOne ────────────────────────────────────────────────────────────────────

describe('EmailTemplatesService.findOne', () => {
  it('returns the template when found', async () => {
    const { service } = await buildService();
    const result = await service.findOne('invite-signup');
    expect(result.status).toBe(200);
    expect(result.data.key).toBe('invite-signup');
  });

  it('throws NotFoundException when template does not exist', async () => {
    const { service } = await buildService({
      emailTemplate: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(service.findOne('nonexistent')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ── findAll ────────────────────────────────────────────────────────────────────

describe('EmailTemplatesService.findAll', () => {
  it('filters by category when provided', async () => {
    const { service, prisma } = await buildService();
    await service.findAll(1, 25, '', undefined, 'alliance');
    expect(prisma.emailTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: 'alliance' }),
      }),
    );
    expect(prisma.emailTemplate.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: 'alliance' }),
      }),
    );
  });

  it('filters by functionality when provided', async () => {
    const { service, prisma } = await buildService();
    await service.findAll(1, 25, '', undefined, undefined, 'Commission review');
    expect(prisma.emailTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ functionality: 'Commission review' }),
      }),
    );
  });

  it('combines category and functionality with businessUnit/search filters', async () => {
    const { service, prisma } = await buildService();
    await service.findAll(
      1,
      25,
      'invite',
      'medvirtual',
      'talent',
      'Onboarding',
    );
    expect(prisma.emailTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          business_unit: 'medvirtual',
          category: 'talent',
          functionality: 'Onboarding',
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('does not filter by category/functionality when omitted', async () => {
    const { service, prisma } = await buildService();
    await service.findAll(1, 25, '');
    const call = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('category');
    expect(call.where).not.toHaveProperty('functionality');
  });

  it('includes category/functionality in the select whitelist', async () => {
    const { service, prisma } = await buildService();
    await service.findAll(1, 25, '');
    expect(prisma.emailTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          category: true,
          functionality: true,
        }),
      }),
    );
  });

  it('resolves updated_by into a display name via a USER lookup', async () => {
    const { service } = await buildService({
      emailTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ...TEMPLATE, id: 't1', updated_by: 'user-42' },
          ]),
        count: jest.fn().mockResolvedValue(1),
      },
      uSER: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'user-42', first_name: 'Jane', last_name: 'Doe' },
          ]),
      },
    });
    const result = await service.findAll(1, 25, '');
    expect(result.data[0]).toMatchObject({
      updated_by: 'user-42',
      updated_by_name: 'Jane Doe',
    });
  });

  it('labels sync-originated rows as "Auto-sync" without a USER lookup', async () => {
    const { service, prisma } = await buildService({
      emailTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...TEMPLATE, id: 't1', updated_by: 'sync' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    });
    const result = await service.findAll(1, 25, '');
    expect(result.data[0]).toMatchObject({
      updated_by: 'sync',
      updated_by_name: 'Auto-sync',
    });
    expect(prisma.uSER.findMany).not.toHaveBeenCalled();
  });

  it('returns null updated_by_name when updated_by is null', async () => {
    const { service } = await buildService({
      emailTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ ...TEMPLATE, id: 't1', updated_by: null }]),
        count: jest.fn().mockResolvedValue(1),
      },
    });
    const result = await service.findAll(1, 25, '');
    expect(result.data[0]).toMatchObject({
      updated_by: null,
      updated_by_name: null,
    });
  });
});

// ── getFunctionalityOptions ─────────────────────────────────────────────────────

describe('EmailTemplatesService.getFunctionalityOptions', () => {
  it('returns distinct non-null functionality values', async () => {
    const { service, prisma } = await buildService({
      emailTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { functionality: 'Onboarding' },
            { functionality: 'Payroll' },
          ]),
      },
    });
    const result = await service.getFunctionalityOptions();
    expect(result).toEqual({ status: 200, data: ['Onboarding', 'Payroll'] });
    expect(prisma.emailTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ distinct: ['functionality'] }),
    );
  });

  it('filters out null/empty functionality values', async () => {
    const { service } = await buildService({
      emailTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { functionality: 'Onboarding' },
            { functionality: null },
            { functionality: '' },
          ]),
      },
    });
    const result = await service.getFunctionalityOptions();
    expect(result.data).toEqual(['Onboarding']);
  });
});

// ── update ─────────────────────────────────────────────────────────────────────

describe('EmailTemplatesService.update', () => {
  const dto = {
    subject: 'New subject',
    body: 'New body with {{inviteLink}}',
    reason: 'Test update',
  };

  it('saves a history snapshot before updating', async () => {
    const { service, prisma } = await buildService();
    await service.update('invite-signup', dto, 'user-1');
    expect(prisma.emailTemplateHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subject: TEMPLATE.subject,
          body: TEMPLATE.body,
          category: TEMPLATE.category,
          functionality: TEMPLATE.functionality,
          changed_by: 'user-1',
        }),
      }),
    );
  });

  it('persists the new wording to the template', async () => {
    const { service, prisma } = await buildService();
    await service.update('invite-signup', dto, 'user-1');
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subject: dto.subject,
          body: dto.body,
          updated_by: 'user-1',
        }),
      }),
    );
  });

  it('persists category/functionality when provided in the dto', async () => {
    const { service, prisma } = await buildService();
    await service.update(
      'invite-signup',
      { ...dto, category: 'administration', functionality: 'Payroll' },
      'user-1',
    );
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: 'administration',
          functionality: 'Payroll',
        }),
      }),
    );
  });

  it('falls back to existing category/functionality when omitted from dto', async () => {
    const { service, prisma } = await buildService();
    await service.update('invite-signup', dto, 'user-1');
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: TEMPLATE.category,
          functionality: TEMPLATE.functionality,
        }),
      }),
    );
  });

  it('persists category/functionality as null when explicitly cleared in the dto', async () => {
    const { service, prisma } = await buildService();
    await service.update(
      'invite-signup',
      { ...dto, category: null, functionality: null },
      'user-1',
    );
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: null,
          functionality: null,
        }),
      }),
    );
  });

  it('throws BadRequestException when body contains an undeclared placeholder', async () => {
    const { service } = await buildService();
    await expect(
      service.update(
        'invite-signup',
        { subject: 'S', body: 'Hi {{unknownField}}' },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when template does not exist', async () => {
    const { service } = await buildService({
      emailTemplate: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });
    await expect(service.update('ghost', dto, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('does NOT call syncToPeer when PEER_ENV_API_URL is not set', async () => {
    const originalFetch = global.fetch;
    const mockFetch = jest.fn();
    global.fetch = mockFetch;
    delete process.env.PEER_ENV_API_URL;
    delete process.env.INTER_ENV_SYNC_SECRET;

    const { service } = await buildService();
    await service.update('invite-signup', dto, 'user-1');

    // Allow the fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });

  it('calls syncToPeer when both PEER_ENV_API_URL and INTER_ENV_SYNC_SECRET are set', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;
    process.env.PEER_ENV_API_URL = 'https://peer.example.com';
    process.env.INTER_ENV_SYNC_SECRET = 'secret123';

    const { service } = await buildService();
    await service.update('invite-signup', dto, 'user-1');

    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledWith(
      'https://peer.example.com/email-templates/invite-signup/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Sync-Secret': 'secret123',
        }),
      }),
    );

    delete process.env.PEER_ENV_API_URL;
    delete process.env.INTER_ENV_SYNC_SECRET;
  });
});

// ── rollback ───────────────────────────────────────────────────────────────────

describe('EmailTemplatesService.rollback', () => {
  it('restores the snapshot values to the template', async () => {
    const { service, prisma } = await buildService();
    await service.rollback('invite-signup', 'hist-1', 'user-1');
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subject: HISTORY_ENTRY.subject,
          body: HISTORY_ENTRY.body,
          category: HISTORY_ENTRY.category,
          functionality: HISTORY_ENTRY.functionality,
        }),
      }),
    );
  });

  it('saves the current state to history before rolling back', async () => {
    const { service, prisma } = await buildService();
    await service.rollback('invite-signup', 'hist-1', 'user-1');
    expect(prisma.emailTemplateHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subject: TEMPLATE.subject,
          body: TEMPLATE.body,
          category: TEMPLATE.category,
          functionality: TEMPLATE.functionality,
          changed_by: 'user-1',
          reason: expect.stringContaining('Rollback'),
        }),
      }),
    );
  });

  it('throws NotFoundException when history entry does not exist', async () => {
    const { service } = await buildService({
      emailTemplateHistory: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    });
    await expect(
      service.rollback('invite-signup', 'bad-id', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when history entry belongs to a different template', async () => {
    const { service } = await buildService({
      emailTemplateHistory: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...HISTORY_ENTRY, template_id: 'tpl-OTHER' }),
        create: jest.fn(),
      },
    });
    await expect(
      service.rollback('invite-signup', 'hist-1', 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── receiveSyncFromPeer (anti-loop) ────────────────────────────────────────────

describe('EmailTemplatesService.receiveSyncFromPeer', () => {
  const payload = { subject: 'Synced subject', body: 'Synced body' };

  it('saves a history snapshot with changed_by = "sync"', async () => {
    const { service, prisma } = await buildService();
    await service.receiveSyncFromPeer('invite-signup', payload, 'PROD');
    expect(prisma.emailTemplateHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changed_by: 'sync',
          reason: 'Auto-sync from PROD',
        }),
      }),
    );
  });

  it('updates the template with the synced payload', async () => {
    const { service, prisma } = await buildService();
    await service.receiveSyncFromPeer('invite-signup', payload, 'PROD');
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subject: payload.subject,
          body: payload.body,
          updated_by: 'sync',
        }),
      }),
    );
  });

  it('applies category/functionality from the synced payload when present', async () => {
    const { service, prisma } = await buildService();
    await service.receiveSyncFromPeer(
      'invite-signup',
      { ...payload, category: 'administration', functionality: 'Payroll' },
      'PROD',
    );
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: 'administration',
          functionality: 'Payroll',
        }),
      }),
    );
  });

  it('falls back to existing category/functionality when payload omits them', async () => {
    const { service, prisma } = await buildService();
    await service.receiveSyncFromPeer('invite-signup', payload, 'PROD');
    expect(prisma.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: TEMPLATE.category,
          functionality: TEMPLATE.functionality,
        }),
      }),
    );
  });

  it('does NOT call syncToPeer after receiving a sync (anti-loop guarantee)', async () => {
    const mockFetch = jest.fn();
    global.fetch = mockFetch;
    process.env.PEER_ENV_API_URL = 'https://peer.example.com';
    process.env.INTER_ENV_SYNC_SECRET = 'secret123';

    const { service } = await buildService();
    await service.receiveSyncFromPeer('invite-signup', payload, 'PROD');

    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();

    delete process.env.PEER_ENV_API_URL;
    delete process.env.INTER_ENV_SYNC_SECRET;
  });

  it('ignores sync for an unknown template key without throwing', async () => {
    const { service } = await buildService({
      emailTemplate: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });
    await expect(
      service.receiveSyncFromPeer('nonexistent', payload, 'PROD'),
    ).resolves.not.toThrow();
  });
});

// ── testSend ───────────────────────────────────────────────────────────────────

describe('EmailTemplatesService.testSend', () => {
  it('sends an email to the user email with [TEST] prefix in subject', async () => {
    const { service, mail } = await buildService();
    await service.testSend('invite-signup', {}, 'user-1', 'admin@example.com');
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@example.com',
        subject: expect.stringContaining('[TEST]'),
      }),
    );
  });

  it('throws NotFoundException for an unknown template', async () => {
    const { service } = await buildService({
      emailTemplate: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(
      service.testSend('ghost', {}, 'user-1', 'admin@example.com'),
    ).rejects.toThrow(NotFoundException);
  });

  it('honors business_unit from dto for the template row, not just branding', async () => {
    const buRow = {
      ...TEMPLATE,
      business_unit: 'berry-virtual',
      headline: 'Berry Welcome!',
    };
    const findFirst = jest.fn().mockResolvedValueOnce(buRow);
    const { service, prisma, mail } = await buildService({
      emailTemplate: { findFirst },
    });
    await service.testSend(
      'invite-signup',
      { business_unit: 'berry-virtual' },
      'user-1',
      'admin@example.com',
    );
    expect(prisma.emailTemplate.findFirst).toHaveBeenCalledWith({
      where: { key: 'invite-signup', business_unit: 'berry-virtual' },
    });
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('Berry Welcome!'),
      }),
    );
  });

  it('falls back to the default row when the BU has no dedicated template', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(TEMPLATE);
    const { service, mail } = await buildService({
      emailTemplate: { findFirst },
    });
    await service.testSend(
      'invite-signup',
      { business_unit: 'berry-virtual' },
      'user-1',
      'admin@example.com',
    );
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: { key: 'invite-signup', business_unit: 'berry-virtual' },
    });
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: { key: 'invite-signup', business_unit: null },
    });
    expect(mail.sendMail).toHaveBeenCalled();
  });
});

// ── preview ────────────────────────────────────────────────────────────────────

describe('EmailTemplatesService.preview', () => {
  it('returns rendered HTML and subject with placeholders filled', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {});
    expect(result.status).toBe(200);
    expect(result.data.html).toContain('<!DOCTYPE html>');
    expect(result.data.subject).not.toContain('{{');
  });

  it('uses override body from dto when provided', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      body: 'Custom body content',
    });
    expect(result.data.html).toContain('Custom body content');
  });

  it('resolves branding from DB when business_unit is provided in dto', async () => {
    const { service, prisma } = await buildService();
    await service.preview('invite-signup', { business_unit: 'medvirtual' });
    expect(prisma.emailBranding.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { business_unit: 'medvirtual' } }),
    );
  });

  it('falls back to MedVirtual branding when no BU is provided', async () => {
    const { service, prisma } = await buildService({
      emailBranding: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const result = await service.preview('invite-signup', {});
    expect(result.data.html).toContain('#01546B');
  });

  it('honors business_unit from dto for the template row, not just branding', async () => {
    const buRow = {
      ...TEMPLATE,
      business_unit: 'berry-virtual',
      headline: 'Berry Welcome!',
    };
    const findFirst = jest.fn().mockResolvedValueOnce(buRow);
    const { service, prisma } = await buildService({
      emailTemplate: { findFirst },
    });
    const result = await service.preview('invite-signup', {
      business_unit: 'berry-virtual',
    });
    expect(prisma.emailTemplate.findFirst).toHaveBeenCalledWith({
      where: { key: 'invite-signup', business_unit: 'berry-virtual' },
    });
    expect(result.data.html).toContain('Berry Welcome!');
  });

  it('falls back to the default row when the BU has no dedicated template', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(TEMPLATE);
    const { service } = await buildService({
      emailTemplate: { findFirst },
    });
    const result = await service.preview('invite-signup', {
      business_unit: 'berry-virtual',
    });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: { key: 'invite-signup', business_unit: 'berry-virtual' },
    });
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: { key: 'invite-signup', business_unit: null },
    });
    expect(result.data.html).toContain(TEMPLATE.headline);
  });

  it('throws NotFoundException when neither the BU row nor the default row exists', async () => {
    const { service } = await buildService({
      emailTemplate: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(
      service.preview('ghost', { business_unit: 'berry-virtual' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('falls back to primary_color background and #ffffff text when button colors are unset', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toContain(
      `background-color: ${BRANDING.primary_color};\n      color: #ffffff !important;`,
    );
  });

  it('uses button_color and button_text_color from branding when set', async () => {
    const { service } = await buildService({
      emailBranding: {
        findUnique: jest.fn().mockResolvedValue({
          ...BRANDING,
          button_color: '#112233',
          button_text_color: '#F0F0F0',
        }),
      },
    });
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toContain(
      'background-color: #112233;\n      color: #F0F0F0 !important;',
    );
  });

  it('renders the CTA button with only a class, no inline style, so hover CSS actually applies in Gmail', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toMatch(/<a href="[^"]*" class="cta-button">/);
    expect(result.data.html).not.toContain('lang="x-cta-btn"');
  });

  it('renders a .cta-button:hover rule using the branding secondary_color', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toContain('class="cta-button"');
    expect(result.data.html).toContain(
      `.cta-button:hover {\n      background-color: ${BRANDING.secondary_color};`,
    );
  });
});

// ── layout presets ──────────────────────────────────────────────────────────────

describe('EmailTemplatesService — layout presets', () => {
  it('renders the solid banner div for the "default" preset', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
    );
  });

  it('omits the colored banner for the "minimal" preset and renders the logo inline', async () => {
    const { service } = await buildService({
      emailBranding: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...BRANDING, layout_preset: 'minimal' }),
      },
    });
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).not.toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
    );
    expect(result.data.html).toContain('class="logo"');
    expect(result.data.html).toContain(BRANDING.logo_url);
  });

  it('renders a tinted hero header with an accent bar for the "hero" preset', async () => {
    const { service } = await buildService({
      emailBranding: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...BRANDING, layout_preset: 'hero' }),
      },
    });
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toContain(
      `background:${BRANDING.primary_color}33;`,
    );
    expect(result.data.html).toContain(
      `background:${BRANDING.primary_color};margin:0 auto 20px;`,
    );
  });

  it('falls back to the "default" structure for an unrecognized layout_preset value', async () => {
    const { service } = await buildService({
      emailBranding: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...BRANDING, layout_preset: 'bogus-value' }),
      },
    });
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
    });
    expect(result.data.html).toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
    );
  });
});

// ── branding overrides in preview/testSend ──────────────────────────────────────

describe('EmailTemplatesService — branding overrides in preview/testSend', () => {
  it('preview() uses an overridden primary_color instead of the saved DB color', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
      primary_color: '#FF0000',
    });
    expect(result.data.html).toContain('background:#FF0000;');
    expect(result.data.html).not.toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;`,
    );
  });

  it('preview() switches structure via a layout_preset override while keeping saved colors/logo', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
      layout_preset: 'hero',
    });
    expect(result.data.html).toContain(
      `background:${BRANDING.primary_color}33;`,
    );
    expect(result.data.html).toContain(BRANDING.logo_url);
  });

  it('testSend() reflects branding overrides in the rendered email', async () => {
    const { service, mail } = await buildService();
    await service.testSend(
      'invite-signup',
      { business_unit: 'medvirtual', layout_preset: 'minimal' },
      'user-1',
      'admin@example.com',
    );
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.not.stringContaining(
          `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
        ),
      }),
    );
  });

  it('testSend() with no override fields behaves identically to before (back-compat)', async () => {
    const { service, mail } = await buildService();
    await service.testSend(
      'invite-signup',
      { business_unit: 'medvirtual' },
      'user-1',
      'admin@example.com',
    );
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `${BRANDING.company_name} <noreply@medvirtual.ai>`,
        html: expect.stringContaining(
          `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
        ),
      }),
    );
  });

  it('honors an explicit empty-string logo_url override as intentional (not "unset")', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      business_unit: 'medvirtual',
      logo_url: '',
    });
    // An explicit '' override is honored as-is (distinct from an omitted/undefined field,
    // which would fall back to the saved BRANDING.logo_url below).
    expect(result.data.html).not.toContain(BRANDING.logo_url);
    expect(result.data.html).toContain('src=""');
  });

  it('company_name override is reflected in testSend\'s mail "from" header', async () => {
    const { service, mail } = await buildService();
    await service.testSend(
      'invite-signup',
      { business_unit: 'medvirtual', company_name: 'Acme Corp' },
      'user-1',
      'admin@example.com',
    );
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Acme Corp <noreply@medvirtual.ai>' }),
    );
  });
});

// ── getTemplateContent (real transactional send path) ────────────────────────

describe('EmailTemplatesService.getTemplateContent', () => {
  const BASE_THEME = {
    primaryColor: BRANDING.primary_color,
    primaryColorHover: BRANDING.secondary_color,
    secondaryColor: '#F8F9FA',
    accentColor: BRANDING.primary_color,
    companyName: BRANDING.company_name,
    logoUrl: BRANDING.logo_url,
  };

  it('renders the solid banner div when theme.layoutPreset is "default"', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent(
      'invite-signup',
      {},
      { ...BASE_THEME, layoutPreset: 'default' },
    );
    expect(result.html).toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
    );
  });

  it('omits the colored banner and renders the logo inline when theme.layoutPreset is "minimal"', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent(
      'invite-signup',
      {},
      { ...BASE_THEME, layoutPreset: 'minimal' },
    );
    expect(result.html).not.toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
    );
    expect(result.html).toContain('class="logo"');
  });

  it('renders a tinted hero header with an accent bar when theme.layoutPreset is "hero"', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent(
      'invite-signup',
      {},
      { ...BASE_THEME, layoutPreset: 'hero' },
    );
    expect(result.html).toContain(`background:${BRANDING.primary_color}33;`);
    expect(result.html).toContain(
      `background:${BRANDING.primary_color};margin:0 auto 20px;`,
    );
  });

  it('falls back to the "default" structure when theme.layoutPreset is undefined', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent('invite-signup', {}, {
      ...BASE_THEME,
    } as EmailTheme);
    expect(result.html).toContain(
      `background:${BRANDING.primary_color};padding:30px 20px;text-align:center;`,
    );
  });
});

// ── header logo normalization ──────────────────────────────────────────────────

describe('EmailTemplatesService header logo normalization', () => {
  // Business unit logos have arbitrary aspect ratios, so the header must pin
  // HEIGHT (not width) or a tall logo renders far larger than a wide one.
  const BASE_THEME = {
    primaryColor: BRANDING.primary_color,
    primaryColorHover: BRANDING.secondary_color,
    secondaryColor: '#F8F9FA',
    accentColor: BRANDING.primary_color,
    companyName: BRANDING.company_name,
    logoUrl: BRANDING.logo_url,
  };

  const PRESETS = ['default', 'minimal', 'hero', 'unknown-legacy'];

  it.each(PRESETS)(
    'pins the logo height and lets width vary (preset: %s)',
    async (layoutPreset) => {
      const { service } = await buildService();
      const result = await service.getTemplateContent('invite-signup', {}, {
        ...BASE_THEME,
        layoutPreset,
      } as EmailTheme);

      const imgs = result.html
        .split('\n')
        .filter((line) => line.includes('<img'));

      expect(imgs.length).toBeGreaterThan(0);
      imgs.forEach((img) => {
        expect(img).toContain('height:40px');
        expect(img).toContain('width:auto');
        // Outlook ignores max-width on images, so the attribute must be present.
        expect(img).toContain('height="40"');
        expect(img).not.toContain('height:auto');
      });
    },
  );

  it('no longer renders the width-only rule that caused inconsistent heights', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent('invite-signup', {}, {
      ...BASE_THEME,
    } as EmailTheme);

    expect(result.html).not.toContain('max-width: 200px; height: auto;');
    expect(result.html).toContain(
      'height: 40px; width: auto; max-width: 200px',
    );
  });

  it('sizes the hero preset logo identically to the others', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent('invite-signup', {}, {
      ...BASE_THEME,
      layoutPreset: 'hero',
    } as EmailTheme);

    // The hero preset used to render its logo at 220px.
    expect(result.html).not.toContain('max-width:220px');
  });

  it('renders the logo configured on the business unit', async () => {
    const { service } = await buildService();
    const result = await service.getTemplateContent('invite-signup', {}, {
      ...BASE_THEME,
      logoUrl: 'https://cdn.example.com/custom-bu-logo.png',
    } as EmailTheme);

    expect(result.html).toContain('https://cdn.example.com/custom-bu-logo.png');
  });

  it('normalizes the logo on the preview path too', async () => {
    const { service } = await buildService();
    const result = await service.preview('invite-signup', {
      logo_url: 'https://cdn.example.com/preview-logo.png',
    });

    expect(result.data.html).toContain(
      'https://cdn.example.com/preview-logo.png',
    );
    expect(result.data.html).toContain('height="40"');
    expect(result.data.html).not.toContain('max-width: 200px; height: auto;');
  });
});
