#!/usr/bin/env node
// scripts/verify.js
//
// Encodes the regression checks that have been run by hand, over and
// over, throughout this project's development: syntax validation for
// every Netlify function and every HTML page's embedded script,
// dangling onclick/onchange handlers, duplicate function/window.X
// definitions, getElementById calls with no matching id="", i18n key
// parity between English and Spanish (both admin.html's inline
// dictionary and shared/public-i18n.js's separate one), and
// firestore.rules brace balance.
//
// None of this replaces real testing of actual behavior — it catches
// the class of mistake that's bitten this project before: a str_replace
// edit that silently drops a function declaration or a section comment,
// a new i18n key added in English but not Spanish, a handler wired to a
// function that was renamed or removed. Those are exactly the kind of
// small, easy-to-miss breaks that don't show up until someone clicks the
// broken button in production.
//
// Usage: node scripts/verify.js
// Exits 1 if any check fails, 0 if everything passes — safe to wire into
// a CI step (see .github/workflows/verify.yml) or run locally with
// `npm run verify`.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checksRun = 0;

// Known, already-investigated false positives that this script's checks
// can't distinguish from real problems without deeper parsing than a
// regex can do. Each entry here was manually traced back to its source
// and confirmed harmless — see the comment on each check below for why.
// This list should only ever grow by deliberate addition after the same
// kind of investigation, never as a quick way to silence a real failure.
const KNOWN_FALSE_POSITIVES = {
  danglingHandlers: {
    // A raw `if (...)` expression inside an inline handler attribute
    // (e.g. onmouseenter="if(!this.classList.contains(...))...") reads to
    // this regex exactly like a call to a function named "if". Confirmed
    // by grep against both files: only onmouseenter/onkeydown/onchange
    // attributes starting with a literal `if(`, no function named "if"
    // anywhere.
    'tenant-portal.html': ['if'],
    'index.html': ['if'],
  },
  duplicateWindowX: {
    // Not a duplicate function — window._boldPaymentsEnabled is a plain
    // variable assigned once in the try branch and once in the catch
    // branch of the same try/catch, never both. Confirmed by viewing the
    // surrounding lines directly.
    'tenant-portal.html': ['_boldPaymentsEnabled'],
  },
  missingDomIds: {
    // A defensive, pre-existing no-op: `document.getElementById('year')
    // && (...)` — only acts if the element exists, and it deliberately
    // doesn't on this page (this looks like a copy-pasted footer
    // copyright-year updater from a page that does have one). Confirmed
    // harmless, not fixed, since the code already null-checks it.
    'tenant-portal.html': ['year'],
  },
};

function isKnownFalsePositive(category, page, item) {
  return (KNOWN_FALSE_POSITIVES[category]?.[page] || []).includes(item);
}

function fail(label, detail) {
  failures++;
  console.log(`\n\x1b[31m✗ ${label}\x1b[0m`);
  if (detail) console.log(`  ${String(detail).split('\n').join('\n  ')}`);
}
function pass(label) {
  checksRun++;
  console.log(`\x1b[32m✓\x1b[0m ${label}`);
}

function readIfExists(relPath) {
  const full = path.join(ROOT, relPath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

// ── 1. Syntax-check every Netlify function ──────────────────────────────────
function checkFunctionSyntax() {
  const dirs = ['netlify/functions', 'netlify/functions/_lib'];
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.js')) continue;
      const filePath = path.join(dir, file);
      try {
        execFileSync(process.execPath, ['--check', path.join(ROOT, filePath)], { stdio: 'pipe' });
        pass(`Syntax: ${filePath}`);
      } catch (e) {
        fail(`Syntax: ${filePath}`, e.stderr?.toString() || e.message);
      }
    }
  }
}

// ── 2. Syntax-check every HTML page's embedded script ───────────────────────
// Two script styles exist in this codebase: <script type="module"> (admin,
// tenant-portal, owner-portal, apply, index) and plain <script> (documents,
// respond). Both are checked; a page with neither is skipped rather than
// treated as a failure, since not every HTML page has embedded JS.
const HTML_PAGES = ['admin.html', 'tenant-portal.html', 'owner-portal.html', 'apply.html', 'index.html', 'documents.html', 'respond.html'];

function extractScript(html) {
  const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (moduleMatch) return moduleMatch[1];
  const plainMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (plainMatch) return plainMatch[1];
  return null;
}

function checkHtmlSyntax() {
  for (const page of HTML_PAGES) {
    const html = readIfExists(page);
    if (html == null) continue; // not every page exists in every checkout
    const script = extractScript(html);
    if (script == null) { pass(`Syntax: ${page} (no embedded script)`); continue; }
    const tmpFile = path.join(ROOT, `.verify-tmp-${page}.mjs`);
    try {
      fs.writeFileSync(tmpFile, script);
      execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
      pass(`Syntax: ${page}`);
    } catch (e) {
      fail(`Syntax: ${page}`, e.stderr?.toString() || e.message);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }
}

// ── 3-5. Dangling handlers, duplicate definitions, missing DOM ids ──────────
function checkHtmlRegressions() {
  for (const page of HTML_PAGES) {
    const html = readIfExists(page);
    if (html == null) continue;
    const script = extractScript(html);
    if (script == null) continue;

    // Dangling handlers: onclick="foo(...)" where foo is never defined as
    // window.foo = ... or function foo(...). This regex has a known,
    // harmless limitation — a raw JS keyword used as an inline expression
    // (e.g. onclick="if(...)...") looks like a call to a function named
    // "if". Already-confirmed instances of this are filtered out via
    // KNOWN_FALSE_POSITIVES above rather than re-triaged every run; a
    // genuinely new dangling handler still fails the check.
    const handlerCalls = new Set([...html.matchAll(/on(?:click|change|input|submit|keydown|keyup|blur|focus)="([a-zA-Z_$][a-zA-Z0-9_$]*)\(/g)].map(m => m[1]));
    const windowAssigned = new Set([...script.matchAll(/window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g)].map(m => m[1]));
    const plainFunctions = new Set([...script.matchAll(/\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)].map(m => m[1]));
    const defined = new Set([...windowAssigned, ...plainFunctions]);
    const dangling = [...handlerCalls].filter(fn => !defined.has(fn)).sort();
    const newDangling = dangling.filter(fn => !isKnownFalsePositive('danglingHandlers', page, fn));
    const knownDangling = dangling.filter(fn => isKnownFalsePositive('danglingHandlers', page, fn));
    if (newDangling.length) fail(`Dangling handlers in ${page}`, newDangling.join(', '));
    else pass(`No new dangling handlers in ${page}` + (knownDangling.length ? ` (${knownDangling.join(', ')} — known false positive, see allowlist)` : ''));

    // Duplicate window.X assignments: the second silently overwrites the
    // first at script-load time, so the first is dead code that never
    // runs — this is exactly the bug class that was found and fixed in
    // tenant-portal.html earlier in this project (a whole duplicated
    // autopay flow, only the second copy of which actually executed).
    const waCounts = {};
    for (const name of [...script.matchAll(/window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g)].map(m => m[1])) {
      waCounts[name] = (waCounts[name] || 0) + 1;
    }
    const dupes = Object.entries(waCounts).filter(([, c]) => c > 1);
    const newDupes = dupes.filter(([name]) => !isKnownFalsePositive('duplicateWindowX', page, name));
    const knownDupes = dupes.filter(([name]) => isKnownFalsePositive('duplicateWindowX', page, name));
    if (newDupes.length) fail(`Duplicate window.X in ${page}`, newDupes.map(([k, c]) => `${k} (${c}x)`).join(', '));
    else pass(`No new duplicate window.X in ${page}` + (knownDupes.length ? ` (${knownDupes.map(([k])=>k).join(', ')} — known false positive, see allowlist)` : ''));

    // Missing DOM ids: getElementById('foo') with no id="foo" anywhere on
    // the page.
    const declaredIds = new Set([...html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
    const referencedIds = [...html.matchAll(/getElementById\(['"]([a-zA-Z0-9_-]+)['"]\)/g)].map(m => m[1]);
    const missingIds = [...new Set(referencedIds.filter(id => !declaredIds.has(id)))].sort();
    const newMissing = missingIds.filter(id => !isKnownFalsePositive('missingDomIds', page, id));
    const knownMissing = missingIds.filter(id => isKnownFalsePositive('missingDomIds', page, id));
    if (newMissing.length) fail(`Missing DOM ids in ${page}`, newMissing.join(', '));
    else pass(`No new missing DOM ids in ${page}` + (knownMissing.length ? ` (${knownMissing.join(', ')} — known false positive, see allowlist)` : ''));
  }
}

// ── 6. i18n key parity ───────────────────────────────────────────────────────
// Two separate i18n systems exist in this codebase: admin.html's inline
// `const I18N = { en: {...}, es: {...} }` dictionary, and the standalone
// shared/public-i18n.js file that tenant-portal.html (and other public-
// facing pages) load as a plain script. Both are checked the same way.
function extractBracedBlock(text, startIdx) {
  const braceStart = text.indexOf('{', startIdx);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return [text.slice(braceStart, i + 1), i + 1];
    }
  }
  return [null, null];
}

function checkI18nDict(label, content, dictMarker, referencedInHtml) {
  const dictStart = content.indexOf(dictMarker);
  if (dictStart === -1) { fail(`${label}: could not find "${dictMarker}"`); return; }
  const [dictBlock] = extractBracedBlock(content, dictStart);
  const enKeyPos = dictBlock.indexOf('en:');
  const [enBlock, enEndOffset] = extractBracedBlock(dictBlock, enKeyPos);
  const esKeyPos = dictBlock.indexOf('es:', enEndOffset);
  const [esBlock] = extractBracedBlock(dictBlock, esKeyPos);

  const enKeys = new Set([...enBlock.matchAll(/'([\w.]+)'\s*:/g)].map(m => m[1]));
  const esKeys = new Set([...esBlock.matchAll(/'([\w.]+)'\s*:/g)].map(m => m[1]));
  const onlyInEn = [...enKeys].filter(k => !esKeys.has(k));
  const onlyInEs = [...esKeys].filter(k => !enKeys.has(k));

  if (onlyInEn.length || onlyInEs.length) {
    fail(`${label}: EN/ES key mismatch`,
      (onlyInEn.length ? `Only in EN: ${onlyInEn.join(', ')}\n` : '') +
      (onlyInEs.length ? `Only in ES: ${onlyInEs.join(', ')}` : ''));
  } else {
    pass(`${label}: EN/ES keys match (${enKeys.size} keys)`);
  }

  if (referencedInHtml) {
    const referenced = new Set([
      ...[...referencedInHtml.matchAll(/data-i18n(?:-placeholder|-title)?="([\w.]+)"/g)].map(m => m[1]),
      ...[...referencedInHtml.matchAll(/\bt\('([\w.]+)'\)/g)].map(m => m[1]),
    ]);
    const missing = [...referenced].filter(k => k.includes('.') && !enKeys.has(k)).sort();
    if (missing.length) fail(`${label}: referenced keys missing from dictionary`, missing.join(', '));
    else pass(`${label}: no dangling key references`);
  }
}

function checkI18n() {
  const adminHtml = readIfExists('admin.html');
  if (adminHtml) checkI18nDict('admin.html i18n', adminHtml, 'const I18N = {', adminHtml);

  const publicI18n = readIfExists('shared/public-i18n.js');
  if (publicI18n) {
    // Referenced keys for this dictionary can appear across multiple
    // public-facing pages, not just one — check against whichever of
    // them exist in this checkout.
    const referencedAcross = ['tenant-portal.html', 'apply.html', 'index.html']
      .map(p => readIfExists(p)).filter(Boolean).join('\n');
    checkI18nDict('shared/public-i18n.js', publicI18n, 'const DICT = {', referencedAcross);
  }
}

// ── 7. firestore.rules brace balance ────────────────────────────────────────
function checkFirestoreRules() {
  const rules = readIfExists('firestore.rules');
  if (rules == null) return;
  const opens = (rules.match(/{/g) || []).length;
  const closes = (rules.match(/}/g) || []).length;
  if (opens !== closes) fail('firestore.rules brace balance', `${opens} "{" vs ${closes} "}"`);
  else pass('firestore.rules brace balance');
}

// ── Run everything ───────────────────────────────────────────────────────────
console.log('Running verification checks...\n');
checkFunctionSyntax();
checkHtmlSyntax();
checkHtmlRegressions();
checkI18n();
checkFirestoreRules();

console.log(`\n${checksRun} checks passed, ${failures} failed.`);
if (failures > 0) {
  console.log('\x1b[31mVerification failed.\x1b[0m');
  process.exit(1);
} else {
  console.log('\x1b[32mAll checks passed.\x1b[0m');
  process.exit(0);
}
