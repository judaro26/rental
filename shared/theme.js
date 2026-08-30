/**
 * /shared/theme.js
 * Applies super-admin-configured branding (colors, font pairing, logo) to
 * index.html, apply.html, and tenant-portal.html. Deliberately NOT loaded by
 * admin.html — admins need a consistent, predictable interface regardless of
 * whatever branding is configured for the public-facing site.
 *
 * Usage: <script src="/shared/theme.js"></script>
 *   ... after fetching settings/site ...
 *   SiteTheme.apply(settingsDocData?.theme);
 *
 * How color theming works: index.html/apply.html/tenant-portal.html already
 * consistently define the same 6 CSS custom properties at :root (--cream,
 * --charcoal, --amber, --amber-light, --slate, --border), so overriding just
 * two of them (primary -> --charcoal, accent -> --amber, with --amber-light
 * derived automatically) reaches every element that already references them
 * — no per-element changes needed.
 *
 * How font theming works: font-family is hardcoded inline in many places
 * (not variable-driven), including with higher specificity than a stylesheet
 * rule can normally beat. This injects a small !important override block —
 * a deliberate, narrow use of !important for exactly this "theme override"
 * purpose, so a font change actually reaches every element rather than only
 * the ones that happen not to have an inline override.
 */
(function (global) {
  const DEFAULTS = { primaryColor: '#1A1A2E', accentColor: '#C9903A', fontPairing: 'classic', logoUrl: '' };

  const FONT_PAIRINGS = {
    classic:   { heading: "'Cormorant Garamond', serif", body: "'Jost', sans-serif", googleFonts: null }, // already loaded by every page
    modern:    { heading: "'Playfair Display', serif", body: "'Inter', sans-serif", googleFonts: 'Playfair+Display:wght@400;600&family=Inter:wght@400;500;600' },
    warm:      { heading: "'Fraunces', serif", body: "'Karla', sans-serif", googleFonts: 'Fraunces:wght@400;600&family=Karla:wght@400;500;600' },
    minimal:   { heading: "'Space Grotesk', sans-serif", body: "'Space Grotesk', sans-serif", googleFonts: 'Space+Grotesk:wght@400;500;600' },
    editorial: { heading: "'Libre Baskerville', serif", body: "'Work Sans', sans-serif", googleFonts: 'Libre+Baskerville:wght@400;700&family=Work+Sans:wght@400;500;600' },
  };

  // Simple hex lightening for deriving --amber-light from a custom accent
  // color, so a custom accent still gets a matching light tint without
  // needing the admin to pick a second color.
  function lighten(hex, percent) {
    try {
      const num = parseInt(hex.replace('#', ''), 16);
      const amt = Math.round(2.55 * percent);
      let r = (num >> 16) + amt, g = (num >> 8 & 0x00FF) + amt, b = (num & 0x0000FF) + amt;
      r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
      return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
    } catch { return hex; }
  }

  function injectFontOverrideStyle() {
    if (document.getElementById('site-theme-font-override')) return;
    const style = document.createElement('style');
    style.id = 'site-theme-font-override';
    style.textContent = `
      body, input, select, textarea, button, .form-input { font-family: var(--font-body, 'Jost', sans-serif) !important; }
      h1, h2, h3, h4 { font-family: var(--font-heading, 'Cormorant Garamond', serif) !important; }
    `;
    document.head.appendChild(style);
  }

  function injectGoogleFontLink(spec) {
    if (!spec) return;
    const id = 'site-theme-google-font';
    let link = document.getElementById(id);
    if (!link) { link = document.createElement('link'); link.id = id; link.rel = 'stylesheet'; document.head.appendChild(link); }
    link.href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  }

  // Renders the configured logo into every element carrying this class —
  // add class="site-logo-slot" to a header/sidebar brand-mark container to
  // have it show the custom logo when one is set.
  function applyLogo(logoUrl) {
    document.querySelectorAll('.site-logo-slot').forEach(el => {
      if (logoUrl) el.innerHTML = `<img src="${logoUrl}" alt="Logo" style="max-height:36px;max-width:160px;object-fit:contain;">`;
    });
  }

  function apply(theme) {
    const t = { ...DEFAULTS, ...(theme || {}) };
    const root = document.documentElement.style;
    root.setProperty('--charcoal', t.primaryColor);
    root.setProperty('--amber', t.accentColor);
    root.setProperty('--amber-light', lighten(t.accentColor, 25));

    const pairing = FONT_PAIRINGS[t.fontPairing] || FONT_PAIRINGS.classic;
    if (pairing.googleFonts) injectGoogleFontLink(pairing.googleFonts);
    root.setProperty('--font-heading', pairing.heading);
    root.setProperty('--font-body', pairing.body);
    injectFontOverrideStyle();

    applyLogo(t.logoUrl);
  }

  global.SiteTheme = { apply };
})(window);
