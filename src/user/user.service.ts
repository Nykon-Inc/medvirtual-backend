import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  OrganizationStatus,
  Prisma,
  USER,
  UserAuditSource,
} from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { UpdateProfileDto } from './dto/updateProfile.dto';
import { GetProfileDto } from './dto/getProfile.dto';
import { SearchUsersDto } from './dto/searchUsers.dto';
import { ACTIVE_PIPELINE_STAFF_WHERE } from '../common/constant/activeDealPipelines';
import { buildInclusiveDateRange } from '../common/utils/date-range.util';
import InviteSignup from '../common/utils/email-templates/invite-signup';
import { getUserEmailTheme } from '../common/utils/email-templates/theme-helper';
import { InviteUserToOrganizationDto } from './dto/inviteUserToOrganization.dto';
import { organizationIndustryToDbDictionary } from '../common/dictionaries/organizationIndustry-dictionary';
import { HubspotService } from '../hubspot/hubspot.service';
import {
  USER_AUDIT_EVENTS,
  UserAuditService,
  auditActor,
  snapshotUser,
} from '../user-audit/user-audit.service';
import { admin } from 'googleapis/build/src/apis/admin';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly hubspotService: HubspotService,
    private readonly userAudit: UserAuditService,
  ) {}

  async create(userData: Prisma.USERUncheckedCreateInput): Promise<USER> {
    const { password, ...rest } = userData;
    const hash = await bcrypt.hash(password, 10);

    const newUserData = {
      ...rest,
      email: rest.email.toLowerCase().trim(),
      password: hash,
      // Set default creation tracking if not provided
      createdByMethod: rest.createdByMethod || 'self_signup',
      createdByUserId: rest.createdByUserId || null,
    };

    const newUser = await this.prisma.uSER.create({
      data: newUserData,
    });
    return newUser;
  }

  async findByEmail(
    email: string,
  ): Promise<(USER & { affiliateProfile: { id: string } | null }) | null> {
    return this.prisma.uSER.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: { affiliateProfile: { select: { id: true } } },
    });
  }

  async findById(id: string): Promise<USER | null> {
    const user = await this.prisma.uSER.findUnique({
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`User not found`);
    }
    return user;
  }

  async findByOrganizationId(organizationId: string): Promise<any> {
    const users = await this.prisma.uSER.findMany({
      where: { organization_id: organizationId },
      select: {
        id: true,
        email: true,
        organization_id: true,
        organization_name: true,
        first_name: true,
        last_name: true,
        phone: true,
        avatar: true,
        job_title: true,
        role: true,
        workos_id: true,
        authentication_method: true,
        status: true,
        verified: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!users || users.length === 0) {
      throw new NotFoundException(`No users found in this organization.`);
    }

    return users;
  }

  async findUsersByOrganizationByCurrentUser(
    user: USER,
    status?: string,
  ): Promise<any> {
    let whereClause: any = {};

    // If user is system_admin, only return users from organizations they admin
    if (user.role === 'system_admin') {
      // Find organizations where this user is the admin
      const adminOrganizations = await this.prisma.organization.findMany({
        where: { admin_id: user.id },
        select: { id: true },
      });

      const organizationIds = adminOrganizations.map((org) => org.id);

      if (organizationIds.length === 0) {
        throw new NotFoundException(
          `No organizations found where you are the admin.`,
        );
      }

      whereClause = { organization_id: { in: organizationIds } };
    } else if (user.role === 'system_super_admin') {
      // system_super_admin can see all users from all organizations | here I need to retrieve just users without organization it means 'system super admins'
      whereClause = { organization_id: null };
    } else {
      // Fallback to original behavior for other roles
      whereClause = { organization_id: user.organization_id };
    }

    // Add status filter if provided
    if (status) {
      whereClause.status = status;
    }

    const users = await this.prisma.uSER.findMany({
      where: whereClause,
      select: {
        id: true,
        email: true,
        organization_id: true,
        organization_name: true,
        first_name: true,
        last_name: true,
        job_title: true,
        role: true,
        status: true,
        createdAt: true,
      },
      orderBy: {
        first_name: 'asc',
      },
    });

    if (!users || users.length === 0) {
      throw new NotFoundException(
        `No users found in the accessible organizations.`,
      );
    }

    return users;
  }

  async getAllSystemUsers(
    search?: string,
    page?: number,
    perPage?: number,
    status?: string,
  ): Promise<any> {
    page = page ? Number(page) : 1;
    perPage = perPage ? Number(perPage) : 10;
    const skip = (page - 1) * perPage;
    const take = perPage;

    const whereClause: any = {
      role: { in: ['system_admin', 'system_super_admin'] },
    };

    // Status is a literal column on USER ('active' | 'inactive' | 'invited'),
    // the same value the list already returns and the frontend displays.
    // Filtering here (shared by findMany and count) keeps meta.total accurate.
    if (status) {
      whereClause.status = status;
    }

    // Add search filter if provided
    if (search) {
      // Match each whitespace-separated token independently and AND them
      // together, so a complete full name ("First Last") matches a user
      // whose first_name and last_name live in different columns. A single OR
      // per column would never match a full name, since no single column
      // contains "First Last" as a substring.
      const tokens = search.trim().split(/\s+/).filter(Boolean);

      whereClause.AND = tokens.map((token) => ({
        OR: [
          { first_name: { contains: token, mode: 'insensitive' } },
          { last_name: { contains: token, mode: 'insensitive' } },
          { email: { contains: token, mode: 'insensitive' } },
          { job_title: { contains: token, mode: 'insensitive' } },
        ],
      }));
    }

    const [users, total] = await this.prisma.$transaction([
      this.prisma.uSER.findMany({
        where: whereClause,
        skip,
        take,
        select: {
          id: true,
          email: true,
          first_name: true,
          last_name: true,
          job_title: true,
          role: true,
          status: true,
          createdAt: true,
          sessions: {
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              id: true,
              createdAt: true,
            },
          },
        },
        orderBy: {
          first_name: 'asc',
        },
      }),
      this.prisma.uSER.count({
        where: whereClause,
      }),
    ]);

    if (!users || users.length === 0) {
      throw new NotFoundException(`No system users found.`);
    }

    return {
      status: 200,
      data: users,
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.ceil(Number(total) / perPage),
      },
    };
  }

  async getProfileById(id: string): Promise<GetProfileDto> {
    const user = await this.prisma.uSER.findUnique({
      where: { id },
      include: {
        organization: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User not found`);
    }

    // Transform to GetProfileDto format
    const profileResponse: GetProfileDto = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      phone: user.phone,
      avatar: user.avatar,
      job_title: user.job_title,
      role: user.role,
      status: user.status,
      verified: user.verified,
      onboarding_tour_dismissed: user.onboarding_tour_dismissed,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      organization: user.organization
        ? {
            id: user.organization.id,
            name: user.organization.name,
            email: user.organization.email || undefined,
            phone: user.organization.phone || undefined,
            website_url: user.organization.website_url || undefined,
            location: user.organization.location || undefined,
            status: user.organization.status,
            organization_role: user.organization.organization_role,
            specialties: user.organization.specialties || undefined,
            services: user.organization.services || undefined,
            description: user.organization.description || undefined,
            industry: user.organization.industry
              ? organizationIndustryToDbDictionary[
                  user.organization.industry
                ] || user.organization.industry
              : undefined,
            number_of_employees:
              user.organization.number_of_employees || undefined,
            createdAt: user.organization.createdAt,
            updatedAt: user.organization.updatedAt,
          }
        : undefined,
    };

    return profileResponse;
  }

  async getCurrentUserProfile(userId: string): Promise<GetProfileDto> {
    return this.getProfileById(userId);
  }

  async updateProfile(
    id: string,
    profileData: UpdateProfileDto,
  ): Promise<GetProfileDto> {
    try {
      const currentUser = await this.findById(id);
      if (!currentUser) {
        throw new NotFoundException(`User not found`);
      }

      // Separate user fields from organization fields
      const {
        organization_name,
        organization_description,
        organization_website_url,
        organization_industry,
        organization_number_of_employees,
        organization_location,
        organization_date_founded,
        organization_specialties,
        organization_role,
        signed_document_url,
        ...userFields
      } = profileData;

      // Filter out undefined values from user fields to avoid Prisma errors
      const filteredUserFields = Object.fromEntries(
        Object.entries(userFields).filter(([, value]) => value !== undefined),
      );

      // Handle organization updates if organization fields are provided
      const organizationFields = {
        organization_name,
        organization_description,
        organization_website_url,
        organization_industry,
        organization_number_of_employees,
        organization_location,
        organization_date_founded,
        organization_specialties,
        organization_role,
        signed_document_url,
      };

      // Check if any organization fields are provided (including null/empty values for clearing)
      const hasOrganizationFields = Object.values(organizationFields).some(
        (value) => value !== undefined,
      );

      if (hasOrganizationFields && currentUser.organization_id) {
        // Prepare organization update data
        const organizationUpdateData: Prisma.OrganizationUpdateInput = {};

        if (organization_name !== undefined) {
          if (organization_name.trim() !== '') {
            organizationUpdateData.name = organization_name;
          }
        }
        if (organization_description !== undefined) {
          organizationUpdateData.description = organization_description || null;
        }
        if (organization_website_url !== undefined) {
          organizationUpdateData.website_url = organization_website_url || null;
        }
        if (organization_industry !== undefined) {
          organizationUpdateData.industry = organization_industry || null;
        }
        if (organization_number_of_employees !== undefined) {
          if (
            organization_number_of_employees === null ||
            organization_number_of_employees === 0
          ) {
            organizationUpdateData.number_of_employees = null;
          } else {
            // Ensure it's a valid integer
            const numEmployees = parseInt(
              organization_number_of_employees.toString(),
              10,
            );
            if (isNaN(numEmployees) || numEmployees < 1) {
              throw new BadRequestException(
                'Number of employees must be a valid positive integer',
              );
            }
            organizationUpdateData.number_of_employees = numEmployees;
          }
        }
        if (organization_location !== undefined) {
          organizationUpdateData.location = organization_location || null;
        }
        if (organization_date_founded !== undefined) {
          if (
            organization_date_founded === null ||
            organization_date_founded === ''
          ) {
            organizationUpdateData.date_founded = null;
          } else {
            organizationUpdateData.date_founded = new Date(
              organization_date_founded,
            );
          }
        }
        if (organization_specialties !== undefined) {
          if (
            organization_specialties === null ||
            organization_specialties === ''
          ) {
            organizationUpdateData.specialties = { set: [] };
          } else {
            // Convert comma-separated string to array
            const specialtiesArray = organization_specialties
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            organizationUpdateData.specialties = { set: specialtiesArray };
          }
        }
        if (organization_role !== undefined) {
          organizationUpdateData.organization_role = organization_role;
        }
        if (signed_document_url !== undefined) {
          organizationUpdateData.signed_document_url =
            signed_document_url || null;
        }

        // Update organization
        await this.prisma.organization.update({
          where: { id: currentUser.organization_id },
          data: organizationUpdateData,
        });
      }

      // Update user fields
      const updatedUser = await this.prisma.uSER.update({
        where: { id },
        data: filteredUserFields,
        include: {
          organization: true,
        },
      });

      await this.userAudit.logUpdate({
        before: currentUser,
        after: updatedUser,
        source: UserAuditSource.user,
        ...auditActor(currentUser),
        metadata: { origin: 'profile_self_update' },
      });

      // Transform to GetProfileDto format
      const profileResponse: GetProfileDto = {
        id: updatedUser.id,
        email: updatedUser.email,
        first_name: updatedUser.first_name,
        last_name: updatedUser.last_name,
        phone: updatedUser.phone,
        avatar: updatedUser.avatar,
        job_title: updatedUser.job_title,
        role: updatedUser.role,
        status: updatedUser.status,
        verified: updatedUser.verified,
        onboarding_tour_dismissed: updatedUser.onboarding_tour_dismissed,
        createdAt: updatedUser.createdAt,
        updatedAt: updatedUser.updatedAt,
        organization: updatedUser.organization
          ? {
              id: updatedUser.organization.id,
              name: updatedUser.organization.name,
              email: updatedUser.organization.email || undefined,
              phone: updatedUser.organization.phone || undefined,
              website_url: updatedUser.organization.website_url || undefined,
              location: updatedUser.organization.location || undefined,
              status: updatedUser.organization.status,
              organization_role: updatedUser.organization.organization_role,
              specialties: updatedUser.organization.specialties || undefined,
              services: updatedUser.organization.services || undefined,
              description: updatedUser.organization.description || undefined,
              industry: updatedUser.organization.industry
                ? organizationIndustryToDbDictionary[
                    updatedUser.organization.industry
                  ] || updatedUser.organization.industry
                : undefined,
              number_of_employees:
                updatedUser.organization.number_of_employees || undefined,
              createdAt: updatedUser.organization.createdAt,
              updatedAt: updatedUser.organization.updatedAt,
            }
          : undefined,
      };

      return profileResponse;
    } catch (error) {
      throw new BadRequestException(`Failed to update profile: ${error}`);
    }
  }

  async update(
    id: string,
    userData: Prisma.USERUpdateInput,
    actorUserId?: string,
  ): Promise<USER> {
    try {
      let user: Prisma.USERUpdateInput;
      const currentUser = await this.prisma.uSER.findUnique({
        where: { id },
        include: { contact: true },
      });
      if (!currentUser) {
        throw new NotFoundException(`User not found`);
      }

      if (userData.status === 'active' && currentUser.verified === false) {
        throw new BadRequestException(
          'Cannot activate a user who has not completed email verification.',
        );
      }

      //verify user to update status
      if (
        userData.job_title &&
        userData.organization_name &&
        currentUser.status === 'incomplete'
      ) {
        user = { ...userData, status: 'active' };
      } else {
        user = { ...userData };
      }

      const hubspotContactId = currentUser.contact?.hubspot_id ?? null;
      if (hubspotContactId) {
        const userForHubspot = {
          ...user,
          hubspot_contact_id: hubspotContactId,
        };
        await this.hubspotService.updateContactInHubspot(
          userForHubspot,
          actorUserId,
          `User profile updated — contact record synced to HubSpot`,
        );
      }

      const updated = await this.prisma.uSER.update({
        where: { id },
        data: user,
      });

      await this.userAudit.logUpdate({
        before: currentUser,
        after: updated,
        source:
          actorUserId && actorUserId === id
            ? UserAuditSource.user
            : UserAuditSource.admin,
        actorUserId: actorUserId ?? null,
        metadata: { origin: 'user_update' },
      });

      return updated;
    } catch (error) {
      throw new BadRequestException(`Failed to update user: ${error}`);
    }
  }

  async delete(id: string, actorUserId?: string): Promise<USER> {
    try {
      const user = await this.findById(id);
      if (!user) {
        throw new NotFoundException(`User not found`);
      }

      // Additional safety check: Prevent deletion of kind admins
      if (
        (user.role === 'system_super_admin' && user.status !== 'invited') ||
        (user.role === 'organization_super_admin' && user.status !== 'invited')
      ) {
        throw new BadRequestException(
          'Cannot delete Admin users for security reasons',
        );
      }

      // Check if user is the only owner of any organization
      const ownedOrganizations = await this.prisma.organization.findMany({
        where: { owner_id: id },
      });

      if (ownedOrganizations.length > 0) {
        // Check if there are other users in the organization who could become owners
        for (const org of ownedOrganizations) {
          const otherUsers = await this.prisma.uSER.findMany({
            where: {
              organization_id: org.id,
              id: { not: id },
              role: { in: ['organization_admin', 'organization_super_admin'] },
            },
          });

          if (otherUsers.length === 0) {
            throw new BadRequestException(
              `Cannot delete user. User is the only admin/owner of organization: ${org.name}. Please assign another admin first.`,
            );
          }
        }
      }

      //delete contact in hubspot
      const userForHubspot = {
        ...user,
        hubspot_contact_id: user.hubspot_contact_id,
      };
      await this.hubspotService.deleteContactInHubspot(
        userForHubspot,
        actorUserId,
        `User account deleted — contact record removed from HubSpot`,
      );

      // Use a transaction to handle all deletions atomically
      return await this.prisma.$transaction(async (tx) => {
        // 1. Delete sessions (has RESTRICT constraint)
        await tx.session.deleteMany({
          where: { userId: id },
        });

        // 2. Delete email verifications (has RESTRICT constraint)
        await tx.emailVerification.deleteMany({
          where: { userId: id },
        });

        // 3. Delete email invitations (has RESTRICT constraint)
        await tx.emailInvitation.deleteMany({
          where: { userId: id },
        });

        // 4. Delete ticket notes created by this user (has RESTRICT constraint)
        // Intentionally NOT filtered by deleted_at: the RESTRICT constraint requires every
        // note to go, soft-deleted ones included, or the user delete fails.
        await tx.ticketNotes.deleteMany({
          where: { author_id: id },
        });

        // 5. Handle organization relationships (has RESTRICT constraints)
        // Update organizations where this user is admin_id
        await tx.organization.updateMany({
          where: { admin_id: id },
          data: { admin_id: null },
        });

        // Update organizations where this user is owner_id
        await tx.organization.updateMany({
          where: { owner_id: id },
          data: { owner_id: null },
        });

        // 6. Update hire requests where this user is assigned (has SET NULL constraint)
        await tx.hireRequest.updateMany({
          where: { assign_user_id: id },
          data: { assign_user_id: null },
        });

        // 7. Update tickets where this user is the user (has SET NULL constraint)
        // Intentionally NOT filtered by deleted_at: soft-deleted tickets still hold an FK to
        // this user, so skipping them would leave a dangling reference and block the delete.
        await tx.ticket.updateMany({
          where: { user_id: id },
          data: { user_id: null },
        });

        // 8. Reset affiliate profile status if this user was a connected/invited affiliate.
        // Contact.user_id is now SET NULL on delete, so the Contact record survives —
        // only the profile's status needs recomputing since it no longer has a user.
        // updateMany (not update) is a no-op when no profile matches, matching the
        // best-effort pattern used above for organizations/hire requests/tickets.
        await tx.affiliateProfile.updateMany({
          where: { user_id: id },
          data: { status: 'pending' },
        });

        // 9. Tombstone — commits atomically with the delete, so a user can never vanish
        // without a trace (a failed audit write rolls the whole delete back).
        await this.userAudit.logOrThrow(
          {
            subject: user,
            event: USER_AUDIT_EVENTS.DELETED,
            source: UserAuditSource.admin,
            actorUserId: actorUserId ?? null,
            oldStatus: user.status,
            before: snapshotUser(user),
            metadata: {
              origin: 'user_delete',
              owned_organization_ids: ownedOrganizations.map((o) => o.id),
            },
          },
          tx,
        );

        // 10. Finally, delete the user
        return await tx.uSER.delete({
          where: { id },
        });
      });
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(`Failed to delete user: ${error}`);
    }
  }

  async updateStatus(id: string, actorUserId?: string): Promise<USER> {
    try {
      const currentUser = await this.findById(id);
      if (!currentUser) throw new NotFoundException(`User not found`);
      if (currentUser.status !== 'prospect')
        new BadRequestException(`User status is not prospect`);

      const updated = await this.prisma.uSER.update({
        where: { id },
        data: {
          status: 'client',
        },
      });

      await this.userAudit.logUpdate({
        before: currentUser,
        after: updated,
        source: UserAuditSource.admin,
        actorUserId: actorUserId ?? null,
        metadata: { origin: 'user_update_status' },
      });

      return updated;
    } catch (error) {
      throw new BadRequestException(`Failed to update user status: ${error}`);
    }
  }

  async searchOrganizationUsers(
    query: Omit<SearchUsersDto, 'role'>,
  ): Promise<any[]> {
    const {
      search,
      status,
      organization_id,
      limit,
      staff_status,
      dateFrom,
      dateTo,
    } = query;

    const whereClause: Prisma.USERWhereInput = {
      role: { in: ['organization_admin', 'organization_super_admin'] },
    };

    if (search) {
      // Match each whitespace-separated token independently and AND them
      // together, so a complete full name ("First Last") matches a user
      // whose first_name and last_name live in different columns. A single OR
      // per column would never match a full name, since no single column
      // contains "First Last" as a substring.
      const tokens = search.trim().split(/\s+/).filter(Boolean);

      whereClause.AND = tokens.map((token) => ({
        OR: [
          { first_name: { contains: token, mode: 'insensitive' } },
          { last_name: { contains: token, mode: 'insensitive' } },
          { email: { contains: token, mode: 'insensitive' } },
          { job_title: { contains: token, mode: 'insensitive' } },
        ],
      }));
    }

    if (status) {
      whereClause.status = status;
    }

    if (organization_id) {
      whereClause.organization_id = organization_id;
    }

    // Same definitions as the operational dashboard (panel.service getPanelData)
    // so filtered counts match the "Clients (with Staff)" / "Prospects (no Staff)"
    // and "Users Created" cards.
    if (staff_status === 'with_active_staff') {
      whereClause.organization = {
        staff: { some: ACTIVE_PIPELINE_STAFF_WHERE },
      };
    } else if (staff_status === 'without_active_staff') {
      whereClause.organization = {
        staff: { none: ACTIVE_PIPELINE_STAFF_WHERE },
      };
    }

    const createdAtRange = buildInclusiveDateRange(dateFrom, dateTo);
    if (createdAtRange) {
      whereClause.createdAt = createdAtRange;
    }

    const queryOptions: Prisma.USERFindManyArgs = {
      where: whereClause,
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        job_title: true,
        role: true,
        status: true,
        avatar: true,
        phone: true,
        verified: true,
        createdAt: true,
        updatedAt: true,
        organization: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
        affiliateProfile: {
          select: {
            id: true,
            hubspot_id: true,
            full_name: true,
            status: true,
            commission_percent_default: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    };

    if (limit) {
      queryOptions.take = limit;
    }

    const users = await this.prisma.uSER.findMany(queryOptions);

    return users.map((user) => ({
      ...user,
      full_name: `${user.first_name} ${user.last_name}`.trim(),
    }));
  }

  async searchUsers(query: SearchUsersDto): Promise<any[]> {
    const { search, role, status, organization_id, limit } = query;

    const whereClause: Prisma.USERWhereInput = {};

    // Add search filter
    if (search) {
      whereClause.OR = [
        {
          first_name: {
            contains: search,
            mode: 'insensitive',
          },
        },
        {
          last_name: {
            contains: search,
            mode: 'insensitive',
          },
        },
        {
          email: {
            contains: search,
            mode: 'insensitive',
          },
        },
        {
          job_title: {
            contains: search,
            mode: 'insensitive',
          },
        },
      ];
    }

    // Add role filter
    if (role) {
      whereClause.role = role;
    }

    // Add status filter
    if (status) {
      whereClause.status = status;
    }

    // Add organization filter
    if (organization_id) {
      whereClause.organization_id = organization_id;
    }

    const queryOptions: Prisma.USERFindManyArgs = {
      where: whereClause,
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        job_title: true,
        role: true,
        status: true,
        organization_name: true,
        organization_id: true,
        avatar: true,
        phone: true,
        verified: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    };

    // Only add pagination if limit is provided
    if (limit) {
      queryOptions.take = limit;
    }

    const users = await this.prisma.uSER.findMany(queryOptions);

    // Transform users to handle empty avatars
    return users.map((user) => ({
      ...user,
      avatar:
        user.avatar ||
        this.generateDefaultAvatar(user.first_name, user.last_name),
      full_name: `${user.first_name} ${user.last_name}`.trim(),
    }));
  }

  private generateDefaultAvatar(firstName: string, lastName: string): string {
    // Generate initials for default avatar
    const initials =
      `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
    // Return a data URL for a simple colored circle with initials
    // This is a simple SVG-based avatar
    const svg = `
      <svg width="40" height="40" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="20" fill="#4F46E5"/>
        <text x="20" y="26" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="14" font-weight="bold">${initials}</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  async getOrganizationUsersPaginated(
    organizationId: string,
    query: any,
  ): Promise<any> {
    const {
      page = 1,
      limit = 10,
      search,
      role,
      status,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      date_created_from,
      date_created_to,
    } = query;

    const skip = (page - 1) * limit;

    // Build where clause
    const whereClause: any = {
      organization_id: organizationId,
    };

    // Add search filter
    if (search) {
      whereClause.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { job_title: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Add role filter
    if (role) {
      whereClause.role = role;
    }

    // Add status filter
    if (status) {
      whereClause.status = status;
    }

    // Add date filters
    if (date_created_from || date_created_to) {
      whereClause.createdAt = {};
      if (date_created_from) {
        whereClause.createdAt.gte = new Date(date_created_from);
      }
      if (date_created_to) {
        // Include the entire day by setting time to end of day
        const endDate = new Date(date_created_to);
        endDate.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = endDate;
      }
    }

    // Build orderBy clause
    const orderBy: any = {};
    orderBy[sortBy] = sortOrder;

    try {
      // Get total count
      const total = await this.prisma.uSER.count({
        where: whereClause,
      });

      // Get paginated users
      const users = await this.prisma.uSER.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          email: true,
          first_name: true,
          last_name: true,
          phone: true,
          avatar: true,
          job_title: true,
          role: true,
          status: true,
          verified: true,
          organization_id: true,
          organization_name: true,
          createdAt: true,
          updatedAt: true,
          affiliateProfile: {
            select: {
              id: true,
              hubspot_id: true,
              full_name: true,
              status: true,
              commission_percent_default: true,
              createdAt: true,
            },
          },
        },
      });

      // Transform users to include full_name and default avatar
      const transformedUsers = users.map((user) => ({
        ...user,
        full_name: `${user.first_name} ${user.last_name}`.trim(),
        avatar:
          user.avatar ||
          this.generateDefaultAvatar(user.first_name, user.last_name),
      }));

      const totalPages = Math.ceil(total / limit);

      return {
        users: transformedUsers,
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      };
    } catch (error) {
      throw new NotFoundException('Failed to fetch organization users');
    }
  }

  async inviteUserToOrganization(
    organizationId: string,
    inviteData: InviteUserToOrganizationDto,
    currentUser: USER,
    options?: {
      /**
       * The invitee already exists as a HubSpot contact (e.g. the offer-panel
       * "Add as user" flow resolved them by email). Link that contact instead of
       * creating one — creating would 409 on the duplicate email and leave the
       * user without a hubspot_contact_id.
       */
      existingHubspotContactId?: string;
    },
  ): Promise<string> {
    try {
      const normalizedEmail = inviteData.email.toLowerCase().trim();

      // Check if user already exists
      const existingUser = await this.prisma.uSER.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });

      if (existingUser) {
        throw new BadRequestException(
          existingUser.organization_id === organizationId
            ? 'A user with this email already exists in this organization'
            : 'This email is already used by another account',
        );
      }

      // Get organization details
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      if (organization.status === 'inactive') {
        throw new BadRequestException(
          'Cannot invite users to an inactive organization',
        );
      }

      // Create the user with invited status
      const newUser = await this.prisma.uSER.create({
        data: {
          email: normalizedEmail,
          first_name: inviteData.first_name || '',
          last_name: inviteData.last_name || '',
          phone: inviteData.phone || '',
          job_title: inviteData.job_title || '',
          organization_id: organizationId,
          organization_name: organization.name,
          role: inviteData.role || 'organization_admin',
          workos_id: '',
          password: '', // Will be set when user completes signup
          authentication_method: 'OwnSign',
          status: 'invited',
          verified: false,
          avatar: '',
          createdByMethod: 'admin_invite',
          createdByUserId: currentUser.id,
        },
      });

      await this.userAudit.log({
        subject: newUser,
        event: USER_AUDIT_EVENTS.INVITED,
        source: UserAuditSource.admin,
        ...auditActor(currentUser),
        after: { status: newUser.status, role: newUser.role },
        metadata: {
          origin: 'organization_invite',
          createdByMethod: 'admin_invite',
          contact_id: inviteData.contact_id ?? null,
        },
      });

      // Link contact to the new user if contact_id was provided
      if (inviteData.contact_id) {
        try {
          await this.prisma.contact.update({
            where: { id: inviteData.contact_id },
            data: { user_id: newUser.id },
          });
        } catch (err) {
          console.error('Failed to link contact to new user:', err);
        }
      }

      // Generate invitation token
      const code = jwt.sign({ id: newUser.id }, process.env.JWT_SECRET, {
        expiresIn: '48h',
      });

      // Get user email theme
      const emailTheme = await getUserEmailTheme(this.prisma, newUser.id);

      // Send signup link via email
      const baseInviteLink = `${process.env.FRONTEND_URL}/invite-signup?code=${code}`;
      const inviteLink =
        emailTheme?.companyName === 'Berry Virtual'
          ? `${baseInviteLink}&company=berry`
          : baseInviteLink;
      const emailBody = InviteSignup(inviteLink, emailTheme || undefined);
      const mailSent = await this.mailService.sendMail({
        from: `${emailTheme?.companyName || 'MedVirtual'} <noreply@medvirtual.ai>`,
        to: inviteData.email,
        subject: `Welcome to ${emailTheme?.companyName || 'MedVirtual'} - Complete Your Account Setup`,
        html: emailBody,
        headers: {
          'X-Mailer': `${emailTheme?.companyName || 'MedVirtual'} Platform`,
          'X-Priority': '3',
          'List-Unsubscribe': '<mailto:unsubscribe@medvirtual.ai>',
          'X-Entity-Ref-ID': `invite-${newUser.id}`,
        },
      });

      if (!mailSent) {
        throw new BadRequestException('Failed to send invitation email');
      }

      // Store the verification code in the database with an expiration time
      const codeExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours - same time as JWT
      const storeCode = await this.prisma.emailInvitation.create({
        data: {
          userId: newUser.id,
          email_from: inviteData.email,
          code: code,
          expiresAt: codeExpiresAt,
        },
      });
      if (!storeCode) {
        throw new BadRequestException('Failed to store invite code');
      }

      if (options?.existingHubspotContactId) {
        await this.linkExistingHubspotContact(
          newUser,
          options.existingHubspotContactId,
          currentUser,
        );
        return `Invitation sent successfully to ${inviteData.email}`;
      }

      //create contact in hubspot
      try {
        const newUserForHubspot = {
          ...newUser,
          organization: {
            hubspot_id: organization.hubspot_id || '',
            business_unit: organization.business_unit || '',
            name: organization.name,
            admin_id: organization.admin_id || null,
          },
        };

        await this.hubspotService.createContactInHubspot(
          newUserForHubspot,
          currentUser.id,
          `New user invited to organization — contact record created in HubSpot`,
        );
      } catch (err) {
        console.error('Error creating contact in Hubspot:', err);
      }

      return `Invitation sent successfully to ${inviteData.email}`;
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException('Failed to invite user to organization');
    }
  }

  /**
   * Stores an already-existing HubSpot contact id on a freshly invited user.
   * hubspot_contact_id is unique, so a contact already held by another user is
   * logged and skipped rather than failing the invite.
   */
  private async linkExistingHubspotContact(
    user: USER,
    hubspotContactId: string,
    currentUser: USER,
  ): Promise<void> {
    try {
      const holder = await this.prisma.uSER.findUnique({
        where: { hubspot_contact_id: hubspotContactId },
        select: { id: true },
      });
      if (holder && holder.id !== user.id) {
        console.warn(
          `HubSpot contact ${hubspotContactId} is already linked to user ${holder.id} — not linking to ${user.id}`,
        );
        return;
      }
      await this.prisma.uSER.update({
        where: { id: user.id },
        data: { hubspot_contact_id: hubspotContactId },
      });
      await this.userAudit.logUpdate({
        before: user,
        after: { hubspot_contact_id: hubspotContactId },
        source: UserAuditSource.admin,
        ...auditActor(currentUser),
        metadata: { origin: 'hubspot_contact_linked' },
      });
    } catch (err) {
      console.error('Failed to link existing HubSpot contact to user:', err);
    }
  }
}
