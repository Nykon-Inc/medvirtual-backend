import {
  EMAIL_LOGO_HEIGHT_PX,
  EMAIL_LOGO_MAX_WIDTH_PX,
  getEmailHeader,
  getEmailLogoCss,
  getEmailLogoImg,
  getLogoUrl,
} from './components';
import { EmailTheme } from './theme';

const theme = (overrides: Partial<EmailTheme> = {}): EmailTheme =>
  ({
    primaryColor: '#01546B',
    primaryColorHover: '#013A4F',
    secondaryColor: '#F8F9FA',
    accentColor: '#00B2E2',
    companyName: 'MedVirtual',
    ...overrides,
  }) as EmailTheme;

describe('email logo helpers', () => {
  describe('getLogoUrl', () => {
    it('should use the business unit logo configured in EmailBranding', () => {
      const url = getLogoUrl(
        theme({ logoUrl: 'https://cdn.example.com/custom-logo.png' }),
      );
      expect(url).toBe('https://cdn.example.com/custom-logo.png');
    });

    it('should fall back to the Berry Virtual logo when none is configured', () => {
      expect(getLogoUrl(theme({ companyName: 'Berry Virtual' }))).toBe(
        'https://staging.medvirtual.ai/logobv.png',
      );
    });

    it('should fall back to the MedVirtual logo when none is configured', () => {
      expect(getLogoUrl(theme())).toBe(
        'https://staging.medvirtual.ai/logo.png',
      );
    });

    it('should fall back to MedVirtual when no theme is provided', () => {
      expect(getLogoUrl()).toBe('https://staging.medvirtual.ai/logo.png');
      expect(getLogoUrl(null)).toBe('https://staging.medvirtual.ai/logo.png');
    });
  });

  describe('getEmailLogoImg', () => {
    it('should normalize height and let width vary', () => {
      const html = getEmailLogoImg(theme());
      expect(html).toContain(`height:${EMAIL_LOGO_HEIGHT_PX}px`);
      expect(html).toContain('width:auto');
      expect(html).toContain(`max-width:${EMAIL_LOGO_MAX_WIDTH_PX}px`);
    });

    it('should emit the height attribute for Outlook, which ignores max-width', () => {
      expect(getEmailLogoImg(theme())).toContain(
        `height="${EMAIL_LOGO_HEIGHT_PX}"`,
      );
    });

    it('should never constrain by width alone', () => {
      // A width-only constraint is what made logos of differing aspect ratios
      // render at inconsistent heights.
      expect(getEmailLogoImg(theme())).not.toContain('height:auto');
    });

    it('should render the configured logo and company name', () => {
      const html = getEmailLogoImg(
        theme({
          companyName: 'Berry Virtual',
          logoUrl: 'https://cdn.example.com/bv.png',
        }),
      );
      expect(html).toContain('src="https://cdn.example.com/bv.png"');
      expect(html).toContain('alt="Berry Virtual Logo"');
    });
  });

  describe('getEmailLogoCss', () => {
    it('should define a fixed height with automatic width', () => {
      const css = getEmailLogoCss();
      expect(css).toContain(`height: ${EMAIL_LOGO_HEIGHT_PX}px`);
      expect(css).toContain('width: auto');
      expect(css).toContain(`max-width: ${EMAIL_LOGO_MAX_WIDTH_PX}px`);
      expect(css).not.toContain('height: auto');
    });
  });

  describe('getEmailHeader', () => {
    it('should honor the business unit logo instead of hardcoding a default', () => {
      const html = getEmailHeader(
        theme({ logoUrl: 'https://cdn.example.com/custom-logo.png' }),
      );
      expect(html).toContain('https://cdn.example.com/custom-logo.png');
      expect(html).toContain(`height="${EMAIL_LOGO_HEIGHT_PX}"`);
    });

    it('should apply the theme primary color as the header background', () => {
      expect(getEmailHeader(theme({ primaryColor: '#FD7171' }))).toContain(
        'background:#FD7171',
      );
    });
  });
});
