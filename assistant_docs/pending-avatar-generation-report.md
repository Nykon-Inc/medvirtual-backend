# Data Quality — "Avatar Not Generated" Report

> Describes the `pendingAvatarGeneration` report added to the operational dashboard's Data Quality section (Administration module → Talents tab, frontend).

---

## 1. What it surfaces

Candidates that have a real **headshot** (synced from HubSpot's `headshot_screenshot` property into `Candidate.headshot_url`) but whose **AI-generated avatar** (`Candidate.avatar_url`) was never produced from it.

This is a different failure mode than "Candidates Without Headshot":

| Report | Condition | Usual root cause |
|---|---|---|
| Candidates Without Headshot | `headshot_url` is `null`, `n/a`, or `N/A` | No headshot was ever uploaded/synced from HubSpot |
| **Avatar Not Generated** (this report) | `headshot_url` contains a real URL, but `avatar_url` is `null` | The avatar-generation job ran (or should have) but never completed |

A growing "Avatar Not Generated" list is the operational signal to check **OpenAI** and **OpenRouter** account credits/quotas — see [openai.service.ts](../src/openai/openai.service.ts) `generateAvatarWithScreenshoot()`, which calls OpenAI's `gpt-image-1` first and falls back to OpenRouter's `editImage()` when OpenAI reports insufficient quota. If both providers are failing, [candidates.service.ts](../src/candidate/candidates.service.ts) sends the `openrouter-fallback-failed` alert email (see [common/utils/email-templates/openrouter-fallback-failed.ts](../src/common/utils/email-templates/openrouter-fallback-failed.ts)); this dashboard report is the queryable, always-up-to-date view of the same underlying problem.

## 2. Where it's generated

**File:** [panel/panel.service.ts](../src/panel/panel.service.ts), method `getPanelData()`.

The query mirrors the filter already used by the existing avatar-generation batch job, `processAllAvatars()` in [candidate/candidates.service.ts](../src/candidate/candidates.service.ts):

```ts
const pendingAvatarGeneration = await this.prisma.candidate.findMany({
  where: {
    pipeline_status: { in: ['261075105', '1087596819'] }, // Available pool only
    headshot_url: { contains: 'http' }, // Has a real headshot URL
    avatar_url: null, // Avatar was never generated
    ...(hasDateFilter ? { createdAt: dateFilterCreated } : {}),
  },
  select: selectCandidates,
});
```

Unlike `processAllAvatars()` (which scans the whole table to find work for the cron job), this report is scoped to the **Available pipeline** (`pipeline_status in ['261075105', '1087596819']`) and respects the dashboard's optional `dateFrom`/`dateTo` filter — same scoping already applied to `failedResumeParsing` and `withoutHeadshot`, for consistency across the three Data Quality tables.

Row shaping (rate computation, `approved_positions_pairing` label mapping, `panelCandidates` projection) follows the exact same pattern as the other two reports in the same method.

## 3. API shape

No new endpoint — this report is returned as part of the existing aggregated dashboard endpoint:

```
GET /panel?dateFrom=...&dateTo=...
```

New field on the response: `pendingAvatarGeneration: Candidate[]` (same row shape as `failedResumeParsing` / `withoutHeadshot`).

Auth: `AuthGuard` + `RolesGuard`, restricted to `system_super_admin` / `system_admin` (same as the rest of `/panel`, defined in [panel/panel.controller.ts](../src/panel/panel.controller.ts)).

## 4. Frontend

**File:** `frontend/src/app/modules/administration/_components/talents-section.tsx` — third column ("Avatar Not Generated") added to the existing `data-quality` `MvSectionCard` grid, alongside "Failed Resume Parsing" and "Candidates Without HeadShot". Columns: HubSpot ID, Candidate Name, HeadShot URL. Clicking a row opens `MvCandidateReadModal` for that candidate, same as the other two tables.

Type/normalization: `frontend/src/app/modules/administration/_lib/panel-api.ts` — `PanelData.pendingAvatarGeneration: PanelCandidate[]`, defaulted to `[]` in `normalizePanel()`.

User-facing documentation: `frontend/docs/admins-guide/02-dashboard.md` (Operational Dashboard → Tables section).

## 5. Fixing what this report surfaces

Rows here resolve on their own once `processAllAvatars()` (triggered by the daily cron — see [cron/cron.service.ts](../src/cron/cron.service.ts)) successfully regenerates the avatar, or when a candidate is manually reprocessed. There is no admin action against this table itself; it exists purely for **operational visibility** into avatar-generation health.
