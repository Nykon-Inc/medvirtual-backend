import { ApiProperty } from '@nestjs/swagger';

export class AdminLoginRowDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userName: string;

  @ApiProperty({
    description: 'Human-readable role label, e.g. "System Admin"',
  })
  role: string;

  @ApiProperty()
  loggedInAt: string;
}

export class AdminLoginsResponseDto {
  @ApiProperty({ type: [AdminLoginRowDto] })
  data: AdminLoginRowDto[];

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
