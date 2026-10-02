#!/usr/bin/env node
// scripts/test-payment-info.js
// "How to pay" on invoices: rendering and escaping, the live invoice page (current payment
// details, PAID status), the invoice email, and the QR endpoint.
// Usage: node scripts/test-payment-info.js   (or: npm test)

const Module = require('module');
let emails = [];
const blobs = {};            // netlify blobs: key -> {data, metadata}
let dbBroken = false;
const origLoad = Module._load;

// ---- fake Firestore (supports doc get/set/update/delete/add, where().limit().get(), serialized transactions)
function makeDb(seed = {}) {
  const store = JSON.parse(JSON.stringify(seed)); let lock = Promise.resolve(); let auto = 0;
  const col = n => (store[n] = store[n] || {});
  const docRef = (n, id) => ({ id,
    get: async () => { if (dbBroken) throw new Error('firestore unavailable'); return { exists: id in col(n), data: () => col(n)[id] }; },
    set: async (d, o) => { col(n)[id] = o && o.merge ? { ...(col(n)[id]||{}), ...d } : d; },
    update: async d => { col(n)[id] = { ...(col(n)[id]||{}), ...d }; },
    delete: async () => { delete col(n)[id]; } });
  return { _store: store,
    collection: n => ({ doc: id => docRef(n, id), add: async d => { const id = 'auto' + (++auto); col(n)[id] = d; return { id }; },
      where: (f, op, v) => ({ limit: () => ({ get: async () => { if (dbBroken) throw new Error('firestore unavailable');
        const docs = Object.entries(col(n)).filter(([, d]) => d[f] === v).map(([id, d]) => ({ id, data: () => d })); return { empty: !docs.length, docs }; } }) }) }),
    runTransaction: fn => { const run = lock.then(async () => { const w = []; const out = await fn({ get: r => r.get(), set: (r, d) => w.push([r, d]) }); for (const [r, d] of w) await r.set(d); return out; }); lock = run.catch(() => {}); return run; } };
}
let DB = makeDb();
Module._load = function (req, ...rest) {
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async m => { emails.push(m); } }) };
  if (req === '@netlify/blobs') return { getStore: () => ({ set: async (k, buf, o) => { blobs[k] = { data: buf, metadata: o && o.metadata }; },
      getWithMetadata: async k => blobs[k] ? { data: blobs[k].data, metadata: blobs[k].metadata } : null }) };
  if (req === 'firebase-admin') return { apps: [1], firestore: () => DB, credential: { cert: () => ({}) } };
  return origLoad.call(this, req, ...rest);
};
process.env.NETLIFY_SITE_ID = 'x'; process.env.NETLIFY_API_TOKEN = 'y'; process.env.SMTP_HOST = 'h'; process.env.SMTP_USER = 'u';
process.env.FIREBASE_SERVICE_ACCOUNT = '{}';

const path = require('path');
const R = path.resolve(__dirname, '../netlify/functions') + '/';
const PI = require(R + '_lib/payment-info');
const CIraw = require(R + '_lib/create-invoice');
const WS = require(R + '_lib/workspace');
// createInvoice needs a workspace context, exactly as it has inside a real handler.
const CI = { ...CIraw, createInvoice: args => WS.runWithWorkspace(WS._testing.defaultWorkspace(), () => CIraw.createInvoice(args)) };
const view = require(R + 'view-invoice').handler;
const viewQr = require(R + 'view-qr').handler;
let failed = 0; const check = (n, c, x = '') => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n + (x ? '  ' + x : '')); if (!c) failed++; };

const SITE = { zelleName: 'Juan Landlord', zelleEmail: 'pay@landlord.com', zellePhone: '555-0100', zelleNote: 'Use the unit # as memo', zelleQrUploaded: true,
               cashappTag: '$landlord', cashappName: 'Juan L', cashappQrUploaded: false };
const PROP = { paymentMethods: [{ id: 'pm_1', label: 'Venmo', instructions: '@landlord-venmo\nNo goods & services', enabled: true },
                                { id: 'pm_2', label: 'Wire', instructions: 'hidden', enabled: false }],
               preferredPaymentMethod: 'pm_1', boldPaymentsEnabled: true };
const seed = () => ({ settings: { site: SITE }, properties: { p1: PROP }, invoices: {}, receiptClaims: {} });

(async () => {
  // ---------- renderers ----------
  DB = makeDb(seed()); let info = await PI.getPaymentInfo(DB, 'p1');
  check('entries: preferred (Venmo) first, disabled "Wire" omitted, Zelle/Cash App/online present',
    info.entries.map(e => e.id).join(',') === 'pm_1,zelle,cashapp,bold' && info.entries[0].preferred === true, info.entries.map(e => e.id).join(','));
  let html = PI.renderPaymentSectionHtml(info, { invoiceNumber: 'INV-2026-0007' });
  check('page block shows Zelle email, Venmo text, PREFERRED badge, invoice # reference, pay-online link',
    html.includes('pay@landlord.com') && html.includes('@landlord-venmo') && html.includes('PREFERRED') && html.includes('INV-2026-0007') && html.includes('/tenant-portal'));
  check('QR only where uploaded (Zelle yes, Cash App no)', html.includes('method=zelle') && !html.includes('method=cashapp'));
  const evil = { entries: [{ id: 'x', kind: 'manual', label: '<img src=x onerror=alert(1)>', rows: [['Name', '"><script>alert(1)</script>']], text: "'; DROP", note: '<b>', qr: null }] };
  const eh = PI.renderPaymentSectionHtml(evil, {});
  check('admin-entered text is HTML-escaped (no live <script>/<img onerror>)', !/<script>|<img src=x/i.test(eh) && eh.includes('&lt;script&gt;'));
  check('no methods configured -> empty (nothing rendered)', PI.renderPaymentSectionHtml({ entries: [] }) === '' && PI.renderPaymentEmailBlock({ entries: [] }) === '');
  DB = makeDb({ settings: { site: SITE }, properties: { p2: { preferredPaymentMethod: 'gone' } } });
  info = await PI.getPaymentInfo(DB, 'p2');
  check('preferred points at a missing method -> no crash, nothing marked preferred', info.entries.length === 2 && !info.entries.some(e => e.preferred));
  DB = makeDb({ settings: { site: SITE } });
  info = await PI.getPaymentInfo(DB, null);
  check('no property -> still shows global Zelle/Cash App', info.entries.length === 2);

  // ---------- invoice page markers ----------
  const common = { invoiceNumber: 'INV-2026-0007', date: 'Oct 1', dueDate: 'Nov 1', siteName: 'S', siteUrl: 'https://x', tenantName: 'K', tenantEmail: 'k@x.com',
                   unit: '1', propertyName: 'P', lineItems: [{ description: 'Rent', quantity: 1, unitPrice: 10, amount: 10 }], subtotal: 10, taxRate: 0, taxAmount: 0, total: 10, notes: '' };
  const inv = CI.buildHtml({ ...common, type: 'invoice', isPaid: false });
  const rec = CI.buildHtml({ ...common, type: 'receipt', isPaid: true });
  check('new invoice carries PAY/STAMP/STATUS markers and PENDING pill', ['<!--RB:PAY-->', '<!--RB:STAMP-->', '<!--RB:STATUS-->', '<!--/RB:STATUS-->'].every(m => inv.includes(m)) && inv.includes('PENDING'));
  check('receipt has NO markers and is stamped PAID', !/RB:/.test(rec) && rec.includes('PAID'));

  // ---------- live view ----------
  async function createAndView(status, extra = {}) {
    DB = makeDb(seed()); emails = [];
    const r = await CI.createInvoice({ a: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }, db: DB, siteUrl: 'https://x.test', siteName: 'Site', type: 'invoice',
      tenantId: 't1', tenantName: 'Kelcie', tenantEmail: 'k@x.com', propertyId: 'p1', lineItems: [{ description: 'Rent', quantity: 1, unitPrice: 2475, amount: 2475 }], dueDate: 'November 1, 2026', sendNow: true });
    const id = Object.keys(DB._store.invoices)[0];
    if (status) DB._store.invoices[id].status = status;
    const key = DB._store.invoices[id].blobKey;
    const res = await view({ httpMethod: 'GET', queryStringParameters: { key } });
    return { r, res, key, id };
  }
  let t = await createAndView(null);
  check('pending invoice view: shows "How to pay" with live Zelle details, still PENDING, markers gone, no-store',
    t.res.statusCode === 200 && t.res.body.includes('How to pay') && t.res.body.includes('pay@landlord.com') && t.res.body.includes('PENDING') && !/RB:/.test(t.res.body) && t.res.headers['Cache-Control'] === 'private, no-store');
  // admin changes Zelle later -> same old invoice shows the NEW account
  DB._store.settings.site.zelleEmail = 'new-account@landlord.com';
  t.res = await view({ httpMethod: 'GET', queryStringParameters: { key: t.key } });
  check('changing the Zelle account later updates already-sent invoices (no stale/dead account)', t.res.body.includes('new-account@landlord.com') && !t.res.body.includes('pay@landlord.com'));

  t = await createAndView('paid');
  check('paid invoice view: pill + stamp say PAID, payment instructions removed', t.res.body.includes('PAID') && !t.res.body.includes('PENDING') && !t.res.body.includes('How to pay') && t.res.body.includes('rotate(15deg)') && !/RB:/.test(t.res.body));

  // legacy blob (no markers) is served untouched with old caching
  const legacy = '<html><body>OLD INVOICE PENDING</body></html>';
  blobs['legacy.html'] = { data: Buffer.from(legacy), metadata: {} };
  let lr = await view({ httpMethod: 'GET', queryStringParameters: { key: 'legacy.html' } });
  check('legacy invoice (no markers) served byte-for-byte, original cache header', lr.body === legacy && lr.headers['Cache-Control'] === 'private, max-age=3600');

  // Firestore down: invoice must still open
  t = await createAndView(null); dbBroken = true;
  lr = await view({ httpMethod: 'GET', queryStringParameters: { key: t.key } }); dbBroken = false;
  check('Firestore outage: invoice still opens (200), markers stripped, no payment block', lr.statusCode === 200 && !/RB:/.test(lr.body) && !lr.body.includes('How to pay') && lr.body.includes('INV-'));
  // blob without a Firestore record
  blobs['orphan.html'] = { data: Buffer.from(inv), metadata: {} };
  DB = makeDb(seed());
  lr = await view({ httpMethod: 'GET', queryStringParameters: { key: 'orphan.html' } });
  check('invoice blob with no matching record: served as created, markers stripped', lr.statusCode === 200 && !/RB:/.test(lr.body) && lr.body.includes('PENDING'));

  // ---------- email ----------
  t = await createAndView(null);
  check('invoice email includes compact "How to pay" (Zelle + Venmo + online link)', emails.length === 1 && emails[0].html.includes('How to pay') && emails[0].html.includes('pay@landlord.com') && emails[0].html.includes('Venmo') && emails[0].html.includes('https://x.test/tenant-portal'));
  DB = makeDb(seed()); emails = [];
  await CI.createInvoice({ a: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }, db: DB, siteUrl: 'https://x.test', siteName: 'S', type: 'receipt', paymentId: 'pz', tenantId: 't1', tenantName: 'K', tenantEmail: 'k@x.com', propertyId: 'p1',
    lineItems: [{ description: 'Rent', quantity: 1, unitPrice: 10, amount: 10 }], paidDate: 'Oct 1' });
  check('receipt email has NO payment block', emails.length === 1 && !emails[0].html.includes('How to pay'));
  DB = makeDb(seed()); emails = [];
  dbBroken = false;
  const brokenDb = makeDb(seed()); const realGet = brokenDb.collection;
  brokenDb.collection = n => { const c = realGet(n); return { ...c, doc: id => (n === 'properties' || (n === 'settings' && id === 'site')) ? { get: async () => { throw new Error('read denied'); } } : c.doc(id) }; };
  await CI.createInvoice({ a: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }, db: brokenDb, siteUrl: 'https://x.test', siteName: 'S', type: 'invoice', tenantId: 't1', tenantName: 'K', tenantEmail: 'k@x.com', propertyId: 'p1',
    lineItems: [{ description: 'Rent', quantity: 1, unitPrice: 10, amount: 10 }], dueDate: 'Nov 1', sendNow: true });
  check('payment info unreadable -> invoice email STILL sends (just without the block)', emails.length === 1 && !emails[0].html.includes('How to pay'));

  // ---------- view-qr ----------
  blobs['zelle-qr'] = { data: Buffer.from('ZQR'), metadata: { contentType: 'image/png' } };
  blobs['cashapp-qr'] = { data: Buffer.from('CQR'), metadata: { contentType: 'image/png' } };
  blobs['secret'] = { data: Buffer.from('SECRET'), metadata: {} };
  const q = async m => Buffer.from((await viewQr({ httpMethod: 'GET', queryStringParameters: m })).body, 'base64').toString();
  check('view-qr: method=cashapp serves the Cash App QR (was serving Zelle)', await q({ method: 'cashapp' }) === 'CQR');
  check('view-qr: default and method=zelle serve Zelle', (await q({})) === 'ZQR' && (await q({ method: 'zelle' })) === 'ZQR');
  check('view-qr: unknown / injected method falls back to Zelle (cannot select arbitrary blobs)', (await q({ method: '../secret' })) === 'ZQR' && (await q({ method: 'secret' })) === 'ZQR');

  process.exit(failed ? 1 : 0);
})();
