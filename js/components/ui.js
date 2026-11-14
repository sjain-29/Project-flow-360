/** Small UI toolkit: escaping, badges, tables, modal dialogs, forms, toasts. No framework. */
import { icon } from './icons.js';
import { esc, fmtDate, fmtDateTime, fmtMoney, fmtQty, AppError, pct } from '../utils/format.js';
import { store } from '../services/store.js';

export { esc, icon };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ badges */
const TONES = {
  good: ['Completed', 'Approved', 'Received', 'Received at GVT', 'Closed', 'Successful', 'Delivered', 'Accepted', 'Fully Available', 'On track', 'Fulfilled', 'Settled', 'Selected', 'Yes'],
  info: ['In Progress', 'Active', 'Issued', 'Dispatched', 'PR Raised', 'Booked', 'Scheduled', 'In Transit', 'Passed', 'Open', 'Material Prepared', 'Partially Dispatched', 'Upcoming', 'Medium'],
  warn: ['Pending Approval', 'Waiting for Approval', 'Requested', 'Created', 'Pending', 'Changes Requested', 'Partially Received', 'Partially Returned', 'Partially Available', 'Partially Accepted', 'Under Review', 'Returned – Pending Closure', 'At risk', 'Planning', 'Due soon', 'Due today', 'Retest Required', 'Reopened', 'Outstanding', 'Awaiting receipt'],
  serious: ['On Hold', 'Blocked', 'Not Available', 'High', 'Not verified'],
  crit: ['Rejected', 'Failed', 'Cancelled', 'Overdue', 'Critical', 'Reversed', 'Deactivated'],
};
const TONE_OF = Object.fromEntries(Object.entries(TONES).flatMap(([tone, list]) => list.map((s) => [s, tone])));
export const toneOf = (status) => TONE_OF[status] || '';
export const badge = (status, tone) => (status === undefined || status === null || status === '' ? '<span class="muted">—</span>' : `<span class="badge ${tone ?? toneOf(status)}">${esc(status)}</span>`);
export const meter = (frac, cls = '') => `<div class="meter ${cls}" role="img" aria-label="${pct(frac || 0)}"><i style="width:${Math.max(0, Math.min(100, (frac || 0) * 100))}%"></i></div>`;

/* ------------------------------------------------------------------ value formatting */
export function fmtValue(type, v) {
  if (v === undefined || v === null || v === '') return '<span class="muted">—</span>';
  switch (type) {
    case 'date': return esc(fmtDate(v));
    case 'ts': return esc(fmtDateTime(v));
    case 'money': return esc(fmtMoney(v));
    case 'number': return esc(fmtQty(v));
    case 'user': return esc(store.userName(v));
    case 'dept': return esc(store.deptName(v));
    case 'bool': return v ? 'Yes' : 'No';
    case 'status': return badge(v);
    case 'url': return /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v)} ${icon('external')}</a>` : esc(v);
    default: return esc(v);
  }
}

/* ------------------------------------------------------------------ tables */
/**
 * cols: [{ key, label, type, num, html: (row) => string, cls }]
 * On phones the table turns into stacked cards (each cell shows its heading).
 */
export function table({ cols, rows, href, empty = 'Nothing to show yet.', flag, select, cls = '', foot }) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const head = `${select ? '<th class="sel"><input type="checkbox" data-act="selAll" aria-label="Select all"></th>' : ''}${cols.map((c) => `<th${c.num || ['number', 'money'].includes(c.type) ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}`;
  const body = rows.map((r) => {
    const link = href ? href(r) : null;
    return `<tr${link ? ` data-href="${esc(link)}" tabindex="0"` : ''}${flag && flag(r) ? ' class="rowflag"' : ''}>${select ? `<td class="sel"><input type="checkbox" data-sel="${esc(select(r))}" aria-label="Select row"></td>` : ''}${cols.map((c) => {
      const isNum = c.num || ['number', 'money'].includes(c.type);
      const v = c.html ? c.html(r) : fmtValue(c.type, r[c.key]);
      return `<td data-label="${esc(c.label)}" class="${isNum ? 'num ' : ''}${c.cls || ''}">${v ?? ''}</td>`;
    }).join('')}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="tbl stack ${cls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`;
}

export function pageHead({ title, sub, crumbs, actions }) {
  return `<div class="pagehead"><div class="titles">${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}
export const tabsBar = (items, current, hrefOf) => `<nav class="tabs" role="tablist">${items.map(([id, label]) => `<a role="tab" href="${hrefOf(id)}" aria-selected="${id === current}">${esc(label)}</a>`).join('')}</nav>`;
export const btn = (act, label, { ic, cls = '', data = {}, title } = {}) => `<button type="button" class="btn ${cls}" data-act="${act}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}${title ? ` title="${esc(title)}"` : ''}>${ic ? icon(ic) : ''}${esc(label)}</button>`;
export const dl = (pairs) => `<dl class="dl">${pairs.filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== '').map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

/* ------------------------------------------------------------------ toasts */
export function toast(message, kind = 'ok') {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4200);
}
/** Show an error the same way everywhere. */
export function showError(e) {
  if (!(e instanceof AppError)) console.error(e);
  else if (e.detail) console.warn('Refused:', e.detail);
  toast(e instanceof AppError ? e.message : `Something went wrong: ${e?.message || e}`, 'error');
}

/* ------------------------------------------------------------------ modal */
let openModals = 0;
export const modalIsOpen = () => openModals > 0;
export function openModal({ title, body, footer, wide, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button type="button" class="iconbtn" data-close aria-label="Close">${icon('x')}</button></header><div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
  document.body.appendChild(back);
  openModals++;
  const prev = document.activeElement;
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    back.remove(); openModals--;
    document.removeEventListener('keydown', onKey);
    prev?.focus?.();
    onClose?.(result);
    if (openModals === 0) document.dispatchEvent(new CustomEvent('pf360:modalclosed'));
  };
  const onKey = (e) => { if (e.key === 'Escape' && !back.querySelector('.busy')) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back && !back.querySelector('.busy')) close(); });
  back.querySelector('[data-close]').addEventListener('click', () => close());
  // focus the first field, unless the person has already clicked or typed into the form
  setTimeout(() => { if (!back.contains(document.activeElement)) (back.querySelector('input:not([type=hidden]), select, textarea, button.primary') || back.querySelector('[data-close]'))?.focus(); }, 30);
  return { el: back, close };
}

export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, requireText }) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<p>${body}</p>${requireText ? `<div class="field"><label for="cf-text">Type <b>${esc(requireText)}</b> to confirm</label><input id="cf-text" autocomplete="off"></div>` : ''}`,
      footer: `<button type="button" class="btn" data-no>Cancel</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirmLabel)}</button>`,
      onClose: (r) => resolve(r === true),
    });
    m.el.querySelector('[data-no]').addEventListener('click', () => m.close(false));
    m.el.querySelector('[data-yes]').addEventListener('click', () => {
      if (requireText && m.el.querySelector('#cf-text').value.trim() !== requireText) { m.el.querySelector('#cf-text').focus(); return; }
      m.close(true);
    });
  });
}

/* ------------------------------------------------------------------ forms */
export const userOptions = (filter) => store.users().filter((u) => u.active !== false && (!filter || filter(u))).map((u) => [u.id, `${u.displayName} — ${store.deptName(u.departmentId)}`]);
export const deptOptions = () => store.departments().filter((d) => d.active !== false).map((d) => [d.id, d.name]);
const optionList = (f) => {
  if (f.type === 'user') return userOptions(f.filter);
  if (f.type === 'dept') return deptOptions();
  const raw = f.opts || (f.optsFrom ? store.settings()[f.optsFrom] : []) || [];
  return raw.map((o) => (Array.isArray(o) ? o : [o, o]));
};

export function fieldHtml(f, value, idPrefix = 'f') {
  const id = `${idPrefix}-${f.name}`;
  const v = value ?? f.value ?? '';
  const req = f.req ? ' <span class="req" title="Required">*</span>' : '';
  const common = `id="${id}" name="${esc(f.name)}"${f.req ? ' required' : ''}${f.disabled ? ' disabled' : ''}`;
  let input;
  switch (f.type) {
    case 'static': return `<div class="field wide">${f.label ? `<div class="lbl">${esc(f.label)}</div>` : ''}<div>${f.html}</div></div>`;
    case 'textarea': input = `<textarea ${common} rows="${f.rows || 3}" maxlength="4900" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`; break;
    case 'number': case 'money': input = `<input ${common} type="number" inputmode="decimal" step="${f.step || 'any'}"${f.neg ? '' : ' min="0"'} value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`; break;
    case 'date': input = `<input ${common} type="date" value="${esc(v)}">`; break;
    case 'password': input = `<input ${common} type="password" autocomplete="${f.autocomplete || 'new-password'}" value="">`; break;
    case 'bool': return `<div class="field ${f.wide ? 'wide' : ''}"><label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}"${v ? ' checked' : ''}${f.disabled ? ' disabled' : ''}><span>${esc(f.label)}${f.hint ? `<br><span class="hint">${esc(f.hint)}</span>` : ''}</span></label></div>`;
    case 'select': case 'user': case 'dept': case 'ref': {
      const opts = optionList(f);
      const known = opts.some(([val]) => String(val) === String(v));
      input = `<select ${common}><option value="">${esc(f.placeholder || (f.req ? 'Choose…' : '— none —'))}</option>${!known && v !== '' ? `<option value="${esc(v)}" selected>${esc(f.type === 'user' ? store.userName(v) : f.type === 'dept' ? store.deptName(v) : v)}</option>` : ''}${opts.map(([val, label]) => `<option value="${esc(val)}"${String(val) === String(v) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
      break;
    }
    case 'multi': {
      const sel = new Set(Array.isArray(v) ? v : []);
      return `<div class="field wide"><div class="lbl">${esc(f.label)}${req}</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 14px" data-multi="${esc(f.name)}">${optionList(f).map(([val, label]) => `<label class="check"><input type="checkbox" value="${esc(val)}"${sel.has(val) ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('') || '<span class="muted">Nothing to choose from yet.</span>'}</div>${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
    }
    default: input = `<input ${common} type="${f.type === 'url' ? 'url' : 'text'}" value="${esc(v)}" maxlength="${f.max || 300}" placeholder="${esc(f.placeholder || '')}"${f.autocomplete ? ` autocomplete="${f.autocomplete}"` : ' autocomplete="off"'}>`;
  }
  return `<div class="field ${f.wide || f.type === 'textarea' ? 'wide' : ''}"><label for="${id}">${esc(f.label)}${req}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
}

/** Read the values of a form built with fieldHtml(). Throws AppError on a missing required field. */
export function readForm(root, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'static') continue;
    if (f.type === 'multi') { out[f.name] = $$(`[data-multi="${f.name}"] input:checked`, root).map((i) => i.value); continue; }
    const el = root.querySelector(`[name="${f.name}"]`);
    if (!el) continue;
    if (f.type === 'bool') { out[f.name] = el.checked; continue; }
    let v = el.value.trim();
    if (f.req && v === '') { el.focus(); throw new AppError(`Enter: ${f.label}.`); }
    if (['number', 'money'].includes(f.type) && v !== '') {
      v = Number(v);
      if (Number.isNaN(v)) { el.focus(); throw new AppError(`${f.label} must be a number.`); }
      if (!f.neg && v < 0) { el.focus(); throw new AppError(`${f.label} cannot be negative.`); }
    }
    out[f.name] = v;
  }
  return out;
}

/**
 * A form in a dialog. onSubmit(values) may throw an AppError, which is shown inside the dialog.
 * Resolves with onSubmit's result (or true), or undefined when cancelled.
 */
/** Required and pre-filled fields stay in view; the remaining optional ones fold into "More details". */
function formBody(fields, values) {
  const filled = (f) => { const v = values[f.name] ?? f.value; return v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && !v.length); };
  const isMain = (f) => f.req || f.main || ['static', 'multi', 'password'].includes(f.type) || filled(f);
  const grid = (list) => `<div class="formgrid">${list.map((f) => fieldHtml(f, values[f.name])).join('')}</div>`;
  const extra = fields.filter((f) => !isMain(f));
  if (fields.length <= 5 || extra.length <= 2) return grid(fields);
  return `${grid(fields.filter(isMain))}<details class="more"><summary>More details <span class="muted">(optional · ${extra.length} fields)</span></summary>${grid(extra)}</details>`;
}

export function formModal({ title, intro, fields, values = {}, submitLabel = 'Save', onSubmit, wide, danger, successMessage }) {
  return new Promise((resolve) => {
    let done;
    const m = openModal({
      title, wide,
      body: `<form novalidate><div class="err" hidden role="alert"></div>${intro ? `<div class="note">${intro}</div>` : ''}${formBody(fields, values)}<button type="submit" hidden></button></form>`,
      footer: `<button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-submit>${esc(submitLabel)}</button>`,
      onClose: () => resolve(done),
    });
    const form = m.el.querySelector('form');
    const err = m.el.querySelector('.err');
    const submitBtn = m.el.querySelector('[data-submit]');
    const submit = async () => {
      if (submitBtn.classList.contains('busy')) return;
      err.hidden = true;
      let vals;
      try { vals = readForm(form, fields); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
      submitBtn.classList.add('busy'); submitBtn.disabled = true;
      try {
        const r = await onSubmit(vals);
        done = r === undefined ? true : r;
        submitBtn.classList.remove('busy');
        m.close();
        if (successMessage !== false) toast(successMessage || 'Saved.');
      } catch (e) {
        submitBtn.classList.remove('busy'); submitBtn.disabled = false;
        if (!(e instanceof AppError)) console.error(e); else if (e.detail) console.warn('Refused:', e.detail);
        err.textContent = e instanceof AppError ? e.message : `Something went wrong: ${e?.message || e}`;
        err.hidden = false;
        m.el.scrollTop = 0;
      }
    };
    submitBtn.addEventListener('click', submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    m.el.querySelector('[data-cancel]').addEventListener('click', () => m.close());
  });
}

/** Run an action with a busy state on its button, and uniform error handling. */
export async function withBusy(button, fn, okMessage) {
  if (button?.classList.contains('busy')) return;
  button?.classList.add('busy');
  try { const r = await fn(); if (okMessage) toast(okMessage); return r; } catch (e) { showError(e); return undefined; } finally { button?.classList.remove('busy'); }
}
