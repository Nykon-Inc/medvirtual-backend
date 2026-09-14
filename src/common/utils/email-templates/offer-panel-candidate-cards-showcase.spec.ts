import { OFFER_PANEL_PROMO_PRICE_MONTHLY } from '../../constant/offer-panel-promo.constant';
import {
  OfferPanelEmailCandidate,
  renderOfferPanelCandidateCards,
} from './offer-panel-candidate-cards';
import { renderOfferPanelCandidateCardsShowcase } from './offer-panel-candidate-cards-showcase';
import { EmailTheme } from './theme';

function makeTheme(overrides: Partial<EmailTheme> = {}): EmailTheme {
  return {
    primaryColor: '#01546B',
    primaryColorHover: '#013A4F',
    secondaryColor: '#F8F9FA',
    accentColor: '#00B2E2',
    companyName: 'MedVirtual',
    logoUrl: 'https://staging.medvirtual.ai/logo.png',
    layoutPreset: 'default',
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<OfferPanelEmailCandidate> = {},
): OfferPanelEmailCandidate {
  return {
    id: 'c1',
    first_name: 'Ana',
    last_name: 'Silva',
    country: 'Brazil',
    avatar_url: 'https://medvirtual-avatar.s3.us-east-1.amazonaws.com/ana.png',
    employment_type: 'Full Time',
    approved_positions_pairing: ['Medical Assistant'],
    skills: [{ skill_name: 'EMR' }],
    languages: [{ name: 'English' }],
    bill_rate_monthly: 2500,
    ...overrides,
  };
}

describe('renderOfferPanelCandidateCardsShowcase', () => {
  // The value is injected into the template body, which renderHtml then runs
  // `.replace(/\n/g, '<br>')` over — a newline here becomes a stray <br>.
  it('never emits a newline', () => {
    const html = renderOfferPanelCandidateCardsShowcase(
      [makeCandidate(), makeCandidate({ id: 'c2', first_name: 'Bruno' })],
      makeTheme(),
      true,
    );

    expect(html).not.toContain('\n');
  });

  it('returns an empty string when there are no candidates', () => {
    expect(renderOfferPanelCandidateCardsShowcase([], makeTheme(), false)).toBe(
      '',
    );
    expect(
      renderOfferPanelCandidateCardsShowcase(null, makeTheme(), false),
    ).toBe('');
    expect(
      renderOfferPanelCandidateCardsShowcase(undefined, makeTheme(), false),
    ).toBe('');
  });

  // Placeholder values are injected raw, and names come from HubSpot.
  it('escapes interpolated candidate data', () => {
    const html = renderOfferPanelCandidateCardsShowcase(
      [
        makeCandidate({
          first_name: '<script>alert(1)</script>',
          last_name: null,
          country: 'A & B "quoted"',
          approved_positions_pairing: ['<img onerror=x>'],
        }),
      ],
      makeTheme(),
      false,
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B &quot;quoted&quot;');
  });

  it('masks the candidate last name', () => {
    const html = renderOfferPanelCandidateCardsShowcase(
      [makeCandidate()],
      makeTheme(),
      false,
    );

    expect(html).toContain('Ana S.');
    expect(html).not.toContain('Silva');
  });

  describe('the brand/white seam', () => {
    // The avatar row must carry the brand fill on both the style and the
    // bgcolor attribute — Outlook's Word renderer reads the attribute, and
    // without the fill the avatar floats on white and the split collapses.
    it('paints the avatar row with the brand colour twice', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B' }),
        false,
      );

      expect(html).toContain('bgcolor="#01546B"');
      expect(html).toContain('background-color:#01546B');
    });

    // The white ring is what makes the circle's lower half read as sunk into
    // the white row beneath it.
    it('rings the avatar in white', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).toContain('border:6px solid #ffffff');
    });

    it('shows a single initial when only a first name is known', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [
          makeCandidate({
            avatar_url: null,
            first_name: 'Ana',
            last_name: null,
          }),
        ],
        makeTheme(),
        false,
      );

      expect(html).toContain('>A<');
    });

    it('rings the initials fallback in white too', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ avatar_url: null })],
        makeTheme(),
        false,
      );

      expect(html).toContain('border:6px solid #ffffff');
      expect(html).toContain('>AS<');
    });
  });

  describe('avatar', () => {
    // showAvatar() on the frontend falls back to `/avatar_default.png`, which
    // resolves against the mail client's origin and 404s in every inbox.
    it('never emits a relative image src', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ avatar_url: '/avatar_default.png' })],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('/avatar_default.png');
      expect(html).toContain('>AS<');
    });

    it('renders an absolute avatar url as an img', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).toContain(
        'src="https://medvirtual-avatar.s3.us-east-1.amazonaws.com/ana.png"',
      );
    });
  });

  describe('theme', () => {
    // White on Berry's coral scores 2.70, under the WCAG floor — the ink is
    // measured, not thresholded on luminance.
    it('uses dark ink on a pale brand colour', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '#FD7171', companyName: 'Berry Virtual' }),
        false,
      );

      expect(html).toContain('#1a1a19');
    });

    // A pale brand would make the price unreadable on the white half.
    it('falls back to near-black for the rate on a pale brand', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '#FD7171' }),
        false,
      );

      expect(html).toContain('color:#1a1a19;letter-spacing:-0.5px');
    });

    it('keeps a dark brand colour for the rate', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B' }),
        false,
      );

      expect(html).toContain('color:#01546B;letter-spacing:-0.5px');
    });

    // Same precedence renderHtml uses for the CTA, so the band and the button
    // never disagree within one email.
    it('prefers the configured button colour for the band', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B', buttonColor: '#123456' }),
        false,
      );

      expect(html).toContain('bgcolor="#123456"');
    });

    // EmailBranding rows are admin-edited, so the colour can arrive empty or
    // malformed; the card must not render `background-color:` with no value.
    it('falls back to the default brand colour when none is configured', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '' }),
        false,
      );

      expect(html).toContain('bgcolor="#01546B"');
    });

    it('survives an unparseable brand colour', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: 'not-a-colour' }),
        false,
      );

      expect(html).toContain('Ana S.');
      expect(html).toContain('#f5f5f5');
    });

    // An admin can force the ink from Customize Design; the measured value must
    // not override an explicit choice.
    it('honours an explicitly configured button text colour', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B', buttonTextColor: '#1a1a19' }),
        true,
      );

      // The banner's "Limited Time Offer" pill sits on the brand fill, so it
      // takes the configured ink rather than the measured one (which would be
      // white on this dark teal).
      expect(html).toContain('background-color:#01546B;color:#1a1a19');
    });

    // EmailBranding rows are admin-edited, so the name can be blank while the
    // logo is set. The card still renders; the alt text just goes empty.
    it('still renders the logo when the company name is blank', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ companyName: '' }),
        false,
      );

      expect(html).toContain('Ana S.');
      expect(html).toContain('src="https://staging.medvirtual.ai/logo.png"');
      expect(html).toContain('alt=""');
    });

    // The logo image is drawn IN the brand colour, so it can only live on the
    // white footer — on the coloured band it would be coral-on-coral.
    it('puts the logo image on the white footer', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ logoUrl: 'https://staging.medvirtual.ai/logo.png' }),
        false,
      );

      expect(html).toContain('src="https://staging.medvirtual.ai/logo.png"');
      // The footer sits on white with a hairline above it, never on the band.
      expect(html).toContain('border-top:1px solid #f0efec');
    });

    // The band is an empty colour spacer: the company name used to print there
    // as a wordmark, and removing it reclaimed that row's height.
    it('prints no company name on the band', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ companyName: 'MedVirtual' }),
        false,
      );

      // Only the logo's alt text may carry the name — never as visible copy.
      expect(html).not.toContain('>MedVirtual<');
      expect(html).toContain('alt="MedVirtual"');
    });

    // Outlook.com drops background-image on <td> and Outlook strips opacity
    // from images, so the logo must be a plain <img> on a plain white cell.
    it('renders the logo without background-image or opacity', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('background-image');
      expect(html).not.toContain('opacity');
    });

    // The footer is two independent cells: the price keeps its strip when the
    // BU has no logo configured, so the card does not lose its price with it.
    it('keeps the price column when there is no logo', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme({ logoUrl: undefined }),
        false,
      );

      expect(html).toContain('border-top:1px solid #f0efec');
      expect(html).toContain('$2,500');
      expect(html).not.toContain('<img src="https://staging');
    });

    // Nothing to price and nothing to attribute — drawing the strip would leave
    // a bare rule across the bottom of the card.
    it('drops the whole footer with neither a rate nor a logo', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ bill_rate_monthly: null, bill_rate_hourly: null })],
        makeTheme({ logoUrl: undefined }),
        false,
      );

      expect(html).not.toContain('border-top:1px solid #f0efec');
      expect(html).toContain('Ana S.');
    });
  });

  describe('rate', () => {
    it('derives a monthly rate from the hourly one', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ bill_rate_monthly: null, bill_rate_hourly: 10 })],
        makeTheme(),
        false,
      );

      expect(html).toContain('$1,760');
    });

    it('omits the rate block when there is no usable rate', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ bill_rate_monthly: 0, bill_rate_hourly: null })],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('/month');
    });

    it('strikes the original price when the promo is cheaper', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ bill_rate_monthly: 2500 })],
        makeTheme(),
        true,
      );

      expect(html).toContain('text-decoration:line-through');
      expect(html).toContain('$2,500');
    });

    // A promo must never present as a price increase.
    it('does not strike a price already below the promo', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [
          makeCandidate({
            bill_rate_monthly: OFFER_PANEL_PROMO_PRICE_MONTHLY - 100,
          }),
        ],
        makeTheme(),
        true,
      );

      expect(html).not.toContain('text-decoration:line-through');
    });
  });

  describe('content', () => {
    it('shows the promo banner only when the promo is enabled', () => {
      const on = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        true,
      );
      const off = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(on).toContain('Limited Time Offer');
      expect(off).not.toContain('Limited Time Offer');
    });

    // The promo block is approved commercial copy, so the A/B covers the cards
    // only — the banner must stay byte-identical to the institutional one, or
    // whichever variant wins would need the copy re-approved.
    it('renders a promo banner identical to the institutional card', () => {
      const theme = makeTheme();
      const showcase = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        theme,
        true,
      );
      const institutional = renderOfferPanelCandidateCards(
        [makeCandidate()],
        theme,
        true,
      );

      const banner = (html: string) =>
        html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8);

      expect(banner(showcase)).toBe(banner(institutional));
    });

    it('collapses extra positions into the primary pill', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [
          makeCandidate({
            approved_positions_pairing: [
              'Medical Assistant',
              'Scribe',
              'Biller',
            ],
          }),
        ],
        makeTheme(),
        false,
      );

      expect(html).toContain('Medical Assistant +2');
    });

    it('collapses skills beyond the pill limit', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [
          makeCandidate({
            skills: [
              { skill_name: 'EMR' },
              { skill_name: 'Scheduling' },
              { skill_name: 'Billing' },
              { skill_name: 'Intake' },
              { skill_name: 'Triage' },
            ],
          }),
        ],
        makeTheme(),
        false,
      );

      expect(html).toContain('EMR');
      expect(html).toContain('+2 more');
      expect(html).not.toContain('Triage');
    });

    // Every optional field arrives null for candidates HubSpot has barely
    // filled in; the card must still render rather than emit "null" or throw.
    it('renders a candidate with every optional field missing', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [
          {
            id: 'bare',
            first_name: null,
            last_name: null,
            name: null,
            country: null,
            avatar_url: null,
            employment_type: null,
            approved_positions_pairing: null,
            skills: null,
            languages: null,
            bill_rate_monthly: null,
            bill_rate_hourly: null,
          },
        ],
        makeTheme({ logoUrl: undefined, companyName: '' }),
        false,
      );

      expect(html).toContain('Candidate');
      expect(html).not.toContain('null');
      expect(html).not.toContain('undefined');
      expect(html).not.toContain('/month');
    });

    it('skips entries whose skill and language names are blank', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [
          makeCandidate({
            skills: [{ skill_name: null }, { skill_name: '  ' }],
            languages: [{ name: null }],
            country: '   ',
          }),
        ],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('null');
      expect(html).toContain('Ana S.');
    });

    // Availability is the caption above the price in the footer. It used to
    // also render above the skills; printing it in both places put "Full Time"
    // on the card twice.
    it('shows the availability exactly once', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ employment_type: 'Full Time' })],
        makeTheme(),
        false,
      );

      expect(html.split('Full Time')).toHaveLength(2);
    });

    // Float and inline-block side-by-side layouts collapse in Outlook, so the
    // footer's two halves must be cells of one row.
    it('lays the footer out as price-left, logo-right in one table row', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        true,
      );

      const footer = html.slice(html.indexOf('border-top:1px solid #f0efec'));
      const priceAt = footer.indexOf('$1,760');
      const logoAt = footer.indexOf('staging.medvirtual.ai/logo.png');

      expect(priceAt).toBeGreaterThan(-1);
      expect(logoAt).toBeGreaterThan(priceAt);
      expect(footer).toContain('align="right"');
      expect(footer).not.toContain('float:');
    });

    // The institutional card's footer stack is availability, then the struck
    // original, then the promo price. The showcase keeps that order so the A/B
    // is not also testing a different price layout.
    it('stacks availability, struck price and promo price in that order', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate({ employment_type: 'Part Time' })],
        makeTheme(),
        true,
      );

      const footer = html.slice(html.indexOf('border-top:1px solid #f0efec'));

      expect(footer.indexOf('Part Time')).toBeLessThan(
        footer.indexOf('$2,500'),
      );
      expect(footer.indexOf('$2,500')).toBeLessThan(footer.indexOf('$1,760'));
    });

    it('shows the availability and country', () => {
      const html = renderOfferPanelCandidateCardsShowcase(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).toContain('Full Time');
      expect(html).toContain('Brazil');
    });

    // Beyond MAX_CARDS the email risks Gmail's ~102KB clipping threshold.
    it('caps the card list and links the remainder to the panel', () => {
      const many = Array.from({ length: 9 }, (_, i) =>
        makeCandidate({ id: `c${i}`, first_name: `Cand${i}` }),
      );
      const html = renderOfferPanelCandidateCardsShowcase(
        many,
        makeTheme(),
        false,
        'https://app.medvirtual.ai/panel/abc',
      );

      expect(html).toContain('+3 more candidates');
      expect(html).toContain('href="https://app.medvirtual.ai/panel/abc"');
      expect(html).not.toContain('Cand8');
    });

    it('renders the remainder as plain text without a panel url', () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        makeCandidate({ id: `c${i}` }),
      );
      const html = renderOfferPanelCandidateCardsShowcase(
        many,
        makeTheme(),
        false,
      );

      expect(html).toContain('+2 more candidates');
      expect(html).not.toContain('<a href');
    });

    it('uses the singular form for a single hidden candidate', () => {
      const many = Array.from({ length: 7 }, (_, i) =>
        makeCandidate({ id: `c${i}` }),
      );
      const html = renderOfferPanelCandidateCardsShowcase(
        many,
        makeTheme(),
        false,
      );

      expect(html).toContain('+1 more candidate ');
    });
  });
});
