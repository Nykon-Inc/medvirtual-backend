import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { mapDealToDb } from '../../common/utils/hubspot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { dealToDbDictionary } from '../../common/dictionaries/deal-dictionary';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, retries = 3, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (
      retries > 0 &&
      axios.isAxiosError(err) &&
      err.response?.status === 429
    ) {
      await sleep(delay);
      return retry(fn, retries - 1, delay * 2); // exponential backoff
    }
    throw err;
  }
}

@Injectable()
export class HandlerDealCreation {
  constructor(private readonly prisma: PrismaService) {}

  async execute(event, organization?: any) {
    try {
      const dealExists = await this.prisma.staff.findUnique({
        where: {
          hubspot_id: String(event.objectId),
        },
      });
      if (dealExists) {
        console.log(
          `Deal with Hubspot ID ${event.objectId} already exists. Skipping creation.`,
        );
        return;
      }

      const properties = Object.keys(dealToDbDictionary).join(',');
      const getObject = await retry(() =>
        axios.get(
          `https://api.hubapi.com/crm/v3/objects/deals/${event.objectId}?properties=${properties}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      if (!getObject) {
        throw new BadRequestException('No object data found');
      }

      if (
        getObject.data.properties.pipeline &&
        getObject.data.properties.pipeline !== '5155250' &&
        getObject.data.properties.pipeline !== '85165570'
      )
        return; //Only process deals from BV OPERATIONS PIPELINE (5155250) OU MV OPERATIONS (85165570)

      const dealData = mapDealToDb(getObject.data.properties);
      dealData.status = 'active';
      //console.log('dealData before date conversion: ', dealData);
      dealData.hubspot_close_date = dealData.hubspot_close_date
        ? new Date(dealData.hubspot_close_date)
        : null;
      dealData.start_date = dealData.start_date
        ? new Date(dealData.start_date)
        : null;
      dealData.hubspot_commission_start_date =
        dealData.hubspot_commission_start_date
          ? new Date(dealData.hubspot_commission_start_date)
          : null;

      if (organization) {
        //organization cames from syncOrganizationDeals
        //If organization is provided, we use it directly
        dealData.hubspot_candidate_id = null; //When syncing from organization, we don't have candidate association
        dealData.candidate_id = null;
        dealData.hubspot_organization_id = organization.hubspot_id;
        dealData.organization_id = organization.id;
      } else {
        //Here I need to check if we alreadey have an candidate (VirtualAssistant) before we proceed with the deal Creation
        const getObjectVA = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/deals/${event.objectId}/associations/${process.env.HUBSPOT_CUSTOM_OBJECT}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );

        if (getObjectVA?.data?.results?.length > 0) {
          dealData.hubspot_candidate_id = getObjectVA.data.results[0].id;

          const candidateExists = await this.prisma.candidate.findUnique({
            where: {
              hubspot_id: String(dealData.hubspot_candidate_id),
            },
            select: {
              id: true,
            },
          });
          if (candidateExists) dealData.candidate_id = candidateExists.id;
        }

        const getObjectCompany = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/deals/${event.objectId}/associations/companies`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );
        if (getObjectCompany?.data?.results?.length > 0) {
          dealData.hubspot_organization_id =
            getObjectCompany.data.results[0].id;
          const organizationExists = await this.prisma.organization.findUnique({
            where: {
              hubspot_id: String(dealData.hubspot_organization_id),
            },
            select: {
              id: true,
              status: true,
            },
          });
          if (organizationExists)
            dealData.organization_id = organizationExists.id;
          if (organizationExists && organizationExists.status === 'inactive') {
            await this.prisma.organization.update({
              where: { id: organizationExists.id },
              data: { status: 'active' },
            });
          }
        }
      }

      const dealCreated = await this.prisma.staff.create({
        data: dealData,
      });
      if (!dealCreated) {
        throw new BadRequestException('Error creating Deal in the database');
      }

      return true;
    } catch (error) {
      console.error(`❌ Error fetching deal ${event.objectId} from HubSpot`);
      console.error('Status:', error.response?.status);
      console.error('Data:', error.response?.data);
      console.error('Message:', error.message);
      throw new BadRequestException(
        `Error fetching object creation Deal: ${error.message}`,
      );
    }
  }
}
