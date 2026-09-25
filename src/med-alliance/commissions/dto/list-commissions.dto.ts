import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceSource } from '@prisma/client';

export enum CommissionStatus {
  DETECTED = 'detected',
  PENDING_ADMIN_CONFIRMATION = 'pending_admin_confirmation',
  ELIGIBLE = 'eligible',
  REQUESTED = 'requested',
  PAID = 'paid',
  VOID = 'void',
  REJECTED = 'rejected',
}

export class ListCommissionsDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Filter by commission status',
    enum: CommissionStatus,
  })
  @IsOptional()
  @IsEnum(CommissionStatus)
  status?: CommissionStatus;

  @ApiPropertyOptional({
    description:
      'Filter by the billing system the invoice came from (HubSpot or our own Stripe/Hubstaff invoicing)',
    enum: InvoiceSource,
    example: InvoiceSource.internal,
  })
  @IsOptional()
  @IsEnum(InvoiceSource)
  source?: InvoiceSource;

  // Admin only: filter commissions by organization
  @ApiPropertyOptional({
    description: 'Admin only: filter by organization UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  organization_id?: string;

  // Admin only: filter commissions by affiliate user id
  @ApiPropertyOptional({
    description: 'Admin only: filter by affiliate profile UUID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  affiliate_id?: string;

  @ApiPropertyOptional({
    description: 'Filter commissions created from this date (ISO date string)',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @ApiPropertyOptional({
    description: 'Filter commissions created up to this date (ISO date string)',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsDateString()
  created_to?: string;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: ['createdAt', 'commission_amount', 'admin_decision_at'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsEnum(['createdAt', 'commission_amount', 'admin_decision_at'])
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
