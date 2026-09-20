import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HubstaffService } from './hubstaff.service';
import {
  CANDIDATE_EMAIL_PROPERTIES,
  HubspotService,
} from '../hubspot/hubspot.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The only fields this sync reads off a HubSpot candidate: the email properties
 * and `vaid` to match against the Hubstaff profile, and `hs_object_id` to find
 * our local Candidate row. Fetching the full candidate dictionary here would
 * pull ~54 properties per record and throw all but a handful away.
 */
const IDENTITY_PROPERTIES = [
  'vaid',
  'hs_object_id',
  ...CANDIDATE_EMAIL_PROPERTIES,
];

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
 * Emails are compared case-insensitively and whitespace-trimmed. HubSpot
 * lowercases what it stores; Hubstaff keeps whatever the user typed at signup,
 * so "Jane.Doe@Gmail.com " and "jane.doe@gmail.com" are the same VA.
 */
function normaliseEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * A candidate row reduced to the columns this sync touches. Held in memory for
 * the whole run, so it stays deliberately narrow.
 */
interface CandidateRow {
  id: string;
  hubspot_id: string;
  hubstaff_id: string | null;
  /** Not used for matching — carried only so HUBSTAFF_SYNC_TRACE can find a row by email. */
  email: string;
}

/** The slice of a HubSpot search result this sync reads, given IDENTITY_PROPERTIES. */
interface HubspotIdentityRecord {
  id?: string;
  properties?: {
    vaid?: string;
    hs_object_id?: string;
    /** One entry per CANDIDATE_EMAIL_PROPERTIES name. */
    [property: string]: string | undefined;
  };
}

/**
 * Every email a HubSpot record carries, strongest identifier first. Used both
 * to index the record and to report which property produced a match.
 */
function emailsOnRecord(
  record: HubspotIdentityRecord,
): { property: string; email: string }[] {
  const found: { property: string; email: string }[] = [];
  for (const property of CANDIDATE_EMAIL_PROPERTIES) {
    const email = normaliseEmail(record.properties?.[property]);
    if (email) found.push({ property, email });
  }
  return found;
}

/** How a Hubstaff member was resolved to a HubSpot record. */
type MatchSource = 'email' | 'va_id';

/** What the sync concluded about one Hubstaff member. */
export type HubstaffSyncRowStatus =
  /** Candidate already carries this hubstaff_id — nothing to do. */
  | 'already_linked'
  /** Resolved to a Candidate whose hubstaff_id is unset. */
  | 'would_link'
  /** Resolved to a Candidate, but another Candidate currently holds the id. */
  | 'would_relink'
  /** No HubSpot record carries this member's email or VA ID. */
  | 'no_hubspot_match'
  /** Matched a HubSpot record, but no staffed Candidate row has its id. */
  | 'no_staffed_candidate'
  /** Matched a HubSpot record that has neither an id nor an hs_object_id. */
  | 'no_hubspot_id'
  /** Neither an email nor a VA ID to match on. */
  | 'no_identifier';

/**
 * One member's resolution, flattened for export. Collected only when
 * `collectRows` is set — the worker returns its result into Redis, where ~900
 * of these would be dead weight on every job.
 */
export interface HubstaffSyncRow {
  hubstaffUserId: string;
  name: string | null;
  hubstaffEmail: string | null;
  vaIdInHubstaff: string | null;
  status: HubstaffSyncRowStatus;
  matchSource: MatchSource | null;
  /** Which HubSpot property carried the matching email. */
  matchProperty: string | null;
  hubspotId: string | null;
  hubspotEmails: { property: string; email: string }[];
  hubspotVaId: string | null;
  candidateId: string | null;
  candidateEmail: string | null;
  candidateCurrentHubstaffId: string | null;
  /**
   * True when the email and the VA ID point at different HubSpot records — the
   * population where the two systems genuinely disagree, rather than one simply
   * having no answer.
   */
  identifiersDisagree: boolean;
  /** The record the identifier that did NOT win pointed at. */
  alternateHubspotId: string | null;
  /** Candidate that would lose this hubstaff_id, on a would_relink. */
  displacedCandidateId: string | null;
  displacedCandidateEmail: string | null;
}

/** A Candidate holding a hubstaff_id that no current Hubstaff member has. */
export interface HubstaffStaleBinding {
  candidateId: string;
  candidateEmail: string;
  hubspotId: string;
  hubstaffId: string;
}

export interface HubstaffSyncResult {
  updateCount: number;
  skipCount: number;
  skipReasons: Record<string, number>;
  matchedBy: Record<MatchSource, number>;
  /** Subset of matchedBy.va_id whose email match dead-ended at an unstaffed record. */
  recoveredByVaIdAfterEmail: number;
  /** Present only when `collectRows` was set. */
  rows?: HubstaffSyncRow[];
  /** Present only when `collectRows` was set. */
  staleBindings?: HubstaffStaleBinding[];
}

export interface HubstaffSyncOptions {
  /**
   * Resolve and report every match but write nothing. Used by
   * `scripts/diagnose-hubstaff-sync.ts` to preview a run against live data.
   */
  dryRun?: boolean;
  /**
   * Return a per-member row and the stale bindings alongside the counters, for
   * the CSV export ops fills in. Off by default.
   */
  collectRows?: boolean;
}

/**
 * Comma-separated needles that turn on verbose per-record tracing, e.g.
 *
 *   HUBSTAFF_SYNC_TRACE="jasson.alex.garcia@gmail.com"
 *   HUBSTAFF_SYNC_TRACE="cda6eeba-f6fc-40e2-b117-3498495bda3d,another@x.com"
 *
 * A needle is matched as a case-insensitive substring against whatever
 * identifiers are in scope at each stage — candidate id, candidate email,
 * hubspot_id, Hubstaff user id, Hubstaff email, or VA ID.
 *
 * Unset (the default) costs one null check per stage and logs nothing.
 */
const TRACE_NEEDLES: string[] = (process.env.HUBSTAFF_SYNC_TRACE ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

/**
 * Binds Hubstaff members to our Candidate rows by way of their HubSpot record.
 *
 * Matching is email-first: the VA's email address is the one identifier both
 * systems hold natively, while the VA ID is a hand-entered custom field on both
 * sides and is blank or mistyped on a large share of records. The VA ID remains
 * the fallback, so every pairing the previous behaviour found is still found.
 */
@Injectable()
export class HubstaffSyncService {
  private readonly logger = new Logger(HubstaffSyncService.name);

  constructor(
    private readonly hubstaffService: HubstaffService,
    private readonly prisma: PrismaService,
    private readonly hubspotService: HubspotService,
  ) {}

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
   * first stage that breaks: does the row exist, does it have Staff records,
   * did the candidate-set filter keep it, did the HubSpot search return its
   * hubspot_id, and does any Hubstaff member carry its email or VA ID.
   *
   * Queried directly rather than read off the loaded rows, so a candidate the
   * filter excluded still gets reported — being excluded is itself the answer.
   */
  private async traceCandidates(
    hsRecords: HubspotIdentityRecord[],
    memberEmails: Set<string>,
    memberVaIds: Set<string>,
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
        staff: { select: { id: true, hubspot_id: true } },
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
        `Candidate ${row.id} email=<${row.email}> hubspot_id=${row.hubspot_id} hubstaff_id=${row.hubstaff_id ?? 'null'}`,
      );
      this.trace(
        `  ↳ staff records: ${
          row.staff.length === 0
            ? 'NONE — excluded by the staff filter, so the sync cannot reach it'
            : JSON.stringify(row.staff)
        }`,
      );
      this.trace(
        `  ↳ survived the candidate-set filter? ${loadedIds.has(row.id) ? 'YES' : 'NO'}`,
      );

      const hsRecord = hsRecords.find((r) => String(r.id) === row.hubspot_id);
      const emailsFound = hsRecord ? emailsOnRecord(hsRecord) : [];
      const vaidOnRecord = hsRecord?.properties?.vaid?.trim();
      this.trace(
        `  ↳ in HubSpot response? ${
          hsRecord
            ? `YES (emails=${JSON.stringify(emailsFound)} vaid=<${vaidOnRecord ?? 'none'}>)`
            : 'NO — its hubspot_id was not among the records the email/vaid searches returned'
        }`,
      );

      const emailHits = emailsFound.filter((e) => memberEmails.has(e.email));
      const vaIdHit = vaidOnRecord ? memberVaIds.has(vaidOnRecord) : false;
      this.trace(
        `  ↳ a Hubstaff member carries that identifier? ${
          emailHits.length > 0 || vaIdHit
            ? `YES (${[
                emailHits.length > 0 &&
                  `email via ${emailHits.map((e) => e.property).join('/')}`,
                vaIdHit && 'va_id',
              ]
                .filter(Boolean)
                .join(' + ')})`
            : 'NO — nothing drives an update for this candidate'
        }`,
      );
    }
  }

  async syncMembers(
    options: HubstaffSyncOptions = {},
  ): Promise<HubstaffSyncResult> {
    const dryRun = options.dryRun === true;
    this.logger.log(
      `🚀 Starting Hubstaff members sync${dryRun ? ' (DRY RUN — no writes)' : ''}...`,
    );

    try {
      const members = await this.hubstaffService.getOrganizationMembers();
      this.logger.log(`📡 Fetched ${members.length} members from Hubstaff`);

      // ── Identifiers on the Hubstaff side ────────────────────────────────
      const emails: string[] = [];
      const vaIds: string[] = [];
      /** user_id → the identifiers that member can be matched on. */
      const memberIdentities = new Map<
        string,
        { email: string | null; vaId: string | null }
      >();

      // Which literal spellings of the VA ID key are actually in use, and which
      // other field names appear on members that have none — the latter is where
      // an unhandled variant would show up.
      const vaIdKeyVariants = new Map<string, number>();
      const keysOnMembersWithoutVaId = new Map<string, number>();
      let blankVaIdCount = 0;
      let missingVaIdKeyCount = 0;
      let missingEmailCount = 0;

      const bump = (map: Map<string, number>, key: string) =>
        map.set(key, (map.get(key) ?? 0) + 1);

      for (const member of members) {
        const customFields = member.profile?.custom_fields ?? {};
        const vaIdKey = Object.keys(customFields).find(isVaIdKey);
        const vaId = (vaIdKey ? customFields[vaIdKey]?.trim() : null) || null;
        const email = normaliseEmail(member.user?.email);

        if (vaIdKey) {
          bump(vaIdKeyVariants, vaIdKey);
          if (!vaId) blankVaIdCount++;
        } else {
          missingVaIdKeyCount++;
          for (const key of Object.keys(customFields)) {
            bump(keysOnMembersWithoutVaId, key);
          }
        }
        if (!email) missingEmailCount++;

        if (this.isTraced(email, String(member.user_id), vaId)) {
          this.trace(
            `Hubstaff member user_id=${member.user_id} email=<${email ?? 'none'}> ` +
              `vaIdKey=${vaIdKey ?? 'NOT FOUND'} vaId=${vaId ?? 'null'} ` +
              `allCustomFields=${JSON.stringify(customFields)}`,
          );
        }

        memberIdentities.set(String(member.user_id), { email, vaId });
        if (email) emails.push(email);
        if (vaId) vaIds.push(vaId);
      }

      const uniqueEmails = [...new Set(emails)];
      const uniqueVaIds = [...new Set(vaIds)];

      this.logger.log(
        `📡 Identifiers on the Hubstaff side: ${uniqueEmails.length} distinct email(s) ` +
          `(${missingEmailCount} member(s) have none), ${uniqueVaIds.length} distinct VA ID(s)`,
      );
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

      if (uniqueEmails.length === 0 && uniqueVaIds.length === 0) {
        this.logger.log(
          '🏁 Sync completed. No members carry an email address or a VA ID.',
        );
        return {
          updateCount: 0,
          skipCount: members.length,
          skipReasons: { no_identifier: members.length },
          matchedBy: { email: 0, va_id: 0 },
          recoveredByVaIdAfterEmail: 0,
        };
      }

      // ── HubSpot lookups ─────────────────────────────────────────────────
      // Two searches, union of results. Neither is a superset of the other: a
      // record can carry an email we know and no VA ID, or a VA ID we know and
      // an email that differs from the Hubstaff one.
      this.logger.log('📡 Fetching matched candidates from HubSpot...');
      const [byEmailResult, byVaIdResult] = await Promise.all([
        uniqueEmails.length > 0
          ? this.hubspotService.fetchCandidatesByEmails(
              uniqueEmails,
              IDENTITY_PROPERTIES,
            )
          : Promise.resolve({ candidates: [] }),
        uniqueVaIds.length > 0
          ? this.hubspotService.fetchPropertiesAndCandidates(
              uniqueVaIds,
              IDENTITY_PROPERTIES,
            )
          : Promise.resolve({ candidates: [] }),
      ]);

      // Deduplicate by record id — a record matched by both searches comes back
      // twice, and counting it twice would inflate the duplicate warnings below.
      const hsById = new Map<string, HubspotIdentityRecord>();
      for (const record of [
        ...byEmailResult.candidates,
        ...byVaIdResult.candidates,
      ] as HubspotIdentityRecord[]) {
        const id = record.id ?? record.properties?.hs_object_id;
        if (id) hsById.set(String(id), record);
      }
      const hsRecords = [...hsById.values()];
      this.logger.log(
        `HubSpot candidates fetched: ${hsRecords.length} distinct ` +
          `(${byEmailResult.candidates.length} by email, ${byVaIdResult.candidates.length} by VA ID)`,
      );

      // Index the response by every identifier it carries. First writer wins,
      // preserving the previous .find() behaviour when HubSpot holds duplicate
      // records for one identifier.
      //
      // Email indexing walks CANDIDATE_EMAIL_PROPERTIES in precedence order and
      // is pass-per-property, not record-by-record: a weaker property on record
      // A must never claim an address that a stronger property on record B
      // holds, which is exactly what a single pass over the records would do.
      const hsByEmail = new Map<
        string,
        { record: HubspotIdentityRecord; property: string }
      >();
      const hsByVaId = new Map<string, HubspotIdentityRecord>();
      const emailPropertyHits = new Map<string, number>();
      let duplicateEmails = 0;
      let duplicateVaIds = 0;

      for (const property of CANDIDATE_EMAIL_PROPERTIES) {
        for (const record of hsRecords) {
          const email = normaliseEmail(record.properties?.[property]);
          if (!email) continue;
          if (hsByEmail.has(email)) {
            duplicateEmails++;
            continue;
          }
          hsByEmail.set(email, { record, property });
          emailPropertyHits.set(
            property,
            (emailPropertyHits.get(property) ?? 0) + 1,
          );
        }
      }

      for (const record of hsRecords) {
        const vaid = record.properties?.vaid?.trim();
        if (vaid) {
          if (hsByVaId.has(vaid)) duplicateVaIds++;
          else hsByVaId.set(vaid, record);
        }

        if (
          this.isTraced(
            record.id,
            record.properties?.vaid,
            ...emailsOnRecord(record).map((e) => e.email),
          )
        ) {
          this.trace(
            `HubSpot record id=${record.id ?? 'none'} ` +
              `emails=${JSON.stringify(emailsOnRecord(record))} ` +
              `vaid=<${record.properties?.vaid ?? 'none'}> ` +
              `hs_object_id=${record.properties?.hs_object_id ?? 'none'}`,
          );
        }
      }

      this.logger.log(
        `📇 Indexed ${hsByEmail.size} distinct HubSpot email(s) by property: ${
          [...emailPropertyHits.entries()]
            .map(([property, count]) => `${property} ×${count}`)
            .join(', ') || 'none'
        }`,
      );
      if (duplicateEmails > 0 || duplicateVaIds > 0) {
        this.logger.warn(
          `⚠️ Duplicate HubSpot records: ${duplicateEmails} carry an email already claimed by another ` +
            `record (or by a stronger property), ${duplicateVaIds} share a VA ID — ` +
            `first match wins, which may bind a stale record`,
        );
      }

      // ── Local candidates ────────────────────────────────────────────────
      // Load the candidates once and serve every lookup from memory. This loop
      // previously issued up to three sequential queries per member (find by
      // hubspot_id, find the current hubstaff_id holder, and the writes), which
      // for ~880 members meant hundreds of round trips per run.
      //
      // The set is narrowed to two groups, and both are required:
      //
      //  1. Match targets — candidates whose hubspot_id came back from the
      //     HubSpot searches AND that have at least one Staff record. The loop
      //     can only ever reach a candidate via byHubspotId.get(hubspotId), so
      //     anything outside this set is dead weight.
      //  2. Current holders — whoever already owns one of the hubstaff_ids we
      //     might assign. hubstaff_id is uniquely indexed, so a holder outside
      //     group 1 still has to be found and released; omitting them would turn
      //     every reassignment into a P2002 unique-constraint violation.
      const hsIds = [...hsById.keys()];
      const memberUserIds = members.map((m) => String(m.user_id));

      const candidateRows: CandidateRow[] =
        await this.prisma.candidate.findMany({
          where: {
            OR: [
              { hubspot_id: { in: hsIds }, staff: { some: {} } },
              { hubstaff_id: { in: memberUserIds } },
            ],
          },
          select: {
            id: true,
            hubspot_id: true,
            hubstaff_id: true,
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

      // Separate the two reasons a match target can be missing, which the
      // no_local_candidate counter alone conflates: the candidate genuinely does
      // not exist, versus it exists but has no Staff record and was filtered
      // out. Without this split a low match rate looks like a matching problem
      // when it may just be that few candidates are staffed.
      const hsIdSet = new Set(hsIds);
      const staffedTargets = candidateRows.filter((r) =>
        hsIdSet.has(r.hubspot_id),
      ).length;
      const targetsIgnoringStaffFilter = await this.prisma.candidate.count({
        where: { hubspot_id: { in: hsIds } },
      });
      this.logger.log(
        `📊 ${targetsIgnoringStaffFilter} candidate(s) carry one of the ${hsIds.length} returned hubspot_id(s); ` +
          `${staffedTargets} of those have a Staff record ` +
          `(${targetsIgnoringStaffFilter - staffedTargets} excluded by the staff filter)`,
      );

      await this.traceCandidates(
        hsRecords,
        new Set(uniqueEmails),
        new Set(uniqueVaIds),
        candidateRows,
      );

      // ── Per-member resolution ───────────────────────────────────────────
      let updateCount = 0;
      let skipCount = 0;
      // Breakdown of the single skipCount above, so a run that updates nothing
      // says which stage dropped everything.
      const skipReasons = {
        no_identifier: 0,
        no_hubspot_match: 0,
        no_hubspot_id: 0,
        no_local_candidate: 0,
        already_synced: 0,
      };
      const matchedBy: Record<MatchSource, number> = { email: 0, va_id: 0 };
      // Members the email match found a HubSpot record for, but whose record has
      // no staffed Candidate row — so the VA ID's (different) record supplied the
      // binding instead. Worth its own counter: it is the population where the
      // two identifiers disagree about which of HubSpot's duplicate records for
      // a VA is the current one, and a jump here means the duplicates grew.
      let recoveredByVaIdAfterEmail = 0;
      const rows: HubstaffSyncRow[] = [];

      for (const member of members) {
        const hubstaffUserId = String(member.user_id);
        const { email, vaId } = memberIdentities.get(hubstaffUserId) ?? {
          email: null,
          vaId: null,
        };
        const traced = this.isTraced(email, hubstaffUserId, vaId);

        /**
         * Records this member's outcome for the CSV export. Called at every exit
         * from the loop body, so a member can never be silently absent from the
         * export — "not in the file" and "no problem found" would be
         * indistinguishable to whoever is filling it in.
         */
        const record = (
          status: HubstaffSyncRowStatus,
          detail: Partial<HubstaffSyncRow> = {},
        ) => {
          if (!options.collectRows) return;
          rows.push({
            hubstaffUserId,
            name: member.user?.name ?? null,
            hubstaffEmail: email,
            vaIdInHubstaff: vaId,
            status,
            matchSource: null,
            matchProperty: null,
            hubspotId: null,
            hubspotEmails: [],
            hubspotVaId: null,
            candidateId: null,
            candidateEmail: null,
            candidateCurrentHubstaffId: null,
            identifiersDisagree: false,
            alternateHubspotId: null,
            displacedCandidateId: null,
            displacedCandidateEmail: null,
            ...detail,
          });
        };

        if (!email && !vaId) {
          skipCount++;
          skipReasons.no_identifier++;
          record('no_identifier');
          if (traced) {
            this.trace(
              `member ${hubstaffUserId} SKIP no_identifier — no email on the Hubstaff user and no custom field matching 'VA ID'`,
            );
          }
          continue;
        }

        // Email is the primary key between the two systems, the VA ID the
        // fallback. Both are tried in order and the first one that reaches a
        // staffed Candidate row wins: HubSpot keeps several records per VA, so
        // an email can legitimately match a record that was never staffed while
        // the VA ID points at the record that was. Stopping at the email match
        // in that case would leave the member unbound.
        const emailHit = email ? hsByEmail.get(email) : undefined;
        const vaIdHit = vaId ? hsByVaId.get(vaId) : undefined;

        const attempts: {
          source: MatchSource;
          record: HubspotIdentityRecord;
          property?: string;
        }[] = [];
        if (emailHit) {
          attempts.push({
            source: 'email',
            record: emailHit.record,
            property: emailHit.property,
          });
        }
        if (vaIdHit && vaIdHit !== emailHit?.record) {
          attempts.push({ source: 'va_id', record: vaIdHit });
        }

        // Both identifiers found a record, but not the same one. This is the
        // disagreement ops has to settle: HubSpot holds several records per VA
        // and no matching rule can tell which one is current.
        const identifiersDisagree = !!emailHit && attempts.length > 1;
        const idOf = (r?: HubspotIdentityRecord) => {
          const id = r?.id || r?.properties?.hs_object_id;
          return id ? String(id) : null;
        };

        if (attempts.length === 0) {
          skipCount++;
          skipReasons.no_hubspot_match++;
          record('no_hubspot_match');
          if (traced) {
            this.trace(
              `member ${hubstaffUserId} SKIP no_hubspot_match — neither email <${email ?? 'none'}> ` +
                `nor vaId <${vaId ?? 'none'}> is on any of the ${hsRecords.length} HubSpot record(s) returned`,
            );
          }
          continue;
        }

        let resolved:
          | {
              source: MatchSource;
              property?: string;
              hubspotId: string;
              candidate: CandidateRow;
            }
          | undefined;
        let anyHubspotId = false;

        for (const attempt of attempts) {
          const id =
            attempt.record.id || attempt.record.properties?.hs_object_id;
          if (!id) continue;
          anyHubspotId = true;

          const row = byHubspotId.get(String(id));
          if (row) {
            resolved = {
              source: attempt.source,
              property: attempt.property,
              hubspotId: String(id),
              candidate: row,
            };
            break;
          }
        }

        if (!resolved) {
          skipCount++;
          const first = attempts[0];
          const detail: Partial<HubstaffSyncRow> = {
            matchSource: first.source,
            matchProperty: first.property ?? null,
            hubspotId: idOf(first.record),
            hubspotEmails: emailsOnRecord(first.record),
            hubspotVaId: first.record.properties?.vaid?.trim() ?? null,
            identifiersDisagree,
            alternateHubspotId: idOf(attempts[1]?.record),
          };

          if (!anyHubspotId) {
            skipReasons.no_hubspot_id++;
            record('no_hubspot_id', detail);
            if (traced) {
              this.trace(
                `member ${hubstaffUserId} SKIP no_hubspot_id — no matched record has an id or hs_object_id`,
              );
            }
          } else {
            skipReasons.no_local_candidate++;
            record('no_staffed_candidate', detail);
            if (traced) {
              this.trace(
                `member ${hubstaffUserId} SKIP no_local_candidate — no staffed Candidate row for any of ` +
                  `${attempts.length} matched record(s) (tried ${attempts.map((a) => a.source).join(', ')})`,
              );
            }
          }
          continue;
        }

        const { candidate, hubspotId } = resolved;
        const matchSource = resolved.source;
        /** Which HubSpot property carried the matching email, for the logs. */
        const matchProperty = resolved.property;
        if (matchSource === 'va_id' && emailHit) {
          recoveredByVaIdAfterEmail++;
        }

        matchedBy[matchSource]++;

        const resolvedRecord = attempts.find(
          (a) => a.source === matchSource,
        )!.record;
        const rowDetail: Partial<HubstaffSyncRow> = {
          matchSource,
          matchProperty: matchProperty ?? null,
          hubspotId: String(hubspotId),
          hubspotEmails: emailsOnRecord(resolvedRecord),
          hubspotVaId: resolvedRecord.properties?.vaid?.trim() ?? null,
          candidateId: candidate.id,
          candidateEmail: candidate.email,
          candidateCurrentHubstaffId: candidate.hubstaff_id,
          identifiersDisagree,
          alternateHubspotId:
            idOf(attempts.find((a) => a.source !== matchSource)?.record) ?? null,
        };

        /** Identifiers behind this pairing — logged on every update, since a
         * wrong binding puts one VA's tracked hours on another's invoice and
         * "updated N candidates" gives nothing to check that against. */
        const identity =
          `hubstaff_id=${hubstaffUserId} email=<${email ?? 'none'}> vaId=<${vaId ?? 'none'}> ` +
          `matched by ${matchSource}${matchProperty ? ` (HubSpot ${matchProperty})` : ''} ` +
          `→ hubspot_id=${String(hubspotId)} → candidate ${candidate.id} <${candidate.email}>`;

        if (traced) {
          this.trace(
            `member ${identity} (current hubstaff_id=${candidate.hubstaff_id ?? 'null'})`,
          );
        }

        if (candidate.hubstaff_id === hubstaffUserId) {
          skipCount++;
          skipReasons.already_synced++;
          record('already_linked', rowDetail);
          continue;
        }

        // hubstaff_id is uniquely indexed, so any current holder has to release
        // it first. Both writes go in one transaction: as two independent
        // updates, a failure between them left the id attached to neither row.
        const currentHolder = byHubstaffId.get(hubstaffUserId);
        const displaced =
          currentHolder && currentHolder.id !== candidate.id
            ? currentHolder
            : null;
        const holderNote = displaced
          ? `, TAKING it from candidate ${displaced.id} <${displaced.email}> ` +
            `(hubspot_id=${displaced.hubspot_id})`
          : '';

        record(displaced ? 'would_relink' : 'would_link', {
          ...rowDetail,
          displacedCandidateId: displaced?.id ?? null,
          displacedCandidateEmail: displaced?.email ?? null,
        });

        if (dryRun) {
          updateCount++;
          this.logger.log(
            `📝 [dry run] would set ${identity} ` +
              `(current hubstaff_id=${candidate.hubstaff_id ?? 'null'}${holderNote})`,
          );
          continue;
        }

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
            data: { hubstaff_id: hubstaffUserId },
          });
        });

        // Mirror the writes into the in-memory index so a later member reading
        // the same rows sees post-write state rather than the initial snapshot.
        if (currentHolder && currentHolder.id !== candidate.id) {
          currentHolder.hubstaff_id = null;
        }
        if (candidate.hubstaff_id) {
          byHubstaffId.delete(candidate.hubstaff_id);
        }
        candidate.hubstaff_id = hubstaffUserId;
        byHubstaffId.set(hubstaffUserId, candidate);

        updateCount++;
        this.logger.log(`✅ Updated ${identity}${holderNote}`);
      }

      this.logger.log(
        `🏁 Sync completed${dryRun ? ' (DRY RUN)' : ''}. ${dryRun ? 'Would update' : 'Updated'}: ${updateCount}, ` +
          `Skipped/Not found: ${skipCount} ` +
          `(no identifier: ${skipReasons.no_identifier}, no HubSpot match: ${skipReasons.no_hubspot_match}, ` +
          `no HubSpot id: ${skipReasons.no_hubspot_id}, no local candidate: ${skipReasons.no_local_candidate}, ` +
          `already synced: ${skipReasons.already_synced})`,
      );
      this.logger.log(
        `🔗 Matched by email: ${matchedBy.email}, by VA ID fallback: ${matchedBy.va_id} ` +
          `(of which ${recoveredByVaIdAfterEmail} had an email match whose HubSpot record has no staffed Candidate row)`,
      );
      // Candidates holding a hubstaff_id that no current member has. Queried
      // separately rather than filtered out of candidateRows: that set is
      // deliberately narrowed to rows the sync can act on, and its hubstaff_id
      // clause matches only *current* member ids — so a departed member's row
      // is never in it, and filtering would report zero every time.
      const staleBindings: HubstaffStaleBinding[] = options.collectRows
        ? (
            await this.prisma.candidate.findMany({
              where: {
                NOT: { hubstaff_id: null },
                hubstaff_id: { notIn: memberUserIds },
              },
              select: {
                id: true,
                email: true,
                hubspot_id: true,
                hubstaff_id: true,
              },
            })
          ).map((r) => ({
            candidateId: r.id,
            candidateEmail: r.email,
            hubspotId: r.hubspot_id,
            hubstaffId: r.hubstaff_id as string,
          }))
        : [];
      if (staleBindings.length > 0) {
        this.logger.warn(
          `⚠️ ${staleBindings.length} Candidate row(s) hold a hubstaff_id that no current Hubstaff member has`,
        );
      }

      return {
        updateCount,
        skipCount,
        skipReasons,
        matchedBy,
        recoveredByVaIdAfterEmail,
        ...(options.collectRows ? { rows, staleBindings } : {}),
      };
    } catch (error) {
      this.logger.error(
        '❌ Hubstaff members sync failed:',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
