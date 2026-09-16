import { Test, TestingModule } from '@nestjs/testing';
import { StaffMatchingService } from './staff-matching.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewCasesService } from '../review-cases/review-cases.service';

const mockPrisma = {
  hubspotLineItemSnapshot: { findMany: jest.fn(), update: jest.fn() },
  staff: { findMany: jest.fn() },
};

const mockReviewCases = {
  openOrSkip: jest.fn(),
};

describe('StaffMatchingService', () => {
  let service: StaffMatchingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffMatchingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ReviewCasesService, useValue: mockReviewCases },
      ],
    }).compile();

    service = module.get<StaffMatchingService>(StaffMatchingService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should return zero stats when there are no unmatched line items', async () => {
    mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([]);

    const result = await service.run('org-1');

    expect(result).toEqual({ matched: 0, unmatched: 0, ambiguous: 0 });
    expect(mockPrisma.staff.findMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Real-world noise cases from the plan spec
  // ---------------------------------------------------------------------------
  describe('real-world name matching cases', () => {
    it('matches "Sharys Mea Maglasang" against deal "Cameron Family Chiropractic | Sharys Mea Maglasang Maglasang" (duplicated surname)', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-1', name: 'Sharys Mea Maglasang', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-1',
          hubspot_deal_name:
            'Cameron Family Chiropractic | Sharys Mea Maglasang Maglasang',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-1' },
        data: {
          match_status: 'matched',
          staff_id: 'staff-1',
          matched_by: 'auto',
        },
      });
    });

    it('matches "Dharyll Mae Vicente" against deal "La Starza Wellness Chiropractic - Dharyll Mae C. Vicente" (dash separator + middle initial)', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-2', name: 'Dharyll Mae Vicente', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-2',
          hubspot_deal_name:
            'La Starza Wellness Chiropractic - Dharyll Mae C. Vicente',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
    });

    it('matches "Maria Cielo Danao" against deal "Sleppy Chiropractic | Maria Cielo Danao (2)" (numeric VA-counter suffix)', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-3', name: 'Maria Cielo Danao', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-3',
          hubspot_deal_name: 'Sleppy Chiropractic | Maria Cielo Danao (2)',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
    });

    it('matches "Juliah Monte\\n " against deal "Ute Pass Family Chiropractic | Juliah Monte" (dirty whitespace/newline)', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-4', name: 'Juliah Monte\n ', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-4',
          hubspot_deal_name: 'Ute Pass Family Chiropractic | Juliah Monte',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
    });

    it('matches "Paulo Melo" against deal "Paulo Melo - test" (name BEFORE a trailing qualifier tag)', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-10', name: 'Paulo Melo', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-10',
          hubspot_deal_name: 'Paulo Melo - test',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-10' },
        data: {
          match_status: 'matched',
          staff_id: 'staff-10',
          matched_by: 'auto',
        },
      });
    });

    it('matches "Elizabeth veloso " (lowercase, trailing space) against deal "Elizabeth Veloso - test"', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-11', name: 'Elizabeth veloso ', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-11',
          hubspot_deal_name: 'Elizabeth Veloso - test',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-11' },
        data: {
          match_status: 'matched',
          staff_id: 'staff-11',
          matched_by: 'auto',
        },
      });
    });

    it('does not falsely match when the deal name has no real person on either side of the separator', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        {
          id: 'li-12',
          name: 'Someone Entirely Different',
          invoice_id: 'inv-1',
        },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-12',
          hubspot_deal_name: 'Some Clinic - test',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.unmatched).toBe(1);
    });

    it('prefers structured Candidate first_name/last_name over hubspot_deal_name when available', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-5', name: 'Rafael Delgado', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-5',
          hubspot_deal_name: 'Some Company | Totally Different Text',
          candidate: { first_name: 'Rafael', last_name: 'Delgado' },
        },
      ]);

      const result = await service.run('org-1');

      expect(result.matched).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-5' },
        data: {
          match_status: 'matched',
          staff_id: 'staff-5',
          matched_by: 'auto',
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Outcomes
  // ---------------------------------------------------------------------------
  describe('unmatched outcome', () => {
    it('marks the line item unmatched and opens a review case when no Staff scores above the threshold', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-6', name: 'Completely Unknown Person', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-6',
          hubspot_deal_name: 'Acme Corp | Somebody Else',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.unmatched).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-6' },
        data: { match_status: 'unmatched' },
      });
      expect(mockReviewCases.openOrSkip).toHaveBeenCalledWith(
        'org-1',
        'unmatched_line_item',
        expect.objectContaining({
          line_item_name: 'Completely Unknown Person',
        }),
        'li-6',
      );
    });

    it('marks the line item unmatched when there are no staff candidates at all', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-7', name: 'Anyone', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([]);

      const result = await service.run('org-1');

      expect(result.unmatched).toBe(1);
    });
  });

  describe('ambiguous outcome', () => {
    it('marks the line item ambiguous and opens a review case when 2+ staff score closely above the threshold', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-8', name: 'Maria Santos', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([
        {
          id: 'staff-8a',
          hubspot_deal_name: 'Acme Corp | Maria Santos',
          candidate: null,
        },
        {
          id: 'staff-8b',
          hubspot_deal_name: 'Acme Corp | Maria Santos (2)',
          candidate: null,
        },
      ]);

      const result = await service.run('org-1');

      expect(result.ambiguous).toBe(1);
      expect(mockPrisma.hubspotLineItemSnapshot.update).toHaveBeenCalledWith({
        where: { id: 'li-8' },
        data: { match_status: 'ambiguous' },
      });
      expect(mockReviewCases.openOrSkip).toHaveBeenCalledWith(
        'org-1',
        'ambiguous_line_item',
        expect.objectContaining({
          line_item_name: 'Maria Santos',
          candidate_staff_ids: expect.arrayContaining(['staff-8a', 'staff-8b']),
        }),
        'li-8',
      );
    });
  });

  describe('organization scoping', () => {
    it('only fetches Staff scoped to the organization_id being matched', async () => {
      mockPrisma.hubspotLineItemSnapshot.findMany.mockResolvedValue([
        { id: 'li-9', name: 'Someone', invoice_id: 'inv-1' },
      ]);
      mockPrisma.staff.findMany.mockResolvedValue([]);

      await service.run('org-42');

      expect(mockPrisma.staff.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organization_id: 'org-42' },
        }),
      );
      expect(mockPrisma.hubspotLineItemSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            match_status: null,
            invoice: { organization_id: 'org-42' },
          }),
        }),
      );
    });
  });
});
