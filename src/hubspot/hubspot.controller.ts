import {
  Controller,
  Post,
  UseGuards,
  HttpCode,
  Body,
  Get,
  Query,
  Param,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HubspotService } from './hubspot.service';
import { HubspotAuditService } from './hubspot-audit.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GetCandidatesDto } from './dto/get-candidates.dto';
import { ListHubspotAuditLogsDto } from './dto/list-hubspot-audit-logs.dto';

@ApiTags('hubspot')
@ApiBearerAuth()
@Controller('hubspot')
export class HubspotController {
  constructor(
    private readonly hubspotService: HubspotService,
    private readonly hubspotAuditService: HubspotAuditService,
  ) { }

  @Get('admin/audit-logs')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('system_admin', 'system_super_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'List all HubSpot audit logs (admin only)' })
  @ApiQuery({ type: ListHubspotAuditLogsDto })
  @ApiResponse({
    status: 200,
    description: 'Audit logs retrieved successfully',
  })
  async listAuditLogs(@Query() query: ListHubspotAuditLogsDto) {
    const result = await this.hubspotAuditService.findAllLogs(query);
    return {
      status: 200,
      message: 'Audit logs retrieved successfully',
      ...result,
    };
  }

  @Post('candidates')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('user', 'admin', 'system_super_admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get candidates from HubSpot with dynamic filters' })
  @ApiBody({
    type: GetCandidatesDto,
    description: 'Data to get candidates from HubSpot',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Returns candidates below dynamic filters',
  })
  @ApiResponse({ status: 400, description: 'Data is required' })
  @ApiResponse({
    status: 400,
    description: 'Virtual Assistant identifier is required',
  })
  @ApiResponse({ status: 400, description: 'Error fetching candidates' })
  async getCandidates(@Body() data: GetCandidatesDto) {
    return this.hubspotService.getCandidates(data);
  }

  @Post('webhook')
  @ApiOperation({
    summary: 'Receive and process incoming HubSpot webhook events',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async webhook(@Body() data: any) {
    console.log('Webhook received:', data);
    return this.hubspotService.changeDataFromHubspot(data);
  }

  @Post('create-candidates')
  @ApiOperation({
    summary:
      'Create candidate records by importing data from a specific HubSpot pipeline stage',
  })
  @ApiQuery({
    name: 'pipeline_stage',
    required: true,
    description: 'Pipeline stage to filter candidates',
  })
  @ApiResponse({ status: 200, description: 'Candidates created successfully' })
  @UseGuards(AuthGuard)
  async createCandidates(@Query('pipeline_stage') pipeline_stage: string) {
    return this.hubspotService.createCandidates(pipeline_stage);
  }

  @Post('update-candidates')
  @ApiOperation({
    summary:
      'Update existing candidate records with fresh data from a specific HubSpot pipeline stage',
  })
  @ApiQuery({
    name: 'pipeline_stage',
    required: true,
    description: 'Pipeline stage to filter candidates',
  })
  @ApiResponse({ status: 200, description: 'Candidates updated successfully' })
  @UseGuards(AuthGuard)
  async updateCandidates(@Query('pipeline_stage') pipeline_stage: string) {
    return this.hubspotService.updateCandidates(pipeline_stage);
  }

  @Post('update-organizations')
  @ApiOperation({
    summary:
      'Update all organization records with the latest data from HubSpot',
  })
  @ApiResponse({
    status: 200,
    description: 'Organizations updated successfully',
  })
  @UseGuards(AuthGuard)
  async updateOrganizations() {
    return this.hubspotService.updateOrganizations();
  }

  //=> this route is just a example to read candidates and download resume
  @Post('candidates-download')
  //@UseGuards(AuthGuard, RolesGuard)
  //@Roles('user', 'admin', 'system_super_admin')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Get candidates from HubSpot with dynamic filters and download their resumes',
  })
  @ApiBody({
    type: GetCandidatesDto,
    description: 'Data to get candidates from HubSpot',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Returns candidates below dynamic filters',
  })
  @ApiResponse({ status: 400, description: 'Data is required' })
  @ApiResponse({
    status: 400,
    description: 'Virtual Assistant identifier is required',
  })
  @ApiResponse({ status: 400, description: 'Error fetching candidates' })
  async getCandidates2(@Body() data: GetCandidatesDto) {
    return this.hubspotService.getCandidatesAndDownload(data);
  }

  @Post('populate-contacts')
  //@UseGuards(AuthGuard)
  @ApiOperation({
    summary:
      'Populate platform contact records with data imported from HubSpot contacts',
  })
  @ApiResponse({ status: 200, description: 'Contacts populated successfully' })
  async populateContacts() {
    return this.hubspotService.populateContactsFromHubspot();
  }

  @Get('align-owners')
  @ApiOperation({
    summary:
      'Align HubSpot deal owners with the corresponding platform user assignments',
  })
  @ApiResponse({ status: 200, description: 'Owners aligned successfully' })
  async alignOwners() {
    return this.hubspotService.alignOwners();
  }
}
