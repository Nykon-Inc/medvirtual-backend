import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { USER } from '@prisma/client';

import { CreateStaffDto } from './dto/create-staff.dto';
import { CreateBonusDto } from './dto/create-bonus.dto';
import { terminateDto } from './dto/terminate.dto';

import { PrismaService } from '../prisma/prisma.service';
import { staffStatusDictionary } from '../common/dictionaries/staff-status-dictionary';
import { dealToDbDictionary } from '../common/dictionaries/deal-dictionary';
import axios from 'axios';
import { HandlerObjectCreation } from '../hubspot/handlers/objectCreation';
import { HandlerOrganizationCreation } from '../hubspot/handlers/organizationCreation';
import { activePipelines } from '../common/constant/activeDealPipelines';
import {
  TicketAuditService,
  TICKET_AUDIT_EVENTS,
  TICKET_AUDIT_ORIGINS,
  buildActorLabel,
} from '../ticket/ticket-audit.service';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objectCreation: HandlerObjectCreation,
    private readonly organizationCreation: HandlerOrganizationCreation,
    private readonly ticketAudit: TicketAuditService,
  ) {}

  private async findOne(id: string) {
    const staff = await this.prisma.staff.findUnique({
      where: { id },
      select: {
        id: true,
        hirerequest_id: true,
        status: true,
        salary: true,
        start_date: true,
        created_at: true,
        updated_at: true,
        hubspot_id: true,
        hubspot_close_date: true,
        hubspot_deal_name: true,
        hubspot_dealstage: true,
        hubspot_dealtype: true,
        hubspot_deployment_type: true,
        hubspot_description: true,
        hubspot_hs_acv: true,
        hubspot_pipeline: true,
        hubspot_business_unit: true,
        hubspot_candidate_id: true,
        hubspot_organization_id: true,
        candidate: {
          select: {
            id: true,
            hubspot_vaid: true,
            first_name: true,
            last_name: true,
            name: true,
            email: true,
            specialization: true,
            employment_type: true,
            country: true,
            about_me: true,
            avatar_url: true,
            gender: true,
            languages: {
              select: {
                name: true,
              },
            },
            createdAt: true,
          },
        },
        hireRequest: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            availability: true,
            contract_length: true,
            expected_start_date: true,
            salary_range_from: true,
            salary_range_to: true,
            specialization: true,
            location: true,
          },
        },
        bonus: {
          where: { deleted_at: null },
          select: {
            id: true,
            amount: true,
            description: true,
            created_at: true,
            created_by: true,
          },
          orderBy: { created_at: 'asc' },
        },
      },
    });
    if (!staff) return null;
    return {
      ...staff,
      candidate: staff.candidate
        ? {
            ...staff.candidate,
            vaid: staff.candidate.hubspot_vaid,
            avatar: staff.candidate.avatar_url
              ? `${process.env.AVATAR_URL}${staff.candidate.avatar_url}`
              : null,
          }
        : null,
    };
  }

  async create(createStaffDto: CreateStaffDto, user: USER) {
    try {
      const statusHandled = staffStatusDictionary[createStaffDto.status];
      const staff = await this.prisma.staff.create({
        data: {
          candidate_id: createStaffDto.candidate_id,
          hirerequest_id: createStaffDto.hirerequest_id,
          status: statusHandled,
          salary: createStaffDto.salary,
          start_date: createStaffDto.start_date,
          created_by: user.id,
        },
      });

      return await this.findOne(staff.id);
    } catch (error) {
      throw new BadRequestException('Failed to create staff', error);
    }
  }

  async addBonus(data: CreateBonusDto, user: USER): Promise<any> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: data.staff_id },
      select: {
        id: true,
        candidate_id: true,
        status: true,
        hubspot_deal_name: true,
        candidate: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            name: true,
          },
        },
      },
    });
    if (!staff) throw new NotFoundException('Staff member not found');
    if (staff.status !== 'active')
      throw new BadRequestException(
        'Cannot add bonus to inactive staff member',
      );
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException('User not found');

    let assignedValidated;

    if (user.role.includes('organization')) {
      //get the concierge client as assigned user
      const org = await this.prisma.organization.findUnique({
        where: { id: user.organization_id || undefined },
        select: { admin_id: true },
      });
      if (!org) throw new BadRequestException('Organization not found');
      assignedValidated = org.admin_id;
    } else {
      assignedValidated = undefined;
    }

    // Validate that the user creating the ticket exists
    const creatorUser = await this.prisma.uSER.findUnique({
      where: { id: user.id },
    });
    if (!creatorUser) {
      throw new BadRequestException(
        `User with ID ${user.id} not found. Cannot create ticket.`,
      );
    }

    // Validate that the assigned user exists (if provided)
    if (assignedValidated) {
      const assignedUser = await this.prisma.uSER.findUnique({
        where: { id: assignedValidated },
      });
      if (!assignedUser) {
        throw new BadRequestException(
          `Assigned user with ID ${assignedValidated} not found.`,
        );
      }
    }

    const [bonus, ticket] = await this.prisma.$transaction([
      this.prisma.bonus.create({
        data: {
          staff_id: data.staff_id,
          amount: data.bonus,
          description: data.description,
          created_by: user.id,
        },
      }),
      this.prisma.ticket.create({
        data: {
          organization: { connect: { id: user.organization_id || undefined } },
          type: 'bonus',
          staff: { connect: { id: data.staff_id } },
          title: `Bonus Added: $${data.bonus} to ${staff.hubspot_deal_name ? staff.hubspot_deal_name : staff?.candidate?.first_name + ` ` + staff?.candidate?.last_name}`,
          description: data.description,
          priority: 'medium',
          createdBy: { connect: { id: user.id } },
          user: assignedValidated
            ? { connect: { id: assignedValidated } }
            : undefined,
        },
      }),
    ]);

    void this.ticketAudit.log({
      ticketId: ticket.id,
      actorUserId: user.id,
      actorLabel: buildActorLabel(user),
      event: TICKET_AUDIT_EVENTS.CREATED,
      newStatus: ticket.status,
      after: {
        status: ticket.status,
        type: ticket.type,
        priority: ticket.priority,
        org_id: ticket.org_id,
        user_id: ticket.user_id,
        staff_id: ticket.staff_id,
        title: ticket.title,
      },
      metadata: {
        origin: TICKET_AUDIT_ORIGINS.STAFF_BONUS,
        actorRole: user.role ?? null,
        actorOrganizationId: user.organization_id ?? null,
        bonusId: bonus.id,
        bonusAmount: data.bonus,
        assignedAtCreation: ticket.user_id ?? null,
      },
    });

    return await this.findOne(data.staff_id);
  }

  async requestTermination(data: terminateDto, user: USER): Promise<any> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: data.staff_id },
      select: {
        id: true,
        candidate_id: true,
        status: true,
        hubspot_deal_name: true,
        candidate: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            name: true,
          },
        },
      },
    });
    if (!staff) throw new NotFoundException('Staff member not found');
    if (!user || (user.role.includes('organization') && !user.organization_id))
      throw new NotFoundException('User not found');

    let assignedValidated;

    if (user.role.includes('organization')) {
      //get the concierge client as assigned user
      const org = await this.prisma.organization.findUnique({
        where: { id: user.organization_id || undefined },
        select: { admin_id: true },
      });
      if (!org) throw new BadRequestException('Organization not found');
      assignedValidated = org.admin_id;
    } else {
      assignedValidated = undefined;
    }

    // Validate that the user creating the ticket exists
    const creatorUser = await this.prisma.uSER.findUnique({
      where: { id: user.id },
    });
    if (!creatorUser) {
      throw new BadRequestException(
        `User with ID ${user.id} not found. Cannot create ticket.`,
      );
    }

    // Validate that the assigned user exists (if provided)
    if (assignedValidated) {
      const assignedUser = await this.prisma.uSER.findUnique({
        where: { id: assignedValidated },
      });
      if (!assignedUser) {
        throw new BadRequestException(
          `Assigned user with ID ${assignedValidated} not found.`,
        );
      }
    }

    const [staffStatus, ticket] = await this.prisma.$transaction([
      this.prisma.staff.update({
        where: { id: staff.id },
        data: { status: 'termination-requested' },
      }),
      this.prisma.ticket.create({
        data: {
          organization: { connect: { id: user.organization_id || undefined } },
          staff: { connect: { id: staff.id } },
          type: 'termination',
          title: `Termination Requested: ${staff.hubspot_deal_name ? staff.hubspot_deal_name : staff?.candidate?.first_name + ` ` + staff?.candidate?.last_name}`,
          description: data.description,
          priority: 'high',
          createdBy: { connect: { id: user.id } },
          user: assignedValidated
            ? { connect: { id: assignedValidated } }
            : undefined,
        },
      }),
    ]);

    void this.ticketAudit.log({
      ticketId: ticket.id,
      actorUserId: user.id,
      actorLabel: buildActorLabel(user),
      event: TICKET_AUDIT_EVENTS.CREATED,
      newStatus: ticket.status,
      after: {
        status: ticket.status,
        type: ticket.type,
        priority: ticket.priority,
        org_id: ticket.org_id,
        user_id: ticket.user_id,
        staff_id: ticket.staff_id,
        title: ticket.title,
      },
      metadata: {
        origin: TICKET_AUDIT_ORIGINS.STAFF_TERMINATION,
        actorRole: user.role ?? null,
        actorOrganizationId: user.organization_id ?? null,
        staffStatusAfter: staffStatus.status,
        assignedAtCreation: ticket.user_id ?? null,
      },
    });

    return await this.findOne(data.staff_id);
  }

  async searchStaff(query: {
    search?: string;
    status?: string;
    organization_id?: string;
    limit?: number;
  }): Promise<any> {
    const { search, status, organization_id, limit } = query;

    const where: any = {};

    //removed on 2026-04-16 by Paulo asked by Pauli because we need to retrieve all staffs on frontend and filter by status
    //where.hubspot_dealstage = {
    //    in: activePipelines.map(([key, _value]) => String(key))
    //};

    if (status) {
      where.status = status;
    }

    if (organization_id) {
      where.organization_id = organization_id;
    }

    if (search) {
      // Match each whitespace-separated token independently and AND them
      // together, so a complete full name ("Svetlana Petrova") matches a staff
      // whose first_name and last_name live in different columns. A single OR
      // per column would never match a full name, since no single column
      // contains "Svetlana Petrova" as a substring.
      const tokens = search.trim().split(/\s+/).filter(Boolean);

      where.AND = tokens.map((token) => ({
        OR: [
          { hubspot_deal_name: { contains: token, mode: 'insensitive' } },
          { hubspot_client_name: { contains: token, mode: 'insensitive' } },
          { hubspot_company_name: { contains: token, mode: 'insensitive' } },
          {
            candidate: { first_name: { contains: token, mode: 'insensitive' } },
          },
          {
            candidate: { last_name: { contains: token, mode: 'insensitive' } },
          },
          { candidate: { email: { contains: token, mode: 'insensitive' } } },
        ],
      }));
    }

    const queryOptions: any = {
      where,
      select: {
        id: true,
        hirerequest_id: true,
        status: true,
        salary: true,
        start_date: true,
        terminated_date: true,
        organization_id: true,
        created_at: true,
        updated_at: true,
        hubspot_id: true,
        hubspot_close_date: true,
        hubspot_deal_name: true,
        hubspot_dealstage: true,
        hubspot_dealtype: true,
        hubspot_deployment_type: true,
        hubspot_description: true,
        hubspot_hs_acv: true,
        hubspot_pipeline: true,
        hubspot_business_unit: true,
        hubspot_candidate_id: true,
        hubspot_client_name: true,
        hubspot_company_name: true,
        hubspot_organization_id: true,
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
        candidate: {
          select: {
            id: true,
            hubspot_vaid: true,
            first_name: true,
            last_name: true,
            name: true,
            email: true,
            specialization: true,
            employment_type: true,
            country: true,
            about_me: true,
            avatar_url: true,
            hubstaff_id: true,
            gender: true,
            languages: {
              select: {
                name: true,
              },
            },
            skills: {
              select: {
                skill_name: true,
              },
            },
            createdAt: true,
          },
        },
        hireRequest: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            availability: true,
            contract_length: true,
            expected_start_date: true,
            salary_range_from: true,
            salary_range_to: true,
            specialization: true,
            location: true,
          },
        },
        bonus: {
          where: { deleted_at: null },
          select: {
            id: true,
            amount: true,
            description: true,
            created_at: true,
            created_by: true,
          },
          orderBy: { created_at: 'asc' },
        },
      },
      orderBy: { created_at: 'desc' },
    };

    if (limit) {
      queryOptions.take = Number(limit);
    }

    const staff: any[] = await this.prisma.staff.findMany(queryOptions);

    return staff.map((s) => ({
      ...s,
      candidate: s.candidate
        ? {
            ...s.candidate,
            vaid: s.candidate.hubspot_vaid,
            avatar: s.candidate.avatar_url
              ? `${process.env.AVATAR_URL}${s.candidate.avatar_url}`
              : null,
          }
        : null,
    }));
  }

  async getStaffForTickets(user: USER): Promise<object> {
    const where: any = {
      hireRequest: {},
    };

    if (user.role.includes('organization')) {
      where.hireRequest.org_id = user.organization_id;
    }

    const staff = await this.prisma.staff.findMany({
      where,
      select: {
        id: true,
        status: true,
        candidate: {
          select: {
            id: true,
            hubspot_vaid: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        },
        hireRequest: {
          select: {
            title: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return staff.map((s) => ({
      ...s,
      candidate: s.candidate
        ? { ...s.candidate, vaid: s.candidate.hubspot_vaid }
        : null,
    }));
  }

  async findAll(
    user: USER,
    page: number,
    perPage: number,
    search: string,
    start_date_from: Date,
    start_date_to: Date,
  ): Promise<object> {
    page = page ? Number(page) : 1;
    perPage = perPage ? Number(perPage) : 10;

    const skip = (page - 1) * perPage;
    const take = perPage;

    const where: any = {
      status: { not: { in: ['terminated', 'inactive'] } },
      hireRequest: {},
      candidate: {},
    };

    const andConditions: any[] = [];

    if (user.role.includes('organization')) {
      andConditions.push({
        OR: [
          { hireRequest: { org_id: user.organization_id } },
          { organization_id: user.organization_id },
        ],
      });
    }

    if (search) {
      // AND each whitespace-separated token so a complete full name matches
      // across first_name/last_name columns (see searchStaff for rationale).
      const tokens = search.trim().split(/\s+/).filter(Boolean);

      for (const token of tokens) {
        andConditions.push({
          OR: [
            {
              hireRequest: { title: { contains: token, mode: 'insensitive' } },
            },
            {
              candidate: {
                first_name: { contains: token, mode: 'insensitive' },
              },
            },
            {
              candidate: {
                last_name: { contains: token, mode: 'insensitive' },
              },
            },
            { hubspot_deal_name: { contains: token, mode: 'insensitive' } },
          ],
        });
      }
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    if (start_date_from || start_date_to) {
      where.start_date = {};
      if (start_date_from) where.start_date.gte = new Date(start_date_from);
      if (start_date_to) where.start_date.lte = new Date(start_date_to);
    }

    const select = {
      id: true,
      hirerequest_id: true,
      status: true,
      salary: true,
      start_date: true,
      created_at: true,
      updated_at: true,
      hubspot_id: true,
      hubspot_close_date: true,
      hubspot_deal_name: true,
      hubspot_dealstage: true,
      hubspot_dealtype: true,
      hubspot_deployment_type: true,
      hubspot_description: true,
      hubspot_hs_acv: true,
      hubspot_pipeline: true,
      hubspot_business_unit: true,
      hubspot_candidate_id: true,
      hubspot_organization_id: true,
      candidate: {
        select: {
          id: true,
          hubspot_vaid: true,
          first_name: true,
          last_name: true,
          name: true,
          email: true,
          specialization: true,
          employment_type: true,
          country: true,
          about_me: true,
          avatar_url: true,
          gender: true,
          languages: {
            select: {
              name: true,
            },
          },
          skills: {
            select: {
              skill_name: true,
            },
          },
          createdAt: true,
        },
      },
      hireRequest: {
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          availability: true,
          contract_length: true,
          expected_start_date: true,
          salary_range_from: true,
          salary_range_to: true,
          specialization: true,
          location: true,
        },
      },
      bonus: {
        where: { deleted_at: null },
        select: {
          id: true,
          amount: true,
          description: true,
          created_at: true,
          created_by: true,
        },
      },
    };

    const [staff, total] = await this.prisma.$transaction([
      this.prisma.staff.findMany({
        where,
        skip,
        take,
        select,
      }),
      this.prisma.staff.count({ where }),
    ]);

    const hiredStaffWithAvatar = staff.map((staff) => ({
      ...staff,
      candidate: {
        ...staff.candidate,
        vaid: staff.candidate?.hubspot_vaid,
        avatar: staff.candidate?.avatar_url
          ? `${process.env.AVATAR_URL}${staff.candidate.avatar_url}`
          : null,
      },
    }));

    return {
      status: 200,
      data: hiredStaffWithAvatar,
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.ceil(Number(total) / perPage),
      },
    };
  }

  async findByOrganization(
    user: USER,
    organizationId: string,
    page: number,
    perPage: number,
    search: string,
    start_date_from: Date,
    start_date_to: Date,
  ): Promise<object> {
    //console.log('Organization ID in Service:', organizationId);
    page = page ? Number(page) : 1;
    perPage = perPage ? Number(perPage) : 10;

    const skip = (page - 1) * perPage;
    const take = perPage;

    const where: any = {
      status: { not: 'terminated' },
      hireRequest: {},
      candidate: {},
    };

    where.OR = [
      {
        hireRequest: {
          org_id: organizationId,
        },
      },
      {
        organization_id: organizationId,
      },
    ];

    if (search) {
      // AND each whitespace-separated token so a complete full name matches
      // across first_name/last_name columns (see searchStaff for rationale).
      const tokens = search.trim().split(/\s+/).filter(Boolean);

      where.AND = tokens.map((token) => ({
        OR: [
          {
            hireRequest: {
              title: { contains: token, mode: 'insensitive' },
            },
          },
          {
            candidate: {
              first_name: { contains: token, mode: 'insensitive' },
            },
          },
          {
            candidate: {
              last_name: { contains: token, mode: 'insensitive' },
            },
          },
        ],
      }));
    }

    if (start_date_from || start_date_to) {
      where.start_date = {};
      if (start_date_from) where.start_date.gte = new Date(start_date_from);
      if (start_date_to) where.start_date.lte = new Date(start_date_to);
    }

    const select = {
      id: true,
      hirerequest_id: true,
      status: true,
      salary: true,
      start_date: true,
      created_at: true,
      updated_at: true,
      hubspot_id: true,
      hubspot_close_date: true,
      hubspot_deal_name: true,
      hubspot_dealstage: true,
      hubspot_dealtype: true,
      hubspot_deployment_type: true,
      hubspot_description: true,
      hubspot_hs_acv: true,
      hubspot_pipeline: true,
      hubspot_business_unit: true,
      hubspot_candidate_id: true,
      hubspot_client_name: true,
      hubspot_organization_id: true,
      candidate: {
        select: {
          id: true,
          hubspot_vaid: true,
          first_name: true,
          last_name: true,
          name: true,
          email: true,
          specialization: true,
          employment_type: true,
          country: true,
          about_me: true,
          languages: {
            select: {
              name: true,
            },
          },
          skills: {
            select: {
              skill_name: true,
            },
          },
          createdAt: true,
        },
      },
      hireRequest: {
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          availability: true,
          contract_length: true,
          expected_start_date: true,
          salary_range_from: true,
          salary_range_to: true,
          specialization: true,
          location: true,
        },
      },
      bonus: {
        where: { deleted_at: null },
        select: {
          id: true,
          amount: true,
          description: true,
          created_at: true,
          created_by: true,
        },
      },
    };

    const [staff, total] = await this.prisma.$transaction([
      this.prisma.staff.findMany({
        where,
        skip,
        take,
        select,
      }),
      this.prisma.staff.count({ where }),
    ]);

    const staffWithCandidateVaid = staff.map((s) => ({
      ...s,
      candidate: s.candidate
        ? { ...s.candidate, vaid: s.candidate.hubspot_vaid }
        : null,
    }));

    return {
      status: 200,
      data: staffWithCandidateVaid,
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.ceil(Number(total) / perPage),
      },
    };
  }

  async updateStaff(
    staffId: string,
    updateData: any,
    user: USER,
  ): Promise<any> {
    try {
      // Verify staff exists
      const existingStaff = await this.prisma.staff.findUnique({
        where: { id: staffId },
        include: {
          candidate: true,
        },
      });

      if (!existingStaff) {
        throw new NotFoundException('Staff member not found');
      }

      // Extract staff-specific fields and candidate fields
      const { status } = updateData;

      // Update staff record
      const staffUpdateData: any = {};
      if (status !== undefined) {
        staffUpdateData.status = staffStatusDictionary[status] || status;
      }

      // Use transaction to update both staff and candidate records
      const result = await this.prisma.$transaction(async (tx) => {
        // Update staff record
        const updatedStaff = await tx.staff.update({
          where: { id: staffId },
          data: staffUpdateData,
        });

        // Return updated staff with all relations
        return await tx.staff.findUnique({
          where: { id: staffId },
          select: {
            id: true,
            hirerequest_id: true,
            status: true,
            salary: true,
            start_date: true,
            created_at: true,
            updated_at: true,
            hubspot_id: true,
            hubspot_close_date: true,
            hubspot_deal_name: true,
            hubspot_dealstage: true,
            hubspot_dealtype: true,
            hubspot_deployment_type: true,
            hubspot_description: true,
            hubspot_hs_acv: true,
            hubspot_pipeline: true,
            hubspot_business_unit: true,
            hubspot_candidate_id: true,
            hubspot_organization_id: true,
            candidate: {
              select: {
                id: true,
                hubspot_vaid: true,
                first_name: true,
                last_name: true,
                name: true,
                email: true,
                specialization: true,
                employment_type: true,
                country: true,
                about_me: true,
                years_of_experience: true,
                hourly_pay_rate: true,
                gender: true,
                medical_tools: true,
                tools: true,
                languages: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
                skills: {
                  select: {
                    id: true,
                    skill_name: true,
                    proficiency_level: true,
                    skill_type: true,
                  },
                },
                createdAt: true,
              },
            },
            hireRequest: {
              select: {
                id: true,
                title: true,
                description: true,
                status: true,
                priority: true,
                availability: true,
                contract_length: true,
                expected_start_date: true,
                salary_range_from: true,
                salary_range_to: true,
                specialization: true,
                location: true,
              },
            },
            bonus: {
              where: { deleted_at: null },
              select: {
                id: true,
                amount: true,
                description: true,
                created_at: true,
                created_by: true,
              },
            },
          },
        });
      });

      return {
        status: 200,
        message: 'Staff updated successfully',
        data: result
          ? {
              ...result,
              candidate: result.candidate
                ? { ...result.candidate, vaid: result.candidate.hubspot_vaid }
                : null,
            }
          : result,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Failed to update staff member');
    }
  }

  async populateDbFromHubspot(): Promise<any> {
    const BATCH_SIZE = 100;
    const ASSOCIATION_BATCH_SIZE = 100;
    let hasMore = true;
    let after: string | undefined = undefined;
    const allDeals: any[] = [];
    const properties = Object.keys(dealToDbDictionary);

    while (hasMore) {
      const body: any = {
        filterGroups: [
          {
            filters: [
              { propertyName: 'pipeline', operator: 'EQ', value: '85165570' }, // MV OPERATIONS PIPELINE
            ],
          },
        ],
        properties: properties,
        limit: BATCH_SIZE,
      };

      if (after) body.after = after;

      const result = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/deals/search',
        body,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );
      console.log(JSON.stringify(body, null, 2));

      allDeals.push(...result.data.results);
      if (result.data.paging?.next?.after) {
        after = result.data.paging.next.after;
      } else {
        hasMore = false;
      }
    }

    console.log(`Total deals fetched from HubSpot: ${allDeals.length}`);

    const mappedDeals = allDeals.map((deal) => {
      const mapped: any = { hubspot_id: deal.id };
      for (const [hubspotKey, dbKey] of Object.entries(dealToDbDictionary)) {
        let value = deal.properties[hubspotKey];

        if (value === '' || value === undefined) {
          value = null;
        }

        if (
          (dbKey === 'hubspot_close_date' && value) ||
          (dbKey === 'start_date' && value) ||
          (dbKey === 'hubspot_commission_start_date' && value)
        ) {
          const dateValue = new Date(value);
          value = isNaN(dateValue.getTime()) ? null : dateValue;
        }

        mapped[dbKey] = value;
      }
      return mapped;
    });

    const VADeals: any[] = [];
    const CompanyDeals: any[] = [];

    for (let i = 0; i < mappedDeals.length; i += ASSOCIATION_BATCH_SIZE) {
      const chunk = mappedDeals.slice(i, i + ASSOCIATION_BATCH_SIZE);
      const dealIds = chunk.map((d) => ({ id: d.hubspot_id }));

      try {
        const response = await axios.post(
          `https://api.hubapi.com/crm/v3/associations/deal/${process.env.HUBSPOT_CUSTOM_OBJECT}/batch/read`,
          { inputs: dealIds },
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const associations = response.data.results;

        // Mapping the results back to each deal
        for (const deal of chunk) {
          const assoc = associations.find(
            (a: any) => a.from?.id === deal.hubspot_id,
          );
          if (assoc?.to?.length > 0) {
            const hubspotCandidateId = assoc.to[0].id;

            let candidateExists = await this.prisma.candidate.findUnique({
              where: { hubspot_id: String(hubspotCandidateId) },
              select: { id: true },
            });

            if (candidateExists) {
              deal.candidate_id = candidateExists.id;
            } else {
              const event = {
                objectId: hubspotCandidateId,
              };
              await this.objectCreation.execute(event);
              candidateExists = await this.prisma.candidate.findUnique({
                where: { hubspot_id: String(hubspotCandidateId) },
                select: { id: true },
              });
              if (candidateExists) deal.candidate_id = candidateExists.id;
            }
            deal.hubspot_candidate_id = hubspotCandidateId;
          }
          deal.status = activePipelines.some(
            ([key]) => key === deal.hubspot_dealstage,
          )
            ? 'active'
            : 'inactive';
          VADeals.push(deal);
        }
      } catch (error: any) {
        console.error(
          'Error to find batch process :',
          error.response?.data || error,
        );
      }
    }
    console.log('Deals with candidates Associated: ', VADeals);

    for (let i = 0; i < VADeals.length; i += ASSOCIATION_BATCH_SIZE) {
      const chunk = VADeals.slice(i, i + ASSOCIATION_BATCH_SIZE);
      const dealIds = chunk.map((d) => ({ id: d.hubspot_id }));

      try {
        const response = await axios.post(
          `https://api.hubapi.com/crm/v3/associations/deal/company/batch/read`,
          { inputs: dealIds },
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const associations = response.data.results;

        // Mapping the results back to each deal
        for (const deal of chunk) {
          const assoc = associations.find(
            (a: any) => a.from?.id === deal.hubspot_id,
          );
          if (assoc?.to?.length > 0) {
            const hubspotCandidateId = assoc.to[0].id;

            const organizationExists =
              await this.prisma.organization.findUnique({
                where: { hubspot_id: String(hubspotCandidateId) },
                select: { id: true },
              });

            if (organizationExists) {
              deal.organization_id = organizationExists.id;
            }
            deal.hubspot_organization_id = hubspotCandidateId;
          }

          CompanyDeals.push(deal);
        }
      } catch (error: any) {
        console.error(
          'Error to find batch process :',
          error.response?.data || error,
        );
      }
    }

    console.log(
      'Deals with companies and candidates Associated: ',
      CompanyDeals,
    );

    const CHUNK_SIZE = 500; // Adjust chunk size as needed
    for (let i = 0; i < CompanyDeals.length; i += CHUNK_SIZE) {
      const chunk = CompanyDeals.slice(i, i + CHUNK_SIZE);
      await this.prisma.staff.createMany({
        data: chunk,
        skipDuplicates: true,
      });
    }

    return `DB populated from HubSpot successfully with ${CompanyDeals.length} deals`;
  }

  async syncOrganizationIds(): Promise<any> {
    const staffWithoutOrg = await this.prisma.staff.findMany({
      where: {
        hubspot_organization_id: { not: null },
        organization_id: null,
      },
      select: {
        id: true,
        hubspot_organization_id: true,
      },
    });

    if (staffWithoutOrg.length === 0) {
      return {
        updated: 0,
        skipped: 0,
        errors: [],
        message: 'No staff records to sync',
      };
    }

    let updated = 0;
    let skipped = 0;
    const errors: { staffId: string; hubspotOrgId: string; reason: string }[] =
      [];

    for (const staff of staffWithoutOrg) {
      const hubspotOrgId = staff.hubspot_organization_id as string;

      // Try to find existing org first
      let organization = await this.prisma.organization.findUnique({
        where: { hubspot_id: hubspotOrgId },
        select: { id: true },
      });

      // If not found, try to create it from HubSpot
      if (!organization) {
        try {
          await this.organizationCreation.execute({ objectId: hubspotOrgId });
          organization = await this.prisma.organization.findUnique({
            where: { hubspot_id: hubspotOrgId },
            select: { id: true },
          });
        } catch (err) {
          errors.push({ staffId: staff.id, hubspotOrgId, reason: err.message });
          continue;
        }
      }

      if (organization) {
        await this.prisma.staff.update({
          where: { id: staff.id },
          data: { organization_id: organization.id },
        });
        updated++;
      } else {
        skipped++;
      }
    }

    return {
      updated,
      skipped,
      errors,
      message: `Synced ${updated} staff records. ${skipped} skipped. ${errors.length} error(s).`,
    };
  }

  async moveStaffBackToActive(staffId: string): Promise<any> {
    if (!staffId) {
      throw new BadRequestException('Staff ID is required');
    }
    const staff = await this.prisma.staff.findUnique({
      where: {
        id: staffId,
        status: 'termination-requested',
      },
      select: {
        id: true,
      },
    });

    if (!staff) {
      throw new NotFoundException(
        'Staff member not found or not in termination-requested status',
      );
    }

    const updatedStaff = await this.prisma.staff.update({
      where: { id: staffId },
      data: { status: 'active' },
    });
    if (!updatedStaff) {
      throw new BadRequestException(
        'Failed to move staff member back to active',
      );
    }

    return this.findOne(staffId);
  }
}
