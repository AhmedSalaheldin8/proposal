#!/usr/bin/env node
/**
 * acceptance_test.js — the "done" gate from the build brief.
 *
 * Replays a past inquiry (printed BOQ specs only, exactly what
 * parse_inquiry.md would extract) through matcher.js against master.json,
 * then compares AUTO results with the codes actually quoted by hand.
 *
 * Pass criteria:
 *   1. AUTO lines agree with the actually-quoted code on >= 85% of lines.
 *   2. No candidate at any rank has an IP lower than the line's required IP.
 *
 * Usage: node acceptance_test.js [source_quote_id]
 *        (default: 2026-06-29_alam-al-idaa_residential)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { matchInquiry } = require('./matcher');

const QUOTE_ID = process.argv[2] || '2026-06-29_alam-al-idaa_residential';

const master = JSON.parse(fs.readFileSync(path.join(__dirname, 'master.json'), 'utf8'));

// Expected code per line = what was actually handwritten (after Same-as
// resolution), taken from the master rows of this quote.
const expected = new Map();
for (const row of master) {
  if (row.source_quote === QUOTE_ID) expected.set(row.line_id, row.internal_code);
}
if (expected.size === 0) {
  console.error(`No master rows for source_quote "${QUOTE_ID}"`);
  process.exit(2);
}

// Rebuild the inquiry line items from the PRINTED spec only (no handwriting).
const extraction = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'data', 'extracted', QUOTE_ID + '.json'), 'utf8'));

const items = [];
for (const line of extraction.lines) {
  if (!expected.has(line.line_id)) continue; // line never entered master (e.g. supplier-coded)
  items.push({
    _line_id: line.line_id,
    description: [line.spec.type, line.spec.material].filter(Boolean).join(' — '),
    type: line.spec.type,
    watt: line.spec.watt, lumen: line.spec.lumen, cct: line.spec.cct,
    cri: line.spec.cri, ip: line.spec.ip, mounting: line.spec.mounting,
    diameter_mm: line.spec.diameter_mm, height_mm: line.spec.height_mm,
    length_mm: line.spec.length_mm, width_mm: line.spec.width_mm,
    qty: line.qty, location: line.location, raw_ref: null
  });
}

const results = matchInquiry(items, master);

let autoTotal = 0, autoAgree = 0, ipViolations = 0;
const statusCount = { AUTO: 0, REVIEW: 0, MANUAL: 0 };
const misses = [];

for (const r of results) {
  const want = expected.get(r.item._line_id);
  statusCount[r.status]++;

  for (const c of r.candidates) {
    const reqIp = r.item.ip, candIp = c.row.ip;
    if (reqIp !== null && candIp !== null && Number(candIp) < Number(reqIp)) {
      ipViolations++;
      console.error(`IP VIOLATION: ${r.item._line_id} requires IP${reqIp}, proposed ${c.code} is IP${candIp}`);
    }
  }

  if (r.status === 'AUTO') {
    autoTotal++;
    if (r.candidates[0].code === want) autoAgree++;
    else misses.push({ line: r.item._line_id, want, got: r.candidates[0].code, score: r.candidates[0].score });
  } else {
    misses.push({ line: r.item._line_id, want, got: `(${r.status})` + (r.candidates[0] ? ` top=${r.candidates[0].code}@${r.candidates[0].score}` : ' no candidate'), score: null });
  }
}

const agreePct = autoTotal ? (100 * autoAgree / autoTotal) : 0;
const coveragePct = 100 * autoTotal / results.length;

console.log(`\nAcceptance test — inquiry: ${QUOTE_ID}`);
console.log(`  lines replayed:        ${results.length}`);
console.log(`  status:                AUTO ${statusCount.AUTO} · REVIEW ${statusCount.REVIEW} · MANUAL ${statusCount.MANUAL}`);
console.log(`  AUTO coverage:         ${coveragePct.toFixed(1)}% of lines`);
console.log(`  AUTO agreement:        ${autoAgree}/${autoTotal} = ${agreePct.toFixed(1)}%  (required >= 85%)`);
console.log(`  IP violations:         ${ipViolations}  (required 0)`);

if (misses.length) {
  console.log(`\n  Non-agreeing / non-AUTO lines:`);
  for (const m of misses) console.log(`   - ${m.line}: quoted ${m.want}, matcher ${m.got}`);
}

const pass = agreePct >= 85 && ipViolations === 0;
console.log(`\n  RESULT: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
