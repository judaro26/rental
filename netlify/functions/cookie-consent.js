/**
 * /shared/cookie-consent.js
 * Opt-in cookie consent banner shown to every visitor, in either language
 * (via PublicI18N — load public-i18n.js first). Persists the choice locally
 * so it isn't asked again, and logs the event server-side via
 * /api/record-cookie-consent for an audit trail (Colombia's Law 1581 expects
 * consent records to be retained, not just a client-side flag).
 *
 * Usage: <script src="/shared/public-i18n.js"></script>
 *        <script src="/shared/cookie-consent.js"></script>
 *        <script type="module"> await PublicI18N.init(...); CookieConsent.init(); </script>
 *
 * Note on scope: this app currently sets very few cookies of its own —
 * mainly Stripe.js's fraud-prevention cookies where payments happen.
 * "Reject Non-Essential" doesn't attempt to block those, since they're
 * necessary for the payment feature the user is actively using; it's wired
 * up so any future non-essential script (analytics, ads) can gate itself
 * on CookieConsent.hasConsent() before loading.
 */
(function (global) {
  const STORAGE_KEY = 'cookieConsent';
  const POLICY_VERSION = '1.0';

  function getStored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  function t(key, fallback) {
    return (global.PublicI18N && global.PublicI18N.t) ? global.PublicI18N.t(key) : fallback;
  }

  async function logConsent(choice) {
    try {
      await fetch('/api/record-cookie-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          choice,
          policyVersion: POLICY_VERSION,
          page: window.location.pathname,
          language: global.PublicI18N ? global.PublicI18N.getLang() : null,
        }),
      });
    } catch (err) { /* best-effort — never block the UI on this */ }
  }

  function hide() {
    const el = document.getElementById('cookie-consent-banner');
    if (el) el.remove();
  }

  function choose(choice) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice, at: new Date().toISOString(), policyVersion: POLICY_VERSION }));
    logConsent(choice);
    hide();
  }

  function render() {
    if (document.getElementById('cookie-consent-banner')) return;
    const el = document.createElement('div');
    el.id = 'cookie-consent-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookie consent');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:10000;background:#1A1A2E;color:#fff;padding:18px 24px;box-shadow:0 -4px 20px rgba(0,0,0,0.25);font-family:inherit;';
    el.innerHTML = `
      <div style="max-width:960px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:16px;">
        <p style="flex:1;min-width:240px;margin:0;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.85);" data-i18n="cookie.message">${t('cookie.message', "We use cookies to run this site and process payments securely. Some are required for the site to function; others help us understand how it's used. You can accept or decline non-essential cookies.")}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" id="cookie-reject-btn" style="background:none;border:1px solid rgba(255,255,255,0.35);color:#fff;padding:9px 18px;border-radius:2px;font-size:12px;letter-spacing:0.05em;cursor:pointer;" data-i18n="cookie.reject">${t('cookie.reject', 'Reject Non-Essential')}</button>
          <button type="button" id="cookie-accept-btn" style="background:#C9903A;border:none;color:#fff;padding:9px 18px;border-radius:2px;font-size:12px;letter-spacing:0.05em;cursor:pointer;font-weight:600;" data-i18n="cookie.accept">${t('cookie.accept', 'Accept All')}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('cookie-accept-btn').addEventListener('click', () => choose('accepted'));
    document.getElementById('cookie-reject-btn').addEventListener('click', () => choose('rejected'));
  }

  function init() {
    const stored = getStored();
    // Re-prompt if the policy version has changed since they last chose.
    if (stored && stored.policyVersion === POLICY_VERSION) return;
    render();
  }

  function hasConsent() {
    const stored = getStored();
    return !!stored && stored.choice === 'accepted';
  }

  global.CookieConsent = { init, hasConsent, POLICY_VERSION };
})(window);
