import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { HandlerOrganization } from './handlers/organization';
import { HandlerClient } from './handlers/client';
import { HandlerAffiliate } from './handlers/affiliate';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

describe('DashboardService', () => {
  let service: DashboardService;
  let handlerOrganization: HandlerOrganization;
  let handlerClient: HandlerClient;

  const mockHandlerOrganization = {
    execute: jest.fn(),
  };

  const mockHandlerClient = {
    execute: jest.fn(),
  };

  const mockHandlerAffiliate = {
    execute: jest.fn(),
  };

  const prismaMock = {
    interview: {
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: HandlerOrganization, useValue: mockHandlerOrganization },
        { provide: HandlerClient, useValue: mockHandlerClient },
        { provide: HandlerAffiliate, useValue: mockHandlerAffiliate },
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    handlerOrganization = module.get<HandlerOrganization>(HandlerOrganization);
    handlerClient = module.get<HandlerClient>(HandlerClient);

    jest.clearAllMocks();
  });

  it('should call organization.execute for organization_super_admin', async () => {
    const user = { role: 'organization_super_admin' } as any;
    mockHandlerOrganization.execute.mockResolvedValue('org data');

    const result = await service.getDashboardData(user);

    expect(handlerOrganization.execute).toHaveBeenCalledWith(user, 1, 10);
    expect(handlerOrganization.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe('org data');
  });

  it('should call organization.execute for organization_admin', async () => {
    const user = { role: 'organization_admin' } as any;
    mockHandlerOrganization.execute.mockResolvedValue('org admin data');

    const result = await service.getDashboardData(user);

    expect(handlerOrganization.execute).toHaveBeenCalledWith(user, 1, 10);
    expect(result).toBe('org admin data');
  });

  it('should call client.execute for system_super_admin', async () => {
    const user = { role: 'system_super_admin' } as any;
    mockHandlerClient.execute.mockResolvedValue('client data');

    const result = await service.getDashboardData(user);

    expect(handlerClient.execute).toHaveBeenCalledWith(user, 1, 10);
    expect(result).toBe('client data');
  });

  it('should call client.execute for system_admin', async () => {
    const user = { role: 'system_admin' } as any;
    mockHandlerClient.execute.mockResolvedValue('client admin data');

    const result = await service.getDashboardData(user);

    expect(handlerClient.execute).toHaveBeenCalledWith(user, 1, 10);
    expect(result).toBe('client admin data');
  });

  it('should set exception when the userrole is invalid', async () => {
    const user = { role: 'invalid_role' } as any;

    await expect(service.getDashboardData(user)).rejects.toThrow(
      BadRequestException,
    );
  });

  describe('closeAlert', () => {
    it('should throw BadRequestException if interviewId is falsy', async () => {
      await expect(service.closeAlert('')).rejects.toThrow(BadRequestException);
      expect(prismaMock.interview.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if interview update returns null', async () => {
      prismaMock.interview.update.mockResolvedValueOnce(null);
      await expect(service.closeAlert('interview-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should close alert and return updated interview', async () => {
      const mockInterview = { id: 'interview-1', alert_closed: true };
      prismaMock.interview.update.mockResolvedValueOnce(mockInterview);

      const result = await service.closeAlert('interview-1');

      expect(result).toEqual(mockInterview);
      expect(prismaMock.interview.update).toHaveBeenCalledWith({
        where: { id: 'interview-1' },
        data: { alert_closed: true },
      });
    });
  });
});
