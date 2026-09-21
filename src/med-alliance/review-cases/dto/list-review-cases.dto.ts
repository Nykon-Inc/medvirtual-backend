import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListReviewCasesDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Filter by review case status',
    enum: ['open', 'resolved'],
  })
  @IsOptional()
  @IsIn(['open', 'resolved'])
  status?: 'open' | 'resolved';

  @ApiPropertyOptional({
    description: 'Filter by reason code',
    enum: [
      'multiple_hubspot_matches',
      'reconciliation_invoice_changed',
      'soft_duplicate_referral',
      'invoice_reassociated_in_hubspot',
    ],
  })
  @IsOptional()
  @IsIn([
    'multiple_hubspot_matches',
    'reconciliation_invoice_changed',
    'soft_duplicate_referral',
    'invoice_reassociated_in_hubspot',
  ])
  reason_code?: string;

  @ApiPropertyOptional({
    description: 'Search by company name or other relevant text',
    example: 'Acme',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
