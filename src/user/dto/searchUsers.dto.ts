import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsIn,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class SearchUsersDto {
  @ApiProperty({
    required: false,
    description: 'Search term to filter users by name, email, or job title',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by user role',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by user status',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by organization ID',
  })
  @IsOptional()
  @IsString()
  organization_id?: string;

  @ApiProperty({
    required: false,
    enum: ['with_active_staff', 'without_active_staff'],
    description:
      'Filter by whether the user organization has active staff (same definition as the operational dashboard)',
  })
  @IsOptional()
  @IsIn(['with_active_staff', 'without_active_staff'])
  staff_status?: 'with_active_staff' | 'without_active_staff';

  @ApiProperty({
    required: false,
    description: 'Users created on or after this date (YYYY-MM-DD, UTC)',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiProperty({
    required: false,
    description:
      'Users created on or before this date (YYYY-MM-DD, inclusive, UTC)',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiProperty({
    required: false,
    description:
      'Number of results to return (no maximum limit). If not provided, returns all results.',
    minimum: 1,
  })
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value) : undefined))
  @IsInt()
  @Min(1)
  limit?: number;
}
