import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

const SORTABLE_FIELDS = [
  'selectedAt',
  'candidateName',
  'organizationName',
] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

export class ClientSelectedCandidatesQueryDto {
  @ApiProperty({ description: 'Page number', required: false, default: 1 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number = 1;

  @ApiProperty({ description: 'Items per page', required: false, default: 10 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  perPage?: number = 10;

  @ApiProperty({
    description: 'Start date (createdAt/updatedAt lower bound)',
    required: false,
  })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiProperty({
    description: 'End date (createdAt/updatedAt upper bound)',
    required: false,
  })
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiProperty({
    description: 'Field to sort by',
    required: false,
    enum: SORTABLE_FIELDS,
    default: 'selectedAt',
  })
  @IsOptional()
  @IsString()
  @IsIn(SORTABLE_FIELDS)
  sortBy?: SortableField = 'selectedAt';

  @ApiProperty({
    description: 'Sort order',
    required: false,
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';

  @ApiProperty({
    description:
      'When true, ignore page/perPage and return the full filtered result set',
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  export?: boolean = false;
}
