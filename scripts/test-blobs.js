#!/usr/bin/env node
// scripts/test-blobs.js
//
// Backup and restore of a workspace's Netlify Blobs (scripts/lib/blobs.js) against an in-memory store.
// These hold identity documents and leases, so what is pinned down is: every file is verified after it
// is written, a corrupt or wrong-workspace backup is refused BEFORE anything is restored, a hostile key
// can never become a file path, and re-running is incremental.
//
// Usage: node scripts/test-blobs.js   (or: npm test)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B = require('./lib/blobs');
const { BLOB_STORES } = require('../netlify/functions/_lib/workspace');
const { main } = require('./workspace');
const { makeWorld } = require('./lib/test-world');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`\x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? '\n  ' + String(detail).split('\n').join('\n  ') : ''}`); }
}
const rejects = async fn => { try { await fn(); return null; } catch (e) { return e; } };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-test-'));

// an in-memory stand-in for one Netlify Blobs store (pages of two, like a paginated listing)
function makeStore(initial = {}, opts = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, { data: Buffer.from(v.data), etag: v.etag || `e-${sha(Buffer.from(v.data)).slice(0, 8)}`, metadata: v.metadata || {} }]));
  let n = 0; const reads = [];
  return {
    _m: m, _reads: reads,
    list: o => (o && o.paginate
      ? (async function* () { const keys = [...m.keys()]; for (let i = 0; i < keys.length; i += 2) yield { blobs: keys.slice(i, i + 2).map(k => ({ key: k, etag: m.get(k).etag })) }; })()
      : Promise.resolve({ blobs: [...m].map(([key, v]) => ({ key, etag: v.etag })) })),
    getWithMetadata: async key => { reads.push(key); if (opts.failOn === key) throw new Error('network reset'); if (opts.vanish === key) return null; const v = m.get(key); return v ? { data: v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.length), etag: v.etag, metadata: v.metadata } : null; },
    getMetadata: async key => (m.has(key) ? { etag: m.get(key).etag, metadata: m.get(key).metadata } : null),
    set: async (key, data, o) => { m.set(key, { data: Buffer.from(data), etag: `restored-${++n}`, metadata: (o && o.metadata) || {} }); },
  };
}
// one store per base name, like openStore('documents')
const world = (contents = {}, opts = {}) => { const stores = {}; for (const b of BLOB_STORES) stores[b] = makeStore(contents[b] || {}, opts[b] || {}); return { stores, openStore: b => stores[b] }; };

const DOCS = {
  'tenant-1/lease.pdf': { data: 'LEASE-BYTES', metadata: { contentType: 'application/pdf', fileName: 'lease.pdf' } },
  'tenant-1/id-front.jpg': { data: 'ID-PHOTO-BYTES', metadata: { contentType: 'image/jpeg' } },
  'flat-key.txt': { data: 'hello' },
};

(async () => {
  // ── backup ───────────────────────────────────────────────────────────────
  {
    const out = tmp(); const w = world({ documents: DOCS, invoices: { 'invoice_INV-1.html': { data: '<html>inv</html>' } } });
    const r = await B.backupWorkspaceBlobs({ openStore: w.openStore, workspaceId: 'acme', outDir: out, now: () => new Date('2026-10-01T00:00:00Z') });
    check('backup succeeds and counts every blob across all stores (paginated listing included)', r.ok && r.blobs === 4 && r.written === 4 && r.skipped === 0 && r.failed.length === 0, JSON.stringify({ ...r, bytes: undefined }));
    const manifest = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
    check('the manifest names the workspace, the time, and a SHA-256 for every blob', manifest.workspace === 'acme' && manifest.createdAt === '2026-10-01T00:00:00.000Z' && manifest.stores.documents.length === 3 && Object.values(manifest.stores).flat().every(e => /^[0-9a-f]{64}$/.test(e.sha256)));
    const lease = manifest.stores.documents.find(e => e.key === 'tenant-1/lease.pdf');
    const file = path.join(out, 'acme', 'documents', lease.file);
    check('each blob is saved byte-for-byte, with its key and metadata beside it', fs.readFileSync(file, 'utf8') === 'LEASE-BYTES' && sha(fs.readFileSync(file)) === lease.sha256 && JSON.parse(fs.readFileSync(`${file}.meta.json`, 'utf8')).metadata.contentType === 'application/pdf');
    check('a key containing "/" is stored as ONE flat file name (it cannot create folders)', !lease.file.includes('/') && lease.file === 'k_tenant-1%2Flease.pdf');
    check('every store in the shared list is covered, even an empty one', Object.keys(manifest.stores).join() === BLOB_STORES.join());
    const mode = p => fs.statSync(p).mode & 0o777;
    check('files and folders are created owner-only (these are identity documents)', mode(file) === 0o600 && mode(r.manifestPath) === 0o600 && mode(path.join(out, 'acme', 'documents')) === 0o700);

    // incremental
    w.stores.documents._reads.length = 0;
    const again = await B.backupWorkspaceBlobs({ openStore: w.openStore, workspaceId: 'acme', outDir: out });
    check('running it again is incremental: unchanged blobs are skipped and NOT downloaded again', again.ok && again.written === 0 && again.skipped === 4 && w.stores.documents._reads.length === 0);
    w.stores.documents._m.set('flat-key.txt', { data: Buffer.from('changed!'), etag: 'new-etag', metadata: {} });
    const third = await B.backupWorkspaceBlobs({ openStore: w.openStore, workspaceId: 'acme', outDir: out });
    check('...but a blob that changed (new etag) is fetched again', third.written === 1 && third.skipped === 3 && fs.readFileSync(path.join(out, 'acme', 'documents', 'k_flat-key.txt'), 'utf8') === 'changed!');
    fs.writeFileSync(file, 'TAMPERED');
    const fourth = await B.backupWorkspaceBlobs({ openStore: w.openStore, workspaceId: 'acme', outDir: out });
    check('a backup file that was damaged on disk is re-fetched, not trusted as "unchanged"', fourth.written === 1 && fs.readFileSync(file, 'utf8') === 'LEASE-BYTES');
  }

  // ── hostile and awkward keys ─────────────────────────────────────────────
  {
    const out = tmp(); const nasty = ['..', '.', '../../etc/passwd', '..%2f..%2fx', 'a/../../b', 'NUL', 'name with spaces & symbols #?.pdf', 'ünïcödé/файл.txt', 'x'.repeat(400)];
    const w = world({ documents: Object.fromEntries(nasty.map(k => [k, { data: `data-of-${k.slice(0, 12)}` }])) });
    const r = await B.backupWorkspaceBlobs({ openStore: w.openStore, workspaceId: 'acme', outDir: out });
    const written = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : written.push(path.join(d, f.name)); })(out);
    check(`${nasty.length} hostile or awkward keys (.., ../../etc/passwd, 400 characters, unicode...) all back up successfully`, r.ok && r.blobs === nasty.length, JSON.stringify(r.failed));
    check('...and every file landed INSIDE the backup folder — no key can escape it', written.every(p => path.resolve(p).startsWith(path.resolve(out) + path.sep)));
    check('...a 400-character key gets a short hashed file name that fits any filesystem', fs.readdirSync(path.join(out, 'acme', 'documents')).every(f => f.length <= 200));
    const mf = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
    check('...and the manifest still maps every original key to its file', nasty.every(k => mf.stores.documents.some(e => e.key === k)));
  }

  // ── failures ─────────────────────────────────────────────────────────────
  {
    const out = tmp(); const w = world({ documents: DOCS }, { documents: { failOn: 'flat-key.txt' } });
    const r = await B.backupWorkspaceBlobs({ openStore: w.openStore, workspaceId: 'acme', outDir: out });
    check('one blob that cannot be read is REPORTED (the run is not ok), and the others are still backed up', !r.ok && r.failed.length === 1 && r.failed[0].key === 'flat-key.txt' && r.written === 2);
    const gone = world({ documents: DOCS }, { documents: { vanish: 'flat-key.txt' } });
    const g = await B.backupWorkspaceBlobs({ openStore: gone.openStore, workspaceId: 'acme', outDir: tmp() });
    check('a blob deleted between listing and reading is quietly skipped, not an error', g.ok && g.written === 2);
    const empty = await B.backupWorkspaceBlobs({ openStore: world().openStore, workspaceId: 'acme', outDir: tmp() });
    check('a workspace with no blobs at all produces an empty, valid manifest', empty.ok && empty.blobs === 0 && JSON.parse(fs.readFileSync(empty.manifestPath, 'utf8')).totals.blobs === 0);
    const disk = tmp(); const badFs = { ...fs, writeFileSync: (p, ...a) => { if (String(p).endsWith('k_flat-key.txt')) { fs.writeFileSync(p, 'CORRUPTED-ON-WRITE'); return; } return fs.writeFileSync(p, ...a); } };
    const c = await B.backupWorkspaceBlobs({ openStore: world({ documents: DOCS }).openStore, workspaceId: 'acme', outDir: disk, fsImpl: badFs });
    check('a file that does not read back identically is a FAILURE (a backup only counts if it verifies)', !c.ok && c.failed.some(f => /read-back hash mismatch/.test(f.error)));
  }

  // ── restore ──────────────────────────────────────────────────────────────
  {
    const out = tmp(); const src = world({ documents: DOCS, invoices: { 'inv.html': { data: '<b>1</b>' } } });
    await B.backupWorkspaceBlobs({ openStore: src.openStore, workspaceId: 'acme', outDir: out });

    const target = world();
    const plan = await B.restoreWorkspaceBlobs({ openStore: target.openStore, workspaceId: 'acme', fromDir: out, apply: false });
    check('restore without --apply only plans: nothing is written', plan.ok && plan.planned === 4 && plan.restored === 0 && target.stores.documents._m.size === 0);
    const done = await B.restoreWorkspaceBlobs({ openStore: target.openStore, workspaceId: 'acme', fromDir: out, apply: true });
    check('restore --apply puts every blob back, byte-for-byte, with its metadata', done.ok && done.restored === 4 && target.stores.documents._m.get('tenant-1/lease.pdf').data.toString() === 'LEASE-BYTES' && target.stores.documents._m.get('tenant-1/lease.pdf').metadata.fileName === 'lease.pdf' && target.stores.invoices._m.get('inv.html').data.toString() === '<b>1</b>');

    const existing = world({ documents: { 'flat-key.txt': { data: 'NEWER-LIVE-VERSION' } } });
    const noOver = await B.restoreWorkspaceBlobs({ openStore: existing.openStore, workspaceId: 'acme', fromDir: out, apply: true });
    check('an existing blob is NOT overwritten by default (a restore must not destroy newer data)', noOver.skippedExisting === 1 && existing.stores.documents._m.get('flat-key.txt').data.toString() === 'NEWER-LIVE-VERSION' && noOver.restored === 3);
    const over = await B.restoreWorkspaceBlobs({ openStore: existing.openStore, workspaceId: 'acme', fromDir: out, apply: true, overwrite: true });
    check('...unless you explicitly ask to overwrite', over.restored === 4 && existing.stores.documents._m.get('flat-key.txt').data.toString() === 'hello');

    // corruption aborts everything
    const m = JSON.parse(fs.readFileSync(path.join(out, 'acme', 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(out, 'acme', 'documents', m.stores.documents[1].file), 'TAMPERED-WITH');
    const blank = world();
    const bad = await B.restoreWorkspaceBlobs({ openStore: blank.openStore, workspaceId: 'acme', fromDir: out, apply: true });
    check('a file that does not match its checksum aborts the WHOLE restore before anything is written', !bad.ok && bad.corrupt.length === 1 && /nothing was restored/.test(bad.error) && BLOB_STORES.every(b => blank.stores[b]._m.size === 0));
    fs.rmSync(path.join(out, 'acme', 'documents', m.stores.documents[0].file));
    const missing = await B.restoreWorkspaceBlobs({ openStore: blank.openStore, workspaceId: 'acme', fromDir: out, apply: true });
    check('a MISSING file is caught the same way', !missing.ok && missing.corrupt.length === 2);

    // wrong workspace / no backup
    const out2 = tmp(); await B.backupWorkspaceBlobs({ openStore: src.openStore, workspaceId: 'acme', outDir: out2 });
    fs.cpSync(path.join(out2, 'acme'), path.join(out2, 'beta'), { recursive: true });
    check('a backup of one workspace cannot be restored into another', /refusing to restore it into the wrong workspace/.test((await rejects(() => B.restoreWorkspaceBlobs({ openStore: blank.openStore, workspaceId: 'beta', fromDir: out2, apply: true }))).message));
    check('a missing backup is a clear error', /no backup of "ghost"/.test((await rejects(() => B.restoreWorkspaceBlobs({ openStore: blank.openStore, workspaceId: 'ghost', fromDir: out2, apply: true }))).message));
  }

  // ── through the command line ─────────────────────────────────────────────
  {
    const w = makeWorld(); w.st.workspaces.set('acme', { name: 'Acme', status: 'active', databaseId: 'ws-acme' });
    const stores = {}; const opened = [];
    const openBlobStore = prefix => base => { opened.push(prefix + base); const k = prefix + base; return (stores[k] = stores[k] || makeStore(base === 'documents' ? DOCS : {})); };
    const run = async (argv) => { const out = [], err = []; const code = await main(argv, { out: s => out.push(s), err: s => err.push(s), makeDeps: async () => ({ ...w.deps, openBlobStore, cleanup() {} }) }); return { code, out: out.join('\n'), err: err.join('\n') }; };
    const dir = tmp();
    const b = await run(['backup-blobs', 'acme', '--out', dir]);
    check('backup-blobs acme opens the workspace\'s own PREFIXED stores (ws-acme-documents, ...)', b.code === 0 && opened.length > 0 && opened.every(n => n.startsWith('ws-acme-')) && opened.includes('ws-acme-documents') && opened.length === BLOB_STORES.length, opened.join());
    check('backup-blobs writes the backup and reminds you it holds sensitive documents', fs.existsSync(path.join(dir, 'acme', 'manifest.json')) && /sensitive/.test(b.out));
    opened.length = 0; const d = await run(['backup-blobs', 'default', '--out', dir]);
    check('backup-blobs default opens the ORIGINAL, un-prefixed store names', d.code === 0 && opened.includes('documents') && !opened.some(n => n.startsWith('ws-')));
    const noOut = await run(['backup-blobs', 'acme']);
    check('backup-blobs without --out is a usage error', noOut.code === 2);
    const ghost = await run(['backup-blobs', 'ghost', '--out', dir]);
    check('backup-blobs of an unknown workspace is a usage error', ghost.code === 2 && /does not exist/.test(ghost.err));
    const r = await run(['restore-blobs', 'acme', '--from', dir]);
    check('restore-blobs without --apply is a plan', r.code === 0 && /PLAN ONLY/.test(r.out));
    const all = await run(['backup-blobs', 'x', '--all', '--out', tmp()]);
    check('backup-blobs --all backs up the default workspace and every registered one', all.code === 0 && /default/.test(all.out) && /acme/.test(all.out));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
