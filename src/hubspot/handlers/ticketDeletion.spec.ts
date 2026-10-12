import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { HandlerTicketDeletion } from './ticketDeletion';
import { PrismaService } from '../../prisma/prisma.service';
import { HubspotService } from '../hubspot.service';
import { CandidateAuditService } from '../../candidate/candidate-audit.service';

const prismaMock = {
  hireRequest: { findUnique: jest.fn(), update: jest.fn() },
  candidate: { update: jest.fn() },
  candidatePanel: { deleteMany: jest.fn() },
};

const hubspotMock = {
  updateOneCandidateFromHireRequest: jest.fn(),
};

const candidateAuditMock = {
  logMany: jest.fn(),
};

const AVAILABLE_STAGE = '261075105';

describe('HandlerTicketDeletion', () => {
  let handler: HandlerTicketDeletion;

  const mockTicket = (candidate: Record<string, unknown>) => {
    prismaMock.hireRequest.findUnique.mockResolvedValue({
      id: 'hr-1',
      status: 'sourcing',
      panels: [
        {
          panelCandidates: [
            { candidate: { id: 'c-1', hubspot_id: 'hs-1', ...candidate } },
          ],
        },
      ],
    });
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandlerTicketDeletion,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HubspotService, useValue: hubspotMock },
        { provide: CandidateAuditService, useValue: candidateAuditMock },
      ],
    }).compile();

    handler = module.get<HandlerTicketDeletion>(HandlerTicketDeletion);
    jest.clearAllMocks();
  });

  it('should do nothing when the ticket is unknown', async () => {
    prismaMock.hireRequest.findUnique.mockResolvedValue(null);

    await handler.execute({ objectId: 1 });

    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(prismaMock.hireRequest.update).not.toHaveBeenCalled();
  });

  it('should return candidates to their origin stage and soft-delete the hire request', async () => {
    mockTicket({
      pipeline_status: '555',
      pipeline_status_origin: AVAILABLE_STAGE,
      first_available_at: new Date('2026-01-15T00:00:00.000Z'),
    });

    await handler.execute({ objectId: 1 });

    expect(prismaMock.candidate.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { pipeline_status: AVAILABLE_STAGE },
    });
    expect(hubspotMock.updateOneCandidateFromHireRequest).toHaveBeenCalledWith(
      'hs-1',
      AVAILABLE_STAGE,
    );
    expect(prismaMock.hireRequest.update).toHaveBeenCalledWith({
      where: { id: 'hr-1' },
      data: { old_status: 'sourcing', status: 'deleted' },
    });
    expect(prismaMock.candidatePanel.deleteMany).toHaveBeenCalledWith({
      where: { hire_request_id: 'hr-1' },
    });
  });

  it('should stamp first_available_at when returning an unstamped candidate to the pool', async () => {
    mockTicket({
      pipeline_status: '555',
      pipeline_status_origin: AVAILABLE_STAGE,
      first_available_at: null,
    });

    await handler.execute({ objectId: 1 });

    expect(prismaMock.candidate.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: {
        pipeline_status: AVAILABLE_STAGE,
        first_available_at: expect.any(Date),
      },
    });
  });

  it('should not stamp first_available_at when the origin is not an available stage', async () => {
    mockTicket({
      pipeline_status: '555',
      pipeline_status_origin: null,
      first_available_at: null,
    });

    await handler.execute({ objectId: 1 });

    expect(prismaMock.candidate.update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { pipeline_status: '555' },
    });
  });

  it('should throw when the deletion fails', async () => {
    prismaMock.hireRequest.findUnique.mockRejectedValue(new Error('db down'));

    await expect(handler.execute({ objectId: 1 })).rejects.toThrow(
      BadRequestException,
    );
  });
});
