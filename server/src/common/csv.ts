export class CsvError extends Error {}

/**
 * RFC 4180 CSV parser: quoted fields, "" escapes, embedded newlines, CRLF or LF, UTF-8 BOM.
 * Blank lines are skipped. Throws CsvError on malformed or oversized input.
 * `maxRows` counts data rows (the header is extra).
 */
export function parseCsv(input: string, limits: { maxRows: number; maxColumns?: number }): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const maxColumns = limits.maxColumns ?? 50;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const pushField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    const blank = row.length === 1 && row[0] === '';
    if (!blank) {
      if (row.length > maxColumns) throw new CsvError(`Too many columns (maximum ${maxColumns})`);
      rows.push(row);
      if (rows.length > limits.maxRows + 1) throw new CsvError(`Too many rows (maximum ${limits.maxRows})`);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\r') {
      if (text.charAt(i + 1) === '\n') i++;
      pushRow();
    } else if (c === '\n') {
      pushRow();
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field');
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

// Cells that start with these characters can be executed as formulas by spreadsheet programs.
const FORMULA_START = /^[=+\-@\t\r]/;

/** Escapes quotes/delimiters and neutralizes formula injection by prefixing an apostrophe. */
export function csvCell(value: string): string {
  let v = FORMULA_START.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export const toCsv = (rows: string[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
