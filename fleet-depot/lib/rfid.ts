export interface RfidRow {
  idTag: string;
  driverName: string;
  email?: string;
}

export interface RfidParseResult {
  rows: RfidRow[];
  errors: { line: number; message: string }[];
}

// OCPP 1.6 idTag is CiString20.
const TAG = /^[A-Za-z0-9_-]{1,20}$/;

function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";") (cells.push(cur.trim()), (cur = ""));
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse "idTag,driverName[,email]" CSV. A header row is detected and skipped. */
export function parseRfidCsv(text: string): RfidParseResult {
  const rows: RfidRow[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let first = true;
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    if (!raw.trim()) return;
    const cells = splitLine(raw);
    if (first) {
      first = false;
      if (/^(id_?tag|tag|card|rfid)/i.test(cells[0])) return;
    }
    const [idTag, driverName, email] = cells;
    if (!idTag || !TAG.test(idTag))
      return void errors.push({
        line,
        message: `invalid idTag "${idTag ?? ""}"`,
      });
    if (!driverName)
      return void errors.push({ line, message: "missing driver name" });
    if (email && !/^[^@\s]+@[^@\s]+$/.test(email))
      return void errors.push({ line, message: `invalid email "${email}"` });
    const key = idTag.toUpperCase();
    if (seen.has(key))
      return void errors.push({ line, message: `duplicate idTag "${idTag}"` });
    seen.add(key);
    rows.push({ idTag, driverName, ...(email ? { email } : {}) });
  });
  return { rows, errors };
}
