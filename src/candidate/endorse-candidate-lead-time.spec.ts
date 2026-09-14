import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, Logger } from '@nestjs/common';

import { CandidatesService } from './candidates.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { GoogledriveService } from '../googledrive/googledrive.service';
import { OpenaiService } from '../openai/openai.service';
import { MailService } from '../mail/mail.service';
import { HireRequestService } from '../hire-request/hire-request.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { CandidateAuditService } from './candidate-audit.service';

/**
 * Dedicated spec for the 48h panel-candidate lead-time enforcement inside
 * `endorseCandidate`. Kept separate from `candidates.service.spec.ts` because
 * that file's shared `mockPrisma` does not model `candidatePanel`,
 * `panelCandidate.findFirst/createMany`, `candidate.findMany`, or
 * `interview` — the full surface this flow touches.
 */

const mockPrisma = {
  candidatePanel: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  candidate: {
    findMany: jest.fn(),
  },
  panelCandidate: {
    findFirst: jest.fn(),
    createMany: jest.fn(),
  },
  interview: {
    findFirst: jest.fn(),
  },
};

const s3Mock = { uploadFile: jest.fn(), getFile: jest.fn(), deleteFile: jest.fn() };
const googleMock = { downloadFile: jest.fn() };
const openAIMock = { organizeText: jest.fn() };
const hubspotMock = {
  updateContact: jest.fn(),
  updateOneCandidateFromHireRequest: jest.fn(),
};
const mailMock = { sendEmail: jest.fn() };
const hireRequestMock = { updateStatus: jest.fn() };
const notificationsMock = {
  notifyEndorseCandidates: jest.fn(),
  notifyPanelCandidateBlocked: jest.fn(),
};
const positionRateConfigMock = {
  findAll: jest.fn().mockResolvedValue({ status: 200, data: [], meta: { total: 0, page: 1, perPage: 10, totalPages: 0 } }),
  findAllUnpaginated: jest.fn().mockResolvedValue([]),
};
const businessUnitContextMock = {
  getVisibleHubspotValues: jest.fn(),
  isAllowedHubspotValue: jest.fn(),
  resolveByHubspotValue: jest.fn(),
  poolFor: jest.fn(),
  displayToSlug: jest.fn(),
  normalizeBusinessUnit: jest.fn(),
  bustCache: jest.fn(),
};
const candidateAuditMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

describe('CandidatesService.endorseCandidate — 48h panel-candidate lead time', () => {
  let service: CandidatesService;

  const orgUser = {
    id: 'user-org-1',
    organization_id: 'org-1',
    role: 'organization_admin',
  } as any;

  const adminUser = {
    id: 'user-admin-1',
    organization_id: null,
    role: 'system_admin',
  } as any;

  const baseData = {
    hireRequestId: 'hr-1',
    candidatesId: ['candidate-1'],
  };

  const mockCandidate = {
    id: 'candidate-1',
    hubspot_id: 'hs-1',
    pipeline_status: 'some-status',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidatesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: S3Service, useValue: s3Mock },
        { provide: GoogledriveService, useValue: googleMock },
        { provide: OpenaiService, useValue: openAIMock },
        { provide: HubspotService, useValue: hubspotMock },
        { provide: MailService, useValue: mailMock },
        { provide: HireRequestService, useValue: hireRequestMock },
        { provide: NotificationsService, useValue: notificationsMock },
        { provide: PositionRateConfigService, useValue: positionRateConfigMock },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
        { provide: Logger, useValue: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } },
      ],
    }).compile();

    service = module.get<CandidatesService>(CandidatesService);
    jest.clearAllMocks();

    mockPrisma.candidate.findMany.mockResolvedValue([mockCandidate]);
    mockPrisma.panelCandidate.findFirst.mockResolvedValue(null);
    mockPrisma.panelCandidate.createMany.mockResolvedValue({ count: 1 });
    notificationsMock.notifyEndorseCandidates.mockResolvedValue(true);
    notificationsMock.notifyPanelCandidateBlocked.mockResolvedValue(true);
  });

  it('rejects an organization user targeting a panel whose interview starts in 2h', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue({ id: 'panel-1' });
    mockPrisma.interview.findFirst.mockResolvedValue({
      scheduled_date: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    await expect(
      service.endorseCandidate({ ...baseData }, orgUser),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.panelCandidate.createMany).not.toHaveBeenCalled();
    expect(notificationsMock.notifyEndorseCandidates).not.toHaveBeenCalled();
  });

  it('notifies the hire request assignees when the 48h block fires', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue({ id: 'panel-1' });
    mockPrisma.interview.findFirst.mockResolvedValue({
      scheduled_date: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    await expect(
      service.endorseCandidate({ ...baseData }, orgUser),
    ).rejects.toThrow(BadRequestException);

    expect(notificationsMock.notifyPanelCandidateBlocked).toHaveBeenCalledWith(
      baseData.hireRequestId,
      orgUser.id,
      baseData.candidatesId,
    );
  });

  it('still throws BadRequestException when notifyPanelCandidateBlocked rejects', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue({ id: 'panel-1' });
    mockPrisma.interview.findFirst.mockResolvedValue({
      scheduled_date: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    notificationsMock.notifyPanelCandidateBlocked.mockRejectedValue(
      new Error('email provider down'),
    );

    await expect(
      service.endorseCandidate({ ...baseData }, orgUser),
    ).rejects.toThrow(BadRequestException);

    expect(mockPrisma.panelCandidate.createMany).not.toHaveBeenCalled();
  });

  it('allows an organization user targeting a panel whose interview starts in 72h', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue({ id: 'panel-1' });
    mockPrisma.interview.findFirst.mockResolvedValue({
      scheduled_date: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });

    const result = await service.endorseCandidate({ ...baseData }, orgUser);

    expect(result).toBe(true);
    expect(mockPrisma.panelCandidate.createMany).toHaveBeenCalled();
  });

  it('allows a system_admin targeting a panel whose interview starts in 2h', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue({ id: 'panel-1' });
    mockPrisma.interview.findFirst.mockResolvedValue({
      scheduled_date: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    const result = await service.endorseCandidate({ ...baseData }, adminUser);

    expect(result).toBe(true);
    expect(mockPrisma.panelCandidate.createMany).toHaveBeenCalled();
    // Admins should not even need the interview lookup gate to matter —
    // but it must not incorrectly block them when it does run.
  });

  it('allows an organization user when the panel has no scheduled-status interview', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue({ id: 'panel-1' });
    mockPrisma.interview.findFirst.mockResolvedValue(null);

    const result = await service.endorseCandidate({ ...baseData }, orgUser);

    expect(result).toBe(true);
    expect(mockPrisma.panelCandidate.createMany).toHaveBeenCalled();
  });

  it('allows an organization user when the panel is created fresh in the same call, without querying interviews', async () => {
    mockPrisma.candidatePanel.findFirst.mockResolvedValue(null);
    mockPrisma.candidatePanel.create.mockResolvedValue({ id: 'panel-new' });

    const result = await service.endorseCandidate({ ...baseData }, orgUser);

    expect(result).toBe(true);
    expect(mockPrisma.interview.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.panelCandidate.createMany).toHaveBeenCalled();
  });
});
