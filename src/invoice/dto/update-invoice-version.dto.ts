import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  IsNumber,
  IsEnum,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  InvoiceLineType,
  InvoiceLineCategory,
  AdjustmentType,
} from '@prisma/client';

export class InvoiceLineItemDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  parent_line_item_id?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  ticket_id?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  worker_id?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  worker_name_snapshot?: string;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  is_full_time?: boolean;

  // Accepted from the client for UI display purposes (e.g. rendering a +/-
  // toggle) but not persisted — invoice.service.ts destructures and discards
  // it before saving; adjustment_amount already carries the actual sign.
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  adjustment_sign?: string;

  @ApiProperty({ enum: InvoiceLineType })
  @IsEnum(InvoiceLineType)
  type: InvoiceLineType;

  @ApiProperty({ enum: InvoiceLineCategory })
  @IsEnum(InvoiceLineCategory)
  category: InvoiceLineCategory;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  total_hours_worked?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  total_pto_hours?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  total_holiday_hours?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  total_hours_payable?: number;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  hourly_rate?: number;

  @ApiProperty()
  @IsNumber()
  service_amount: number;

  @ApiProperty()
  @IsNumber()
  operations_cost: number;

  @ApiProperty()
  @IsNumber()
  medvirtual_fees: number;

  @ApiProperty({ enum: AdjustmentType, required: false })
  @IsEnum(AdjustmentType)
  @IsOptional()
  adjustment_type?: AdjustmentType;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  adjustment_value?: number;

  @ApiProperty()
  @IsNumber()
  adjustment_amount: number;

  @ApiProperty()
  @IsNumber()
  final_total: number;
}

export class UpdateInvoiceVersionDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty()
  @IsNumber()
  subtotal: number;

  @ApiProperty()
  @IsNumber()
  tax_total: number;

  @ApiProperty()
  @IsNumber()
  total: number;

  @ApiProperty({ required: false, enum: ['dollar', 'percent'] })
  @IsString()
  @IsOptional()
  discountType?: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  discountValue?: number;

  @ApiProperty({ type: [InvoiceLineItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemDto)
  line_items: InvoiceLineItemDto[];
}
