/** Formatting and small pure helpers (no DOM access). */

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const today = () => toISO(new Date());
export function toISO(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
/** Parse 'YYYY-MM-DD' as a local date (midnight). */
export function parseISO(s) {
  if (!s || typeof s !== 'string') return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
export function daysBetween(a, b) {
  const da = typeof a === 'string' ? parseISO(a) : a;
  const db = typeof b === 'string' ? parseISO(b) : b;
  if (!da || !db) return null;
  return Math.round((db - da) / 86400000);
}
export const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(v) {
  if (!v) return '—';
  const d = typeof v === 'number' ? new Date(v) : parseISO(v);
  if (!d || Number.isNaN(d.getTime())) return String(v);
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${fmtDate(ts)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(ts);
}

export const round = (n, dp = 3) => { const f = 10 ** dp; return Math.round((Number(n) || 0) * f) / f; };
export const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
export function fmtQty(n) {
  if (n === null || n === undefined || n === '') return '—';
  return round(n, 3).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}
let currency = 'INR';
export const setCurrency = (c) => { currency = c || 'INR'; };
export function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n) || 0);
  } catch { return `${currency} ${round(n, 2)}`; }
}
export const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
export const sum = (list, fn) => list.reduce((a, x) => a + (Number(typeof fn === 'function' ? fn(x) : x[fn]) || 0), 0);
export const groupBy = (list, fn) => list.reduce((m, x) => { const k = typeof fn === 'function' ? fn(x) : x[fn]; (m[k] ||= []).push(x); return m; }, {});
export const uniq = (list) => [...new Set(list)];
export const byKey = (key, dir = 1) => (a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0);
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const truncate = (s, n = 80) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

/** Errors that carry a message meant for the person using the app. */
export class AppError extends Error {
  constructor(message, detail) { super(message); this.name = 'AppError'; this.detail = detail; }
}
