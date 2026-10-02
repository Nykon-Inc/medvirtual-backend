import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { PositionRateConfigService } from '../position-rate-config/position-rate-config.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prismaService: PrismaService;
  let mailService: MailService;

  const mockPrismaService = {
    hireRequest: {
      findUnique: jest.fn(),
    },
    ticket: {
      findFirst: jest.fn(),
    },
    uSER: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    organization: {
      findMany: jest.fn(),
    },
    candidate: {
      findMany: jest.fn().mockResolvedValue([]),
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
    prismaService = module.get<PrismaService>(PrismaService);
    mailService = module.get<MailService>(MailService);

    // Set up environment variables for tests
    process.env.FRONTEND_URL = 'https://test.example.com';
    process.env.RESEND_API_KEY = 'test-api-key';
    // Ensure non-production by default so [DEV] prefix is applied
    delete process.env.ENVIRONMENT;

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  describe('buildEmail', () => {
    it('should build email with proper HTML structure', () => {
      const htmlInner = '<h1>Test Content</h1>';
      const result = (service as any).buildEmail(htmlInner);

      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<html lang="en">');
      expect(result).toContain('<div class="email-wrapper">');
      expect(result).toContain('<div class="container">');
      expect(result).toContain(htmlInner);
      expect(result).toContain('</body>');
      expect(result).toContain('</html>');
    });
  });

  describe('notifyHireRequestPlacementCompleted', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior Developer',
      description: 'Looking for a senior developer',
      status: 'placement_completed',
      priority: 'high',
      specialization: 'Frontend',
      salary_range_from: 5000,
      salary_range_to: 8000,
      expected_start_date: new Date('2024-02-01'),
      assign_user_id: 'user1',
      assigned_sourcing: {
        id: 'user2',
        email: 'sourcing@example.com',
        first_name: 'Jane',
        last_name: 'Smith',
      },
      createdBy: {
        id: 'user3',
        email: 'creator@example.com',
        first_name: 'Bob',
        last_name: 'Johnson',
      },
      organization: {
        name: 'Test Company',
        business_unit: 'Berry Virtual',
      },
      panels: [
        {
          id: 'panel1',
          panelCandidates: [
            {
              candidate: {
                id: 'candidate1',
                first_name: 'Jane',
                last_name: 'Smith',
                name: 'Jane Smith',
              },
            },
          ],
        },
      ],
    };

    it('should send notification email successfully', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestPlacementCompleted('hr1');

      expect(result).toBe(true);
      expect(mockPrismaService.hireRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'hr1' },
        select: expect.any(Object),
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.any(String),
          to: expect.arrayContaining([
            'assignee@example.com',
            'sourcing@example.com',
            'creator@example.com',
          ]),
          subject: 'Placement completed: Senior Developer',
          html: expect.stringContaining('placement completed'),
        }),
      );
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Selected Candidates:/),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestPlacementCompleted('hr1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle missing winner candidate gracefully', async () => {
      const mockHireRequestWithoutWinner = {
        ...mockHireRequest,
        panels: [
          {
            id: 'panel1',
            panelCandidates: [],
          },
        ],
      };

      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequestWithoutWinner,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestPlacementCompleted('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Selected Candidates:/),
        }),
      );
    });

    it('should throw BadRequestException when no assignee email', async () => {
      const hireRequestWithoutEmail = {
        ...mockHireRequest,
        assign_user_id: 'user1',
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hireRequestWithoutEmail,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(
        service.notifyHireRequestPlacementCompleted('hr1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle missing salary range and start date', async () => {
      const hireRequestMinimal = {
        ...mockHireRequest,
        salary_range_from: null,
        salary_range_to: null,
        expected_start_date: null,
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hireRequestMinimal,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestPlacementCompleted('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Not specified'),
        }),
      );
    });
  });

  describe('notifyHireRequestClientChange', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior Developer',
      description: 'Looking for a senior developer',
      priority: 'high',
      specialization: 'Frontend',
      organization: { name: 'Test Company' },
    };

    it('should send notification for edited hire request', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestClientChange(
        'hr1',
        'edited',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: expect.arrayContaining(['assignee@example.com']),
          subject: 'Hire Request edited: Senior Developer',
          html: expect.stringContaining('Hire Request EDITED'),
        }),
      );
    });

    it('should send notification for canceled hire request', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestClientChange(
        'hr1',
        'canceled',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: expect.arrayContaining(['assignee@example.com']),
          subject: 'Hire Request canceled: Senior Developer',
          html: expect.stringContaining('Hire Request CANCELED'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestClientChange('hr1', 'edited'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when no assignee email', async () => {
      const hireRequestWithoutEmail = {
        ...mockHireRequest,
        assign_user_id: 'user1',
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hireRequestWithoutEmail,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(
        service.notifyHireRequestClientChange('hr1', 'edited'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('notifyHireRequestCreated', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior Developer',
      description: 'Looking for a senior developer',
      status: 'new',
      priority: 'high',
      specialization: 'Frontend',
      salary_range_from: 5000,
      salary_range_to: 8000,
      expected_start_date: new Date('2024-02-01'),
      availability: 'full-time',
      contract_length: '6 months',
      assign_user_id: 'user1',
      organization: { name: 'Test Company' },
    };

    it('should send notification email successfully', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestCreated('hr1');

      expect(result).toBe(true);
      expect(mockPrismaService.hireRequest.findUnique).toHaveBeenCalledWith({
        where: { id: 'hr1' },
        select: expect.any(Object),
      });
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: expect.arrayContaining(['assignee@example.com']),
          subject: 'Hire Request Assigned: Senior Developer',
          html: expect.stringContaining('Hire Request'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.notifyHireRequestCreated('hr1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when no assignee email', async () => {
      const hireRequestWithoutEmail = {
        ...mockHireRequest,
        assign_user_id: 'user1',
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hireRequestWithoutEmail,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(service.notifyHireRequestCreated('hr1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle missing optional fields', async () => {
      const hireRequestMinimal = {
        ...mockHireRequest,
        description: null,
        contract_length: null,
        salary_range_from: null,
        salary_range_to: null,
        expected_start_date: null,
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hireRequestMinimal,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestCreated('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('No description provided'),
        }),
      );
    });
  });

  describe('notifyHireRequestPlacementCompleted - from email by business unit', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior Developer',
      description: 'Looking for a senior developer',
      status: 'placement_completed',
      priority: 'high',
      specialization: 'Frontend',
      salary_range_from: 5000,
      salary_range_to: 8000,
      expected_start_date: new Date('2024-02-01'),
      assigned_user: {
        id: 'user1',
        email: 'assignee@example.com',
        first_name: 'John',
        last_name: 'Doe',
      },
      assigned_sourcing: {
        id: 'user2',
        email: 'sourcing@example.com',
        first_name: 'Jane',
        last_name: 'Smith',
      },
      createdBy: {
        id: 'user3',
        email: 'creator@example.com',
        first_name: 'Bob',
        last_name: 'Johnson',
      },
      organization: {
        name: 'Test Company',
        business_unit: 'Berry Virtual',
      },
      panels: [
        {
          id: 'panel1',
          panelCandidates: [
            {
              candidate: {
                id: 'candidate1',
                first_name: 'Jane',
                last_name: 'Smith',
                name: 'Jane Smith',
                specialization: 'Frontend',
                country: 'USA',
              },
            },
          ],
        },
      ],
    };

    it('should use Berry Virtual when organization is Berry Virtual', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'assignee@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestPlacementCompleted('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Berry Virtual <noreply@medvirtual.ai>',
        }),
      );
    });

    it('should use MedVirtual when organization is MedVirtual', async () => {
      const medVirtualHireRequest = {
        ...mockHireRequest,
        organization: {
          name: 'Test Company',
          business_unit: 'MedVirtual',
        },
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        medVirtualHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        { email: 'assignee@example.com', role: 'organization_admin' },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestPlacementCompleted('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'MedVirtual <noreply@medvirtual.ai>',
        }),
      );
    });
  });

  describe('notifyHireRequestSelectWinner - from email by business unit', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior Developer',
      description: 'Looking for a senior developer',
      status: 'placement_completed',
      priority: 'high',
      specialization: 'Frontend',
      salary_range_from: 5000,
      salary_range_to: 8000,
      expected_start_date: new Date('2024-02-01'),
      organization: {
        id: 'org1',
        name: 'Test Company',
        business_unit: 'Berry Virtual',
        admin: {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
        },
        owner: {
          id: 'owner1',
          email: 'owner@example.com',
          first_name: 'Owner',
          last_name: 'User',
        },
      },
      panels: [
        {
          id: 'panel1',
          panelCandidates: [
            {
              candidate: {
                id: 'candidate1',
                first_name: 'Jane',
                last_name: 'Smith',
                name: 'Jane Smith',
              },
            },
          ],
        },
      ],
    };

    it('should use Berry Virtual when organization is Berry Virtual', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
        {
          id: 'owner1',
          email: 'owner@example.com',
          first_name: 'Owner',
          last_name: 'User',
          role: 'organization_admin',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestSelectWinner('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Berry Virtual <noreply@medvirtual.ai>',
        }),
      );
    });

    it('should use MedVirtual when organization is MedVirtual', async () => {
      const medVirtualHireRequest = {
        ...mockHireRequest,
        organization: {
          ...mockHireRequest.organization,
          business_unit: 'MedVirtual',
        },
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        medVirtualHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestSelectWinner('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'MedVirtual <noreply@medvirtual.ai>',
        }),
      );
    });
  });

  describe('notifyHireRequestAwaitingDecision - from email by business unit', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior Developer',
      status: 'awaiting_decision',
      panels: [
        {
          id: 'panel1',
          status: 'decision_pending',
          scheduled_date: new Date('2024-02-01'),
        },
      ],
      organization: {
        id: 'org1',
        name: 'Test Company',
        business_unit: 'Berry Virtual',
      },
    };

    it('should use Berry Virtual when organization is Berry Virtual', async () => {
      const organizationAdmins = [
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ];
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue(organizationAdmins);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestAwaitingDecision('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Berry Virtual <noreply@medvirtual.ai>',
        }),
      );
    });

    it('should use MedVirtual when organization is MedVirtual', async () => {
      const medVirtualHireRequest = {
        ...mockHireRequest,
        organization: {
          ...mockHireRequest.organization,
          business_unit: 'MedVirtual',
        },
      };
      const organizationAdmins = [
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ];
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        medVirtualHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue(organizationAdmins);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestAwaitingDecision('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'MedVirtual <noreply@medvirtual.ai>',
        }),
      );
    });
  });

  describe('notifyTicketEvent', () => {
    const mockTicket = {
      id: 'ticket1',
      title: 'Bug Report',
      description: 'Application crashes on login',
      status: 'new',
      priority: 'high',
      type: 'bug',
      createdAt: new Date('2024-01-15'),
      created_by: 'creator1',
      user: {
        id: 'assignee1',
        email: 'assignee@example.com',
        role: 'system_admin',
      },
      organization: { name: 'Test Company' },
      staff: null,
      candidate: null,
    };

    it('should send notification for created ticket', async () => {
      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(mockTicket, 'created');

      expect(result).toBe(true);
      // For system admins, subject format is different (e.g., "bug Ticket Created for Test Company")
      expect(mockMailService.sendMail).toHaveBeenCalledTimes(2); // Once for creator, once for assignee
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: expect.arrayContaining([expect.any(String)]),
          subject: expect.stringMatching(/Ticket Created|Bug Report/),
          html: expect.stringContaining('Bug Report'),
        }),
      );
    });

    it('should not send notification when creator and assignee are the same', async () => {
      const ticketSameUser = {
        ...mockTicket,
        created_by: 'assignee1',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'system_admin',
        },
      };
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        created_by: 'assignee1',
        user_id: 'assignee1',
      });

      const result = await service.notifyTicketEvent(ticketSameUser, 'created');

      expect(result).toBe(false);
      expect(mockMailService.sendMail).not.toHaveBeenCalled();
    });

    it('should send notification for assigned ticket', async () => {
      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(mockTicket, 'assigned');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: expect.arrayContaining([expect.any(String)]),
          subject: expect.stringContaining('Bug Report'),
          html: expect.stringContaining(
            'The ticket was <strong>assigned</strong>',
          ),
        }),
      );
    });

    it('should send notification for closed ticket', async () => {
      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(mockTicket, 'closed');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: expect.arrayContaining([expect.any(String)]),
          subject: expect.stringContaining('Bug Report'),
          html: expect.stringContaining(
            'The ticket was <strong>closed</strong>',
          ),
        }),
      );
    });

    it('should throw NotFoundException when ticket not found', async () => {
      await expect(service.notifyTicketEvent(null, 'created')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when no assignee email and no creator', async () => {
      const ticketWithoutEmail = {
        ...mockTicket,
        user: { email: null },
        created_by: null,
      };

      // Mock the ticket.findFirst call that happens when created_by is null but ticket.id exists
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        created_by: null,
        user_id: null,
      });
      // Mock uSER.findUnique to return null (no creator email found)
      mockPrismaService.uSER.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyTicketEvent(ticketWithoutEmail, 'created'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not throw when user is null but creator exists', async () => {
      const ticketWithoutUser = {
        ...mockTicket,
        user: null,
        created_by: 'creator1',
      };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(
        ticketWithoutUser,
        'created',
      );
      expect(result).toBe(true);
    });

    it('should include staff member details when present', async () => {
      const ticketWithStaff = {
        ...mockTicket,
        created_by: 'creator1',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'system_admin',
        },
        staff: {
          id: 'staff1',
          candidate: {
            id: 'candidate1',
            name: 'John Doe',
            email: 'john.doe@example.com',
          },
        },
      };
      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(ticketWithStaff, 'created');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Staff Member:.*John Doe/),
        }),
      );
      // Staff email is no longer included in the email
      expect(mockMailService.sendMail).not.toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Staff Email:/),
        }),
      );
    });

    it('should include candidate details when present', async () => {
      const ticketWithCandidate = {
        ...mockTicket,
        created_by: 'creator1',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'system_admin',
        },
        candidate: {
          id: 'candidate1',
          name: 'Jane Smith',
          email: 'jane.smith@example.com',
        },
      };
      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(ticketWithCandidate, 'created');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Candidate:.*Jane Smith/),
        }),
      );
      // Candidate email is no longer included in the email
      expect(mockMailService.sendMail).not.toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Candidate Email:/),
        }),
      );
    });

    it('should include both staff and candidate details when both are present', async () => {
      const ticketWithBoth = {
        ...mockTicket,
        created_by: 'creator1',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'system_admin',
        },
        staff: {
          id: 'staff1',
          candidate: {
            id: 'candidate1',
            name: 'John Doe',
            email: 'john.doe@example.com',
          },
        },
        candidate: {
          id: 'candidate2',
          name: 'Jane Smith',
          email: 'jane.smith@example.com',
        },
      };
      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(ticketWithBoth, 'created');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Staff Member:.*John Doe/),
        }),
      );
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringMatching(/Candidate:.*Jane Smith/),
        }),
      );
    });

    it('should resolve the ticket-created-admin template for system admins on created', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);
      mockEmailTemplatesService.getTemplateContent.mockResolvedValueOnce({
        subject: 'Templated admin subject',
        html: '<p>Templated admin body</p>',
      });

      await service.notifyTicketEvent(mockTicket, 'created');

      expect(mockEmailTemplatesService.getTemplateContent).toHaveBeenCalledWith(
        'ticket-created-admin',
        expect.objectContaining({
          '{{emailTitle}}': expect.any(String),
          '{{ticketTitle}}': 'Bug Report',
          '{{orgName}}': 'Test Company',
          '{{staffLine}}': '',
          '{{candidateLine}}': '',
          '{{descriptionBlock}}': expect.stringContaining(
            'Application crashes on login',
          ),
          '{{ticketLink}}': expect.any(String),
        }),
        expect.anything(),
        null,
      );
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Templated admin subject',
          html: '<p>Templated admin body</p>',
        }),
      );
    });

    it('should fall back to inline admin HTML when ticket-created-admin template is missing', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);
      // default mock returns null → fallback path

      await service.notifyTicketEvent(mockTicket, 'created');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Bug Report'),
        }),
      );
    });

    it('should resolve the dedicated ticket-assigned template on assigned', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'organization_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(mockTicket, 'assigned');

      expect(mockEmailTemplatesService.getTemplateContent).toHaveBeenCalledWith(
        'ticket-assigned',
        expect.objectContaining({ '{{ticketTitle}}': 'Bug Report' }),
        expect.anything(),
        null,
      );
      expect(
        mockEmailTemplatesService.getTemplateContent,
      ).not.toHaveBeenCalledWith(
        'ticket-event',
        expect.anything(),
        expect.anything(),
        null,
      );
    });

    it('should keep using the shared ticket-event template for non-assigned events', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'organization_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(mockTicket, 'closed');

      expect(mockEmailTemplatesService.getTemplateContent).toHaveBeenCalledWith(
        'ticket-event',
        expect.anything(),
        expect.anything(),
        null,
      );
      expect(
        mockEmailTemplatesService.getTemplateContent,
      ).not.toHaveBeenCalledWith(
        'ticket-assigned',
        expect.anything(),
        expect.anything(),
        null,
      );
    });
  });

  describe('email content validation', () => {
    it('should include proper detail URLs in hire request emails', async () => {
      const mockHireRequest = {
        id: 'hr1',
        title: 'Test Job',
        description: 'Test description',
        status: 'new',
        priority: 'high',
        specialization: 'Frontend',
        salary_range_from: 5000,
        salary_range_to: 8000,
        expected_start_date: new Date('2024-02-01'),
        availability: 'full-time',
        contract_length: '6 months',
        assign_user_id: 'user1',
        organization: { name: 'Test Company' },
      };

      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'test@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyHireRequestCreated('hr1');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining(
            'https://test.example.com/modules/talent/hire-requests?request=hr1',
          ),
        }),
      );
    });

    it('should include proper detail URLs in ticket emails', async () => {
      const mockTicket = {
        id: 'ticket1',
        title: 'Test Ticket',
        description: 'Test description',
        status: 'new',
        priority: 'high',
        type: 'bug',
        createdAt: new Date('2024-01-15'),
        created_by: 'creator1',
        user: {
          id: 'assignee1',
          email: 'test@example.com',
          role: 'system_admin',
        },
        organization: { name: 'Test Company' },
        staff: null,
        candidate: null,
      };

      // Mock creator lookup
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(mockTicket, 'created');

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining(
            'https://test.example.com/modules/talent/admin/tickets?ticket=ticket1',
          ),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('should propagate mail service errors', async () => {
      const mockHireRequest = {
        id: 'hr1',
        title: 'Test Job',
        description: 'Test description',
        status: 'new',
        priority: 'high',
        specialization: 'Frontend',
        salary_range_from: 5000,
        salary_range_to: 8000,
        expected_start_date: new Date('2024-02-01'),
        availability: 'full-time',
        contract_length: '6 months',
        assign_user_id: 'user1',
        organization: { name: 'Test Company' },
      };

      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'test@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockRejectedValue(
        new Error('Mail service error'),
      );

      await expect(service.notifyHireRequestCreated('hr1')).rejects.toThrow(
        'Mail service error',
      );
    });

    it('should propagate prisma service errors', async () => {
      mockPrismaService.hireRequest.findUnique.mockRejectedValue(
        new Error('Database error'),
      );

      await expect(service.notifyHireRequestCreated('hr1')).rejects.toThrow(
        'Database error',
      );
    });
  });

  // ─── NEW TESTS ────────────────────────────────────────────────────────────

  describe('notifyInterviewScheduled', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Senior VA',
      description: 'Description',
      status: 'interview_scheduled',
      priority: 'high',
      salary_range_from: 4000,
      salary_range_to: 6000,
      expected_start_date: new Date('2024-03-01'),
      hubspot_role_type: 'Medical Assistant',
      availability: 'full-time',
      assign_user_id: 'user1',
      organization: {
        id: 'org1',
        name: 'Test Org',
        business_unit: 'MedVirtual',
      },
      panels: [
        {
          id: 'panel1',
          interviews: [
            {
              id: 'int1',
              scheduled_date: new Date('2024-03-15'),
              link: 'https://meet.example.com/abc',
            },
          ],
          panelCandidates: [
            {
              candidate: {
                id: 'c1',
                first_name: 'Jane',
                last_name: 'Doe',
                name: 'Jane Doe',
                email: 'jane@example.com',
              },
            },
          ],
        },
      ],
    };

    it('should send interview notification successfully with link', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('Interview Invite'),
          html: expect.stringContaining('https://meet.example.com/abc'),
        }),
      );
    });

    it('should send interview notification without link when no link provided', async () => {
      const hrWithoutLink = {
        ...mockHireRequest,
        panels: [
          {
            id: 'panel1',
            interviews: [
              {
                id: 'int1',
                scheduled_date: new Date('2024-03-15'),
                link: null,
              },
            ],
            panelCandidates: [],
          },
        ],
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrWithoutLink);
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.notifyInterviewScheduled('hr1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when no assignee users', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValueOnce([]);

      await expect(service.notifyInterviewScheduled('hr1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle hire request with no expected_start_date', async () => {
      const hrNoDate = { ...mockHireRequest, expected_start_date: null };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoDate);
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Not specified'),
        }),
      );
    });

    // Bug 1 — the DB template lookup must receive the business-unit *slug*
    // (or null), not the display value 'MedVirtual'. Otherwise it never matches
    // the seeded global template and the custom-design render is skipped.
    it('should resolve the DB template (custom design) instead of falling back for a display-value business unit', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);

      // Template resolves only when the lookup value is the slug or null/undefined —
      // i.e. NOT the raw display value 'MedVirtual'.
      mockEmailTemplatesService.getTemplateContent.mockImplementation(
        async (_key, _values, _theme, businessUnit) => {
          if (
            businessUnit === undefined ||
            businessUnit === null ||
            businessUnit === 'medvirtual'
          ) {
            return {
              subject: 'Interview Invite: DB',
              html: '<div>DB_RENDERED_TEMPLATE</div>',
            };
          }
          return null;
        },
      );

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
      // Uses the DB-rendered template, not the buildEmail fallback.
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Interview Invite: DB',
          html: expect.stringContaining('DB_RENDERED_TEMPLATE'),
        }),
      );
    });

    // Bug 2 — when the DB template is missing and buildEmail() is used, the saved
    // custom button color from EmailBranding must still be applied to the CTA button.
    it('should apply the custom buttonColor in the buildEmail fallback', async () => {
      (mockPrismaService as any).emailBranding = {
        findUnique: jest.fn().mockResolvedValue({
          business_unit: 'medvirtual',
          primary_color: '#01546B',
          secondary_color: '#013A4F',
          logo_url: null,
          company_name: 'MedVirtual',
          button_color: '#FF00AA',
          button_text_color: '#FFFFFF',
          layout_preset: 'default',
        }),
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);
      // Force the buildEmail fallback path.
      mockEmailTemplatesService.getTemplateContent.mockResolvedValue(null);

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ html: expect.stringContaining('#FF00AA') }),
      );

      delete (mockPrismaService as any).emailBranding;
    });

    // The DB template body uses {{pairingLinkLine}} instead of hardcoding
    // "Pairing Link: {{interviewLink}}", so the whole line disappears when there
    // is no link. The button is always rendered: it falls back to a "Go to
    // platform" button pointing at the login URL when no pairing link exists.
    it('should drop the pairing line and fall back to a platform login button when there is no link', async () => {
      const hrWithoutLink = {
        ...mockHireRequest,
        panels: [
          {
            id: 'panel1',
            interviews: [
              {
                id: 'int1',
                scheduled_date: new Date('2024-03-15'),
                link: null,
              },
            ],
            panelCandidates: [],
          },
        ],
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrWithoutLink);
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);
      // Force the buildEmail fallback so we can inspect the rendered html too.
      mockEmailTemplatesService.getTemplateContent.mockResolvedValue(null);

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
      expect(mockEmailTemplatesService.getTemplateContent).toHaveBeenCalledWith(
        'hr-interview-scheduled',
        expect.objectContaining({
          '{{pairingLinkLine}}': '',
          '{{ctaLabel}}': 'Go to platform',
          '{{ctaUrl}}': expect.stringContaining('/login'),
        }),
        expect.anything(),
        expect.anything(),
      );
      // Fallback html: no Pairing Link line, no '#' link, but a platform button.
      const sentHtml = mockMailService.sendMail.mock.calls[0][0].html;
      expect(sentHtml).not.toContain('Pairing Link:');
      expect(sentHtml).not.toContain('href="#"');
      expect(sentHtml).toContain('Go to platform');
      expect(sentHtml).toContain('/login');
    });

    it('should show the pairing line and a Join meeting button when a link exists', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany
        .mockResolvedValueOnce([
          {
            id: 'user1',
            email: 'assignee@example.com',
            first_name: 'John',
            last_name: 'Doe',
          },
        ])
        .mockResolvedValueOnce([{ email: 'orguser@example.com' }]);
      mockMailService.sendMail.mockResolvedValue(true);
      mockEmailTemplatesService.getTemplateContent.mockResolvedValue(null);

      const result = await service.notifyInterviewScheduled('hr1');

      expect(result).toBe(true);
      expect(mockEmailTemplatesService.getTemplateContent).toHaveBeenCalledWith(
        'hr-interview-scheduled',
        expect.objectContaining({
          '{{pairingLinkLine}}': 'Pairing Link: https://meet.example.com/abc',
          '{{ctaLabel}}': 'Join meeting',
          '{{ctaUrl}}': 'https://meet.example.com/abc',
        }),
        expect.anything(),
        expect.anything(),
      );
      const sentHtml = mockMailService.sendMail.mock.calls[0][0].html;
      expect(sentHtml).toContain('Pairing Link:');
      expect(sentHtml).toContain('Join meeting');
    });
  });

  describe('notifyHireRequestSourcingAssignee', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Sourcing Job',
      description: 'Description',
      priority: 'high',
      assigned_sourcing: {
        id: 'sourcing1',
        email: 'sourcing@example.com',
        first_name: 'Jane',
        last_name: 'Smith',
      },
      organization: { name: 'Test Org', business_unit: 'MedVirtual' },
    };

    it('should send sourcing assignee notification successfully', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestSourcingAssignee(
        'hr1',
        'sourcing',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['sourcing@example.com'],
          subject: expect.stringContaining('Sourcing Job'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestSourcingAssignee('hr1', 'sourcing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when no sourcing assignee email', async () => {
      const hrNoEmail = {
        ...mockHireRequest,
        assigned_sourcing: {
          id: 'sourcing1',
          email: null,
          first_name: 'Jane',
          last_name: 'Smith',
        },
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoEmail);

      await expect(
        service.notifyHireRequestSourcingAssignee('hr1', 'sourcing'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle missing description', async () => {
      const hrNoDesc = { ...mockHireRequest, description: null };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoDesc);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestSourcingAssignee(
        'hr1',
        'sourcing',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('No description provided'),
        }),
      );
    });
  });

  describe('notifyHireRequestConciergeAssigned', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Concierge Job',
      description: 'Description',
      priority: 'high',
      assign_user_id: 'user1',
      organization: { name: 'Test Org', business_unit: 'MedVirtual' },
    };

    it('should send concierge notification successfully', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'user@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestConciergeAssigned(
        'hr1',
        'for_review',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Hire Request For Review: Concierge Job',
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestConciergeAssigned('hr1', 'for_review'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when no assignee users', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(
        service.notifyHireRequestConciergeAssigned('hr1', 'for_review'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('notifyHireRequestCreated - type branches', () => {
    const baseHireRequest = {
      id: 'hr1',
      title: 'VA Role',
      description: 'Description',
      status: 'new',
      priority: 'high',
      salary_range_from: 3000,
      salary_range_to: 5000,
      expected_start_date: new Date('2024-04-01'),
      availability: 'part-time',
      assign_user_id: 'user1',
      assigned_sourcing: {
        id: 'sourcing1',
        email: 'sourcing@example.com',
        first_name: 'Jane',
        last_name: 'Smith',
      },
      assigned_staffing: {
        id: 'staffing1',
        email: 'staffing@example.com',
        first_name: 'Bob',
        last_name: 'Jones',
      },
      organization: { name: 'Test Org', business_unit: 'MedVirtual' },
    };

    it('should notify sourcing assignee when type is sourcing', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        baseHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'sourcing1',
          email: 'sourcing@example.com',
          first_name: 'Jane',
          last_name: 'Smith',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestCreated('hr1', 'sourcing');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining(
            'Sourcing Assignment to a Hire Request',
          ),
        }),
      );
    });

    it('should notify staffing coordinator when type is staffing_coordinator', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        baseHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'staffing1',
          email: 'staffing@example.com',
          first_name: 'Bob',
          last_name: 'Jones',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestCreated(
        'hr1',
        'staffing_coordinator',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining(
            'Staffing Coordinator Assignment to a Hire Request',
          ),
        }),
      );
    });

    it('should throw BadRequestException when type=sourcing but no sourcing email', async () => {
      const hrNoSourcing = { ...baseHireRequest, assigned_sourcing: null };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoSourcing);

      await expect(
        service.notifyHireRequestCreated('hr1', 'sourcing'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when type=staffing_coordinator but no staffing email', async () => {
      const hrNoStaffing = { ...baseHireRequest, assigned_staffing: null };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoStaffing);

      await expect(
        service.notifyHireRequestCreated('hr1', 'staffing_coordinator'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should include panel_request_flow note when from=panel_request_flow', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        baseHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'user@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestCreated(
        'hr1',
        undefined,
        'panel_request_flow',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Panel Request Flow'),
        }),
      );
    });
  });

  describe('notifyHireRequestBackToSourcing', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Back to Sourcing',
      description: 'Description',
      status: 'sourcing',
      priority: 'medium',
      salary_range_from: 4000,
      salary_range_to: 7000,
      expected_start_date: new Date('2024-05-01'),
      availability: 'full-time',
      assign_user_id: 'user1',
      assigned_sourcing: {
        id: 'sourcing1',
        email: 'sourcing@example.com',
        first_name: 'Jane',
        last_name: 'Smith',
      },
      organization: { name: 'Test Org', business_unit: 'MedVirtual' },
    };

    it('should send back to sourcing notification successfully', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestBackToSourcing('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['sourcing@example.com'],
          subject: 'Hire Request Assigned: Back to Sourcing',
          html: expect.stringContaining('back to sourcing'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestBackToSourcing('hr1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when sourcing assignee has no email', async () => {
      const hrNoEmail = {
        ...mockHireRequest,
        assigned_sourcing: {
          id: 'sourcing1',
          email: null,
          first_name: 'Jane',
          last_name: 'Smith',
        },
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoEmail);

      await expect(
        service.notifyHireRequestBackToSourcing('hr1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle null salary range and start date', async () => {
      const hrNoSalary = {
        ...mockHireRequest,
        salary_range_from: null,
        salary_range_to: null,
        expected_start_date: null,
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoSalary);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestBackToSourcing('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Not specified'),
        }),
      );
    });
  });

  describe('notifyClientPanelReady', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Panel Ready Job',
      description: 'Description',
      status: 'panel_ready',
      priority: 'high',
      salary_range_from: 3000,
      salary_range_to: 5000,
      expected_start_date: new Date('2024-04-15'),
      availability: 'full-time',
      organization: {
        id: 'org1',
        name: 'Test Org',
        business_unit: 'MedVirtual',
      },
    };

    it('should send panel ready notification to org users', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        { email: 'orgadmin@example.com' },
        { email: 'orgowner@example.com' },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyClientPanelReady('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: expect.arrayContaining([
            'orgadmin@example.com',
            'orgowner@example.com',
          ]),
          subject: 'Your candidate panel is ready: Panel Ready Job',
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.notifyClientPanelReady('hr1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when no active org users', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(service.notifyClientPanelReady('hr1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle null salary range', async () => {
      const hrNoSalary = {
        ...mockHireRequest,
        salary_range_from: null,
        salary_range_to: null,
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoSalary);
      mockPrismaService.uSER.findMany.mockResolvedValue([
        { email: 'orgadmin@example.com' },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyClientPanelReady('hr1');

      expect(result).toBe(true);
    });
  });

  describe('notifyHireRequestPanelReady', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Panel Reviewed Job',
      description: 'Description',
      status: 'panel_ready',
      priority: 'high',
      salary_range_from: 4000,
      salary_range_to: 6000,
      expected_start_date: new Date('2024-05-01'),
      availability: 'full-time',
      assign_user_id: 'user1',
      assigned_sourcing: {
        id: 'sourcing1',
        email: 'sourcing@example.com',
        first_name: 'Jane',
        last_name: 'Smith',
      },
      organization: { name: 'Test Org', business_unit: 'MedVirtual' },
    };

    it('should send panel ready notification to sourcing assignee', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestPanelReady('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['sourcing@example.com'],
          subject: 'Panel Reviewed and Ready: Panel Reviewed Job',
          html: expect.stringContaining('Panel Ready'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.notifyHireRequestPanelReady('hr1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when sourcing assignee has no email', async () => {
      const hrNoEmail = { ...mockHireRequest, assigned_sourcing: null };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoEmail);

      await expect(service.notifyHireRequestPanelReady('hr1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('notifyEndorseCandidates', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Endorse Job',
      description: 'Description',
      priority: 'high',
      assign_user_id: 'user1',
      organization: { name: 'Test Org', business_unit: 'MedVirtual' },
    };

    it('should send endorse candidates notification', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'user1',
          email: 'user@example.com',
          first_name: 'John',
          last_name: 'Doe',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyEndorseCandidates('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'New candidates in Hire Request: Endorse Job',
          html: expect.stringContaining('new candidates'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(service.notifyEndorseCandidates('hr1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when no assignee users', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(service.notifyEndorseCandidates('hr1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('notifyHireRequestSelectWinner - no admins branch', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Winner Job',
      description: 'Description',
      status: 'placement_completed',
      priority: 'high',
      salary_range_from: 5000,
      salary_range_to: 8000,
      expected_start_date: new Date('2024-06-01'),
      hubspot_role_type: 'Medical Assistant',
      availability: 'full-time',
      organization: {
        id: 'org1',
        name: 'Test Org',
        business_unit: 'MedVirtual',
        admin: null,
        owner: null,
      },
      panels: [
        {
          id: 'panel1',
          panelCandidates: [],
        },
      ],
    };

    it('should throw BadRequestException when no organization admins', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(
        service.notifyHireRequestSelectWinner('hr1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should send notification when admins exist and no winner candidate', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestSelectWinner('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Not specified'),
        }),
      );
    });

    it('should include winner name when winner candidate exists', async () => {
      const hrWithWinner = {
        ...mockHireRequest,
        panels: [
          {
            id: 'panel1',
            panelCandidates: [
              {
                candidate: {
                  id: 'c1',
                  first_name: 'Jane',
                  last_name: 'Doe',
                  name: 'Jane Doe',
                },
              },
            ],
          },
        ],
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrWithWinner);
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestSelectWinner('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Jane Doe'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestSelectWinner('hr1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should deduplicate admin and owner when both have the same email', async () => {
      const hrWithAdminOwner = {
        ...mockHireRequest,
        organization: {
          ...mockHireRequest.organization,
          admin: {
            id: 'admin1',
            email: 'admin@example.com',
            first_name: 'Admin',
            last_name: 'User',
          },
          owner: {
            id: 'admin1',
            email: 'admin@example.com',
            first_name: 'Admin',
            last_name: 'User',
          },
        },
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hrWithAdminOwner,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestSelectWinner('hr1');

      expect(result).toBe(true);
      // Only one unique email — sendMail called once
      expect(mockMailService.sendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifyHireRequestAwaitingDecision - no admins branch', () => {
    const mockHireRequest = {
      id: 'hr1',
      title: 'Awaiting Job',
      hubspot_role_type: 'Medical Assistant',
      availability: 'full-time',
      status: 'awaiting_decision',
      panels: [
        {
          id: 'panel1',
          status: 'decision_pending',
          scheduled_date: new Date('2024-06-15'),
        },
      ],
      organization: {
        id: 'org1',
        name: 'Test Org',
        business_unit: 'MedVirtual',
      },
    };

    it('should throw BadRequestException when no organization admins', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        mockHireRequest,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([]);

      await expect(
        service.notifyHireRequestAwaitingDecision('hr1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should send notification when no scheduled date', async () => {
      const hrNoDate = {
        ...mockHireRequest,
        panels: [
          { id: 'panel1', status: 'decision_pending', scheduled_date: null },
        ],
      };
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(hrNoDate);
      mockPrismaService.uSER.findMany.mockResolvedValue([
        {
          id: 'admin1',
          email: 'admin@example.com',
          first_name: 'Admin',
          last_name: 'User',
          role: 'organization_admin',
        },
      ]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyHireRequestAwaitingDecision('hr1');

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Not specified'),
        }),
      );
    });

    it('should throw NotFoundException when hire request not found', async () => {
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyHireRequestAwaitingDecision('hr1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('notifyTicketStatusChangeToCreator', () => {
    const mockTicket = {
      id: 'ticket1',
      title: 'Status Change Ticket',
      description: 'Description',
      status: 'in_progress',
      type: 'support',
      createdAt: new Date('2024-01-15'),
      created_by: 'creator1',
      organization: { name: 'Test Company' },
    };

    it('should send status change notification to creator (system admin)', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketStatusChangeToCreator(
        mockTicket,
        'in_progress',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MedVirtual'),
          to: ['creator@example.com'],
          subject: expect.stringContaining('IN PROGRESS'),
        }),
      );
    });

    it('should throw NotFoundException when ticket is null', async () => {
      await expect(
        service.notifyTicketStatusChangeToCreator(null, 'resolved'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when creator has no email', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyTicketStatusChangeToCreator(mockTicket, 'resolved'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should return false when creator is client and ticket is not support', async () => {
      const nonSupportTicket = { ...mockTicket, type: 'general' };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'organization_admin',
      });

      const result = await service.notifyTicketStatusChangeToCreator(
        nonSupportTicket,
        'resolved',
      );

      expect(result).toBe(false);
      expect(mockMailService.sendMail).not.toHaveBeenCalled();
    });

    it('should send notification when creator is client and ticket is support', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'organization_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketStatusChangeToCreator(
        mockTicket,
        'resolved',
      );

      expect(result).toBe(true);
    });

    it('should use ticket.id fallback to fetch created_by when created_by is missing', async () => {
      const ticketNoCreatedBy = { ...mockTicket, created_by: null };
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        created_by: 'creator1',
      });
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketStatusChangeToCreator(
        ticketNoCreatedBy,
        'closed',
      );

      expect(result).toBe(true);
    });

    it('should send notification with referral ticket type', async () => {
      const referralTicket = {
        ...mockTicket,
        type: 'referral',
        description:
          'Name: John Doe\nEmail: john@example.com\nMessage: Test message',
      };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketStatusChangeToCreator(
        referralTicket,
        'resolved',
      );

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('John Doe'),
        }),
      );
    });
  });

  describe('notifyTicketReopened', () => {
    const mockTicket = {
      id: 'ticket1',
      title: 'Reopened Ticket',
      description: 'Description',
      type: 'support',
      createdAt: new Date('2024-01-15'),
      created_by: 'creator1',
      organization: { name: 'Test Company' },
    };

    it('should send reopened notification to creator (system admin)', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketReopened(mockTicket);

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['creator@example.com'],
          subject: 'Your ticket has been reopened: Reopened Ticket',
        }),
      );
    });

    it('should throw NotFoundException when ticket is null', async () => {
      await expect(service.notifyTicketReopened(null)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when creator has no email', async () => {
      mockPrismaService.uSER.findUnique.mockResolvedValue(null);

      await expect(service.notifyTicketReopened(mockTicket)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return false when creator is client and ticket is not support', async () => {
      const nonSupportTicket = { ...mockTicket, type: 'general' };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'organization_admin',
      });

      const result = await service.notifyTicketReopened(nonSupportTicket);

      expect(result).toBe(false);
    });

    it('should use ticket.id fallback when created_by is missing', async () => {
      const ticketNoCreatedBy = { ...mockTicket, created_by: null };
      mockPrismaService.ticket.findFirst.mockResolvedValue({
        created_by: 'creator1',
      });
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketReopened(ticketNoCreatedBy);

      expect(result).toBe(true);
    });

    it('should send notification with referral ticket type', async () => {
      const referralTicket = {
        ...mockTicket,
        type: 'referral',
        description:
          'Name: Jane Smith\nEmail: jane@example.com\nMessage: Referral message',
      };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketReopened(referralTicket);

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Jane Smith'),
        }),
      );
    });
  });

  describe('notifyTicketNoteAddedToAssignee', () => {
    const mockTicket = {
      id: 'ticket1',
      title: 'Note Ticket',
      organization: { name: 'Test Company' },
      user_id: 'assignee1',
      user: {
        id: 'assignee1',
        email: 'assignee@example.com',
        first_name: 'John',
        last_name: 'Doe',
      },
    };

    it('should send note added notification to assignee', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketNoteAddedToAssignee('ticket1', {
        content: 'This is a response.',
        author: { id: 'author1', first_name: 'Admin', last_name: 'User' },
      });

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['assignee@example.com'],
          subject: 'You received a response on your ticket: Note Ticket',
          html: expect.stringContaining('This is a response.'),
        }),
      );
    });

    it('should throw NotFoundException when ticket not found', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.notifyTicketNoteAddedToAssignee('ticket1', { content: 'note' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when ticket has no assigned user', async () => {
      const ticketNoUser = { ...mockTicket, user_id: null, user: null };
      mockPrismaService.ticket.findFirst.mockResolvedValue(ticketNoUser);

      await expect(
        service.notifyTicketNoteAddedToAssignee('ticket1', { content: 'note' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should use fallback author name when author is not provided', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketNoteAddedToAssignee('ticket1', {
        content: 'note content',
      });

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('A user'),
        }),
      );
    });
  });

  describe('notifyTicketNoteAddedToCreator', () => {
    const mockTicket = {
      id: 'ticket1',
      title: 'Creator Note Ticket',
      organization: { name: 'Test Company' },
      created_by: 'creator1',
    };

    it('should send note added notification to creator', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          first_name: 'Bob',
          last_name: 'Smith',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ id: 'creator1', role: 'system_admin' });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketNoteAddedToCreator('ticket1', {
        content: 'Creator response here.',
        author: { id: 'author1', first_name: 'Admin', last_name: 'User' },
      });

      expect(result).toBe(true);
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['creator@example.com'],
          subject:
            'You received a response on your ticket: Creator Note Ticket',
          html: expect.stringContaining('Creator response here.'),
        }),
      );
    });

    it('should throw NotFoundException when ticket not found', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.notifyTicketNoteAddedToCreator('ticket1', { content: 'note' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when ticket has no creator', async () => {
      const ticketNoCreator = { ...mockTicket, created_by: null };
      mockPrismaService.ticket.findFirst.mockResolvedValue(ticketNoCreator);

      await expect(
        service.notifyTicketNoteAddedToCreator('ticket1', { content: 'note' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when creator has no email', async () => {
      mockPrismaService.ticket.findFirst.mockResolvedValue(mockTicket);
      mockPrismaService.uSER.findUnique.mockResolvedValue(null);

      await expect(
        service.notifyTicketNoteAddedToCreator('ticket1', { content: 'note' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('formatReferralDescription (via notifyTicketStatusChangeToCreator)', () => {
    it('should parse Name, Email, and Message fields correctly', async () => {
      const referralTicket = {
        id: 'ticket1',
        title: 'Referral Ticket',
        description:
          'Name: Alice Johnson\nEmail: alice@example.com\nMessage: Looking for a VA',
        type: 'referral',
        createdAt: new Date('2024-01-15'),
        created_by: 'creator1',
        organization: { name: 'Test Company' },
      };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketStatusChangeToCreator(
        referralTicket,
        'resolved',
      );

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Alice Johnson'),
        }),
      );
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('alice@example.com'),
        }),
      );
      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Looking for a VA'),
        }),
      );
    });

    it('should handle multi-line message in referral description', async () => {
      const referralTicket = {
        id: 'ticket1',
        title: 'Referral Multi',
        description:
          'Name: Bob\nEmail: bob@example.com\nMessage: Line one\nLine two\nLine three',
        type: 'referral',
        createdAt: new Date('2024-01-15'),
        created_by: 'creator1',
        organization: { name: 'Test Company' },
      };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'system_admin',
      });
      mockPrismaService.organization.findMany.mockResolvedValue([]);
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketStatusChangeToCreator(
        referralTicket,
        'in_progress',
      );

      expect(mockMailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Line one'),
        }),
      );
    });
  });

  describe('notifyTicketEvent - additional branches', () => {
    const mockTicket = {
      id: 'ticket1',
      title: 'Event Ticket',
      description: 'Description',
      status: 'new',
      priority: 'high',
      type: 'support',
      createdAt: new Date('2024-01-15'),
      created_by: 'creator1',
      user: {
        id: 'assignee1',
        email: 'assignee@example.com',
        role: 'system_admin',
      },
      organization: { name: 'Test Company' },
      staff: null,
      candidate: null,
    };

    it('should throw BadRequestException when all recipients are clients on resolved non-support ticket', async () => {
      const nonSupportTicket = {
        ...mockTicket,
        type: 'general',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'organization_admin',
        },
      };
      mockPrismaService.uSER.findUnique.mockResolvedValue({
        id: 'creator1',
        email: 'creator@example.com',
        role: 'organization_admin',
      });

      // All recipients are non-system-admins, filtered out for resolved non-support ticket → BadRequestException
      await expect(
        service.notifyTicketEvent(nonSupportTicket, 'resolved'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should add paulo@regenta.ai as fixed recipient for support tickets', async () => {
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ role: 'system_admin' })
        .mockResolvedValueOnce({ role: 'system_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(mockTicket, 'created');

      const calls = mockMailService.sendMail.mock.calls
        .map((c: any[]) => c[0].to)
        .flat();
      expect(calls).toContain('paulo@regenta.ai');
    });

    it('should send notification for resolved event on support ticket to clients', async () => {
      const clientTicket = {
        ...mockTicket,
        type: 'support',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'organization_admin',
        },
      };
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'organization_admin',
        })
        .mockResolvedValueOnce({ role: 'organization_admin' })
        .mockResolvedValueOnce({ role: 'organization_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(clientTicket, 'resolved');

      expect(result).toBe(true);
    });
  });

  describe('getTicketDetailUrl', () => {
    it('should return /profile URL for organization_admin role', () => {
      const url = (service as any).getTicketDetailUrl(
        'ticket1',
        'organization_admin',
      );
      expect(url).toBe(
        'https://test.example.com/modules/profile?ticket=ticket1',
      );
    });

    it('should return /profile URL for organization_super_admin role', () => {
      const url = (service as any).getTicketDetailUrl(
        'ticket1',
        'organization_super_admin',
      );
      expect(url).toBe(
        'https://test.example.com/modules/profile?ticket=ticket1',
      );
    });

    it('should return /tickets URL for system_admin role', () => {
      const url = (service as any).getTicketDetailUrl(
        'ticket1',
        'system_admin',
      );
      expect(url).toBe(
        'https://test.example.com/modules/talent/admin/tickets?ticket=ticket1',
      );
    });

    it('should return /tickets URL when role is undefined', () => {
      const url = (service as any).getTicketDetailUrl('ticket1', undefined);
      expect(url).toBe(
        'https://test.example.com/modules/talent/admin/tickets?ticket=ticket1',
      );
    });
  });

  describe('decodeHtmlEntities', () => {
    it('should decode all supported HTML entities', () => {
      const input = '&amp;&lt;&gt;&quot;&#39;&nbsp;&#x27;&#x2F;&#x2f;&#47;';
      const result = (service as any).decodeHtmlEntities(input);
      expect(result).toBe("&<>\"' '///");
    });

    it('should return empty string for falsy input', () => {
      expect((service as any).decodeHtmlEntities('')).toBe('');
      expect((service as any).decodeHtmlEntities(null)).toBe('');
      expect((service as any).decodeHtmlEntities(undefined)).toBe('');
    });
  });

  describe('notifyTicketEvent - Bonus ticket title branches', () => {
    const bonusTicketWithOrg = {
      id: 'ticket1',
      title: 'Bonus Ticket',
      description: 'Bonus description',
      status: 'new',
      priority: 'high',
      type: 'bonus',
      createdAt: new Date('2024-01-15'),
      created_by: 'creator1',
      user: {
        id: 'assignee1',
        email: 'assignee@example.com',
        role: 'system_admin',
      },
      organization: { name: 'Test Company' },
      staff: { candidate: { name: 'Staff Member' } },
      candidate: null,
    };

    it('should use org name in subject for Bonus ticket with org and staff', async () => {
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ role: 'system_admin' })
        .mockResolvedValueOnce({ role: 'system_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(bonusTicketWithOrg, 'created');

      const calls = mockMailService.sendMail.mock.calls as any[][];
      const subjectWithOrg = calls.some(
        (c) => c[0].subject === 'Bonus Ticket Created for Test Company',
      );
      expect(subjectWithOrg).toBe(true);
    });

    it('should use staff name in subject for Bonus ticket with staff but no org', async () => {
      const bonusTicketNoOrg = { ...bonusTicketWithOrg, organization: null };
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ role: 'system_admin' })
        .mockResolvedValueOnce({ role: 'system_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(bonusTicketNoOrg, 'created');

      const calls = mockMailService.sendMail.mock.calls as any[][];
      const subjectWithStaff = calls.some(
        (c) => c[0].subject === 'Bonus Ticket Created for Staff Member',
      );
      expect(subjectWithStaff).toBe(true);
    });

    it('should use generic subject for ticket with no org and no staff', async () => {
      const genericTicket = {
        ...bonusTicketWithOrg,
        type: 'general',
        organization: null,
        staff: null,
      };
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ role: 'system_admin' })
        .mockResolvedValueOnce({ role: 'system_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      await service.notifyTicketEvent(genericTicket, 'created');

      const calls = mockMailService.sendMail.mock.calls as any[][];
      const subjectGeneric = calls.some(
        (c) =>
          (c[0].subject as string).includes('Ticket Created') &&
          !(c[0].subject as string).includes('for'),
      );
      expect(subjectGeneric).toBe(true);
    });
  });

  describe('notifyTicketEvent - fallback creator lookup in event handler', () => {
    it('should use ticket.id fallback to find creator in notifyTicketEvent when created_by is absent', async () => {
      const ticketNoCreatedBy = {
        id: 'ticket1',
        title: 'Fallback Ticket',
        description: 'Description',
        type: 'support',
        createdAt: new Date('2024-01-15'),
        created_by: null,
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'system_admin',
        },
        organization: { name: 'Test Company' },
        staff: null,
        candidate: null,
      };

      mockPrismaService.ticket.findFirst.mockResolvedValue({
        created_by: 'creator1',
        user_id: 'assignee1',
      });
      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ role: 'system_admin' })
        .mockResolvedValueOnce({ role: 'system_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(
        ticketNoCreatedBy,
        'created',
      );

      expect(result).toBe(true);
    });
  });

  describe('notifyTicketEvent - referral ticket in standard path', () => {
    it('should render referral description in standard format for non-system-admin', async () => {
      const referralTicket = {
        id: 'ticket1',
        title: 'Referral',
        description: 'Name: Bob\nEmail: bob@test.com\nMessage: Hello',
        type: 'referral',
        createdAt: new Date('2024-01-15'),
        created_by: 'creator1',
        user: {
          id: 'assignee1',
          email: 'assignee@example.com',
          role: 'system_admin',
        },
        organization: { name: 'Test Org' },
        staff: null,
        candidate: null,
      };

      mockPrismaService.uSER.findUnique
        .mockResolvedValueOnce({
          id: 'creator1',
          email: 'creator@example.com',
          role: 'system_admin',
        })
        .mockResolvedValueOnce({ role: 'system_admin' })
        .mockResolvedValueOnce({ role: 'system_admin' });
      mockMailService.sendMail.mockResolvedValue(true);

      const result = await service.notifyTicketEvent(
        referralTicket,
        'assigned',
      );

      expect(result).toBe(true);
      const calls = mockMailService.sendMail.mock.calls as any[][];
      const bodyWithBob = calls.some((c) =>
        (c[0].html as string).includes('Bob'),
      );
      expect(bodyWithBob).toBe(true);
    });
  });

  describe('notifyHireRequestPlacementCompleted - no recipients branch', () => {
    it('should throw BadRequestException when all recipient emails are empty', async () => {
      const hrNoRecipients = {
        id: 'hr1',
        title: 'No Recipients Job',
        description: 'Description',
        status: 'placement_completed',
        priority: 'high',
        specialization: 'Frontend',
        salary_range_from: null,
        salary_range_to: null,
        expected_start_date: null,
        assign_user_id: 'user1',
        assigned_sourcing: null,
        createdBy: null,
        organization: { name: 'Test Company', business_unit: 'MedVirtual' },
        panels: [],
      };

      // All users returned have null emails
      mockPrismaService.hireRequest.findUnique.mockResolvedValue(
        hrNoRecipients,
      );
      mockPrismaService.uSER.findMany.mockResolvedValue([
        { id: 'user1', email: null, first_name: 'John', last_name: 'Doe' },
      ]);

      await expect(
        service.notifyHireRequestPlacementCompleted('hr1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('offer panel created — candidate cards', () => {
    const basePanel = {
      id: 'p1',
      title: 'Panel',
      description: null,
      business_unit: 'MedVirtual',
      recipient_name: 'Jane',
      recipient_email: 'jane@client.com',
      recipient_org_name: 'Client Co',
      promo_enabled: false,
      public_token: 'tok-123',
      recipientUser: { first_name: 'Jane' },
      createdBy: {
        first_name: 'Paulo',
        last_name: 'Melo',
        email: 'paulo@medvirtual.ai',
      },
      candidates: [{ candidate_id: 'c1' }],
      _count: { candidates: 1 },
    };

    const candidateRow = {
      id: 'c1',
      first_name: 'Ana',
      last_name: 'Silva',
      name: 'Ana Silva',
      country: 'Brazil',
      avatar_url: 'ana.png',
      gender: 'female',
      employment_type: null,
      hourly_pay_rate: null,
      business_unit: 'MedVirtual',
      approved_positions_pairing: [],
      languages: [],
      skills: [{ skill_name: 'EMR' }],
    };

    beforeEach(() => {
      (mockPrismaService as any).offerPanel = { findUnique: jest.fn() };
      mockPrismaService.candidate.findMany.mockResolvedValue([candidateRow]);
      mockPositionRateConfigService.findAllUnpaginated.mockResolvedValue([]);
      mockEmailTemplatesService.getTemplateContent.mockResolvedValue(null);
      mockMailService.sendMail.mockResolvedValue(true);
    });

    it.each([
      ['public', 'notifyOfferPanelCreatedPublic'],
      ['client', 'notifyOfferPanelCreatedClient'],
    ] as const)(
      'passes the rendered cards to the template on the %s variant',
      async (_label, method) => {
        (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue(
          basePanel,
        );

        await (service as any)[method]('p1');

        const [, runtimeValues] =
          mockEmailTemplatesService.getTemplateContent.mock.calls[0];
        expect(runtimeValues['{{candidateCards}}']).toContain('Ana S.');
        // Injected into a body that renderHtml then newline-replaces.
        expect(runtimeValues['{{candidateCards}}']).not.toContain('\n');
      },
    );

    it('prefixes the bare S3 avatar key so the image resolves in an inbox', async () => {
      (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue(
        basePanel,
      );

      await service.notifyOfferPanelCreatedPublic('p1');

      const [, runtimeValues] =
        mockEmailTemplatesService.getTemplateContent.mock.calls[0];
      expect(runtimeValues['{{candidateCards}}']).toContain(
        'amazonaws.com/ana.png',
      );
    });

    it('still sends when the panel has no candidates', async () => {
      (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue({
        ...basePanel,
        candidates: [],
        _count: { candidates: 0 },
      });

      await expect(service.notifyOfferPanelCreatedPublic('p1')).resolves.toBe(
        true,
      );
      expect(mockPrismaService.candidate.findMany).not.toHaveBeenCalled();
    });

    // A failure building the cards must not cost the recipient the whole email.
    it('sends a cardless email rather than failing when candidates cannot load', async () => {
      (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue(
        basePanel,
      );
      mockPrismaService.candidate.findMany.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.notifyOfferPanelCreatedPublic('p1')).resolves.toBe(
        true,
      );

      const [, runtimeValues] =
        mockEmailTemplatesService.getTemplateContent.mock.calls[0];
      expect(runtimeValues['{{candidateCards}}']).toBe('');
    });

    describe('HubSpot BCC logging', () => {
      const HUBSPOT_BCC = '20630393@bcc.hubspot.com';
      const originalEnvironment = process.env.ENVIRONMENT;
      const originalBccEmail = process.env.HUBSPOT_BCC_EMAIL;

      beforeEach(() => {
        (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue(
          basePanel,
        );
      });

      // Both vars are read by other suites in this file, so they are restored
      // rather than deleted.
      afterEach(() => {
        process.env.ENVIRONMENT = originalEnvironment;
        process.env.HUBSPOT_BCC_EMAIL = originalBccEmail;
      });

      it.each([
        ['public', 'notifyOfferPanelCreatedPublic'],
        ['client', 'notifyOfferPanelCreatedClient'],
      ] as const)(
        'bccs the HubSpot address on the %s variant in PROD',
        async (_label, method) => {
          process.env.ENVIRONMENT = 'PROD';
          process.env.HUBSPOT_BCC_EMAIL = HUBSPOT_BCC;

          await (service as any)[method]('p1');

          expect(mockMailService.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({ bcc: HUBSPOT_BCC }),
          );
        },
      );

      // The address lives in local .env too, so the environment gate — not the
      // presence of the var — is what keeps test sends off a real CRM timeline.
      it('omits the bcc outside PROD even when the address is configured', async () => {
        process.env.ENVIRONMENT = 'DEV';
        process.env.HUBSPOT_BCC_EMAIL = HUBSPOT_BCC;

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ bcc: undefined }),
        );
      });

      it('omits the bcc in PROD when the address is not configured', async () => {
        process.env.ENVIRONMENT = 'PROD';
        delete process.env.HUBSPOT_BCC_EMAIL;

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ bcc: undefined }),
        );
      });

      // A whitespace-only value must disable the BCC, not reach Resend as an
      // invalid recipient.
      it('omits the bcc when the configured address is blank', async () => {
        process.env.ENVIRONMENT = 'PROD';
        process.env.HUBSPOT_BCC_EMAIL = '   ';

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ bcc: undefined }),
        );
      });

      it.each([
        ['PROD', 'PROD'],
        ['DEV', 'DEV'],
      ] as const)(
        'still ccs the panel creator in %s',
        async (_label, environment) => {
          process.env.ENVIRONMENT = environment;
          process.env.HUBSPOT_BCC_EMAIL = HUBSPOT_BCC;

          await service.notifyOfferPanelCreatedPublic('p1');

          expect(mockMailService.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({ cc: 'paulo@medvirtual.ai' }),
          );
        },
      );
    });

    describe('sender address', () => {
      it.each([
        ['public', 'notifyOfferPanelCreatedPublic'],
        ['client', 'notifyOfferPanelCreatedClient'],
      ] as const)(
        'sends as the creator when their email is on a verified domain (%s)',
        async (_label, method) => {
          (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue({
            ...basePanel,
            createdBy: { ...basePanel.createdBy, email: 'paulo@medvirtual.ai' },
          });

          await (service as any)[method]('p1');

          expect(mockMailService.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
              from: expect.stringContaining('<paulo@medvirtual.ai>'),
            }),
          );
        },
      );

      it('sends as the creator when their email is on the other verified domain', async () => {
        (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue({
          ...basePanel,
          createdBy: {
            ...basePanel.createdBy,
            email: 'hanieh@berryvirtual.com',
          },
        });

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            from: expect.stringContaining('<hanieh@berryvirtual.com>'),
          }),
        );
      });

      it('falls back to the shared noreply address when the creator domain is not verified', async () => {
        (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue({
          ...basePanel,
          createdBy: { ...basePanel.createdBy, email: 'paulo@regenta.ai' },
        });

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            from: expect.stringContaining('<noreply@medvirtual.ai>'),
          }),
        );
      });

      it('falls back to the shared noreply address when the creator has no email', async () => {
        (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue({
          ...basePanel,
          createdBy: { ...basePanel.createdBy, email: null },
        });

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            from: expect.stringContaining('<noreply@medvirtual.ai>'),
          }),
        );
      });

      it('still suppresses the cc when the verified creator email matches the recipient', async () => {
        (mockPrismaService as any).offerPanel.findUnique.mockResolvedValue({
          ...basePanel,
          recipient_email: 'paulo@medvirtual.ai',
          createdBy: { ...basePanel.createdBy, email: 'paulo@medvirtual.ai' },
        });

        await service.notifyOfferPanelCreatedPublic('p1');

        expect(mockMailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            from: expect.stringContaining('<paulo@medvirtual.ai>'),
            cc: undefined,
          }),
        );
      });
    });
  });
});
