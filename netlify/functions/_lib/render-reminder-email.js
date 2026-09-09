// netlify/functions/_lib/render-reminder-email.js
// Shared HTML template + EN/ES copy for reminder emails. Required by both
// send-property-reminders.js (real sends) and manage-property-payments.js
// (test sends) so there is exactly one definition of what a reminder email
// looks like — testing a reminder and actually receiving one always match.
//
// Deliberately NOT a raw-HTML editor for the super_admin: letting an admin
// paste arbitrary HTML into something that gets emailed is easy to break
// (unclosed tags, broken layout in some clients) for very little upside.
// Instead, a small set of safe, structured knobs (colors, logo, footer
// text) drive one well-built layout — same philosophy as the Site
// Appearance theme system already built for the public site.

const COPY = {
  en: {
    eyebrow: 'Reminder',
    subjectLine: (label, dueLabel) => `${label} due ${dueLabel}`,
    greeting: name => `Hi ${name},`,
    bodyTenant: (label, property, dueLabel) => `This is a reminder that your <strong>${label}</strong> for ${property} is due on <strong>${dueLabel}</strong>.`,
    bodyAdmin: (label, property, dueLabel) => `This is a reminder that the <strong>${label}</strong> for ${property} is due on <strong>${dueLabel}</strong>.`,
    disclaimer: 'This is an automated reminder, not an invoice — check with your property manager if you have questions about how to pay.',
    testBanner: 'This is a test, sent only to you — not to tenants or any configured notify email.',
    defaultFooter: 'The Property Management Team',
  },
  es: {
    eyebrow: 'Recordatorio',
    subjectLine: (label, dueLabel) => `${label} vence el ${dueLabel}`,
    greeting: name => `Hola ${name},`,
    bodyTenant: (label, property, dueLabel) => `Este es un recordatorio de que tu <strong>${label}</strong> para ${property} vence el <strong>${dueLabel}</strong>.`,
    bodyAdmin: (label, property, dueLabel) => `Este es un recordatorio de que <strong>${label}</strong> para ${property} vence el <strong>${dueLabel}</strong>.`,
    disclaimer: 'Este es un recordatorio automático, no una factura — consulta con tu administrador de propiedad si tienes preguntas sobre cómo pagar.',
    testBanner: 'Esta es una prueba, enviada solo a ti — no a inquilinos ni a ningún correo de notificación configurado.',
    defaultFooter: 'El Equipo de Administración',
  },
};

function copyFor(lang) { return COPY[lang] || COPY.en; }

// template: { headerColor, accentColor, logoUrl, footerText } — all
// optional; every field falls back to a sensible default so this works
// unchanged for anyone who never configures anything.
function renderReminderEmailHtml({ lang, recipientName, label, propertyName, dueLabel, customMessage, isAdminCopy, isTest, template }) {
  const c = copyFor(lang);
  const tpl = template || {};
  const headerColor = tpl.headerColor || '#1A1A2E';
  const accentColor = tpl.accentColor || '#C9903A';
  const footerText = (tpl.footerText || '').trim() || c.defaultFooter;
  const logoHtml = tpl.logoUrl
    ? `<img src="${tpl.logoUrl}" alt="" style="max-height:40px;margin-bottom:14px;">`
    : '';
  const bodyLine = isAdminCopy ? c.bodyAdmin(label, propertyName, dueLabel) : c.bodyTenant(label, propertyName, dueLabel);

  return `
<div style="font-family:Georgia,'Times New Roman',serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;">
  ${isTest ? `<div style="background:#FEF3C7;color:#92400E;padding:10px 24px;font-size:12px;text-align:center;font-family:Arial,sans-serif;">${c.testBanner}</div>` : ''}
  <div style="background:${headerColor};padding:30px 32px;text-align:center;">
    ${logoHtml}
    <div style="color:#ffffff;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;opacity:0.7;font-family:Arial,sans-serif;">${c.eyebrow}</div>
    <div style="color:${accentColor};font-size:26px;font-weight:600;margin-top:8px;">${label}</div>
  </div>
  <div style="padding:32px;">
    <p style="font-size:15px;color:#1F2937;margin:0 0 16px;">${c.greeting(recipientName)}</p>
    <p style="font-size:15px;color:#1F2937;line-height:1.65;margin:0 0 20px;">${bodyLine}</p>
    ${customMessage ? `<p style="font-size:14px;color:#374151;background:#F9FAFB;border-left:3px solid ${accentColor};padding:14px 16px;border-radius:4px;margin:0 0 20px;line-height:1.5;">${customMessage}</p>` : ''}
    <p style="font-size:12px;color:#9CA3AF;margin:20px 0 0;line-height:1.5;">${c.disclaimer}</p>
  </div>
  <div style="background:#F9FAFB;padding:18px 32px;text-align:center;border-top:1px solid #E5E7EB;">
    <p style="font-size:12px;color:#6B7280;margin:0;">${footerText}</p>
  </div>
</div>`;
}

function renderReminderSubject({ lang, label, dueLabel, isTest }) {
  const c = copyFor(lang);
  return `${isTest ? '[TEST] ' : ''}${c.eyebrow}: ${c.subjectLine(label, dueLabel)}`;
}

module.exports = { renderReminderEmailHtml, renderReminderSubject };
