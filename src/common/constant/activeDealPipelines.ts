import { dealPipelineToDbDictionary } from '../dictionaries/deal-pipeline-dictionary';

export const activePipelines = Object.entries(
  dealPipelineToDbDictionary,
).filter(
  ([key]) =>
    key !== '148234581' &&
    key !== '1012779094' &&
    key !== '16981844' &&
    key !== '31963952' &&
    key !== '159176450' &&
    key !== '1012777775' &&
    key !== '159176451' &&
    key !== '159176452',
);

/**
 * Staff "active placement" filter used by the operational dashboard (panel)
 * and by the client-users list, so both agree on what "organization with
 * active staff" means: status 'active' AND a deal stage in an active pipeline.
 *
 * Not to be confused with ACTIVE_STAFF_STATUS_FILTER in
 * organizationActiveStaff.util.ts (pairing-type classification).
 */
export const ACTIVE_PIPELINE_STAFF_WHERE = {
  status: 'active',
  hubspot_dealstage: { in: activePipelines.map(([key]) => String(key)) },
};
