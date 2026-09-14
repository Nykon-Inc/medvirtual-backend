import { Test, TestingModule } from '@nestjs/testing';
import { PositionRateConfigService } from './position-rate-config.service';
import { PrismaService } from '../prisma/prisma.service';

const mockData = [
  {
    position: 'Admin VA',
    medical_floor_price_english: 15,
    medical_margin_per_hour: 9,
  },
  {
    position: 'Billing VA',
    medical_floor_price_english: 18,
    medical_margin_per_hour: 9,
  },
];

const mockPrisma = {
  positionRateConfig: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('PositionRateConfigService', () => {
  let service: PositionRateConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionRateConfigService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PositionRateConfigService>(PositionRateConfigService);
    jest.clearAllMocks();
  });

  describe('findAll (paginated)', () => {
    it('returns paginated result with meta on page 1', async () => {
      mockPrisma.$transaction.mockResolvedValue([mockData, 2]);

      const result = await service.findAll(1, 10);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result).toEqual({
        status: 200,
        data: mockData,
        meta: { total: 2, page: 1, perPage: 10, totalPages: 1 },
      });
    });

    it('uses default page=1 and perPage=10 when called without args', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      const result = await service.findAll();

      expect(result.meta).toEqual({
        total: 0,
        page: 1,
        perPage: 10,
        totalPages: 0,
      });
    });

    it('calculates skip correctly for page 2', async () => {
      mockPrisma.$transaction.mockResolvedValue([mockData, 25]);

      const result = await service.findAll(2, 10);

      expect(result.meta.page).toBe(2);
      expect(result.meta.totalPages).toBe(3);
    });
  });

  describe('findAllUnpaginated', () => {
    it('returns all configs ordered by position asc without pagination', async () => {
      mockPrisma.positionRateConfig.findMany.mockResolvedValue(mockData);

      const result = await service.findAllUnpaginated();

      expect(mockPrisma.positionRateConfig.findMany).toHaveBeenCalledWith({
        orderBy: { position: 'asc' },
      });
      expect(result).toEqual(mockData);
    });

    it('returns empty array when no configs exist', async () => {
      mockPrisma.positionRateConfig.findMany.mockResolvedValue([]);
      const result = await service.findAllUnpaginated();
      expect(result).toEqual([]);
    });
  });

  describe('findByPosition', () => {
    it('returns config for a specific position', async () => {
      const mockConfig = {
        position: 'Admin VA',
        medical_floor_price_english: 15,
      };
      mockPrisma.positionRateConfig.findUnique.mockResolvedValue(mockConfig);

      const result = await service.findByPosition('Admin VA');

      expect(mockPrisma.positionRateConfig.findUnique).toHaveBeenCalledWith({
        where: { position: 'Admin VA' },
      });
      expect(result).toEqual(mockConfig);
    });

    it('returns null when position not found', async () => {
      mockPrisma.positionRateConfig.findUnique.mockResolvedValue(null);
      const result = await service.findByPosition('Unknown');
      expect(result).toBeNull();
    });
  });

  describe('upsert', () => {
    const dto = {
      medical_floor_price_english: 15,
      non_medical_floor_price_english: 15,
      medical_floor_price_bilingual: 17,
      non_medical_floor_price_bilingual: 17,
      medical_margin_per_hour: 9,
      non_medical_margin_per_hour: 9,
    };

    it('calls prisma upsert with correct create/update payloads', async () => {
      const saved = { position: 'Admin VA', ...dto };
      mockPrisma.positionRateConfig.upsert.mockResolvedValue(saved);

      const result = await service.upsert('Admin VA', dto);

      expect(mockPrisma.positionRateConfig.upsert).toHaveBeenCalledWith({
        where: { position: 'Admin VA' },
        update: {
          medical_floor_price_english: 15,
          non_medical_floor_price_english: 15,
          medical_floor_price_bilingual: 17,
          non_medical_floor_price_bilingual: 17,
          medical_margin_per_hour: 9,
          non_medical_margin_per_hour: 9,
        },
        create: {
          position: 'Admin VA',
          medical_floor_price_english: 15,
          non_medical_floor_price_english: 15,
          medical_floor_price_bilingual: 17,
          non_medical_floor_price_bilingual: 17,
          medical_margin_per_hour: 9,
          non_medical_margin_per_hour: 9,
        },
      });
      expect(result).toEqual(saved);
    });

    it('passes undefined for unspecified fields (Prisma will skip updating them)', async () => {
      const partialDto = { medical_margin_per_hour: 6 };
      mockPrisma.positionRateConfig.upsert.mockResolvedValue({});

      await service.upsert('Admin VA', partialDto);

      const call = mockPrisma.positionRateConfig.upsert.mock.calls[0][0];
      expect(call.update.medical_floor_price_english).toBeUndefined();
      expect(call.update.non_medical_floor_price_english).toBeUndefined();
      expect(call.update.medical_margin_per_hour).toBe(6);
    });
  });
});
