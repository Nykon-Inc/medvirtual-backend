import { ApiProperty } from '@nestjs/swagger';

export class HireRequestByClientRowDto {
  @ApiProperty()
  hireRequestId: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  createdByUserId: string;

  @ApiProperty()
  createdByName: string;

  @ApiProperty()
  organizationId: string;

  @ApiProperty()
  organizationName: string;
}

export class HireRequestsByClientsResponseDto {
  @ApiProperty({ type: [HireRequestByClientRowDto] })
  data: HireRequestByClientRowDto[];

  @ApiProperty({
    required: false,
    description: 'Omitted when export=true',
  })
  meta?: {
    total: number;
    totalPages: number;
    page: number;
    perPage: number;
  };
}
