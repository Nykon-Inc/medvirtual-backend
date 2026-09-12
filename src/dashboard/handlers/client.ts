import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketStatus } from '@prisma/client';
import { HireRequestService } from '../../hire-request/hire-request.service';

@Injectable()
export class HandlerClient {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hireRequestService: HireRequestService,
  ) {}

  async execute(
    user: any,
    page: number = 1,
    perPage: number = 10,
  ): Promise<object> {
    const result: any = {};
    if (
      !user ||
      (user.role.includes('organization') && !user.organization_id)
    ) {
      throw new Error('User or organization not found!!');
    }

    const newRequestsCount = await this.prisma.hireRequest.count({
      where: {
        status: 'new',
      },
    });
    result.newRequests = newRequestsCount;

    const panelToScheduleCount = await this.prisma.hireRequest.count({
      where: {
        status: 'panel_ready',
      },
    });
    result.panelsToSchedule = panelToScheduleCount;

    const pendingDecisionsCount = await this.prisma.hireRequest.count({
      where: {
        status: 'awaiting_decision',
      },
    });
    result.pendingDecisions = pendingDecisionsCount;

    const openTicketsCount = await this.prisma.ticket.count({
      where: {
        OR: [
          { status: TicketStatus.new },
          { status: TicketStatus.in_progress },
        ],
        // Sibling of OR, so Prisma ANDs it — soft-deleted tickets stay out of the KPI.
        deleted_at: null,
        ...(user.role === 'system_admin' ? { user_id: user.id } : {}),
      },
    });
    result.openTickets = openTicketsCount;

    // Unified format with /hire-request, includes specialization and skills
    const hireRequestsResult = await this.hireRequestService.findAll(
      user,
      undefined,
      page,
      perPage,
    );
    result.hireRequests = hireRequestsResult; // { data, meta }

    return result;
  }
}
