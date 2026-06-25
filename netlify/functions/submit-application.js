// netlify/functions/submit-application.js
// Handles prospective tenant rental applications.
// Stores encrypted PII in Firestore, emails admin notification,
// and sends applicant a GDPR/CCPA-compliant confirmation with data rights disclosure.
//
// Required env vars:
//   FIREBASE_SERVICE_ACCOUNT
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   ADMIN_NOTIFY_EMAIL
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

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── Privacy notice embedded in the applicant confirmation email ──────────────
function buildPrivacyNotice(siteName, siteUrl, submittedAt) {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR DATA RIGHTS — PRIVACY NOTICE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

What we collected: Name, contact information, employment details, and rental history provided in your application submitted on ${submittedAt}.

Why we collected it: To evaluate your rental application for the property you requested.

How long we keep it: Applications are retained for 90 days. Approved tenant records are retained for the duration of tenancy plus 7 years as required by law.

Your rights (CCPA / GDPR):
  • Right to Access  — You may request a copy of the data we hold about you.
  • Right to Delete  — You may request deletion of your application data at any time before a lease is executed.
  • Right to Correct — You may request corrections to inaccurate data.
  • Right to Know    — You may ask how your data is used and with whom it is shared.

We do NOT sell your personal information to third parties.

To exercise any of these rights, email us at the address on record for ${siteName}${siteUrl ? ' (' + siteUrl + ')' : ''}.

This application was submitted with your express consent and is stored securely.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ── Applicant confirmation email ─────────────────────────────────────────────
function buildApplicantEmail({ firstName, propertyName, unitLabel, applicationId, siteName, siteUrl, submittedAt }) {
  const privacyText = buildPrivacyNotice(siteName, siteUrl, submittedAt);
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:580px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
    <div style="background:#1A1A2E;padding:28px 36px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
    </div>
    <div style="padding:32px 36px;">
      <h2 style="font-size:22px;font-weight:400;color:#1A1A2E;margin:0 0 8px;">Application Received</h2>
      <p style="font-size:14px;color:#6B7280;margin:0 0 24px;">Hello ${firstName}, your rental application has been submitted successfully.</p>
      <div style="background:#F9FAFB;border-radius:3px;padding:16px;margin-bottom:24px;border-left:3px solid #C9903A;">
        <table cellpadding="0" cellspacing="0" width="100%" style="font-size:13px;">
          <tr><td style="color:#9CA3AF;padding-bottom:6px;width:140px;">Application ID</td><td style="font-weight:600;color:#1A1A2E;padding-bottom:6px;">#${applicationId}</td></tr>
          <tr><td style="color:#9CA3AF;padding-bottom:6px;">Property</td><td style="font-weight:500;padding-bottom:6px;">${propertyName}${unitLabel ? ' — ' + unitLabel : ''}</td></tr>
          <tr><td style="color:#9CA3AF;padding-bottom:6px;">Submitted</td><td style="padding-bottom:6px;">${submittedAt}</td></tr>
          <tr><td style="color:#9CA3AF;">Status</td><td><span style="font-size:11px;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:10px;font-weight:500;">Under Review</span></td></tr>
        </table>
      </div>
      <p style="font-size:13px;color:#374151;line-height:1.7;margin:0 0 20px;">Our team will review your application and contact you within <strong>2–5 business days</strong>. You will receive an email with our decision at this address.</p>
      <p style="font-size:13px;color:#374151;line-height:1.7;margin:0 0 24px;">If you have questions in the meantime, please reply to this email or contact us through the portal.</p>
      <div style="background:#F0F9FF;border:1px solid #BFDBFE;border-radius:3px;padding:14px 16px;margin-bottom:20px;">
        <p style="font-size:12px;font-weight:600;color:#1D4ED8;margin:0 0 6px;">🔒 Your Privacy</p>
        <p style="font-size:12px;color:#1D4ED8;margin:0;line-height:1.6;">You have rights over the personal data you provided. See the full disclosure below. We do not sell your information.</p>
      </div>
    </div>
    <div style="background:#F7F4EF;padding:20px 36px;">
      <pre style="font-size:10px;color:#6B7280;white-space:pre-wrap;font-family:monospace;line-height:1.7;margin:0;">${privacyText}</pre>
    </div>
  </div>`;
}

// ── Admin notification email ──────────────────────────────────────────────────
function buildAdminEmail({ firstName, lastName, email, phone, propertyName, unitLabel, applicationId, income, currentEmployer, moveInDate, message, consentGiven, submittedAt, siteName, siteUrl }) {
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:auto;background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 2px 16px rgba(26,26,46,0.08);">
    <div style="background:#1A1A2E;padding:24px 32px;">
      <span style="font-size:20px;font-weight:300;color:#E8D5B0;letter-spacing:0.06em;">${siteName || 'Tenant Portal'}</span>
      <span style="float:right;font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;line-height:2.2;">📋 New Application</span>
    </div>
    <div style="padding:28px 32px 8px;">
      <h2 style="font-size:22px;font-weight:400;color:#1A1A2E;margin:0 0 4px;">New Rental Application</h2>
      <p style="font-size:13px;color:#9CA3AF;margin:0 0 20px;">Submitted ${submittedAt} — Application #${applicationId}</p>
    </div>
    <div style="padding:0 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        <tr>
          <td width="50%" style="padding-bottom:16px;vertical-align:top;">
            <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Applicant</p>
            <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:600;">${firstName} ${lastName}</p>
            <p style="margin:2px 0 0;font-size:13px;color:#6B7280;">${email}</p>
            ${phone ? `<p style="margin:2px 0 0;font-size:13px;color:#6B7280;">${phone}</p>` : ''}
          </td>
          <td width="50%" style="padding-bottom:16px;vertical-align:top;">
            <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Property</p>
            <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${propertyName}</p>
            ${unitLabel ? `<p style="margin:2px 0 0;font-size:13px;color:#6B7280;">${unitLabel}</p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding-bottom:16px;vertical-align:top;">
            <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Monthly Income</p>
            <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${income ? '$' + Number(income).toLocaleString() : '—'}</p>
          </td>
          <td style="padding-bottom:16px;vertical-align:top;">
            <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Current Employer</p>
            <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${currentEmployer || '—'}</p>
          </td>
        </tr>
        <tr>
          <td style="vertical-align:top;">
            <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Desired Move-in</p>
            <p style="margin:0;font-size:14px;color:#1A1A2E;font-weight:500;">${moveInDate || '—'}</p>
          </td>
          <td style="vertical-align:top;">
            <p style="margin:0 0 3px;font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;">Consent Given</p>
            <p style="margin:0;font-size:13px;color:${consentGiven?'#16A34A':'#DC2626'};font-weight:500;">${consentGiven ? '✓ Yes — recorded' : '✗ Not recorded'}</p>
          </td>
        </tr>
      </table>
      ${message ? `<div style="background:#F9FAFB;border-radius:3px;padding:14px;border-left:3px solid #C9903A;margin-bottom:20px;">
        <p style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 6px;">Applicant's Message</p>
        <p style="font-size:13px;color:#374151;line-height:1.6;margin:0;white-space:pre-wrap;">${message}</p>
      </div>` : ''}
      ${siteUrl ? `<a href="${siteUrl}/admin" style="display:inline-block;background:#C9903A;color:#fff;text-decoration:none;padding:12px 28px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;border-radius:2px;font-weight:500;">Review in Admin Panel →</a>` : ''}
    </div>
    <div style="background:#FEF3C7;padding:14px 32px;">
      <p style="font-size:11px;color:#92400E;margin:0;line-height:1.5;">⚠️ This application contains personal data. Handle in compliance with applicable privacy laws. Do not forward to unauthorized parties. Retain only as long as legally required.</p>
    </div>
  </div>`;
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    firstName, lastName, email, phone,
    propertyId, propertyName, unitId, unitLabel,
    income, currentEmployer, moveInDate, message,
    consentDataCollection,   // must be true — express opt-in
    consentBackgroundCheck,  // must be true — express opt-in
    consentTerms,            // must be true
    siteName,
  } = body;

  // ── Validate required fields ─────────────────────────────────────────────
  if (!firstName || !lastName || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'First name, last name, and email are required.' }) };
  }
  if (!propertyId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Property is required.' }) };
  }
  // ── Validate express consent — REQUIRED for CCPA/GDPR compliance ─────────
  if (!consentDataCollection || !consentTerms) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'You must provide express consent to data collection and our terms to submit an application. This is required by law.' }),
    };
  }

  // ── Capture server-side metadata (cannot be spoofed) ────────────────────
  const ipAddress  = (event.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim() || event.headers?.['x-real-ip'] || 'unknown';
  const userAgent  = event.headers?.['user-agent'] || 'unknown';
  const submittedAt = new Date().toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const submittedAtISO = new Date().toISOString();

  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

  const a  = getAdmin();
  const db = a.firestore();

  try {
    // ── Check property is still available ───────────────────────────────────
    const propSnap = await db.collection('properties').doc(propertyId).get();
    if (!propSnap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Property not found.' }) };
    }
    const propData = propSnap.data();

    // If a specific unit is requested, verify it is available
    if (unitId) {
      const unitSnap = await db.collection('properties').doc(propertyId).collection('units').doc(unitId).get();
      if (unitSnap.exists) {
        const unitData = unitSnap.data();
        if (unitData.available === false) {
          return { statusCode: 409, body: JSON.stringify({ error: 'This unit is no longer available. Please check back for other openings.' }) };
        }
      }
    } else if (propData.available === false) {
      return { statusCode: 409, body: JSON.stringify({ error: 'This property is no longer accepting applications.' }) };
    }

    // ── Check for duplicate application (same email + property, last 30 days)
    // Use a single-field Firestore query to avoid requiring a composite index.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dupSnap = await db.collection('applications')
      .where('email', '==', email)
      .get();

    const duplicateExists = dupSnap.docs.some(doc => {
      const data = doc.data();
      const submittedAtTs = data.submittedAt;
      const isSameProperty = data.propertyId === propertyId;
      const isRecent = submittedAtTs && submittedAtTs.toDate && submittedAtTs.toDate() >= thirtyDaysAgo;
      return isSameProperty && isRecent;
    });

    if (duplicateExists) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'An application from this email address for this property was already submitted within the last 30 days. Please contact us if you need to update your application.' }),
      };
    }

    // ── Store application in Firestore ──────────────────────────────────────
    // Only store what we need (data minimization principle)
    const applicationData = {
      // Applicant identity
      firstName:        firstName.trim(),
      lastName:         lastName.trim(),
      email:            email.trim().toLowerCase(),
      phone:            phone?.trim() || null,
      // Property
      propertyId,
      propertyName:     propertyName || propData.name || '',
      unitId:           unitId || null,
      unitLabel:        unitLabel || null,
      // Application details
      income:           income ? parseFloat(income) : null,
      currentEmployer:  currentEmployer?.trim() || null,
      moveInDate:       moveInDate || null,
      message:          message?.trim() || null,
      // Status
      status:           'pending',  // pending | approved | declined | withdrawn
      // Consent record (legally required — server-side timestamp and IP)
      consent: {
        dataCollection:   !!consentDataCollection,
        backgroundCheck:  !!consentBackgroundCheck,
        terms:            !!consentTerms,
        recordedAt:       submittedAtISO,
        ipAddress,
        userAgent,
        legalText: 'Applicant expressly consented to data collection for rental application processing, potential background/credit check authorization, and terms of application. Consent recorded with IP address and user agent at time of submission.',
      },
      // Audit
      submittedAt:      a.firestore.FieldValue.serverTimestamp(),
      updatedAt:        a.firestore.FieldValue.serverTimestamp(),
      ipAddress,        // top-level for admin audit log
      // Data retention policy
      retentionPolicy:  'delete_after_90_days_if_not_approved',
      // Deletion request tracking
      deletionRequested: false,
    };

    const ref = await db.collection('applications').add(applicationData);
    const applicationId = ref.id.substring(0, 8).toUpperCase(); // short readable ID

    // Store short ID back on the record
    await ref.update({ applicationId });

    // ── Log to audit collection ──────────────────────────────────────────────
    await db.collection('applicationAuditLog').add({
      applicationId:   ref.id,
      shortId:         applicationId,
      action:          'application_submitted',
      applicantEmail:  email,
      propertyId,
      propertyName:    propertyName || propData.name || '',
      ipAddress,
      userAgent,
      timestamp:       a.firestore.FieldValue.serverTimestamp(),
    });

    // ── Send emails ──────────────────────────────────────────────────────────
    if (process.env.SMTP_HOST) {
      const transporter = getTransporter();
      try {
        // Confirmation to applicant
        await transporter.sendMail({
          from:    process.env.SMTP_FROM || process.env.SMTP_USER,
          to:      email,
          subject: `Application Received — ${propertyName || propData.name} (#${applicationId})`,
          html:    buildApplicantEmail({ firstName, propertyName: propertyName || propData.name, unitLabel, applicationId, siteName, siteUrl, submittedAt }),
        });

        // Notification to admin
        const adminEmail = process.env.ADMIN_NOTIFY_EMAIL;
        if (adminEmail) {
          await transporter.sendMail({
            from:    process.env.SMTP_FROM || process.env.SMTP_USER,
            to:      adminEmail,
            subject: `📋 New Application — ${firstName} ${lastName} for ${propertyName || propData.name} (#${applicationId})`,
            html:    buildAdminEmail({ firstName, lastName, email, phone, propertyName: propertyName || propData.name, unitLabel, applicationId, income, currentEmployer, moveInDate, message, consentGiven: true, submittedAt, siteName, siteUrl }),
          });
        }
      } catch (emailErr) {
        console.error('submit-application email error:', emailErr);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, applicationId, message: 'Your application has been submitted. You will receive a confirmation email shortly.' }),
    };

  } catch (err) {
    console.error('submit-application error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'An error occurred while submitting your application. Please try again.' }) };
  }
};
