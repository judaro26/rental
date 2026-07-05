// netlify/functions/purge-expired-applications.js
// Scheduled (daily) data-minimization sweep for DECLINED or ARCHIVED
// applications (approved applications are never touched). Two stages:
//
//   1. Document purge  — after APPLICATION_RETENTION_DAYS (default 90), the
//      uploaded supporting-document files are permanently deleted (blobs removed,
//      references cleared) but the application record is kept, flagged as purged.
//   2. Record deletion — after APPLICATION_DELETE_DAYS (default 365), the entire
//      application record is permanently deleted (with any remaining files).
//
// An audit-log entry is written for every action (kept in applicationAuditLog,
// a separate collection) so the monthly compliance report can summarize them.
//
// Schedule is declared in netlify.toml ([functions."purge-expired-applications"]).
//
// Required env vars: FIREBASE_SERVICE_ACCOUNT, NETLIFY_SITE_ID (or SITE_ID), NETLIFY_API_TOKEN

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

// Normalize a Firestore Timestamp | ISO string | Date to epoch ms (or null).
function toMs(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch { return null; } }
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

exports.handler = async () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn('purge-expired-applications: FIREBASE_SERVICE_ACCOUNT not set — skipping.');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  const DAY = 24 * 60 * 60 * 1000;
  const retentionDays = parseInt(process.env.APPLICATION_RETENTION_DAYS || '90', 10) || 90;
  let deleteDays = parseInt(process.env.APPLICATION_DELETE_DAYS || '365', 10) || 365;
  if (deleteDays < retentionDays) deleteDays = retentionDays; // never delete before purging files
  const now = Date.now();
  const purgeCutoff = now - retentionDays * DAY;
  const deleteCutoff = now - deleteDays * DAY;

  const a  = getAdmin();
  const db = a.firestore();

  let store = null;
  try {
    const { getStore } = require('@netlify/blobs');
    const siteID    = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const blobToken = process.env.NETLIFY_API_TOKEN;
    if (siteID && blobToken) store = getStore({ name: 'documents', consistency: 'strong', siteID, token: blobToken });
    else console.warn('purge-expired-applications: Netlify Blobs env vars missing — will clear references but cannot delete blobs.');
  } catch (e) { console.warn('purge-expired-applications: blob store unavailable:', e.message); }

  async function deleteBlobs(docs) {
    let n = 0;
    for (const d of docs) {
      if (store && d.storagePath) {
        try { await store.delete(d.storagePath); n++; }
        catch (e) { console.warn(`purge: failed to delete blob ${d.storagePath}:`, e.message); }
      }
    }
    return n;
  }

  const snap = await db.collection('applications').get();
  let purgedApps = 0, purgedFiles = 0, deletedApps = 0, deletedFiles = 0;

  for (const docSnap of snap.docs) {
    const app = docSnap.data();
    if (app.status === 'approved') continue; // never auto-purge/delete approved applications

    // Reference time: archived date (if archived) else declined date.
    const archivedMs = app.archived ? (toMs(app.archivedAt) || toMs(app.updatedAt)) : null;
    const declinedMs = app.status === 'declined' ? (toMs(app.declinedAt) || toMs(app.submittedAt)) : null;
    const eligibleMs = archivedMs != null ? archivedMs : declinedMs;
    if (eligibleMs == null) continue; // not declined/archived

    const docs = Array.isArray(app.applicationDocuments) ? app.applicationDocuments : [];

    // ── Stage 2: full record deletion (past the delete window) ──────────────
    if (eligibleMs <= deleteCutoff) {
      const filesRemoved = await deleteBlobs(docs);
      try {
        // Write the audit entry BEFORE deleting the record (audit lives elsewhere).
        await db.collection('applicationAuditLog').add({
          applicationId: docSnap.id,
          shortId:       app.applicationId || docSnap.id.substring(0, 8).toUpperCase(),
          action:        'application_deleted_retention',
          applicantEmail: app.email || 'unknown',
          propertyName:  app.propertyName || '',
          reason:        app.archived ? 'archived' : 'declined',
          deletedFiles:  filesRemoved,
          retentionDays: deleteDays,
          timestamp:     a.firestore.FieldValue.serverTimestamp(),
        });
        await docSnap.ref.delete();
        deletedApps++; deletedFiles += filesRemoved;
      } catch (e) {
        console.error(`purge: failed to delete application ${docSnap.id}:`, e.message);
      }
      continue;
    }

    // ── Stage 1: document purge (past the retention window, files still present) ─
    if (eligibleMs <= purgeCutoff && docs.length && !app.documentsPurgedAt) {
      const filesRemoved = await deleteBlobs(docs);
      try {
        await docSnap.ref.update({
          applicationDocuments: [],
          documentsPurgedAt: a.firestore.FieldValue.serverTimestamp(),
          documentsPurgedCount: docs.length,
          updatedAt: a.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection('applicationAuditLog').add({
          applicationId: docSnap.id,
          shortId:       app.applicationId || docSnap.id.substring(0, 8).toUpperCase(),
          action:        'documents_purged_retention',
          applicantEmail: app.email || 'unknown',
          propertyName:  app.propertyName || '',
          reason:        app.archived ? 'archived' : 'declined',
          purgedCount:   docs.length,
          retentionDays,
          timestamp:     a.firestore.FieldValue.serverTimestamp(),
        });
        purgedApps++; purgedFiles += filesRemoved;
      } catch (e) {
        console.error(`purge: failed to update application ${docSnap.id}:`, e.message);
      }
    }
  }

  console.log(`purge-expired-applications: purged docs from ${purgedApps} app(s) (${purgedFiles} files); fully deleted ${deletedApps} app(s) (${deletedFiles} files). Retention ${retentionDays}d / delete ${deleteDays}d.`);
  return { statusCode: 200, body: JSON.stringify({ success: true, purgedApps, purgedFiles, deletedApps, deletedFiles, retentionDays, deleteDays }) };
};
