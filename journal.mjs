const eventIdPattern = /^[0-9a-f]{64}$/;
const unitPattern = /^[a-z][a-z0-9_-]{0,19}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
export const windowSeconds = 300;

function requireThat(test, message) {
  if (!test) throw new Error(message);
}

// The final blank line is optional. RFC-style quotes may enclose commas and line breaks.
export function csvRows(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',') {
      row.push(field); field = ''; closed = false;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = []; field = ''; closed = false;
    } else if (c === '"' && !field && !closed) {
      quoted = true;
    } else {
      requireThat(!closed && c !== '"', 'Unexpected character beside a quoted CSV field.');
      field += c;
    }
  }
  requireThat(!quoted, 'A CSV field has an open quote.');
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function integerAmount(value) {
  requireThat(typeof value === 'string' && /^\d{1,28}$/.test(value) && BigInt(value) > 0n,
    'Amounts must be positive integers in the unit’s smallest denomination.');
  return BigInt(value);
}

function parseTime(text) {
  requireThat(timestampPattern.test(text), 'Time needs an ISO timestamp with a time zone.');
  const [year,month,day] = text.slice(0,10).split('-').map(Number);
  const days = [31, year%4===0 && (year%100!==0 || year%400===0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  const instant = Date.parse(text);
  requireThat(month>=1 && month<=12 && day>=1 && day<=days[month-1] && Number(text.slice(11,13))<24 && Number.isFinite(instant), 'Time must be a real calendar date and clock time.');
  return Math.floor(instant/1000);
}

function unitOf(value) {
  requireThat(typeof value === 'string' && unitPattern.test(value), 'Check the currency unit.');
  return value;
}

export function ticketsFromCSV(text) {
  const [header = [], ...records] = csvRows(text);
  const cols = header.map(s => s.trim().toLowerCase());
  const required = ['ticket','time','direction','amount','unit'];
  requireThat(required.every(k => cols.includes(k)) && new Set(cols).size === cols.length,
    'Till CSV headers must include ticket, time, direction, amount and unit. event_id is optional.');
  const labels = new Set(), references = new Set();
  return records.map((record, i) => {
    try {
      requireThat(record.length === cols.length, 'The field count differs from the header.');
      const get = k => (record[cols.indexOf(k)] ?? '').trim();
      const ticket = get('ticket'), direction = get('direction'), event_id = get('event_id').toLowerCase();
      const time = parseTime(get('time'));
      requireThat(ticket && !labels.has(ticket), 'Each ticket needs a unique label.');
      requireThat(direction === 'in' || direction === 'out', 'Direction must be in or out.');
      requireThat(!event_id || eventIdPattern.test(event_id), 'event_id must be 64 hexadecimal characters.');
      requireThat(!event_id || !references.has(event_id), 'Two tickets reference the same event ID.');
      labels.add(ticket); if (event_id) references.add(event_id);
      return {ticket, time, direction, amount:integerAmount(get('amount')), unit:unitOf(get('unit')), event_id};
    } catch (error) { throw new Error('Till row ' + (i + 2) + '. ' + error.message); }
  });
}

export function readEvents(text) {
  const data = text.trim();
  if (!data) return [];
  if (data[0] === '[') {
    const result = JSON.parse(data);
    requireThat(Array.isArray(result), 'Wallet data must be an event array or one event per line.');
    return result;
  }
  try { const one = JSON.parse(data); return [one]; }
  catch { return data.split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l)); }
}

function inspectEnvelope(event) {
  requireThat(event && event.kind === 7376, 'Use only NIP-60 spending history (kind 7376).');
  requireThat(typeof event.id === 'string' && eventIdPattern.test(event.id), 'Each history event needs its 64-character ID.');
  requireThat(Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= 253402300799,
    'Each history event needs a Unix timestamp in seconds.');
}

function historyRow(event, tags) {
  requireThat(Array.isArray(tags), 'Decrypted spending history must be an array of tags.');
  function read(name, fallback) {
    const values = tags.filter(row => Array.isArray(row) && row[0] === name);
    if (!values.length && fallback !== undefined) return fallback;
    requireThat(values.length === 1 && typeof values[0][1] === 'string', 'Missing or repeated history tag “' + name + '”.');
    return values[0][1];
  }
  const direction = read('direction');
  requireThat(direction === 'in' || direction === 'out', 'Wallet direction must be in or out.');
  return {id:event.id, time:event.created_at, direction, amount:integerAmount(read('amount')), unit:unitOf(read('unit','sat'))};
}

export async function walletFromEvents(events, unlock) {
  for (const event of events) inspectEnvelope(event);
  const authors = new Set(events.map(e=>e.pubkey).filter(Boolean));
  requireThat(authors.size <= 1, 'Import history from one wallet at a time.');
  const seen = new Map();
  for (const event of events) {
    let tags = event.content;
    if (typeof tags === 'string') {
      if (tags.trimStart().startsWith('[')) tags = JSON.parse(tags);
      else {
        requireThat(typeof unlock === 'function', 'Encrypted events need a compatible Nostr browser signer with NIP-44.');
        tags = JSON.parse(await unlock(event));
      }
    }
    const row = historyRow(event,tags);
    const prior = seen.get(row.id);
    requireThat(!prior || ['time','direction','amount','unit'].every(k=>prior[k]===row[k]),
      'Conflicting copies of wallet event ' + row.id.slice(0, 12) + '.');
    seen.set(row.id, row);
  }
  return [...seen.values()];
}

export function signed(row) { return row.direction === 'out' ? -row.amount : row.amount; }
const ordered = (left, right) => left.time - right.time || (left.ticket ?? left.id).localeCompare(right.ticket ?? right.id);

export function reconcile(tickets, events, confirmations = new Map()) {
  const byId = new Map(events.map(e=>[e.id,e]));
  const reserved = new Set(tickets.map(t=>t.event_id).filter(Boolean));
  const freeByType = new Map(), candidates = new Map(), demand = new Map();
  const typeKey = r => [r.unit,r.direction,r.amount].join('/');
  for (const e of events) if (!reserved.has(e.id)) {
    const key = typeKey(e);
    if (!freeByType.has(key)) freeByType.set(key,{events:[]});
    freeByType.get(key).events.push(e);
  }
  for (const group of freeByType.values()) {
    group.events.sort(ordered);
    group.overlap=new Int32Array(group.events.length+1);
  }
  function lowerBound(list,time) {
    let left=0, right=list.length;
    while(left<right) {
      const mid=(left+right)>>>1;
      if(list[mid].time<time)left=mid+1;else right=mid;
    }
    return left;
  }
  for (const ticket of tickets) if (!ticket.event_id) {
    const group=freeByType.get(typeKey(ticket));
    if(!group)continue;
    const start=lowerBound(group.events,ticket.time-windowSeconds);
    const end=lowerBound(group.events,ticket.time+windowSeconds+1);
    group.overlap[start]++;group.overlap[end]--;
    candidates.set(ticket.ticket,{count:end-start, sample:group.events.slice(start,Math.min(start+5,end))});
  }
  for(const group of freeByType.values()) {
    let overlap=0;
    for(let i=0;i<group.events.length;i++) {
      overlap+=group.overlap[i];
      demand.set(group.events[i].id,overlap);
    }
  }
  const included = new Set();
  const rows = [...tickets].sort(ordered).map(t=>{
    let e = null, status = 'Missing in wallet', options = [], candidateCount=0;
    if(t.event_id) {
      e = byId.get(t.event_id) ?? null;
      if(e) {
        if(e.unit!==t.unit) status='Unit differs';
        else if(e.direction!==t.direction) status='Direction differs';
        else if(e.amount!==t.amount) status='Amount differs';
        else status='Matched';
      }
    } else {
      const potential=candidates.get(t.ticket);
      options=potential?.sample??[];candidateCount=potential?.count??0;
      if(candidateCount===1 && demand.get(options[0].id)===1) {
        e=options[0];
        status=confirmations.get(t.ticket)===e.id ? 'Confirmed' : 'Match suggested';
      } else if(options.length) status='Ambiguous';
    }
    if(e) included.add(e.id);
    return {t,e,status,options,candidateCount};
  });
  for(const e of [...events].sort(ordered)) if(!included.has(e.id)) rows.push({t:null,e,status:'Wallet only',options:[],candidateCount:0});
  const units=[...new Set([...tickets,...events].map(r=>r.unit))].sort();
  const totals=new Map(units.map(unit=>[unit,{till:0n,wallet:0n}]));
  for(const t of tickets) totals.get(t.unit).till+=signed(t);
  for(const e of events) totals.get(e.unit).wallet+=signed(e);
  return {rows,units,totals};
}

export function reportCSV(rows) {
  const headings=['ticket','ticket_time_utc','till_direction','till_unit','till_amount','wallet_event_id','wallet_time_utc','wallet_direction','wallet_unit','wallet_amount','result','candidate_count','candidate_ids_first_5'];
  function safe(value) {
    let s=String(value??'');
    if (/^[\s]*[=+@-]/.test(s)) s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';
  }
  const iso=r=>r?new Date(r.time*1000).toISOString():'';
  return [headings,...rows.map(({t,e,status,options,candidateCount})=>[t?.ticket,iso(t),t?.direction,t?.unit,t?.amount,e?.id,iso(e),e?.direction,e?.unit,e?.amount,status,candidateCount,options.map(x=>x.id).join(' ')])].map(line=>line.map(safe).join(',')).join('\r\n')+'\r\n';
}
