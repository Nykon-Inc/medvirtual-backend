import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePositionRateConfigDto } from './dto/update-position-rate-config.dto';

@Injectable()
export class PositionRateConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(page = 1, perPage = 10, search = '') {
    const skip = (page - 1) * perPage;
    const where = search
      ? { position: { contains: search, mode: 'insensitive' as const } }
      : undefined;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.positionRateConfig.findMany({
        where,
        orderBy: { position: 'asc' },
        skip,
        take: perPage,
      }),
      this.prisma.positionRateConfig.count({ where }),
    ]);

    return {
      status: 200,
      data,
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      },
    };
  }

  findAllUnpaginated() {
    return this.prisma.positionRateConfig.findMany({
      orderBy: { position: 'asc' },
    });
  }

  findByPosition(position: string) {
    return this.prisma.positionRateConfig.findUnique({
      where: { position },
    });
  }

  upsert(position: string, dto: UpdatePositionRateConfigDto) {
    const data = {
      medical_floor_price_english: dto.medical_floor_price_english,
      non_medical_floor_price_english: dto.non_medical_floor_price_english,
      medical_floor_price_bilingual: dto.medical_floor_price_bilingual,
      non_medical_floor_price_bilingual: dto.non_medical_floor_price_bilingual,
      medical_margin_per_hour: dto.medical_margin_per_hour,
      non_medical_margin_per_hour: dto.non_medical_margin_per_hour,
    };

    return this.prisma.positionRateConfig.upsert({
      where: { position },
      update: data,
      create: { position, ...data },
    });
  }
}
