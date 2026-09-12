import { forwardRef, Module } from '@nestjs/common';
import { BusinessUnitsService } from './business-units.service';
import { BusinessUnitsController } from './business-units.controller';
import { BusinessUnitContext } from './business-unit-context.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HubspotModule } from '../hubspot/hubspot.module';
import { CandidateAuditModule } from '../candidate/candidate-audit.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => HubspotModule),
    CandidateAuditModule,
  ],
  controllers: [BusinessUnitsController],
  providers: [BusinessUnitsService, BusinessUnitContext],
  exports: [BusinessUnitsService, BusinessUnitContext],
})
export class BusinessUnitsModule {}
