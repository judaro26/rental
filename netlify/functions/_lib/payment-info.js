// netlify/functions/_lib/payment-info.js
// Gathers and renders the "how to pay" information shown on invoices and in
// invoice emails, from the same sources the tenant portal and admin use:
//   - settings/site: zelleName/Email/Phone/Note/QrUploaded,
//                    cashappTag/Name/Note/QrUploaded  (global, shown in the portal)
//   - properties/{id}: paymentMethods [{id,label,instructions,enabled}],
//                      preferredPaymentMethod ('' | 'bold' | a method id),
//                      boldPaymentsEnabled        (configured in admin → Properties)
//
// The invoice PAGE is filled in when it is viewed (see view-invoice.js), not
// when it is created, so changing a Zelle account later never leaves old
// unpaid invoices pointing at a dead one. The EMAIL block is a point-in-time
// summary, as emails are.
//
// Every value here is admin-entered free text and ends up on a login-free
// page, so everything dynamic is HTML-escaped.

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getPaymentInfo(db, propertyId) {
  let site = {};
  try {
    const snap = await db.collection('settings').doc('site').get();
    if (snap.exists) site = snap.data() || {};
  } catch (err) { console.warn('payment-info: could not read site settings:', err.message); }

  let prop = {};
  if (propertyId) {
    try {
      const snap = await db.collection('properties').doc(propertyId).get();
      if (snap.exists) prop = snap.data() || {};
    } catch (err) { console.warn('payment-info: could not read property:', err.message); }
  }

  const entries = [];

  if (site.zelleEmail || site.zellePhone) {
    entries.push({
      id: 'zelle', kind: 'manual', label: 'Zelle',
      rows: [['Name', site.zelleName], ['Email', site.zelleEmail], ['Phone', site.zellePhone]].filter(r => r[1]),
      note: site.zelleNote || '',
      qr: site.zelleQrUploaded ? 'zelle' : null,
    });
  }
  if (site.cashappTag || site.cashappName) {
    entries.push({
      id: 'cashapp', kind: 'manual', label: 'Cash App',
      rows: [['Name', site.cashappName], ['$Cashtag', site.cashappTag]].filter(r => r[1]),
      note: site.cashappNote || '',
      qr: site.cashappQrUploaded ? 'cashapp' : null,
    });
  }
  (Array.isArray(prop.paymentMethods) ? prop.paymentMethods : []).forEach(m => {
    if (!m || m.enabled === false || !String(m.label || '').trim()) return;
    entries.push({ id: m.id, kind: 'manual', label: String(m.label).trim(), rows: [], text: m.instructions || '', note: '', qr: null });
  });
  if (prop.boldPaymentsEnabled === true) {
    entries.push({ id: 'bold', kind: 'online', label: 'Pay online by card', rows: [], text: '', note: '', qr: null });
  }

  // The property's featured method goes first.
  const pref = prop.preferredPaymentMethod || '';
  const idx = pref ? entries.findIndex(e => e.id === pref) : -1;
  if (idx > 0) entries.unshift(entries.splice(idx, 1)[0]);
  if (idx >= 0) entries[0].preferred = true;

  return { entries };
}

// Full block for the invoice page.
function renderPaymentSectionHtml(info, { invoiceNumber } = {}) {
  if (!info || !info.entries || !info.entries.length) return '';

  const blocks = info.entries.map((e, i) => {
    const badge = e.preferred
      ? '<span style="font-size:10px;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:10px;margin-left:8px;font-weight:600;letter-spacing:0.05em;vertical-align:middle;">PREFERRED</span>'
      : '';
    let body;
    if (e.kind === 'online') {
      body = `<p style="font-size:13px;color:#374151;margin:0 0 10px;">Pay by card securely from your tenant portal.</p>
        <a href="/tenant-portal" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:10px 22px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;border-radius:2px;">Pay online</a>`;
    } else {
      const rows = (e.rows || []).map(([k, v]) =>
        `<tr><td style="font-size:12px;color:#9CA3AF;padding:2px 14px 2px 0;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="font-size:14px;font-weight:600;color:#1A1A2E;padding:2px 0;word-break:break-word;">${esc(v)}</td></tr>`).join('');
      const table = rows ? `<table cellpadding="0" cellspacing="0">${rows}</table>` : '';
      const text = e.text ? `<p style="font-size:13px;color:#374151;margin:0;white-space:pre-line;">${esc(e.text)}</p>` : '';
      const note = e.note ? `<p style="font-size:12px;color:#C9903A;margin:8px 0 0;">${esc(e.note)}</p>` : '';
      const qr = e.qr
        ? `<img src="/api/view-qr?method=${e.qr}" alt="${esc(e.label)} QR code" width="140" height="140" style="width:140px;height:140px;object-fit:contain;border:1px solid #E5E7EB;border-radius:4px;background:#fff;">`
        : '';
      body = `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">${qr}<div style="flex:1;min-width:180px;">${table}${text}${note}</div></div>`;
    }
    return `<div style="padding:14px 0;${i ? 'border-top:1px solid #F3F4F6;' : ''}">
      <div style="font-size:14px;font-weight:600;color:#1A1A2E;margin-bottom:8px;">${esc(e.label)}${badge}</div>${body}</div>`;
  }).join('');

  const ref = invoiceNumber
    ? `<p style="font-size:12px;color:#6B7280;margin:6px 0 0;">Please include <strong>invoice #${esc(invoiceNumber)}</strong> in your payment note so we can match it.</p>`
    : '';

  return `<div style="border:1px solid #E5E7EB;border-radius:3px;padding:8px 20px 16px;margin-bottom:24px;background:#FDFBF8;">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;padding-top:12px;">How to pay</div>${blocks}${ref}</div>`;
}

// Compact list for the invoice email (no QR codes — mail clients block images).
function renderPaymentEmailBlock(info, { siteUrl } = {}) {
  if (!info || !info.entries || !info.entries.length) return '';
  const portal = `${String(siteUrl || '').replace(/\/+$/, '')}/tenant-portal`;
  const items = info.entries.map(e => {
    let line;
    if (e.kind === 'online') {
      line = `<strong>Pay by card online:</strong> <a href="${esc(portal)}" style="color:#C9903A;">tenant portal</a>`;
    } else if (e.id === 'zelle') {
      const who = (e.rows || []).filter(r => r[0] === 'Email' || r[0] === 'Phone').map(r => esc(r[1])).join(' · ');
      line = `<strong>Zelle:</strong> ${who}`;
    } else if (e.id === 'cashapp') {
      const tag = (e.rows || []).find(r => r[0] === '$Cashtag');
      line = `<strong>Cash App:</strong> ${esc(tag ? tag[1] : (e.rows[0] || [])[1] || '')}`;
    } else {
      line = `<strong>${esc(e.label)}:</strong> ${esc(e.text)}`;
    }
    const pref = e.preferred ? ' <span style="color:#92400E;font-size:11px;">(preferred)</span>' : '';
    return `<li style="margin:0 0 6px;font-size:13px;color:#374151;">${line}${pref}</li>`;
  }).join('');
  return `<div style="margin:0 0 24px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">How to pay</div><ul style="margin:0;padding-left:18px;">${items}</ul></div>`;
}

module.exports = { getPaymentInfo, renderPaymentSectionHtml, renderPaymentEmailBlock, esc };
