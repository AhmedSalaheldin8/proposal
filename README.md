# IST Light — Inquiry → Internal Code Matcher

Takes a client lighting inquiry (BOQ / RFQ) and returns **internal** product
codes + prices for faster quoting. The internal master is built from past
quotation PDFs — there is no separate price list, and supplier catalogue
codes (Romaluce / Prior / Lohuis / Disano) never enter the output.

Plain HTML/JS in the browser (no backend, no API keys); Node only for the
offline build scripts. The matcher is deterministic — same inquiry in, same
result out; the LLM is used only for text extraction (Steps 1 & 2).

## Workflow

```
past quote PDFs ──(LLM visual extraction)──▶ data/extracted/*.json
data/extracted/*.json ──(node build_master.js)──▶ master.csv + master.json +
                                                  master.data.js + conflicts.csv +
                                                  supplier_refs.csv
new inquiry ──(parse_inquiry.md, run manually in Claude Code)──▶ inquiry.json
inquiry.json + master ──(index.html / matcher.js)──▶ codes + prices + confidence
```

### Step 1 — build the master

```
node build_master.js
```

Reads `data/extracted/*.json` (one file per past quote; the current corpus is
the 17-page scan of 6 quotations, extracted line-by-line with handwriting
kept verbatim in `hw.raw`). Output:

- `master.csv` / `master.json` — one row per resolved quote line with an
  internal code: `internal_code, type, watt, lumen, cct, cri, ip, mounting,
  diameter_mm, height_mm, length_mm, width_mm, price, price_unit,
  source_quote, …`
- `master.data.js` — same rows as a `<script>`-loadable file so
  `index.html` works from `file://`.
- `conflicts.csv` — same code at different prices across quotes. **Nothing
  is auto-picked**; resolve these by hand. Currently flagged:
  `L-NSCF-1005` (55 vs 65), `CLMI-5W` (25 vs 30), `MFL-215` (120/110/160),
  `LT` (130 for 19W vs 230 for 24W — two lengths of the same profile).
- `supplier_refs.csv` — lines you answered with supplier catalogue codes
  (Disano-style numerics, Vyrtech, NULTY+ landscape gear). Kept for
  reference, excluded from the master.

"Same as X" / "Same C" / checkmark-only lines are resolved **within each
document** via the printed fixture-type letter or an explicit line
reference. Unresolvable references (rows physically cut off in the scan)
are printed at build time, never silently dropped.

### Step 2 — parse a new inquiry

Run `parse_inquiry.md` manually in Claude Code on the client document. It
extracts a JSON array of line items only — no codes, no prices, `null` for
anything unstated, "Same as X" text kept in `raw_ref`.

### Step 3 — match

Open `index.html` in a browser, paste the inquiry JSON, click *Match*.
Per line: top 3 candidate codes, each with a score and a HIGH / MEDIUM / LOW
confidence, plus a line status:

- **AUTO** — top candidate is HIGH; safe to take.
- **REVIEW** — top candidate is MEDIUM; check before quoting.
- **MANUAL** — nothing passed, or only LOW; pick by hand.

Hard filters (candidate excluded on failure): candidate IP ≥ required IP
(a candidate with unknown IP is excluded whenever the inquiry requires more
than IP20), mounting matches, fixture type matches (fixed vs adjustable
downlights are distinct), watt within ±15%, lumen within ±15%. Soft score
0–100 over attributes known on both sides (CCT exact ×30, CRI ×10, watt ×20,
lumen ×20, dimensions ×20); unknown values are neutral, never a penalty.

The output box gives quote-ready rows —
`[{ code, qty, price, price_unit, confidence }]` — as copyable JSON or CSV.
Wiring this into AutoQuote is deferred until its input format is provided
(Step 4 of the brief).

## Acceptance test

```
node acceptance_test.js                                # Alam Al Idaa (default)
node acceptance_test.js adce_mz47-plot-c76_villa
node acceptance_test.js dewan_fountain-view-saadiyat
```

Replays a past inquiry (printed specs only) and compares AUTO results with
the codes actually quoted by hand. Gate: ≥ 85% AUTO agreement and zero
lower-IP proposals. Current numbers:

| Inquiry | Lines | AUTO agreement | IP violations |
|---|---|---|---|
| Alam Al Idaa residential | 73 | 72/73 = **98.6%** | 0 |
| ADCE MZ47 Plot-C76 villa | 12 | 12/12 = **100%** | 0 |
| Dewan Fountain View Saadiyat | 4 | 4/4 = **100%** | 0 |

The single Alam Al Idaa miss (line A-16) is a spot where the handwriting
itself is inconsistent: the 7W/840lm TYPE-B spec is priced as `FX-08 30Đ`
everywhere else in the same document, but that one line says
`WP203-10W 35Đ`; the matcher proposes the spec-consistent `FX-08`.

## Known reading ambiguities (flagged `uncertain` in the extraction)

- egis Jumeirah page: red-pen second-pass edits tangle the `MFL-112` /
  `MFL-215` wattages and prices (rows E-01…E-03); `Same L1` references a row
  cut off at the top of the scan.
- `SP-9083C` on the 4BR-villa page is assumed to be `SP-9082C` (every other
  occurrence); flagged, not silently merged.
- Industrial BOQ page 7 is photographed at an angle; several supplier code
  digits are uncertain (they don't enter the master anyway).

## Repo layout

```
data/extracted/       per-quote extraction JSON (input to build_master)
build_master.js       Step 1 — master + conflicts builder (Node)
parse_inquiry.md      Step 2 — extraction prompt (run manually)
matcher.js            Step 3 — deterministic matcher (browser + Node)
index.html            Step 3 — UI (open directly, no server needed)
acceptance_test.js    the "done" gate (Node)
master.csv|json|data.js, conflicts.csv, supplier_refs.csv   generated
```
