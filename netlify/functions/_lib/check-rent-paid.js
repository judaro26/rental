// netlify/functions/_lib/check-rent-paid.js
// Checks whether a tenant has already covered rent for a given billing
// cycle, so invoice generation (both the scheduled automatic sweep and the
// admin-triggered ad-hoc "Generate Now") can skip sending a redundant
// invoice for rent that's already been paid — e.g. a tenant who pays a
// few days early, before the scheduled generate-window even fires.
//
// Checks two independent signals, either of which is sufficient:
//   - a PAID payment record (payments collection) for this tenant, with
//     an amount close to the rent amount, dated within the cycle window —
//     covers tenants who pay directly (Zelle, Cash App, Bold, manual
//     recording) without an invoice ever having been sent first.
//   - a PAID invoice (invoices collection) for this tenant whose due date
//     falls within the cycle window — covers the case where an invoice
//     (manual or automated) already existed and was paid.
//
// Both queries filter on tenantId only (a single equality filter, no
// composite-index question) and check everything else in memory — the
// same reasoning as elsewhere in this codebase: tenant-scoped collections
// are small enough that this costs nothing real, and it avoids any
// uncertainty about Firestore index behavior on a check this consequential.

async function hasQualifyingPayment(db, tenantId, monthlyRent, cycleStartMs, cycleEndMs) {
  const threshold = Number(monthlyRent) * 0.95; // allow for small processor-fee rounding differences
  const paymentsSnap = await db.collection('payments').where('tenantId', '==', tenantId).get();
  return paymentsSnap.docs.some(doc => {
    const p = doc.data();
    if (p.status !== 'paid') return false;
    if (Number(p.amount || 0) < threshold) return false;
    const paidMs = p.createdAt?.toDate ? p.createdAt.toDate().getTime() : (p.manualDate ? new Date(p.manualDate).getTime() : null);
    if (paidMs == null || isNaN(paidMs)) return false;
    return paidMs >= cycleStartMs && paidMs <= cycleEndMs;
  });
}

async function hasAlreadyPaidInvoice(db, tenantId, cycleStartMs, cycleEndMs) {
  const invoicesSnap = await db.collection('invoices').where('tenantId', '==', tenantId).get();
  return invoicesSnap.docs.some(doc => {
    const inv = doc.data();
    if (inv.type !== 'invoice' || inv.status !== 'paid') return false;
    if (!inv.dueDate) return false;
    // dueDate may be 'YYYY-MM-DD' (manual creation) or a toLocaleDateString
    // string like 'September 1, 2026' (automated creation) — both parse
    // reliably via the Date constructor.
    const dueMs = new Date(inv.dueDate).getTime();
    if (isNaN(dueMs)) return false;
    return dueMs >= cycleStartMs && dueMs <= cycleEndMs;
  });
}

// cycleStartMs/cycleEndMs define the window rent for this cycle could
// reasonably have been paid in — typically the previous due date through
// the upcoming one, since tenants often pay a few days to weeks early.
async function isRentAlreadyCoveredForCycle({ db, tenantId, monthlyRent, cycleStartMs, cycleEndMs }) {
  const [byPayment, byInvoice] = await Promise.all([
    hasQualifyingPayment(db, tenantId, monthlyRent, cycleStartMs, cycleEndMs),
    hasAlreadyPaidInvoice(db, tenantId, cycleStartMs, cycleEndMs),
  ]);
  return byPayment || byInvoice;
}

module.exports = { isRentAlreadyCoveredForCycle };
