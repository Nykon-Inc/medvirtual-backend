import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UserAuditService } from './user-audit.service';

// Global: the USER lifecycle is written from ~10 feature modules (auth, user, organization,
// affiliates, business units, HubSpot handlers, cron, recovery, invoice).
@Global()
@Module({
  imports: [PrismaModule],
  providers: [UserAuditService],
  exports: [UserAuditService],
})
export class UserAuditModule {}
