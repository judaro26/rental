// netlify/functions/get-owner-dashboard.js
// Returns everything the logged-in owner-portal user is allowed to see,
// computed server-side with the Admin SDK so the client never needs its
// own Firestore read access at all — the entire security boundary for
// this feature lives in this one function, not in Firestore rules (this
// repo's actual live rules aren't visible from here, so rather than guess
// at a boundary I can't verify, access is mediated entirely through
// authenticated server code, the same pattern already used for every
// other sensitive action in this app).
//
// Privacy boundary, deliberately conservative: the caller sees their own
// transactions in full detail (date, category, description, amount,
// receipt), but only aggregate totals for every other owner on the same
// property — never another owner's individual line items. The spending
// breakdown and reconciliation math the owner sees is otherwise identical
// to what the admin sees in admin.html, using the same calculation this
// was verified against.
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT

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

function computeBreakdown(propExpenses, owners) {
  const currencies = [...new Set(propExpenses.map(e => e.currency || 'USD'))];
  if (currencies.length > 1) return { mixedCurrency: true };
  const cur = currencies[0] || 'USD';
  const grandTotal = propExpenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const spentByOwner = {};
  for (const e of propExpenses) {
    const key = e.paidByOwner || '(Unspecified)';
    spentByOwner[key] = (spentByOwner[key] || 0) + parseFloat(e.amount || 0);
  }
  const rows = Object.entries(spentByOwner).map(([name, spent]) => {
    const ownerRecord = owners.find(o => o.name === name);
    const pct = grandTotal ? (spent / grandTotal) * 100 : 0;
    const fairShare = ownerRecord ? (grandTotal * ownerRecord.percentage) / 100 : null;
    const delta = fairShare != null ? spent - fairShare : null;
    return { name, spent, pct, ownershipPct: ownerRecord?.percentage ?? null, delta };
  }).sort((a, b) => b.spent - a.spent);
  return { currency: cur, grandTotal, rows };
}

function computeCatchup(propExpenses, agreement) {
  if (!agreement?.enabled) return null;
  const otherOwnerNames = [...new Set(propExpenses.map(f => f.paidByOwner).filter(n => n && n !== agreement.catchingUpOwnerName))];
  const targets = otherOwnerNames.map(name => {
    const total = propExpenses
      .filter(f => f.paidByOwner === name && String(f.date || '').startsWith(String(agreement.targetYear)))
      .reduce((s, f) => s + parseFloat(f.amount || 0), 0);
    return { name, total };
  }).filter(t => t.total > 0);
  if (!targets.length) return { catchingUpOwnerName: agreement.catchingUpOwnerName, targetYear: agreement.targetYear, progress: 0, targets: [] };
  const progress = propExpenses
    .filter(f => f.paidByOwner === agreement.catchingUpOwnerName)
    .reduce((s, f) => s + parseFloat(f.amount || 0), 0);
  return { catchingUpOwnerName: agreement.catchingUpOwnerName, targetYear: agreement.targetYear, note: agreement.note || '', progress, targets };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const a = getAdmin();
  const db = a.firestore();

  const { verifyOwner } = require('./_lib/verify-owner');
  const authResult = await verifyOwner(event, db, a);
  if (authResult.error) return authResult.error;
  const { ownerData } = authResult;

  const linkedProperties = ownerData.linkedProperties || [];
  if (!linkedProperties.length) {
    return { statusCode: 200, body: JSON.stringify({ name: ownerData.name, properties: [] }) };
  }

  try {
    const propertyIds = linkedProperties.map(l => l.propertyId);
    // Single-field queries only, matching this app's existing pattern of
    // avoiding composite-index requirements — fetched once per unique
    // property, not per linked-property entry, in case of duplicates.
    const uniquePropertyIds = [...new Set(propertyIds)];
    const propSnaps = await Promise.all(uniquePropertyIds.map(id => db.collection('properties').doc(id).get()));
    const propsById = {};
    propSnaps.forEach(snap => { if (snap.exists) propsById[snap.id] = snap.data(); });

    const results = [];
    for (const link of linkedProperties) {
      const prop = propsById[link.propertyId];
      if (!prop) continue; // property was deleted since this link was created
      const owners = Array.isArray(prop.owners) ? prop.owners : [];

      const finSnap = await db.collection('financials').where('propertyId', '==', link.propertyId).get();
      const allFinancials = finSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const expenses = allFinancials.filter(f => f.type === 'expense');
      const income = allFinancials.filter(f => f.type === 'income');

      const breakdown = computeBreakdown(expenses, owners);
      const catchup = computeCatchup(expenses, prop.catchUpAgreement);

      const incomeByCurrency = {};
      for (const i of income) { const cur = i.currency || 'USD'; incomeByCurrency[cur] = (incomeByCurrency[cur] || 0) + parseFloat(i.amount || 0); }

      // Same total, broken out per year and currency — needed for the
      // owner-portal year-end summary feature. The year the owner wants
      // isn't known at request time (this endpoint doesn't take a year
      // parameter), so this returns every year present rather than one
      // pre-filtered figure, and the client picks which year to display.
      const incomeByYear = {};
      for (const i of income) {
        const year = String(i.date || '').slice(0, 4);
        if (!year) continue;
        const cur = i.currency || 'USD';
        incomeByYear[year] = incomeByYear[year] || {};
        incomeByYear[year][cur] = (incomeByYear[year][cur] || 0) + parseFloat(i.amount || 0);
      }

      // Full detail only for the caller's own transactions — this is the
      // actual privacy boundary described at the top of this file.
      const myTransactions = expenses
        .filter(f => f.paidByOwner === link.ownerName)
        .map(f => ({ date: f.date, category: f.category, description: f.description || '', amount: f.amount, currency: f.currency || 'USD', receiptUrl: f.receiptUrl || null }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      results.push({
        propertyId: link.propertyId,
        propertyName: prop.name || link.propertyName || '',
        address: prop.address || '',
        myOwnerName: link.ownerName,
        owners: owners.map(o => ({ name: o.name, percentage: o.percentage })),
        incomeByCurrency,
        incomeByYear,
        breakdown,
        catchup,
        myTransactions,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ name: ownerData.name, properties: results }) };
  } catch (err) {
    console.error('get-owner-dashboard error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
