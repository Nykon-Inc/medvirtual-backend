import { Test, TestingModule } from '@nestjs/testing';
import { PanelMetricDetailsService } from './panel-metric-details.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  clientInvitesAcceptedWhere,
  hrSubmittedByClientWhere,
  newAvailableCandidatesWhere,
  newClientsWithActiveStaffWhere,
  newHireRequestsWhere,
  newStaffWhere,
  talentsCreatedWhere,
  talentsEndorsedWhere,
  talentsHiredWhere,
} from './panel-metric-filters';

describe('PanelMetricDetailsService', () => {
  let service: PanelMetricDetailsService;
  const prismaMock = {
    hireRequest: { count: jest.fn(), findMany: jest.fn() },
    staff: { count: jest.fn(), findMany: jest.fn() },
    organization: { count: jest.fn(), findMany: jest.fn() },
    uSER: { count: jest.fn(), findMany: jest.fn() },
    candidate: { count: jest.fn(), findMany: jest.fn() },
    candidateAuditLog: { findMany: jest.fn() },
    panelCandidate: { count: jest.fn(), findMany: jest.fn() },
  };

  const query = { dateFrom: '2026-01-01', dateTo: '2026-01-31' };
  const range = {
    gte: new Date('2026-01-01'),
    lte: new Date('2026-01-31T23:59:59.999Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PanelMetricDetailsService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = module.get(PanelMetricDetailsService);
  });

  describe('new hire requests', () => {
    const hr = {
      id: 'hr-1',
      title: 'Medical Receptionist',
      status: 'new',
      createdAt: new Date('2026-01-10T12:00:00.000Z'),
      organization: { name: 'Acme Clinic' },
      createdBy: { first_name: 'John', last_name: 'Smith' },
    };

    it('counts and pages with the same where the card uses', async () => {
      prismaMock.hireRequest.count.mockResolvedValue(23);
      prismaMock.hireRequest.findMany.mockResolvedValue([hr]);

      const result = await service.getNewHireRequests({
        ...query,
        page: 3,
        perPage: 10,
      });

      const where = newHireRequestsWhere(range);
      expect(prismaMock.hireRequest.count).toHaveBeenCalledWith({ where });
      expect(prismaMock.hireRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where, skip: 20, take: 10 }),
      );
      expect(result).toEqual({
        data: [
          {
            id: 'hr-1',
            title: 'Medical Receptionist',
            organizationName: 'Acme Clinic',
            status: 'new',
            createdByName: 'John Smith',
            createdAt: '2026-01-10T12:00:00.000Z',
          },
        ],
        meta: { total: 23, totalPages: 3, page: 3, perPage: 10 },
      });
    });

    it('returns every row without meta on export', async () => {
      prismaMock.hireRequest.findMany.mockResolvedValue([hr]);

      const result = await service.getNewHireRequests({
        ...query,
        export: true,
      });

      expect(prismaMock.hireRequest.count).not.toHaveBeenCalled();
      const args = prismaMock.hireRequest.findMany.mock.calls[0][0];
      expect(args.skip).toBeUndefined();
      expect(args.take).toBeUndefined();
      expect(result.meta).toBeUndefined();
      expect(result.data).toHaveLength(1);
    });
  });

  it('uses the HR Report where for submitted-by-client', async () => {
    prismaMock.hireRequest.count.mockResolvedValue(0);
    prismaMock.hireRequest.findMany.mockResolvedValue([]);

    await service.getHrSubmittedByClient(query);

    expect(prismaMock.hireRequest.count).toHaveBeenCalledWith({
      where: hrSubmittedByClientWhere(range),
    });
  });

  it('maps new staff with fallbacks', async () => {
    prismaMock.staff.count.mockResolvedValue(1);
    prismaMock.staff.findMany.mockResolvedValue([
      {
        id: 'st-1',
        start_date: null,
        created_at: new Date('2026-01-05T00:00:00.000Z'),
        hubspot_deal_name: 'Deal - Maria',
        hubspot_company_name: 'HubSpot Co',
        candidate: null,
        hireRequest: null,
        organization: null,
      },
    ]);

    const result = await service.getNewStaff(query);

    expect(prismaMock.staff.count).toHaveBeenCalledWith({
      where: newStaffWhere(range),
    });
    expect(result.data[0]).toEqual({
      id: 'st-1',
      name: 'Deal - Maria',
      position: '—',
      companyName: 'HubSpot Co',
      startDate: null,
      createdAt: '2026-01-05T00:00:00.000Z',
    });
  });

  describe('new available candidates', () => {
    it('filters on the first entry into the pool, not the current stage', () => {
      expect(newAvailableCandidatesWhere(range)).toEqual({
        first_available_at: range,
      });
    });

    it('falls back to the current pool when there is no period', () => {
      expect(newAvailableCandidatesWhere(undefined)).toEqual({
        pipeline_status: { in: ['261075105', '1087596819'] },
      });
    });

    it('counts and pages candidates by first availability', async () => {
      prismaMock.candidate.count.mockResolvedValue(1);
      prismaMock.candidate.findMany.mockResolvedValue([
        {
          id: 'c-1',
          first_name: 'Maria',
          last_name: 'Silva',
          name: null,
          email: 'maria@x.com',
          country: null,
          specialization: 'Medical Scribe',
          createdAt: new Date('2025-11-02T00:00:00.000Z'),
          first_available_at: new Date('2026-01-15T00:00:00.000Z'),
        },
      ]);

      const result = await service.getNewAvailableCandidates(query);

      expect(prismaMock.candidate.count).toHaveBeenCalledWith({
        where: newAvailableCandidatesWhere(range),
      });
      expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: newAvailableCandidatesWhere(range),
          orderBy: { first_available_at: 'desc' },
        }),
      );
      expect(result.data[0]).toEqual({
        id: 'c-1',
        name: 'Maria Silva',
        email: 'maria@x.com',
        country: '—',
        specialization: 'Medical Scribe',
        createdAt: '2025-11-02T00:00:00.000Z',
        firstAvailableAt: '2026-01-15T00:00:00.000Z',
      });
    });
  });

  it('returns clients with their active staff count', async () => {
    prismaMock.organization.count.mockResolvedValue(1);
    prismaMock.organization.findMany.mockResolvedValue([
      {
        id: 'org-1',
        name: 'Acme',
        business_unit: null,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        _count: { staff: 4 },
      },
    ]);

    const result = await service.getNewClientsWithActiveStaff(query);

    expect(prismaMock.organization.count).toHaveBeenCalledWith({
      where: newClientsWithActiveStaffWhere(range),
    });
    expect(result.data[0]).toMatchObject({
      name: 'Acme',
      businessUnit: '—',
      activeStaffCount: 4,
    });
  });

  it('orders invites accepted by activation date', async () => {
    prismaMock.uSER.count.mockResolvedValue(0);
    prismaMock.uSER.findMany.mockResolvedValue([]);

    await service.getInvitesAccepted(query);

    expect(prismaMock.uSER.count).toHaveBeenCalledWith({
      where: clientInvitesAcceptedWhere(range),
    });
    expect(prismaMock.uSER.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { activatedAt: 'desc' } }),
    );
  });

  it('uses the talents-created where', async () => {
    prismaMock.candidate.count.mockResolvedValue(0);
    prismaMock.candidate.findMany.mockResolvedValue([]);

    await service.getTalentsCreated(query);

    expect(prismaMock.candidate.count).toHaveBeenCalledWith({
      where: talentsCreatedWhere(range),
    });
    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: talentsCreatedWhere(range),
        orderBy: { first_available_at: 'desc' },
      }),
    );
  });

  it('counts talents created exactly like new available candidates', () => {
    expect(talentsCreatedWhere(range)).toEqual(
      newAvailableCandidatesWhere(range),
    );
    expect(talentsCreatedWhere(undefined)).toEqual(
      newAvailableCandidatesWhere(undefined),
    );
  });

  it('pages endorsed talents over distinct candidates', async () => {
    prismaMock.candidateAuditLog.findMany.mockResolvedValue([
      {
        candidate_id: 'c-1',
        actor_label: 'Ana (admin)',
        createdAt: new Date('2026-01-20T00:00:00.000Z'),
      },
      {
        candidate_id: 'c-2',
        actor_label: null,
        createdAt: new Date('2026-01-19T00:00:00.000Z'),
      },
      {
        candidate_id: 'c-3',
        actor_label: null,
        createdAt: new Date('2026-01-18T00:00:00.000Z'),
      },
    ]);
    prismaMock.candidate.findMany.mockResolvedValue([
      {
        id: 'c-3',
        first_name: 'Maria',
        last_name: null,
        name: null,
        email: 'maria@x.com',
      },
    ]);

    const result = await service.getTalentsEndorsed({
      ...query,
      page: 2,
      perPage: 2,
    });

    expect(prismaMock.candidateAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: talentsEndorsedWhere(range),
        distinct: ['candidate_id'],
      }),
    );
    expect(prismaMock.candidate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['c-3'] } } }),
    );
    expect(result).toEqual({
      data: [
        {
          id: 'c-3',
          name: 'Maria',
          email: 'maria@x.com',
          endorsedBy: '—',
          endorsedAt: '2026-01-18T00:00:00.000Z',
        },
      ],
      meta: { total: 3, totalPages: 2, page: 2, perPage: 2 },
    });
  });

  it('maps hired talents through panel → hire request', async () => {
    prismaMock.panelCandidate.count.mockResolvedValue(1);
    prismaMock.panelCandidate.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        updatedAt: new Date('2026-01-15T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        candidate: { first_name: 'Joao', last_name: 'Silva', name: null },
        panel: {
          hireRequest: { title: 'Scribe', organization: { name: 'Acme' } },
        },
      },
    ]);

    const result = await service.getTalentsHired(query);

    expect(prismaMock.panelCandidate.count).toHaveBeenCalledWith({
      where: talentsHiredWhere(range),
    });
    expect(result.data[0]).toEqual({
      id: 'pc-1',
      name: 'Joao Silva',
      hireRequestTitle: 'Scribe',
      organizationName: 'Acme',
      hiredAt: '2026-01-15T00:00:00.000Z',
    });
  });
});
