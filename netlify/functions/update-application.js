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

function buildSmartMoveRequestEmail({ firstName, propertyName, unitLabel, applicationId, siteName, smartMoveLanding, submittedAt }) {
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
    <div style="background:#1A1A2E;padding:28px 36px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
    </div>
    <div style="padding:32px 36px;">
      <h2 style="font-size:22px;font-weight:400;color:#1A1A2E;margin:0 0 8px;">Complete your SmartMove rental screening</h2>
      <p style="font-size:14px;color:#6B7280;margin:0 0 20px;">Hello ${firstName},</p>
      <p style="font-size:14px;color:#6B7280;line-height:1.7;margin:0 0 18px;">Thank you for applying for ${propertyName}${unitLabel ? ' — ' + unitLabel : ''}. We are ready to move forward with your application, but the SmartMove screening fee must be paid and your report completed before approval can be finalized.</p>
      <p style="font-size:14px;color:#6B7280;line-height:1.7;margin:0 0 18px;">Click the button below to complete your SmartMove screening application and pay the screening fee securely.</p>
      <a href="${smartMoveLanding}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:14px 22px;border-radius:4px;font-size:14px;font-weight:600;">Complete screening in SmartMove</a>
      <div style="background:#F8FAFC;border:1px solid #BFDBFE;border-radius:3px;padding:16px;margin-top:24px;">
        <p style="margin:0;font-size:13px;color:#1D4ED8;font-weight:600;">Application reference</p>
        <p style="margin:6px 0 0;font-size:13px;color:#475569;">#${applicationId}</p>
      </div>
      <p style="font-size:12px;color:#64748B;line-height:1.6;margin:20px 0 0;">If you have questions, reply to this email and our team will assist you.</p>
    </div>
  </div>`;
}

function appendQueryParams(base, params) {
  try {
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  } catch (err) {
    return base;
  }
}

function buildSmartMoveAdminNotificationEmail({ applicantName, applicantEmail, propertyName, unitLabel, applicationId, smartMoveLanding, smartMoveStatus, consent, siteName }) {
  const consentRows = [
    ['Data collection', consent.dataCollection ? 'Yes' : 'No'],
    ['Background check consent', consent.backgroundCheck ? 'Yes' : 'No'],
    ['Terms accepted', consent.terms ? 'Yes' : 'No'],
    ['Recorded', consent.recordedAt || 'Unknown'],
    ['IP address', consent.ipAddress || 'Unknown'],
  ];
  const consentHtml = consentRows.map(([label, value]) => `<tr><td style="padding:8px 10px;border:1px solid #E2E8F0;font-size:13px;color:#334155;">${label}</td><td style="padding:8px 10px;border:1px solid #E2E8F0;font-size:13px;color:#111827;">${value}</td></tr>`).join('');
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:620px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;">
    <div style="background:#111827;padding:28px 36px;">
      <span style="font-size:20px;font-weight:300;color:#F8FAFC;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
    </div>
    <div style="padding:28px 36px;">
      <h2 style="font-size:22px;font-weight:500;color:#111827;margin:0 0 18px;">SmartMove screening invitation sent</h2>
      <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 18px;">A SmartMove rental screening request has been sent for ${applicantName}.</p>
      <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
        <tr><td style="padding:10px 10px;border:1px solid #E2E8F0;font-weight:600;color:#111827;width:170px;">Applicant</td><td style="padding:10px 10px;border:1px solid #E2E8F0;color:#111827;">${applicantEmail}</td></tr>
        <tr><td style="padding:10px 10px;border:1px solid #E2E8F0;font-weight:600;color:#111827;">Property</td><td style="padding:10px 10px;border:1px solid #E2E8F0;color:#111827;">${propertyName}${unitLabel ? ' — ' + unitLabel : ''}</td></tr>
        <tr><td style="padding:10px 10px;border:1px solid #E2E8F0;font-weight:600;color:#111827;">Application</td><td style="padding:10px 10px;border:1px solid #E2E8F0;color:#111827;">#${applicationId}</td></tr>
        <tr><td style="padding:10px 10px;border:1px solid #E2E8F0;font-weight:600;color:#111827;">SmartMove status</td><td style="padding:10px 10px;border:1px solid #E2E8F0;color:#111827;">${smartMoveStatus}</td></tr>
      </table>
      <div style="margin-bottom:20px;">
        <p style="font-size:14px;font-weight:600;color:#111827;margin:0 0 10px;">Applicant consent summary</p>
        <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">${consentHtml}</table>
      </div>
      <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 18px;">Open SmartMove to check the screening request and confirm next steps.</p>
      <a href="${smartMoveLanding}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:12px 20px;border-radius:4px;font-size:14px;font-weight:600;">Open SmartMove</a>
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

  const { applicationId, status, reviewChecks, adminNotes, creditCheckOrder, employmentVerificationOrder, smartMoveReportType, siteName } = body;
  if (!applicationId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'applicationId is required' }) };
  }
  if (!status && reviewChecks === undefined && adminNotes === undefined && !creditCheckOrder && !employmentVerificationOrder) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to update. Provide status, reviewChecks, adminNotes, or verification order flags.' }) };
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
    if (creditCheckOrder) {
      const smartMoveLanding = process.env.SMARTMOVE_LANDING_PAGE || 'https://rentals-secure.mysmartmove.com/landlord/firstscreening/step-one';
      const smartMoveApiUrl = process.env.SMARTMOVE_API_URL;
      const smartMoveApiKey = process.env.SMARTMOVE_API_KEY;
      const reportType = smartMoveReportType || 'smartcheck_premium';
      updates.creditCheckOrderedAt = a.firestore.FieldValue.serverTimestamp();
      updates.creditCheckOrderedBy = 'admin';
      updates.creditCheckStatus = 'requested';
      updates.creditCheckReportType = reportType;

      if (smartMoveApiUrl && smartMoveApiKey) {
        try {
          const providerResponse = await fetch(smartMoveApiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${smartMoveApiKey}`,
            },
            body: JSON.stringify({
              applicationId,
              firstName: app.firstName,
              lastName: app.lastName,
              email: app.email,
              phone: app.phone,
              currentEmployer: app.currentEmployer,
              propertyName: app.propertyName,
              unitLabel: app.unitLabel,
              reportType,
              reason: 'Rental screening fee payment and report',
              consent: app.consent || {},
            }),
          });
          const providerData = await providerResponse.json();
          const smartMoveStatus = providerResponse.ok ? (providerData.status || 'requested') : 'order_failed';

          if (providerResponse.ok) {
            if (providerData.reportUrl) updates.creditReportUrl = providerData.reportUrl;
            if (providerData.status) updates.creditCheckStatus = providerData.status;
            updates.creditCheckProviderMessage = providerData.message || providerData.status || 'SmartMove request sent successfully';
          } else {
            updates.creditCheckStatus = 'order_failed';
            updates.creditCheckProviderMessage = providerData.error || providerData.message || 'SmartMove provider returned an error';
          }

          const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
          if (adminEmail && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
            const transporter = nodemailer.createTransport({
              host:   process.env.SMTP_HOST,
              port:   parseInt(process.env.SMTP_PORT || '587'),
              secure: parseInt(process.env.SMTP_PORT || '587') === 465,
              auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            });
            const adminNotificationHtml = buildSmartMoveAdminNotificationEmail({
              applicantName: `${app.firstName || ''} ${app.lastName || ''}`.trim() || 'Applicant',
              applicantEmail: app.email || 'unknown',
              propertyName: app.propertyName || 'Requested property',
              unitLabel: app.unitLabel || '',
              applicationId: app.applicationId || applicationId.substring(0, 8).toUpperCase(),
              smartMoveLanding,
              smartMoveStatus,
              consent: app.consent || {},
              siteName: siteName || 'Tenant Portal',
            });
            await transporter.sendMail({
              from:    process.env.SMTP_FROM || process.env.SMTP_USER,
              to:      adminEmail,
              subject: `SmartMove screening request ${smartMoveStatus} for ${app.firstName || 'Applicant'} ${app.lastName || ''}`.trim(),
              html: adminNotificationHtml,
            });
          }
        } catch (err) {
          updates.creditCheckStatus = 'order_error';
          updates.creditCheckProviderMessage = err.message;
        }
      } else if (process.env.SMTP_HOST && app.email) {
        const transporter = nodemailer.createTransport({
          host:   process.env.SMTP_HOST,
          port:   parseInt(process.env.SMTP_PORT || '587'),
          secure: parseInt(process.env.SMTP_PORT || '587') === 465,
          auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        try {
          const smartMoveLandingWithParams = appendQueryParams(smartMoveLanding, {
            firstName: app.firstName,
            lastName: app.lastName,
            email: app.email,
            propertyName: app.propertyName,
            unitLabel: app.unitLabel,
            reportType: reportType,
            applicationId,
          });
          const emailHtml = buildSmartMoveRequestEmail({
            firstName: app.firstName || 'Applicant',
            propertyName: app.propertyName || 'your requested property',
            unitLabel: app.unitLabel || '',
            applicationId: app.applicationId || applicationId.substring(0, 8).toUpperCase(),
            siteName: siteName || 'Tenant Portal',
            smartMoveLanding: smartMoveLandingWithParams,
            submittedAt: app.submittedAt?.toDate ? app.submittedAt.toDate().toLocaleString() : new Date().toLocaleString(),
          });
          await transporter.sendMail({
            from:    process.env.SMTP_FROM || process.env.SMTP_USER,
            to:      app.email,
            subject: `Complete your SmartMove rental screening for ${app.propertyName || 'your application'}`,
            html:    emailHtml,
          });
          const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
          if (adminEmail) {
            const adminNotificationHtml = buildSmartMoveAdminNotificationEmail({
              applicantName: `${app.firstName || ''} ${app.lastName || ''}`.trim() || 'Applicant',
              applicantEmail: app.email || 'unknown',
              propertyName: app.propertyName || 'Requested property',
              unitLabel: app.unitLabel || '',
              applicationId: app.applicationId || applicationId.substring(0, 8).toUpperCase(),
              smartMoveLanding,
              smartMoveStatus: 'pending applicant payment',
              consent: app.consent || {},
              siteName: siteName || 'Tenant Portal',
            });
            await transporter.sendMail({
              from:    process.env.SMTP_FROM || process.env.SMTP_USER,
              to:      adminEmail,
              subject: `SmartMove screening request sent for ${app.firstName || 'Applicant'} ${app.lastName || ''}`.trim(),
              html: adminNotificationHtml,
            });
          }
          updates.creditCheckStatus = 'email_sent';
          updates.creditCheckProviderMessage = 'SmartMove request email sent to applicant';
        } catch (err) {
          updates.creditCheckStatus = 'email_failed';
          updates.creditCheckProviderMessage = err.message;
        }
      }
    }
    if (employmentVerificationOrder) {
      const employmentProviderUrl = process.env.EMPLOYMENT_VERIFICATION_API_URL;
      const employmentProviderKey = process.env.EMPLOYMENT_VERIFICATION_API_KEY;
      updates.employmentVerificationOrderedAt = a.firestore.FieldValue.serverTimestamp();
      updates.employmentVerificationOrderedBy = 'admin';
      updates.employmentVerificationStatus = 'ordered';
      if (employmentProviderUrl && employmentProviderKey) {
        try {
          const providerResponse = await fetch(employmentProviderUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${employmentProviderKey}`,
            },
            body: JSON.stringify({
              applicationId,
              firstName: app.firstName,
              lastName: app.lastName,
              email: app.email,
              phone: app.phone,
              currentEmployer: app.currentEmployer,
              propertyName: app.propertyName,
              unitLabel: app.unitLabel,
              reason: 'Rental applicant employment verification',
              consent: app.consent || {},
            }),
          });
          const providerData = await providerResponse.json();
          if (providerResponse.ok) {
            if (providerData.reportUrl) updates.employmentReportUrl = providerData.reportUrl;
            if (providerData.status) updates.employmentVerificationStatus = providerData.status;
            updates.employmentVerificationProviderMessage = providerData.message || providerData.status || 'Verification requested successfully';
          } else {
            updates.employmentVerificationStatus = 'order_failed';
            updates.employmentVerificationProviderMessage = providerData.error || providerData.message || 'Employment provider returned an error';
          }
        } catch (err) {
          updates.employmentVerificationStatus = 'order_error';
          updates.employmentVerificationProviderMessage = err.message;
        }
      }
    }

    await db.collection('applications').doc(applicationId).update(updates);

    let action = 'review_updated';
    if (status) action = `status_changed_to_${status}`;
    else if (creditCheckOrder && employmentVerificationOrder) action = 'credit_and_employment_ordered';
    else if (creditCheckOrder) action = 'credit_check_ordered';
    else if (employmentVerificationOrder) action = 'employment_verification_ordered';
    await db.collection('applicationAuditLog').add({
      applicationId,
      shortId:       app.applicationId || applicationId.substring(0, 8).toUpperCase(),
      action,
      applicantEmail: app.email,
      propertyId:    app.propertyId,
      adminNotes:    adminNotes || null,
      reviewChecks:  reviewChecks || null,
      creditCheckOrdered: !!creditCheckOrder,
      employmentVerificationOrdered: !!employmentVerificationOrder,
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
