import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import axios from 'axios';

import { PrismaService } from '../prisma/prisma.service';
import {
  Prisma,
  Organization,
  USER,
  OrganizationRole,
  OrganizationStatus,
  HireRequestStatus,
} from '@prisma/client';
import { CreateOrganizationDto } from './dto/createOrganization.dto';
import { UpdateOrganizationDto } from './dto/updateOrganization.dto';
import { ConvertToClientDto } from './dto/convertToClient.dto';
import { UpdateInvoiceConfigurationDto } from './dto/updateInvoiceConfiguration.dto';
import { GetOrganizationsDto } from './dto/getOrganizations.dto';
import {
  PaginatedOrganizationsResponseDto,
  OrganizationResponseDto,
} from './dto/organizationResponse.dto';
import {
  GetOrganizationStaffDto,
  AdminCreateStaffDto,
} from './dto/admin-staff-management.dto';
import {
  GetCandidatesForAdminDto,
  GetHireRequestsForAdminDto,
  AdminCreateStaffWithHireRequestDto,
} from './dto/admin-staff-selection.dto';
import { AuthService } from '../auth/auth.service';
import { HubspotService } from '../hubspot/hubspot.service';
import { staffStatusDictionary } from '../common/dictionaries/staff-status-dictionary';
import { dbToStageDictionary } from '../common/dictionaries/stage-dictionary';
import { HandlerOrganizationCreation } from '../hubspot/handlers/organizationCreation';
import { organizationToDbDictionary } from '../common/dictionaries/organization-dictionary';
import { dealPipelineToDbDictionary } from '../common/dictionaries/deal-pipeline-dictionary';
import { organizationIndustryToDbDictionary } from '../common/dictionaries/organizationIndustry-dictionary';
// import { mapDealToDb, mapOrganizationToDbHubspot } from '../common/utils/hubspot.util';
//import { dealToDbDictionary } from '../common/dictionaries/deal-dictionary';
import { HandlerDealCreation } from '../hubspot/handlers/dealCreation';
import { NotificationsService } from '../notifications/notifications.service';
import { dealToDbDictionary } from '../common/dictionaries/deal-dictionary';
import { SqsService } from '../sqs/sqs.service';
import { activePipelines } from '../common/constant/activeDealPipelines';
import { ContactService } from '../contacts/contacts.service';
import { BusinessUnitContext } from '../business-units/business-unit-context.service';
import { CandidateAuditFieldGroup, CandidateAuditSource } from '@prisma/client';
import {
  CANDIDATE_AUDIT_EVENTS,
  CandidateAuditService,
} from '../candidate/candidate-audit.service';

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @Inject(forwardRef(() => HandlerOrganizationCreation))
    private readonly organizationCreation: HandlerOrganizationCreation,
    private readonly dealCreation: HandlerDealCreation,
    @Inject(forwardRef(() => HubspotService))
    private readonly hubspot: HubspotService,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notifications: NotificationsService,

    private readonly sqs: SqsService,
    private readonly contactService: ContactService,
    private readonly businessUnitContext: BusinessUnitContext,
    private readonly candidateAudit: CandidateAuditService,
  ) {}

  /**
   * Builds one HubSpot filterGroup per currently-visible business unit,
   * each carrying a `business_unit EQ <value>` filter plus any shared
   * `extraFilters` (e.g. num_associated_deals/hs_object_id). Replaces the
   * old two-literal (MedVirtual/Berry Virtual) filterGroups so a newly
   * visible BU (e.g. MMVA) is included automatically and nothing
   * unrecognized is silently swept up.
   */
  private async buildBusinessUnitFilterGroups(
    extraFilters: Array<{
      propertyName: string;
      operator: string;
      value: string;
    }> = [],
  ): Promise<
    Array<{
      filters: Array<{ propertyName: string; operator: string; value: string }>;
    }>
  > {
    const visibleValues =
      await this.businessUnitContext.getVisibleHubspotValues();
    return visibleValues.map((value) => ({
      filters: [
        { propertyName: 'business_unit', operator: 'EQ', value },
        ...extraFilters,
      ],
    }));
  }

  async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getOwnerId(userId: string): Promise<string | null> {
    if (!userId) return null;
    const user = await this.prisma.uSER.findUnique({
      where: { id: userId },
      select: {
        id: true,
        hubspot_id: true,
        first_name: true,
        last_name: true,
        email: true,
      },
    });

    /* => Commented because we cannot create owners using hubspot API
    if (user && !user.hubspot_id) {
      await this.ownerCreationService.execute(user)
    }
    */

    return user && user.hubspot_id ? user.hubspot_id : null;
  }

  async getOwnerNameById(ownerId) {
    try {
      const response = await axios.get(
        `https://api.hubapi.com/crm/v3/owners/${ownerId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const owner = response.data;
      return owner.fullName || `${owner.firstName} ${owner.lastName}`;
    } catch (error) {
      console.error(
        `Erro ao buscar owner ${ownerId}:`,
        error.response?.data || error.message,
      );
      return null;
    }
  }

  async getDealsByCompanyId(companyId) {
    try {
      await this.delay(1000);
      const result = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/deals/search',
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'hs_primary_associated_company',
                  operator: 'EQ',
                  value: `${companyId}`,
                },
              ],
            },
          ],
          properties: [
            'amount',
            //'business_unit',
            'actual_pairing_date',
            'dealname',
          ],
          limit: 10,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      return result.data.results;
    } catch (error) {
      console.error('Error fetching companies from HubSpot:', error);
      throw new Error('Failed to fetch companies from HubSpot');
    }
  }

  async formatCompany(company) {
    const ownerIds = company.properties.hs_all_owner_ids;

    if (!ownerIds) {
      return company;
    }

    // It can have multiples Ids separated by `;`
    const ownerIdList = ownerIds.split(';');

    // Get the name of all owners
    const ownerNames = await Promise.all(
      ownerIdList.map((id) => this.getOwnerNameById(id)),
    );

    // Get all deals associated with this company
    const deals = await this.getDealsByCompanyId(
      company.properties.hs_object_id,
    );

    // Replace the object
    return {
      ...company,
      staff: deals,
      properties: {
        ...company.properties,
        hs_all_owner_names: ownerNames.filter(Boolean), // new field with name
      },
    };
  }

  async getAllFromHubspot(): Promise<any> {
    let objectOrganization;

    try {
      const filterGroups = await this.buildBusinessUnitFilterGroups([
        { propertyName: 'num_associated_deals', operator: 'GT', value: '0' },
        { propertyName: 'hs_object_id', operator: 'EQ', value: '8304831771' },
      ]);

      const result = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/companies/search',
        {
          filterGroups,
          properties: [
            'agent_status',
            //'business_unit',
            'address',
            'name',
            'hs_all_assigned_business_unit_ids',
            'description',
            'domain',
            'hs_all_accessible_team_ids',
            'hs_all_owner_ids',
            'hs_all_team_ids',
            'hs_num_open_deals',
            'hs_total_deal_value',
            'num_associated_deals',
          ],
          limit: 100,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const companies = result.data.results;
      const formattedCompanies = await Promise.all(
        companies.map((company) => this.formatCompany(company)),
      );

      return formattedCompanies;
    } catch (error) {
      console.error('Error fetching companies from HubSpot:', error);
      throw new Error('Failed to fetch companies from HubSpot');
    }
  }

  async getAll(user: USER, status?: string): Promise<Organization[]> {
    try {
      const whereClause: any = {
        ...(status
          ? { status: { equals: status as OrganizationStatus } }
          : {
              status: {
                in: [OrganizationStatus.active, OrganizationStatus.inactive],
              },
            }), //keep only active and inactive by default, hide deleted, but allow filter by status if needed
      };

      // For system_super_admin: return all organizations
      if (user.role === 'system_super_admin') {
        // No additional filtering needed - return all active organizations
      }
      // For system_admin: return only organizations they are admin or concierge of
      else if (user.role === 'system_admin') {
        //whereClause.OR = [{ admin_id: user.id }]; //Updated on 2026-02-19 asked by Pauli
      }
      // For organization users: return organizations they are associated with
      else {
        whereClause.OR = [
          { admin_id: user.id },
          { owner_id: user.id },
          { admin_id: user.id },
          {
            admin_id: user.role.includes('organization') ? user.id : undefined,
          },
        ].filter(Boolean);
      }

      return await this.prisma.organization.findMany({
        where: whereClause,
        orderBy: {
          name: 'asc',
        },
        include: {
          owner: true,
          admin: true,
          users: true,
          contacts: true,
        },
      });
    } catch {
      throw new NotFoundException('Organizations not found');
    }
  }

  async getAllPaginated(
    user: USER,
    query: GetOrganizationsDto,
  ): Promise<PaginatedOrganizationsResponseDto> {
    //try {
    const {
      page = 1,
      limit = 10,
      search,
      role,
      type,
      status,
      industry,
      location,
      admin,
      billing_mode,
      business_unit,
      hasUser,
      hasStaff,
      without_referral,
      hubstaffConnected,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const skip = (page - 1) * limit;

    // Build where clause
    const whereClause: any = {};

    // Scope and search each contribute their own AND branch. They must never
    // share the `OR` key: OR-ing them together would make an org visible to a
    // non-system user simply because they searched for it.
    const andConditions: Prisma.OrganizationWhereInput[] = [];

    // Add user-specific filtering based on role
    if (user.role === 'system_super_admin' || user.role === 'system_admin') {
      // No additional filtering needed - return all organizations
      /*
      } else if (user.role === 'system_admin') {
        // For system_admin: return only organizations they are admin or concierge of
        whereClause.OR = [{ admin_id: user.id }];
      }
      */
    } else {
      // Visibility scope for organization users: only orgs they own or administer
      andConditions.push({
        OR: [{ admin_id: user.id }, { owner_id: user.id }],
      });
    }

    // Add search filter
    // Match each whitespace-separated token independently and AND them
    // together, so "First Last" matches a member user whose name spans two
    // columns. Mirrors the same handling in UserService; a single OR per
    // column could never match a full name, since no one column contains
    // "First Last" as a substring.
    const tokens = search ? search.trim().split(/\s+/).filter(Boolean) : [];

    andConditions.push(
      ...tokens.map((token) => ({
        OR: [
          { name: { contains: token, mode: Prisma.QueryMode.insensitive } },
          /*
          Email and description was removed when we added the users
          { email: { contains: token, mode: Prisma.QueryMode.insensitive } },
          {
            description: {
              contains: token,
              mode: Prisma.QueryMode.insensitive,
            },
          },
          */
          {
            users: {
              some: {
                OR: [
                  {
                    first_name: {
                      contains: token,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                  {
                    last_name: {
                      contains: token,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                ],
              },
            },
          },
        ],
      })),
    );

    if (andConditions.length) {
      whereClause.AND = andConditions;
    }

    // Add role filter
    if (role) {
      whereClause.organization_role = role;
    }

    // Add role type
    if (type) {
      whereClause.type = type;
    }

    // Add status filter
    if (status) {
      whereClause.status = status;
    } else {
      whereClause.status = { not: OrganizationStatus.deleted };
    }

    // Add industry filter
    if (industry) {
      whereClause.industry = {
        contains: industry,
        mode: 'insensitive',
      };
    }

    // Add location filter
    if (location) {
      whereClause.location = {
        contains: location,
        mode: 'insensitive',
      };
    }

    // Add admin filter (available for system_super_admin and system_admin,
    // both of which already have unrestricted base visibility above)
    if (
      admin &&
      (user.role === 'system_super_admin' || user.role === 'system_admin')
    ) {
      whereClause.admin_id = admin;
    }

    if (business_unit) {
      whereClause.business_unit = business_unit;
    }

    // Apply hasUser filter: only organizations with at least one user
    if (hasUser === true) {
      whereClause.users = {
        some: {},
      };
    }

    // Apply hasStaff filter: only organizations with at least one staff that is not terminated
    if (hasStaff === true) {
      whereClause.staff = {
        some: {
          status: { not: { in: ['terminated', 'inactive'] } },
        },
      };
    }

    // Apply without_referral filter: only organizations with no affiliate referral
    if (without_referral === true) {
      whereClause.referred_by_affiliate_id = null;
    }

    // Combined filter for Hubstaff connection and Billing Mode
    if (hubstaffConnected === 'true' || billing_mode) {
      whereClause.invoiceConfiguration = {
        ...(hubstaffConnected === 'true' ? { hubstaff_id: { not: null } } : {}),
        ...(billing_mode ? { billing_mode: { equals: billing_mode } } : {}),
      };
    }

    if (hubstaffConnected === 'false') {
      if (billing_mode) {
        // If billing mode is specified, configuration must exist, so we just check for null hubstaff_id
        whereClause.invoiceConfiguration = {
          ...whereClause.invoiceConfiguration,
          hubstaff_id: null,
        };
      } else {
        // No billing mode, so allow null configuration OR configuration with null hubstaff_id
        whereClause.OR = [
          ...(whereClause.OR || []),
          { invoiceConfiguration: null },
          { invoiceConfiguration: { hubstaff_id: null } },
        ];
      }
    }

    // Check if sorting by calculated fields (userCount or activeStaffCount)
    const isCalculatedFieldSort =
      sortBy === 'userCount' || sortBy === 'activeStaffCount';

    // Build orderBy clause (only for non-calculated fields)
    const orderBy: any = {};
    if (!isCalculatedFieldSort) {
      orderBy[sortBy] = sortOrder;
    }

    // Get total count (after applying all filters including hasUser and hasStaff)
    const total = await this.prisma.organization.count({
      where: whereClause,
    });

    // Get organizations - if sorting by calculated field, get all, otherwise use pagination
    const organizations = await this.prisma.organization.findMany({
      where: whereClause,
      skip: isCalculatedFieldSort ? 0 : skip, // Skip pagination if sorting by calculated field
      take: isCalculatedFieldSort ? undefined : limit, // Get all if sorting by calculated field
      orderBy: isCalculatedFieldSort ? undefined : orderBy, // Don't use orderBy for calculated fields
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            first_name: true,
            last_name: true,
            job_title: true,
            phone: true,
          },
        },
        admin: {
          select: {
            id: true,
            email: true,
            first_name: true,
            last_name: true,
            job_title: true,
            phone: true,
          },
        },
        users: {
          select: {
            id: true,
            status: true,
          },
        },
        staff: {
          select: {
            id: true,
            status: true,
          },
        },
        contacts: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            user_id: true,
            hubspot_id: true,
          },
        },
        invoiceConfiguration: true,
      },
    });

    const sync = await this.prisma.sync.findFirst({
      where: {
        role: 'organizations',
      },
      orderBy: {
        last_synced_at: 'desc',
      },
    });

    // Calculate counts and track organizations to deactivate
    const organizationsWithCounts: Array<
      (typeof organizations)[0] & { userCount: number; staffCount: number }
    > = [];
    const organizationsToDeactivate: string[] = [];

    for (const org of organizations) {
      // Calculate userCount: exclude inactive, include pending as active
      // Count users where status !== 'inactive' (includes: active, pending, invited, suspended, etc.)
      const userCount = org.users.length;

      // Calculate staffCount: exclude terminated
      // Count staff where status !== 'terminated'
      const staffCount = org.staff.filter(
        (staff) => staff.status !== 'terminated' && staff.status !== 'inactive',
      ).length;

      // Apply hasUser filter: skip organizations that don't meet the criteria
      if (hasUser === true && org.users.length === 0) {
        continue; // Skip this organization as it doesn't have users
      }

      // Apply hasStaff filter: skip organizations that don't meet the criteria
      if (hasStaff === true && staffCount === 0) {
        continue; // Skip this organization as it doesn't have active staff
      }

      // Track organizations that need to be deactivated
      if (staffCount === 0 && org.status === 'active') {
        organizationsToDeactivate.push(org.id);
      }

      organizationsWithCounts.push({
        ...org,
        userCount,
        staffCount,
      });
    }

    // Sort by calculated fields if needed
    if (isCalculatedFieldSort) {
      organizationsWithCounts.sort((a, b) => {
        let aValue: number;
        let bValue: number;

        if (sortBy === 'userCount') {
          aValue = a.userCount;
          bValue = b.userCount;
        } else if (sortBy === 'activeStaffCount') {
          aValue = a.staffCount;
          bValue = b.staffCount;
        } else {
          return 0;
        }

        if (sortOrder === 'asc') {
          return aValue - bValue;
        } else {
          return bValue - aValue;
        }
      });

      // Apply pagination after sorting
      const paginatedOrganizations = organizationsWithCounts.slice(
        skip,
        skip + limit,
      );
      organizationsWithCounts.length = 0;
      organizationsWithCounts.push(...paginatedOrganizations);
    }

    // Desactivate organizations with staffCount === 0
    //removed on 2025-11-06 by Paulo because I got issue when the user update the organization status manually
    /*if (organizationsToDeactivate.length > 0) {
        await this.prisma.organization.updateMany({
          where: {
            id: { in: organizationsToDeactivate },
          },
          data: {
            status: 'inactive',
          },
        });
      }*/

    // Transform data
    const data: OrganizationResponseDto[] = organizationsWithCounts.map(
      (org) => ({
        id: org.id,
        hubspot_id: org.hubspot_id || undefined,
        name: org.name,
        email: org.email || undefined,
        phone: org.phone || undefined,
        website_url: org.website_url || undefined,
        address: org.address || undefined,
        city: org.city || undefined,
        state: org.state || undefined,
        postal_code: org.postal_code || undefined,
        location: org.location || undefined,
        description: org.description || undefined,
        industry: org.industry
          ? organizationIndustryToDbDictionary[org.industry] || org.industry
          : undefined,
        business_unit: org.business_unit || undefined,
        organization_role: org.organization_role,
        number_of_employees: org.number_of_employees || undefined,
        date_founded: org.date_founded || undefined,
        date_joined: org.date_joined || undefined,
        date_became_client: org.date_became_client || undefined,
        type: org.type || undefined,
        //status: org.status === 'active' && org.staffCount === 0 ? 'inactive' : org.status,
        status: org.status,
        signed_document_url: org.signed_document_url || undefined,
        signed_document_date: org.signed_document_date || undefined,
        specialties: org.specialties || undefined,
        services: org.services || undefined,
        owner_id: org.owner_id || undefined,
        admin_id: org.admin_id || undefined,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
        deletedAt: org.deletedAt || undefined,
        owner: org.owner || undefined,
        admin: org.admin || undefined,
        userCount: org.userCount,
        staffCount: org.staffCount,
        source: org.source || undefined,
        contacts:
          org.contacts.length > 0
            ? org.contacts.map((contact) => ({
                id: contact.id,
                first_name: contact.first_name,
                last_name: contact.last_name,
                email: contact.email,
                phone: contact.phone,
                user_id: contact.user_id || undefined,
              }))
            : undefined,
        invoiceConfiguration: org.invoiceConfiguration || undefined,
      }),
    );

    // Calculate pagination metadata
    // Since we filter in memory after Prisma query, the total might not be accurate
    // We use the filtered count for the current page, but keep the original total
    // for pagination navigation (this is a limitation of filtering in memory)
    const filteredCount = organizationsWithCounts.length;
    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      data,
      last_synced_at: sync ? sync.last_synced_at.toISOString() : '',
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
    //} catch (error) {
    //  throw new NotFoundException('Organizations not found');
    //}
  }

  async getContactByOrgId(orgId: string) {
    return this.prisma.contact.findMany({
      where: { organization_id: orgId },
      select: {
        id: true,
        user_id: true,
        hubspot_id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
      },
    });
  }

  async getById(id: string): Promise<Organization> {
    try {
      const organization = await this.prisma.organization.findUnique({
        where: { id },
        include: {
          owner: true,
          admin: true,
          users: true,
          contacts: true,
          invoiceConfiguration: true,
        },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      return organization;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException('Organization not found');
    }
  }

  async create(
    data: CreateOrganizationDto,
    user?: USER,
    referred_by_affiliate_id?: string,
  ): Promise<Organization> {
    try {
      // // Check if the organization already exists
      // const existingOrganization = await this.prisma.organization.findUnique({
      //   where: { email: data.email },
      // });

      // if (existingOrganization) {
      //   throw new BadRequestException('Organization already exists');
      // }
      //console.log(data)
      // Handle owner assignment based on owner_type
      let ownerId: string | undefined = undefined;
      let ownerEmail: string | undefined = undefined;

      if (data.owner_type === 'existing' && data.owner_id) {
        // Use existing user as owner
        const existingOwner = await this.prisma.uSER.findUnique({
          where: { id: data.owner_id },
        });

        if (!existingOwner) {
          console.error(`Selected owner user not found: ${data.owner_id}`);
          throw new BadRequestException('Selected owner user not found');
        }

        // Check if user is already an owner of another organization
        if (existingOwner.is_organization_owner) {
          console.error(
            `User ${existingOwner.id} is already an owner of another organization`,
          );
          throw new BadRequestException(
            'User is already an owner of another organization',
          );
        }

        ownerId = existingOwner.id;
        ownerEmail = existingOwner.email;
      } else if (data.owner_type === 'new' && data.owner_email) {
        // Check if user with this email already exists
        const existingUser = await this.prisma.uSER.findUnique({
          where: { email: data.owner_email },
        });

        if (existingUser) {
          console.error(
            `User with email ${data.owner_email} already exists: ${existingUser.id}`,
          );
          throw new BadRequestException('User with this email already exists.');
        }

        ownerEmail = data.owner_email;
      } else if (
        data.owner_type &&
        data.owner_type !== 'existing' &&
        data.owner_type !== 'new'
      ) {
        console.error(`Invalid owner_type: ${data.owner_type}`);
        throw new BadRequestException(
          'Invalid owner_type. Must be "existing" or "new"',
        );
      }

      // Assign a random admin if not specified
      let adminId: string | undefined = data.admin_id;
      if (!adminId) {
        if (user && !referred_by_affiliate_id) {
          adminId = user.id; // Added on 2025-11-18 by Paulo to get the logged in user as default admin
        } else {
          let availableAdmins;
          //console.log(referred_by_affiliate_id, data.refer_to_user_id)
          //If we have an referral and a refer_to_user_id, we will try to assign the referred admin, if not we will assign randomly as before | Added on 2026-04-16
          if (referred_by_affiliate_id && data.refer_to_user_id) {
            availableAdmins = await this.prisma.uSER.findMany({
              where: {
                id: data.refer_to_user_id,
              },
            });
          } else {
            availableAdmins = await this.prisma.uSER.findMany({
              where: {
                email:
                  process.env.ENVIRONMENT === 'DEV'
                    ? 'paulo@regenta.ai'
                    : 'hanieh@berryvirtual.com', // Added on 2025-09-25 for get Hanieh as default concierge for all organizations via hubspot. asked by Pauli
                role: 'system_super_admin',
                status: 'active',
              },
            });
          }

          if (availableAdmins.length > 0) {
            // Simple round-robin assignment - could be enhanced with load balancing
            const randomIndex = Math.floor(
              Math.random() * availableAdmins.length,
            );
            adminId = availableAdmins[randomIndex].id;
          }
        }
        //console.log('Assigned adminId:', adminId);
      }
      let specialtiesArray: string[] = [];
      let servicesArray: string[] = [];
      if (typeof data.specialties === 'string') {
        specialtiesArray = data.specialties.split(',').map((s) => s.trim());
      } else if (Array.isArray(data.specialties)) {
        specialtiesArray = data.specialties;
      } else {
        specialtiesArray = [];
      }

      if (typeof data.services === 'string') {
        servicesArray = data.services.split(',').map((s) => s.trim());
      } else if (Array.isArray(data.services)) {
        servicesArray = data.services;
      } else {
        servicesArray = [];
      }

      const existingOrganization = await this.prisma.organization.findFirst({
        where: {
          contact_email: data.contact_email, // The email field was removed on the UI
          status: { not: OrganizationStatus.deleted }, // Allow creating organization with same email if the previous one is deleted
        },
      });

      if (existingOrganization && data.contact_email !== undefined) {
        throw new BadRequestException(
          `The ${data.contact_email} is main contact of another organization. Please use another email or update the existing organization.`,
        );
      }

      const organization = await this.prisma.organization.create({
        data: {
          name: data.name,
          email: !referred_by_affiliate_id ? data.email : undefined,
          phone: data.phone,
          website_url: data.website_url,
          address: data.address,
          city: data.city,
          state: data.state,
          postal_code: data.zip,
          location: data.location,
          description: data.description,
          industry: data.industry
            ? organizationIndustryToDbDictionary[data.industry] || data.industry
            : undefined,
          business_unit: data.business_unit,
          type: referred_by_affiliate_id ? 'PROSPECT' : data.type,
          organization_role:
            data.organization_role || OrganizationRole.prospect,
          number_of_employees: Number(data.number_of_employees),
          date_founded: data.date_founded
            ? new Date(data.date_founded)
            : undefined,
          date_joined: data.date_joined
            ? new Date(data.date_joined)
            : new Date(),
          status: data.status || OrganizationStatus.active,
          specialties: specialtiesArray,
          services: servicesArray,
          owner_id: ownerId,
          admin_id: adminId,
          hubspot_id: data.hubspot_id || undefined,
          source: user ? 'MedVirtual app' : 'Hubspot',
          referred_by_affiliate_id: referred_by_affiliate_id || undefined,
          contact_first_name: data.contact_first_name || undefined,
          contact_last_name: data.contact_last_name || undefined,
          contact_email: data.contact_email || undefined,
          refer_to_user_id: data.refer_to_user_id || undefined,
        },
      });

      // Handle owner creation/invitation
      if (data.owner_type === 'existing' && ownerId) {
        // Update existing user to be owner of this organization
        await this.prisma.uSER.update({
          where: { id: ownerId },
          data: {
            organization_id: organization.id,
            organization_name: organization.name,
            role: 'organization_super_admin',
            is_organization_owner: true,
          },
        });
      } else if (data.owner_type === 'new' && ownerEmail) {
        // Invite new user as owner
        const inviteData = {
          email: ownerEmail,
          role: 'organization_super_admin',
          companyName: data.name,
          organizationId: organization.id,
          first_name: data.owner_first_name || '',
          last_name: data.owner_last_name || '',
          job_title: data.owner_job_title || '',
          phone: data.owner_phone || '',
        };
        await this.auth.inviteUser(inviteData);
      }

      // Create initial InvoiceConfiguration record
      await this.prisma.invoiceConfiguration.create({
        data: {
          organization_id: organization.id,
          hubspot_id: organization.hubspot_id,
        },
      });

      const newOrganization = await this.getById(organization.id);

      if (user) {
        //this rule avoid re-call on hubspot. If this flow came from hubspot, we dont have logged user and then we avoid send new organization for hubspot
        await this.hubspot.createOrganizationInHubspot(
          newOrganization,
          user?.id,
          `New organization onboarded — company record created in HubSpot`,
        );
        // Referred companies have their own contact creation flow (createForReferredCompany in Step 6)
        if (!referred_by_affiliate_id) {
          console.log('Creating contact for organization:', newOrganization.id);
          await this.contactService.createForOrganization(newOrganization.id);
        }
      }

      return newOrganization;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to create organization:', error);
    }
  }

  async update(
    id: string,
    data: UpdateOrganizationDto,
    actorUserId?: string,
  ): Promise<Organization> {
    try {
      const updateData: any = {};

      // Map the fields from DTO to database fields
      if (data.name !== undefined) updateData.name = data.name;
      if (data.email !== undefined) updateData.email = data.email;
      if (data.phone !== undefined) updateData.phone = data.phone;
      if (data.website_url !== undefined)
        updateData.website_url = data.website_url;
      if (data.location !== undefined) updateData.location = data.location;
      if (data.description !== undefined)
        updateData.description = data.description;
      if (data.industry !== undefined) updateData.industry = data.industry;

      // Fix number_of_employees validation
      if (data.number_of_employees !== undefined) {
        // Ensure it's a valid integer
        const numEmployees = parseInt(data.number_of_employees.toString(), 10);
        if (isNaN(numEmployees) || numEmployees < 1) {
          throw new BadRequestException(
            'Number of employees must be a valid positive integer',
          );
        }
        updateData.number_of_employees = numEmployees;
      }
      if (data.date_founded !== undefined && data.date_founded !== '')
        updateData.date_founded = new Date(data.date_founded);
      if (data.date_joined !== undefined)
        updateData.date_joined = new Date(data.date_joined);
      if (data.status !== undefined) updateData.status = data.status;
      if (data.specialties !== undefined)
        updateData.specialties = data.specialties;
      if (data.services !== undefined) updateData.services = data.services;
      if (data.admin_id !== undefined) updateData.admin_id = data.admin_id;

      // Handle organization_role update
      if (data.organization_role !== undefined) {
        updateData.organization_role = data.organization_role;
      }

      // Handle signed_document_url update
      if (data.signed_document_url !== undefined) {
        updateData.signed_document_url = data.signed_document_url;
        // Update the signed document date when URL is provided
        updateData.signed_document_date = new Date();
      }

      if (data.status === 'active') {
        updateData.status = OrganizationStatus.active;
      } else if (data.status === 'inactive') {
        updateData.status = OrganizationStatus.inactive;
      } else {
        console.log('Status not updated, invalid value:', data.status);
      }

      const res = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.organization.update({
          where: { id },
          data: {
            status: updateData.status as OrganizationStatus,
            admin_id: updateData.admin_id,
          },
          include: {
            owner: true,
            admin: true,
            users: true,
          },
        });

        if (updateData.status === OrganizationStatus.inactive) {
          await tx.$executeRaw`
            UPDATE "USER"
            SET "status_before_deactivation" = "status", "status" = 'inactive'
            WHERE "organization_id" = ${id}
              AND "status" NOT IN ('invited', 'suspended', 'incomplete')
          `;
        }

        if (updateData.status === OrganizationStatus.active) {
          await tx.$executeRaw`
            UPDATE "USER"
            SET "status" = "status_before_deactivation",
                "status_before_deactivation" = NULL
            WHERE "organization_id" = ${id}
              AND "status_before_deactivation" = 'active'
          `;
        }
        return updated;
      });

      //updateOrganizationInHubspot
      await this.hubspot.updateOrganizationInHubspot(
        res,
        actorUserId,
        `Organization admin updated — HubSpot company owner synced`,
      );

      return res;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('Failed to update organization:', error);
      throw new BadRequestException('Failed to update organization');
    }
  }

  async updateInvoiceConfiguration(
    organizationId: string,
    data: UpdateInvoiceConfigurationDto,
  ): Promise<any> {
    try {
      // Check if organization exists
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      // Filter out undefined fields to only update what's provided
      const filteredData = Object.entries(data).reduce((acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      }, {});

      // Upsert the invoice configuration
      const updatedConfig = await this.prisma.invoiceConfiguration.upsert({
        where: { organization_id: organizationId },
        update: filteredData,
        create: {
          ...filteredData,
          organization_id: organizationId,
        },
      });

      return {
        status: 200,
        message: 'Invoice configuration updated successfully',
        data: updatedConfig,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      console.error('Failed to update invoice configuration:', error);
      throw new BadRequestException('Failed to update invoice configuration');
    }
  }

  async convertToClient(id: string, data: ConvertToClientDto): Promise<any> {
    try {
      const organization = await this.prisma.organization.findUnique({
        where: { id },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      if (organization.organization_role !== OrganizationRole.prospect) {
        throw new BadRequestException('Organization is already a client');
      }

      //transaction to handle the updates
      const updates = await this.prisma.$transaction(async (up) => {
        (await up.organization.update({
          where: { id },
          data: {
            organization_role: OrganizationRole.client,
            date_became_client: new Date(),
            signed_document_url: data.signed_document_url,
            signed_document_date: data.signed_document_date
              ? new Date(data.signed_document_date)
              : new Date(),
          },
          include: {
            owner: true,
            admin: true,
            users: true,
          },
        }),
          await up.hireRequest.updateMany({
            where: {
              org_id: id,
              status: HireRequestStatus.pending_signature,
            },
            data: {
              status: HireRequestStatus.new,
            },
          }));
      });

      return await this.prisma.organization.findUnique({
        where: { id },
        include: {
          owner: true,
          admin: true,
          users: true,
        },
      });
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        'Failed to convert organization to client',
        error,
      );
    }
  }

  async assignAdmin(id: string, adminId: string): Promise<Organization> {
    try {
      // Verify the admin is a system admin or super admin
      const admin = await this.prisma.uSER.findUnique({
        where: { id: adminId },
      });

      if (
        !admin ||
        !['system_admin', 'system_super_admin'].includes(admin.role)
      ) {
        throw new BadRequestException(
          'Invalid admin. Must be a system admin or super admin.',
        );
      }

      const res = await this.prisma.organization.update({
        where: { id },
        data: { admin_id: adminId },
        include: {
          owner: true,
          admin: true,
          users: true,
        },
      });

      //updateOrganizationInHubspot
      await this.hubspot.updateOrganizationInHubspot(
        res,
        undefined,
        `Admin assigned to organization — HubSpot company owner updated`,
      );

      return res;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to assign admin');
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.organization.update({
          where: { id },
          data: { status: OrganizationStatus.inactive },
        }),
        this.prisma.uSER.updateMany({
          where: { organization_id: id },
          data: { status: 'inactive' },
        }),
      ]);

      return true;
    } catch {
      throw new NotFoundException('Organization not found');
    }
  }

  // Admin Staff Management Methods
  async getOrganizationStaff(
    organizationId: string,
    query: GetOrganizationStaffDto,
    _user: USER,
  ): Promise<any> {
    try {
      // Verify organization exists
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const {
        page = 1,
        perPage = 10,
        search,
        start_date_from,
        start_date_to,
        status,
      } = query;

      const skip = (page - 1) * perPage;
      const take = perPage;

      const where: any = {
        //hireRequest: {
        //  org_id: organizationId,
        //},
        //candidate: {},
        organization_id: organizationId,
      };

      if (search) {
        where.OR = [
          {
            hireRequest: {
              title: { contains: search, mode: 'insensitive' },
            },
          },
          {
            candidate: {
              first_name: { contains: search, mode: 'insensitive' },
            },
          },
          {
            candidate: {
              last_name: { contains: search, mode: 'insensitive' },
            },
          },
        ];
      }

      if (start_date_from || start_date_to) {
        where.start_date = {};
        if (start_date_from) where.start_date.gte = new Date(start_date_from);
        if (start_date_to) where.start_date.lte = new Date(start_date_to);
      }

      if (status) {
        // Convert frontend status to database status using the dictionary
        const dbStatus = staffStatusDictionary[status];
        if (dbStatus) {
          where.status = dbStatus;
        }
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
            first_name: true,
            last_name: true,
            name: true,
            email: true,
            specialization: true,
            employment_type: true,
            country: true,
            about_me: true,
            gender: true,
            avatar_url: true,
            hubspot_vaid: true,
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

      const staffWithDictionary: any = staff.map((s) => ({
        ...s,
        hubspot_dealstage: s.hubspot_dealstage
          ? dealPipelineToDbDictionary[s.hubspot_dealstage] ||
            s.hubspot_dealstage
          : undefined,
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

      return {
        status: 200,
        data: staffWithDictionary,
        meta: {
          total,
          page,
          perPage,
          totalPages: Math.ceil(Number(total) / perPage),
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Failed to fetch organization staff');
    }
  }

  async createStaffForOrganization(
    data: AdminCreateStaffDto,
    user: USER,
  ): Promise<any> {
    try {
      // Verify organization exists
      const organization = await this.prisma.organization.findUnique({
        where: { id: data.organization_id },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      // Verify hire request belongs to the organization
      const hireRequest = await this.prisma.hireRequest.findFirst({
        where: {
          id: data.hirerequest_id,
          org_id: data.organization_id,
        },
      });

      if (!hireRequest) {
        throw new BadRequestException(
          'Hire request not found or does not belong to the specified organization',
        );
      }

      // Verify candidate exists
      const candidate = await this.prisma.candidate.findUnique({
        where: { id: data.candidate_id },
      });

      if (!candidate) {
        throw new NotFoundException('Candidate not found');
      }

      const statusHandled = staffStatusDictionary[data.status];

      const staff = await this.prisma.staff.create({
        data: {
          candidate_id: data.candidate_id,
          hirerequest_id: data.hirerequest_id,
          status: statusHandled,
          salary: data.salary,
          start_date: data.start_date,
          created_by: user.id,
        },
      });

      // Get the created staff with all relations
      const createdStaff = await this.prisma.staff.findUnique({
        where: { id: staff.id },
        select: {
          id: true,
          hirerequest_id: true,
          status: true,
          salary: true,
          start_date: true,
          created_at: true,
          updated_at: true,
          candidate: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
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
        },
      });

      return {
        status: 201,
        message: 'Staff created successfully for organization',
        data: createdStaff,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException('Failed to create staff for organization');
    }
  }

  // Admin Selection Methods
  async getCandidatesForHireRequest(
    hireRequestId: string,
    query: GetCandidatesForAdminDto,
  ): Promise<any> {
    try {
      // Verify hire request exists
      const hireRequest = await this.prisma.hireRequest.findUnique({
        where: { id: hireRequestId },
        select: { id: true, title: true, org_id: true },
      });

      if (!hireRequest) {
        throw new NotFoundException('Hire request not found');
      }

      const {
        page = 1,
        perPage = 20,
        search,
        specialization,
        employment_type,
        country,
      } = query;

      const skip = (page - 1) * perPage;
      const take = perPage;

      // First check if there are any candidates attached to this hire request
      const attachedCandidatesCount = await this.prisma.candidate.count({
        where: {
          pipeline_status: 'available',
          panelCandidates: {
            some: {
              panel: {
                hire_request_id: hireRequestId,
              },
            },
          },
        },
      });

      // Build where clause - if no attached candidates, get all available candidates
      const where: any = {
        pipeline_status: 'available',
      };

      // Only filter by panelCandidates if there are attached candidates
      if (attachedCandidatesCount > 0) {
        where.panelCandidates = {
          some: {
            panel: {
              hire_request_id: hireRequestId,
            },
          },
        };
      }

      if (search) {
        where.OR = [
          {
            first_name: { contains: search, mode: 'insensitive' },
          },
          {
            last_name: { contains: search, mode: 'insensitive' },
          },
          {
            email: { contains: search, mode: 'insensitive' },
          },
        ];
      }

      if (specialization) {
        where.specialization = {
          contains: specialization,
          mode: 'insensitive',
        };
      }

      if (employment_type) {
        where.employment_type = employment_type;
      }

      if (country) {
        where.country = { contains: country, mode: 'insensitive' };
      }

      const select = {
        id: true,
        first_name: true,
        last_name: true,
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
        panelCandidates: {
          where: {
            panel: {
              hire_request_id: hireRequestId,
            },
          },
          select: {
            status: true,
            panel: {
              select: {
                id: true,
                status: true,
                scheduled_date: true,
              },
            },
          },
        },
      };

      const [candidates, total] = await this.prisma.$transaction([
        this.prisma.candidate.findMany({
          where,
          skip,
          take,
          select,
          orderBy: {
            createdAt: 'desc',
          },
        }),
        this.prisma.candidate.count({ where }),
      ]);

      return {
        status: 200,
        data: candidates,
        hireRequest: {
          id: hireRequest.id,
          title: hireRequest.title,
        },
        hasAttachedCandidates: attachedCandidatesCount > 0,
        meta: {
          total,
          page,
          perPage,
          totalPages: Math.ceil(Number(total) / perPage),
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        'Failed to fetch candidates for hire request',
      );
    }
  }

  async getCandidatesForAdmin(query: GetCandidatesForAdminDto): Promise<any> {
    try {
      const {
        page = 1,
        perPage = 20,
        search,
        specialization,
        employment_type,
        country,
      } = query;

      const skip = (page - 1) * perPage;
      const take = perPage;

      const where: any = {
        pipeline_status: 'available', // Only available candidates
      };

      if (search) {
        where.OR = [
          {
            first_name: { contains: search, mode: 'insensitive' },
          },
          {
            last_name: { contains: search, mode: 'insensitive' },
          },
          {
            email: { contains: search, mode: 'insensitive' },
          },
        ];
      }

      if (specialization) {
        where.specialization = {
          contains: specialization,
          mode: 'insensitive',
        };
      }

      if (employment_type) {
        where.employment_type = employment_type;
      }

      if (country) {
        where.country = { contains: country, mode: 'insensitive' };
      }

      const select = {
        id: true,
        first_name: true,
        last_name: true,
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
      };

      const [candidates, total] = await this.prisma.$transaction([
        this.prisma.candidate.findMany({
          where,
          skip,
          take,
          select,
          orderBy: {
            createdAt: 'desc',
          },
        }),
        this.prisma.candidate.count({ where }),
      ]);

      return {
        status: 200,
        data: candidates,
        meta: {
          total,
          page,
          perPage,
          totalPages: Math.ceil(Number(total) / perPage),
        },
      };
    } catch (error) {
      throw new BadRequestException('Failed to fetch candidates');
    }
  }

  async getHireRequestDetails(hireRequestId: string): Promise<any> {
    try {
      // Get hire request with attached candidates
      const hireRequest = await this.prisma.hireRequest.findUnique({
        where: { id: hireRequestId },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          specialization: true,
          location: true,
          availability: true,
          contract_length: true,
          expected_start_date: true,
          salary_range_from: true,
          salary_range_to: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          panels: {
            select: {
              id: true,
              status: true,
              scheduled_date: true,
              createdAt: true,
              panelCandidates: {
                select: {
                  id: true,
                  status: true,
                  createdAt: true,
                  candidate: {
                    select: {
                      id: true,
                      first_name: true,
                      last_name: true,
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
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!hireRequest) {
        throw new NotFoundException('Hire request not found');
      }

      // Extract all candidates from panels
      const attachedCandidates = hireRequest.panels.flatMap((panel) =>
        panel.panelCandidates.map((pc) => ({
          ...pc.candidate,
          panelStatus: pc.status,
          panelId: panel.id,
          panelScheduledDate: panel.scheduled_date,
        })),
      );

      const candidates = await this.prisma.candidate.findMany({
        where: {
          pipeline_status: {
            in: ['261075105', '1087596819'],
          },
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          specialization: true,
          employment_type: true,
          country: true,
          about_me: true,
          languages: {
            select: { name: true },
          },
          skills: {
            select: { skill_name: true },
          },
        },
      });

      const mappedPipelineCandidates = candidates.map((c) => ({
        ...c,
        panelStatus: null, //just for align with the preious structure
        panelId: null,
        panelScheduledDate: null,
      }));

      //just for merge candidates and return all candidates
      const allCandidates = [
        ...attachedCandidates,
        ...mappedPipelineCandidates,
      ];

      return {
        status: 200,
        data: {
          hireRequest: {
            id: hireRequest.id,
            title: hireRequest.title,
            description: hireRequest.description,
            status: hireRequest.status,
            priority: hireRequest.priority,
            specialization: hireRequest.specialization,
            location: hireRequest.location,
            availability: hireRequest.availability,
            contract_length: hireRequest.contract_length,
            expected_start_date: hireRequest.expected_start_date,
            salary_range_from: hireRequest.salary_range_from,
            salary_range_to: hireRequest.salary_range_to,
            createdAt: hireRequest.createdAt,
            organization: hireRequest.organization,
          },
          attachedCandidates: allCandidates,
          hasAttachedCandidates: attachedCandidates.length > 0,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Failed to fetch hire request details');
    }
  }

  async getHireRequestsForAdmin(
    organizationId: string,
    query: GetHireRequestsForAdminDto,
  ): Promise<any> {
    try {
      // Verify organization exists
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const { page = 1, perPage = 20, search, status, specialization } = query;

      const skip = (page - 1) * perPage;
      const take = perPage;

      const where: any = {
        org_id: organizationId,
      };

      if (search) {
        where.title = { contains: search, mode: 'insensitive' };
      }

      if (status) {
        where.status = status;
      }

      if (specialization) {
        where.specialization = {
          contains: specialization,
          mode: 'insensitive',
        };
      }

      const select = {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        specialization: true,
        location: true,
        availability: true,
        contract_length: true,
        expected_start_date: true,
        salary_range_from: true,
        salary_range_to: true,
        createdAt: true,
      };

      const [hireRequests, total] = await this.prisma.$transaction([
        this.prisma.hireRequest.findMany({
          where,
          skip,
          take,
          select,
          orderBy: {
            createdAt: 'desc',
          },
        }),
        this.prisma.hireRequest.count({ where }),
      ]);

      return {
        status: 200,
        data: hireRequests,
        meta: {
          total,
          page,
          perPage,
          totalPages: Math.ceil(Number(total) / perPage),
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException('Failed to fetch hire requests');
    }
  }

  async createStaffWithOptionalHireRequest(
    data: AdminCreateStaffWithHireRequestDto,
    user: USER,
  ): Promise<any> {
    try {
      // Verify organization exists
      const organization = await this.prisma.organization.findUnique({
        where: { id: data.organization_id },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      // Verify candidate exists
      const candidate = await this.prisma.candidate.findUnique({
        where: { id: data.candidate_id },
      });

      if (!candidate) {
        throw new NotFoundException('Candidate not found');
      }

      let hireRequestId = data.hirerequest_id;

      // If no hire request ID provided, create a new hire request
      if (!hireRequestId) {
        if (!data.hire_request_title) {
          throw new BadRequestException(
            'Hire request title is required when creating a new hire request',
          );
        }

        const newHireRequest = await this.prisma.hireRequest.create({
          data: {
            org_id: data.organization_id,
            title: data.hire_request_title,
            description: data.hire_request_description || '',
            status: 'placement_completed', // Mark as completed since we're creating staff
            priority: data.hire_request_priority || 'medium',
            specialization:
              data.hire_request_specialization ||
              candidate.specialization ||
              '',
            location: data.hire_request_location || '',
            availability: data.hire_request_availability || 'immediate',
            contract_length: data.hire_request_contract_length || '',
            expected_start_date:
              data.hire_request_expected_start_date || data.start_date,
            salary_range_from:
              data.hire_request_salary_range_from || data.salary,
            salary_range_to: data.hire_request_salary_range_to || data.salary,
          },
        });

        hireRequestId = newHireRequest.id;
      } else {
        // Verify existing hire request belongs to the organization
        const existingHireRequest = await this.prisma.hireRequest.findFirst({
          where: {
            id: hireRequestId,
            org_id: data.organization_id,
          },
        });

        if (!existingHireRequest) {
          throw new BadRequestException(
            'Hire request not found or does not belong to the specified organization',
          );
        }
      }

      const statusHandled = staffStatusDictionary[data.status];

      const pipelineStatus = Object.keys(dbToStageDictionary).find((key) => {
        return dbToStageDictionary[key] === 'Hired';
      });
      if (!pipelineStatus)
        throw new NotFoundException(`Pipeline status not found for Hired`);
      await this.hubspot.updateOneCandidateFromHireRequest(
        candidate.hubspot_id,
        pipelineStatus,
        user.id,
      );

      const pipelineStatusLosers = Object.keys(dbToStageDictionary).find(
        (key) => {
          return dbToStageDictionary[key] === 'Available Candidates';
        },
      );
      if (!pipelineStatusLosers)
        throw new NotFoundException(
          `Pipeline status not found for Available Candidates`,
        );

      // Create staff and record candidate as winner in a transaction
      const result = await this.prisma.$transaction(async (tx) => {
        // Create the staff record
        const staff = await tx.staff.create({
          data: {
            candidate_id: data.candidate_id,
            hirerequest_id: hireRequestId,
            status: statusHandled,
            salary: data.salary,
            start_date: data.start_date,
            created_by: user.id,
          },
        });

        // Record candidate as winner for the hire request
        // First, check if there are any panels for this hire request
        const panels = await tx.candidatePanel.findMany({
          where: { hire_request_id: hireRequestId },
          select: { id: true },
        });
        console.log('panels', panels);
        if (panels.length > 0) {
          // Update panel candidates to mark this candidate as winnee
          await tx.panelCandidate.updateMany({
            where: {
              panel_id: { in: panels.map((p) => p.id) },
              candidate_id: data.candidate_id,
            },
            data: {
              status: 'selected_by_client',
            },
          });
          await tx.candidate.update({
            where: { id: candidate.id },
            data: { pipeline_status: pipelineStatus },
          });

          // Mark other candidates as returned to pool
          await tx.panelCandidate.updateMany({
            where: {
              panel_id: { in: panels.map((p) => p.id) },
              candidate_id: { not: data.candidate_id },
            },
            data: {
              status: 'returned_to_pool',
            },
          });

          const loserExists = await tx.panelCandidate.findMany({
            where: {
              panel_id: { in: panels.map((p) => p.id) },
              NOT: {
                candidate_id: candidate.id,
              },
            },
            select: {
              id: true,
              candidate: {
                select: {
                  id: true,
                  hubspot_id: true,
                  pipeline_status: true,
                  pipeline_status_origin: true,
                },
              },
            },
          });
          console.log('loserExists', loserExists);
          const candidateLosers = loserExists.map((c) => c.candidate);
          await Promise.all(
            candidateLosers.map(async (c) => {
              const pipeline_treated =
                c.pipeline_status_origin || pipelineStatusLosers;
              await this.prisma.candidate.update({
                where: { id: c.id },
                data: { pipeline_status: pipeline_treated },
              });
              await this.candidateAudit.log({
                candidateId: c.id,
                hubspotId: c.hubspot_id,
                actorUserId: user.id,
                event: CANDIDATE_AUDIT_EVENTS.PIPELINE_STATUS_CHANGED,
                fieldGroup: CandidateAuditFieldGroup.pipeline_status,
                before: { pipeline_status: c.pipeline_status },
                after: { pipeline_status: pipeline_treated },
                source: CandidateAuditSource.user,
              });
              await this.hubspot.updateOneCandidateFromHireRequest(
                c.hubspot_id,
                pipeline_treated,
                user.id,
              );
            }),
          );

          // Update panel status to decision_made
          await tx.candidatePanel.updateMany({
            where: { hire_request_id: hireRequestId },
            data: { status: 'decision_made' },
          });
        }

        // Update hire request status to placement_completed
        await tx.hireRequest.update({
          where: { id: hireRequestId },
          data: { status: 'placement_completed' },
        });

        return staff;
      });

      const staff = result;

      // Get the created staff with all relations
      const createdStaff = await this.prisma.staff.findUnique({
        where: { id: staff.id },
        select: {
          id: true,
          hirerequest_id: true,
          status: true,
          salary: true,
          start_date: true,
          created_at: true,
          updated_at: true,
          candidate: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
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
        },
      });

      return {
        status: 201,
        message: 'Staff created successfully for organization',
        data: createdStaff,
      };
    } catch (error) {
      console.log('error', error);
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException('Failed to create staff for organization');
    }
  }

  async populateDbFromHubspotX(): Promise<any> {
    const filterGroups = await this.buildBusinessUnitFilterGroups();

    const result = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/companies/search',
      {
        filterGroups,
        properties: [
          'agent_status',
          'business_unit',
          'address',
          'name',
          'hs_all_assigned_business_unit_ids',
          'description',
          'domain',
          'hs_all_accessible_team_ids',
          'hs_all_owner_ids',
          'hs_all_team_ids',
          'hs_num_open_deals',
          'hs_total_deal_value',
          'num_associated_deals',
        ],
        limit: 100,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );

    // Referred orgs are excluded: hard-deleting them would either crash on the
    // FK Restrict of AffiliateCommission/HubspotInvoiceSnapshot rows or silently
    // destroy Med Alliance referral history.
    await this.prisma.organization.deleteMany({
      where: {
        hubspot_id: { not: null },
        referred_by_affiliate_id: null,
      },
    });

    const dataMapped = result.data.results.map((org: any) => {
      return {
        ...org.properties,
        objectId: org.id,
      };
    });

    for (const org of dataMapped) {
      await this.organizationCreation.execute(org);
    }

    return 'db populated from hubspot successfully';
  }

  async populateDbFromHubspot(): Promise<any> {
    const BATCH_SIZE = 100; // HubSpot limita geralmente até 100 por request
    let hasMore = true;
    let after: string | undefined = undefined;
    const allOrganizations: any[] = [];

    // filterGroups are derived once from the currently-visible BUs and reused
    // across every page — visibility isn't expected to flip mid-pagination.
    const filterGroups = await this.buildBusinessUnitFilterGroups();

    // 1. Buscar todos os registros com paginação
    while (hasMore) {
      const body: any = {
        filterGroups,
        properties: [
          'agent_status',
          'business_unit',
          'address',
          'name',
          'hs_all_assigned_business_unit_ids',
          'description',
          'domain',
          'hs_all_accessible_team_ids',
          'hs_all_owner_ids',
          'hs_all_team_ids',
          'hs_num_open_deals',
          'hs_total_deal_value',
          'num_associated_deals',
        ],
        limit: BATCH_SIZE,
      };

      if (after) body.after = after;

      const result = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/companies/search',
        body,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        },
      );

      allOrganizations.push(...result.data.results);
      if (result.data.paging?.next?.after) {
        after = result.data.paging.next.after;
      } else {
        hasMore = false;
      }
    }

    // 2. Limpar registros antigos do HubSpot
    //await this.prisma.organization.deleteMany({
    //  where: { hubspot_id: { not: null } },
    //});

    const validColumns = [
      'id',
      'name',
      'email',
      'phone',
      'website_url',
      'location',
      'address',
      'city',
      'state',
      'postal_code',
      'description',
      'industry',
      'organization_role',
      'number_of_employees',
      'date_founded',
      'date_joined',
      'date_became_client',
      'status',
      'signed_document_url',
      'signed_document_date',
      'hubspot_id',
      'business_unit',
      'createdAt',
      'updatedAt',
      'owner_id',
      'admin_id',
      'specialties',
      'services',
    ];

    // 3. Mapear campos para seu schema
    const mappedOrganizations = allOrganizations.map((org) => {
      const mapped: any = { hubspot_id: org.id };
      for (const [hubspotKey, dbKey] of Object.entries(
        organizationToDbDictionary,
      )) {
        if (validColumns.includes(dbKey)) {
          let value = org.properties[hubspotKey] ?? null;

          if (['specialties', 'services'].includes(dbKey)) {
            if (!Array.isArray(value)) value = [];
          }

          if (dbKey === 'organization_role' && !value) {
            value = 'prospect'; // default definido no schema
          }

          mapped[dbKey] = value;
        }
      }
      return mapped;
    });

    // Referred orgs are excluded: hard-deleting them would either crash on the
    // FK Restrict of AffiliateCommission/HubspotInvoiceSnapshot rows or silently
    // destroy Med Alliance referral history.
    await this.prisma.organization.deleteMany({
      where: { hubspot_id: { not: null }, referred_by_affiliate_id: null },
    });

    // 4. Inserir tudo de uma vez (bulk insert)
    // Atenção: Prisma tem limite de parâmetros por insert (Postgres: 65535), então podemos dividir em chunks
    const CHUNK_SIZE = 500; // Ajuste conforme necessidade
    for (let i = 0; i < mappedOrganizations.length; i += CHUNK_SIZE) {
      const chunk = mappedOrganizations.slice(i, i + CHUNK_SIZE);
      await this.prisma.organization.createMany({
        data: chunk,
        skipDuplicates: true,
      });
    }

    return `DB populated from HubSpot successfully with ${mappedOrganizations.length} organizations`;
  }

  async desactiveWithoutStaff(): Promise<any> {
    const organizations = await this.prisma.organization.updateMany({
      where: {
        staff: {
          none: {},
        },
      },
      data: {
        status: 'inactive',
        organization_role: 'prospect',
      },
    });

    return organizations;
  }

  async syncOrganizationsWithDeals(): Promise<object> {
    /*
    1. get all active organizations
    2. for each organization, get all associated deals from hubspot
    3. if the organization does not exist with the hubspotId, create it
    4. for each organization, check if the associated deals exist as staff
    5. if the staff does not exist, create it
    */
    const arrayReturn: string[] = [];
    const chunkSize = 100;
    const concurrency = 5;
    const ALLOWED_PIPELINES = ['5155250', '85165570'];

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const organizations = await this.prisma.organization.findMany({
      where: {
        status: 'active',
        hubspot_id: { not: null },
      },
      select: {
        id: true,
        hubspot_id: true,
        name: true,
        staff: {
          select: {
            hubspot_id: true,
            candidate: { select: { id: true, hubspot_id: true } },
          },
        },
      },
    });

    const orgMap = new Map(organizations.map((o) => [o.hubspot_id, o]));
    const organizationsId = organizations.map((org) => org.hubspot_id);

    const chunks: any[] = [];
    for (let i = 0; i < organizationsId.length; i += chunkSize) {
      chunks.push(organizationsId.slice(i, i + chunkSize));
    }

    const processChunk = async (chunk: string[], index: number) => {
      try {
        const { data } = await axios.post(
          'https://api.hubapi.com/crm/v4/associations/company/deal/batch/read',
          { inputs: chunk.map((id) => ({ id })) },
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            timeout: 20000, // 20s by security
          },
        );

        // => Get DealIds
        const dealIds = new Set<string>();

        for (const result of data.results) {
          for (const assoc of result.to) {
            dealIds.add(String(assoc.toObjectId));
            //console.log(`Found deal association: Company ${result.from.id} -> Deal ${assoc.toObjectId}`);
          }
        }

        if (dealIds.size === 0) return;
        //==========

        // => Get deals on batch
        const dealPipelineMap = new Map<string, string>();
        const dealIdArray = Array.from(dealIds);

        for (let i = 0; i < dealIdArray.length; i += 100) {
          const dealChunk = dealIdArray.slice(i, i + 100);

          const { data: dealsData } = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/deals/batch/read',
            {
              properties: ['pipeline', 'dealstage'],
              inputs: dealChunk.map((id) => ({ id })),
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
              timeout: 20000,
            },
          );

          for (const deal of dealsData.results) {
            dealPipelineMap.set(
              String(deal.id),
              String(deal.properties.pipeline),
            );
          }

          await sleep(200); //to avoid rate limits on hubspot
        }
        //============

        const staffPromises: Promise<any>[] = [];

        for (const result of data.results) {
          const org = orgMap.get(result.from.id);

          if (!org) {
            staffPromises.push(
              this.organizationCreation
                .execute({ objectId: result.from })
                .then((newOrg) => {
                  if (newOrg)
                    arrayReturn.push(
                      `=> Organization ${result.from.id} created.`,
                    );
                }),
            );
            continue;
          }

          for (const assoc of result.to) {
            const dealHubspotId = String(assoc.toObjectId);
            const pipeline = dealPipelineMap.get(dealHubspotId);

            // => Ignore deals not in allowed pipelines
            if (!pipeline) continue;
            if (!ALLOWED_PIPELINES.includes(pipeline)) continue;
            //============

            const existingStaff = org.staff.find(
              (s) => s.hubspot_id == dealHubspotId,
            );

            if (existingStaff == undefined) {
              await this.sqs.sendMessage({
                QueueUrl: process.env.DEALS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  Type: 'CREATE_DEAL_STAFF',
                  objectId: dealHubspotId,
                  organization: {
                    id: org.id,
                    hubspot_id: org.hubspot_id,
                  },
                }),
              });

              arrayReturn.push(
                `=> Deal ${dealHubspotId} in organization ${org.name} queued for creation.`,
              );
              console.log(
                `=> Create Deal ${dealHubspotId} in organization ${org.name} .`,
              );
            } else {
              //verify if the staff is active but in pipeline_status different activePipelines
              const staffMember = await this.prisma.staff.findUnique({
                where: { hubspot_id: dealHubspotId.toString() },
                select: {
                  id: true,
                  status: true,
                  hubspot_dealstage: true,
                },
              });

              if (
                staffMember &&
                staffMember.status === 'active' &&
                !activePipelines.some(
                  ([key]) => key === staffMember.hubspot_dealstage,
                )
              ) {
                //update the staff to inactive - send new message to SQS

                await this.sqs.sendMessage({
                  QueueUrl: process.env.DEALS_QUEUE_URL,
                  MessageBody: JSON.stringify({
                    Type: 'DEACTIVATE_STAFF',
                    objectId: dealHubspotId,
                  }),
                });
                console.log(
                  `Staff ${staffMember.id} set to inactive due to dealstage ${staffMember.hubspot_dealstage}`,
                );
                arrayReturn.push(
                  `=> Deal ${dealHubspotId} in organization ${org.name} queued for deactivation.`,
                );
              }

              if (
                staffMember &&
                staffMember.status !== 'active' &&
                activePipelines.some(
                  ([key]) => key === staffMember.hubspot_dealstage,
                )
              ) {
                //update the staff to active - send new message to SQS

                await this.sqs.sendMessage({
                  QueueUrl: process.env.DEALS_QUEUE_URL,
                  MessageBody: JSON.stringify({
                    Type: 'REACTIVATE_STAFF',
                    objectId: dealHubspotId,
                  }),
                });

                console.log(
                  `Staff ${staffMember.id} reactivated due to dealstage ${staffMember.hubspot_dealstage}`,
                );
                arrayReturn.push(
                  `=> Deal ${dealHubspotId} in organization ${org.name} queued for activation.`,
                );
              }
            }
          }
        }

        const results = await Promise.allSettled(staffPromises);

        results.forEach((r) => {
          if (r.status === 'rejected') {
            console.error('❌ Error processing staff:', r.reason);
          }
        });
      } catch (error) {
        console.error(
          `Error in batch ${index + 1}:`,
          axios.isAxiosError(error) ? error.response?.data : error,
        );
      }
    };

    const queue: Promise<void>[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const task = processChunk(chunks[i], i);
      queue.push(task);
      if (queue.length >= concurrency) {
        await Promise.allSettled(queue);
        queue.length = 0;
      }
    }
    if (queue.length) await Promise.allSettled(queue);

    await this.prisma.sync.create({
      data: { role: 'organizations', last_synced_at: new Date() },
    });

    return {
      message: 'Organization sync with deals completed',
      status: 200,
      data: { arrayReturn },
    };
  }

  async getOrganizationIndustryTypes(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/companies';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'industry',
      );

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find industry types:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find Organization Industry types');
    }
  }

  async getOrganizationTypes(): Promise<any> {
    try {
      const url = 'https://api.hubapi.com/crm/v3/properties/companies';
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });

      const vaTypeProperty = response.data.results.find(
        (prop) => prop.name === 'type',
      );

      if (!vaTypeProperty) {
        return [];
      }

      return vaTypeProperty.options || [];
    } catch (error) {
      console.error(
        'Failed to find Organization Type:',
        error.response?.data || error.message,
      );
      throw new Error('Failed to find Organization Type');
    }
  }

  async checkOrganizationNameExists(name: string): Promise<boolean> {
    if (!name?.trim()) return false;
    const found = await this.prisma.organization.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        status: { not: OrganizationStatus.deleted },
      },
      select: { id: true },
    });
    return found !== null;
  }
}
