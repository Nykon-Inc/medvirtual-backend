import { ApiProperty } from '@nestjs/swagger';
import {
  IsUUID,
  IsDateString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsBoolean,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

// isCustom/is_custom and allowFees/allow_fees each accept both casings because
// different frontend call sites send one or the other; invoice.service.ts reads
// whichever is set (`dto.isCustom || dto.is_custom`). Keep both until the
// frontend is standardized on one casing.
export class CreateInvoiceDto {
  @ApiProperty({ example: 'uuid-of-organization' })
  @IsUUID()
  organization_id: string;

  @ApiProperty({ example: '2024-01-01' })
  @IsDateString()
  billing_start_date: string;

  @ApiProperty({ example: '2024-01-31' })
  @IsDateString()
  billing_end_date: string;

  @ApiProperty({ example: '2024-02-01', required: false })
  @IsDateString()
  @IsOptional()
  issue_date?: string;

  @ApiProperty({ example: '2024-02-15', required: false })
  @IsDateString()
  @IsOptional()
  due_date?: string;

  @ApiProperty({ example: '2024-02-15', required: false })
  @IsDateString()
  @IsOptional()
  public_due_date?: string;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  is_prebill?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  isCustom?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  is_custom?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  allowFees?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  allow_fees?: boolean;

  @ApiProperty({ example: 0, required: false })
  @IsNumber()
  @IsOptional()
  ops?: number;

  @ApiProperty({ example: 0, required: false })
  @IsNumber()
  @IsOptional()
  fee?: number;
}

// Same dual-casing fields as CreateInvoiceDto (see comment above) — one
// invoice per organization_id is created with these shared settings.
export class BulkCreateInvoiceDto {
  @ApiProperty({ type: [String], example: ['uuid1', 'uuid2'] })
  @IsArray()
  @IsUUID(undefined, { each: true })
  organization_ids: string[];

  @ApiProperty({ example: '2024-01-01' })
  @IsDateString()
  billing_start_date: string;

  @ApiProperty({ example: '2024-01-31' })
  @IsDateString()
  billing_end_date: string;

  @ApiProperty({ example: '2024-02-01', required: false })
  @IsDateString()
  @IsOptional()
  issue_date?: string;

  @ApiProperty({ example: '2024-02-15', required: false })
  @IsDateString()
  @IsOptional()
  due_date?: string;

  @ApiProperty({ example: '2024-02-15', required: false })
  @IsDateString()
  @IsOptional()
  public_due_date?: string;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  is_prebill?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  isCustom?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  is_custom?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  allowFees?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  allow_fees?: boolean;

  @ApiProperty({ example: 0, required: false })
  @IsNumber()
  @IsOptional()
  ops?: number;

  @ApiProperty({ example: 0, required: false })
  @IsNumber()
  @IsOptional()
  fee?: number;
}
