// netlify/functions/update-application.js
// Admin action: approve, decline, or withdraw a rental application.
// Sends decision email to applicant with legally required disclosures.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SMTP_*, SITE_URL

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { applicationId, status, reviewChecks, adminNotes, siteName } = body;
  if (!applicationId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required' }) };
  }
  if (!status && reviewChecks === undefined && adminNotes === undefined) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to update. Provide status, reviewChecks, or adminNotes.' }) };
  }
  if (status && !['approved', 'declined', 'withdrawn', 'pending'].includes(status)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status value' }) };
  }

  const a  = getAdmin();
  const db = a.firestore();
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  try {
    const appSnap = await db.collection('applications').doc(applicationId).get();
    if (!appSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Application not found' }) };
    }
    const app = appSnap.data();

    const updates = {
      updatedAt: a.firestore.FieldValue.serverTimestamp(),
    };
    if (status) {
      updates.status = status;
      if (status === 'approved') updates.approvedAt = a.firestore.FieldValue.serverTimestamp();
      if (status === 'declined') updates.declinedAt = a.firestore.FieldValue.serverTimestamp();
    }
    if (reviewChecks !== undefined) {
      updates.reviewChecks = reviewChecks;
    }
    if (adminNotes !== undefined) {
      updates.adminNotes = adminNotes || null;
    }

    await db.collection('applications').doc(applicationId).update(updates);

    const action = status ? `status_changed_to_${status}` : 'review_updated';
    await db.collection('applicationAuditLog').add({
      applicationId,
      shortId:       app.applicationId || applicationId.substring(0, 8).toUpperCase(),
      action,
      applicantEmail: app.email,
      propertyId:    app.propertyId,
      adminNotes:    adminNotes || null,
      reviewChecks:  reviewChecks || null,
      timestamp:     a.firestore.FieldValue.serverTimestamp(),
    });

    // If approved, mark unit/property as taken (optional — only if a specific unit)
    if (status === 'approved' && app.unitId) {
      await db.collection('properties').doc(app.propertyId)
        .collection('units').doc(app.unitId)
        .update({ available: false, takenByApplicationId: applicationId, updatedAt: a.firestore.FieldValue.serverTimestamp() });
    }

    // Email the applicant
    if (process.env.SMTP_HOST && app.email && (status === 'approved' || status === 'declined')) {
      const transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587'),
        secure: parseInt(process.env.SMTP_PORT || '587') === 465,
        auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const isApproved = status === 'approved';
      const subject = isApproved
        ? `🎉 Your Application Has Been Approved — ${app.propertyName}`
        : `Your Application Decision — ${app.propertyName}`;

      const declineNotice = `
ADVERSE ACTION NOTICE (if applicable)
If your application was declined based in whole or in part on information in a consumer report, you have the right to:
  1. Request a free copy of the consumer report used.
  2. Dispute the accuracy of any information in the report.
  3. Contact the consumer reporting agency that provided the report.

Your right to a free annual credit report: AnnualCreditReport.com | 1-877-322-8228`;

      const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
        <div style="background:#1A1A2E;padding:28px 36px;">
          <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
        </div>
        <div style="padding:32px 36px;">
          <h2 style="font-size:22px;font-weight:400;color:#1A1A2E;margin:0 0 8px;">${isApproved ? '🎉 Application Approved' : 'Application Decision'}</h2>
          <p style="font-size:14px;color:#6B7280;margin:0 0 20px;">Hello ${app.firstName},</p>
          <div style="background:${isApproved ? '#F0FDF4' : '#FEF2F2'};border:1px solid ${isApproved ? '#BBF7D0' : '#FECACA'};border-radius:3px;padding:16px;margin-bottom:20px;">
            <p style="font-size:14px;font-weight:500;color:${isApproved ? '#16A34A' : '#DC2626'};margin:0 0 8px;">${isApproved ? '✓ Your application has been approved!' : 'We are unable to approve your application at this time.'}</p>
            <p style="font-size:13px;color:${isApproved ? '#065F46' : '#991B1B'};margin:0;line-height:1.6;">${isApproved
              ? 'Congratulations! A member of our team will contact you shortly to discuss next steps, including lease signing and move-in details.'
              : 'We appreciate your interest and the time you took to apply. We encourage you to continue your housing search.'
            }</p>
          </div>
          ${adminNotes ? `<div style="background:#F9FAFB;border-left:3px solid #C9903A;padding:12px 16px;border-radius:0 3px 3px 0;margin-bottom:20px;">
            <p style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;margin:0 0 4px;">Note from property manager</p>
            <p style="font-size:13px;color:#374151;margin:0;line-height:1.6;">${adminNotes}</p>
          </div>` : ''}
          <div style="border-top:1px solid #F3F4F6;padding-top:16px;margin-top:4px;">
            <p style="font-size:13px;color:#374151;margin:0 0 6px;font-weight:500;">Application Reference: #${app.applicationId || applicationId.substring(0, 8).toUpperCase()}</p>
            <p style="font-size:13px;color:#6B7280;margin:0;">Property: ${app.propertyName}${app.unitLabel ? ' — ' + app.unitLabel : ''}</p>
          </div>
        </div>
        ${!isApproved ? `<div style="background:#F7F4EF;padding:20px 36px;">
          <pre style="font-size:10px;color:#6B7280;white-space:pre-wrap;font-family:monospace;line-height:1.7;margin:0;">${declineNotice}</pre>
        </div>` : ''}
      </div>`;

      await transporter.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to:      app.email,
        subject,
        html,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('update-application error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
