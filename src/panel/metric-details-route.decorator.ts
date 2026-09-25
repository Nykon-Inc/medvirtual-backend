import { applyDecorators, Get, HttpCode, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

/**
 * GET route for an Operational Dashboard card drill-down: admin-only, paged
 * rows behind one KPI card. Shared by `/panel/details/*` and
 * `/offer-panels/stats/details/*`.
 */
export function MetricDetailsRoute(path: string, summary: string) {
  return applyDecorators(
    Get(path),
    UseGuards(AuthGuard, RolesGuard),
    Roles('system_super_admin', 'system_admin'),
    HttpCode(200),
    ApiOperation({ summary }),
    ApiResponse({ status: 200, description: 'Rows retrieved successfully' }),
    ApiResponse({ status: 400, description: 'Invalid or missing date range' }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
    ApiResponse({
      status: 403,
      description: 'Access denied: insufficient permissions',
    }),
  );
}
