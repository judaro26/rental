#!/usr/bin/env node
// scripts/test-rent-coverage.js
// Auto-invoicing must not mistake LAST month's payment for THIS month's (see
// coverageWindowStartMs in netlify/functions/_lib/check-rent-paid.js).
// Usage: node scripts/test-rent-coverage.js   (or: npm test)
const path = require('path');
const R = path.resolve(__dirname, '../netlify/functions/_lib') + '/';
const { findMatchingCycle, computeCycle } = require(R+'reminder-cycle');
const { isRentAlreadyCoveredForCycle, coverageWindowStartMs } = require(R+'check-rent-paid');
const fakeDb=(pay,inv)=>({collection:n=>({where:()=>({get:async()=>({docs:(n==='payments'?pay:inv).map(r=>({data:()=>r}))})})})});
const day=(y,m,d)=>Date.UTC(y,m-1,d);
async function run(label, today, payments, invoices, expectCovered){
  const cycle=findMatchingCycle({dayOfMonth:1,leadDays:5},today);
  const due=new Date(cycle.dueMs);
  const prev=computeCycle(1,0,due.getUTCFullYear(),due.getUTCMonth()-1);
  const start=coverageWindowStartMs(prev.dueMs,cycle.dueMs);
  const got=await isRentAlreadyCoveredForCycle({db:fakeDb(payments,invoices),tenantId:'t',monthlyRent:2475,cycleStartMs:start,cycleEndMs:cycle.dueMs});
  console.log((got===expectCovered?'PASS':'FAIL'),'-',label,'(covered='+got+')');
  if(got!==expectCovered) process.exitCode=1;
}
(async()=>{
  const sep26=day(2026,9,26);
  await run("Kelcie: Sept invoice paid (due Sep 1) -> must NOT suppress Oct invoice", sep26, [], [{type:'invoice',status:'paid',dueDate:'September 1, 2026'}], false);
  await run("Sept rent paid Sep 3 -> must NOT suppress", sep26, [{status:'paid',amount:2475,manualDate:'2026-09-03'}], [], false);
  await run("Tenant paid Oct rent early on Sep 24 -> SHOULD skip", sep26, [{status:'paid',amount:2475,manualDate:'2026-09-24'}], [], true);
  await run("Oct invoice already paid early (due Oct 1) -> SHOULD skip", sep26, [], [{type:'invoice',status:'paid',dueDate:'October 1, 2026'}], true);
  await run("Sept rent paid late on Sep 20 -> known limitation, still looks covered", sep26, [{status:'paid',amount:2475,manualDate:'2026-09-20'}], [], true);
})();
