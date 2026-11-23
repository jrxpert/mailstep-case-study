// Minimal RFC 4180 CSV parser: quoted fields, "" escapes, commas/newlines inside quotes, CRLF, BOM.
// Enough for labels.csv (notes contain quoted commas); avoids a dependency.

export function parseCsv(text: string): string[][] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      if (field !== "") throw new Error(`unexpected quote inside unquoted field (row ${rows.length + 1})`);
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error("unterminated quoted field at end of file");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A single empty line (e.g. blank line at EOF) is not a data row.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
