// scripts/lib/blobs.js
//
// Backup and restore of a workspace's Netlify Blobs — the stored documents (tenant IDs, leases,
// photos), invoices, move-out statements and settings. Netlify Blobs has no backup of its own, and
// these are the one kind of client data that Firestore's backups do not cover.
//
//   <out>/<workspace>/manifest.json          what was backed up, with a SHA-256 per blob
//   <out>/<workspace>/<store>/k_<key>        the blob's bytes
//   <out>/<workspace>/<store>/k_<key>.meta.json   its key, metadata, etag, size, hash
//
// * Every file is read back and checked against its hash before it counts as backed up.
// * Re-running is incremental: an unchanged blob (same etag, file intact) is skipped.
// * Restore refuses a file whose hash does not match the manifest, and does not overwrite an
//   existing blob unless asked.
// * The backup holds SENSITIVE client data (identity documents). Files are created owner-only;
//   store the folder somewhere encrypted. Contents are never printed.
//
// The Blobs store is injected (`openStore(baseName)`), so this is tested with an in-memory store.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BLOB_STORES } = require('../../netlify/functions/_lib/workspace');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Keys can contain "/" and any character, and ".." must never become a path.
function fileNameFor(key) {
  const enc = encodeURIComponent(key);
  return enc.length <= 180 ? `k_${enc}` : `h_${sha256(Buffer.from(key))}`;
}

async function* listKeys(store) {
  const pages = store.list({ paginate: true });
  if (pages && typeof pages[Symbol.asyncIterator] === 'function') {
    for await (const page of pages) for (const b of page.blobs || []) yield b;
  } else {
    const page = await pages;
    for (const b of (page && page.blobs) || []) yield b;
  }
}

async function backupWorkspaceBlobs({ openStore, workspaceId, outDir, fsImpl = fs, now = () => new Date(), stores = BLOB_STORES }) {
  const root = path.join(outDir, workspaceId);
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifest = { workspace: workspaceId, createdAt: now().toISOString(), stores: {} };
  const totals = { written: 0, skipped: 0, failed: [], bytes: 0 };

  for (const base of stores) {
    const dir = path.join(root, base);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = openStore(base);
    const entries = (manifest.stores[base] = []);
    for await (const { key, etag } of listKeys(store)) {
      const file = fileNameFor(key);
      const dataPath = path.join(dir, file), metaPath = `${dataPath}.meta.json`;
      try {
        // incremental: same etag and an intact file => nothing to do
        if (fsImpl.existsSync(dataPath) && fsImpl.existsSync(metaPath)) {
          const prev = JSON.parse(fsImpl.readFileSync(metaPath, 'utf8'));
          if (prev.key === key && etag && prev.etag === etag && sha256(fsImpl.readFileSync(dataPath)) === prev.sha256) {
            entries.push({ key, file, sha256: prev.sha256, size: prev.size }); totals.skipped++; totals.bytes += prev.size; continue;
          }
        }
        const blob = await store.getWithMetadata(key, { type: 'arrayBuffer' });
        if (!blob) continue; // deleted between listing and reading
        const buf = Buffer.from(blob.data);
        const hash = sha256(buf);
        fsImpl.writeFileSync(dataPath, buf, { mode: 0o600 });
        fsImpl.writeFileSync(metaPath, JSON.stringify({ key, metadata: blob.metadata || {}, etag: blob.etag || etag || null, size: buf.length, sha256: hash }), { mode: 0o600 });
        // a backup only counts if it reads back identically
        if (sha256(fsImpl.readFileSync(dataPath)) !== hash) throw new Error('read-back hash mismatch');
        entries.push({ key, file, sha256: hash, size: buf.length }); totals.written++; totals.bytes += buf.length;
      } catch (e) { totals.failed.push({ store: base, key, error: e.message }); }
    }
  }
  manifest.totals = { blobs: Object.values(manifest.stores).reduce((n, a) => n + a.length, 0), bytes: totals.bytes, failed: totals.failed.length };
  fsImpl.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { ok: totals.failed.length === 0, workspaceId, ...totals, blobs: manifest.totals.blobs, manifestPath: path.join(root, 'manifest.json') };
}

async function restoreWorkspaceBlobs({ openStore, workspaceId, fromDir, apply = false, overwrite = false, fsImpl = fs }) {
  const root = path.join(fromDir, workspaceId);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fsImpl.existsSync(manifestPath)) throw new Error(`no backup of "${workspaceId}" in ${fromDir} (manifest.json not found)`);
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  if (manifest.workspace !== workspaceId) throw new Error(`this backup is of "${manifest.workspace}", not "${workspaceId}" — refusing to restore it into the wrong workspace`);

  const res = { restored: 0, skippedExisting: 0, corrupt: [], planned: 0 };
  // verify EVERYTHING before writing ANYTHING: one corrupt file aborts the whole restore
  for (const [base, entries] of Object.entries(manifest.stores)) {
    for (const e of entries) {
      const p = path.join(root, base, e.file);
      if (!fsImpl.existsSync(p) || sha256(fsImpl.readFileSync(p)) !== e.sha256) res.corrupt.push({ store: base, key: e.key });
    }
  }
  if (res.corrupt.length) return { ok: false, ...res, error: `${res.corrupt.length} file(s) are missing or do not match their checksum; nothing was restored` };

  for (const [base, entries] of Object.entries(manifest.stores)) {
    const store = openStore(base);
    for (const e of entries) {
      const dataPath = path.join(root, base, e.file);
      const meta = JSON.parse(fsImpl.readFileSync(`${dataPath}.meta.json`, 'utf8'));
      if (!overwrite && (await store.getMetadata(e.key))) { res.skippedExisting++; continue; }
      if (!apply) { res.planned++; continue; }
      await store.set(e.key, fsImpl.readFileSync(dataPath), { metadata: meta.metadata || {} });
      res.restored++;
    }
  }
  return { ok: true, applied: apply, ...res };
}

module.exports = { backupWorkspaceBlobs, restoreWorkspaceBlobs, fileNameFor, sha256 };
