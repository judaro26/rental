// netlify/functions/send-auto-invoices.js
// Scheduled (daily) function that automatically generates and sends a real
// rent invoice for each tenant with automatic invoicing enabled, ahead of
// their own configured due date — a genuine invoice through the same
// creation path a manually-created one uses (_lib/create-invoice.js), not
// just a reminder email about a date.
//
// Distinct from send-property-reminders.js, which only reminds about a
// due date without creating anything, and from send-invoice-reminders.js,
// which reminds about invoices that already exist.
//
// Per-tenant fields (tenants/{id}), configured in admin.html's tenant
// edit modal:
//   rentDueDay: 1–28
//   autoInvoiceEnabled: true — explicit opt-in; absent/false means off,
//     so this can never start invoicing an existing tenant who simply has
//     a monthlyRent set but was never specifically enabled for this.
//   autoInvoiceLeadDays: 0–27 (days before the due date to generate+send)
//   autoInvoiceLastPeriod: 'YYYY-MM' — tracks which month's invoice was
//     last auto-generated, to avoid duplicates if this runs more than once
//     on the matching day.
//
// The Firestore query here deliberately filters on a single field
// (status) and checks autoInvoiceEnabled/rentDueDay in memory afterward,
// rather than a two-field composite query — the same reasoning as the
// integrationSecrets design: composite-query index behavior isn't
// something to guess at for a collection this consequential, and tenant
// counts are small enough that filtering in memory costs nothing real.
//
// The schedule is declared in netlify.toml ([functions."send-auto-invoices"]).
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, SITE_URL, NETLIFY_SITE_ID
// (or SITE_ID), NETLIFY_API_TOKEN (email creds come from the existing
// integration-override system, falling back to SMTP_* if not configured).

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
  const { findMatchingCycle, computeCycle, utcMidnightToday } = require('./_lib/reminder-cycle');
  const { createInvoice } = require('./_lib/create-invoice');
  const { isRentAlreadyCoveredForCycle } = require('./_lib/check-rent-paid');
  const { notifyAdminOnFailure } = require('./_lib/notify-admin-on-failure');

  const a = getAdmin();
  const db = a.firestore();

  if (!process.env.SMTP_HOST) {
    console.warn('send-auto-invoices: no email configuration available (no custom provider, no SMTP_HOST env var) — skipping this run.');
    return { statusCode: 200, body: 'No email configuration available.' };
  }

  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  let siteName = 'Tenant Portal';
  try {
    const settingsSnap = await db.collection('settings').doc('site').get();
    if (settingsSnap.exists) siteName = settingsSnap.data().siteName || siteName;
  } catch (err) {
    console.warn('send-auto-invoices: could not load site settings, using default name:', err.message);
  }

  const todayMs = utcMidnightToday();
  let invoicesGenerated = 0, errors = 0;
  const errorMessages = [];

  try {
    const tenantsSnap = await db.collection('tenants').where('status', '==', 'active').get();

    for (const tenantDoc of tenantsSnap.docs) {
      const tenant = tenantDoc.data();
      if (tenant.autoInvoiceEnabled !== true) continue; // explicit opt-in only
      if (!tenant.rentDueDay || !tenant.monthlyRent || !tenant.email) continue;

      const rule = { dayOfMonth: tenant.rentDueDay, leadDays: tenant.autoInvoiceLeadDays || 0 };
      const cycle = findMatchingCycle(rule, todayMs);
      if (!cycle) continue; // not this tenant's day
      if (tenant.autoInvoiceLastPeriod === cycle.period) continue; // already generated this cycle

      // Skip if rent for this cycle already appears covered — e.g. the
      // tenant paid a few days early, before this scheduled window even
      // fired. Window is the previous due date through the upcoming one.
      const upcomingDue = new Date(cycle.dueMs);
      const prevCycle = computeCycle(tenant.rentDueDay, 0, upcomingDue.getUTCFullYear(), upcomingDue.getUTCMonth() - 1);
      const rentCovered = await isRentAlreadyCoveredForCycle({
        db, tenantId: tenantDoc.id, monthlyRent: tenant.monthlyRent,
        cycleStartMs: prevCycle.dueMs, cycleEndMs: cycle.dueMs,
      });
      if (rentCovered) {
        await tenantDoc.ref.update({ autoInvoiceLastPeriod: cycle.period });
        continue;
      }

      const dueDateLabel = new Date(cycle.dueMs).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      const tenantName = `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || 'Tenant';

      try {
        await createInvoice({
          a, db, siteUrl, siteName,
          type: 'invoice',
          tenantId: tenantDoc.id,
          tenantName,
          tenantEmail: tenant.email,
          unit: tenant.unit || '',
          propertyId: tenant.propertyId || null,
          propertyName: tenant.propertyName || '',
          lineItems: [{ description: 'Monthly Rent', quantity: 1, unitPrice: tenant.monthlyRent, amount: tenant.monthlyRent }],
          dueDate: dueDateLabel,
          sendNow: true,
        });
        await tenantDoc.ref.update({ autoInvoiceLastPeriod: cycle.period });
        invoicesGenerated++;
      } catch (err) {
        console.error(`send-auto-invoices: failed for tenant ${tenantDoc.id}:`, err.message);
        errors++;
        errorMessages.push(`tenant ${tenantDoc.id} (${tenant.email}): ${err.message}`);
      }
    }

    console.log(`send-auto-invoices: ${invoicesGenerated} invoice(s) generated, ${errors} error(s).`);
    await notifyAdminOnFailure({ functionName: 'send-auto-invoices', errorCount: errors, sampleErrors: errorMessages });
    return { statusCode: 200, body: JSON.stringify({ invoicesGenerated, errors }) };

  } catch (err) {
    console.error('send-auto-invoices error:', err);
    await notifyAdminOnFailure({ functionName: 'send-auto-invoices', fatalError: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
