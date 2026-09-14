import { DateTime } from '@hubspot/api-client/lib/codegen/crm/associations/v4';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class editInterviewDTO {
  @ApiProperty({
    description:
      'The date and time of the interview. For client-originated hire requests, must be at least 24 hours in advance.',
    type: String,
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  date_time: DateTime;

  @ApiProperty({
    description: 'Just date of the interview',
    type: String,
    required: false,
  })
  @IsString()
  @IsOptional()
  date: string;

  @ApiProperty({
    description: 'Just time of the interview',
    type: String,
    required: false,
  })
  @IsString()
  @IsOptional()
  time: string;

  @ApiProperty({
    description: 'The link of the interview',
    example: 'https://meet.google.com/XXXX',
    required: false,
  })
  @IsString()
  @IsOptional()
  interview_link: string;
}
