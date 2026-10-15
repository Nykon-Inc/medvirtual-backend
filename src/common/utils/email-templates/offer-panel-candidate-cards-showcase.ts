import {
  OFFER_PANEL_PROMO_PRICE_LABEL,
  OFFER_PANEL_PROMO_PRICE_MONTHLY,
} from '../../constant/offer-panel-promo.constant';
import { escapeEmailHtml as esc } from './escape';
import {
  contrastRatio,
  inkOn,
  maskCandidateName,
  mixWithWhite,
  OfferPanelEmailCandidate,
  rgba,
} from './offer-panel-candidate-cards';
import { EmailTheme } from './theme';

/**
 * "Showcase" variant of the offer-panel candidate cards — a warmer, more
 * commercial alternative to the institutional card in
 * `offer-panel-candidate-cards.ts`.
 *
 * Both renderers are live and interchangeable: they take the same arguments and
 * return the same kind of string, so the choice between them is a one-line swap
 * at the call site. The original is untouched.
 *
 * ── The design ──────────────────────────────────────────────────────────────
 * Where the institutional card is a left-aligned dossier (avatar in a gutter,
 * data in rows), this one is a portrait: a brand-coloured band fills the top
 * half of the card, white fills the bottom, and the candidate's avatar sits
 * centred on the seam between them. Name, origin, position and skills stack
 * centred underneath. The eye lands on the person first and the data second,
 * which is the point.
 *
 * The card closes on a two-column footer — availability and price on the left,
 * business-unit logo on the right — which is the one part that keeps the
 * institutional card's left-aligned reading order, because that is the block
 * the sales team scans.
 *
 * ── Why the seam is built the way it is ─────────────────────────────────────
 * The avatar must appear to straddle the colour boundary. On the web that is a
 * negative margin; in email it is not — Outlook's Word renderer ignores
 * negative margins, and several clients drop `position` entirely. So the seam is
 * assembled out of table rows, which every client agrees on:
 *
 *   row 1  brand fill, empty spacer ─────────┐  the "top half"
 *   row 2  brand fill, holds the avatar      │  avatar's upper half sits here
 *   row 3  white, tall       ────────────────┘  avatar's lower half is faked by
 *                                               the ring + the white row's edge
 *
 * The avatar carries a thick white ring, so where the circle meets row 3 the
 * ring and the white row are the same colour and the boundary disappears: the
 * portrait reads as sunk into the white, exactly like the overlap would look.
 * No negative offsets, no `position`, no background images.
 *
 * ── Constraints inherited from the injection point ──────────────────────────
 * This value lands in the `{{candidateCards}}` placeholder, same as the
 * original, so the same two rules bind (see that file's header for the full
 * reasoning):
 *
 *  1. No newlines in the output — `renderHtml` turns every `\n` in the body into
 *     a `<br>` after substitution. `stripNewlines` enforces it.
 *  2. Placeholders are injected raw, and candidate data comes from HubSpot, so
 *     every interpolated value goes through `esc()`.
 *
 * Colour, logo and company name arrive in the `EmailTheme`; nothing here
 * branches on a business unit. The shared colour maths (`mixWithWhite`, `rgba`,
 * `inkOn`) and `maskCandidateName` are imported from the original renderer
 * rather than duplicated, so a fix to either lands in both cards.
 *
 * The brand appears once, in the white footer's right-hand cell (`cardFooter`),
 * and never on the coloured band. That logo is the candidate's own BU
 * (`brand_logo_url`), falling back to the theme's — everything else on the card
 * follows the panel's theme. `EmailBranding.logo_url` points at a logo
 * drawn IN the brand colour — Berry's is coral, MedVirtual's is teal — so on
 * the band it would be coral-on-coral. There is no upload pipeline to produce a
 * knocked-out white copy (the field is a URL an admin pastes), and the usual
 * rescues are unreliable in an inbox: Outlook.com drops `background-image` on
 * `<td>`, and Outlook strips `opacity` from images. White is the surface these
 * assets are drawn for, so that is where the logo goes.
 */

/**
 * The portrait is the hero of this card, so it runs well past the institutional
 * card's 72px. At 128 the face is still legible in a phone's preview pane, and
 * the circle stays inside the ~600px email body with room for the band either
 * side of it.
 */
const AVATAR_PX = 128;

/**
 * Thickness of the white ring that dissolves the avatar into the white half.
 * Scaled up with the portrait — a 5px ring around a 128px circle reads as a
 * hairline and stops selling the overlap.
 */
const RING_PX = 6;

/**
 * Colour showing above the portrait. This is the entire top band now that the
 * wordmark is gone — it holds no content, so it is sized purely as the margin
 * of brand colour around the circle rather than around any text.
 */
const BAND_TOP_PX = 18;

/**
 * Optical gap between the bottom of the portrait and the candidate's name.
 *
 * Read the padding expression at the call site before touching this: the white
 * cell must first clear the part of the avatar hanging into it, which is
 * `AVATAR_PX / 2 - RING_PX` — half the circle, minus the ring, because the ring
 * is white and visually merges with the cell instead of occupying it. This
 * constant is only the space *after* that, so small values here are real.
 */
const BAND_BOTTOM_PX = 2;

/** Beyond this, the email risks Gmail's ~102KB clipping threshold. */
const MAX_CARDS = 6;

/** Skills shown before collapsing into a "+N" pill (no JS to measure overflow). */
const MAX_SKILL_PILLS = 3;

interface ShowcaseTheme {
  primary: string;
  /** Band fill: the configured Button Color, else the brand primary. */
  band: string;
  /** Ink for the promo banner's pill, which sits on the band fill. */
  onBand: string;
  logoUrl: string | null;
  companyName: string;
  pillBg: string;
  pillText: string;
  pillBorder: string;
  panelBg: string;
  /** Rate figure on white — the brand colour, unless it is too pale to read. */
  rateInk: string;
}

function toShowcaseTheme(theme: EmailTheme): ShowcaseTheme {
  const primary = theme?.primaryColor || '#01546B';

  // Same precedence the CTA uses in `renderHtml`, so the card's brand band and
  // the email's button never disagree within one message.
  const band = theme?.buttonColor || primary;

  // Honour an explicitly configured button text colour; otherwise measure.
  // Berry's #FD7171 is why this is measured and not thresholded — white scores
  // 2.70 on that coral, under the WCAG floor even for large text.
  const ink = theme?.buttonTextColor || inkOn(band);

  // A pale brand colour would make the rate unreadable on the white half, so it
  // falls back to near-black when it cannot carry body text on white.
  const rateInk =
    contrastRatio(primary, '#ffffff') >= 4.5 ? primary : '#1a1a19';

  return {
    primary,
    band,
    onBand: ink,
    logoUrl: theme?.logoUrl ?? null,
    companyName: theme?.companyName || '',
    pillBg: mixWithWhite(primary, 0.9),
    pillText: rateInk,
    pillBorder: rgba(primary, 0.2),
    panelBg: mixWithWhite(primary, 0.94),
    rateInk,
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

function initialsOf(c: OfferPanelEmailCandidate): string {
  const parts = maskCandidateName(c).split(/\s+/).filter(Boolean);
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
  return `<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:600;background:${bg};color:${color};border:1px solid ${border};line-height:16px;mso-line-height-rule:exactly;white-space:nowrap;">${esc(label)}</span>`;
}

/**
 * Pure-CSS initials tile, used when there is no usable avatar. The frontend's
 * fallback is a root-relative path (`/avatar_default.png`) which resolves
 * against the mail client's own origin and 404s in every inbox, so the email
 * never emits a relative src.
 *
 * It carries the same white ring as the photo so it dissolves into the white
 * half identically — the seam illusion must not depend on the candidate having
 * uploaded a picture.
 */
function initialsTile(c: OfferPanelEmailCandidate, t: ShowcaseTheme): string {
  const inner = AVATAR_PX - RING_PX * 2;
  // Tracks the circle so the initials keep the same optical weight as a photo.
  const fontPx = Math.round(inner * 0.38);
  return `<div style="width:${inner}px;height:${inner}px;border-radius:${AVATAR_PX}px;background:#ffffff;border:${RING_PX}px solid #ffffff;color:${t.primary};font-size:${fontPx}px;font-weight:700;text-align:center;line-height:${inner}px;mso-line-height-rule:exactly;font-family:Arial,Helvetica,sans-serif;">${esc(initialsOf(c))}</div>`;
}

/**
 * The hero portrait. The white ring is load-bearing, not decoration: it is what
 * makes the circle's lower half read as sitting on the white row beneath it.
 */
function avatar(c: OfferPanelEmailCandidate, t: ShowcaseTheme): string {
  const url = (c.avatar_url ?? '').trim();
  // Only absolute URLs are usable in an inbox.
  if (!/^https?:\/\//i.test(url)) return initialsTile(c, t);

  const inner = AVATAR_PX - RING_PX * 2;
  return `<img src="${esc(url)}" alt="${esc(maskCandidateName(c))}" width="${inner}" height="${inner}" style="width:${inner}px;height:${inner}px;border-radius:${AVATAR_PX}px;object-fit:cover;object-position:center top;display:block;border:${RING_PX}px solid #ffffff;background:#f4f4f2;" />`;
}

/** Rendered width of the logo in the card footer. */
const BRAND_LOGO_PX = 88;

/**
 * The card footer: availability and price on the left, business-unit logo on
 * the right, both on white.
 *
 * The left column reproduces the institutional card's footer stack — the
 * uppercase availability caption, then the struck original above the promo
 * price — because that ordering is what the sales team reads, and the A/B
 * should not also be testing a different price layout. What changes is the
 * surface: the institutional card sets that stack on the brand fill, this one
 * keeps it on white so the whole bottom half of the card stays light.
 *
 * The right column is the one place the logo IMAGE can live. Every
 * `EmailBranding.logo_url` asset is a brand-coloured mark drawn for a white
 * page, so it disappears on the coloured band above; here it needs no
 * knocked-out variant, no `background-image` (Outlook.com drops it on `<td>`)
 * and no `opacity` (Outlook strips it from images) — just a plain `<img>` with
 * an explicit width on a plain white cell, which renders everywhere including
 * the Word-based clients.
 *
 * Both columns are cells of one table rather than floated blocks: float and
 * `display:inline-block` side-by-side layouts collapse in Outlook, while a
 * two-cell row is the one horizontal arrangement every client honours. The
 * logo cell carries a fixed width so the price never gets squeezed.
 */
function cardFooter(
  c: OfferPanelEmailCandidate,
  t: ShowcaseTheme,
  promoEnabled: boolean,
  employment: string,
): string {
  const hourly = toNumber(c.bill_rate_hourly);
  const monthly =
    toNumber(c.bill_rate_monthly) ?? (hourly !== null ? hourly * 176 : null);
  const hasRate = monthly !== null && monthly > 0;

  // The logo names the candidate's own BU, not the panel's — a mixed panel
  // must not stamp every card with the panel's brand.
  const logoUrl = c.brand_logo_url || t.logoUrl;
  const logoAlt = c.brand_name || t.companyName;

  // Nothing to attribute and nothing to price — skip the strip entirely rather
  // than drawing an empty rule across the card.
  if (!hasRate && !logoUrl) return '';

  // A promo must never present as a price increase, so the original is struck
  // only when it is actually above the advertised price.
  const showPromo =
    hasRate && promoEnabled && monthly > OFFER_PANEL_PROMO_PRICE_MONTHLY;
  const shown = showPromo ? OFFER_PANEL_PROMO_PRICE_MONTHLY : monthly;

  const caption = employment
    ? `<div style="font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#8a8983;padding-bottom:3px;">${esc(employment)}</div>`
    : '';

  const struck = showPromo
    ? `<div style="font-size:12px;line-height:15px;color:#96958f;text-decoration:line-through;font-weight:600;">${usd.format(monthly)}</div>`
    : '';

  const price = hasRate
    ? `${caption}${struck}<div style="line-height:1.15;"><span style="font-size:24px;font-weight:800;color:${t.rateInk};letter-spacing:-0.5px;">${usd.format(shown as number)}</span><span style="font-size:12px;font-weight:600;color:#7a7973;">&nbsp;/month</span></div>`
    : '';

  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(logoAlt)}" width="${BRAND_LOGO_PX}" style="width:${BRAND_LOGO_PX}px;height:auto;max-height:28px;display:block;border:0;outline:none;text-decoration:none;" />`
    : '';

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;margin-top:16px;"><tr><td align="left" valign="bottom" style="padding:14px 0 0;border-top:1px solid #f0efec;text-align:left;">${price}</td>${
    logo
      ? `<td align="right" valign="bottom" width="${BRAND_LOGO_PX}" style="width:${BRAND_LOGO_PX}px;padding:14px 0 0 12px;border-top:1px solid #f0efec;">${logo}</td>`
      : ''
  }</tr></table>`;
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
 *
 * Deliberately byte-identical to the institutional card's banner: the promo is
 * an approved commercial message with signed-off copy, so the A/B is about the
 * candidate cards only. Keeping the banner constant also means whichever variant
 * wins, the promo block does not need re-approval.
 */
function promoBanner(t: ShowcaseTheme): string {
  const features = PROMO_FEATURES.map(
    (f) =>
      `<span style="font-size:12px;color:#0f172a;font-weight:600;">&#10003; ${esc(f)}</span>`,
  ).join(
    '<span style="color:#cbd5e1;">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>',
  );

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background-color:${t.panelBg};border-radius:10px;margin:0 0 14px;"><tr><td style="padding:18px 20px;text-align:center;"><div style="display:inline-block;padding:6px 16px;border-radius:999px;background-color:${t.band};color:${t.onBand};font-weight:700;font-size:11px;letter-spacing:.4px;text-transform:uppercase;">Limited Time Offer</div><div style="font-size:17px;font-weight:800;color:#0f172a;line-height:1.3;padding:10px 0 8px;">Select candidates starting at just ${OFFER_PANEL_PROMO_PRICE_LABEL}/month Full-time</div><div>${features}</div><div style="font-size:10px;color:#888780;padding-top:8px;">*Terms &amp; Conditions Apply*</div></td></tr></table>`;
}

/**
 * One portrait card.
 *
 * The three-row seam (band / avatar-on-band / white) is the whole trick — see
 * the file header. `mso-line-height-rule:exactly` and explicit heights keep
 * Word's renderer from inflating the band rows and shifting the avatar off the
 * boundary.
 */
function card(
  c: OfferPanelEmailCandidate,
  t: ShowcaseTheme,
  promoEnabled: boolean,
): string {
  const positions = (c.approved_positions_pairing ?? []).filter(Boolean);
  const skills = (c.skills ?? [])
    .map((s) => (s?.skill_name ?? '').trim())
    .filter(Boolean);
  const languages = (c.languages ?? [])
    .map((l) => (l?.name ?? '').trim())
    .filter(Boolean);

  const country = (c.country ?? '').trim();
  const employment = (c.employment_type ?? '').trim();
  const primaryPosition = positions[0] ?? '';
  const extraPositions = positions.length - 1;

  const shownSkills = skills.slice(0, MAX_SKILL_PILLS);
  const hiddenSkills = skills.length - shownSkills.length;
  const skillPills =
    shownSkills
      .map((s) => pill(s, t.pillBg, t.pillText, t.pillBorder))
      .join(' ') +
    (hiddenSkills > 0
      ? ` ${pill(`+${hiddenSkills} more`, '#f4f3ee', '#5f5e5a', 'rgba(0,0,0,.07)')}`
      : '');

  // Country and languages are secondary facts; one muted line keeps the card
  // from turning back into a data sheet.
  const metaBits = [country, languages.slice(0, 2).join(', ')].filter(Boolean);
  const meta = metaBits.length
    ? `<div style="font-size:12px;color:#7a7973;padding-top:5px;">${esc(metaBits.join('  ·  '))}</div>`
    : '';

  const positionLine = primaryPosition
    ? `<div style="padding-top:10px;">${pill(
        extraPositions > 0
          ? `${primaryPosition} +${extraPositions}`
          : primaryPosition,
        t.pillBg,
        t.pillText,
        t.pillBorder,
      )}</div>`
    : '';

  // Availability is NOT drawn here — it is the caption above the price in
  // `cardFooter`, matching the institutional card's footer stack. Rendering it
  // in both places would print "Full Time" twice on every card.

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background:#ffffff;border:1px solid #ececea;border-radius:16px;margin-bottom:18px;">
      <tr>
        <td height="${BAND_TOP_PX}" style="height:${BAND_TOP_PX}px;line-height:0;font-size:0;padding:0;border-radius:16px 16px 0 0;background-color:${t.band};" bgcolor="${t.band}">&nbsp;</td>
      </tr>
      <tr>
        <td align="center" height="${AVATAR_PX / 2}" style="height:${AVATAR_PX / 2}px;line-height:0;font-size:0;padding:0;background-color:${t.band};" bgcolor="${t.band}">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;">
            <tr>
              <td style="padding:0;line-height:0;font-size:0;">${avatar(c, t)}</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:${AVATAR_PX / 2 - RING_PX + BAND_BOTTOM_PX}px 20px 20px;background-color:#ffffff;border-radius:0 0 16px 16px;">
          <div style="font-size:20px;font-weight:800;color:#1a1a19;line-height:1.25;letter-spacing:-0.3px;">${esc(maskCandidateName(c))}</div>
          ${meta}
          ${positionLine}
          ${skillPills.trim() ? `<div style="padding-top:12px;">${skillPills}</div>` : ''}
          ${cardFooter(c, t, promoEnabled, employment)}
        </td>
      </tr>
    </table>`;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Builds the `{{candidateCards}}` value in the showcase style. Drop-in
 * replacement for `renderOfferPanelCandidateCards` — same signature, same
 * contract. Returns an empty string when there is nothing to show, so a panel
 * with no candidates renders the surrounding copy without an empty frame.
 *
 * @param panelUrl used by the "+N more" line when the list is capped.
 */
export function renderOfferPanelCandidateCardsShowcase(
  candidates: OfferPanelEmailCandidate[] | null | undefined,
  theme: EmailTheme,
  promoEnabled: boolean,
  panelUrl?: string | null,
): string {
  const list = (candidates ?? []).filter(Boolean);
  if (list.length === 0) return '';

  const t = toShowcaseTheme(theme);
  const shown = list.slice(0, MAX_CARDS);
  const hidden = list.length - shown.length;

  const cards = shown.map((c) => card(c, t, promoEnabled)).join('');
  const banner = promoEnabled ? promoBanner(t) : '';

  const moreLine =
    hidden > 0
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background-color:${t.panelBg};border-radius:12px;"><tr><td align="center" style="padding:14px 18px;font-size:13px;font-weight:600;color:${t.rateInk};">${
          panelUrl
            ? `<a href="${esc(panelUrl)}" style="color:${t.rateInk};font-weight:700;text-decoration:none;">+${hidden} more candidate${hidden !== 1 ? 's' : ''} waiting for you &rarr;</a>`
            : `+${hidden} more candidate${hidden !== 1 ? 's' : ''} waiting for you`
        }</td></tr></table>`
      : '';

  return stripNewlines(
    `<div style="padding:4px 0 8px;">${banner}${cards}${moreLine}</div>`,
  );
}
