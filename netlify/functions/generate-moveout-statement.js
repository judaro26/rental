// netlify/functions/generate-moveout-statement.js
// Admin action: generates and sends a move-out record for a tenant.
//
// For US properties this is a California-compliant security deposit
// itemization (Civil Code §1950.5): itemized deductions across the four
// allowed categories (unpaid rent, damage beyond ordinary wear and tear,
// cleaning, personal property), the refund or amount owed, and a note
// about the $125 receipt-attachment threshold. The 21-calendar-day
// deadline (§1950.5(g)(1)) is tracked and shown in the admin UI, not
// here — this function just records when the statement was actually
// generated/sent, which is itself part of a landlord's proof of timely
// compliance.
//
// For Colombia properties there is no deposit-itemization step at all:
// Ley 820 de 2003 (Art. 16) prohibits cash security deposits for
// residential leases outright, so this just records the move-out date
// and property condition.
//
// Like view-invoice.js, the generated statement is meant to open directly
// from an email link with no tenant-portal login required, so — same
// lesson as that file — the blob key must be unguessable on its own, not
// just unique. crypto.randomBytes, not a sequential id or timestamp.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_*, SITE_URL

const nodemailer = require('nodemailer');
const crypto = require('crypto');

let admin;
function getAdmin() {
  if (!admin) {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
      });
    }
  }
  return admin;
}

function getStore() {
  const { getStore: _gs } = require('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new Error(`Missing env vars: ${[!siteID&&'NETLIFY_SITE_ID',!token&&'NETLIFY_API_TOKEN'].filter(Boolean).join(', ')}`);
  return _gs({ name: 'moveout-statements', consistency: 'strong', siteID, token });
}

const CATEGORY_LABELS = {
  unpaid_rent: 'Unpaid rent',
  damage: 'Damage beyond ordinary wear and tear',
  cleaning: 'Cleaning to restore move-in condition',
  personal_property: 'Personal property (per lease)',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildUsHtml({ siteName, siteUrl, tenantName, tenantEmail, unit, propertyName,
  moveOutDate, forwardingAddress, deposit, deductions, totalDeductions, netAmount, refundMethod }) {

  const rows = deductions.map(d => `
    <tr>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;">${esc(CATEGORY_LABELS[d.category] || d.category)}</td>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;">${esc(d.description)}</td>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:500;">$${parseFloat(d.amount).toFixed(2)}</td>
    </tr>`).join('');

  const repairCleaningTotal = deductions
    .filter(d => d.category === 'damage' || d.category === 'cleaning')
    .reduce((s, d) => s + parseFloat(d.amount || 0), 0);

  const isRefund = netAmount >= 0;
  const refundMethodLabel = refundMethod === 'electronic'
    ? 'Electronically, via your tenant portal / original payment method'
    : 'By paper check, made payable to all adult tenants named on the lease';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Security Deposit Itemization</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Helvetica Neue',Arial,sans-serif; background:#F7F4EF; padding:40px 20px; color:#1A1A2E; }
    .page { background:#fff; max-width:760px; margin:0 auto; padding:48px; border-radius:4px; box-shadow:0 2px 24px rgba(26,26,46,0.08); }
    @media print { body { background:#fff; padding:0; } .page { box-shadow:none; padding:32px; } .no-print { display:none; } }
  </style>
</head>
<body>
  <div class="page">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td>
          <div style="font-size:28px;font-weight:300;color:#1A1A2E;letter-spacing:0.04em;">${esc(siteName) || 'Tenant Portal'}</div>
          ${siteUrl ? `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;">${esc(siteUrl)}</div>` : ''}
        </td>
        <td style="text-align:right;vertical-align:top;">
          <div style="font-size:26px;font-weight:700;color:#C9903A;letter-spacing:0.04em;">Security Deposit Itemization</div>
          <div style="font-size:12px;color:#6B7280;margin-top:4px;">Cal. Civ. Code §1950.5</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td width="50%" style="vertical-align:top;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">Tenant</div>
          <div style="font-size:15px;font-weight:600;">${esc(tenantName)}</div>
          <div style="font-size:13px;color:#6B7280;margin-top:3px;">${esc(tenantEmail)}</div>
          ${unit ? `<div style="font-size:13px;color:#6B7280;">Unit ${esc(unit)}</div>` : ''}
          ${propertyName ? `<div style="font-size:13px;color:#6B7280;">${esc(propertyName)}</div>` : ''}
          ${forwardingAddress ? `<div style="font-size:12px;color:#9CA3AF;margin-top:8px;">Forwarding address:<br>${esc(forwardingAddress).replace(/\n/g,'<br>')}</div>` : ''}
        </td>
        <td width="50%" style="vertical-align:top;text-align:right;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">Move-out date</div>
          <div style="font-size:15px;font-weight:600;">${esc(moveOutDate)}</div>
        </td>
      </tr>
    </table>

    <div style="background:#F7F4EF;border-radius:3px;padding:16px 20px;margin-bottom:24px;display:flex;justify-content:space-between;font-size:14px;">
      <span style="color:#6B7280;">Security deposit received</span>
      <strong>$${deposit.toFixed(2)}</strong>
    </div>

    ${deductions.length ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #F3F4F6;border-radius:3px;overflow:hidden;">
      <thead>
        <tr style="background:#F9FAFB;">
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:left;font-weight:600;">Category</th>
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:left;font-weight:600;">Description</th>
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:right;font-weight:600;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${repairCleaningTotal > 125 ? `<p style="font-size:12px;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:3px;padding:10px 14px;margin-bottom:20px;">Itemized receipts or invoices for the repair and cleaning charges above are available upon request, as required for deductions exceeding $125 (Cal. Civ. Code §1950.5(g)(2)).</p>` : ''}
    ` : `<p style="font-size:13px;color:#6B7280;margin-bottom:24px;">No deductions — your full deposit is being refunded.</p>`}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td width="60%"></td><td width="40%">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:13px;color:#6B7280;">Deposit received</td><td style="padding:6px 0;font-size:13px;text-align:right;">$${deposit.toFixed(2)}</td></tr>
          <tr><td style="padding:6px 0;font-size:13px;color:#6B7280;">Total deductions</td><td style="padding:6px 0;font-size:13px;text-align:right;">−$${totalDeductions.toFixed(2)}</td></tr>
          <tr><td style="padding:10px 0;font-size:15px;font-weight:700;border-top:1px solid #F3F4F6;">${isRefund ? 'Refund due to you' : 'Amount you owe'}</td>
            <td style="padding:10px 0;font-size:18px;font-weight:700;text-align:right;border-top:1px solid #F3F4F6;color:${isRefund?'#16A34A':'#DC2626'};">$${Math.abs(netAmount).toFixed(2)}</td></tr>
        </table>
      </td></tr>
    </table>

    ${isRefund ? `<p style="font-size:13px;color:#374151;margin-bottom:28px;">Refund method: ${esc(refundMethodLabel)}</p>` : ''}

    <div style="border-top:1px solid #F3F4F6;padding-top:20px;text-align:center;">
      <p style="font-size:12px;color:#9CA3AF;">This statement is provided within 21 calendar days of move-out, as required by California Civil Code §1950.5. Please contact us with any questions.</p>
    </div>

    <div class="no-print" style="margin-top:24px;text-align:center;">
      <button onclick="window.print()" style="background:#1A1A2E;color:#fff;border:none;padding:10px 28px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;border-radius:2px;cursor:pointer;">🖨 Print / Save as PDF</button>
    </div>
  </div>
</body>
</html>`;
}

function buildCoHtml({ siteName, siteUrl, tenantName, tenantEmail, unit, propertyName, moveOutDate, forwardingAddress, conditionNotes }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Registro de Salida</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Helvetica Neue',Arial,sans-serif; background:#F7F4EF; padding:40px 20px; color:#1A1A2E; }
    .page { background:#fff; max-width:700px; margin:0 auto; padding:48px; border-radius:4px; box-shadow:0 2px 24px rgba(26,26,46,0.08); }
    @media print { body { background:#fff; padding:0; } .page { box-shadow:none; padding:32px; } .no-print { display:none; } }
  </style>
</head>
<body>
  <div class="page">
    <div style="font-size:28px;font-weight:300;color:#1A1A2E;margin-bottom:4px;">${esc(siteName) || 'Portal del Inquilino'}</div>
    ${siteUrl ? `<div style="font-size:12px;color:#9CA3AF;margin-bottom:28px;">${esc(siteUrl)}</div>` : ''}
    <div style="font-size:24px;font-weight:700;color:#C9903A;margin-bottom:24px;">Registro de Salida</div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        <td width="50%" style="vertical-align:top;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">Inquilino</div>
          <div style="font-size:15px;font-weight:600;">${esc(tenantName)}</div>
          <div style="font-size:13px;color:#6B7280;margin-top:3px;">${esc(tenantEmail)}</div>
          ${unit ? `<div style="font-size:13px;color:#6B7280;">Unidad ${esc(unit)}</div>` : ''}
          ${propertyName ? `<div style="font-size:13px;color:#6B7280;">${esc(propertyName)}</div>` : ''}
          ${forwardingAddress ? `<div style="font-size:12px;color:#9CA3AF;margin-top:8px;">Dirección de envío:<br>${esc(forwardingAddress).replace(/\n/g,'<br>')}</div>` : ''}
        </td>
        <td width="50%" style="vertical-align:top;text-align:right;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">Fecha de salida</div>
          <div style="font-size:15px;font-weight:600;">${esc(moveOutDate)}</div>
        </td>
      </tr>
    </table>

    <div style="background:#F7F4EF;border-radius:3px;padding:14px 18px;margin-bottom:20px;font-size:12px;color:#6B7280;line-height:1.6;">
      La ley colombiana (Ley 820 de 2003, Art. 16) prohíbe los depósitos en efectivo para contratos de arrendamiento de vivienda urbana. Este documento registra la salida y el estado de la propiedad; no aplica ninguna deducción de depósito.
    </div>

    ${conditionNotes ? `<div style="margin-bottom:24px;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">Notas sobre el estado de la propiedad</div><p style="font-size:13px;color:#374151;white-space:pre-wrap;line-height:1.6;">${esc(conditionNotes)}</p></div>` : ''}

    <div class="no-print" style="margin-top:24px;text-align:center;">
      <button onclick="window.print()" style="background:#1A1A2E;color:#fff;border:none;padding:10px 28px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;border-radius:2px;cursor:pointer;">🖨 Imprimir / Guardar como PDF</button>
    </div>
  </div>
</body>
</html>`;
}

function buildEmail({ isUS, tenantName, siteName, statementUrl, netAmount }) {
  const subject = isUS ? 'Your Security Deposit Itemization' : 'Registro de Salida';
  const intro = isUS
    ? `Hello ${esc(tenantName)}, your move-out security deposit statement is ready.`
    : `Hola ${esc(tenantName)}, tu registro de salida está listo.`;
  const amountLine = isUS
    ? `<tr><td style="font-size:13px;color:#6B7280;">${netAmount >= 0 ? 'Refund due' : 'Amount owed'}</td><td style="font-size:16px;font-weight:700;color:#C9903A;text-align:right;">$${Math.abs(netAmount).toFixed(2)}</td></tr>`
    : '';
  const buttonLabel = isUS ? 'View Statement' : 'Ver Registro';
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
    <div style="background:#1A1A2E;padding:24px 32px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${esc(siteName)||'Tenant Portal'}</span>
    </div>
    <div style="padding:32px;">
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:400;color:#1A1A2E;">${subject}</h2>
      <p style="font-size:15px;color:#6B7280;margin:0 0 24px;">${intro}</p>
      ${amountLine ? `<table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:24px;" cellpadding="0" cellspacing="0">${amountLine}</table>` : ''}
      <a href="${statementUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">${buttonLabel}</a>
    </div>
  </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantId, moveOutDate, forwardingAddress, country, deductions, refundMethod, conditionNotes, siteName } = body;
  if (!tenantId || !moveOutDate) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId and moveOutDate are required.' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();

  const { verifyAdmin } = require('./_lib/verify-admin');
  const authResult = await verifyAdmin(event, db, a);
  if (authResult.error) return authResult.error;

  try {
    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    if (!tenantSnap.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Tenant not found.' }) };
    const tenant = tenantSnap.data();
    if (!tenant.email) return { statusCode: 400, body: JSON.stringify({ error: 'This tenant has no email address on file.' }) };

    const isUS = country !== 'CO';
    const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
    const moveOutDateFormatted = new Date(moveOutDate + 'T00:00:00').toLocaleDateString(isUS ? 'en-US' : 'es-CO', { year:'numeric', month:'long', day:'numeric' });

    let html, netAmount = null, cleanDeductions = [], depositAmount = 0;

    if (isUS) {
      depositAmount = parseFloat(tenant.securityDeposit) || 0;
      cleanDeductions = Array.isArray(deductions) ? deductions
        .filter(d => d && d.description && parseFloat(d.amount) > 0)
        .map(d => ({ category: d.category || 'damage', description: String(d.description).trim().slice(0, 300), amount: parseFloat(d.amount) }))
        .slice(0, 50) : [];
      const totalDeductions = cleanDeductions.reduce((s, d) => s + d.amount, 0);
      netAmount = depositAmount - totalDeductions;

      html = buildUsHtml({
        siteName, siteUrl, tenantName: `${tenant.firstName||''} ${tenant.lastName||''}`.trim(), tenantEmail: tenant.email,
        unit: tenant.unit || '', propertyName: tenant.propertyName || '',
        moveOutDate: moveOutDateFormatted, forwardingAddress: String(forwardingAddress||'').slice(0, 500),
        deposit: depositAmount, deductions: cleanDeductions, totalDeductions, netAmount,
        refundMethod: refundMethod === 'check' ? 'check' : 'electronic',
      });
    } else {
      html = buildCoHtml({
        siteName, siteUrl, tenantName: `${tenant.firstName||''} ${tenant.lastName||''}`.trim(), tenantEmail: tenant.email,
        unit: tenant.unit || '', propertyName: tenant.propertyName || '',
        moveOutDate: moveOutDateFormatted, forwardingAddress: String(forwardingAddress||'').slice(0, 500),
        conditionNotes: String(conditionNotes||'').slice(0, 3000),
      });
    }

    // Same lesson as view-invoice.js: this link is meant to open without a
    // login, so the key itself is the entire access control and must be
    // unguessable, not just unique.
    const store = getStore();
    const blobKey = `moveout_${tenantId}_${crypto.randomBytes(16).toString('hex')}.html`;
    await store.set(blobKey, Buffer.from(html, 'utf8'), { metadata: { contentType: 'text/html', fileName: blobKey } });
    const statementUrl = `${siteUrl}/api/view-moveout-statement?key=${encodeURIComponent(blobKey)}`;

    // Record for the landlord's own proof of timely compliance — the
    // 21-day clock is enforced by law, not by this app, but having a
    // server-recorded generatedAt timestamp is exactly the kind of
    // evidence that defeats a bad-faith claim later.
    const moveOutData = {
      tenantId, tenantName: `${tenant.firstName||''} ${tenant.lastName||''}`.trim(), tenantEmail: tenant.email,
      propertyId: tenant.propertyId || null, propertyName: tenant.propertyName || '', unit: tenant.unit || '',
      country: isUS ? 'US' : 'CO', moveOutDate, forwardingAddress: String(forwardingAddress||'').slice(0, 500),
      depositAmount: isUS ? depositAmount : null,
      deductions: isUS ? cleanDeductions : null,
      netAmount: isUS ? netAmount : null,
      refundMethod: isUS ? (refundMethod === 'check' ? 'check' : 'electronic') : null,
      conditionNotes: isUS ? null : String(conditionNotes||'').slice(0, 3000),
      statementUrl, blobKey,
      generatedAt: a.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection('moveOuts').add(moveOutData);

    if (process.env.SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      tenant.email,
        subject: isUS ? 'Your Security Deposit Itemization' : 'Tu Registro de Salida',
        html:    buildEmail({ isUS, tenantName: `${tenant.firstName||''} ${tenant.lastName||''}`.trim(), siteName, statementUrl, netAmount }),
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, statementUrl }) };
  } catch (err) {
    console.error('generate-moveout-statement error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
