import {demoCSV, demoEvents} from './demo.mjs';
import {ticketsFromCSV,readEvents,walletFromEvents,reconcile,reportCSV,signed} from './journal.mjs';
import {extensionUnlock} from './unlock.mjs';

const $=id=>document.getElementById(id);
const element=(tag,text,className)=>{
  const node=document.createElement(tag);
  if(text!==undefined) node.textContent=text;
  if(className) node.className=className;
  return node;
};
const numbers=new Intl.NumberFormat('en-US');
const format=n=>n<0n?'−'+numbers.format(-n):numbers.format(n);
const isMatched=row=>row.status==='Matched'||row.status==='Confirmed';
const label=row=>row.t?.ticket??row.e.id.slice(0,8)+'…';
const key=row=>row.t?'t/'+row.t.ticket:'e/'+row.e.id;
let tickets=[],events=[],confirmations=new Map(),report,unit='sat',selected=null;

function showShift(nextTickets,nextEvents,caption,initial) {
  tickets=nextTickets;events=nextEvents;confirmations=new Map();
  report=reconcile(tickets,events);
  unit=report.units.includes('sat')?'sat':report.units[0]??'sat';
  selected=initial??null;
  $('subtitle').textContent=caption;
  $('filter').value='all';
  $('unit').replaceChildren(...report.units.map(u=>new Option(u,u)));
  $('unit').value=unit;
  $('unit').hidden=report.units.length<2;
  render();
}

function costs(r){
  if(!r)return '—';
  return format(signed(r))+(r.unit!==unit?' '+r.unit:'');
}
function sourceRow(title,record){
  const box=element('div',undefined,'source');
  box.append(element('strong',title));
  if(!record){box.append(element('p','No record.'));return box;}
  box.append(element('p',new Date(record.time*1000).toISOString()+' · '+record.direction+' · '+format(record.amount)+' '+record.unit));
  if(record.id||record.event_id) box.append(element('code',record.id??record.event_id));
  return box;
}
function explanation(row) {
  const {t,e,status}=row;
  switch(status){
    case 'Matched':return 'The event ID, direction, unit and amount agree.';
    case 'Confirmed':return 'You confirmed this time-and-amount match for this shift.';
    case 'Amount differs':{
      const delta=signed(e)-signed(t);
      return 'The wallet records '+format(delta<0n?-delta:delta)+' '+t.unit+' '+(delta<0n?'less':'more')+' than the till.';
    }
    case 'Direction differs':return 'The event ID agrees, but one side records an incoming payment and the other records an outgoing payment.';
    case 'Unit differs':return 'The event ID agrees. The till uses '+t.unit+' and the wallet uses '+e.unit+'.';
    case 'Match suggested':return 'One event has the same amount, unit and direction within five minutes. Check it against the ticket before confirming.';
    case 'Ambiguous':return 'The five-minute search overlaps another possible match. Supply a verified event ID in the till CSV to resolve it.';
    case 'Wallet only':return 'This wallet event has no assigned ticket in the imported till.';
    default:return t.event_id?'The referenced event is absent from the supplied history.':'The supplied history has no matching event within five minutes.';
  }
}
function updateDetail(row){
  const d=$('detail');d.replaceChildren();
  if(!row){d.append(element('p','Select a receipt to review.', 'explain'));return;}
  d.append(element('p',row.t?'Ticket':'Wallet event','kind'),element('p',label(row),'identifier'),element('p',explanation(row),'explain'));
  if(row.status==='Match suggested'||row.status==='Confirmed'){
    const button=element('button',row.status==='Confirmed'?'Undo confirmation':'Confirm this match','dark');
    button.onclick=()=>{
      if(row.status==='Confirmed')confirmations.delete(row.t.ticket);else confirmations.set(row.t.ticket,row.e.id);
      report=reconcile(tickets,events,confirmations);render();
      $('notice').textContent=row.status==='Confirmed'?'Confirmation removed.':'Match confirmed for ticket '+row.t.ticket+'.';
    };
    d.append(button);
  }
  const details=element('details'), summary=element('summary','View source rows');
  details.append(summary,sourceRow('Till receipt',row.t),sourceRow('Wallet history',row.e));
  if(row.status==='Ambiguous'){
    details.append(element('p',row.candidateCount+' possible wallet event(s). Showing up to five.','source'));
    for(const candidate of row.options)details.append(sourceRow('Candidate event',candidate));
  }
  d.append(details);
}
function render(){
  const amounts=report.totals.get(unit)??{till:0n,wallet:0n};
  const delta=amounts.wallet-amounts.till;
  $('till').textContent=format(amounts.till)+' '+unit;
  $('wallet').textContent=format(amounts.wallet)+' '+unit;
  $('difference').textContent=format(delta)+' '+unit;
  $('difference').classList.toggle('orange',delta!==0n);
  const filter=$('filter').value;
  const visible=report.rows.filter(r=>(r.t?.unit===unit||r.e?.unit===unit)&&(filter==='all'||(filter==='matched'?isMatched(r):!isMatched(r))));
  if(!visible.some(r=>key(r)===selected))selected=visible[0]?key(visible[0]):null;
  const rows=$('rows');rows.replaceChildren();
  let selectedRow;
  for(const row of visible){
    const tr=element('tr');const ticket=element('td',undefined,'sel'),button=element('button',label(row),'ticket');
    button.type='button';button.setAttribute('aria-label','Review '+(row.t?'ticket ':'wallet event ')+label(row));
    const choose=()=>{
      selected=key(row);
      rows.querySelector('tr.active')?.classList.remove('active');
      tr.classList.add('active');updateDetail(row);
      for(const b of rows.querySelectorAll('.ticket[aria-current]'))b.removeAttribute('aria-current');
      button.setAttribute('aria-current','true');
      if (window.matchMedia('(max-width:690px)').matches) $('review-title').scrollIntoView({block:'nearest'});
    };
    tr.onclick=choose;
    if(key(row)===selected){tr.classList.add('active');button.setAttribute('aria-current','true');selectedRow=row;}
    const status=element('td');
    const style=isMatched(row)?'good':row.status==='Match suggested'?'suggest':'warn';
    const badge=element('span',undefined,'status '+style),icon=element('i');
    icon.dataset.sign=isMatched(row)?'✓':row.status==='Match suggested'?'~':'!';
    icon.setAttribute('aria-hidden','true');badge.append(icon,document.createTextNode(row.status));status.append(badge);
    const direction=(row.t??row.e).direction;
    ticket.append(button);tr.append(ticket,element('td',row.t?(direction==='in'?'Sale':'Refund'):(direction==='in'?'In':'Out')),element('td',costs(row.t),'num amt'),element('td',costs(row.e),'num amt'),status);rows.append(tr);
  }
  if(!visible.length){const tr=element('tr'),td=element('td','No receipts in this view.','empty');td.colSpan=5;tr.append(td);rows.append(tr);}
  updateDetail(selectedRow);
}
async function demo(){
  showShift(ticketsFromCSV(demoCSV),await walletFromEvents(demoEvents),'Saturday market · Demo shift','t/1042');
}
$('unit').onchange=()=>{unit=$('unit').value;selected=null;render();};
$('filter').onchange=render;
$('import').onclick=()=>{$('import-error').textContent='';$('files').showModal();};
$('help').onclick=()=>$('guide').showModal();
for(const b of document.querySelectorAll('.close'))b.onclick=()=>b.closest('dialog').close();
$('restore').onclick=async()=>{await demo();$('import-form').reset();$('files').close();};
$('import-form').onsubmit=async ev=>{
  ev.preventDefault();
  const form=ev.currentTarget, till=form.elements.till.files[0], history=form.elements.history.files[0];
  const error=$('import-error');error.textContent='';
  if(!till||!history)return;
  const controls=[...form.querySelectorAll('button,input')];controls.forEach(el=>el.disabled=true);
  try{
    if(till.size>5*1024*1024||history.size>5*1024*1024)throw Error('Choose files under 5 MiB each.');
    const [csv,json]=await Promise.all([till.text(),history.text()]);
    const nextTickets=ticketsFromCSV(csv),envelopes=readEvents(json);
    if(nextTickets.length>5000||envelopes.length>5000)throw Error('Use at most 5,000 records per file. Split larger exports by shift.');
    const nextEvents=await walletFromEvents(envelopes,extensionUnlock(window.nostr));
    if(!nextTickets.length&&!nextEvents.length)throw Error('Both files are empty.');
    showShift(nextTickets,nextEvents,'Imported shift · '+nextTickets.length+' tickets · '+nextEvents.length+' wallet events');
    form.reset();$('files').close();$('notice').textContent='Shift imported.';
  }catch(e){error.textContent=e.message;}finally{controls.forEach(el=>el.disabled=false);}
};
$('export').onclick=()=>{
  const blob=new Blob([reportCSV(report.rows)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download='tillfold-shift-report.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);$('notice').textContent='Exported all shift rows as CSV.';
};
await demo();
