import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TraceQueueJob } from '../common/observability/trace-queue-job.decorator';
import { HubstaffService } from './hubstaff.service';
import { PrismaService } from '../prisma/prisma.service';
import { Logger } from '@nestjs/common';
import { HubspotService } from '../hubspot/hubspot.service';
import { Prisma } from '@prisma/client';

/**
 * The only fields this sync reads off a HubSpot candidate: `vaid` to match against
 * the Hubstaff profile and `hs_object_id` to find our local Candidate row. Fetching
 * the full candidate dictionary here would pull ~54 properties per record and throw
 * all but two away.
 */
const IDENTITY_PROPERTIES = ['vaid', 'hs_object_id'];

/**
 * Matches every spelling ops have used for the VA ID custom field:
 *
 *   "VA ID"  "VAID"  "VA_ID"  "VA-ID"  "VA.ID"  "va id"  "vaId"
 *   "Employee VA ID"  "VA ID Number"
 *
 * Matching the literal string 'VA ID' (the previous behaviour) silently dropped
 * every member whose field was named any other way — they were counted as
 * having no VA ID at all rather than as a naming mismatch.
 *
 * The surrounding boundaries matter. Simply stripping separators and testing
 * `includes('VAID')` also matches words that merely contain the letters, and a
 * wrongly-picked field would bind a bogus VA ID — which lands a VA's tracked
 * hours on someone else's invoice. Any variant this still misses will surface
 * in the "field names seen on members without a VA ID" log below.
 */
const VA_ID_KEY_PATTERN = /(^|[^a-z0-9])va[\s._-]*id($|[^a-z0-9])/i;

/** True for any custom-field key that denotes the VA ID, however it is spelled. */
function isVaIdKey(key: string): boolean {
  return VA_ID_KEY_PATTERN.test(key);
}

/**
 * A candidate row reduced to the columns this sync touches. Held in memory for
 * the whole run, so it stays deliberately narrow.
 */
interface CandidateRow {
  id: string;
  hubspot_id: string;
  hubstaff_id: string | null;
  /** Local copy of the VA ID. Read to decide whether the backfill has anything to do. */
  hubspot_vaid: string | null;
  /** Not used for matching — carried only so HUBSTAFF_SYNC_TRACE can find a row by email. */
  email: string;
}

/** The slice of a HubSpot search result this sync reads, given IDENTITY_PROPERTIES. */
interface HubspotIdentityRecord {
  id?: string;
  properties?: {
    vaid?: string;
    hs_object_id?: string;
  };
}

/**
 * Comma-separated needles that turn on verbose per-record tracing, e.g.
 *
 *   HUBSTAFF_SYNC_TRACE="jasson.alex.garcia@gmail.com"
 *   HUBSTAFF_SYNC_TRACE="cda6eeba-f6fc-40e2-b117-3498495bda3d,another@x.com"
 *
 * A needle is matched as a case-insensitive substring against whatever
 * identifiers are in scope at each stage — candidate id, candidate email,
 * hubspot_id, Hubstaff user id, Hubstaff email, or VA ID. Because this sync
 * matches on VA ID and never reads email, tracing by email is the only way to
 * pin a specific person from the Candidate record you have in front of you.
 *
 * Unset (the default) costs one null check per stage and logs nothing.
 */
const TRACE_NEEDLES: string[] = (process.env.HUBSTAFF_SYNC_TRACE ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

@Processor('hubstaff-sync')
export class HubstaffWorker extends WorkerHost {
  private readonly logger = new Logger(HubstaffWorker.name);

  constructor(
    private readonly hubstaffService: HubstaffService,
    private readonly prisma: PrismaService,
    private readonly hubspotService: HubspotService,
  ) {
    super();
  }

  @TraceQueueJob('hubstaff-sync')
  async process(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'sync-hubstaff-members':
        return await this.handleSyncMembers();
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  /** True when any supplied value contains one of the HUBSTAFF_SYNC_TRACE needles. */
  private isTraced(...values: (string | null | undefined)[]): boolean {
    if (TRACE_NEEDLES.length === 0) return false;
    return values.some((value) => {
      if (!value) return false;
      const haystack = value.toLowerCase();
      return TRACE_NEEDLES.some((needle) => haystack.includes(needle));
    });
  }

  private trace(message: string): void {
    this.logger.log(`🔬 [trace] ${message}`);
  }

  /**
   * Walks a traced candidate backwards through the pipeline and reports the
   * first stage that breaks: does the row exist, did the loaded candidate set
   * keep it, did the vaid search return its hubspot_id, and does any Hubstaff
   * member actually carry that VA ID.
   *
   * Queried directly rather than read off the loaded rows, so a candidate the
   * load missed still gets reported — being absent is itself the answer.
   */
  private async traceCandidates(
    hsRecords: HubspotIdentityRecord[],
    memberVaIdMap: Map<string, string>,
    loadedRows: CandidateRow[],
  ): Promise<void> {
    if (TRACE_NEEDLES.length === 0) return;

    const traced = await this.prisma.candidate.findMany({
      where: {
        OR: TRACE_NEEDLES.flatMap((needle) => [
          { id: { equals: needle } },
          { email: { contains: needle, mode: 'insensitive' as const } },
          { hubspot_id: { equals: needle } },
        ]),
      },
      select: {
        id: true,
        email: true,
        hubspot_id: true,
        hubstaff_id: true,
        hubspot_vaid: true,
      },
    });

    if (traced.length === 0) {
      this.trace(
        `no Candidate row matches ${JSON.stringify(TRACE_NEEDLES)} by id, email or hubspot_id`,
      );
      return;
    }

    const loadedIds = new Set(loadedRows.map((r) => r.id));

    for (const row of traced) {
      this.trace(
        `Candidate ${row.id} email=<${row.email}> hubspot_id=${row.hubspot_id} ` +
          `hubstaff_id=${row.hubstaff_id ?? 'null'} vaid=${row.hubspot_vaid ?? 'null'}`,
      );
      this.trace(
        `  ↳ survived the candidate-set filter? ${loadedIds.has(row.id) ? 'YES' : 'NO'}`,
      );

      const hsRecord = hsRecords.find((r) => String(r.id) === row.hubspot_id);
      const vaidOnRecord = hsRecord?.properties?.vaid?.trim();
      this.trace(
        `  ↳ in HubSpot response? ${
          hsRecord
            ? `YES (vaid=<${vaidOnRecord ?? 'none'}>)`
            : 'NO — its hubspot_id was not among the records the vaid search returned'
        }`,
      );

      const memberForVaid = vaidOnRecord
        ? [...memberVaIdMap.entries()].find(([, v]) => v === vaidOnRecord)
        : undefined;
      this.trace(
        `  ↳ a Hubstaff member carries that VA ID? ${
          memberForVaid
            ? `YES (user_id=${memberForVaid[0]})`
            : 'NO — nothing drives an update for this candidate'
        }`,
      );
    }
  }

  private async handleSyncMembers() {
    this.logger.log('🚀 Starting Hubstaff members sync...');

    try {
      const members = await this.hubstaffService.getOrganizationMembers();
      this.logger.log(`📡 Fetched ${members.length} members from Hubstaff`);

      // Extract all non-empty VA IDs from Hubstaff members
      const vaIds: string[] = [];
      const memberVaIdMap = new Map<string, string>(); // Maps member user_id to VA ID

      // Which literal spellings of the VA ID key are actually in use, and which
      // other field names appear on members that have none — the latter is where
      // an unhandled variant would show up.
      const vaIdKeyVariants = new Map<string, number>();
      const keysOnMembersWithoutVaId = new Map<string, number>();
      let blankVaIdCount = 0;
      let missingVaIdKeyCount = 0;

      const bump = (map: Map<string, number>, key: string) =>
        map.set(key, (map.get(key) ?? 0) + 1);

      for (const member of members) {
        const customFields = member.profile?.custom_fields ?? {};
        const vaIdKey = Object.keys(customFields).find(isVaIdKey);
        const vaId = vaIdKey ? customFields[vaIdKey]?.trim() : null;

        if (vaIdKey) {
          bump(vaIdKeyVariants, vaIdKey);
          if (!vaId) blankVaIdCount++;
        } else {
          missingVaIdKeyCount++;
          for (const key of Object.keys(customFields)) {
            bump(keysOnMembersWithoutVaId, key);
          }
        }

        if (this.isTraced(member.user?.email, String(member.user_id), vaId)) {
          this.trace(
            `Hubstaff member user_id=${member.user_id} email=<${member.user?.email ?? 'none'}> ` +
              `vaIdKey=${vaIdKey ?? 'NOT FOUND'} vaId=${vaId ?? 'null'} ` +
              `allCustomFields=${JSON.stringify(customFields)}`,
          );
        }

        if (vaId) {
          vaIds.push(vaId);
          memberVaIdMap.set(String(member.user_id), vaId);
        }
      }

      this.logger.log(`📡 Found ${vaIds.length} members with VA ID profiles`);
      this.logger.log(
        `🔑 VA ID key spellings in use: ${
          vaIdKeyVariants.size === 0
            ? 'none'
            : [...vaIdKeyVariants.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([key, count]) => `"${key}" ×${count}`)
                .join(', ')
        }`,
      );
      this.logger.log(
        `🔑 Members with no VA ID: ${missingVaIdKeyCount} missing the field entirely, ${blankVaIdCount} with the field present but blank`,
      );
      if (keysOnMembersWithoutVaId.size > 0) {
        // Any VA-ID-ish name appearing here is a variant isVaIdKey still misses.
        this.logger.log(
          `🔑 Field names seen on members without a VA ID: ${[
            ...keysOnMembersWithoutVaId.entries(),
          ]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([key, count]) => `"${key}" ×${count}`)
            .join(', ')}`,
        );
      }

      if (vaIds.length === 0) {
        this.logger.log(
          '🏁 Sync completed. No members with VA ID profiles found.',
        );
        return {
          updateCount: 0,
          vaIdBackfillCount: 0,
          skipCount: members.length,
        };
      }

      this.logger.log('📡 Fetching matched candidates from HubSpot...');
      const hubspotResult =
        await this.hubspotService.fetchPropertiesAndCandidates(
          vaIds,
          IDENTITY_PROPERTIES,
        );
      this.logger.log(
        `HubSpot candidates fetched: ${hubspotResult.candidates.length}`,
      );

      // Index the HubSpot response by VA ID. The previous .find() per member was
      // a full scan of the response for every one of them. First writer wins,
      // preserving .find()'s behaviour when HubSpot holds duplicate records for
      // one VA ID.
      const hsRecords = hubspotResult.candidates as HubspotIdentityRecord[];
      const hsByVaId = new Map<string, HubspotIdentityRecord>();
      for (const record of hsRecords) {
        const vaid = record.properties?.vaid?.trim();
        if (vaid && !hsByVaId.has(vaid)) {
          hsByVaId.set(vaid, record);
        }
      }

      for (const record of hsRecords) {
        if (this.isTraced(record.id, record.properties?.vaid)) {
          this.trace(
            `HubSpot record id=${record.id ?? 'none'} vaid=<${record.properties?.vaid ?? 'none'}> ` +
              `hs_object_id=${record.properties?.hs_object_id ?? 'none'}`,
          );
        }
      }

      const duplicateHsRecords = hsRecords.length - hsByVaId.size;
      if (duplicateHsRecords > 0) {
        this.logger.warn(
          `⚠️ ${duplicateHsRecords} HubSpot record(s) share a VA ID with another — first match wins, which may bind a stale record`,
        );
      }

      // Load the candidates once and serve every lookup from memory. This loop
      // previously issued up to three sequential queries per member (find by
      // hubspot_id, find the current hubstaff_id holder, and the writes), which
      // for ~880 members meant hundreds of round trips per run.
      //
      // The set is narrowed to two groups, and both are required:
      //
      //  1. Match targets — candidates whose hubspot_id came back from the vaid
      //     search. The loop can only ever reach a candidate via
      //     byHubspotId.get(hubspotId), so anything outside this set is dead
      //     weight. Deliberately NOT narrowed to candidates with a Staff record:
      //     a VA tracking time in Hubstaff is the same person whether or not a
      //     deal has landed yet, and the staff filter left those rows with a
      //     null hubstaff_id until one did.
      //  2. Current holders — whoever already owns one of the hubstaff_ids we
      //     might assign. hubstaff_id is uniquely indexed, so a holder outside
      //     group 1 still has to be found and released; omitting them would turn
      //     every reassignment into a P2002 unique-constraint violation.
      const hsIds = [
        ...new Set(hsRecords.map((r) => String(r.id)).filter(Boolean)),
      ];
      const memberUserIds = members.map((m) => String(m.user_id));

      const candidateRows: CandidateRow[] =
        await this.prisma.candidate.findMany({
          where: {
            OR: [
              { hubspot_id: { in: hsIds } },
              { hubstaff_id: { in: memberUserIds } },
            ],
          },
          select: {
            id: true,
            hubspot_id: true,
            hubstaff_id: true,
            hubspot_vaid: true,
            email: true,
          },
        });

      // Both maps hold the SAME row objects, so mutating a row after a write
      // keeps every view of it consistent for later iterations.
      const byHubspotId = new Map<string, CandidateRow>();
      const byHubstaffId = new Map<string, CandidateRow>();
      for (const row of candidateRows) {
        byHubspotId.set(row.hubspot_id, row);
        if (row.hubstaff_id) {
          byHubstaffId.set(row.hubstaff_id, row);
        }
      }
      this.logger.log(
        `🔎 Indexed ${candidateRows.length} candidate(s) — ${byHubstaffId.size} already carry a hubstaff_id`,
      );

      // How much of the HubSpot side we can actually act on. A low number here
      // means the gap is upstream — HubSpot returned VA records we hold no
      // Candidate row for — rather than a matching bug in the loop below.
      const hsIdSet = new Set(hsIds);
      const matchTargets = candidateRows.filter((r) =>
        hsIdSet.has(r.hubspot_id),
      ).length;
      this.logger.log(
        `📊 ${matchTargets} of the ${hsIds.length} returned hubspot_id(s) resolve to a local Candidate row`,
      );

      await this.traceCandidates(hsRecords, memberVaIdMap, candidateRows);

      let updateCount = 0;
      let vaIdBackfillCount = 0;
      let skipCount = 0;
      // Breakdown of the single skipCount above, so a run that updates nothing
      // says which stage dropped everything.
      const skipReasons = {
        no_va_id: 0,
        no_hubspot_match: 0,
        no_hubspot_id: 0,
        no_local_candidate: 0,
        already_synced: 0,
      };

      for (const member of members) {
        const hubstaffUserId = String(member.user_id);
        const vaId = memberVaIdMap.get(hubstaffUserId);
        const traced = this.isTraced(member.user?.email, hubstaffUserId, vaId);

        if (!vaId) {
          skipCount++;
          skipReasons.no_va_id++;
          if (traced) {
            this.trace(
              `member ${hubstaffUserId} SKIP no_va_id — no custom field matching 'VA ID'`,
            );
          }
          continue;
        }

        const matchedCandidate = hsByVaId.get(vaId);

        if (!matchedCandidate) {
          skipCount++;
          skipReasons.no_hubspot_match++;
          if (traced) {
            this.trace(
              `member ${hubstaffUserId} SKIP no_hubspot_match — vaId <${vaId}> absent from the ${hsRecords.length} HubSpot record(s) returned`,
            );
          }
          continue;
        }

        const hubspotId =
          matchedCandidate.id || matchedCandidate.properties?.hs_object_id;
        if (!hubspotId) {
          skipCount++;
          skipReasons.no_hubspot_id++;
          if (traced) {
            this.trace(
              `member ${hubstaffUserId} SKIP no_hubspot_id — matched record has neither id nor hs_object_id`,
            );
          }
          continue;
        }

        const candidate = byHubspotId.get(String(hubspotId));

        if (!candidate) {
          skipCount++;
          skipReasons.no_local_candidate++;
          if (traced) {
            this.trace(
              `member ${hubstaffUserId} SKIP no_local_candidate — no Candidate row has hubspot_id=${String(hubspotId)} (vaId <${vaId}>)`,
            );
          }
          continue;
        }

        if (traced) {
          this.trace(
            `member ${hubstaffUserId} resolved vaId <${vaId}> → hubspot_id ${String(hubspotId)} → candidate ${candidate.id} ` +
              `(current hubstaff_id=${candidate.hubstaff_id ?? 'null'}, current vaid=${candidate.hubspot_vaid ?? 'null'})`,
          );
        }

        const needsHubstaffId = candidate.hubstaff_id !== hubstaffUserId;
        // The VA ID is the key this whole match ran on, so persisting it costs
        // nothing extra and spares the next consumer a HubSpot round trip.
        // Gap-fill only: the candidate dictionary's `vaid` → `hubspot_vaid`
        // mapping is the primary writer and HubSpot the system of record, so a
        // value already on the row is left alone rather than overwritten from a
        // Hubstaff profile field ops edit by hand.
        const needsVaId = !candidate.hubspot_vaid;

        if (!needsHubstaffId && !needsVaId) {
          skipCount++;
          skipReasons.already_synced++;
          continue;
        }

        // hubstaff_id is uniquely indexed, so any current holder has to release
        // it first. Both writes go in one transaction: as two independent
        // updates, a failure between them left the id attached to neither row.
        // Only relevant when the id is actually moving — a vaid-only backfill
        // must not strip the id off whoever legitimately holds it.
        const currentHolder = needsHubstaffId
          ? byHubstaffId.get(hubstaffUserId)
          : undefined;

        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          if (currentHolder && currentHolder.id !== candidate.id) {
            await tx.candidate.update({
              where: { id: currentHolder.id },
              data: { hubstaff_id: null },
            });
            this.logger.debug(
              `Cleared hubstaff_id from candidate ${currentHolder.id} to avoid unique constraint conflict`,
            );
          }

          await tx.candidate.update({
            where: { id: candidate.id },
            data: {
              ...(needsHubstaffId ? { hubstaff_id: hubstaffUserId } : {}),
              ...(needsVaId ? { hubspot_vaid: vaId } : {}),
            },
          });
        });

        // Mirror the writes into the in-memory index so a later member reading
        // the same rows sees post-write state rather than the initial snapshot.
        if (needsHubstaffId) {
          if (currentHolder && currentHolder.id !== candidate.id) {
            currentHolder.hubstaff_id = null;
          }
          if (candidate.hubstaff_id) {
            byHubstaffId.delete(candidate.hubstaff_id);
          }
          candidate.hubstaff_id = hubstaffUserId;
          byHubstaffId.set(hubstaffUserId, candidate);

          updateCount++;
          this.logger.debug(
            `✅ Updated candidate ${candidate.id} with Hubstaff ID ${hubstaffUserId}`,
          );
        }

        if (needsVaId) {
          candidate.hubspot_vaid = vaId;
          vaIdBackfillCount++;
          this.logger.debug(
            `✅ Backfilled candidate ${candidate.id} with VA ID ${vaId}`,
          );
        }
      }

      this.logger.log(
        `🏁 Sync completed. Updated: ${updateCount}, VA IDs backfilled: ${vaIdBackfillCount}, ` +
          `Skipped/Not found: ${skipCount} ` +
          `(no VA ID: ${skipReasons.no_va_id}, no HubSpot match: ${skipReasons.no_hubspot_match}, ` +
          `no HubSpot id: ${skipReasons.no_hubspot_id}, no local candidate: ${skipReasons.no_local_candidate}, ` +
          `already synced: ${skipReasons.already_synced})`,
      );
      return { updateCount, vaIdBackfillCount, skipCount, skipReasons };
    } catch (error) {
      this.logger.error(
        '❌ Hubstaff members sync failed:',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
