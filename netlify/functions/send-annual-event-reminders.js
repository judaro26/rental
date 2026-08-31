// netlify/functions/send-annual-event-reminders.js
// Scheduled (daily) function for annual, recurring property events (e.g.
// a yearly HOA/board meeting) with one or more lead-time reminders per
// event. Sends an email with an attached .ics calendar file so the
// recipient gets a one-click "Add to Calendar" button in their email
// client — no OAuth, no connected Google/Outlook account required.
//
// Per-property field (properties/{id}.annualEvents[]):
//   { id, label, month (1-12), day (1-28), reminderLeadDays: [n, ...],
//     notifyEmail, notifyTenants (default false — board/HOA meetings are
//     primarily an owner/admin concern, unlike bill reminders which
//     default to notifying tenants), lang, lastSentYears: { '<leadDays>': year } }
//
// Reuses the same styled bilingual email template as the bill/utility
// reminders (_lib/render-reminder-email.js) and the same recipient-
// resolution pattern (tenant notification and the admin/board
// notification are independent of each other) — this is a different
// recurrence pattern (annual vs. monthly, multiple lead-times vs. one),
// not a different email design or a different notification philosophy.
//
// The schedule is declared in netlify.toml ([functions."send-annual-event-reminders"]).

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

exports.handler = async () => {
  await require('./_lib/apply-email-config')();
  const { findMatchingAnnualCycle, utcMidnightToday } = require('./_lib/annual-event-cycle');
  const { generateIcs } = require('./_lib/generate-ics');
  const { renderReminderEmailHtml, renderReminderSubject } = require('./_lib/render-reminder-email');
  const { notifyAdminOnFailure } = require('./_lib/notify-admin-on-failure');

  const a = getAdmin();
  const db = a.firestore();

  if (!process.env.SMTP_HOST) {
    console.warn('send-annual-event-reminders: no email configuration available (no custom provider, no SMTP_HOST env var) — skipping this run.');
    return { statusCode: 200, body: 'No email configuration available.' };
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  let emailTemplate = {};
  try {
    const settingsSnap = await db.collection('settings').doc('site').get();
    if (settingsSnap.exists) emailTemplate = settingsSnap.data().reminderEmailTemplate || {};
  } catch (err) {
    console.warn('send-annual-event-reminders: could not load email template, using defaults:', err.message);
  }

  const todayMs = utcMidnightToday();
  let remindersSent = 0, recipientsNotified = 0, errors = 0;
  const errorMessages = [];

  try {
    const propsSnap = await db.collection('properties').get();

    for (const propDoc of propsSnap.docs) {
      const property = propDoc.data();
      const events = Array.isArray(property.annualEvents) ? property.annualEvents : [];
      if (!events.length) continue;

      let eventsChanged = false;
      const updatedEvents = events.map(e => ({ ...e, lastSentYears: { ...(e.lastSentYears || {}) } }));

      for (let i = 0; i < updatedEvents.length; i++) {
        const event = updatedEvents[i];
        const leadDaysList = Array.isArray(event.reminderLeadDays) ? event.reminderLeadDays : [];
        if (!event.month || !event.day || !leadDaysList.length) continue;

        for (const leadDays of leadDaysList) {
          const cycle = findMatchingAnnualCycle(event, leadDays, todayMs);
          if (!cycle) continue; // not this reminder's day
          const leadKey = String(leadDays);
          if (updatedEvents[i].lastSentYears[leadKey] === cycle.year) continue; // already sent this year's reminder

          // Independent recipient resolution, same reasoning as the bill/
          // utility reminders: a Firestore hiccup on the tenant lookup
          // shouldn't block the admin/board copy, and an admin-only event
          // (tenants off, the default here) shouldn't need any active
          // tenants to exist at all.
          let recipients = [];
          if (event.notifyTenants) {
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
              console.error(`send-annual-event-reminders: could not query tenants for property ${propDoc.id}:`, err.message);
              errors++;
              errorMessages.push(`tenant query for property ${propDoc.id}: ${err.message}`);
            }
          }
          if (event.notifyEmail) {
            recipients.push({ email: event.notifyEmail, name: 'there', isAdminCopy: true });
          }

          if (!recipients.length) { updatedEvents[i].lastSentYears[leadKey] = cycle.year; eventsChanged = true; continue; }

          const lang = event.lang === 'es' ? 'es' : 'en';
          const dateLocale = lang === 'es' ? 'es-ES' : 'en-US';
          const dueDateLabel = new Date(cycle.dueMs).toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
          const label = event.label || (lang === 'es' ? 'Evento Anual' : 'Annual Event');

          // Stable UID — derived from property + event id, NOT the
          // specific year or lead-time — so every reminder for this
          // recurring event updates the same calendar entry rather than
          // creating a new one each time.
          const icsUid = `annual-event-${propDoc.id}-${event.id}@rentbay`;
          const icsContent = generateIcs({ uid: icsUid, label, propertyName: property.name || '', month: event.month, day: event.day });

          for (const recipient of recipients) {
            try {
              await transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
                to: recipient.email,
                subject: renderReminderSubject({ lang, label, dueLabel: dueDateLabel }),
                html: renderReminderEmailHtml({
                  lang, recipientName: recipient.name, label, propertyName: property.name || '',
                  dueLabel: dueDateLabel, customMessage: '', isAdminCopy: recipient.isAdminCopy, template: emailTemplate,
                }),
                // PUBLISH, not REQUEST — this is "here's an event, add it
                // if you want," not an organizer/attendee RSVP invitation
                // (which would need ORGANIZER/ATTENDEE fields the .ics
                // doesn't include).
                icalEvent: { filename: 'event.ics', method: 'PUBLISH', content: icsContent },
              });
              recipientsNotified++;
            } catch (err) {
              console.error(`send-annual-event-reminders: failed to email ${recipient.email} for property ${propDoc.id}:`, err.message);
              errors++;
              errorMessages.push(`${recipient.email} (property ${propDoc.id}): ${err.message}`);
            }
          }

          updatedEvents[i].lastSentYears[leadKey] = cycle.year;
          eventsChanged = true;
          remindersSent++;
        }
      }

      if (eventsChanged) {
        try {
          await propDoc.ref.update({ annualEvents: updatedEvents });
        } catch (err) {
          console.error(`send-annual-event-reminders: failed to update lastSentYears for property ${propDoc.id}:`, err.message);
          errors++;
          errorMessages.push(`update lastSentYears for property ${propDoc.id}: ${err.message}`);
        }
      }
    }

    console.log(`send-annual-event-reminders: ${remindersSent} reminder(s) triggered, ${recipientsNotified} recipient(s) notified, ${errors} error(s).`);
    await notifyAdminOnFailure({ functionName: 'send-annual-event-reminders', errorCount: errors, sampleErrors: errorMessages });
    return { statusCode: 200, body: JSON.stringify({ remindersSent, recipientsNotified, errors }) };

  } catch (err) {
    console.error('send-annual-event-reminders error:', err);
    await notifyAdminOnFailure({ functionName: 'send-annual-event-reminders', fatalError: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
