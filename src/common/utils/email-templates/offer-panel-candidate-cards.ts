import {
  OFFER_PANEL_PROMO_PRICE_LABEL,
  OFFER_PANEL_PROMO_PRICE_MONTHLY,
} from '../../constant/offer-panel-promo.constant';
import { escapeEmailHtml as esc } from './escape';
import { EmailTheme } from './theme';

/**
 * Renders the selected candidates as HTML cards for the offer-panel creation
 * email, mirroring the public talent-pool card.
 *
 * ── Why this is pre-rendered into a single placeholder ──────────────────────
 * The email template engine (`EmailTemplatesService.applyPlaceholders`) is a
 * hand-rolled `/\{\{[^}]+\}\}/g` replace — it has no loop or conditional
 * construct, so "for each candidate, draw a card" cannot be expressed in the
 * editable template body. The whole grid is therefore built here and injected
 * as the value of one `{{candidateCards}}` placeholder.
 *
 * Two consequences of that injection point, both load-bearing:
 *
 *  1. The output MUST NOT contain a newline. `renderHtml` runs
 *     `filledBody.replace(/\n/g, '<br>')` on the entire body AFTER placeholder
 *     substitution, so any newline in this markup becomes a stray <br> between
 *     cards. `stripNewlines` enforces this at the boundary.
 *
 *  2. Placeholder values are injected RAW (no escaping). Candidate names,
 *     countries and positions originate from HubSpot, so every interpolated
 *     value goes through `esc()`.
 *
 * ── Why nothing here branches on a business unit ────────────────────────────
 * Colour, logo and company name arrive in the `EmailTheme` that
 * `getBusinessUnitEmailTheme` resolves from the `EmailBranding` row for the
 * panel's BU. There are already three BUs (MedVirtual, Berry Virtual, MMVA) and
 * more can be added to that table at any time, so a hardcoded brand check would
 * be wrong on the day it was written. Everything the card needs beyond those
 * fields is derived from `primaryColor`.
 */

/** Card layout is fixed-width per email conventions; keeps Outlook predictable. */
const AVATAR_PX = 72;

/** Beyond this, the email risks Gmail's ~102KB clipping threshold. */
const MAX_CARDS = 6;

/** Skills shown before collapsing into a "+N" pill (no JS to measure overflow). */
const MAX_SKILL_PILLS = 2;

export interface OfferPanelEmailCandidate {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  country?: string | null;
  avatar_url?: string | null;
  employment_type?: string | null;
  approved_positions_pairing?: string[] | null;
  skills?: { skill_name?: string | null }[] | null;
  languages?: { name?: string | null }[] | null;
  bill_rate_monthly?: number | string | null;
  bill_rate_hourly?: number | string | null;
}

// ─── Colour derivation ───────────────────────────────────────────────────────
// `EmailBranding` stores a primary colour but no light tint: `accentColor` is a
// copy of `primary_color` and `secondaryColor` is a hardcoded grey. The card's
// pill and panel backgrounds are therefore mixed from the primary toward white,
// which reproduces the hand-authored design tokens rather than approximating
// them (mixing #FD7171 at 0.88 yields exactly the #ffeeee used by Berry).

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = (hex || '').trim().replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Mixes `hex` toward white by `amount` (0–1). Falls back to a neutral tint. */
export function mixWithWhite(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#f5f5f5';
  const m = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${m(rgb.r)}, ${m(rgb.g)}, ${m(rgb.b)})`;
}

export function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** WCAG relative luminance. */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(aHex: string, bHex: string): number {
  const [light, dark] = [relativeLuminance(aHex), relativeLuminance(bHex)].sort(
    (x, y) => y - x,
  );
  return (light + 0.05) / (dark + 0.05);
}

export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#1a1a19';

/**
 * Picks the ink that actually contrasts against `hex`, by measuring both
 * candidates rather than thresholding luminance.
 *
 * Berry's #FD7171 is why: it sits just above a 0.45 luminance cutoff, so a
 * threshold test classifies it as "light" yet still hands back white — which
 * scores 2.70 against the coral, under the WCAG 3.0 floor for even large text.
 * Measuring instead yields near-black at 6.45. This also means a pale brand
 * colour added to `EmailBranding` later stays legible with no code change.
 */
export function inkOn(hex: string): string {
  return contrastRatio(INK_LIGHT, hex) >= contrastRatio(INK_DARK, hex)
    ? INK_LIGHT
    : INK_DARK;
}

/** True when `hex` needs light ink on top of it. */
export function isDarkColor(hex: string): boolean {
  return inkOn(hex) === INK_LIGHT;
}

interface CardTheme {
  primary: string;
  /** Footer fill: the configured Button Color, else the brand primary. */
  fill: string;
  onPrimary: string;
  onPrimaryMuted: string;
  onPrimaryFaint: string;
  footerEdge: string;
  logoUrl: string | null;
  companyName: string;
  pillBg: string;
  pillText: string;
  pillBorder: string;
  panelBg: string;
}

function toCardTheme(theme: EmailTheme): CardTheme {
  const primary = theme?.primaryColor || '#01546B';

  // The filled footer is the card's "button-like" surface, so it takes the
  // Button Color configured in Customize Design (EmailBranding.button_color),
  // falling back to the brand primary — the same precedence `renderHtml` uses
  // for the CTA, so the two never disagree within one email.
  const fill = theme?.buttonColor || primary;

  // Honour an explicitly configured button text colour; otherwise measure.
  // Defaulting to white (as the CTA does) would put white on Berry's coral at
  // a 2.70 contrast ratio, under the WCAG floor.
  const ink = theme?.buttonTextColor || inkOn(fill);
  const onLight = ink.toLowerCase() === INK_LIGHT;
  const panelBg = mixWithWhite(primary, 0.94);

  return {
    primary,
    fill,
    onPrimary: ink,
    // Secondary/tertiary type on the filled footer, derived from the chosen ink
    // rather than a fixed grey — a fixed grey vanishes on a dark brand and goes
    // muddy on a pale one.
    onPrimaryMuted: onLight
      ? 'rgba(255, 255, 255, 0.78)'
      : 'rgba(26, 26, 25, 0.72)',
    onPrimaryFaint: onLight
      ? 'rgba(255, 255, 255, 0.55)'
      : 'rgba(26, 26, 25, 0.5)',
    footerEdge: onLight
      ? 'rgba(255, 255, 255, 0.18)'
      : 'rgba(26, 26, 25, 0.12)',
    logoUrl: theme?.logoUrl ?? null,
    companyName: theme?.companyName || '',
    pillBg: mixWithWhite(primary, 0.88),
    pillText: primary,
    pillBorder: rgba(primary, 0.22),
    panelBg,
  };
}

// ─── Value formatting ────────────────────────────────────────────────────────

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Ana Silva" -> "Ana S.". The email goes to clients and prospects and can be
 * forwarded anywhere, so it uses the masked form the platform already applies
 * to every non-system viewer (frontend `handleNameToDisplay`).
 */
export function maskCandidateName(c: OfferPanelEmailCandidate): string {
  const first = (c.first_name ?? '').trim();
  const last = (c.last_name ?? '').trim();

  if (first || last) {
    const initial = last ? ` ${last.charAt(0).toUpperCase()}.` : '';
    return `${first}${initial}`.trim();
  }

  // Fall back to the denormalized `name` column, masking its last token too.
  const parts = (c.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Candidate';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(' ')} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function initialsOf(c: OfferPanelEmailCandidate): string {
  const masked = maskCandidateName(c);
  const parts = masked.split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase());
  return letters.join('') || '?';
}

/** Collapses whitespace/newlines so the injected value survives renderHtml. */
function stripNewlines(html: string): string {
  return html.replace(/\s*\n\s*/g, '');
}

// ─── Fragments ───────────────────────────────────────────────────────────────

function pill(
  label: string,
  bg: string,
  color: string,
  border: string,
): string {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:500;background:${bg};color:${color};border:1px solid ${border};line-height:16px;mso-line-height-rule:exactly;white-space:nowrap;">${esc(label)}</span>`;
}

/**
 * Pure-CSS initials tile. `showAvatar()` on the frontend falls back to
 * root-relative paths (`/avatar_default.png`) which resolve against the mail
 * client's own origin and break in every inbox, so the email never emits a
 * relative src — when there is no S3 avatar it draws this instead.
 */
function initialsTile(c: OfferPanelEmailCandidate, t: CardTheme): string {
  return `<div style="width:${AVATAR_PX}px;height:${AVATAR_PX}px;border-radius:${AVATAR_PX / 2}px;background:#ffffff;border:2px solid #ffffff;color:${t.primary};font-size:24px;font-weight:700;text-align:center;line-height:${AVATAR_PX}px;mso-line-height-rule:exactly;">${esc(initialsOf(c))}</div>`;
}

function avatar(c: OfferPanelEmailCandidate, t: CardTheme): string {
  const url = (c.avatar_url ?? '').trim();
  // Only absolute URLs are usable in an inbox.
  if (!/^https?:\/\//i.test(url)) return initialsTile(c, t);

  return `<img src="${esc(url)}" alt="${esc(maskCandidateName(c))}" width="${AVATAR_PX}" height="${AVATAR_PX}" style="width:${AVATAR_PX}px;height:${AVATAR_PX}px;border-radius:${AVATAR_PX / 2}px;object-fit:cover;object-position:center top;display:block;border:2px solid #ffffff;background:#fafafa;" />`;
}

function caption(text: string): string {
  return `<div style="font-size:9px;letter-spacing:.4px;text-transform:uppercase;color:#888780;font-weight:600;padding-bottom:6px;">${esc(text)}</div>`;
}

/**
 * The rate sits on the brand-filled footer, so its type takes the theme's
 * computed ink instead of fixed greys — `#5f5e5a` would disappear on a dark
 * brand and the struck original would be unreadable on a saturated one.
 */
function rateBlock(
  c: OfferPanelEmailCandidate,
  t: CardTheme,
  promoEnabled: boolean,
): string {
  const monthly =
    toNumber(c.bill_rate_monthly) ??
    (toNumber(c.bill_rate_hourly) !== null
      ? (toNumber(c.bill_rate_hourly) as number) * 176
      : null);

  if (monthly === null || monthly <= 0) return '';

  // A promo must never present as a price increase, so the original is struck
  // only when it is actually above the advertised price.
  const showPromo = promoEnabled && monthly > OFFER_PANEL_PROMO_PRICE_MONTHLY;

  const amount = showPromo
    ? `<span style="display:block;font-size:12px;line-height:15px;color:${t.onPrimaryFaint};text-decoration:line-through;font-weight:600;">${usd.format(monthly)}</span><span style="font-size:18px;font-weight:600;color:${t.onPrimary};letter-spacing:-0.3px;">${usd.format(OFFER_PANEL_PROMO_PRICE_MONTHLY)}</span>`
    : `<span style="font-size:18px;font-weight:600;color:${t.onPrimary};letter-spacing:-0.3px;">${usd.format(monthly)}</span>`;

  return `${amount}<span style="font-size:11px;font-weight:400;color:${t.onPrimaryMuted};">/mo</span>`;
}

/** Width of the brand badge in the card's header row. */
const BRAND_BADGE_PX = 64;

/**
 * Brand badge: the business unit's logo as a real <img> beside the candidate's
 * name.
 *
 * This is deliberately NOT a background watermark. Outlook.com (hotmail web)
 * rewrites message CSS and drops `background-image` on `<td>` along with
 * `linear-gradient`, so the veiled-watermark approach rendered in the preview —
 * a full browser — but vanished in the inbox. `opacity` is no safer: Outlook
 * strips it from images, which would put the logo at FULL strength behind the
 * text rather than faintly behind it.
 *
 * Fading the mark would require a pre-lightened copy of the image, but
 * `EmailBranding.logo_url` is a URL an admin pastes — there is no upload
 * pipeline to generate one. So the badge uses the logo as-is, kept small and
 * off to the side where it reads as branding instead of competing with the
 * content. Plain <img> with width/height renders in every client.
 */
function brandBadge(t: CardTheme): string {
  if (!t.logoUrl) return '';

  return `<img src="${esc(t.logoUrl)}" alt="${esc(t.companyName)}" width="${BRAND_BADGE_PX}" style="width:${BRAND_BADGE_PX}px;height:auto;max-height:26px;display:block;border:0;outline:none;text-decoration:none;" />`;
}

/**
 * Promo copy is brand-neutral on purpose.
 *
 * The public talent pool varies its feature list per brand ("HIPAA-trained" for
 * MedVirtual vs "Fully-trained" for Berry, because Berry copy must never say
 * "healthcare"). That rule cannot be extended to a business unit added to the
 * `EmailBranding` table later, so the email states only what holds for every BU.
 */
const PROMO_FEATURES = ['Pre-vetted', 'Ready in days', 'No hidden fees'];

/**
 * Headline banner shown above the cards when the panel carries the promo. It is
 * panel-level (not per candidate), which is why it lives here rather than in
 * `card()`.
 */
function promoBanner(t: CardTheme): string {
  const features = PROMO_FEATURES.map(
    (f) =>
      `<span style="font-size:12px;color:#0f172a;font-weight:600;">&#10003; ${esc(f)}</span>`,
  ).join(
    '<span style="color:#cbd5e1;">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>',
  );

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background-color:${t.panelBg};border-radius:10px;margin:0 0 14px;"><tr><td style="padding:18px 20px;text-align:center;"><div style="display:inline-block;padding:6px 16px;border-radius:999px;background-color:${t.fill};color:${t.onPrimary};font-weight:700;font-size:11px;letter-spacing:.4px;text-transform:uppercase;">Limited Time Offer</div><div style="font-size:17px;font-weight:800;color:#0f172a;line-height:1.3;padding:10px 0 8px;">Select candidates starting at just ${OFFER_PANEL_PROMO_PRICE_LABEL}/month Full-time</div><div>${features}</div><div style="font-size:10px;color:#888780;padding-top:8px;">*Terms &amp; Conditions Apply*</div></td></tr></table>`;
}

function card(
  c: OfferPanelEmailCandidate,
  t: CardTheme,
  promoEnabled: boolean,
): string {
  const positions = (c.approved_positions_pairing ?? []).filter(Boolean);
  const skills = (c.skills ?? [])
    .map((s) => (s?.skill_name ?? '').trim())
    .filter(Boolean);

  const positionPills = positions
    .map((p) => pill(p, t.pillBg, t.pillText, t.pillBorder))
    .join(' ');

  const shownSkills = skills.slice(0, MAX_SKILL_PILLS);
  const hiddenSkills = skills.length - shownSkills.length;
  const skillPills =
    shownSkills
      .map((s) => pill(s, '#eaf3de', '#27500a', 'rgba(39,80,10,.14)'))
      .join(' ') +
    (hiddenSkills > 0
      ? ` ${pill(`+${hiddenSkills}`, '#f1efe8', '#5f5e5a', 'rgba(0,0,0,.06)')}`
      : '');

  const country = (c.country ?? '').trim();
  const employment = (c.employment_type ?? '').trim();
  const rate = rateBlock(c, t, promoEnabled);

  const badge = brandBadge(t);

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background:#ffffff;border:1px solid #ebebeb;border-radius:12px;margin-bottom:14px;">
      <tr>
        <td style="padding:18px 18px 16px;border-radius:12px 12px 0 0;background-color:#ffffff;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td width="${AVATAR_PX}" valign="top" style="width:${AVATAR_PX}px;padding-right:12px;">${avatar(c, t)}</td>
              <td valign="top">
                <div style="font-size:15px;font-weight:700;color:#1a1a19;line-height:1.35;padding-bottom:3px;">${esc(maskCandidateName(c))}</div>
                ${country ? `<div style="font-size:11px;color:#5f5e5a;padding-bottom:8px;">${esc(country)}</div>` : ''}
                ${employment ? `${caption('Availability')}<div style="font-size:11px;color:#5f5e5a;">${esc(employment)}</div>` : ''}
              </td>
              ${badge ? `<td width="${BRAND_BADGE_PX}" valign="top" align="right" style="width:${BRAND_BADGE_PX}px;padding-left:10px;">${badge}</td>` : ''}
            </tr>
          </table>
          ${positionPills ? `<div style="padding-top:14px;">${caption(positions.length > 1 ? 'Positions' : 'Position')}<div>${positionPills}</div></div>` : ''}
          ${skillPills.trim() ? `<div style="padding-top:12px;">${caption('Skills')}<div>${skillPills}</div></div>` : ''}
        </td>
      </tr>
      ${
        rate
          ? `<tr>
        <td style="padding:12px 18px 14px;border-radius:0 0 12px 12px;background-color:${t.fill};border-top:1px solid ${t.footerEdge};">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td valign="bottom">
                ${employment ? `<div style="font-size:9px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:${t.onPrimaryMuted};">${esc(employment)}</div>` : ''}
                <div style="line-height:1.2;">${rate}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
          : ''
      }
    </table>`;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Builds the `{{candidateCards}}` value. Returns an empty string when there is
 * nothing to show, so a panel with no candidates simply renders the surrounding
 * copy without an empty frame.
 *
 * @param panelUrl used by the "+N more" line when the list is capped.
 */
export function renderOfferPanelCandidateCards(
  candidates: OfferPanelEmailCandidate[] | null | undefined,
  theme: EmailTheme,
  promoEnabled: boolean,
  panelUrl?: string | null,
): string {
  const list = (candidates ?? []).filter(Boolean);
  if (list.length === 0) return '';

  const t = toCardTheme(theme);
  const shown = list.slice(0, MAX_CARDS);
  const hidden = list.length - shown.length;

  const cards = shown.map((c) => card(c, t, promoEnabled)).join('');
  const banner = promoEnabled ? promoBanner(t) : '';

  const moreLine =
    hidden > 0
      ? `<div style="font-size:13px;color:#5f5e5a;padding:2px 0 8px;">${
          panelUrl
            ? `<a href="${esc(panelUrl)}" style="color:${t.primary};font-weight:600;text-decoration:none;">+${hidden} more candidate${hidden !== 1 ? 's' : ''}</a>`
            : `+${hidden} more candidate${hidden !== 1 ? 's' : ''}`
        }</div>`
      : '';

  return stripNewlines(
    `<div style="padding:4px 0 8px;">${banner}${cards}${moreLine}</div>`,
  );
}
