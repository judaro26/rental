// netlify/functions/payment-notify.js
// Sends an email to the admin when a payment is confirmed (manual or Zelle approval).
// Stripe payments are handled directly in stripe-webhook.js.
//
// Required env vars: SMTP_*, ADMIN_NOTIFY_EMAIL, SITE_URL

const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  if (!adminEmail || !process.env.SMTP_HOST) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { tenantName, amount, description, method, siteName } = body;
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  const label   = method === 'zelle' ? 'Zelle' : method === 'stripe' ? 'Stripe' : 'Manual';

  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: parseInt(process.env.SMTP_PORT || '587') === 465,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      adminEmail,
      subject: `💳 Payment Confirmed — ${tenantName||'Tenant'} · $${parseFloat(amount).toFixed(2)}`,
      html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
        <div style="background:#1A1A2E;padding:24px 32px;">
          <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName||'Tenant Portal'}</span>
          <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;line-height:2.2;">💳 Payment Confirmed</span>
        </div>
        <div style="padding:28px 32px;">
          <h2 style="margin:0 0 4px;font-size:22px;font-weight:400;color:#1A1A2E;">Payment Confirmed</h2>
          <p style="font-size:13px;color:#9CA3AF;margin:0 0 20px;">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
          <table width="100%" style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:20px;" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Tenant</td><td style="font-size:13px;font-weight:500;text-align:right;padding-bottom:8px;">${tenantName||'—'}</td></tr>
            <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Description</td><td style="font-size:13px;text-align:right;padding-bottom:8px;">${description||'Rent Payment'}</td></tr>
            <tr><td style="font-size:13px;color:#6B7280;padding-bottom:8px;">Method</td>
              <td style="text-align:right;padding-bottom:8px;">
                <span style="font-size:12px;padding:2px 8px;border-radius:10px;background:${method==='zelle'?'#EEF2FF':method==='stripe'?'#F0F9FF':'#F3F4F6'};color:${method==='zelle'?'#4F46E5':method==='stripe'?'#0284C7':'#374151'};">${label}</span>
              </td>
            </tr>
            <tr><td style="font-size:16px;font-weight:700;color:#1A1A2E;padding-top:8px;">Amount</td><td style="font-size:20px;font-weight:700;color:#C9903A;text-align:right;padding-top:8px;">$${parseFloat(amount).toFixed(2)}</td></tr>
          </table>
          ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:10px 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;">View in Admin →</a>` : ''}
        </div>
        <div style="background:#F7F4EF;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9CA3AF;">Automated notification from ${siteName||'Tenant Portal'}.</p>
        </div>
      </div>`,
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('payment-notify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
