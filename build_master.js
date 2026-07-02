#!/usr/bin/env node
/**
 * build_master.js — Step 1 of the IST Light code matcher.
 *
 * Reads data/extracted/*.json (quote lines extracted from past quotation
 * PDFs) and writes:
 *   master.csv     — one row per resolved quote line with an INTERNAL code
 *   master.json    — same rows as JSON (consumed by matcher.js / index.html)
 *   conflicts.csv  — codes that appear at different prices across quotes
 *   supplier_refs.csv — lines answered with supplier catalogue codes
 *                       (never enter the master; kept for reference)
 *
 * Rules implemented:
 *  - "Same as X" / "Same C" / checkmark-only lines are resolved WITHIN the
 *    same document: first by explicit line reference (LINE <id>), then by
 *    TYPE letter (the printed fixture-type letter reused across sections).
 *    Unresolvable references are reported, never silently dropped.
 *  - price_unit is carried through ("PC" or "MTR").
 *  - Conflicting prices for the same code are ALL written to master.csv and
 *    additionally listed in conflicts.csv for manual resolution.
 *  - Supplier-numeric codes (code_type === "supplier") never enter master.
 *
 * Usage: node build_master.js [extractedDir] [outDir]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const extractedDir = process.argv[2] || path.join(__dirname, 'data', 'extracted');
const outDir = process.argv[3] || __dirname;

const SPEC_FIELDS = ['watt', 'lumen', 'cct', 'cri', 'ip', 'mounting',
  'diameter_mm', 'height_mm', 'length_mm', 'width_mm'];

function loadQuotes(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Resolve "Same as X" style references within one document. */
function resolveSameRefs(quote, report) {
  // Index lines that carry their own code, by line_id and by type_letter.
  const byLineId = new Map();
  const byTypeLetter = new Map();
  for (const line of quote.lines) {
    if (line.hw && line.hw.code) {
      byLineId.set(line.line_id, line);
      if (line.type_letter) {
        // Index both the full label and its leading token, so "Same LA.A4"
        // resolves a line labelled "LA.A4 (Arpool S)".
        for (const key of [line.type_letter, line.type_letter.split(/[\s(]/)[0]]) {
          if (key && !byTypeLetter.has(key)) byTypeLetter.set(key, line);
        }
      }
    }
  }

  for (const line of quote.lines) {
    if (line.hw.code || !line.hw.same_ref) continue;
    const ref = line.hw.same_ref;
    let target = null;
    const lineMatch = ref.match(/^LINE\s+(.+)$/i);
    const typeMatch = ref.match(/^TYPE\s+(.+)$/i);
    if (lineMatch) {
      target = byLineId.get(lineMatch[1].trim()) || null;
    } else if (typeMatch) {
      target = byTypeLetter.get(typeMatch[1].trim()) || null;
    }
    if (target) {
      line.hw.code = target.hw.code;
      line.hw.code_type = target.hw.code_type;
      line.hw.price = target.hw.price;
      line.hw.price_unit = target.hw.price_unit;
      line.resolved_from = { ref, via: target.line_id };
    } else {
      report.unresolved.push({
        source_quote: quote.source_quote,
        line_id: line.line_id,
        ref,
        raw: line.hw.raw
      });
    }
  }
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map(c => csvEscape(r[c])).join(','));
  return lines.join('\n') + '\n';
}

function main() {
  const quotes = loadQuotes(extractedDir);
  const report = { unresolved: [] };

  const masterRows = [];
  const supplierRows = [];

  for (const quote of quotes) {
    resolveSameRefs(quote, report);
    for (const line of quote.lines) {
      const hw = line.hw;
      if (!hw.code) continue; // unresolved / no annotation — reported above
      const row = {
        internal_code: hw.code,
        type: line.spec.type,
        watt: line.spec.watt,
        lumen: line.spec.lumen,
        cct: line.spec.cct,
        cri: line.spec.cri,
        ip: line.spec.ip,
        mounting: line.spec.mounting,
        diameter_mm: line.spec.diameter_mm,
        height_mm: line.spec.height_mm,
        length_mm: line.spec.length_mm,
        width_mm: line.spec.width_mm,
        price: hw.price,
        price_unit: hw.price_unit,
        addons: hw.addons || '',
        source_quote: quote.source_quote,
        line_id: line.line_id,
        resolved_from: line.resolved_from ? line.resolved_from.ref + ' via ' + line.resolved_from.via : '',
        uncertain: hw.uncertain ? 'yes' : '',
        raw_annotation: hw.raw
      };
      if (hw.code_type === 'supplier') supplierRows.push(row);
      else masterRows.push(row);
    }
  }

  // Price ranging: same internal code, same price_unit/addons, different
  // price across quotes. Rather than picking one price or blocking on
  // manual resolution, every row in the group gets a price_min/price_max/
  // price_display (e.g. "25-35") so the matcher and UI can show a range.
  // conflicts.csv still lists the underlying occurrences for audit.
  const priceGroups = new Map();
  for (const row of masterRows) {
    if (row.price === null || row.price === undefined) continue;
    const key = [row.internal_code, row.price_unit, row.addons || ''].join('|');
    if (!priceGroups.has(key)) priceGroups.set(key, []);
    priceGroups.get(key).push(row);
  }
  const conflictRows = [];
  for (const [key, rows] of priceGroups) {
    const prices = [...new Set(rows.map(r => r.price))];
    const min = Math.min(...prices), max = Math.max(...prices);
    const display = min === max ? String(min) : `${min}-${max}`;
    for (const r of rows) {
      r.price_min = min;
      r.price_max = max;
      r.price_display = display;
    }
    if (prices.length > 1) {
      for (const r of rows) {
        conflictRows.push({
          internal_code: r.internal_code,
          price_unit: r.price_unit,
          addons: r.addons,
          price: r.price,
          price_range: display,
          source_quote: r.source_quote,
          line_id: r.line_id,
          all_prices_seen: prices.join(' / '),
          raw_annotation: r.raw_annotation
        });
      }
    }
  }

  const masterColumns = ['internal_code', 'type', 'watt', 'lumen', 'cct', 'cri', 'ip',
    'mounting', 'diameter_mm', 'height_mm', 'length_mm', 'width_mm',
    'price', 'price_min', 'price_max', 'price_display', 'price_unit', 'addons',
    'source_quote', 'line_id', 'resolved_from', 'uncertain', 'raw_annotation'];
  const conflictColumns = ['internal_code', 'price_unit', 'addons', 'price',
    'price_range', 'source_quote', 'line_id', 'all_prices_seen', 'raw_annotation'];

  fs.writeFileSync(path.join(outDir, 'master.csv'), toCsv(masterRows, masterColumns));
  fs.writeFileSync(path.join(outDir, 'master.json'), JSON.stringify(masterRows, null, 2));
  // Loadable via <script> so index.html works from file:// with no backend.
  fs.writeFileSync(path.join(outDir, 'master.data.js'),
    'window.MASTER = ' + JSON.stringify(masterRows) + ';\n');
  fs.writeFileSync(path.join(outDir, 'conflicts.csv'), toCsv(conflictRows, conflictColumns));
  fs.writeFileSync(path.join(outDir, 'supplier_refs.csv'), toCsv(supplierRows, masterColumns));

  const codes = new Set(masterRows.map(r => r.internal_code));
  console.log(`master.csv        ${masterRows.length} rows, ${codes.size} distinct internal codes`);
  console.log(`conflicts.csv     ${conflictRows.length} rows (${new Set(conflictRows.map(r => r.internal_code)).size} codes with a price range — shown as min-max, not manually resolved)`);
  console.log(`supplier_refs.csv ${supplierRows.length} rows (excluded from master)`);
  if (report.unresolved.length) {
    console.log(`\nUNRESOLVED "Same as X" references (${report.unresolved.length}) — fix the extraction or resolve manually:`);
    for (const u of report.unresolved) {
      console.log(`  - ${u.source_quote} ${u.line_id}: "${u.ref}" (${u.raw})`);
    }
  }
}

main();
