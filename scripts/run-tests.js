#!/usr/bin/env node
// scripts/run-tests.js — runs every scripts/test-*.js in its own process (each installs its
// own fakes) and fails if any of them fails.   Usage: npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => /^test-.*\.js$/.test(f)).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n\x1b[1m▶ ${f}\x1b[0m`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`\x1b[31m✗ ${f} failed (exit ${r.status})\x1b[0m`); }
}
console.log(failed ? `\n\x1b[31m${failed} of ${files.length} test files failed.\x1b[0m` : `\n\x1b[32mAll ${files.length} test files passed.\x1b[0m`);
process.exit(failed ? 1 : 0);
