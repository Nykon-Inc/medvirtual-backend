import axios from 'axios';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationRole, USER } from '@prisma/client';

import { ConfigService } from '@nestjs/config';

import { HireRequestService } from './hire-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

import { panelReadyDTO } from './dto/panelReady-hire-request.dto';
import { ConfirmPanelHireRequestDto } from './dto/confirm-panel-hire-request.dto';
import { HubspotService } from '../hubspot/hubspot.service';
import { OpenaiService } from '../openai/openai.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { OfferPanelsService } from '../offer-panels/offer-panels.service';
import { CandidateAuditService } from '../candidate/candidate-audit.service';

jest.mock('axios', () => {
  const mockAxios = jest.requireActual('axios');
  return {
    ...mockAxios,
    create: jest.fn(() => ({
      interceptors: {
        request: { use: jest.fn(), eject: jest.fn() },
        response: { use: jest.fn(), eject: jest.fn() },
      },
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    })),
  };
});
const mockedAxios = axios as jest.Mocked<typeof axios>;

const prismaMock = {
  hireRequest: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  hireRequestSkill: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  },
  candidatePanel: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  candidate: {
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  panelCandidate: {
    createMany: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
  },
  interview: {
    create: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
  },
  uSER: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};
const hubspotServiceMock = {
  updateManyCandidatesFromHireRequest: jest.fn(),
  updateOneCandidateFromHireRequest: jest.fn(),
  updateHireRequestInHubspot: jest.fn(),
};

const notificationsServiceMock = {
  sendNotification: jest.fn(),
  createNotification: jest.fn(),
  getNotifications: jest.fn(),
  markAsRead: jest.fn(),
  deleteNotification: jest.fn(),
  notifyHireRequestPlacementCompleted: jest.fn(),
};

const openAIServiceMock = {
  generateTextSummary: jest.fn(),
};

const positionRateConfigMock = {
  findAll: jest.fn().mockResolvedValue({
    status: 200,
    data: [],
    meta: { total: 0, page: 1, perPage: 10, totalPages: 0 },
  }),
  findAllUnpaginated: jest.fn().mockResolvedValue([]),
};

const offerPanelsServiceMock = {
  removeCandidateFromAllPanels: jest.fn(),
};

const candidateAuditServiceMock = {
  log: jest.fn(),
  logOrThrow: jest.fn(),
  logMany: jest.fn(),
};

const configServiceMock = {
  get: jest.fn(),
};

const redisClientMock = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
};

const businessUnitContextMock = {
  poolFor: jest.fn().mockResolvedValue('medical'),
};

describe('HireRequestService', () => {
  let service: HireRequestService;
  let user: USER;

  beforeEach(async () => {
    jest.clearAllMocks();
    redisClientMock.get.mockResolvedValue(null);
    redisClientMock.set.mockResolvedValue('OK');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HireRequestService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotService, useValue: hubspotServiceMock },
        { provide: NotificationsService, useValue: notificationsServiceMock },
        { provide: OpenaiService, useValue: openAIServiceMock },
        {
          provide: PositionRateConfigService,
          useValue: positionRateConfigMock,
        },
        { provide: OfferPanelsService, useValue: offerPanelsServiceMock },
        { provide: CandidateAuditService, useValue: candidateAuditServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: 'REDIS_CLIENT', useValue: redisClientMock },
        { provide: BusinessUnitContext, useValue: businessUnitContextMock },
      ],
    }).compile();

    service = module.get<HireRequestService>(HireRequestService);
    user = {
      id: '1',
      organization_id: 'org1',
      role: 'organization_admin',
      email: 'test@test.com',
      password: '',
      organization_name: 'Default Organization',
      first_name: 'John',
      last_name: 'Doe',
      phone: '',
      avatar: '',
      job_title: '',
      workos_id: '',
      authentication_method: 'OwnSign',
      status: 'active',
      is_organization_owner: false,
      verified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      activatedAt: new Date(),
      createdByMethod: 'self_signup',
      createdByUserId: null,
      hubspot_id: null,
      hubspot_contact_id: null,
      status_before_deactivation: null,
      billcom_session_id: null,
      billcom_session_expires: null,
      billcom_pending_session_id: null,
      billcom_remember_me_id: null,
      billcom_device: null,
      deactivated_by_bu: null,
      onboarding_tour_dismissed: false,
    };
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const baseDto = {
      title: 'Dev',
      description: 'Job description',
      numberVA: 1,
      position: 'Developer',
      availability: 'full-time',
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no org', async () => {
      await expect(
        service.create(baseDto as any, { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if user is system and has no client_id', async () => {
      const systemUser = { ...user, role: 'system' };
      await expect(service.create(baseDto as any, systemUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if organization not found', async () => {
      prismaMock.organization.findUnique.mockResolvedValue(null);
      await expect(service.create(baseDto as any, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should create hire request with skills', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.hireRequestSkill.createMany.mockResolvedValue({ count: 2 });
      prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        hubspot_pairing_date: null,
        skills: [{ skill_name: 'JS' }, { skill_name: 'TS' }],
      });

      const dto = {
        ...baseDto,
        skills: [
          { name: 'JS', level: 'advanced' },
          { name: 'TS', level: 'intermediate' },
        ],
      };

      const result = await service.create(dto as any, user);

      expect(result).toEqual({
        id: 'hr1',
        hubspot_pairing_date: null,
        skills: [{ skill_name: 'JS' }, { skill_name: 'TS' }],
        panels: [],
      });
      expect(prismaMock.hireRequest.create).toHaveBeenCalled();
      expect(prismaMock.hireRequestSkill.createMany).toHaveBeenCalled();
      expect(prismaMock.candidatePanel.create).toHaveBeenCalled();
    });

    it('should create hire request without skills', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        skills: [],
      });

      const dto = { ...baseDto };

      const result = await service.create(dto as any, user);

      expect(result).toEqual({
        id: 'hr1',
        hubspot_pairing_date: null,
        skills: [],
        panels: [],
      });
      expect(prismaMock.hireRequestSkill.createMany).not.toHaveBeenCalled();
      expect(prismaMock.candidatePanel.create).toHaveBeenCalled();
    });

    it('should set status as pending_signature if organization is not active', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'prospect',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        skills: [],
      });

      await service.create(baseDto as any, user);

      expect(prismaMock.hireRequest.create).toHaveBeenCalled();
    });

    it('should set status as new if organization is active', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
        organization_role: OrganizationRole.client,
        admin_id: 'user1',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        skills: [],
      });

      await service.create(baseDto as any, user);

      expect(prismaMock.hireRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'new',
          }),
        }),
      );
    });

    it('should throw BadRequestException if hireRequest is not created', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue(null);

      await expect(service.create(baseDto as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if hireRequestSkills is not created when skills exist', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.hireRequestSkill.createMany.mockResolvedValue(null);

      const dto = {
        ...baseDto,
        skills: [{ name: 'JS', level: 'advanced' }],
      };

      await expect(service.create(dto as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if panel is not created', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.hireRequestSkill.createMany.mockResolvedValue({ count: 1 });
      prismaMock.candidatePanel.create.mockResolvedValue(null);

      const dto = {
        ...baseDto,
        skills: [{ name: 'JS', level: 'advanced' }],
      };

      await expect(service.create(dto as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should create hire request without request_role (now optional)', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue({ id: 'hr1' });
      prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        skills: [],
      });

      const dto = { ...baseDto }; // no request_role

      const result = await service.create(dto as any, user);

      expect(result).toBeDefined();
      expect(prismaMock.hireRequest.create).toHaveBeenCalled();
    });

    it('should persist background_requirements_of_candidate on create', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({
        status: 'active',
      });
      prismaMock.hireRequest.create.mockResolvedValue({
        id: 'hr1',
        background_requirements_of_candidate:
          'Preferred: Athena | Mandatory: Prior Auth',
      });
      prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        skills: [],
        background_requirements_of_candidate:
          'Preferred: Athena | Mandatory: Prior Auth',
      });

      const dto = {
        ...baseDto,
        background_requirements_of_candidate:
          'Preferred: Athena | Mandatory: Prior Auth',
      };

      await service.create(dto as any, user);

      expect(prismaMock.hireRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            background_requirements_of_candidate:
              'Preferred: Athena | Mandatory: Prior Auth',
          }),
        }),
      );
    });
  });

  describe.skip('findAll', () => {
    it('should return formatted hire requests with interview_date and pagination', async () => {
      const mockHireRequests = [
        {
          id: 'hr1',
          panels: [
            {
              id: 'p1',
              status: 'scheduled',
              scheduled_date: new Date(),
              readable: true,
              panelCandidates: [],
              interviews: [
                { scheduled_date: new Date('2025-08-25T10:00:00Z') },
              ],
            },
          ],
        },
      ];
      const mockTotal = 1;

      prismaMock.$transaction.mockResolvedValue([mockHireRequests, mockTotal]);

      const result = await service.findAll({
        ...user,
        role: 'organization_admin',
      });

      expect(result).toEqual({
        data: [
          {
            id: 'hr1',
            panels: [
              {
                id: 'p1',
                status: 'scheduled',
                scheduled_date: expect.any(Date),
                readable: true,
                panelCandidates: [],
                interview_date: new Date('2025-08-25T10:00:00Z'),
                interviews: undefined,
              },
            ],
          },
        ],
        meta: {
          total: 1,
          page: 1,
          perPage: 10,
          totalPages: 1,
        },
      });

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      const args = prismaMock.$transaction.mock.calls[0][0];
      expect(args[0].where).toEqual({
        organization: { id: user.organization_id },
      });
      expect(args[1].where).toEqual({
        organization: { id: user.organization_id },
      });
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.findAll({ ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if user has no role', async () => {
      await expect(service.findAll({ ...user, role: '' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return empty array with pagination meta if no hire requests found', async () => {
      prismaMock.$transaction.mockResolvedValue([[], 0]);
      const result = await service.findAll(user);
      expect(result).toEqual({
        data: [],
        meta: {
          total: 0,
          page: 1,
          perPage: 10,
          totalPages: 0,
        },
      });
    });

    it('should filter hire requests by title when search parameter is provided', async () => {
      const mockHireRequests = [
        {
          id: 'hr1',
          title: 'Software Engineer',
          panels: [],
        },
      ];
      prismaMock.$transaction.mockResolvedValue([mockHireRequests, 1]);

      const result = await service.findAll(
        { ...user, role: 'organization_admin' },
        'Software',
      );

      expect(result.meta.total).toBe(1);
      expect(result.data[0].title).toBe('Software Engineer');

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      const args = prismaMock.$transaction.mock.calls[0][0];
      expect(args[0].where).toEqual({
        organization: { id: user.organization_id },
        title: { contains: 'Software', mode: 'insensitive' },
      });
      expect(args[1].where).toEqual({
        organization: { id: user.organization_id },
        title: { contains: 'Software', mode: 'insensitive' },
      });
    });
  });

  describe('findOne', () => {
    it('should return formatted hire request with interview_date', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        panels: [
          {
            id: 'p1',
            status: 'scheduled',
            scheduled_date: new Date(),
            readable: true,
            panelCandidates: [],
            interviews: [{ scheduled_date: new Date('2025-08-25T10:00:00Z') }],
          },
        ],
      });

      const result = await service.findOne('hr1', user);

      expect(result).toEqual({
        id: 'hr1',
        hubspot_pairing_date: null,
        panels: [
          {
            id: 'p1',
            status: 'scheduled',
            scheduled_date: expect.any(Date),
            readable: true,
            panelCandidates: [],
            interview_date: new Date('2025-08-25T10:00:00Z'),
            interview_link: null,
            interviews: undefined,
          },
        ],
      });

      expect(prismaMock.hireRequest.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'hr1',
            organization: { id: user.organization_id },
          },
        }),
      );
    });

    it('should throw NotFoundException if no org', async () => {
      await expect(
        service.findOne('hr1', { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hire request not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);
      await expect(service.findOne('hr1', user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return panel with interview_date = null if no interviews', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        panels: [
          {
            id: 'p1',
            status: 'scheduled',
            scheduled_date: new Date(),
            readable: true,
            panelCandidates: [],
            interviews: [],
          },
        ],
      });

      const result = await service.findOne('hr1', user);

      expect(result.panels[0]).toEqual(
        expect.objectContaining({
          id: 'p1',
          interview_date: null,
          interviews: undefined,
        }),
      );
    });
  });

  describe('update', () => {
    it('should update hire request with skills', async () => {
      prismaMock.hireRequest.update.mockResolvedValue({ id: 'hr1' });
      prismaMock.hireRequestSkill.deleteMany.mockResolvedValue({});
      prismaMock.hireRequestSkill.createMany.mockResolvedValue({ count: 2 });

      const mockSkills = [
        {
          skill_name: 'JS',
          required_level: 'advanced',
          hire_request_id: 'hr1',
        },
      ];
      prismaMock.hireRequestSkill.findMany.mockResolvedValue(mockSkills);

      // agora precisa mockar o findOne porque é o retorno final
      const mockHireRequestWithSkills = {
        id: 'hr1',
        title: 'Updated',
        skills: mockSkills,
      };
      jest
        .spyOn(service['hubspot'], 'updateHireRequestInHubspot')
        .mockResolvedValue(true);
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(mockHireRequestWithSkills);

      const dto = {
        title: 'Updated',
        skills: [{ name: 'JS', level: 'advanced' }],
      };

      const result = await service.update('hr1', dto as any, user);

      expect(result).toEqual(mockHireRequestWithSkills);

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: 'hr1' },
        data: {
          title: 'Updated',
          hubspot_pairing_date: null,
          staff_to_be_replaced_id: null,
          hubspot_contract_amount: null,
        },
      });
      expect(prismaMock.hireRequestSkill.deleteMany).toHaveBeenCalledWith({
        where: { hire_request_id: 'hr1' },
      });
      expect(prismaMock.hireRequestSkill.createMany).toHaveBeenCalledWith({
        data: [
          {
            skill_name: 'JS',
            required_level: 'advanced',
            hire_request_id: 'hr1',
          },
        ],
      });
      expect(prismaMock.hireRequestSkill.findMany).toHaveBeenCalledWith({
        where: { hire_request_id: 'hr1' },
      });
      expect(service.findOne).toHaveBeenCalledWith('hr1', user, 'hubspot');
    });

    it('should throw NotFoundException if no org', async () => {
      await expect(
        service.update('hr1', {} as any, { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if update fails', async () => {
      prismaMock.hireRequest.update.mockResolvedValue(null);
      await expect(service.update('hr1', {} as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if skills update fails', async () => {
      prismaMock.hireRequest.update.mockResolvedValue({ id: 'hr1' });
      prismaMock.hireRequestSkill.deleteMany.mockResolvedValue({});
      prismaMock.hireRequestSkill.createMany.mockResolvedValue(null);

      await expect(
        service.update(
          'hr1',
          { skills: [{ name: 'JS', level: 'advanced' }] } as any,
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should persist background_requirements_of_candidate on update', async () => {
      const mockUpdated = {
        id: 'hr1',
        background_requirements_of_candidate: 'Updated requirement',
      };
      prismaMock.hireRequest.update.mockResolvedValue(mockUpdated);
      jest
        .spyOn(service['hubspot'], 'updateHireRequestInHubspot')
        .mockResolvedValue(true);
      jest.spyOn(service, 'findOne').mockResolvedValue(mockUpdated);

      const dto = {
        title: 'Updated Title',
        availability: 'full-time',
        expected_start_date: new Date(),
        background_requirements_of_candidate: 'Updated requirement',
      };

      await service.update('hr1', dto as any, user);

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            background_requirements_of_candidate: 'Updated requirement',
          }),
        }),
      );
    });
  });

  describe.skip('updateStatus', () => {
    const hireRequestId = 'hr1';
    const baseUser = { id: 'user1', organization_id: 'org1' } as USER;
    const candidates = [
      { panel_id: 'panel1', candidate: { id: 'cand1', hubspot_id: 'hs1' } },
    ];

    beforeEach(() => {
      jest.clearAllMocks();

      jest.spyOn(service as any, 'verifyAssignUser').mockResolvedValue(true);
      jest
        .spyOn(service as any, 'updateHireRequestStatus')
        .mockResolvedValue(true);
      jest.spyOn(service as any, 'findOne').mockResolvedValue(true);

      jest
        .spyOn(service['hubspot'], 'updateManyCandidatesFromHireRequest')
        .mockResolvedValue(true);
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.updateStatus(
          hireRequestId,
          { status: 'new' },
          { ...baseUser, organization_id: null },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hire request not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);
      await expect(
        service.updateStatus(hireRequestId, { status: 'new' }, baseUser),
      ).rejects.toThrow(NotFoundException);
    });

    describe('cancelled status flow', () => {
      beforeEach(() => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'sourcing',
        });
        prismaMock.panelCandidate.findMany.mockResolvedValue(candidates);
        prismaMock.candidatePanel.deleteMany.mockResolvedValue({ count: 1 });
        prismaMock.candidate.updateMany.mockResolvedValue({ count: 1 });
      });

      it('should update hireRequest, remove candidates and update HubSpot', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'sourcing',
        });
        prismaMock.panelCandidate.findMany.mockResolvedValue(candidates);
        prismaMock.candidatePanel.deleteMany.mockResolvedValue({ count: 1 });
        prismaMock.candidate.updateMany.mockResolvedValue({
          count: candidates.length,
        });

        jest
          .spyOn(service['hubspot'], 'updateManyCandidatesFromHireRequest')
          .mockResolvedValue(true);

        const result = await service.updateStatus(
          hireRequestId,
          { status: 'cancelled' },
          baseUser,
        );

        expect(result).toBe(true);

        expect(prismaMock.candidatePanel.deleteMany).toHaveBeenCalledWith({
          where: { hire_request_id: hireRequestId },
        });

        expect(prismaMock.candidate.updateMany).toHaveBeenCalledWith({
          where: { id: { in: candidates.map((c) => c.candidate.id) } },
          data: expect.any(Object),
        });

        expect(
          service['hubspot'].updateManyCandidatesFromHireRequest,
        ).toHaveBeenCalledWith(
          candidates.map((c) => c.candidate),
          expect.any(String),
        );
      });
    });

    describe('reopen as new', () => {
      beforeEach(() => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'cancelled',
        });
        prismaMock.panelCandidate.findMany.mockResolvedValue(candidates);
        prismaMock.candidatePanel.deleteMany.mockResolvedValue({ count: 1 });
      });

      it('should delete panel candidates, update HubSpot and reopen', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'cancelled',
        });
        prismaMock.panelCandidate.findMany.mockResolvedValue(candidates);
        prismaMock.candidatePanel.deleteMany.mockResolvedValue({ count: 1 });
        jest
          .spyOn(service['hubspot'], 'updateManyCandidatesFromHireRequest')
          .mockResolvedValue(true);

        const result = await service.updateStatus(
          hireRequestId,
          { status: 'new' },
          baseUser,
        );

        expect(result).toBe(true);

        expect(prismaMock.candidatePanel.deleteMany).toHaveBeenCalledWith({
          where: { hire_request_id: hireRequestId },
        });

        expect(
          service['hubspot'].updateManyCandidatesFromHireRequest,
        ).toHaveBeenCalledWith(
          candidates.map((c) => c.candidate),
          expect.any(String),
        );
      });
    });

    describe('panel_ready to sourcing', () => {
      beforeEach(() => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'panel_ready',
        });
        prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });
      });

      it('should update panel readable=false and hireRequest status', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'panel_ready',
        });
        prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });

        const result = await service.updateStatus(
          hireRequestId,
          { status: 'sourcing' },
          baseUser,
        );
        expect(result).toBe(true);

        expect(prismaMock.candidatePanel.updateMany).toHaveBeenCalledWith({
          where: { hire_request_id: hireRequestId },
          data: { readable: false },
        });
      });
    });

    describe('new to sourcing with panel creation', () => {
      beforeEach(() => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({ status: 'new' });
        prismaMock.candidatePanel.findFirst.mockResolvedValue(null);
        prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
      });

      it('should create a new panel if none exists', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({ status: 'new' });
        prismaMock.candidatePanel.findFirst.mockResolvedValue(null);
        prismaMock.candidatePanel.create.mockResolvedValue({ id: 'panel1' });
        const result = await service.updateStatus(
          hireRequestId,
          { status: 'sourcing' },
          baseUser,
        );

        expect(result).toBe(true);

        expect(prismaMock.candidatePanel.create).toHaveBeenCalledWith({
          data: { hire_request_id: hireRequestId, readable: false },
        });
      });
    });

    describe('panel_ready to placement_completed', () => {
      beforeEach(() => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'panel_ready',
        });
        prismaMock.candidatePanel.findFirst.mockResolvedValue({
          id: 'panel1',
          panelCandidates: [{ status: 'selected_by_client' }],
          interviews: [],
        });
      });

      it('should update hire request status to placement_completed', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'panel_ready',
        });
        prismaMock.candidatePanel.findFirst.mockResolvedValue({
          id: 'panel1',
          panelCandidates: [{ status: 'selected_by_client' }],
          interviews: [],
        });

        const result = await service.updateStatus(
          hireRequestId,
          { status: 'placement_completed' },
          baseUser,
        );

        expect(result).toBe(true);

        expect(prismaMock.hireRequest.findUnique).toHaveBeenCalledWith({
          where: { id: hireRequestId },
          select: { status: true },
        });
        expect(prismaMock.candidatePanel.findFirst).toHaveBeenCalledWith({
          where: { hire_request_id: hireRequestId },
          include: { panelCandidates: true, interviews: true },
        });
      });
    });

    describe.skip('invalid status change', () => {
      beforeEach(() => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          status: 'sourcing',
        });
      });

      it('should throw BadRequestException if status change is invalid', async () => {
        await expect(
          service.updateStatus(
            hireRequestId,
            { status: 'placement_completed' },
            baseUser,
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });

  describe.skip('showMatchCandidates', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      process.env.CANDIDATE_HOUR_PER_MONTH = '176';
      process.env.CANDIDATE_PERCENT = '1';
      process.env.CANDIDATE_COST_PER_HOUR = '3.29';
    });

    it('should return scored candidates sorted by score', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: 'hr1',
        specialization: 'Frontend',
        location: 'Brazil',
        availability: 'full-time',
        salary_range_from: 4000,
        salary_range_to: 8000,
        skills: [
          { skill_name: 'React', required_level: 'advanced' },
          { skill_name: 'JavaScript', required_level: 'advanced' },
        ],
      });

      prismaMock.candidate.findMany.mockResolvedValue([
        {
          id: 'cand1',
          specialization: 'Frontend',
          country: 'Brazil',
          employment_type: 'full-time',
          hourly_pay_rate: { toNumber: () => 30 },
          skills: [
            { skill_name: 'React' },
            { skill_name: 'JavaScript' },
            { skill_name: 'CSS' },
          ],
          experiences: [],
          educations: [],
        },
        {
          id: 'cand2',
          specialization: 'Frontend',
          country: 'Brazil',
          employment_type: 'full-time',
          hourly_pay_rate: { toNumber: () => 35 },
          skills: [{ skill_name: 'React' }],
          experiences: [],
          educations: [],
        },
      ]);

      const result = await service.showMatchCandidates('hr1', user);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('cand1');
      expect(result[0]).toHaveProperty('matchedSkills', [
        'React',
        'JavaScript',
      ]);
      expect(result[0].score).toBe(6);
      expect(result[1].score).toBe(5);

      expect(prismaMock.hireRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'hr1' },
        select: expect.any(Object),
      });

      expect(prismaMock.candidate.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { pipeline_status: '261075105' },
            { pipeline_status: '1087596819' },
          ],
        },
        include: {
          skills: true,
          experiences: true,
          educations: true,
        },
      });
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.showMatchCandidates('hr1', { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hireRequest is not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.showMatchCandidates('hr1', user)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus - interview_scheduled to sourcing', () => {
    const hireRequestId = 'hr1';
    const baseUser = {
      id: 'user1',
      organization_id: 'org1',
      role: 'system_admin',
    } as USER;

    beforeEach(() => {
      jest.clearAllMocks();

      jest.spyOn(service as any, 'verifyAssignUser').mockResolvedValue(true);
      jest
        .spyOn(service as any, 'updateHireRequestStatus')
        .mockResolvedValue(true);
      jest
        .spyOn(service as any, 'findOne')
        .mockResolvedValue({ status: 'interview_scheduled' });

      prismaMock.panelCandidate.findMany.mockResolvedValue([]);
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
        interviews: [{ id: 'interview1' }],
      });
      prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.interview.deleteMany.mockResolvedValue({ count: 1 });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('resets CandidatePanel.status back to created and clears the scheduled interview', async () => {
      await service.updateStatus(
        hireRequestId,
        { status: 'sourcing' },
        baseUser,
      );

      // Regression guard: leaving interview_scheduled must not leave the
      // panel's own status stuck at interview_scheduled, otherwise
      // GET /hire-request/get-panels/all keeps bucketing the card under
      // "Interview Scheduled" on the client side even though the hire
      // request itself moved back to sourcing.
      expect(prismaMock.candidatePanel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { hire_request_id: hireRequestId },
          data: expect.objectContaining({ status: 'created' }),
        }),
      );

      expect(prismaMock.interview.deleteMany).toHaveBeenCalledWith({
        where: { panel_id: 'panel1' },
      });
    });

    it('does not touch CandidatePanel.status or delete interviews for panel_ready -> sourcing', async () => {
      jest
        .spyOn(service as any, 'findOne')
        .mockResolvedValue({ status: 'panel_ready' });

      await service.updateStatus(
        hireRequestId,
        { status: 'sourcing' },
        baseUser,
      );

      expect(prismaMock.candidatePanel.updateMany).toHaveBeenCalledWith({
        where: { hire_request_id: hireRequestId },
        data: { readable: false },
      });
      expect(prismaMock.interview.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('confirmPanel', () => {
    const panelData = {
      hireRequest_id: 'hr1',
      candidates_id: ['cand1', 'cand2', 'cand3', 'cand4', 'cand5'],
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.confirmPanel(panelData, { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if data is missing', async () => {
      await expect(
        service.confirmPanel({} as ConfirmPanelHireRequestDto, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if panel does not exist', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);

      await expect(service.confirmPanel(panelData, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should skip addCandidates if candidates_id is empty', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'sourcing',
      });
      prismaMock.candidate.updateMany.mockResolvedValue({ count: 0 });
      prismaMock.candidate.findMany.mockResolvedValue([
        { id: 'cand1', hubspot_id: 'hub1' },
      ]);

      jest
        .spyOn(service['hubspot'], 'updateManyCandidatesFromHireRequest')
        .mockResolvedValue(true);

      const result = await service.confirmPanel(
        { ...panelData, candidates_id: [] },
        user,
      );

      expect(result).toBe(true);
      expect(prismaMock.panelCandidate.createMany).not.toHaveBeenCalled();
      expect(
        service['hubspot'].updateManyCandidatesFromHireRequest,
      ).toHaveBeenCalled();
    });

    it('should throw BadRequestException if addCandidates fails', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.panelCandidate.createMany.mockResolvedValue(null);

      await expect(service.confirmPanel(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if panelUpdated fails', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.panelCandidate.createMany.mockResolvedValue({ count: 5 });
      prismaMock.hireRequest.update.mockResolvedValue(null);

      await expect(service.confirmPanel(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if candidates update fails', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.panelCandidate.createMany.mockResolvedValue({ count: 5 });
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'sourcing',
      });
      prismaMock.candidate.findMany.mockResolvedValue([
        { id: 'cand1', hubspot_id: 'hub1', pipeline_status: 'available' },
      ]);
      prismaMock.candidate.updateMany.mockResolvedValue(null);

      await expect(service.confirmPanel(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if candidates not found', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.panelCandidate.createMany.mockResolvedValue({ count: 5 });
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'sourcing',
      });
      prismaMock.candidate.findMany.mockResolvedValue(null);

      await expect(service.confirmPanel(panelData, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should confirm panel, update candidates and call HubSpot', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.panelCandidate.createMany.mockResolvedValue({ count: 5 });
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'sourcing',
      });
      prismaMock.candidate.updateMany.mockResolvedValue({ count: 5 });
      prismaMock.candidate.findMany.mockResolvedValue([
        { id: 'cand1', hubspot_id: 'hub1', pipeline_status: 'available' },
        { id: 'cand2', hubspot_id: 'hub2', pipeline_status: 'available' },
      ]);

      jest
        .spyOn(service['hubspot'], 'updateManyCandidatesFromHireRequest')
        .mockResolvedValue(true);

      const result = await service.confirmPanel(panelData, user);
      expect(result).toBe(true);

      expect(prismaMock.panelCandidate.createMany).toHaveBeenCalled();
      expect(prismaMock.hireRequest.update).toHaveBeenCalled();
      expect(prismaMock.candidate.updateMany).toHaveBeenCalled();
      expect(
        service['hubspot'].updateManyCandidatesFromHireRequest,
      ).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'cand1' }),
          expect.objectContaining({ id: 'cand2' }),
        ]),
        expect.any(String),
        expect.anything(),
        expect.anything(),
        expect.any(String),
      );
      expect(candidateAuditServiceMock.logMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            candidateId: 'cand1',
            event: 'pipeline_status_changed',
            before: { pipeline_status: 'available' },
          }),
          expect.objectContaining({
            candidateId: 'cand2',
            event: 'pipeline_status_changed',
            before: { pipeline_status: 'available' },
          }),
        ]),
      );
    });

    it('should throw BadRequestException if any candidate has "Hired" status', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate: {
              id: 'cand-hired',
              pipeline_status: '261214844',
              panelCandidates: [],
            },
          },
        ],
      });

      await expect(service.confirmPanel(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('editPanel', () => {
    const panelData = {
      hireRequest_id: 'hr1',
      candidates_id: ['cand1', 'cand2', 'cand3', 'cand4', 'cand5'],
    };

    const panelExistsMock = { id: 'panel1', panelCandidates: [] };
    const currentCandidatesMock = panelData.candidates_id.map((id) => ({
      candidate_id: id,
      candidate: {
        id,
        hubspot_id: `hub${id.slice(-1)}`,
        pipeline_status_origin: '261075105',
        pipeline_status: '261075105',
      },
    }));

    beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.$transaction.mockImplementation(async (cb) => cb(prismaMock));
    });

    const mockPanelFound = () =>
      prismaMock.candidatePanel.findFirst.mockResolvedValue(panelExistsMock);

    const mockCurrentCandidates = () =>
      prismaMock.panelCandidate.findMany.mockResolvedValue(
        currentCandidatesMock,
      );

    const mockAddAndUpdateCandidates = () => {
      prismaMock.panelCandidate.deleteMany.mockResolvedValue({ count: 5 });
      prismaMock.panelCandidate.createMany.mockResolvedValue({ count: 5 });
      prismaMock.candidate.update.mockResolvedValue({});
      prismaMock.candidate.findMany.mockResolvedValue(
        currentCandidatesMock.map((c) => ({
          id: c.candidate_id,
          hubspot_id: c.candidate.hubspot_id,
          pipeline_status: c.candidate.pipeline_status,
        })),
      );
    };

    it('should throw NotFoundException if user is invalid', async () => {
      await expect(service.editPanel(panelData, null as any)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if data is missing', async () => {
      await expect(service.editPanel(null as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should not throw if pipeline status mapping is missing', async () => {
      mockPanelFound();
      prismaMock.panelCandidate.findMany.mockResolvedValue(
        currentCandidatesMock,
      );

      const originalDict = { ...service['dbToStageDictionary'] };
      service['dbToStageDictionary'] = {};

      jest
        .spyOn(service['hubspot'], 'updateManyCandidatesFromHireRequest')
        .mockResolvedValue(true);

      const result = await service.editPanel(panelData, user);

      expect(result).toHaveProperty('id', 'hr1');

      service['dbToStageDictionary'] = originalDict;
    });

    it('should edit panel successfully and sync with HubSpot', async () => {
      mockPanelFound();
      mockCurrentCandidates();
      mockAddAndUpdateCandidates();

      const expectedHireRequest = {
        id: panelData.hireRequest_id,
        name: 'Test Request',
      };
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(expectedHireRequest as any);

      const result = await service.editPanel(panelData, user);
      expect(result).toBe(expectedHireRequest);

      expect(prismaMock.candidatePanel.findFirst).toHaveBeenCalledWith({
        where: { hire_request_id: panelData.hireRequest_id },
        select: {
          id: true,
          panelCandidates: {
            select: {
              candidate: {
                select: {
                  id: true,
                  pipeline_status: true,
                  panelCandidates: { select: { status: true } },
                },
              },
            },
          },
        },
      });
    });

    it('should throw BadRequestException if a hired candidate would remain on the panel', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          // cand1 is part of panelData.candidates_id, so it remains on the panel.
          {
            candidate: {
              id: 'cand1',
              pipeline_status: '261214844',
              panelCandidates: [],
            },
          },
        ],
      });

      await expect(service.editPanel(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should allow removing a hired candidate from the panel', async () => {
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          // cand-hired is NOT part of panelData.candidates_id, so it's being removed.
          {
            candidate: {
              id: 'cand-hired',
              pipeline_status: '261214844',
              panelCandidates: [],
            },
          },
        ],
      });
      mockCurrentCandidates();
      mockAddAndUpdateCandidates();

      const expectedHireRequest = {
        id: panelData.hireRequest_id,
        name: 'Test Request',
      };
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(expectedHireRequest as any);

      const result = await service.editPanel(panelData, user);
      expect(result).toBe(expectedHireRequest);
    });
  });

  describe.skip('panelReady', () => {
    const panelData = { hireRequest_id: 'hr1', readable: true };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.panelReady(panelData, { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if data is missing', async () => {
      await expect(
        service.panelReady({} as panelReadyDTO, user),
      ).rejects.toThrow(BadRequestException);
      await expect(service.panelReady(null as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if hireRequest update fails', async () => {
      prismaMock.hireRequest.update.mockResolvedValue(null);

      await expect(service.panelReady(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if panel update fails', async () => {
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'panel_ready',
      });
      prismaMock.candidatePanel.updateMany.mockResolvedValue(null);

      await expect(service.panelReady(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if panel does not exist', async () => {
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'panel_ready',
      });
      prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);

      await expect(service.panelReady(panelData, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if panel has less than 3 candidates', async () => {
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'panel_ready',
      });
      prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate_id: 'pc1',
            candidate: { id: 'pc1', pipeline_status: '261075105' },
          },
          {
            candidate_id: 'pc2',
            candidate: { id: 'pc2', pipeline_status: '261075105' },
          },
        ],
      });

      await expect(service.panelReady(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should call findOne and return its result if all validations pass', async () => {
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'panel_ready',
      });
      prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate_id: 'pc1',
            candidate: { id: 'pc1', pipeline_status: '261075105' },
          },
          {
            candidate_id: 'pc2',
            candidate: { id: 'pc2', pipeline_status: '261075105' },
          },
          {
            candidate_id: 'pc3',
            candidate: { id: 'pc3', pipeline_status: '261075105' },
          },
        ],
      });

      const findOneMock = jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(true);

      const result = await service.panelReady(panelData, user);

      expect(result).toBe(true);

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: panelData.hireRequest_id },
        data: { status: 'panel_ready' },
      });
      expect(prismaMock.candidatePanel.updateMany).toHaveBeenCalledWith({
        where: { hire_request_id: panelData.hireRequest_id },
        data: { readable: panelData.readable },
      });
      expect(prismaMock.candidatePanel.findFirst).toHaveBeenCalledWith({
        where: { hire_request_id: panelData.hireRequest_id },
        select: {
          id: true,
          panelCandidates: {
            select: {
              candidate_id: true,
              candidate: { select: { id: true, pipeline_status: true } },
            },
          },
        },
      });
      expect(findOneMock).toHaveBeenCalledWith(panelData.hireRequest_id, user);
    });

    it('should throw BadRequestException if any candidate has "Hired" status', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);
      prismaMock.hireRequest.update.mockResolvedValue({
        id: 'hr1',
        status: 'panel_ready',
      });
      prismaMock.candidatePanel.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate_id: 'cand-hired',
            candidate: { id: 'cand-hired', pipeline_status: '261214844' },
          },
        ],
      });

      await expect(service.panelReady(panelData, user)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getPanel', () => {
    const baseId = 'hr1';
    const basePanel = { id: 'panel1' };
    const baseHireRequest = { id: 'hr1' };
    const basePanelCandidates = [
      {
        id: 'pc1',
        candidate: {
          id: 'cand1',
          first_name: 'John',
          last_name: 'Doe',
          email: 'john@example.com',
          country: 'Brazil',
          skills: [{ skill_name: 'React' }],
          educations: [{ institution: 'Uni', degree: 'CS', year: '2020' }],
          experiences: [
            {
              company: 'Company',
              position: 'Dev',
              responsabilities: 'Coding',
              start_date: new Date('2020-01-01'),
              end_date: new Date('2021-01-01'),
            },
          ],
        },
      },
    ];

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw BadRequestException if id is missing', async () => {
      await expect(service.getPanel(null as any, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if user is missing or has no org', async () => {
      await expect(service.getPanel(baseId, null as any)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.getPanel(baseId, { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hireRequest not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);
      await expect(service.getPanel(baseId, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if panel not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(baseHireRequest);
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);
      await expect(service.getPanel(baseId, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if panelCandidates not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(baseHireRequest);
      prismaMock.candidatePanel.findFirst.mockResolvedValue(basePanel);
      prismaMock.panelCandidate.findMany.mockResolvedValue(null);
      await expect(service.getPanel(baseId, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return panel data with candidates', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(baseHireRequest);
      prismaMock.candidatePanel.findFirst.mockResolvedValue(basePanel);
      prismaMock.panelCandidate.findMany.mockResolvedValue(basePanelCandidates);

      const result = await service.getPanel(baseId, user);

      expect(result).toHaveProperty('hireRequest', { id: baseId });
      expect(result).toHaveProperty('panel', { id: basePanel.id });
      expect(result.panelCandidates).toEqual(basePanelCandidates);

      expect(prismaMock.hireRequest.findUnique).toHaveBeenCalledWith({
        where: {
          id: baseId,
          org_id: user.role.includes('organization')
            ? user.organization_id
            : undefined,
        },
      });
      expect(prismaMock.candidatePanel.findFirst).toHaveBeenCalledWith({
        where: { hire_request_id: baseHireRequest.id },
      });
      expect(prismaMock.panelCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { panel_id: basePanel.id },
          include: expect.any(Object),
        }),
      );
    });
  });

  describe.skip('getPanelsByOrganization', () => {
    const organizationId = 'org1';

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.getPanelsByOrganization({ ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if no panels found', async () => {
      prismaMock.candidatePanel.findMany.mockResolvedValue(null);

      await expect(service.getPanelsByOrganization(user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if panels is empty array', async () => {
      prismaMock.candidatePanel.findMany.mockResolvedValue([]);

      await expect(service.getPanelsByOrganization(user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return panels with candidates and computed years_of_experience', async () => {
      const mockResult = [
        {
          id: 'panel1',
          scheduled_date: new Date(),
          status: 'scheduled',
          panelCandidates: [
            {
              status: 'invited',
              candidate: {
                id: 'cand1',
                first_name: 'John',
                last_name: 'Doe',
                name: 'John Doe',
                hourly_pay_rate: 100,
                country: 'Brazil',
                experiences: [{ start_date: new Date('2015-01-01') }],
                skills: [
                  { skill_name: 'JavaScript', required_level: 'advanced' },
                ],
              },
            },
          ],
          hireRequest: {
            id: 'hr1',
            title: 'Frontend Dev',
            description: 'React project',
            status: 'open',
            priority: 'high',
            createdAt: new Date(),
            availability: 'full-time',
            contract_length: '6 months',
            expected_start_date: new Date(),
            salary_range_from: 1000,
            salary_range_to: 2000,
            specialization: 'Frontend',
            location: 'Remote',
            assign_user_id: 'user123',
            skills: [{ skill_name: 'React', required_level: 'advanced' }],
          },
        },
      ];

      prismaMock.candidatePanel.findMany.mockResolvedValue(mockResult);

      const result = await service.getPanelsByOrganization(user);

      const currentYear = new Date().getFullYear();
      const expectedYears = currentYear - 2015;

      expect(prismaMock.candidatePanel.findMany).toHaveBeenCalledWith({
        where: {
          readable: true,
          hireRequest: {
            organization: { id: organizationId },
          },
        },
        select: {
          id: true,
          scheduled_date: true,
          status: true,
          panelCandidates: {
            select: {
              status: true,
              candidate: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  name: true,
                  hourly_pay_rate: true,
                  country: true,
                  experiences: {
                    orderBy: { start_date: 'asc' },
                    take: 1,
                    select: { start_date: true },
                  },
                },
              },
            },
          },
          hireRequest: {
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              priority: true,
              createdAt: true,
              availability: true,
              contract_length: true,
              expected_start_date: true,
              salary_range_from: true,
              salary_range_to: true,
              specialization: true,
              location: true,
              assign_user_id: true,
              skills: {
                select: {
                  skill_name: true,
                  required_level: true,
                },
              },
            },
          },
        },
      });
    });
  });

  describe('scheduleInterview', () => {
    const baseId = 'hr1';
    const baseData = { date_time: '2025-08-20T10:30:00.000Z' };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.scheduleInterview(baseId, baseData as any, {
          ...user,
          organization_id: null,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hireRequest not found', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(baseId, baseData as any, user),
      ).rejects.toThrow(NotFoundException);

      expect(prismaMock.hireRequest.findUnique).toHaveBeenCalledWith({
        where: {
          id: baseId,
          organization: { id: user.organization_id },
        },
        select: {
          id: true,
          hubspot_ticket_id: true,
          createdBy: { select: { role: true } },
        },
      });
    });

    it('should throw NotFoundException if panel not found', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(baseId, baseData as any, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if interview creation fails', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.interview.create.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if panel update fails', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.interview.create.mockResolvedValue({ id: 'interview1' });
      prismaMock.candidatePanel.update.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if hireRequest update fails', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.interview.create.mockResolvedValue({ id: 'interview1' });
      prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue(null);

      await expect(
        service.scheduleInterview(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should schedule interview and update all statuses successfully', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);

      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.interview.create.mockResolvedValue({ id: 'interview1' });
      prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });

      const findOneMock = jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(true);

      const result = await service.scheduleInterview(
        baseId,
        baseData as any,
        user,
      );

      expect(result).toBe(true);

      const expectedDate = new Date(baseData.date_time);
      expect(prismaMock.interview.create).toHaveBeenCalledWith({
        data: {
          panel_id: 'panel1',
          scheduled_date: expectedDate,
          duration: 30,
        },
      });

      expect(prismaMock.candidatePanel.update).toHaveBeenCalledWith({
        where: { id: 'panel1' },
        data: { status: 'interview_scheduled' },
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: baseId },
        data: { status: 'interview_scheduled' },
      });

      expect(findOneMock).toHaveBeenCalledWith(baseId, user);
    });

    it('should throw BadRequestException if any candidate has "Hired" status', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate: {
              id: 'cand-hired',
              pipeline_status: '261214844',
              panelCandidates: [],
            },
          },
        ],
      });

      await expect(
        service.scheduleInterview(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    describe('24h minimum lead time (client-originated hire requests)', () => {
      const inTwoHours = new Date(
        Date.now() + 2 * 60 * 60 * 1000,
      ).toISOString();
      const in48Hours = new Date(
        Date.now() + 48 * 60 * 60 * 1000,
      ).toISOString();

      beforeEach(() => {
        jest
          .spyOn(service, 'verifyUnavailableCandidates')
          .mockResolvedValue(false);
      });

      it('rejects when the hire request is client-originated and date_time is inside the 24h window', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          id: baseId,
          createdBy: { role: 'organization_admin' },
        });

        await expect(
          service.scheduleInterview(
            baseId,
            { date_time: inTwoHours } as any,
            user,
          ),
        ).rejects.toThrow(
          'Interviews for client-requested hire requests must be scheduled at least 24 hours in advance.',
        );

        expect(prismaMock.interview.create).not.toHaveBeenCalled();
        expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
      });

      it('resolves when the hire request is client-originated and date_time is 48h out', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          id: baseId,
          createdBy: { role: 'organization_admin' },
        });
        prismaMock.candidatePanel.findFirst.mockResolvedValue({
          id: 'panel1',
          panelCandidates: [],
        });
        prismaMock.interview.create.mockResolvedValue({ id: 'interview1' });
        prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
        prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
        jest.spyOn(service, 'findOne').mockResolvedValue(true);

        await expect(
          service.scheduleInterview(
            baseId,
            { date_time: in48Hours } as any,
            user,
          ),
        ).resolves.toBe(true);
      });

      it('resolves when the hire request is admin-originated even if date_time is inside the 24h window', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          id: baseId,
          createdBy: { role: 'system_admin' },
        });
        prismaMock.candidatePanel.findFirst.mockResolvedValue({
          id: 'panel1',
          panelCandidates: [],
        });
        prismaMock.interview.create.mockResolvedValue({ id: 'interview1' });
        prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
        prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
        jest.spyOn(service, 'findOne').mockResolvedValue(true);

        await expect(
          service.scheduleInterview(
            baseId,
            { date_time: inTwoHours } as any,
            user,
          ),
        ).resolves.toBe(true);
      });

      it('resolves permissively when createdBy is null, regardless of date_time', async () => {
        prismaMock.hireRequest.findUnique.mockResolvedValue({
          id: baseId,
          createdBy: null,
        });
        prismaMock.candidatePanel.findFirst.mockResolvedValue({
          id: 'panel1',
          panelCandidates: [],
        });
        prismaMock.interview.create.mockResolvedValue({ id: 'interview1' });
        prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
        prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
        jest.spyOn(service, 'findOne').mockResolvedValue(true);

        await expect(
          service.scheduleInterview(
            baseId,
            { date_time: inTwoHours } as any,
            user,
          ),
        ).resolves.toBe(true);
      });
    });
  });

  describe('editInterview', () => {
    const baseId = 'hr1';
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const in48Hours = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('rejects when the hire request is client-originated and date_time is inside the 24h window', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        createdBy: { role: 'organization_admin' },
      });

      await expect(
        service.editInterview(baseId, { date_time: inTwoHours } as any, user),
      ).rejects.toThrow(
        'Interviews for client-requested hire requests must be scheduled at least 24 hours in advance.',
      );

      expect(prismaMock.interview.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
    });

    it('resolves when the hire request is client-originated and date_time is 48h out', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        createdBy: { role: 'organization_admin' },
      });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
      prismaMock.interview.updateMany.mockResolvedValue({ count: 1 });
      jest.spyOn(service, 'findOne').mockResolvedValue(true);

      await expect(
        service.editInterview(baseId, { date_time: in48Hours } as any, user),
      ).resolves.toBe(true);
    });

    it('resolves when the hire request is admin-originated even if date_time is inside the 24h window', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        createdBy: { role: 'system_admin' },
      });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
      prismaMock.interview.updateMany.mockResolvedValue({ count: 1 });
      jest.spyOn(service, 'findOne').mockResolvedValue(true);

      await expect(
        service.editInterview(baseId, { date_time: inTwoHours } as any, user),
      ).resolves.toBe(true);
    });

    it('resolves permissively when createdBy is null, regardless of date_time', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        createdBy: null,
      });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
      prismaMock.interview.updateMany.mockResolvedValue({ count: 1 });
      jest.spyOn(service, 'findOne').mockResolvedValue(true);

      await expect(
        service.editInterview(baseId, { date_time: inTwoHours } as any, user),
      ).resolves.toBe(true);
    });

    it('measures the 24h gap from now, not from the interview previously scheduled far in the future', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        createdBy: { role: 'organization_admin' },
      });
      const threeHoursOut = new Date(
        Date.now() + 3 * 60 * 60 * 1000,
      ).toISOString();

      await expect(
        service.editInterview(
          baseId,
          { date_time: threeHoursOut } as any,
          user,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prismaMock.interview.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('awaitingDecision', () => {
    const baseId = 'hr1';
    const baseData = { date_time: '2025-08-21T14:00:00.000Z' };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.awaitingDecision(baseId, baseData as any, {
          ...user,
          organization_id: null,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hireRequest is not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.awaitingDecision(baseId, baseData as any, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if no panel exists for hire request', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);

      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);

      await expect(
        service.awaitingDecision(baseId, baseData as any, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if any candidate in the panel has "Hired" status', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);

      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate: {
              id: 'cand-hired',
              hubspot_id: 'hub-hired',
              pipeline_status: '261214844',
              pipeline_status_origin: 'origin1',
              panelCandidates: [],
            },
          },
          {
            candidate: {
              id: 'cand2',
              hubspot_id: 'hub2',
              pipeline_status: '261075105',
              pipeline_status_origin: 'origin2',
              panelCandidates: [],
            },
          },
        ],
      });

      await expect(
        service.awaitingDecision(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if panel update fails', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [],
      });
      prismaMock.candidatePanel.update.mockResolvedValue(null);

      await expect(
        service.awaitingDecision(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if hireRequest update fails', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate: {
              id: 'cand1',
              hubspot_id: 'hub1',
              pipeline_status: 'status1',
              pipeline_status_origin: 'origin1',
              panelCandidates: [],
            },
          },
        ],
      });

      prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue(null);

      await expect(
        service.awaitingDecision(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update panel and hireRequest and return result of findOne', async () => {
      jest
        .spyOn(service, 'verifyUnavailableCandidates')
        .mockResolvedValue(false);

      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate: {
              id: 'cand1',
              hubspot_id: 'hub1',
              pipeline_status: 'status1',
              pipeline_status_origin: 'origin1',
              panelCandidates: [],
            },
          },
        ],
      });
      prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });

      const findOneMock = jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(true);

      const result = await service.awaitingDecision(
        baseId,
        baseData as any,
        user,
      );

      expect(result).toBe(true);

      const expectedDate = new Date(baseData.date_time);
      expect(prismaMock.candidatePanel.update).toHaveBeenCalledWith({
        where: { id: 'panel1' },
        data: { status: 'decision_pending', scheduled_date: expectedDate },
      });

      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
        where: { id: baseId },
        data: { status: 'awaiting_decision' },
      });

      expect(findOneMock).toHaveBeenCalledWith(baseId, user);
    });
  });

  describe('allowMoreTime', () => {
    const baseId = 'hr1';
    const baseData = { date_time: '2025-08-25T16:00:00.000Z' };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.allowMoreTime(baseId, baseData as any, {
          ...user,
          organization_id: null,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hireRequest not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.allowMoreTime(baseId, baseData as any, user),
      ).rejects.toThrow(NotFoundException);

      expect(prismaMock.hireRequest.findUnique).toHaveBeenCalledWith({
        where: {
          id: baseId,
          organization: { id: user.organization_id },
        },
        select: { id: true },
      });
    });

    it('should throw NotFoundException if panel does not exist', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);

      await expect(
        service.allowMoreTime(baseId, baseData as any, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if panel update fails', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      prismaMock.candidatePanel.update.mockResolvedValue(null);

      await expect(
        service.allowMoreTime(baseId, baseData as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should update panel scheduled_date and return result of findOne', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({ id: baseId });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });

      const findOneMock = jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(true);

      const result = await service.allowMoreTime(baseId, baseData as any, user);

      expect(result).toBe(true);

      const expectedDate = new Date(baseData.date_time);
      expect(prismaMock.candidatePanel.update).toHaveBeenCalledWith({
        where: { id: 'panel1' },
        data: { scheduled_date: expectedDate },
      });

      expect(findOneMock).toHaveBeenCalledWith(baseId, user);
    });
  });

  describe('changeWinner', () => {
    const baseId = 'hr1';
    const data = { winner_id: ['cand1'] };

    const panelWithNoCrossHired = {
      id: 'panel1',
      panelCandidates: [
        {
          candidate: {
            id: 'cand1',
            pipeline_status: null,
            panelCandidates: [], // no selected_by_client on OTHER panels
          },
        },
      ],
    };

    it('should throw NotFoundException if user has no organization', async () => {
      await expect(
        service.changeWinner(baseId, data, { ...user, organization_id: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if hireRequest not found', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue(null);
      await expect(service.changeWinner(baseId, data, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if panel does not exist', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        hubspot_ticket_id: 'hs1',
      });
      prismaMock.candidatePanel.findFirst.mockResolvedValue(null);
      await expect(service.changeWinner(baseId, data, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if candidate is selected_by_client on another panel', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        hubspot_ticket_id: 'hs1',
      });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      prismaMock.candidatePanel.findUnique.mockResolvedValue({
        id: 'panel1',
        panelCandidates: [
          {
            candidate: {
              id: 'cand1',
              pipeline_status: null,
              panelCandidates: [{ status: 'selected_by_client' }], // hired on another panel
            },
          },
        ],
      });
      await expect(service.changeWinner(baseId, data, user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should complete successfully and allow changing winner on current panel', async () => {
      prismaMock.hireRequest.findUnique.mockResolvedValue({
        id: baseId,
        hubspot_ticket_id: 'hs1',
      });
      prismaMock.candidatePanel.findFirst.mockResolvedValue({ id: 'panel1' });
      // panelCandidates filtered to other panels only — current winner has no cross-panel selected_by_client
      prismaMock.candidatePanel.findUnique.mockResolvedValue(
        panelWithNoCrossHired,
      );
      prismaMock.panelCandidate.findMany
        .mockResolvedValueOnce([
          {
            id: 'pc1',
            candidate_id: 'cand1',
            candidate: { hubspot_id: 'hub1', pipeline_status: null },
          },
        ]) // winners
        .mockResolvedValueOnce([
          {
            id: 'pc2',
            candidate: {
              id: 'cand2',
              hubspot_id: 'hub2',
              pipeline_status_origin: null,
              panelCandidates: [],
            },
          },
        ]); // losers
      prismaMock.candidatePanel.update.mockResolvedValue({ id: 'panel1' });
      prismaMock.hireRequest.update.mockResolvedValue({ id: baseId });
      prismaMock.panelCandidate.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prismaMock.candidate.update.mockResolvedValue({});
      prismaMock.candidatePanel.findMany.mockResolvedValue([
        {
          id: 'panel1',
          scheduled_date: new Date(),
          status: 'decision_made',
          panelCandidates: [
            {
              status: 'selected_by_client',
              candidate: {
                id: 'cand1',
                experiences: [{ start_date: '2020-01-01' }],
                avatar_url: null,
              },
            },
          ],
          hireRequest: {
            id: baseId,
            title: 'Dev',
            description: 'Job',
            status: 'placement_completed',
            skills: [],
          },
        },
      ]);

      jest
        .spyOn(service['hubspot'], 'updateOneCandidateFromHireRequest')
        .mockResolvedValue(true as any);
      jest
        .spyOn(service['hubspot'], 'updateHireRequestInHubspot')
        .mockResolvedValue(true as any);
      jest
        .spyOn(service['notifications'], 'notifyHireRequestPlacementCompleted')
        .mockResolvedValue(undefined as any);

      const result = await service.changeWinner(baseId, data, user);

      expect(result).toHaveLength(1);
      expect(prismaMock.panelCandidate.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.candidatePanel.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'decision_made' }),
        }),
      );
      expect(prismaMock.hireRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'placement_completed' }),
        }),
      );
      expect(
        offerPanelsServiceMock.removeCandidateFromAllPanels,
      ).toHaveBeenCalledWith('cand1');
      expect(candidateAuditServiceMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: 'cand1',
          event: 'pipeline_status_changed',
          before: { pipeline_status: null },
        }),
      );
      expect(candidateAuditServiceMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: 'cand2',
          event: 'pipeline_status_changed',
        }),
      );
    });
  });

  describe('showMatchHireRequests', () => {
    it('should throw NotFoundException if candidate does not exist', async () => {
      prismaMock.candidate.findUnique.mockResolvedValue(null);

      await expect(service.showMatchHireRequests('cand1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return empty array if no hire requests match (all panels full)', async () => {
      prismaMock.candidate.findUnique.mockResolvedValue({
        id: 'cand1',
        specialization: 'IT',
        country: 'USA',
        employment_type: 'Full-time',
        hourly_pay_rate: { toNumber: () => 50 },
        skills: [{ skill_name: 'Node.js' }],
      });

      prismaMock.hireRequest.findMany.mockResolvedValue([
        {
          id: 'hr1',
          specialization: 'IT',
          location: 'USA',
          availability: 'Full-time',
          salary_range_from: '1000',
          salary_range_to: '5000',
          skills: [{ skill_name: 'Node.js' }],
          panels: [{ panelCandidates: [{}, {}, {}, {}, {}] }],
        },
      ]);

      const result = await service.showMatchHireRequests('cand1');
      expect(result).toEqual([]);
    });

    it('should calculate score correctly and sort results', async () => {
      prismaMock.candidate.findUnique.mockResolvedValue({
        id: 'cand1',
        specialization: 'IT',
        country: 'USA',
        employment_type: 'Full-time',
        hourly_pay_rate: { toNumber: () => 50 },
        skills: [{ skill_name: 'Node.js' }, { skill_name: 'React' }],
      });

      prismaMock.hireRequest.findMany.mockResolvedValue([
        {
          id: 'hr1',
          specialization: 'IT',
          location: 'USA',
          availability: 'Full-time',
          salary_range_from: '2000',
          salary_range_to: '5000',
          skills: [{ skill_name: 'Node.js' }, { skill_name: 'Angular' }],
          panels: [{ panelCandidates: [] }],
        },
        {
          id: 'hr2',
          specialization: 'HR',
          location: 'Brazil',
          availability: 'Part-time',
          salary_range_from: '100',
          salary_range_to: '200',
          skills: [{ skill_name: 'Excel' }],
          panels: [{ panelCandidates: [] }],
        },
      ]);

      const result = await service.showMatchHireRequests('cand1');

      // hr1 deve ter score > hr2
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('hr1');
      expect(result[0].score).toBeGreaterThan(result[1].score);
      expect(result[0].matchedSkills).toContain('Node.js');
    });
  });

  describe('getOpenedHireRequests — soft-deleted cancellation tickets', () => {
    // The `deleted_at: null` must sit INSIDE the `none` predicate. Placed anywhere else, a
    // soft-deleted cancellation ticket keeps the hire request hidden permanently. Asserting
    // the exact nested shape (not objectContaining) is deliberate here.
    const expectedNone = {
      none: {
        type: 'hire_request_cancellation',
        status: { not: 'resolved' },
        deleted_at: null,
      },
    };

    beforeEach(() => {
      jest.clearAllMocks();
      prismaMock.hireRequest.findMany.mockResolvedValue([]);
    });

    it('should ignore deleted cancellation tickets for organization admins', async () => {
      await service.getOpenedHireRequests({
        id: 'user1',
        organization_id: 'org1',
        role: 'organization_admin',
      } as USER);

      const where = prismaMock.hireRequest.findMany.mock.calls[0][0].where;
      expect(where.tickets).toEqual(expectedNone);
    });

    it('should ignore deleted cancellation tickets for system admins', async () => {
      await service.getOpenedHireRequests({
        id: 'admin1',
        organization_id: null,
        role: 'system_admin',
      } as unknown as USER);

      const where = prismaMock.hireRequest.findMany.mock.calls[0][0].where;
      expect(where.tickets).toEqual(expectedNone);
    });
  });
});
