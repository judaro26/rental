// netlify/functions/_lib/create-invoice.js
// Core "create (and optionally send) an invoice or receipt" logic, extracted
// from generate-invoice.js so it can be called directly — not just over
// HTTP — by both:
//   - generate-invoice.js itself (HTTP-triggered, for admin-initiated
//     invoices/receipts from the admin.html UI)
//   - send-auto-invoices.js (scheduled, for automated per-tenant rent
//     invoicing)
// There is exactly one implementation of what actually happens when an
// invoice is created; the two callers only differ in how they gather the
// input parameters (an HTTP request body vs. a tenant's own stored fields).

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { getPaymentInfo, renderPaymentEmailBlock } = require('./payment-info');
const { getConfig, getWorkspaceStore } = require('./workspace');

function getStore() {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new Error(`Missing env vars: ${[!siteID&&'NETLIFY_SITE_ID',!token&&'NETLIFY_API_TOKEN'].filter(Boolean).join(', ')}`);
  return getWorkspaceStore({ name: 'invoices', consistency: 'strong', siteID, token });
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
// Markup for the status pill and the diagonal PAID stamp, defined once so the
// page written at creation time and the live version served by view-invoice.js
// (which swaps them in when an invoice has since been paid) cannot drift apart.
function statusPillHtml(paid) {
  return `<div style="font-size:12px;font-weight:600;padding:2px 10px;border-radius:10px;display:inline-block;background:${paid?'#F0FDF4':'#FEF3C7'};color:${paid?'#16A34A':'#92400E'};">
          ${paid ? 'PAID' : 'PENDING'}
        </div>`;
}
function paidStampHtml() {
  return `<div style="position:absolute;top:32px;right:32px;border:4px solid #16A34A;border-radius:4px;padding:8px 20px;transform:rotate(15deg);color:#16A34A;font-size:28px;font-weight:900;letter-spacing:0.15em;opacity:0.7;">PAID</div>`;
}

function buildHtml({ type, invoiceNumber, date, dueDate, paidDate, siteName, siteUrl,
  tenantName, tenantEmail, unit, propertyName, lineItems, subtotal, taxRate, taxAmount,
  total, notes, isPaid }) {

  const isReceipt    = type === 'receipt';
  const accentColor  = '#C9903A';
  const darkColor    = '#1A1A2E';
  // Open invoices carry markers that view-invoice.js fills in at view time
  // (live PAID status, current payment details). Receipts are final: no markers.
  const statusBanner = isPaid || isReceipt ? paidStampHtml() : '<!--RB:STAMP-->';

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
        ${isReceipt ? '' : '<!--RB:STATUS-->'}${statusPillHtml(isPaid || isReceipt)}${isReceipt ? '' : '<!--/RB:STATUS-->'}
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

    ${isReceipt ? '' : '<!--RB:PAY-->'}

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
function buildEmail({ isReceipt, invoiceNumber, tenantName, total, dueDate, invoiceUrl, siteName, paymentHtml = '' }) {
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
      ${paymentHtml}
      <a href="${invoiceUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">View ${label}</a>
    </div>
  </div>`;
}

// Sends the "your invoice/receipt is ready" email. Shared by first-time
// creation and by an explicit receipt resend, so both produce identical mail.
async function sendInvoiceEmail({ isReceipt, invoiceNumber, tenantName, tenantEmail, total, dueDate, invoiceUrl, siteName, paymentHtml = '' }) {
  const transporter = nodemailer.createTransport({
    host:   getConfig('SMTP_HOST'),
    port:   parseInt(getConfig('SMTP_PORT') || '587'),
    secure: parseInt(getConfig('SMTP_PORT') || '587') === 465,
    auth:   { user: getConfig('SMTP_USER'), pass: getConfig('SMTP_PASS') },
  });
  await transporter.sendMail({
    from:    getConfig('SMTP_FROM') || getConfig('SMTP_USER'),
    to:      tenantEmail,
    subject: `${isReceipt ? 'Payment Receipt' : 'New Invoice'} #${invoiceNumber} — $${Number(total).toFixed(2)}`,
    html:    buildEmail({ isReceipt, invoiceNumber, tenantName, total, dueDate, invoiceUrl, siteName, paymentHtml }),
  });
}

// ── Core logic — extracted verbatim from generate-invoice.js's handler ──────
// Same behavior, same validation, same Firestore/Blob/email side effects.
// Callers provide `a` (initialized firebase-admin) and `db` (its firestore()),
// plus siteUrl directly (the HTTP handler derives this from env/headers;
// a scheduled function has neither, so it must pass SITE_URL explicitly).
async function createInvoiceCore({ a, db, siteUrl,
  type = 'invoice', tenantId, tenantName, tenantEmail, unit, propertyId, propertyName,
  lineItems = [], taxRate = 0, dueDate, paidDate, notes, siteName,
  existingInvoiceId, sendNow = true, scheduledSendDate,
}) {
  if (!tenantId || !tenantEmail || !lineItems.length) {
    throw new Error('tenantId, tenantEmail, and lineItems are required');
  }

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
  // The trailing segment used to be Date.now() — but invoiceNumber is
  // fully sequential (INV-2026-0001, -0002, ...) and a millisecond
  // timestamp is a narrow, often-predictable window (e.g. every
  // auto-invoice from a given day's scheduled run clusters within
  // seconds of each other). Since view-invoice.js is intentionally
  // login-free — invoices are meant to open straight from an email link,
  // no tenant portal account required — this key is the entire access
  // control for that invoice. It needs to be unguessable on its own,
  // not just unique.
  const blobKey  = `${isReceipt?'receipt':'invoice'}_${invoiceNumber}_${crypto.randomBytes(16).toString('hex')}.html`;
  await store.set(blobKey, Buffer.from(html, 'utf8'), { metadata: { contentType: 'text/html', fileName: `${blobKey}` } });
  const invoiceUrl = `${siteUrl}/api/view-invoice?key=${encodeURIComponent(blobKey)}`;

  // Receipts always send; invoices send only when sendNow is true (otherwise saved as a draft).
  const willSend = isReceipt || sendNow !== false;

  // Save / update Firestore
  const invoiceData = {
    type, invoiceNumber, tenantId, tenantName, tenantEmail, unit: unit||'',
    propertyId: propertyId||null, propertyName: propertyName||'',
    lineItems, subtotal, taxRate: parseFloat(taxRate)||0, taxAmount, total,
    dueDate: dueDate||null, paidDate: paidDate||null, notes: notes||'',
    status: isReceipt ? 'paid' : (willSend ? 'sent' : 'draft'),
    // Once it's actually sent, drop any pending auto-send date.
    scheduledSendDate: (isReceipt || willSend) ? null : (scheduledSendDate || null),
    invoiceUrl, blobKey,
    updatedAt: a.firestore.FieldValue.serverTimestamp(),
  };

  let invoiceId;
  if (existingInvoiceId) {
    const update = { ...invoiceData };
    if (isReceipt) {
      update.status = 'paid';
      update.paidAt = a.firestore.FieldValue.serverTimestamp();
    } else if (willSend) {
      update.sentAt = a.firestore.FieldValue.serverTimestamp();
    }
    await db.collection('invoices').doc(existingInvoiceId).update(update);
    invoiceId = existingInvoiceId;
  } else {
    const newDoc = {
      ...invoiceData,
      createdAt: a.firestore.FieldValue.serverTimestamp(),
    };
    if (willSend) newDoc.sentAt = a.firestore.FieldValue.serverTimestamp();
    const ref = await db.collection('invoices').add(newDoc);
    invoiceId = ref.id;
  }

  // Email tenant (skipped for drafts)
  if (willSend && getConfig('SMTP_HOST') && tenantEmail) {
    let paymentHtml = '';
    if (!isReceipt) {
      try { paymentHtml = renderPaymentEmailBlock(await getPaymentInfo(db, propertyId), { siteUrl }); }
      catch (err) { console.warn('createInvoice: payment info unavailable, sending email without it:', err.message); }
    }
    await sendInvoiceEmail({ isReceipt, invoiceNumber, tenantName, tenantEmail, total, dueDate, invoiceUrl, siteName, paymentHtml });
  }

  return { success: true, invoiceId, invoiceUrl, invoiceNumber, sent: willSend };
}

// ── Receipt idempotency ──────────────────────────────────────────────────
// Clicking "Receipt" repeatedly (or a retried request) used to mint a new
// receipt number and email the tenant every time. Receipts are now claimed
// atomically in collection `receiptClaims`, keyed by what the
// receipt is FOR: the invoice being receipted, or the payment (paymentId).
//   - first request wins the claim, creates the receipt, records its result
//   - any later/concurrent request for the same key returns the existing
//     receipt with alreadySent:true and sends NOTHING
//   - `resend: true` (an explicit admin choice) re-emails the SAME receipt —
//     same number, same link — instead of creating another one
//   - a failed attempt releases its claim so it can simply be retried
//   - a claim with no result older than the TTL is treated as abandoned
// Requests with no invoice/payment to key on (and all non-receipts) are
// unaffected and behave exactly as before.
const RECEIPT_CLAIM_TTL_MS = 2 * 60 * 1000;

async function claimReceipt({ db, type, existingInvoiceId, paymentId, tenantId, tenantEmail }) {
  if (type !== 'receipt') return { ref: null };
  const key = existingInvoiceId ? `inv_${existingInvoiceId}` : (paymentId ? `pay_${paymentId}` : null);
  if (!key) return { ref: null };
  const ref = db.collection('receiptClaims').doc(key);
  const outcome = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data();
      const abandoned = !d.result && d.claimedAtMs && (Date.now() - d.claimedAtMs) > RECEIPT_CLAIM_TTL_MS;
      if (!abandoned) return { duplicate: true, data: d };
    }
    tx.set(ref, { claimedAtMs: Date.now(), tenantId: tenantId || null, tenantEmail: tenantEmail || null });
    return { duplicate: false };
  });
  return { ref, ...outcome };
}

async function createInvoice(args) {
  const claim = await claimReceipt(args);

  if (claim.duplicate) {
    const d = claim.data || {};
    if (!d.result) return { success: true, alreadySent: true, inProgress: true };
    if (args.resend === true) {
      // Explicit resend: same receipt, same number, one more email.
      const { lineItems = [], taxRate = 0, tenantName, tenantEmail, dueDate, siteName } = args;
      const subtotal = lineItems.reduce((n, i) => n + parseFloat(i.amount || 0), 0);
      const total = subtotal + subtotal * (parseFloat(taxRate) / 100);
      if (getConfig('SMTP_HOST') && tenantEmail) {
        await sendInvoiceEmail({ isReceipt: true, invoiceNumber: d.result.invoiceNumber, tenantName, tenantEmail, total, dueDate, invoiceUrl: d.result.invoiceUrl, siteName });
      }
      return { ...d.result, resent: true };
    }
    return { ...d.result, alreadySent: true, sentAtMs: d.completedAtMs || null };
  }

  try {
    const result = await createInvoiceCore(args);
    if (claim.ref) {
      // Best effort: if this write fails the claim simply expires via the TTL.
      await claim.ref.set({ result, completedAtMs: Date.now() }, { merge: true })
        .catch(err => console.warn('createInvoice: could not record receipt result:', err.message));
    }
    return result;
  } catch (err) {
    if (claim.ref) await claim.ref.delete().catch(() => {}); // release so it can be retried
    throw err;
  }
}


module.exports = { createInvoice, buildHtml, buildEmail, nextInvoiceNumber, getStore, sendInvoiceEmail, statusPillHtml, paidStampHtml };
