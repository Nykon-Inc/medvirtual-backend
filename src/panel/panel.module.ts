import { Module } from '@nestjs/common';
import { PanelController } from './panel.controller';
import { PanelService } from './panel.service';
import { PanelMetricDetailsService } from './panel-metric-details.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PositionRateConfigModule } from '../position-rate-config/position-rate-config.module';
import { BusinessUnitsModule } from '../business-units/business-units.module';

@Module({
  controllers: [PanelController],
  providers: [PanelService, PanelMetricDetailsService],
  imports: [PrismaModule, PositionRateConfigModule, BusinessUnitsModule],
})
export class PanelModule {}
