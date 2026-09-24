/* istanbul ignore file */
import {
  Body,
  Controller,
  Get,
  Param,
  UseGuards,
  Patch,
  Delete,
  Query,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';

import { UserService } from './user.service';
import { AuthGuard } from '../auth/auth.guard';
import { UpdateUserDto } from './dto/updateUser.dto';
import { UpdateProfileDto } from './dto/updateProfile.dto';
import { GetProfileDto } from './dto/getProfile.dto';
import { SearchUsersDto } from './dto/searchUsers.dto';
import { GetOrganizationUsersDto } from './dto/getOrganizationUsers.dto';
import { InviteUserToOrganizationDto } from './dto/inviteUserToOrganization.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { USER } from '@prisma/client';
import { UserAuditService } from '../user-audit/user-audit.service';
import { ListUserAuditLogsDto } from '../user-audit/dto/list-user-audit-logs.dto';

@ApiTags('User')
@ApiBearerAuth()
@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly userAuditService: UserAuditService,
  ) {}

  @Get('profile')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get current user profile with organization details',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile retrieved successfully.',
    type: GetProfileDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getCurrentUserProfile(@CurrentUser() user: USER) {
    return this.userService.getCurrentUserProfile(user.id);
  }

  @Patch('profile')
  @UseGuards(AuthGuard)
  @ApiBody({ type: UpdateProfileDto })
  @ApiOperation({
    summary: 'Update current user profile (email cannot be modified)',
  })
  @ApiResponse({
    status: 200,
    description: 'Profile updated successfully.',
    type: GetProfileDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid profile data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Insufficient permissions for organization fields',
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateCurrentUserProfile(
    @CurrentUser() user: USER,
    @Body() profileData: UpdateProfileDto,
  ) {
    // Check permissions for organization fields
    const organizationFields = [
      'organization_name',
      'organization_description',
      'organization_website_url',
      'organization_industry',
      'organization_number_of_employees',
      'organization_location',
      'organization_date_founded',
      'organization_specialties',
    ];

    const systemAdminFields = ['organization_role', 'signed_document_url'];

    // Check if user is trying to update organization fields
    const hasOrganizationFields = organizationFields.some(
      (field) => profileData[field] !== undefined,
    );

    const hasSystemAdminFields = systemAdminFields.some(
      (field) => profileData[field] !== undefined,
    );

    // Organization fields can only be updated by organization admins and owners
    if (
      hasOrganizationFields &&
      !['organization_admin', 'organization_super_admin'].includes(user.role)
    ) {
      throw new UnauthorizedException(
        'Insufficient permissions to update organization fields',
      );
    }

    // System admin fields can only be updated by system admins
    if (
      hasSystemAdminFields &&
      !['system_admin', 'system_super_admin'].includes(user.role)
    ) {
      throw new UnauthorizedException(
        'Insufficient permissions to update system admin fields',
      );
    }

    return this.userService.updateProfile(user.id, profileData);
  }

  @Get('search')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Search users for organization owner assignment' })
  @ApiResponse({ status: 200, description: 'Users found successfully.' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for name, email, or job title',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    type: String,
    description: 'Filter by user role',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter by user status',
  })
  @ApiQuery({
    name: 'organization_id',
    required: false,
    type: String,
    description: 'Filter by organization ID',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of results to return (no maximum limit)',
  })
  async searchUsers(@Query() query: SearchUsersDto) {
    return this.userService.searchUsers(query);
  }

  @Get('search/organization-users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @ApiOperation({ summary: 'Search organization admin and super admin users' })
  @ApiResponse({ status: 200, description: 'Users found successfully.' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for name, email, or job title',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter by user status',
  })
  @ApiQuery({
    name: 'organization_id',
    required: false,
    type: String,
    description: 'Filter by organization ID',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of results to return',
  })
  async searchOrganizationUsers(@Query() query: SearchUsersDto) {
    return this.userService.searchOrganizationUsers(query);
  }

  // Must stay above @Get(':id') — keeps 'admin' from ever being read as an :id.
  @Get('admin/audit-logs')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin')
  @ApiOperation({
    summary: 'List USER lifecycle audit logs (system owner only)',
  })
  @ApiQuery({ type: ListUserAuditLogsDto })
  @ApiResponse({
    status: 200,
    description: 'Audit logs retrieved successfully',
  })
  async listAuditLogs(@Query() query: ListUserAuditLogsDto) {
    const result = await this.userAuditService.findAllLogs(query);
    return {
      status: 200,
      message: 'Audit logs retrieved successfully',
      ...result,
    };
  }

  @Get(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin')
  @ApiOperation({ summary: 'Get user using ID' })
  @ApiResponse({ status: 200, description: 'User found successfully.' })
  async getUserById(@Param('id') id: string) {
    return this.userService.findById(id);
  }

  @Get('organization/:organizationId')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin')
  @ApiOperation({ summary: 'Get all users of the specific organization' })
  @ApiResponse({ status: 200, description: 'Users found successfully.' })
  @ApiResponse({
    status: 404,
    description: 'No users found in this organization.',
  })
  async getUsersByOrganizationId(
    @Param('organizationId') organizationId: string,
  ) {
    return this.userService.findByOrganizationId(organizationId);
  }

  @Get('organization/:organizationId/paginated')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin', 'organization_super_admin')
  @ApiOperation({ summary: 'Get paginated users of a specific organization' })
  @ApiResponse({ status: 200, description: 'Users found successfully.' })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    type: String,
    description: 'Filter by role',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description: 'Sort by field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    type: String,
    description: 'Sort order',
  })
  @ApiQuery({
    name: 'date_created_from',
    required: false,
    type: String,
    description:
      'Filter by creation date from (ISO date string, e.g., 2025-01-01)',
  })
  @ApiQuery({
    name: 'date_created_to',
    required: false,
    type: String,
    description:
      'Filter by creation date to (ISO date string, e.g., 2025-10-09)',
  })
  async getOrganizationUsersPaginated(
    @Param('organizationId') organizationId: string,
    @Query() query: GetOrganizationUsersDto,
    @CurrentUser() user: USER,
  ) {
    // Check if user has access to this organization
    if (
      user.role === 'organization_super_admin' &&
      user.organization_id !== organizationId
    ) {
      throw new UnauthorizedException('Access denied to this organization');
    }

    return this.userService.getOrganizationUsersPaginated(
      organizationId,
      query,
    );
  }

  @Post('organization/:organizationId/invite')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin', 'organization_super_admin')
  @ApiOperation({ summary: 'Invite a new user to an organization' })
  @ApiResponse({ status: 201, description: 'User invited successfully.' })
  @ApiResponse({
    status: 400,
    description: 'User already exists or invalid data.',
  })
  @ApiResponse({ status: 404, description: 'Organization not found.' })
  @ApiResponse({
    status: 403,
    description: 'Access denied to this organization.',
  })
  async inviteUserToOrganization(
    @Param('organizationId') organizationId: string,
    @Body() inviteData: InviteUserToOrganizationDto,
    @CurrentUser() user: USER,
  ) {
    // Check if user has access to this organization
    if (
      user.role === 'organization_super_admin' &&
      user.organization_id !== organizationId
    ) {
      throw new UnauthorizedException('Access denied to this organization');
    }

    return this.userService.inviteUserToOrganization(
      organizationId,
      inviteData,
      user,
    );
  }

  @Get('organization/users/by-current-user')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @ApiOperation({
    summary: 'Get all users of the organization from current User',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by user status',
    enum: ['active', 'inactive', 'invited', 'suspended'],
  })
  @ApiResponse({ status: 200, description: 'Users found successfully.' })
  @ApiResponse({
    status: 404,
    description: 'No users found in this organization.',
  })
  async findUsersByOrganizationByCurrentUser(
    @CurrentUser() user: USER,
    @Query('status') status?: string,
  ) {
    return this.userService.findUsersByOrganizationByCurrentUser(user, status);
  }

  @Get('system-users/all')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin')
  @ApiOperation({ summary: 'Get all system users' })
  @ApiResponse({ status: 200, description: 'System users found successfully.' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for name or email',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'inactive', 'invited'],
    description: 'Filter system users by their account status',
  })
  async getAllSystemUsers(
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
  ) {
    return this.userService.getAllSystemUsers(search, page, perPage, status);
  }

  @Patch(':id')
  @ApiBody({ type: UpdateUserDto })
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin', 'organization_super_admin')
  @ApiOperation({ summary: 'Update user (admin only)' })
  @ApiResponse({ status: 200, description: 'User updated successfully.' })
  @ApiResponse({ status: 400, description: 'Failed to update user' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateUser(
    @Param('id') id: string,
    @Body() userData: UpdateUserDto,
    @CurrentUser() currentUser: USER,
  ) {
    //console.log('UpdateUser called by', userData, 'for user ID', id);
    // Check if organization admin is trying to update users in their organization
    if (currentUser.role === 'organization_super_admin') {
      const targetUser = await this.userService.findById(id);
      if (
        !targetUser ||
        targetUser.organization_id !== currentUser.organization_id
      ) {
        throw new UnauthorizedException('Access denied to update this user');
      }
    }

    return this.userService.update(id, userData, currentUser.id);
  }

  @Patch('profile/:id')
  @ApiBody({ type: UpdateUserDto })
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Update user profile (self or admin)' })
  @ApiResponse({
    status: 200,
    description: 'User profile updated successfully.',
  })
  @ApiResponse({ status: 400, description: 'Failed to update user profile' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async updateUserProfile(
    @Param('id') id: string,
    @Body() userData: UpdateUserDto,
    @CurrentUser() currentUser: USER,
  ) {
    // Users can only update their own profile, or admins can update any profile
    if (
      currentUser.id !== id &&
      ![
        'system_super_admin',
        'system_admin',
        'organization_super_admin',
      ].includes(currentUser.role)
    ) {
      throw new UnauthorizedException('You can only update your own profile');
    }

    // Organization admins can only update users in their organization
    if (
      currentUser.role === 'organization_super_admin' &&
      currentUser.id !== id
    ) {
      const targetUser = await this.userService.findById(id);
      if (
        !targetUser ||
        targetUser.organization_id !== currentUser.organization_id
      ) {
        throw new UnauthorizedException('Access denied to update this user');
      }
    }

    return this.userService.update(id, userData, currentUser.id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @ApiOperation({
    summary: 'Delete user',
    description:
      'Permanently deletes a user and all related data. Handles foreign key constraints by cleaning up related records first. Cannot delete system super admins or users who are the only admin/owner of an organization.',
  })
  @Roles('system_super_admin', 'organization_super_admin')
  @ApiResponse({
    status: 200,
    description: 'User deleted successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Failed to delete user - may be due to foreign key constraints, security restrictions, or business rules',
  })
  @ApiResponse({
    status: 404,
    description: 'User not found',
  })
  @ApiResponse({
    status: 403,
    description: 'Insufficient permissions',
  })
  async deleteUser(@Param('id') id: string, @CurrentUser() currentUser: USER) {
    return this.userService.delete(id, currentUser.id);
  }

  @Patch('update-status/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin')
  @ApiOperation({ summary: 'Update user status from prospect to client' })
  @ApiResponse({ status: 200, description: 'User updated successfully.' })
  @ApiResponse({ status: 400, description: 'Failed to update user' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateStatus(
    @Param('id') id: string,
    @CurrentUser() currentUser: USER,
  ) {
    return this.userService.updateStatus(id, currentUser.id);
  }
}
