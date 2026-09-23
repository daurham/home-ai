import { SLOT_IDS, SLOT_LAYOUT } from './rawSchema.js';

export const WHOLE_PAGE_PROMPT = `This image is a completed printed Routine B workout log.

Extract ONLY handwritten marks. Ignore printed titles, exercise names, target ranges, and instructions.

Rules:
- Blank cell → null. Do not fill it in.
- Do not inherit weights. If a later set's weight cell is empty, weight is null even if a previous set has a weight.
- Do not name exercises or invent template versions.
- Weight: a number, the letters BW, or null.
- Effort: the circled number in 1-5.
- Pain: the circled number in 0-3.
- date_written: copy the date cell exactly as written text, or null if blank.
- bodyweight: the number in the body wt cell, or null.
- note: the handwritten quick note, or null.

Tables:
- B01, B02, B03, B04, B06: rows of { "weight", "reps" }. Include a row only if it has any handwriting.
- B05: rows of { "weight", "left", "right" } for the L and R columns.
- B07: rows of { "weight", "left_sec", "right_sec" } for L sec and R sec.

Return JSON only.`;

export const WHOLE_PAGE_PROMPT_POC3 = `This image is a completed printed Routine B workout log. You are a literal cell reader.

Copy ONLY handwritten ink. Printed titles, printed set numbers 1/2/3, printed column headers, printed "Target: …" lines, and printed effort/pain scales are not answers.

Page layout, top to bottom:
- Header: Date, Body wt, Duration; then Effort 1-5, Pain 0-3, Pain area.
- B-S1: table B01 on the LEFT (3 rows, Set / Weight / Reps) and table B02 on the RIGHT (3 rows, Set / Weight / Reps).
- B-S2: table B03 on the LEFT (3 rows, Set / Weight / Reps) and table B04 on the RIGHT (3 rows, Set / Weight / Reps).
- B-S3: table B05 on the LEFT (2 rows, Set / Weight / L / R) and table B06 on the RIGHT (2 rows, Set / Weight / Reps).
- FINISHER: table B07 (2 rows, Set / Weight / L sec / R sec).
- Quick note line at the bottom.

Hard rules:
1. Distinguish printed vs handwriting. A printed digit is not a transcribed value.
2. Process every physical printed set row independently, in order. Return exactly that many rows. Do not omit a printed row. Do not add extra rows.
3. A cell with no handwriting is JSON null. Empty means null.
4. Never inherit weight or BW. If a later row's Weight cell is blank, that row's weight is null even if an earlier row in the same table has a value.
5. Never move values between exercise tables. Numbers from B03 must not appear in B01 or B04. Each table is isolated.
6. Never infer planned/target reps as completed reps. Only handwriting inside that row's Reps, L, R, L sec, or R sec cell counts.
7. Never put a reps/time number into the weight field. Weight is only letters BW, a handwritten load number, null, or unreadable.
8. If a cell is uncertain or unreadable, return the string "unreadable". Do not guess.
9. Do not name exercises, choose template versions, normalize dates, or emit canonical workout JSON.

Header fields (strings or null):
- date_written: copy the Date cell exactly as written.
- bodyweight: copy the Body wt digits as a string.
- effort: the one circled number among printed 1 2 3 4 5.
- pain: the one circled number among printed 0 1 2 3. Do not default to 0. 0 is valid only if the digit 0 is the one with a handwritten circle.
- note: the handwritten Quick note text.

Cell strings:
- weight: "BW" if those letters are written, otherwise the handwritten digits as a string, otherwise null.
- reps, left, right, left_sec, right_sec: handwritten digits in THAT cell as a string, otherwise null.

Return JSON only.`;

export function headerPrompt() {
  return `This crop is the header of a Routine B workout log.
Extract only handwritten values:
- date_written: exact text in the Date cell, or null
- bodyweight: number in Body wt, or null
- effort: circled number from 1-5, or null
- pain: circled number from 0-3, or null
Do not infer a year. Do not return exercise data. JSON only.`;
}

export function notePrompt() {
  return `This crop is the Quick note field of a workout log.
Extract the handwritten note text, or null if blank.
JSON: { "note": string or null }
JSON only.`;
}

export function slotPrompt(slotId) {
  const layout = SLOT_LAYOUT[slotId];
  const rowShape = layout.kind === 'unilateral_reps'
    ? '{ "weight": number|"BW"|null, "left": integer|null, "right": integer|null }'
    : layout.kind === 'unilateral_time'
      ? '{ "weight": number|"BW"|null, "left_sec": number|null, "right_sec": number|null }'
      : '{ "weight": number|"BW"|null, "reps": integer|null }';
  return `This crop is table ${slotId} on a Routine B workout log.
Printed columns: ${layout.columns}.
There are ${layout.planned} printed set rows.

Extract ONLY handwritten cell values into { "rows": [ ... ] }.
Each row: ${rowShape}
If a whole row is blank, omit it.
If a weight cell is blank, use null. Do not copy a previous row's weight.
Do not name the exercise. JSON only.`;
}

export function mentionsForbiddenDomain(text) {
  const haystack = String(text || '');
  return /WORKOUT AI TRANSCRIPTION PACK|workout-record\.schema|template_version|exercise_id|load_state|schema_version/i.test(haystack);
}

export { SLOT_IDS };
