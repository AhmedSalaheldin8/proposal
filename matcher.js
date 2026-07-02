/**
 * matcher.js — Step 3 of the IST Light code matcher.
 *
 * matchInquiry(items, master) — deterministic, no LLM, runs in the browser
 * (plain <script src="matcher.js">) and in Node (require('./matcher')).
 *
 * items:  array of inquiry line items (schema of parse_inquiry.md):
 *   { description, type, watt, lumen, cct, cri, ip, mounting,
 *     diameter_mm, height_mm, length_mm, width_mm, qty, location, raw_ref }
 * master: array of master rows (master.json / parsed master.csv):
 *   { internal_code, type, watt, lumen, cct, cri, ip, mounting,
 *     diameter_mm, height_mm, length_mm, width_mm, price, price_unit, ... }
 *
 * HARD filters (candidate excluded on failure, unknown inquiry value = pass):
 *   - IP:       candidate.ip >= required ip. If the inquiry requires more
 *               than IP20 and the candidate's IP is unknown, the candidate
 *               is EXCLUDED (never propose a possibly-lower IP).
 *   - mounting: canonical mounting sets must intersect when both known.
 *   - type:     canonical type category must match when both known
 *               (downlight fixed vs adjustable are distinct when both known).
 *   - watt:     within ±15% of required.
 *   - lumen:    within ±15% of required.
 *
 * SOFT score 0..100 (weighted mean over attributes known on BOTH sides;
 * unknown attributes are excluded from the mean — neutral, not a penalty):
 *   CCT exact 30 · CRI 10 · watt closeness 20 · lumen closeness 20 ·
 *   dimensions closeness 20.
 *
 * Returns per line: top 3 candidate codes, each with score + confidence
 * (HIGH ≥ 75, MEDIUM ≥ 50, LOW < 50) and a line status:
 * AUTO (top is HIGH), REVIEW (top is MEDIUM), MANUAL (LOW or no candidate).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Matcher = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOLERANCE = { watt: 0.15, lumen: 0.15, dims: 0.25 };
  const WEIGHTS = { cct: 30, cri: 10, watt: 20, lumen: 20, dims: 20 };
  const THRESHOLDS = { high: 75, medium: 50 };

  // ---- canonicalisation -------------------------------------------------

  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);

  /** Canonical fixture category from free-form type text. Order matters. */
  function typeCategory(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    if (/high[\s-]?bay/.test(t)) return 'highbay';
    if (/street/.test(t)) return 'street';
    if (/flood/.test(t)) return 'flood';
    if (/strip|led flex|grazer/.test(t)) return 'strip';
    if (/panel/.test(t)) return 'panel';
    if (/triproof|batten|linear/.test(t)) return 'linear';
    if (/inground|in-ground/.test(t)) return 'inground';
    if (/underwater|pool/.test(t)) return 'underwater';
    if (/step light|recessed wall|recessed led wall/.test(t)) return 'wall_recessed';
    if (/wall/.test(t)) return 'wall_surface';
    if (/downlight|down light|spotlight|spot light/.test(t)) return 'downlight';
    if (/chandelier|pendant|bulb/.test(t)) return 'decorative';
    if (/ceiling/.test(t)) return 'ceiling';
    if (/marker/.test(t)) return 'wall_surface';
    return 'other';
  }

  /** true / false / null(unknown) — adjustable downlight subtype. */
  function isAdjustable(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    if (/adjustable/.test(t)) return true;
    if (/fixed/.test(t)) return false;
    return null;
  }

  /** Canonical mounting set from free text (handles "surface/suspended"). */
  function mountingSet(text, typeText) {
    const out = new Set();
    const scan = s => {
      if (!s) return;
      const t = String(s).toLowerCase();
      if (/recess/.test(t)) out.add('recessed');
      if (/surface/.test(t)) out.add('surface');
      if (/suspend|pendant|high-mast|highbay/.test(t)) out.add('suspended');
      if (/wall/.test(t)) out.add('wall');
      if (/pole|mast|bracket/.test(t)) out.add('pole');
      if (/inground/.test(t)) out.add('inground');
      if (/underwater/.test(t)) out.add('underwater');
    };
    scan(text);
    if (out.size === 0) {
      // fall back to hints in the type description
      const t = String(typeText || '').toLowerCase();
      if (/recessed/.test(t)) out.add('recessed');
      if (/surface/.test(t)) out.add('surface');
      if (/wall mounted|wall light/.test(t)) out.add('wall');
    }
    // 'recessed-wall' style values contribute both; that's fine — the type
    // category already separates wall-recessed from ceiling-recessed.
    return out.size ? out : null;
  }

  function withinPct(candidate, required, pct) {
    return Math.abs(candidate - required) <= required * pct + 1e-9;
  }

  /** closeness 1 at exact, 0 at the tolerance edge */
  function closeness(candidate, required, pct) {
    const rel = Math.abs(candidate - required) / (required || 1);
    return Math.max(0, 1 - rel / pct);
  }

  // ---- hard filters -----------------------------------------------------

  function passesHardFilters(item, row) {
    const reqIp = num(item.ip), candIp = num(row.ip);
    if (reqIp !== null) {
      if (candIp === null) { if (reqIp > 20) return false; }
      else if (candIp < reqIp) return false;
    }

    const itemCat = typeCategory(item.type || item.description);
    const rowCat = typeCategory(row.type);
    if (itemCat && rowCat && itemCat !== 'other' && rowCat !== 'other' && itemCat !== rowCat) return false;

    if (itemCat === 'downlight' && rowCat === 'downlight') {
      const a = isAdjustable(item.type || item.description), b = isAdjustable(row.type);
      if (a !== null && b !== null && a !== b) return false;
    }

    const im = mountingSet(item.mounting, item.type || item.description);
    const rm = mountingSet(row.mounting, row.type);
    if (im && rm && ![...im].some(m => rm.has(m))) return false;

    const reqW = num(item.watt), candW = num(row.watt);
    if (reqW !== null && candW !== null && !withinPct(candW, reqW, TOLERANCE.watt)) return false;

    const reqL = num(item.lumen), candL = num(row.lumen);
    if (reqL !== null && candL !== null && !withinPct(candL, reqL, TOLERANCE.lumen)) return false;

    return true;
  }

  // ---- soft score ---------------------------------------------------------

  function softScore(item, row) {
    let wsum = 0, ssum = 0;
    const add = (w, s) => { wsum += w; ssum += w * s; };

    const icct = num(item.cct), rcct = num(row.cct);
    if (icct !== null && rcct !== null) add(WEIGHTS.cct, icct === rcct ? 1 : 0);

    const icri = num(item.cri), rcri = num(row.cri);
    if (icri !== null && rcri !== null) add(WEIGHTS.cri, rcri >= icri ? 1 : Math.max(0, 1 - (icri - rcri) / 20));

    const iw = num(item.watt), rw = num(row.watt);
    if (iw !== null && rw !== null) add(WEIGHTS.watt, closeness(rw, iw, TOLERANCE.watt));

    const il = num(item.lumen), rl = num(row.lumen);
    if (il !== null && rl !== null) add(WEIGHTS.lumen, closeness(rl, il, TOLERANCE.lumen));

    const dims = ['diameter_mm', 'height_mm', 'length_mm', 'width_mm'];
    let dsum = 0, dn = 0;
    for (const d of dims) {
      const a = num(item[d]), b = num(row[d]);
      if (a !== null && b !== null) { dsum += closeness(b, a, TOLERANCE.dims); dn++; }
    }
    if (dn) add(WEIGHTS.dims, dsum / dn);

    return wsum ? Math.round(100 * ssum / wsum) : 50; // nothing comparable -> neutral
  }

  function confidence(score) {
    return score >= THRESHOLDS.high ? 'HIGH' : score >= THRESHOLDS.medium ? 'MEDIUM' : 'LOW';
  }

  // ---- main ---------------------------------------------------------------

  /**
   * @returns array (one entry per inquiry item):
   * { item, status: 'AUTO'|'REVIEW'|'MANUAL',
   *   candidates: [{ code, score, confidence, price, price_unit,
   *                  price_conflict, prices_seen, row }] (top 3) }
   */
  function matchInquiry(items, master) {
    return items.map(item => {
      const survivors = master.filter(row => row.internal_code && passesHardFilters(item, row));

      // best row per code (highest score; deterministic tiebreak on line order)
      const byCode = new Map();
      for (const row of survivors) {
        const score = softScore(item, row);
        const prev = byCode.get(row.internal_code);
        if (!prev || score > prev.score) byCode.set(row.internal_code, { row, score });
      }

      // Price shown per code = the min-max range across past quotes
      // (computed once in build_master.js as price_min/price_max/
      // price_display); a single historical price just displays as itself.
      const candidates = [...byCode.entries()]
        .map(([code, best]) => {
          const r = best.row;
          const hasPrice = r.price_display !== undefined && r.price_display !== null && r.price_display !== '';
          return {
            code,
            score: best.score,
            confidence: confidence(best.score),
            price: hasPrice ? r.price_display : (r.price === '' ? null : r.price),
            price_unit: r.price_unit || null,
            price_is_range: hasPrice && r.price_min !== r.price_max,
            row: r
          };
        })
        .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code))
        .slice(0, 3);

      const top = candidates[0];
      const status = !top || top.confidence === 'LOW' ? 'MANUAL'
        : top.confidence === 'HIGH' ? 'AUTO' : 'REVIEW';

      return { item, status, candidates };
    });
  }

  /** Step-4 output shape: [{ code, qty, price, price_unit, confidence }] */
  function toQuoteRows(results) {
    return results
      .filter(r => r.candidates.length > 0)
      .map(r => ({
        code: r.candidates[0].code,
        qty: r.item.qty === undefined ? null : r.item.qty,
        price: r.candidates[0].price,
        price_unit: r.candidates[0].price_unit,
        confidence: r.candidates[0].confidence
      }));
  }

  return { matchInquiry, toQuoteRows, typeCategory, mountingSet, softScore, passesHardFilters,
    TOLERANCE, WEIGHTS, THRESHOLDS };
}));
