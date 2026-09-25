import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * Query for the Operational Dashboard card drill-downs (`/panel/details/*`,
 * `/offer-panels/stats/details/*`). The drill-down only exists while a period
 * filter is active, so both bounds are required.
 */
export class MetricDetailsQueryDto {
  @ApiProperty({
    description: 'Inclusive start of the window (YYYY-MM-DD)',
    example: '2026-01-01',
  })
  @IsDateString()
  dateFrom: string;

  @ApiProperty({
    description: 'Inclusive end of the window (YYYY-MM-DD)',
    example: '2026-01-31',
  })
  @IsDateString()
  dateTo: string;

  @ApiProperty({ description: 'Page number', required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ description: 'Items per page', required: false, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number = 10;

  @ApiProperty({
    description:
      'When true, ignore page/perPage and return the full filtered result set',
    required: false,
    default: false,
  })
  @IsOptional()
  // `@Type(() => Boolean)` would turn the string "false" into true.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  export?: boolean = false;
}
