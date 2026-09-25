import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

/**
 * Body for POST /offer-panels/:id/add-as-user. The email is deliberately NOT part
 * of the body — it is always the panel's recipient_email, so the admin cannot
 * invite someone other than the person the panel was sent to.
 */
export class AddRecipientAsUserDto {
  @ApiProperty({
    description:
      'Organization to invite into. Must be one of the organizations resolved from the ' +
      "recipient's HubSpot company associations (see the preview endpoint).",
  })
  @IsUUID()
  organization_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  last_name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  job_title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ enum: ['organization_admin', 'organization_super_admin'] })
  @IsEnum(['organization_admin', 'organization_super_admin'])
  role: 'organization_admin' | 'organization_super_admin';
}
