#!/usr/bin/env node
// scripts/test-receipts.js
// Receipt idempotency: repeated or concurrent "send receipt" requests must produce ONE
// receipt and ONE email (see claimReceipt in netlify/functions/_lib/create-invoice.js).
// Usage: node scripts/test-receipts.js   (or: npm test)

const Module = require('module');
let emails = [];
let failNextMail = false;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'nodemailer') return { createTransport: () => ({ sendMail: async (m) => { await new Promise(r=>setTimeout(r,20)); if (failNextMail){failNextMail=false; throw new Error('SMTP down');} emails.push(m); } }) };
  if (req === '@netlify/blobs') return { getStore: () => ({ set: async () => { await new Promise(r=>setTimeout(r,10)); } }) };
  return origLoad.call(this, req, ...rest);
};
process.env.NETLIFY_SITE_ID='x'; process.env.NETLIFY_API_TOKEN='y'; process.env.SMTP_HOST='h'; process.env.SMTP_USER='u';

// ---- minimal fake Firestore with serialized transactions (like real contention-retry outcome)
function makeDb(){
  const store = {}; let lock = Promise.resolve(); let auto=0;
  const col = n => (store[n] = store[n] || {});
  const docRef = (n,id) => ({
    id,
    get: async () => ({ exists: id in col(n), data: () => col(n)[id] }),
    set: async (d,opt) => { col(n)[id] = opt && opt.merge ? { ...(col(n)[id]||{}), ...d } : d; },
    update: async d => { col(n)[id] = { ...(col(n)[id]||{}), ...d }; },
    delete: async () => { delete col(n)[id]; },
  });
  return {
    _store: store,
    collection: n => ({ doc: id => docRef(n,id), add: async d => { const id='auto'+(++auto); col(n)[id]=d; return {id}; } }),
    runTransaction: fn => { const run = lock.then(async () => {
        const writes=[]; const tx={ get: async r => r.get(), set: (r,d)=>writes.push([r,d]) };
        const out = await fn(tx); for (const [r,d] of writes) await r.set(d); return out; });
      lock = run.catch(()=>{}); return run; },
  };
}
const a = { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } };
const path = require('path');
const LIB = path.resolve(__dirname, '../netlify/functions/_lib');
const CI = require(path.join(LIB, 'create-invoice'));
const W = require(path.join(LIB, 'workspace'));
// createInvoice needs a workspace context, exactly as it has inside a real handler.
const createInvoice = args => W.runWithWorkspace(W._testing.defaultWorkspace(), () => CI.createInvoice(args));
const base = { a, siteUrl:'https://x.test', siteName:'Site', tenantId:'t1', tenantName:'Kelcie', tenantEmail:'k@x.com',
  lineItems:[{description:'Rent',quantity:1,unitPrice:100,amount:100}], paidDate:'October 1, 2026' };

let failed=0; const check=(name,cond,extra='')=>{ console.log((cond?'PASS':'FAIL')+' - '+name+(extra?'  '+extra:'')); if(!cond) failed++; };
const recCount = db => Object.values(db._store.invoices||{}).filter(i=>i.type==='receipt').length;

(async()=>{
  // 1. five rapid concurrent clicks on the same invoice's Receipt button
  let db=makeDb(); emails=[];
  let rs = await Promise.all(Array.from({length:5},()=>createInvoice({...base, db, type:'receipt', existingInvoiceId:'invA'})));
  // existingInvoiceId path updates an existing doc; seed it so .update works
  check('5 concurrent clicks (existing invoice) -> exactly 1 email', emails.length===1, `emails=${emails.length}`);
  check('  -> the other 4 report alreadySent', rs.filter(r=>r.alreadySent).length===4);

  // 2. later click after completion
  let r2 = await createInvoice({...base, db, type:'receipt', existingInvoiceId:'invA'});
  check('later click -> alreadySent, no new email, same number', r2.alreadySent && emails.length===1 && r2.invoiceNumber===rs.find(r=>!r.alreadySent).invoiceNumber);

  // 3. payment-keyed receipts (no existing invoice): concurrent
  db=makeDb(); emails=[];
  rs = await Promise.all(Array.from({length:4},()=>createInvoice({...base, db, type:'receipt', paymentId:'pay1'})));
  check('4 concurrent clicks (payment receipt) -> 1 email, 1 receipt doc', emails.length===1 && recCount(db)===1, `emails=${emails.length} docs=${recCount(db)}`);
  const first = rs.find(r=>!r.alreadySent);

  // 4. explicit resend: same number/link, one more email, no new receipt doc
  let r4 = await createInvoice({...base, db, type:'receipt', paymentId:'pay1', resend:true});
  check('resend -> +1 email, same receipt number, no new doc', r4.resent && emails.length===2 && r4.invoiceNumber===first.invoiceNumber && recCount(db)===1);

  // 5. different payments are independent
  await createInvoice({...base, db, type:'receipt', paymentId:'pay2'});
  check('different payment -> its own receipt', recCount(db)===2 && emails.length===3);

  // 6. failure releases claim so retry works
  db=makeDb(); emails=[]; failNextMail=true;
  let threw=false; try{ await createInvoice({...base, db, type:'receipt', paymentId:'pay9'}); }catch(e){ threw=true; }
  let r6 = await createInvoice({...base, db, type:'receipt', paymentId:'pay9'});
  check('SMTP failure then retry -> retry sends', threw && !r6.alreadySent && emails.length===1);

  // 7. abandoned in-progress claim is reclaimable after TTL
  db=makeDb(); emails=[];
  db._store.receiptClaims={ pay_pay7:{ claimedAtMs: Date.now()-3*60*1000, tenantEmail:'STALE-MARKER' } };
  let r7 = await createInvoice({...base, db, type:'receipt', paymentId:'pay7'});
  check('stale claim (no result, >TTL) -> reclaimed and sent', !r7.alreadySent && emails.length===1 && db._store.receiptClaims.pay_pay7.tenantEmail==='k@x.com' && !!db._store.receiptClaims.pay_pay7.result);
  db._store.receiptClaims.pay_pay8={ claimedAtMs: Date.now() };
  let r8 = await createInvoice({...base, db, type:'receipt', paymentId:'pay8'});
  check('fresh in-flight claim -> inProgress, nothing sent', r8.inProgress && emails.length===1);

  // 8. invoices and key-less receipts untouched
  db=makeDb(); emails=[];
  await createInvoice({...base, db, type:'invoice', dueDate:'Nov 1'});
  await createInvoice({...base, db, type:'invoice', dueDate:'Nov 1'});
  await createInvoice({...base, db, type:'receipt'});
  await createInvoice({...base, db, type:'receipt'});
  check('invoices + key-less receipts behave as before (4 emails, no claims)', emails.length===4 && !(db._store.receiptClaims));

  process.exit(failed?1:0);
})();
