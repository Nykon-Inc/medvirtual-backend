import { ApiProperty } from '@nestjs/swagger';

export class OrganizationDto {
  @ApiProperty({ description: 'Organization ID' })
  id: string;

  @ApiProperty({ description: 'Organization name' })
  name: string;

  @ApiProperty({ description: 'Organization email', required: false })
  email?: string;

  @ApiProperty({ description: 'Organization phone', required: false })
  phone?: string;

  @ApiProperty({ description: 'Organization website URL', required: false })
  website_url?: string;

  @ApiProperty({ description: 'Organization location', required: false })
  location?: string;

  @ApiProperty({ description: 'Organization status' })
  status: string;

  @ApiProperty({ description: 'Organization role' })
  organization_role: string;

  @ApiProperty({ description: 'Organization specialties', required: false })
  specialties?: string[];

  @ApiProperty({ description: 'Organization services', required: false })
  services?: string[];

  @ApiProperty({ description: 'Organization description', required: false })
  description?: string;

  @ApiProperty({ description: 'Organization industry', required: false })
  industry?: string;

  @ApiProperty({ description: 'Number of employees', required: false })
  number_of_employees?: number;

  @ApiProperty({ description: 'Organization creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'Organization last update date' })
  updatedAt: Date;
}

export class GetProfileDto {
  @ApiProperty({ description: 'User ID' })
  id: string;

  @ApiProperty({ description: 'User email' })
  email: string;

  @ApiProperty({ description: 'User first name' })
  first_name: string;

  @ApiProperty({ description: 'User last name' })
  last_name: string;

  @ApiProperty({ description: 'User phone number' })
  phone: string;

  @ApiProperty({ description: 'User avatar URL' })
  avatar: string;

  @ApiProperty({ description: 'User job title' })
  job_title: string;

  @ApiProperty({ description: 'User role' })
  role: string;

  @ApiProperty({ description: 'User status' })
  status: string;

  @ApiProperty({ description: 'User verification status' })
  verified: boolean;

  @ApiProperty({
    description:
      'Whether the user has permanently dismissed the onboarding tour',
  })
  onboarding_tour_dismissed: boolean;

  @ApiProperty({ description: 'User creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'User last update date' })
  updatedAt: Date;

  @ApiProperty({
    description: 'Organization details',
    required: false,
    type: OrganizationDto,
  })
  organization?: OrganizationDto;
}
