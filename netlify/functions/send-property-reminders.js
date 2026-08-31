// netlify/functions/send-property-reminders.js
// Scheduled (daily) function that emails active tenants a reminder for each
// enabled reminder rule configured on their property — e.g. "Electric Bill,
// due the 5th, remind 3 days ahead." Rules are admin-defined per property
// (properties/{id}.reminders), self-serve for a Restricted Admin on their
// own properties, same as everything else attached to a property.
//
// Distinct from send-invoice-reminders.js, which reminds about invoices
// that already exist — this reminds about recurring bills/utilities that
// were never necessarily turned into an invoice at all (e.g. a landlord
// just wants tenants nudged about when the water bill is typically due).
//
// The schedule is declared in netlify.toml ([functions."send-property-reminders"]).
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT (email creds come from the
// existing integration-override system via _lib/apply-email-config.js,
// falling back to SMTP_HOST etc. if nothing custom is configured).

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

function utcMidnightToday() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Computes a candidate due/send date for a given (year, month) occurrence of
// the rule's day-of-month.
function computeCycle(dayOfMonth, leadDays, year, month) {
  const due = new Date(Date.UTC(year, month, Math.min(Math.max(dayOfMonth, 1), 28)));
  const send = new Date(due);
  send.setUTCDate(send.getUTCDate() - (leadDays || 0));
  const period = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, '0')}`;
  return { dueMs: due.getTime(), sendMs: send.getTime(), period };
}

// A lead window always falls ON OR BEFORE its due date, so relative to
// "today", the relevant due date is either in today's own month, or in
// NEXT month (when the lead window pushes send-date earlier than the due
// date's own month — e.g. "5 days before the 2nd", checked in the last
// days of the prior month). It can never be the previous month, since
// leadDays is never negative — subtracting days only moves a date earlier,
// never forward into a later month. Checking both candidates, rather than
// assuming the due date is always in today's own month, is what makes this
// correct for every day-of-month/lead-day combination, not just the ones
// where the whole lead window happens to sit inside a single month.
function findMatchingCycle(rule, todayMs) {
  const today = new Date(todayMs);
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  for (const candidateMonth of [m, m + 1]) { // Date.UTC rolls month 12 into next year automatically
    const cycle = computeCycle(rule.dayOfMonth, rule.leadDays || 0, y, candidateMonth);
    if (cycle.sendMs === todayMs) return cycle;
  }
  return null;
}

exports.handler = async () => {
  await require('./_lib/apply-email-config')();
  const { renderReminderEmailHtml, renderReminderSubject } = require('./_lib/render-reminder-email');

  const a = getAdmin();
  const db = a.firestore();
  const nodemailer = require('nodemailer');

  if (!process.env.SMTP_HOST) {
    console.warn('send-property-reminders: no email configuration available (no custom provider, no SMTP_HOST env var) — skipping this run.');
    return { statusCode: 200, body: 'No email configuration available.' };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  // One global template (colors, logo, footer) for every reminder email —
  // fetched once, not per-property, since it's a single site-wide setting.
  let emailTemplate = {};
  try {
    const settingsSnap = await db.collection('settings').doc('site').get();
    if (settingsSnap.exists) emailTemplate = settingsSnap.data().reminderEmailTemplate || {};
  } catch (err) {
    console.warn('send-property-reminders: could not load email template, using defaults:', err.message);
  }

  const todayMs = utcMidnightToday();
  let remindersSent = 0, tenantsNotified = 0, errors = 0;

  try {
    const propsSnap = await db.collection('properties').get();

    for (const propDoc of propsSnap.docs) {
      const property = propDoc.data();
      const rules = Array.isArray(property.reminders) ? property.reminders : [];
      if (!rules.length) continue;

      let rulesChanged = false;
      const updatedRules = rules.map(rule => ({ ...rule }));

      for (let i = 0; i < updatedRules.length; i++) {
        const rule = updatedRules[i];
        if (rule.enabled === false || !rule.dayOfMonth) continue;

        const cycle = findMatchingCycle(rule, todayMs);
        if (!cycle) continue;                             // not this rule's day
        if (rule.lastSentPeriod === cycle.period) continue; // already sent this cycle

        const notifyTenants = rule.notifyTenants !== false; // default true, preserving existing behavior
        const notifyEmail = (rule.notifyEmail || '').trim();

        // Tenant notification and the admin/payables notification are
        // independent — a Firestore hiccup on the tenant lookup shouldn't
        // block the admin's own copy, and an admin-only reminder (tenants
        // turned off) shouldn't need any active tenants to exist at all.
        let recipients = [];
        if (notifyTenants) {
          try {
            const tenantsSnap = await db.collection('tenants')
              .where('propertyId', '==', propDoc.id)
              .where('status', '==', 'active')
              .get();
            tenantsSnap.docs.forEach(tDoc => {
              const tenant = tDoc.data();
              if (tenant.email) recipients.push({ email: tenant.email, name: tenant.firstName || 'there', isAdminCopy: false });
            });
          } catch (err) {
            console.error(`send-property-reminders: could not query tenants for property ${propDoc.id}:`, err.message);
            errors++;
          }
        }
        if (notifyEmail) {
          recipients.push({ email: notifyEmail, name: 'there', isAdminCopy: true });
        }

        if (!recipients.length) { updatedRules[i].lastSentPeriod = cycle.period; rulesChanged = true; continue; }

        const lang = rule.lang === 'es' ? 'es' : 'en'; // admin-chosen per rule, defaults to English
        const dateLocale = lang === 'es' ? 'es-ES' : 'en-US';
        const dueDateLabel = new Date(cycle.dueMs).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', timeZone: 'UTC' });
        const label = rule.label || 'Bill';
        const customMessage = (rule.message || '').trim();

        for (const recipient of recipients) {
          try {
            await transporter.sendMail({
              from: process.env.SMTP_FROM || process.env.SMTP_USER,
              to: recipient.email,
              subject: renderReminderSubject({ lang, label, dueLabel: dueDateLabel }),
              html: renderReminderEmailHtml({
                lang, recipientName: recipient.name, label, propertyName: property.name || '',
                dueLabel: dueDateLabel, customMessage, isAdminCopy: recipient.isAdminCopy, template: emailTemplate,
              }),
            });
            tenantsNotified++;
          } catch (err) {
            console.error(`send-property-reminders: failed to email ${recipient.email} for property ${propDoc.id}:`, err.message);
            errors++;
          }
        }

        updatedRules[i].lastSentPeriod = cycle.period;
        rulesChanged = true;
        remindersSent++;
      }

      if (rulesChanged) {
        await propDoc.ref.update({ reminders: updatedRules });
      }
    }

    console.log(`send-property-reminders: ${remindersSent} reminder(s) triggered, ${tenantsNotified} tenant(s) notified, ${errors} error(s).`);
    return { statusCode: 200, body: JSON.stringify({ remindersSent, tenantsNotified, errors }) };

  } catch (err) {
    console.error('send-property-reminders error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
