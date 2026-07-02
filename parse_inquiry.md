# parse_inquiry — extraction prompt (Step 2)

Run this prompt manually in Claude Code on a new client inquiry (BOQ / RFQ /
luminaire schedule — pasted text, PDF, or scan). It performs **extraction
only**. Copy everything below the line into the session together with the
inquiry document.

---

You are extracting lighting fixture line items from a client inquiry
(BOQ / RFQ / luminaire specification schedule). Extraction ONLY:

- Do NOT propose, guess, or match any product code.
- Do NOT propose or estimate any price.
- Do NOT invent data: any value not stated in the document is `null`.
- Do NOT resolve "Same as X" / "Same C" / "refer type X" references —
  copy the reference text verbatim into `raw_ref`.

Output a single JSON array, one object per fixture line item, in document
order, using exactly this schema:

```json
{
  "description": "verbatim (or lightly cleaned) fixture description text",
  "type": "fixture type as stated, e.g. 'Indoor - Downlight (fixed, with trim)'",
  "watt": 10,
  "lumen": 1200,
  "cct": 3000,
  "cri": 90,
  "ip": 65,
  "mounting": "recessed | surface | suspended | wall | pole | inground | underwater (as stated or clearly implied by the type text; else null)",
  "diameter_mm": 83,
  "height_mm": 52,
  "length_mm": null,
  "width_mm": null,
  "qty": 4,
  "location": "TOILET",
  "raw_ref": null
}
```

Field rules:

- **watt / lumen / cct / cri / ip**: numbers only. "3000K" → `3000`;
  "CRI 90+" → `90`; "IP65" → `65`; "SOOOK" is a common OCR/typo for
  5000K → `5000`. If a range or two values are given, use the stated
  nominal one; if genuinely ambiguous, use `null`.
- **Dimensions**: millimetres. "Ø83mm x H52mm" → `diameter_mm: 83,
  height_mm: 52`. "L1190mm x W65mm x H71mm" → length/width/height.
  600x600 panels → `length_mm: 600, width_mm: 600`.
- **mounting**: derive only from explicit words ("Recessed", "Surface
  mounted", "Wall mounted", "suspended", "pole", "10M pole" → pole).
  A "Downlight (fixed, with trim)" is `recessed`; a "Ceiling Light" that is
  not marked recessed is `surface`; a "Panel light 600x600 recessed" is
  `recessed`; a "Triproof" is `surface`. If unclear → `null`.
- **qty**: the quantity for the line. If the document gives per-building or
  per-unit quantities, one line item per BOQ row as printed — do not
  aggregate rows yourself. Unit other than pieces (e.g. metres of strip):
  still put the number in `qty` and mention the unit in `description`
  (e.g. "27 mtr total").
- **location**: the room/area column if present, else `null`.
- **raw_ref**: any cross-reference text on the line ("Same as D2",
  "Same C", "refer LT-2", fixture reference letters like "Type K") —
  verbatim. Otherwise `null`.
- Client catalogue references (e.g. "X-EC-6140BA-K40", "Sylvania",
  fixture ref letters "GF-1") belong in `description`, never in a code
  field — there is no code field, and you must not create one.

Return ONLY the JSON array (no commentary), so the output can be saved
directly as `inquiry.json` and loaded into the matcher UI (`index.html`)
or `acceptance_test.js`.
