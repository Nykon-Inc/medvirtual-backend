import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';

/**
 * Dedicated spec for NotificationsService.notifyPanelCandidateBlocked, mirroring
 * the mocking conventions established in notifications.service.spec.ts.
 */
describe('NotificationsService.notifyPanelCandidateBlocked', () => {
  let service: NotificationsService;

  const mockPrismaService = {
    hireRequest: {
      findUnique: jest.fn(),
    },
    uSER: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    candidate: {
      findMany: jest.fn(),
    },
  };

  const mockMailService = {
    sendMail: jest.fn(),
  };

  const mockEmailTemplatesService = {
    getTemplateContent: jest.fn().mockResolvedValue(null),
  };

  const mockPositionRateConfigService = {
    findAllUnpaginated: jest.fn().mockResolvedValue([]),
  };

  const mockBusinessUnitContext = {
    poolFor: jest.fn().mockResolvedValue('medical'),
  };

  const mockHireRequest = {
    id: 'hr1',
    title: 'Blocked Job',
    assign_user_id: 'user1,user2',
    organization: { name: 'Test Org', business_unit: 'MedVirtual' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: MailService, useValue: mockMailService },
        { provide: EmailTemplatesService, useValue: mockEmailTemplatesService },
        {
          provide: PositionRateConfigService,
          useValue: mockPositionRateConfigService,
        },
        { provide: BusinessUnitContext, useValue: mockBusinessUnitContext },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);

    process.env.FRONTEND_URL = 'https://test.example.com';
    process.env.RESEND_API_KEY = 'test-api-key';
    delete process.env.ENVIRONMENT;

    jest.clearAllMocks();
    mockEmailTemplatesService.getTemplateContent.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it('resolves recipients from assign_user_id and calls mail.sendMail with all their emails', async () => {
    mockPrismaService.hireRequest.findUnique.mockResolvedValue(
      mockHireRequest,
    );
    mockPrismaService.uSER.findMany.mockResolvedValue([
      {
        id: 'user1',
        email: 'assignee1@example.com',
        first_name: 'Alice',
        last_name: 'Assignee',
      },
      {
        id: 'user2',
        email: 'assignee2@example.com',
        first_name: 'Bob',
        last_name: 'Assignee',
      },
    ]);
    mockPrismaService.uSER.findUnique.mockResolvedValue({
      first_name: 'Client',
      last_name: 'User',
      email: 'client@example.com',
    });
    mockPrismaService.candidate.findMany.mockResolvedValue([
      { id: 'c1', first_name: 'Jane', last_name: 'Candidate' },
    ]);
    mockMailService.sendMail.mockResolvedValue(true);

    const result = await service.notifyPanelCandidateBlocked(
      'hr1',
      'client-user-1',
      ['c1'],
    );

    expect(result).toBe(true);
    expect(mockMailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['assignee1@example.com', 'assignee2@example.com'],
      }),
    );
  });

  it('throws NotFoundException when hire request not found', async () => {
    mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

    await expect(
      service.notifyPanelCandidateBlocked('hr1', 'client-user-1', ['c1']),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns false without throwing when there are no assignees', async () => {
    mockPrismaService.hireRequest.findUnique.mockResolvedValue({
      ...mockHireRequest,
      assign_user_id: '',
    });
    mockPrismaService.uSER.findMany.mockResolvedValue([]);

    const result = await service.notifyPanelCandidateBlocked(
      'hr1',
      'client-user-1',
      ['c1'],
    );

    expect(result).toBe(false);
    expect(mockMailService.sendMail).not.toHaveBeenCalled();
  });

  it('returns false without throwing when assignees have no email', async () => {
    mockPrismaService.hireRequest.findUnique.mockResolvedValue(
      mockHireRequest,
    );
    mockPrismaService.uSER.findMany.mockResolvedValue([
      { id: 'user1', email: null, first_name: 'Alice', last_name: 'Assignee' },
    ]);

    const result = await service.notifyPanelCandidateBlocked(
      'hr1',
      'client-user-1',
      ['c1'],
    );

    expect(result).toBe(false);
    expect(mockMailService.sendMail).not.toHaveBeenCalled();
  });

  it('falls back to hardcoded HTML when no DB template row exists', async () => {
    mockPrismaService.hireRequest.findUnique.mockResolvedValue(
      mockHireRequest,
    );
    mockPrismaService.uSER.findMany.mockResolvedValue([
      {
        id: 'user1',
        email: 'assignee1@example.com',
        first_name: 'Alice',
        last_name: 'Assignee',
      },
    ]);
    mockPrismaService.uSER.findUnique.mockResolvedValue({
      first_name: 'Client',
      last_name: 'User',
      email: 'client@example.com',
    });
    mockPrismaService.candidate.findMany.mockResolvedValue([
      { id: 'c1', first_name: 'Jane', last_name: 'Candidate' },
    ]);
    mockEmailTemplatesService.getTemplateContent.mockResolvedValue(null);
    mockMailService.sendMail.mockResolvedValue(true);

    await service.notifyPanelCandidateBlocked('hr1', 'client-user-1', ['c1']);

    expect(mockMailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Action needed: candidate addition blocked on Blocked Job',
        html: expect.stringContaining('Client User'),
      }),
    );
  });

  it("uses the DB template's subject/html when one exists", async () => {
    mockPrismaService.hireRequest.findUnique.mockResolvedValue(
      mockHireRequest,
    );
    mockPrismaService.uSER.findMany.mockResolvedValue([
      {
        id: 'user1',
        email: 'assignee1@example.com',
        first_name: 'Alice',
        last_name: 'Assignee',
      },
    ]);
    mockPrismaService.uSER.findUnique.mockResolvedValue({
      first_name: 'Client',
      last_name: 'User',
      email: 'client@example.com',
    });
    mockPrismaService.candidate.findMany.mockResolvedValue([
      { id: 'c1', first_name: 'Jane', last_name: 'Candidate' },
    ]);
    mockEmailTemplatesService.getTemplateContent.mockResolvedValue({
      subject: 'Custom subject from DB',
      html: '<p>Custom DB html</p>',
    });
    mockMailService.sendMail.mockResolvedValue(true);

    await service.notifyPanelCandidateBlocked('hr1', 'client-user-1', ['c1']);

    expect(mockMailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Custom subject from DB',
        html: '<p>Custom DB html</p>',
      }),
    );
  });
});
