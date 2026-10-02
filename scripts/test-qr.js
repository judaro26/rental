#!/usr/bin/env node
// scripts/test-qr.js
//
// The Zelle / Cash App QR code round trip, through the REAL upload-qr and view-qr handlers, called exactly
// the way the admin page calls them: the QR type travels in the URL (`/api/upload-qr?method=cashapp`) and
// the form body carries only the file.
//
// Regression: upload-qr used to read the type only from a hidden form field the page never sends, so it
// silently fell back to "zelle" — every upload, including Cash App, was saved over the Zelle QR, and the
// Cash App image 404'd once view-qr started honouring ?method=.
//
// Usage: node scripts/test-qr.js   (or: npm test)

const Module = require('module');
const path = require('path');

// ── fakes: Blobs (named stores), Firestore (admin records), Auth (default pool + tenants) ──────────
const stores = new Map();   // store name -> Map(key -> { data, metadata })
const storeFor = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
const ADMINS = { default: new Set(['admin-default']), 'ws-acme': new Set(['admin-acme']) };
const SESSION = { uid: null, tenant: null };
const fakeDb = id => ({ collection: c => ({ doc: uid => ({ get: async () => { const ok = c === 'admins' && (ADMINS[id] || new Set()).has(uid); return { exists: ok, data: () => ({ role: 'super_admin' }) }; } }) }) });
const authFor = tenantId => ({
  verifyIdToken: async () => {
    if (!SESSION.uid) { const e = new Error('invalid'); e.code = 'auth/argument-error'; throw e; }
    const d = { uid: SESSION.uid, firebase: { sign_in_provider: 'password', ...(SESSION.tenant ? { tenant: SESSION.tenant } : {}) } };
    if (tenantId && d.firebase.tenant !== tenantId) { const e = new Error('mismatch'); e.code = 'auth/mismatching-tenant-id'; throw e; }
    return d;
  },
});
const fakeAdmin = {
  apps: [{}], initializeApp() {}, credential: { cert: () => ({}) }, app: () => ({}),
  firestore: Object.assign(() => fakeDb('default'), { FieldValue: { serverTimestamp: () => 'TS' } }),
  auth: () => Object.assign(authFor(null), { tenantManager: () => ({ authForTenant: id => authFor(id) }) }),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'firebase-admin') return fakeAdmin;
  if (req === 'firebase-admin/firestore') return { getFirestore: (_a, id) => fakeDb(id) };
  if (req === '@netlify/blobs') return { getStore: o => { const m = storeFor(o.name); return {
    set: async (k, data, opts) => { m.set(k, { data: Buffer.from(data), metadata: (opts && opts.metadata) || {} }); },
    getWithMetadata: async k => { const v = m.get(k); return v ? { data: v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.length), metadata: v.metadata } : null; },
  }; } };
  return origLoad.call(this, req, ...rest);
};
Object.assign(process.env, { NETLIFY_SITE_ID: 'site', NETLIFY_API_TOKEN: 'tok', FIREBASE_SERVICE_ACCOUNT: '{}', SITE_URL: 'https://rentbay.netlify.app' });
delete process.env.ALLOW_MULTI_WORKSPACE;

const FN = path.resolve(__dirname, '../netlify/functions');
const W = require(path.join(FN, '_lib/workspace'));
const upload = require(path.join(FN, 'upload-qr')).handler;
const view = require(path.join(FN, 'view-qr')).handler;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}

// a real multipart/form-data body, as a browser's FormData would send it
function multipart({ file, fields = {} }) {
  const boundary = '----qrtest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), Buffer.from(file.bytes), Buffer.from('\r\n')]));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts).toString('base64'), contentType: `multipart/form-data; boundary=${boundary}` };
}
const PNG = tag => ({ name: `${tag}.png`, type: 'image/png', bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`-${tag}-`)]) });
async function up({ method, fields, file = PNG('x'), host = 'rentbay.netlify.app', uid = 'admin-default', tenant = null, noFile = false } = {}) {
  const m = multipart({ file: noFile ? null : file, fields });
  SESSION.uid = uid; SESSION.tenant = tenant;
  const r = await upload({ httpMethod: 'POST', headers: { host, authorization: 'Bearer t', 'content-type': m.contentType }, isBase64Encoded: true, body: m.body, queryStringParameters: method === undefined ? {} : { method } });
  SESSION.uid = null; SESSION.tenant = null;
  return r;
}
const see = async (method, host = 'rentbay.netlify.app') => view({ httpMethod: 'GET', headers: { host }, queryStringParameters: method === undefined ? {} : { method } });
const bytesOf = r => Buffer.from(r.body, 'base64').toString();
const reset = () => stores.clear();

(async () => {
  // ── the reported bug ─────────────────────────────────────────────────────
  {
    reset();
    const r = await up({ method: 'cashapp', file: PNG('CASHAPP') });
    check('uploading the Cash App QR (type in the URL, only the file in the form — as the admin page does) succeeds', r.statusCode === 200, r.body);
    check('...and it is stored as "cashapp-qr", NOT "zelle-qr"', JSON.parse(r.body).key === 'cashapp-qr' && storeFor('settings').has('cashapp-qr') && !storeFor('settings').has('zelle-qr'), JSON.stringify([...storeFor('settings').keys()]));
    const v = await see('cashapp');
    check('...so view-qr?method=cashapp serves it (200) instead of a 404', v.statusCode === 200 && bytesOf(v).includes('CASHAPP'), `${v.statusCode} ${v.body}`);
  }

  // ── the two QR codes never overwrite each other ──────────────────────────
  {
    reset();
    await up({ method: 'zelle', file: PNG('ZELLE') });
    await up({ method: 'cashapp', file: PNG('CASHAPP') });
    const z = await see('zelle'), c = await see('cashapp');
    check('uploading Cash App does NOT overwrite the Zelle QR: each serves its own image', bytesOf(z).includes('ZELLE') && !bytesOf(z).includes('CASHAPP') && bytesOf(c).includes('CASHAPP') && !bytesOf(c).includes('ZELLE'));
    await up({ method: 'zelle', file: PNG('ZELLE2') });
    check('...and re-uploading Zelle leaves the Cash App QR alone', bytesOf(await see('cashapp')).includes('CASHAPP') && bytesOf(await see('zelle')).includes('ZELLE2'));
    check('the content type travels with the image', z.headers['Content-Type'] === 'image/png');
    const cc = String(z.headers['Cache-Control'] || '');
    check('the QR is NEVER shared-cached or held for a day: Cache-Control is private + no-cache (a corrected QR must show at once, not after 24 h)', /private/.test(cc) && /no-cache/.test(cc) && !/public/.test(cc) && !/max-age=[1-9]/.test(cc) && !/s-maxage/.test(cc), cc);
    check('...for BOTH QR codes, so one cannot be served for the other from a shared cache entry', String(c.headers['Cache-Control'] || '') === cc);
  }

  // ── other ways of naming the type ────────────────────────────────────────
  {
    reset();
    const viaField = await up({ method: undefined, fields: { method: 'cashapp' }, file: PNG('FIELD') });
    check('the type is still accepted as a form field (the original contract), so nothing that used it breaks', viaField.statusCode === 200 && JSON.parse(viaField.body).key === 'cashapp-qr');
    reset();
    const both = await up({ method: 'cashapp', fields: { method: 'zelle' }, file: PNG('BOTH') });
    check('if both are given, the URL wins (it is what the page sends)', both.statusCode === 200 && JSON.parse(both.body).key === 'cashapp-qr');
  }

  // ── no more silent default ───────────────────────────────────────────────
  {
    reset();
    const none = await up({ method: undefined });
    check('an upload that does not say which QR it is gets a 400 — it is never silently stored as Zelle', none.statusCode === 400 && /method/i.test(none.body) && storeFor('settings').size === 0, none.body);
    for (const bad of ['paypal', 'zelle-qr', '../etc/passwd', 'CASHAPP', '', 'cashapp ']) {
      const r = await up({ method: bad });
      check(`an unknown type ("${bad}") is refused with 400 and stores nothing`, r.statusCode === 400 && storeFor('settings').size === 0, `${r.statusCode} ${r.body}`);
    }
  }

  // ── only real images ─────────────────────────────────────────────────────
  {
    reset();
    for (const [type, name] of [['image/png', 'a.png'], ['image/jpeg', 'a.jpg'], ['image/webp', 'a.webp']]) {
      const r = await up({ method: 'zelle', file: { name, type, bytes: Buffer.from('IMG') } });
      check(`${type} is accepted (the page's file picker offers PNG, JPEG and WebP)`, r.statusCode === 200, r.body);
    }
    reset();
    for (const [type, name] of [['image/svg+xml', 'a.svg'], ['text/html', 'a.html'], ['application/pdf', 'a.pdf'], ['application/octet-stream', 'a.bin'], ['text/javascript', 'a.js']]) {
      const r = await up({ method: 'zelle', file: { name, type, bytes: Buffer.from('<script>alert(1)</script>') } });
      check(`${type} is refused (400) — this endpoint serves the image back from your own domain, so it must be a plain image`, r.statusCode === 400 && /PNG|JPEG|WebP/i.test(r.body) && storeFor('settings').size === 0, `${r.statusCode} ${r.body}`);
    }
    const empty = await up({ method: 'zelle', noFile: true });
    check('no file at all is a 400', empty.statusCode === 400 && /No file/i.test(empty.body));
    const zero = await up({ method: 'zelle', file: { name: 'e.png', type: 'image/png', bytes: Buffer.alloc(0) } });
    check('an empty file is a 400', zero.statusCode === 400);
  }

  // ── who may upload ───────────────────────────────────────────────────────
  {
    reset();
    const anon = await up({ method: 'zelle', uid: null });
    const tenant = await up({ method: 'zelle', uid: 'some-tenant' });
    check('no session is refused (401) and a signed-in non-admin is refused (403); nothing is stored', anon.statusCode === 401 && tenant.statusCode === 403 && storeFor('settings').size === 0, `${anon.statusCode} ${tenant.statusCode}`);
  }

  // ── viewing ──────────────────────────────────────────────────────────────
  {
    reset();
    check('a QR that was never uploaded is a 404 (the portal hides the image)', (await see('cashapp')).statusCode === 404 && (await see('zelle')).statusCode === 404);
    await up({ method: 'zelle', file: PNG('Z') });
    check('view-qr with no or an unknown type serves the Zelle QR (unchanged)', bytesOf(await see(undefined)).includes('Z') && bytesOf(await see('anything')).includes('Z'));
  }

  // ── another client's QR codes stay in that client's own stores ───────────
  {
    reset();
    Object.assign(process.env, { ALLOW_MULTI_WORKSPACE: 'true' });
    W._testing.resetCaches();
    W._testing.setRegistry({
      async lookupDomain(h) { return h === 'portal.acme.com' ? W._testing.normalizeWorkspace('acme', { status: 'active', authTenantId: 'acme-t1abc', domains: [h] }) : null; },
      async listActive() { return []; }, async loadSecrets() { return {}; },
    });
    await up({ method: 'zelle', file: PNG('DEFAULT-ZELLE') });
    const r = await up({ method: 'cashapp', file: PNG('ACME-CASHAPP'), host: 'portal.acme.com', uid: 'admin-acme', tenant: 'acme-t1abc' });
    check('a client\'s upload lands in the client\'s own PREFIXED store, and never touches yours', r.statusCode === 200 && storeFor('ws-acme-settings').has('cashapp-qr') && !storeFor('settings').has('cashapp-qr') && storeFor('settings').has('zelle-qr'), JSON.stringify([...stores.keys()]));
    const mine = await see('cashapp'), theirs = await see('cashapp', 'portal.acme.com');
    check('...so your site shows no Cash App QR, and the client\'s site shows its own', mine.statusCode === 404 && theirs.statusCode === 200 && bytesOf(theirs).includes('ACME-CASHAPP'));
    const cross = await up({ method: 'zelle', file: PNG('HIJACK'), host: 'portal.acme.com', uid: 'admin-default', tenant: null });
    check('your own admin cannot upload into a client\'s workspace (their token is from the wrong sign-in pool)', cross.statusCode === 401 && !storeFor('ws-acme-settings').has('zelle-qr'), `${cross.statusCode}`);
    delete process.env.ALLOW_MULTI_WORKSPACE;
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
