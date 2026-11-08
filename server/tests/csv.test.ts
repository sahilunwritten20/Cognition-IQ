import { describe, expect, it } from 'vitest';
import { CsvError, csvCell, parseCsv, toCsv } from '../src/common/csv';
import { deriveKey } from '../src/common/crypto';

const limits = { maxRows: 100 };

describe('parseCsv', () => {
  it('parses simple rows with LF and CRLF, with or without a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n', limits)).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2', limits)).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('', limits)).toEqual([]);
  });

  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    expect(parseCsv('"Patil, Asha","say ""hi""","line1\nline2"\n', limits)).toEqual([['Patil, Asha', 'say "hi"', 'line1\nline2']]);
  });

  it('keeps a quote in the middle of an unquoted field literally', () => {
    expect(parseCsv('5" pipe,x', limits)).toEqual([['5" pipe', 'x']]);
  });

  it('strips a UTF-8 BOM and skips blank lines', () => {
    expect(parseCsv('\uFEFFa,b\n\n1,2\n\n', limits)).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,\n', limits)).toEqual([['a', '', 'c'], ['', '', '']]);
  });

  it('rejects unterminated quotes, too many rows and too many columns', () => {
    expect(() => parseCsv('a,"b\n1,2', limits)).toThrow(CsvError);
    expect(() => parseCsv('h\n1\n2\n3', { maxRows: 2 })).toThrow(/Too many rows/);
    expect(() => parseCsv('h\n1\n2', { maxRows: 2 })).not.toThrow(); // header + 2 data rows is allowed
    expect(() => parseCsv('a,b,c', { maxRows: 5, maxColumns: 2 })).toThrow(/Too many columns/);
  });
});

describe('toCsv / csvCell', () => {
  it('neutralizes spreadsheet formula injection', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', "=HYPERLINK(\"http://evil\")"]) {
      expect(csvCell(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('safe')).toBe('safe');
    expect(csvCell('a-b')).toBe('a-b'); // only a LEADING character is dangerous
  });

  it('quotes delimiters, quotes and newlines and round-trips through the parser', () => {
    const rows = [['a', 'b,c', 'd"e'], ['line1\nline2', '', 'x']];
    expect(parseCsv(toCsv(rows), limits)).toEqual(rows);
    expect(toCsv([['x']])).toBe('x\r\n');
  });
});

describe('deriveKey', () => {
  const master = 'ab'.repeat(32);
  it('is deterministic, 64 hex chars, label-separated and different from the master', () => {
    const a = deriveKey(master, 'one');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveKey(master, 'one')).toBe(a);
    expect(deriveKey(master, 'two')).not.toBe(a);
    expect(a).not.toBe(master);
  });
});
