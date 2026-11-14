/** CSV / Excel-compatible export and CSV import helpers. */

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows: array of arrays (first row = headers). */
export const toCSV = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n');

/** Minimal RFC-4180 parser: returns array of arrays. */
export function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const xml = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Excel 2003 XML spreadsheet (opens directly in Excel / LibreOffice, keeps numbers as numbers). */
export function toExcelXml(rows, sheetName = 'Report') {
  const body = rows.map((r, i) => `<Row>${r.map((v) => {
    const isNum = typeof v === 'number' && Number.isFinite(v);
    return `<Cell${i === 0 ? ' ss:StyleID="h"' : ''}><Data ss:Type="${isNum ? 'Number' : 'String'}">${xml(v)}</Data></Cell>`;
  }).join('')}</Row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>`
    + `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`
    + `<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>`
    + `<Worksheet ss:Name="${xml(sheetName.slice(0, 30))}"><Table>${body}</Table></Worksheet></Workbook>`;
}

/** Trigger a browser download. */
export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export const downloadCSV = (name, rows) => download(`${name}.csv`, `﻿${toCSV(rows)}`, 'text/csv;charset=utf-8');
export const downloadExcel = (name, rows) => download(`${name}.xls`, toExcelXml(rows, name), 'application/vnd.ms-excel');
