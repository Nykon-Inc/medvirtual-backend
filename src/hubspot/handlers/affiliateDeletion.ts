import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AffiliateStatus, UserAuditSource } from '@prisma/client';
import { UserAuditService } from '../../user-audit/user-audit.service';

@Injectable()
export class HandlerAffiliateDeletion {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userAudit: UserAuditService,
  ) {}

  async execute(event) {
    try {
      const affiliateExists = await this.prisma.affiliateProfile.findUnique({
        where: {
          hubspot_id: String(event.objectId),
        },
        include: {
          user: true,
        },
      });
      if (!affiliateExists) return;

      if (affiliateExists.user?.role === 'affiliate') {
        await this.prisma.affiliateProfile.update({
          where: {
            id: affiliateExists.id,
          },
          data: {
            status: AffiliateStatus.inactive,
            hubspot_id_before_deletion: affiliateExists.hubspot_id,
            hubspot_id: null,
          },
        });

        await this.prisma.uSER.update({
          where: {
            id: affiliateExists.user.id,
          },
          data: {
            status: 'inactive',
          },
        });

        await this.userAudit.logUpdate({
          before: affiliateExists.user,
          after: { status: 'inactive' },
          source: UserAuditSource.webhook,
          actorLabel: 'HubSpot',
          reason: 'growth_partner_deleted_in_hubspot',
          metadata: {
            origin: 'hubspot_affiliate_deletion',
            affiliate_profile_id: affiliateExists.id,
          },
        });
      } else {
        await this.prisma.affiliateProfile.update({
          where: {
            id: affiliateExists.id,
          },
          data: {
            status: AffiliateStatus.inactive,
            hubspot_id_before_deletion: affiliateExists.hubspot_id,
            hubspot_id: null,
          },
        });
      }
    } catch (error) {
      throw new BadRequestException('Error deleting affiliate', error);
    }
  }
}
