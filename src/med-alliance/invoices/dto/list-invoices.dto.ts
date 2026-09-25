import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceSource } from '@prisma/client';

export class ListInvoicesDto {
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

  // Filter by raw HubSpot invoice_status (e.g. "paid", "outstanding")
  @ApiPropertyOptional({
    description: 'Filter by HubSpot invoice status',
    example: 'paid',
  })
  @IsOptional()
  @IsString()
  invoice_status?: string;

  // Filter by payment_status when available in the HubSpot contract
  @ApiPropertyOptional({
    description: 'Filter by payment status from the HubSpot contract',
    example: 'paid',
  })
  @IsOptional()
  @IsString()
  payment_status?: string;

  @ApiPropertyOptional({
    description:
      'Filter by the billing system the invoice came from (HubSpot or our own Stripe/Hubstaff invoicing)',
    enum: InvoiceSource,
    example: InvoiceSource.internal,
  })
  @IsOptional()
  @IsEnum(InvoiceSource)
  source?: InvoiceSource;

  // When true, return only snapshots where is_candidate_input === true
  @ApiPropertyOptional({
    description: 'When true, return only invoices flagged as candidate input',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  candidates_only?: boolean;

  @ApiPropertyOptional({
    description: 'Filter invoices paid from this date (ISO date string)',
    example: '2024-01-01',
  })
  @IsOptional()
  @IsDateString()
  paid_at_from?: string;

  @ApiPropertyOptional({
    description: 'Filter invoices paid up to this date (ISO date string)',
    example: '2024-12-31',
  })
  @IsOptional()
  @IsDateString()
  paid_at_to?: string;

  // Default: paid_at DESC for idempotency consistency (MA-003 spec).
  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: ['paid_at', 'invoice_amount', 'createdAt'],
    default: 'paid_at',
  })
  @IsOptional()
  @IsEnum(['paid_at', 'invoice_amount', 'createdAt'])
  sortBy?: string = 'paid_at';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
