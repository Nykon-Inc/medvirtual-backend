import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserAuditSource } from '@prisma/client';
import { USER_AUDIT_EVENTS, UserAuditEvent } from '../user-audit.events';

export class ListUserAuditLogsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: Object.values(USER_AUDIT_EVENTS) })
  @IsOptional()
  @IsIn(Object.values(USER_AUDIT_EVENTS))
  event?: UserAuditEvent;

  @ApiPropertyOptional({ enum: UserAuditSource })
  @IsOptional()
  @IsEnum(UserAuditSource)
  source?: UserAuditSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject_user_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  organization_id?: string;

  @ApiPropertyOptional({ example: '2024-01-01' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiPropertyOptional({ example: '2024-12-31' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiPropertyOptional({
    description:
      'Search by subject email/name/id, organization name, actor label or reason',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
