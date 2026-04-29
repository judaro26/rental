// netlify/functions/generate-invoice.js
// Creates a branded HTML invoice or receipt, stores it in Netlify Blobs,
// saves metadata to Firestore, and emails the tenant a link.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   NETLIFY_SITE_ID (or SITE_ID), NETLIFY_API_TOKEN
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   SITE_URL

const nodemailer = require('nodemailer');

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
  return _gs({ name: 'invoices', consistency: 'strong', siteID, token });
}

// ── Auto-increment invoice number ───────────────────────────────────────────
async function nextInvoiceNumber(db, type) {
  const prefix  = type === 'receipt' ? 'REC' : 'INV';
  const year    = new Date().getFullYear();
  const ref     = db.collection('settings').doc('invoiceCounter');
  const snap    = await ref.get();
  const current = (snap.exists ? (snap.data()[prefix] || 0) : 0) + 1;
  await ref.set({ [prefix]: current }, { merge: true });
  return `${prefix}-${year}-${String(current).padStart(4, '0')}`;
}

// ── HTML template ────────────────────────────────────────────────────────────
function buildHtml({ type, invoiceNumber, date, dueDate, paidDate, siteName, siteUrl,
  tenantName, tenantEmail, unit, propertyName, lineItems, subtotal, taxRate, taxAmount,
  total, notes, isPaid }) {

  const isReceipt    = type === 'receipt';
  const accentColor  = '#C9903A';
  const darkColor    = '#1A1A2E';
  const statusBanner = isPaid || isReceipt
    ? `<div style="position:absolute;top:32px;right:32px;border:4px solid #16A34A;border-radius:4px;padding:8px 20px;transform:rotate(15deg);color:#16A34A;font-size:28px;font-weight:900;letter-spacing:0.15em;opacity:0.7;">PAID</div>`
    : '';

  const rows = lineItems.map(item => `
    <tr>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;">${item.description}</td>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;text-align:right;">$${parseFloat(item.unitPrice).toFixed(2)}</td>
      <td style="padding:10px 12px;font-size:13px;color:#374151;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:500;">$${parseFloat(item.amount).toFixed(2)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${isReceipt?'Receipt':'Invoice'} ${invoiceNumber}</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:'Helvetica Neue',Arial,sans-serif; background:#F7F4EF; padding:40px 20px; color:#1A1A2E; }
    .page { background:#fff; max-width:760px; margin:0 auto; padding:48px; border-radius:4px; box-shadow:0 2px 24px rgba(26,26,46,0.08); position:relative; }
    @media print { body { background:#fff; padding:0; } .page { box-shadow:none; padding:32px; } .no-print { display:none; } }
  </style>
</head>
<body>
  <div class="page">
    ${statusBanner}

    <!-- Header -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr>
        <td>
          <div style="font-size:28px;font-weight:300;color:${darkColor};letter-spacing:0.04em;">${siteName || 'Tenant Portal'}</div>
          ${siteUrl ? `<div style="font-size:12px;color:#9CA3AF;margin-top:4px;">${siteUrl}</div>` : ''}
        </td>
        <td style="text-align:right;vertical-align:top;">
          <div style="font-size:32px;font-weight:700;color:${accentColor};letter-spacing:0.06em;text-transform:uppercase;">${isReceipt ? 'Receipt' : 'Invoice'}</div>
          <div style="font-size:14px;color:#6B7280;margin-top:4px;">#${invoiceNumber}</div>
        </td>
      </tr>
    </table>

    <!-- Meta bar -->
    <div style="background:#F7F4EF;border-radius:3px;padding:16px 20px;margin-bottom:32px;display:flex;gap:32px;flex-wrap:wrap;">
      <div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:3px;">Date</div><div style="font-size:13px;font-weight:500;">${date}</div></div>
      ${!isReceipt && dueDate ? `<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:3px;">Due Date</div><div style="font-size:13px;font-weight:500;${!isPaid?'color:#DC2626;':''}">${dueDate}</div></div>` : ''}
      ${(isReceipt || isPaid) && paidDate ? `<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:3px;">Paid Date</div><div style="font-size:13px;font-weight:500;color:#16A34A;">${paidDate}</div></div>` : ''}
      <div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:3px;">Status</div>
        <div style="font-size:12px;font-weight:600;padding:2px 10px;border-radius:10px;display:inline-block;background:${isPaid||isReceipt?'#F0FDF4':'#FEF3C7'};color:${isPaid||isReceipt?'#16A34A':'#92400E'};">
          ${isPaid||isReceipt ? 'PAID' : 'PENDING'}
        </div>
      </div>
    </div>

    <!-- Billing info -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td width="50%" style="vertical-align:top;padding-right:20px;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">Bill To</div>
          <div style="font-size:15px;font-weight:600;color:#1A1A2E;">${tenantName}</div>
          <div style="font-size:13px;color:#6B7280;margin-top:3px;">${tenantEmail}</div>
          ${unit ? `<div style="font-size:13px;color:#6B7280;">Unit ${unit}</div>` : ''}
          ${propertyName ? `<div style="font-size:13px;color:#6B7280;">${propertyName}</div>` : ''}
        </td>
        <td width="50%" style="vertical-align:top;text-align:right;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#9CA3AF;margin-bottom:8px;">From</div>
          <div style="font-size:15px;font-weight:600;color:#1A1A2E;">${siteName || 'Property Management'}</div>
        </td>
      </tr>
    </table>

    <!-- Line items -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #F3F4F6;border-radius:3px;overflow:hidden;">
      <thead>
        <tr style="background:#F9FAFB;">
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:left;font-weight:600;">Description</th>
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:center;font-weight:600;">Qty</th>
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:right;font-weight:600;">Unit Price</th>
          <th style="padding:10px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;text-align:right;font-weight:600;">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <!-- Totals -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td width="60%"></td>
        <td width="40%">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:6px 0;font-size:13px;color:#6B7280;">Subtotal</td>
              <td style="padding:6px 0;font-size:13px;color:#374151;text-align:right;">$${parseFloat(subtotal).toFixed(2)}</td>
            </tr>
            ${taxRate > 0 ? `<tr>
              <td style="padding:6px 0;font-size:13px;color:#6B7280;">Tax (${taxRate}%)</td>
              <td style="padding:6px 0;font-size:13px;color:#374151;text-align:right;">$${parseFloat(taxAmount).toFixed(2)}</td>
            </tr>` : ''}
            <tr>
              <td colspan="2"><div style="border-top:2px solid #1A1A2E;margin:8px 0;"></div></td>
            </tr>
            <tr>
              <td style="padding:4px 0;font-size:16px;font-weight:700;color:#1A1A2E;">Total</td>
              <td style="padding:4px 0;font-size:18px;font-weight:700;color:${accentColor};text-align:right;">$${parseFloat(total).toFixed(2)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${notes ? `<div style="background:#FFFBEB;border-left:3px solid ${accentColor};padding:12px 16px;border-radius:0 3px 3px 0;margin-bottom:24px;font-size:13px;color:#374151;"><strong>Notes:</strong> ${notes}</div>` : ''}

    <!-- Footer -->
    <div style="border-top:1px solid #F3F4F6;padding-top:20px;text-align:center;">
      <p style="font-size:12px;color:#9CA3AF;">Thank you for your business. Please contact us with any questions.</p>
      ${siteUrl ? `<p style="font-size:11px;color:#9CA3AF;margin-top:4px;">${siteUrl}</p>` : ''}
    </div>

    <!-- Print button (hidden when printing) -->
    <div class="no-print" style="margin-top:24px;text-align:center;">
      <button onclick="window.print()" style="background:#1A1A2E;color:#fff;border:none;padding:10px 28px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;border-radius:2px;cursor:pointer;">🖨 Print / Save as PDF</button>
    </div>
  </div>
</body>
</html>`;
}

// ── Email template ───────────────────────────────────────────────────────────
function buildEmail({ isReceipt, invoiceNumber, tenantName, total, dueDate, invoiceUrl, siteName }) {
  const label = isReceipt ? 'Receipt' : 'Invoice';
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
    <div style="background:#1A1A2E;padding:24px 32px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName||'Tenant Portal'}</span>
    </div>
    <div style="padding:32px;">
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:400;color:#1A1A2E;">Your ${label} is Ready</h2>
      <p style="font-size:15px;color:#6B7280;margin:0 0 24px;">Hello ${tenantName}, ${isReceipt?'your payment receipt':'a new invoice'} has been generated.</p>
      <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:24px;" cellpadding="0" cellspacing="0">
        <tr><td style="font-size:13px;color:#6B7280;">Number</td><td style="font-size:13px;font-weight:500;text-align:right;">#${invoiceNumber}</td></tr>
        <tr><td style="font-size:13px;color:#6B7280;padding-top:8px;">Amount</td><td style="font-size:16px;font-weight:700;color:#C9903A;text-align:right;">$${parseFloat(total).toFixed(2)}</td></tr>
        ${!isReceipt && dueDate ? `<tr><td style="font-size:13px;color:#6B7280;padding-top:8px;">Due Date</td><td style="font-size:13px;font-weight:500;text-align:right;">${dueDate}</td></tr>` : ''}
      </table>
      <a href="${invoiceUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">View ${label}</a>
    </div>
  </div>`;
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    type = 'invoice', // 'invoice' | 'receipt'
    tenantId, tenantName, tenantEmail, unit, propertyId, propertyName,
    lineItems = [], taxRate = 0, dueDate, paidDate, notes, siteName,
    existingInvoiceId, // if converting invoice→receipt
  } = body;

  if (!tenantId || !tenantEmail || !lineItems.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, tenantEmail, and lineItems are required' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    const isReceipt    = type === 'receipt';
    const invoiceNumber = existingInvoiceId
      ? (await db.collection('invoices').doc(existingInvoiceId).get()).data()?.invoiceNumber
      : await nextInvoiceNumber(db, type);

    // Calculate totals
    const subtotal  = lineItems.reduce((s, i) => s + parseFloat(i.amount || 0), 0);
    const taxAmount = subtotal * (parseFloat(taxRate) / 100);
    const total     = subtotal + taxAmount;
    const date      = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    // Build HTML
    const html = buildHtml({
      type, invoiceNumber, date, dueDate, paidDate, siteName, siteUrl,
      tenantName, tenantEmail, unit, propertyName,
      lineItems, subtotal, taxRate: parseFloat(taxRate), taxAmount, total,
      notes, isPaid: isReceipt,
    });

    // Store in Netlify Blobs
    const store    = getStore();
    const blobKey  = `${isReceipt?'receipt':'invoice'}_${invoiceNumber}_${Date.now()}.html`;
    await store.set(blobKey, Buffer.from(html, 'utf8'), { metadata: { contentType: 'text/html', fileName: `${blobKey}` } });
    const invoiceUrl = `${siteUrl}/api/view-invoice?key=${encodeURIComponent(blobKey)}`;

    // Save / update Firestore
    const invoiceData = {
      type, invoiceNumber, tenantId, tenantName, tenantEmail, unit: unit||'',
      propertyId: propertyId||null, propertyName: propertyName||'',
      lineItems, subtotal, taxRate: parseFloat(taxRate)||0, taxAmount, total,
      dueDate: dueDate||null, paidDate: paidDate||null, notes: notes||'',
      status: isReceipt ? 'paid' : 'sent',
      invoiceUrl, blobKey,
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    };

    let invoiceId;
    if (existingInvoiceId) {
      await db.collection('invoices').doc(existingInvoiceId).update({
        ...invoiceData,
        status: 'paid',
        paidAt: a.firestore.FieldValue.serverTimestamp(),
      });
      invoiceId = existingInvoiceId;
    } else {
      const ref = await db.collection('invoices').add({
        ...invoiceData,
        createdAt: a.firestore.FieldValue.serverTimestamp(),
        sentAt:    a.firestore.FieldValue.serverTimestamp(),
      });
      invoiceId = ref.id;
    }

    // Email tenant
    if (process.env.SMTP_HOST && tenantEmail) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      tenantEmail,
        subject: `${isReceipt ? 'Payment Receipt' : 'New Invoice'} #${invoiceNumber} — $${total.toFixed(2)}`,
        html:    buildEmail({ isReceipt, invoiceNumber, tenantName, total, dueDate, invoiceUrl, siteName }),
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, invoiceId, invoiceUrl, invoiceNumber }) };
  } catch (err) {
    console.error('generate-invoice error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
