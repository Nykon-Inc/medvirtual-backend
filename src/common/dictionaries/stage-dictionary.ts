export const dbToStageDictionary: Record<number, string> = {
  //id => name
  942502182: 'New Candidates',
  1119641993: 'Incomplete Information',
  1119641994: 'Follow Up Candidates',
  966446725: 'For Account Manager Interview',
  261075105: 'Available Candidates',
  1087596819: 'Available Candidates - Part Time',
  1087596820: 'Endorsed to Client - Part Time',
  1172847191: 'Endorsed via Platform',
  261137285: 'Endorsed to Client',
  261173426: 'Pairing Booked',
  261214844: 'Hired',
  261173427: 'For Endorsement to VS',
  261173428: 'Lost',
};

export const stageToDbDictionary: Record<string, number> = Object.entries(
  dbToStageDictionary,
).reduce(
  (acc, [num, label]) => {
    acc[label] = Number(num);
    return acc;
  },
  {} as Record<string, number>,
);

// Stages a candidate is considered "available" for placement — the only
// stages pipeline_status_origin should ever be set to, since it's the stage
// candidates are returned to when pulled out of a panel/hire request.
export const availableStages = ['261075105', '1087596819'];
