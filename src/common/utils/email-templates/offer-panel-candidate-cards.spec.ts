import {
  contrastRatio,
  inkOn,
  isDarkColor,
  maskCandidateName,
  mixWithWhite,
  OfferPanelEmailCandidate,
  renderOfferPanelCandidateCards,
} from './offer-panel-candidate-cards';
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

describe('renderOfferPanelCandidateCards', () => {
  // The value is injected into the template body, which renderHtml then runs
  // `.replace(/\n/g, '<br>')` over — a newline here becomes a stray <br>.
  it('never emits a newline', () => {
    const html = renderOfferPanelCandidateCards(
      [makeCandidate(), makeCandidate({ id: 'c2', first_name: 'Bruno' })],
      makeTheme(),
      true,
    );

    expect(html).not.toContain('\n');
  });

  it('returns an empty string when there are no candidates', () => {
    expect(renderOfferPanelCandidateCards([], makeTheme(), false)).toBe('');
    expect(renderOfferPanelCandidateCards(null, makeTheme(), false)).toBe('');
    expect(renderOfferPanelCandidateCards(undefined, makeTheme(), false)).toBe(
      '',
    );
  });

  // Placeholder values are injected raw, and names come from HubSpot.
  it('escapes interpolated candidate data', () => {
    const html = renderOfferPanelCandidateCards(
      [
        makeCandidate({
          first_name: '<script>alert(1)</script>',
          last_name: null,
          country: 'A & B "quoted"',
        }),
      ],
      makeTheme(),
      false,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B &quot;quoted&quot;');
  });

  describe('promo pricing', () => {
    it('strikes the original and shows the promo price above the threshold', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ bill_rate_monthly: 2500 })],
        makeTheme(),
        true,
      );

      expect(html).toContain('line-through');
      expect(html).toContain('$2,500');
      expect(html).toContain('$1,760');
    });

    // A promo must never present as a price increase.
    it('leaves a rate at or below the promo price unstruck', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ bill_rate_monthly: 1500 })],
        makeTheme(),
        true,
      );

      expect(html).not.toContain('line-through');
      expect(html).toContain('$1,500');
      // The promo price may still appear in the banner headline, so assert on
      // the card's own rate markup rather than the whole document.
      expect(html).not.toContain('letter-spacing:-0.3px;">$1,760');
    });

    // Regression: the banner was designed but never implemented, so a promo
    // panel shipped with only the struck price and no headline offer.
    it('renders the promo banner above the cards', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme(),
        true,
      );

      expect(html).toContain('Limited Time Offer');
      expect(html).toContain('Select candidates starting at just $1,760/month');
      expect(html).toContain('Terms &amp; Conditions Apply');
      // Above the first card, not after it.
      expect(html.indexOf('Limited Time Offer')).toBeLessThan(
        html.indexOf('Ana S.'),
      );
    });

    it('omits the banner entirely when the panel has no promo', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('Limited Time Offer');
      expect(html).not.toContain('Terms &amp; Conditions');
    });

    // Berry copy must never say "healthcare", and that rule cannot be extended
    // to a BU added later — so the banner says nothing brand-specific.
    it('keeps the banner copy brand-neutral', () => {
      const html = renderOfferPanelCandidateCards(
        // No position/skill data, so candidate fields can't be mistaken for
        // banner copy (a candidate may legitimately be a "Medical Assistant").
        [makeCandidate({ approved_positions_pairing: [], skills: [] })],
        makeTheme({ primaryColor: '#FD7171', companyName: 'Berry Virtual' }),
        true,
      );

      expect(html).not.toMatch(/healthcare|HIPAA/i);
      expect(html).toContain('Pre-vetted');
      expect(html).toContain('Limited Time Offer');
    });

    it('shows the plain rate when the panel has no promo', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ bill_rate_monthly: 2500 })],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('line-through');
      expect(html).toContain('$2,500');
    });

    it('derives a monthly rate from the hourly one when missing', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ bill_rate_monthly: null, bill_rate_hourly: 20 })],
        makeTheme(),
        false,
      );

      expect(html).toContain('$3,520'); // 20 * 176
    });

    it('omits the rate block entirely when no rate is known', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ bill_rate_monthly: null, bill_rate_hourly: null })],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('/mo');
    });
  });

  describe('avatars', () => {
    it('renders the S3 image when the URL is absolute', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).toContain('<img src="https://medvirtual-avatar.s3');
    });

    // showAvatar()'s fallback is root-relative and resolves against the mail
    // client's origin, so a relative src must never reach an inbox.
    it('falls back to an initials tile instead of a relative path', () => {
      const relative = renderOfferPanelCandidateCards(
        [makeCandidate({ avatar_url: '/avatar_default.png' })],
        makeTheme(),
        false,
      );
      const missing = renderOfferPanelCandidateCards(
        [makeCandidate({ avatar_url: null })],
        makeTheme(),
        false,
      );

      for (const html of [relative, missing]) {
        // The brand badge is also an <img>, so assert on the avatar specifically.
        expect(html).not.toContain('avatar_default.png');
        expect(html).not.toContain(`alt="${'Ana S.'}"`);
        expect(html).toContain('AS'); // Ana Silva
      }
    });
  });

  describe('name masking', () => {
    it('masks the surname the way the platform does for non-system viewers', () => {
      expect(maskCandidateName({ first_name: 'Ana', last_name: 'Silva' })).toBe(
        'Ana S.',
      );
    });

    it('masks the denormalized name column too', () => {
      expect(maskCandidateName({ name: 'Carlos Eduardo Mendes' })).toBe(
        'Carlos Eduardo M.',
      );
    });

    it('never emits a full surname in the rendered card', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ first_name: 'Ana', last_name: 'Silva' })],
        makeTheme(),
        false,
      );

      expect(html).toContain('Ana S.');
      expect(html).not.toContain('Silva');
    });

    it('degrades to a placeholder when there is no name at all', () => {
      expect(maskCandidateName({})).toBe('Candidate');
    });
  });

  describe('business-unit neutrality', () => {
    // This is the test that fails if anyone reintroduces a hardcoded brand.
    it('carries an arbitrary brand that matches no known business unit', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({
          primaryColor: '#123456',
          companyName: 'Some Future BU',
          logoUrl: 'https://cdn.example.com/future-bu.png',
        }),
        false,
      );

      expect(html).toContain('#123456');
      expect(html).toContain('https://cdn.example.com/future-bu.png');
      // and none of the incumbent brand colours leaked in
      expect(html).not.toContain('#FD7171');
      expect(html).not.toContain('#01546B');
    });

    it('renders the brand logo as a badge, and omits it when absent', () => {
      const withLogo = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme(),
        false,
      );
      const withoutLogo = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ logoUrl: undefined }),
        false,
      );

      expect(withLogo).toContain(
        '<img src="https://staging.medvirtual.ai/logo.png"',
      );
      expect(withoutLogo).not.toContain('logo.png');
    });

    /**
     * Regression: the badge used to be a CSS background watermark. Outlook.com
     * rewrites message CSS and drops `background-image` on <td>, so it rendered
     * in the browser preview but was missing from the actual inbox. It must be
     * a real <img>. `opacity` is equally unsafe — Outlook strips it, which
     * would show the logo at full strength rather than faintly.
     */
    it('uses a real img, not CSS backgrounds or opacity', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme(),
        false,
      );

      expect(html).not.toContain('background-image');
      expect(html).not.toContain('linear-gradient');
      expect(html).not.toContain('opacity');
    });

    it('labels the badge with the company name for screen readers', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ companyName: 'Berry Virtual' }),
        false,
      );

      expect(html).toContain('alt="Berry Virtual"');
    });

    // The identity block is plain white: the earlier tint read as a washed-out
    // grey panel and also swallowed the watermark.
    it('leaves the identity block unfilled', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B' }),
        false,
      );

      expect(html).toContain(
        'border-radius:12px 12px 0 0;background-color:#ffffff',
      );
    });

    // Pins the derivation to the hand-authored design token rather than an
    // approximation: Berry's #ffeeee in tokens.css.
    it('derives the pill tint to match the existing design tokens', () => {
      expect(mixWithWhite('#FD7171', 0.88)).toBe('rgb(255, 238, 238)');
    });

    it('flips button text colour on a light brand colour', () => {
      expect(isDarkColor('#01546B')).toBe(true);
      expect(isDarkColor('#FFE600')).toBe(false);
    });
  });

  describe('filled footer', () => {
    it('falls back to the brand primary when no Button Color is configured', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor: '#7C3AED' }),
        false,
      );

      expect(html).toContain('background-color:#7C3AED');
    });

    /**
     * The footer is the card's button-like surface, so admins expect it to
     * follow the Button Color they set in Customize Design
     * (EmailBranding.button_color) — the same precedence renderHtml applies to
     * the CTA, so the two can never disagree inside one email.
     */
    it('prefers the configured Button Color over the brand primary', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B', buttonColor: '#B8860B' }),
        false,
      );

      expect(html).toContain('background-color:#B8860B');
      expect(html).not.toContain('background-color:#01546B');
    });

    it('picks ink that contrasts with the Button Color, not the primary', () => {
      // Dark primary (would take white) + pale button colour (needs dark ink).
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B', buttonColor: '#FFE600' }),
        false,
      );

      expect(html).toContain('color:#1a1a19;letter-spacing:-0.3px;');
      expect(html).not.toContain('color:#ffffff;letter-spacing:-0.3px;');
    });

    it('honours an explicitly configured button text colour', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ buttonColor: '#01546B', buttonTextColor: '#FFEE00' }),
        false,
      );

      expect(html).toContain('color:#FFEE00;letter-spacing:-0.3px;');
    });

    it('uses the same fill for the promo badge as for the footer', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B', buttonColor: '#B8860B' }),
        true,
      );

      // Both the badge and the footer must sit on the Button Color, otherwise
      // the shared ink colour would contrast with only one of them.
      const fills = html.match(/background-color:#B8860B/g) ?? [];
      expect(fills.length).toBe(2);
    });

    /**
     * The regression this guards: picking ink by a luminance threshold gave
     * Berry white-on-coral at 2.70, under the WCAG 3.0 floor for large text.
     * Every seeded brand — and any added later — must clear AA (4.5).
     */
    it.each([
      ['MedVirtual', '#01546B'],
      ['Berry Virtual', '#FD7171'],
      ['MMVA', '#7C3AED'],
    ])('keeps footer text readable on %s', (_name, primaryColor) => {
      const ink = inkOn(primaryColor);
      expect(contrastRatio(ink, primaryColor)).toBeGreaterThanOrEqual(4.5);

      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor }),
        false,
      );
      // The price must actually use that ink.
      expect(html).toContain(`color:${ink};letter-spacing:-0.3px;`);
    });

    // Coral is light enough that white fails on it; near-black is chosen.
    it('uses dark ink on a pale brand colour instead of white', () => {
      expect(inkOn('#FD7171')).toBe('#1a1a19');
      expect(inkOn('#01546B')).toBe('#ffffff');
    });

    it('carries the muted ink into the availability label and /mo suffix', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate()],
        makeTheme({ primaryColor: '#01546B' }),
        false,
      );

      // A fixed grey would be unreadable on the filled footer.
      expect(html).toContain('color:rgba(255, 255, 255, 0.78);">/mo');
      expect(html).not.toContain('color:#5f5e5a;">/mo');
    });

    it('keeps the struck original legible on the fill', () => {
      const html = renderOfferPanelCandidateCards(
        [makeCandidate({ bill_rate_monthly: 2500 })],
        makeTheme({ primaryColor: '#01546B' }),
        true,
      );

      expect(html).toContain(
        'color:rgba(255, 255, 255, 0.55);text-decoration:line-through',
      );
      expect(html).not.toContain('color:#94a3b8');
    });

    it('survives a malformed brand colour rather than throwing', () => {
      expect(() =>
        renderOfferPanelCandidateCards(
          [makeCandidate()],
          makeTheme({ primaryColor: 'not-a-color' }),
          false,
        ),
      ).not.toThrow();
    });
  });

  describe('capping', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      makeCandidate({ id: `c${i}`, first_name: `Cand${i}` }),
    );

    it('caps the cards and links the remainder to the panel', () => {
      const html = renderOfferPanelCandidateCards(
        many,
        makeTheme(),
        false,
        'https://app.medvirtual.ai/panel/abc',
      );

      // 6 rendered, 3 summarized — Gmail clips messages past ~102KB.
      expect(html.match(/border-radius:12px 12px 0 0/g)).toHaveLength(6);
      expect(html).toContain('+3 more candidates');
      expect(html).toContain('https://app.medvirtual.ai/panel/abc');
    });

    it('still reports the remainder without a panel URL', () => {
      const html = renderOfferPanelCandidateCards(many, makeTheme(), false);

      expect(html).toContain('+3 more candidates');
      expect(html).not.toContain('<a href');
    });
  });
});
