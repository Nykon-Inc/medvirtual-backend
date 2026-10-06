import { ApiProperty } from '@nestjs/swagger';

/** Rows behind the Operational Dashboard KPI cards. Dates are ISO strings. */

export class HireRequestDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() organizationName: string;
  @ApiProperty() status: string;
  @ApiProperty() createdByName: string;
  @ApiProperty() createdAt: string;
}

export class StaffDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() position: string;
  @ApiProperty() companyName: string;
  @ApiProperty({ nullable: true }) startDate: string | null;
  @ApiProperty() createdAt: string;
}

export class ClientDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() businessUnit: string;
  @ApiProperty() activeStaffCount: number;
  @ApiProperty() createdAt: string;
}

export class ClientUserDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty() organizationName: string;
  @ApiProperty() status: string;
  @ApiProperty() createdAt: string;
  @ApiProperty({ nullable: true }) activatedAt: string | null;
}

export class TalentDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty() country: string;
  @ApiProperty() specialization: string;
  @ApiProperty() createdAt: string;
}

export class NewAvailableTalentDetailRowDto extends TalentDetailRowDto {
  @ApiProperty({ nullable: true }) firstAvailableAt: string | null;
}

export class EndorsedTalentDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty() endorsedBy: string;
  @ApiProperty() endorsedAt: string;
}

export class HiredTalentDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() hireRequestTitle: string;
  @ApiProperty() organizationName: string;
  @ApiProperty() hiredAt: string;
}

export class OfferPanelDetailRowDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() recipientName: string;
  @ApiProperty() recipientOrgName: string;
  @ApiProperty() sentBy: string;
  @ApiProperty() status: string;
  @ApiProperty() sentAt: string;
  @ApiProperty({ nullable: true }) viewedAt: string | null;
  @ApiProperty({ nullable: true }) decidedAt: string | null;
}

export class MetricDetailsMetaDto {
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
  @ApiProperty() page: number;
  @ApiProperty() perPage: number;
}

/** `{ data, meta }`; `meta` is omitted when `export=true`. */
export interface MetricDetailsResponse<T> {
  data: T[];
  meta?: MetricDetailsMetaDto;
}
