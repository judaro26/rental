// netlify/functions/maintenance-notify.js
// Sends a notification email to the admin when a tenant submits a maintenance request.
//
// Required env vars:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM  (same as send-invite)
//   ADMIN_NOTIFY_EMAIL  — where to send notifications (e.g. judaro26@gmail.com)

const nodemailer = require('nodemailer');

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function buildEmailHtml({ tenantName, unit, propertyName, category, priority, description, imageUrls, siteUrl, siteName }) {
  const priorityColor = priority === 'high' ? '#DC2626' : priority === 'medium' ? '#D97706' : '#6B7280';
  const priorityBg    = priority === 'high' ? '#FEF2F2' : priority === 'medium' ? '#FFFBEB' : '#F9FAFB';
  const priorityLabel = priority === 'high' ? '🔴 High — Urgent' : priority === 'medium' ? '🟡 Medium — Needs attention' : '🟢 Low — Not urgent';

  const imagesSection = imageUrls && imageUrls.length
    ? `<tr><td style="padding:0 32px 24px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.06em;">Attached Photos</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${imageUrls.map(url => `<a href="${url}" target="_blank"><img src="${url}" width="120" height="120" style="object-fit:cover;border-radius:4px;border:1px solid #E5E7EB;" alt="photo"></a>`).join('')}
        </div>
      </td></tr>`
    : '';

  const adminUrl = siteUrl ? `${siteUrl}/admin` : '#';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F7F4EF;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EF;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:#1A1A2E;padding:24px 32px;display:flex;align-items:center;justify-content:space-between;">
            <table width="100%"><tr>
              <td><span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span></td>
              <td align="right"><span style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:0.08em;text-transform:uppercase;">Maintenance Alert</span></td>
            </tr></table>
          </td>
        </tr>
        <!-- Priority banner -->
        <tr>
          <td style="background:${priorityBg};border-left:4px solid ${priorityColor};padding:12px 32px;">
            <span style="font-size:13px;font-weight:600;color:${priorityColor};">${priorityLabel}</span>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:28px 32px 8px;">
            <h2 style="margin:0 0 4px;font-size:22px;font-weight:400;color:#1A1A2E;">New Repair Request</h2>
            <p style="margin:0;font-size:13px;color:#9CA3AF;">Submitted ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
          </td>
        </tr>
        <!-- Details grid -->
        <tr>
          <td style="padding:20px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                  <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Tenant</p>
                  <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${tenantName || 'Unknown'}</p>
                </td>
                <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                  <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Unit / Property</p>
                  <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${unit ? 'Unit ' + unit : '—'}${propertyName ? ' · ' + propertyName : ''}</p>
                </td>
              </tr>
              <tr>
                <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                  <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Category</p>
                  <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${category}</p>
                </td>
                <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                  <p style="margin:0 0 3px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Priority</p>
                  <p style="margin:0;font-size:14px;color:${priorityColor};font-weight:600;">${priority ? priority.charAt(0).toUpperCase()+priority.slice(1) : '—'}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Description -->
        <tr>
          <td style="padding:0 32px 24px;">
            <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Description</p>
            <div style="background:#F9FAFB;border-radius:4px;padding:14px 16px;border:1px solid #F3F4F6;">
              <p style="margin:0;font-size:14px;color:#374151;line-height:1.6;">${description}</p>
            </div>
          </td>
        </tr>
        <!-- Photos if any -->
        ${imagesSection}
        <!-- CTA -->
        <tr>
          <td style="padding:0 32px 32px;">
            <a href="${adminUrl}" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;font-weight:500;">
              View in Admin Panel →
            </a>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#F7F4EF;padding:16px 32px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#9CA3AF;">This is an automated notification from ${siteName || 'Tenant Portal'}.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
  if (!adminEmail) {
    console.warn('ADMIN_NOTIFY_EMAIL not set — skipping maintenance notification');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const { tenantName, unit, propertyName, category, priority, description, imageUrls, siteName } = body;
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    const subject = `[${priority?.toUpperCase() || 'NEW'}] Maintenance Request — ${category}${unit ? ' · Unit ' + unit : ''}`;

    await getTransporter().sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      adminEmail,
      subject,
      html:    buildEmailHtml({ tenantName, unit, propertyName, category, priority, description, imageUrls, siteUrl, siteName }),
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('maintenance-notify error:', err);
    // Return 200 so client doesn't surface email errors to tenant
    return { statusCode: 200, body: JSON.stringify({ notified: false, error: err.message }) };
  }
};
