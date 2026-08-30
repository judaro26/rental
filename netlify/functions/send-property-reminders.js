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

        // Find active tenants for this property.
        let tenantsSnap;
        try {
          tenantsSnap = await db.collection('tenants')
            .where('propertyId', '==', propDoc.id)
            .where('status', '==', 'active')
            .get();
        } catch (err) {
          console.error(`send-property-reminders: could not query tenants for property ${propDoc.id}:`, err.message);
          errors++;
          continue;
        }
        if (tenantsSnap.empty) { updatedRules[i].lastSentPeriod = cycle.period; rulesChanged = true; continue; }

        const dueDateLabel = new Date(cycle.dueMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
        const label = rule.label || 'Bill';
        const customMessage = (rule.message || '').trim();

        for (const tDoc of tenantsSnap.docs) {
          const tenant = tDoc.data();
          if (!tenant.email) continue;
          try {
            await transporter.sendMail({
              from: process.env.SMTP_FROM || process.env.SMTP_USER,
              to: tenant.email,
              subject: `Reminder: ${label} due ${dueDateLabel}`,
              html: `
                <p>Hi ${tenant.firstName || 'there'},</p>
                <p>This is a reminder that your <strong>${label}</strong> for ${property.name || 'your property'} is due on <strong>${dueDateLabel}</strong>.</p>
                ${customMessage ? `<p>${customMessage}</p>` : ''}
                <p style="color:#6B7280;font-size:12px;">This is an automated reminder, not an invoice — check with your property manager if you have questions about how to pay.</p>
              `,
            });
            tenantsNotified++;
          } catch (err) {
            console.error(`send-property-reminders: failed to email tenant ${tDoc.id} for property ${propDoc.id}:`, err.message);
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
