import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseGuards,
  Query,
  HttpCode,
} from '@nestjs/common';
import { USER } from '@prisma/client';
import {
  ApiBody,
  ApiParam,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CandidatesService } from './candidates.service';

import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

import { UpdateCandidateDto } from './dto/update-candidate.dto';
import { updateStatusHubspotDTO } from './dto/updateStatus-candidate.dto';
import { EndorseCandidateDto } from './dto/endorse-candidate.dto';
import { RemoveCandidateDto } from './dto/remove-candidate.dto';
import { RemoveCandidateAndCancelDto } from './dto/remove-candidate-and-cancel.dto';

@ApiTags('candidates')
@ApiBearerAuth()
@Controller('candidates')
export class CandidatesController {
  constructor(private readonly candidatesService: CandidatesService) {}

  @Get()
  @ApiOperation({
    summary:
      "Get all candidates for the current user's organization filtered by status",
  })
  @ApiQuery({
    name: 'country',
    required: false,
    type: String,
    description: 'Filter candidates by country of residence',
    example: 'USA, France, Brazil',
  })
  @ApiQuery({
    name: 'shift_block',
    required: false,
    type: String,
    description: 'Filter candidates by shift block from hubspot',
    example: 'Flexible, Full Time',
  })
  @ApiQuery({
    name: 'availiability',
    required: false,
    type: String,
    description: 'Filter candidates by avaliability',
    example: 'Full-time, Part-time',
  })
  @ApiQuery({
    name: 'monthly_compensation_from',
    required: false,
    type: String,
    description: 'Filter candidates by monthly compensations start',
    example: '1000',
  })
  @ApiQuery({
    name: 'monthly_compensation_to',
    required: false,
    type: String,
    description: 'Filter candidates by monthly compensations end',
    example: '5000',
  })
  @ApiQuery({
    name: 'years_of_experience',
    required: false,
    type: Number,
    description: 'Filter candidates by years of experience',
    example: '5',
  })
  @ApiQuery({
    name: 'specializations',
    required: false,
    type: Number,
    description: 'Filter candidates by specializations',
    example: 'pediatric',
  })
  @ApiQuery({
    name: 'skills',
    required: false,
    type: Number,
    description: 'Filter candidates by skills',
    example: 'office, communication',
  })
  @ApiQuery({
    name: 'languages',
    required: false,
    type: Number,
    description: 'Filter candidates by languages spoken',
    example: 'English, Spanish',
  })
  @ApiQuery({
    name: 'all',
    required: false,
    type: Boolean,
    description: 'If true, returns all candidates without pagination',
  })
  // Deactivated in favor of `core_skills_fields` — see ApiQuery below. Param
  // is still accepted (and silently ignored) for backward compatibility.
  // @ApiQuery({
  //   name: 'scorecard_fields',
  //   required: false,
  //   type: String,
  //   description:
  //     'Comma-separated list of VA score card fields to filter by (candidates must have a value for each field)',
  //   example:
  //     'speaks_clearly_and_professionally,stable_internet_connection__min__20_mbps_',
  // })
  @ApiQuery({
    name: 'tools',
    required: false,
    type: String,
    description: 'Comma-separated list of tools to filter by (OR logic)',
    example: 'Zoom,Google Workspace',
  })
  @ApiQuery({
    name: 'medical_tools',
    required: false,
    type: String,
    description: 'Comma-separated list of medical tools to filter by (OR logic)',
    example: 'Athena,eClinicalWorks',
  })
  @ApiQuery({
    name: 'core_skills_fields',
    required: false,
    type: String,
    description:
      'Comma-separated list of "field:value" pairs to filter Core Skills (VA Score Card extended) by exact value. Restricted to system_admin/system_super_admin.',
    example: 'quickbooks:5,claim_generation:8',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidates retrieved successfully',
  })
  @ApiResponse({ status: 400, description: 'Failed to fetch candidates' })
  @UseGuards(AuthGuard)
  async findAll(
    @CurrentUser() user: USER,
    @Query('country') country: string,
    @Query('shift_block') shift_block: string,
    @Query('availability') availability: string,
    @Query('monthly_compensation_from') monthly_compensation_from: string,
    @Query('monthly_compensation_to') monthly_compensation_to: string,
    @Query('years_of_experience') years_of_experience: string,
    @Query('specializations') specializations: string,
    @Query('positions') positions: string,
    @Query('skills') skills: string,
    @Query('languages') languages: string,
    @Query('page') page,
    @Query('perPage') perPage,
    @Query('search') search: string,
    @Query('all') all: string,
    @Query('scorecard_fields') scorecard_fields: string,
    @Query('tools') tools: string,
    @Query('medical_tools') medical_tools: string,
    @Query('core_skills_fields') core_skills_fields: string,
  ) {
    const result = await this.candidatesService.findAll(
      user,
      country,
      shift_block,
      availability,
      monthly_compensation_from,
      monthly_compensation_to,
      years_of_experience,
      specializations,
      positions,
      skills,
      languages,
      page,
      perPage,
      search,
      all,
      scorecard_fields,
      tools,
      medical_tools,
      core_skills_fields,
    );
    return result;
  }

  //Endpoint that should be used only for alliance module
  @Get('for-alliance')
  @ApiOperation({
    summary:
      "Get all candidates for the current user's organization filtered by status",
  })
  @ApiQuery({
    name: 'country',
    required: false,
    type: String,
    description: 'Filter candidates by country of residence',
    example: 'USA, France, Brazil',
  })
  @ApiQuery({
    name: 'shift_block',
    required: false,
    type: String,
    description: 'Filter candidates by shift block from hubspot',
    example: 'Flexible, Full Time',
  })
  @ApiQuery({
    name: 'availiability',
    required: false,
    type: String,
    description: 'Filter candidates by avaliability',
    example: 'Full-time, Part-time',
  })
  @ApiQuery({
    name: 'monthly_compensation_from',
    required: false,
    type: String,
    description: 'Filter candidates by monthly compensations start',
    example: '1000',
  })
  @ApiQuery({
    name: 'monthly_compensation_to',
    required: false,
    type: String,
    description: 'Filter candidates by monthly compensations end',
    example: '5000',
  })
  @ApiQuery({
    name: 'years_of_experience',
    required: false,
    type: Number,
    description: 'Filter candidates by years of experience',
    example: '5',
  })
  @ApiQuery({
    name: 'specializations',
    required: false,
    type: Number,
    description: 'Filter candidates by specializations',
    example: 'pediatric',
  })
  @ApiQuery({
    name: 'skills',
    required: false,
    type: Number,
    description: 'Filter candidates by skills',
    example: 'office, communication',
  })
  @ApiQuery({
    name: 'languages',
    required: false,
    type: Number,
    description: 'Filter candidates by languages spoken',
    example: 'English, Spanish',
  })
  @ApiQuery({
    name: 'all',
    required: false,
    type: Boolean,
    description: 'If true, returns all candidates without pagination',
  })
  // Deactivated in favor of `core_skills_fields` — see ApiQuery below. Param
  // is still accepted (and silently ignored) for backward compatibility.
  // @ApiQuery({
  //   name: 'scorecard_fields',
  //   required: false,
  //   type: String,
  //   description:
  //     'Comma-separated list of VA score card fields to filter by (candidates must have a value for each field)',
  //   example:
  //     'speaks_clearly_and_professionally,stable_internet_connection__min__20_mbps_',
  // })
  @ApiQuery({
    name: 'tools',
    required: false,
    type: String,
    description: 'Comma-separated list of tools to filter by (OR logic)',
    example: 'Zoom,Google Workspace',
  })
  @ApiQuery({
    name: 'medical_tools',
    required: false,
    type: String,
    description: 'Comma-separated list of medical tools to filter by (OR logic)',
    example: 'Athena,eClinicalWorks',
  })
  @ApiQuery({
    name: 'core_skills_fields',
    required: false,
    type: String,
    description:
      'Comma-separated list of "field:value" pairs to filter Core Skills (VA Score Card extended) by exact value. Restricted to system_admin/system_super_admin.',
    example: 'quickbooks:5,claim_generation:8',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidates retrieved successfully',
  })
  @ApiResponse({ status: 400, description: 'Failed to fetch candidates' })
  @UseGuards(AuthGuard)
  async findAllForAlliance(
    @CurrentUser() user: USER,
    @Query('country') country: string,
    @Query('shift_block') shift_block: string,
    @Query('availability') availability: string,
    @Query('monthly_compensation_from') monthly_compensation_from: string,
    @Query('monthly_compensation_to') monthly_compensation_to: string,
    @Query('years_of_experience') years_of_experience: string,
    @Query('specializations') specializations: string,
    @Query('positions') positions: string,
    @Query('skills') skills: string,
    @Query('languages') languages: string,
    @Query('page') page,
    @Query('perPage') perPage,
    @Query('search') search: string,
    @Query('all') all: string,
    @Query('scorecard_fields') scorecard_fields: string,
    @Query('tools') tools: string,
    @Query('medical_tools') medical_tools: string,
    @Query('core_skills_fields') core_skills_fields: string,
  ) {
    const result = await this.candidatesService.findAllForAlliance(
      user,
      country,
      shift_block,
      availability,
      monthly_compensation_from,
      monthly_compensation_to,
      years_of_experience,
      specializations,
      positions,
      skills,
      languages,
      page,
      perPage,
      search,
      all,
      scorecard_fields,
      tools,
      medical_tools,
      core_skills_fields,
    );
    return result;
  }

  @Get('candidate/:id')
  @ApiOperation({ summary: 'Get a specific candidate by ID' })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({ status: 200, description: 'Candidate retrieved successfully' })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @ApiResponse({ status: 401, description: 'Candidate not found' })
  @UseGuards(AuthGuard)
  async findOne(@Param('id') id: string, @CurrentUser() user: USER) {
    const result = await this.candidatesService.findOne(id, user);
    return {
      status: 200,
      message: 'Candidate retrieved successfully',
      data: result,
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a specific candidate by ID' })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({ status: 200, description: 'Candidate updated successfully' })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @UseGuards(AuthGuard)
  async update(@Param('id') id: string, @Body() data: UpdateCandidateDto) {
    const result = await this.candidatesService.update(id, data);
    return {
      status: 200,
      message: 'Candidate updated successfully',
      data: result,
    };
  }

  @Get('/process-data/:id')
  @ApiOperation({ summary: 'Process data for a specific candidate by ID' })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidate data processed successfully',
  })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @UseGuards(AuthGuard)
  async processData(@Param('id') id: string) {
    const result = await this.candidatesService.processData(id);
    return {
      status: 200,
      message: 'Candidate data processed successfully',
    };
  }

  @Get('/process-avatar/:id')
  @ApiOperation({ summary: 'Process data for a specific candidate by ID' })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidate data processed successfully',
  })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @UseGuards(AuthGuard)
  async processAvatar(@Param('id') id: string) {
    const result = await this.candidatesService.processAvatar(id);
    return {
      status: 200,
      message: 'Candidate Avatar processed successfully',
    };
  }

  @Get('/pipelines/all')
  @ApiOperation({ summary: 'Get all pipelines' })
  @ApiResponse({ status: 200, description: 'Pipelines retrieved successfully' })
  @UseGuards(AuthGuard)
  async getPipelines() {
    const result = await this.candidatesService.getPipelines();
    return {
      status: 200,
      message: 'Pipelines retrieved successfully',
      data: result,
    };
  }

  @Get('properties/all')
  @ApiOperation({ summary: 'Get all countries from HubSpot' })
  @UseGuards(AuthGuard)
  @HttpCode(200)
  @ApiQuery({
    name: 'fields',
    required: false,
    type: String,
    description: 'fields properties ',
    example: 'country,specialization, languages, skills, salary_range',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns properties from Candidates',
  })
  async getCountries(@Query() fields: string) {
    const result = await this.candidatesService.getProperties(fields);
    return result;
  }

  @Post('update-status/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Update status of candidates and reflect it on Hubspot',
  })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiBody({ type: updateStatusHubspotDTO })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @ApiResponse({ status: 400, description: 'Status data is required' })
  @ApiResponse({ status: 400, description: 'Invalid status provided' })
  @ApiResponse({ status: 404, description: 'Candidate not found' })
  @ApiResponse({
    status: 400,
    description: 'Failed to update candidate status in HubSpot',
  })
  @ApiResponse({
    status: 400,
    description: 'Failed to update candidate status',
  })
  @UseGuards(AuthGuard)
  async updateStatus(
    @Param('id') id: string,
    @Body() data: updateStatusHubspotDTO,
  ) {
    const result = await this.candidatesService.updateStatusHubspot(id, data);
    return {
      status: 200,
      message: 'Status updated successfully',
      data: result,
    };
  }

  @Get('/show-match-hirerequests/:idCandidate')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_super_admin', 'system_admin')
  @ApiOperation({
    description: 'Show possible hire requests for a specific candidate',
  })
  @ApiParam({
    name: 'candidateId',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({ status: 200, description: 'Data retrieved successfully' })
  @ApiResponse({
    status: 404,
    description: 'User not found or not part of an organization',
  })
  @ApiResponse({ status: 404, description: 'User role not found' })
  async matchHireRequest(
    @CurrentUser() user: USER,
    @Param('idCandidate') candidateId: string,
  ) {
    const result = await this.candidatesService.showMatchHireRequests(
      user,
      candidateId,
    );
    return {
      status: 200,
      message: 'Data retrieved successfully',
      data: result,
    };
  }

  @Post('endorse-candidate')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Endorse candidates in an existing panel' })
  @ApiBody({ type: EndorseCandidateDto })
  @ApiResponse({ status: 200, description: 'Candidate endorsed successfully' })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @ApiResponse({ status: 400, description: 'Hire Request ID is required' })
  @ApiResponse({ status: 400, description: 'Failed to endorse candidate' })
  async endorseCandidate(
    @Body() data: EndorseCandidateDto,
    @CurrentUser() user: USER,
  ) {
    const result = await this.candidatesService.endorseCandidate(data, user);
    return {
      status: 200,
      message: 'Candidate endorsed successfully',
      data: result,
    };
  }

  @Post('remove-candidate')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Remove candidates from an existing panel' })
  @ApiBody({ type: RemoveCandidateDto })
  @ApiResponse({ status: 200, description: 'Candidate removed successfully' })
  @ApiResponse({ status: 400, description: 'Candidate ID is required' })
  @ApiResponse({ status: 400, description: 'Hire Request ID is required' })
  @ApiResponse({
    status: 404,
    description: 'Hire Request not found in candidate panel',
  })
  @ApiResponse({ status: 400, description: 'Failed to remove candidate' })
  async removeCandidate(
    @Body() data: RemoveCandidateDto,
    @CurrentUser() user: USER,
  ) {
    const result = await this.candidatesService.removeCandidate(data, user);
    return {
      status: 200,
      message: 'Candidate removed successfully',
      data: result,
    };
  }

  @Post('remove-candidate-and-cancel')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary:
      'Remove the last candidate from a panel and cancel the hire request atomically',
  })
  @ApiBody({ type: RemoveCandidateAndCancelDto })
  @ApiResponse({
    status: 200,
    description: 'Candidate removed and hire request cancelled',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or invalid state',
  })
  @ApiResponse({
    status: 404,
    description: 'Candidate or hire request not found',
  })
  async removeCandidateAndCancel(
    @Body() data: RemoveCandidateAndCancelDto,
    @CurrentUser() user: USER,
  ) {
    const result = await this.candidatesService.removeCandidateAndCancel(
      data,
      user,
    );
    return {
      status: 200,
      message: 'Candidate removed and hire request cancelled successfully',
      data: result,
    };
  }

  @Get('process-all-avatars')
  @ApiOperation({
    summary: 'Process avatars for all candidates without an avatar',
  })
  @ApiResponse({
    status: 200,
    description: 'Avatar processing initiated successfully',
  })
  @UseGuards(AuthGuard)
  async processAllAvatars() {
    const result = await this.candidatesService.processAllAvatars();
    return {
      status: 200,
      message: 'Avatar processing initiated successfully',
      data: result,
    };
  }

  @Get('talent-pool/random')
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get 10 random candidates from talent pool (public endpoint)',
    description:
      'Returns 10 random candidates from the talent pool without sensitive information. No authentication required. Rate limited to 10 requests per minute.',
  })
  @ApiResponse({
    status: 200,
    description: 'Random candidates retrieved successfully',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests. Rate limit exceeded.',
  })
  async getRandomTalentPoolCandidates(
    @Query('business_unit') business_unit: string,
  ) {
    const result =
      await this.candidatesService.getRandomTalentPoolCandidates(business_unit);
    return {
      status: 200,
      message: 'Random candidates retrieved successfully',
      data: result.candidates,
      count: result.candidates.length,
      totalTable: result.totalTable,
    };
  }

  @Get('talent-pool/:id')
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Get a specific candidate from talent pool by ID (public endpoint)',
    description:
      'Returns a specific candidate from the talent pool by ID without sensitive information. No authentication required. Rate limited to 10 requests per minute.',
  })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidate retrieved successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid candidate ID',
  })
  @ApiResponse({
    status: 404,
    description: 'Candidate not found or not available in talent pool',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests. Rate limit exceeded.',
  })
  async getTalentPoolCandidateById(@Param('id') id: string) {
    const candidate =
      await this.candidatesService.getTalentPoolCandidateById(id);
    return {
      status: 200,
      message: 'Candidate retrieved successfully',
      data: candidate,
    };
  }

  @Get('talent-pool-for-logged-user/:id')
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 requests per minute
  @UseGuards(AuthGuard)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Get a specific candidate from talent pool by ID (public endpoint)',
    description:
      'Returns a specific candidate from the talent pool by ID without sensitive information. No authentication required. Rate limited to 10 requests per minute.',
  })
  @ApiParam({
    name: 'id',
    required: true,
    type: String,
    description: 'Candidate ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Candidate retrieved successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid candidate ID',
  })
  @ApiResponse({
    status: 404,
    description: 'Candidate not found or not available in talent pool',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests. Rate limit exceeded.',
  })
  async getTalentPoolCandidateByIdForLoggedUser(
    @Param('id') id: string,
    @CurrentUser() user: USER,
  ) {
    const candidate =
      await this.candidatesService.getTalentPoolCandidateByIdForLoggedUser(
        id,
        user,
      );
    return {
      status: 200,
      message: 'Candidate retrieved successfully',
      data: candidate,
    };
  }

  @Get('sync-business-unit-count')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync Business Unit Candidate Count (public endpoint)',
    description: 'Update database with Business Unit from hubspot',
  })
  @ApiQuery({
    name: 'business_unit',
    required: true,
    type: String,
    description: 'Business unit to filter candidates',
    example: 'healthcare',
  })
  @ApiResponse({
    status: 200,
    description: 'Total count retrieved successfully',
  })
  async syncBusinessUnits() {
    const result = await this.candidatesService.syncBusinessUnits();
    return {
      status: 200,
      message: 'Business Unit Candidate Count synced successfully',
      data: result,
    };
  }

  @Get('sync-va-score-card')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync VA Score Card fields from HubSpot',
    description:
      'Fetches all VA Score Card fields from HubSpot and updates available candidates in the database. One-way sync: HubSpot → Platform.',
  })
  @ApiResponse({
    status: 200,
    description: 'VA Score Card fields synced successfully',
  })
  async syncVaScoreCardFields() {
    const result = await this.candidatesService.syncVaScoreCardFields();
    return {
      status: 200,
      message: 'VA Score Card fields synced successfully',
      data: result,
    };
  }

  @Get('sync-core-skills')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sync Core Skills fields from HubSpot',
    description:
      'Fetches all Core Skills fields (VA Score Card extended — Bookkeeping, Medical/Dental Admin, Medical/Dental Biller, Sales Executive, SDR, Sales & Account Manager) from HubSpot and updates available candidates in the database. One-way sync: HubSpot → Platform.',
  })
  @ApiResponse({
    status: 200,
    description: 'Core Skills fields synced successfully',
  })
  async syncCoreSkillsFields() {
    const result = await this.candidatesService.syncCoreSkillsFields();
    return {
      status: 200,
      message: 'Core Skills fields synced successfully',
      data: result,
    };
  }
}
