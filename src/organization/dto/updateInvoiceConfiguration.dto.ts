import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsEnum,
  IsInt,
  IsBoolean,
} from 'class-validator';
import { BillingMode, BillingFrequency } from '@prisma/client';

export class UpdateInvoiceConfigurationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  hubstaff_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  hubspot_id?: string;

  @ApiProperty({ enum: BillingMode, required: false })
  @IsOptional()
  @IsEnum(BillingMode)
  billing_mode?: BillingMode;

  @ApiProperty({ enum: BillingFrequency, required: false })
  @IsOptional()
  @IsEnum(BillingFrequency)
  billing_frequency?: BillingFrequency;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  billing_currency?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  payment_terms_days?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  cycle_anchor_day?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  auto_submit_invoices?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  auto_publish_invoices?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  auto_sync_to_stripe?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  requires_reconciliation?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  stripe_customer_id?: string;
}
