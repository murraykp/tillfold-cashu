import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {csvRows,ticketsFromCSV,readEvents,walletFromEvents,reconcile,reportCSV} from '../journal.mjs';
import {extensionUnlock} from '../unlock.mjs';
import {demoCSV,demoEvents} from '../demo.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const sampleTickets=ticketsFromCSV(demoCSV);
const sampleEvents=await walletFromEvents(demoEvents);
const first={...sampleTickets[0],event_id:''};
const event={...sampleEvents[0],time:first.time};
const report=(t,e,c)=>reconcile(t,e,c);
const result=(t,e,c)=>report(t,e,c).rows[0].status;
const signedFixture=JSON.parse(read('./signed-history.json'));
const mockSigner={
  getPublicKey:async()=>signedFixture.event.pubkey,
  nip44:{decrypt:async(author,ciphertext)=>{
    assert.equal(author,signedFixture.event.pubkey);
    assert.equal(ciphertext,signedFixture.event.content);
    return JSON.stringify(signedFixture.tags);
  }}
};
test('demo matches downloadable examples',()=>{
  assert.equal(demoCSV,read('../examples/till.csv'));assert.deepEqual(demoEvents,JSON.parse(read('../examples/wallet-history.json')));
});
test('demo totals and all five results',()=>{
  const r=report(sampleTickets,sampleEvents);
  assert.deepEqual(r.totals.get('sat'),{till:12600n,wallet:12450n});
  assert.deepEqual(r.rows.map(r=>r.status),['Matched','Amount differs','Matched','Match suggested','Matched']);
});
test('separate units even when one referenced event has a conflicting denomination',()=>{
  const r=report([sampleTickets[0]],[{...event,unit:'usd'}]);
  assert.equal(r.rows[0].status,'Unit differs');assert.deepEqual(r.totals.get('sat'),{till:4000n,wallet:0n});assert.deepEqual(r.totals.get('usd'),{till:0n,wallet:4000n});
});
test('event reference mismatch cannot silently choose another event',()=>{
  const e={...event,id:'c'.repeat(64)};
  assert.deepEqual(report([sampleTickets[0]],[e]).rows.map(r=>r.status),['Missing in wallet','Wallet only']);
  assert.equal(result([sampleTickets[0]],[{...event,direction:'out'}]),'Direction differs');
});
test('timestamp window includes both five-minute boundaries',()=>{
  for(const delta of [-300,300])assert.equal(result([first],[{...event,time:first.time+delta}]),'Match suggested');
  for(const delta of [-301,301])assert.equal(result([first],[{...event,time:first.time+delta}]),'Missing in wallet');
});
test('one-to-one review confirmation can be restored or removed',()=>{
  assert.equal(result([first],[event],new Map([[first.ticket,event.id]])),'Confirmed');
  assert.equal(result([first],[event]),'Match suggested');
});
test('ambiguous in either direction, exact reference takes precedence',()=>{
  const two={...event,id:'d'.repeat(64)}, t2={...first,ticket:'second'};
  assert.equal(result([first],[event,two]),'Ambiguous');
  assert.deepEqual(report([first,t2],[event]).rows.map(r=>r.status),['Ambiguous','Ambiguous','Wallet only']);
  assert.deepEqual(report([sampleTickets[0],t2],[event,two]).rows.map(r=>r.status),['Matched','Match suggested']);
});
test('duplicate relay copies count once, conflicting copies fail',async()=>{
  assert.equal((await walletFromEvents([demoEvents[0],demoEvents[0]])).length,1);
  await assert.rejects(()=>walletFromEvents([demoEvents[0],{...demoEvents[0],created_at:1000}]),/Conflicting/);
});
test('mixed authors and spendable token events are rejected before any signer prompt',async()=>{
  let prompts=0;
  const unlock=()=>{prompts++;return '[]';};
  await assert.rejects(()=>walletFromEvents([signedFixture.event,{...signedFixture.event,kind:7375}],unlock),/7376/);
  await assert.rejects(()=>walletFromEvents([signedFixture.event,{...signedFixture.event,pubkey:'b'.repeat(64)}],unlock),/one wallet/);
  assert.equal(prompts,0);
});
test('plain JSON, NDJSON and decrypted string tags, optional unit',async()=>{
  assert.equal(readEvents(demoEvents.map(e=>JSON.stringify(e)).join('\n')).length,5);
  assert.deepEqual(readEvents(JSON.stringify(demoEvents)),demoEvents);
  assert.deepEqual(readEvents(''),[]);assert.deepEqual(readEvents(JSON.stringify(demoEvents[0])),[demoEvents[0]]);
  assert.equal((await walletFromEvents([{...demoEvents[2],content:JSON.stringify(demoEvents[2].content)}]))[0].unit,'sat');
});
test('verified encrypted history passes through a signer for the same key',async()=>{
  const items=await walletFromEvents([signedFixture.event],extensionUnlock(mockSigner));
  assert.equal(items[0].amount,42n);assert.equal(items[0].id,signedFixture.event.id);
});
test('tampered encrypted history never prompts the signer',async()=>{
  const unlock=extensionUnlock({getPublicKey:()=>assert.fail('signer prompted'),nip44:{decrypt:()=>assert.fail('decrypted')}});
  await assert.rejects(()=>unlock({...signedFixture.event,created_at:1}),/invalid Nostr/);
  await assert.rejects(()=>unlock({...signedFixture.event,sig:'0'.repeat(128)}),/invalid Nostr/);
});
test('mismatched or absent signer gives actionable errors',async()=>{
  await assert.rejects(()=>extensionUnlock(null)(signedFixture.event),/enable/);
  await assert.rejects(()=>extensionUnlock({...mockSigner,getPublicKey:async()=>'a'.repeat(64)})(signedFixture.event),/different wallet/);
});
test('parse quoted CSV, escaped quotes, CRLF and a UTF-8 BOM',()=>{
  assert.deepEqual(csvRows('\uFEFF"ticket",memo\r\n"booth, 1","a ""note""\nline"\r\n'),[['ticket','memo'],['booth, 1','a "note"\nline']]);
  assert.throws(()=>csvRows('"unclosed'),/open quote/);assert.throws(()=>csvRows('a,"x"z'),/Unexpected/);
});
test('reject duplicate IDs, duplicate tickets and invalid timestamps',()=>{
  assert.throws(()=>ticketsFromCSV(demoCSV.replace('22'+'a'.repeat(62),'11'+'a'.repeat(62))),/same event/);
  assert.throws(()=>ticketsFromCSV(demoCSV.replace('1042,','1041,')),/unique label/);
  for(const t of ['2026-02-31T13:00:00Z','2026-11-21T13:00:00','2026-11-21T24:00:00Z']){
    assert.throws(()=>ticketsFromCSV(demoCSV.replace('2026-11-21T14:05:00Z',t)),/Time/);
  }
});
test('positive integer arithmetic remains exact over 2^53',async()=>{
  const large='90071992547409910001';
  const row=ticketsFromCSV(demoCSV.replace(',4000,',','+large+','))[0];
  assert.equal(row.amount,BigInt(large));
  await assert.rejects(()=>walletFromEvents([{...demoEvents[0],content:[['amount','12.5'],['direction','in']]}]),/positive integers/);
});
test('report contains review decisions, source IDs, excel-safe ticket labels and no private tags',()=>{
  const r=report([{...first,ticket:'=1+1'}],[event]);const csv=reportCSV(r.rows);
  assert.ok(csv.includes("'=1+1"));assert.ok(csv.includes('Match suggested'));assert.ok(csv.includes(event.id));
  assert.ok(!csv.includes('created"'));assert.equal(csvRows(csv).length,2);
});
test('dense ambiguity stays bounded and retains the complete candidate count',()=>{
  const many=Array.from({length:300},(_,i)=>({...event,id:i.toString(16).padStart(64,'0')}));
  const t=Array.from({length:300},(_,i)=>({...first,ticket:'r'+i}));
  const r=report(t,many);assert.equal(r.rows[0].candidateCount,300);assert.equal(r.rows[0].options.length,5);
  assert.equal(r.totals.get('sat').till,1200000n);assert.equal(r.rows.length,600);
});
