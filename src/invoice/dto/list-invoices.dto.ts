import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsEnum, IsString, IsUUID, IsArray } from 'class-validator';
import { InvoiceStatus } from '@prisma/client';
import { Transform } from 'class-transformer';

export class ListInvoicesDto {
  @ApiProperty({ enum: InvoiceStatus, required: false })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiProperty({
    required: false,
    description: 'Search by reference, invoice number, or organization name',
  })
  @IsString()
  @IsOptional()
  search?: string;

  // Express's query parser only produces an array when the client repeats the
  // key (?organizationIds=a&organizationIds=b); a single value arrives as a
  // plain string. Normalize both shapes to an array before @IsUUID validates.
  @ApiProperty({ required: false, type: [String] })
  @IsUUID(undefined, { each: true })
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value) ? value : value ? [value] : undefined,
  )
  organizationIds?: string[];

  @ApiProperty({ enum: ['arrears', 'prebill'], required: false })
  @IsEnum(['arrears', 'prebill'])
  @IsOptional()
  billingMode?: 'arrears' | 'prebill';

  @ApiProperty({
    required: false,
    description: 'Filter by billing start date (gte)',
  })
  @IsString()
  @IsOptional()
  startDate?: string;

  @ApiProperty({
    required: false,
    description: 'Filter by billing end date (lte)',
  })
  @IsString()
  @IsOptional()
  endDate?: string;
}
