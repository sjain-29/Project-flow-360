/** Comments, attachments and history panels that any record page can embed. */
import * as R from '../services/records.js';
import { session, can } from '../services/session.js';
import { store } from '../services/store.js';
import { DOC_CATEGORIES, FILE_TYPES } from '../config/app-config.js';
import { ENTITIES } from '../config/entities.js';
import { $, esc, icon, formModal, confirmDialog, showError, toast, fmtValue } from './ui.js';
import { fmtDateTime, fmtDate } from '../utils/format.js';

export const panelsHtml = (which = ['comments', 'documents', 'history']) => which.map((w) => `<section class="panel" data-panel="${w}"><header><h2>${{ comments: 'Comments', documents: 'Documents and attachments', history: 'History' }[w]}</h2><span data-tools></span></header><div class="body" data-body><div class="muted">Loading…</div></div></section>`).join('');

const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const labelOf = (coll, k) => ENTITIES[coll]?.fields.find((f) => f.name === k)?.label || k;
const typeOf = (coll, k) => ENTITIES[coll]?.fields.find((f) => f.name === k)?.type;
const show = (coll, k, v) => (v === null || v === undefined || v === '' ? '—' : String(fmtValue(typeOf(coll, k), v)).replace(/<[^>]+>/g, ''));

export function logRowsHtml(logs, { withRecord = false } = {}) {
  if (!logs.length) return '<div class="empty">No history recorded yet.</div>';
  return `<div class="loglist">${logs.map((l) => {
    const keys = l.old ? Object.keys(l.new || {}) : [];
    const diff = keys.length ? `<div class="diff">${keys.filter((k) => !['updatedAt', 'updatedBy'].includes(k)).slice(0, 12).map((k) => `${esc(labelOf(l.rtype, k))}: <del>${esc(show(l.rtype, k, l.old?.[k]))}</del> → <ins>${esc(show(l.rtype, k, l.new?.[k]))}</ins>`).join(' · ')}</div>` : '';
    return `<div class="logrow"><div class="when">${esc(fmtDateTime(l.at))}</div><div><b>${esc(l.name || l.uid || '')}</b> <span class="muted">${esc(store.deptName(l.dept))}</span><div>${esc(l.action || '')}${withRecord && l.rid ? ` <span class="muted">· ${esc(ENTITIES[l.rtype]?.one || l.rtype || '')} ${esc(l.rid)}${l.pid ? ` · ${esc(l.pid)}` : ''}</span>` : ''}${l.note ? `<div class="muted small">${esc(l.note)}</div>` : ''}</div>${diff}</div></div>`;
  }).join('')}</div>`;
}

/** Wire the panels of one record. `coll` decides the module whose permissions apply. */
export function mountPanels(root, ctx, { coll, pid, rid }) {
  const body = (w) => root.querySelector(`[data-panel="${w}"] [data-body]`);
  const tools = (w) => root.querySelector(`[data-panel="${w}"] [data-tools]`);

  if (body('comments')) {
    const mayAdd = R.canComment(coll, pid);
    const draw = (list) => {
      const b = body('comments'); if (!b) return;
      b.innerHTML = `${!can('comments.view', pid) ? '<div class="empty">You do not have permission to view comments.</div>' : `<div class="thread">${list.map((c) => `<div class="comment"><span class="avatar">${esc(initials(c.userName))}</span><div><div class="meta"><b>${esc(c.userName)}</b> · ${esc(c.dept || '')} · ${esc(fmtDateTime(c.at))}${c.editedAt ? ' · edited' : ''}${c.userId === session.userId && !c.deleted ? ` · <button class="linkbtn" data-c-edit="${esc(c.id)}">Edit</button> · <button class="linkbtn" data-c-del="${esc(c.id)}">Delete</button>` : ''}</div><p>${c.deleted ? '<span class="muted">This comment was deleted by its author.</span>' : esc(c.text)}</p></div></div>`).join('') || '<div class="muted">No comments yet.</div>'}</div>`}
        ${mayAdd ? `<form data-c-form style="margin-top:14px;display:grid;gap:8px"><label class="sr" for="cmt">Add a comment</label><textarea id="cmt" rows="2" placeholder="Write a comment…" maxlength="4900"></textarea><div><button class="btn primary sm" type="submit">Add comment</button></div></form>` : ''}`;
      b.querySelector('[data-c-form]')?.addEventListener('submit', async (e) => { e.preventDefault(); const t = b.querySelector('#cmt'); try { await R.addComment(coll, pid, rid, t.value); t.value = ''; } catch (err) { showError(err); } });
      b.querySelectorAll('[data-c-edit]').forEach((el) => el.addEventListener('click', () => { const c = list.find((x) => x.id === el.dataset.cEdit); formModal({ title: 'Edit comment', fields: [{ name: 'text', label: 'Comment', type: 'textarea', req: true }], values: c, onSubmit: (v) => R.editComment(coll, pid, c, v.text) }); }));
      b.querySelectorAll('[data-c-del]').forEach((el) => el.addEventListener('click', async () => { const c = list.find((x) => x.id === el.dataset.cDel); if (await confirmDialog({ title: 'Delete comment', body: 'The comment text will be removed. The fact that a comment was made stays in the record.', confirmLabel: 'Delete', danger: true })) R.deleteComment(coll, pid, c).catch(showError); }));
    };
    ctx.onCleanup(R.watchComments(coll, pid, rid, draw));
  }

  if (body('documents')) {
    const mayAdd = R.canUpload(coll, pid);
    if (mayAdd) {
      tools('documents').innerHTML = `<button class="btn sm" data-d-link>${icon('link')}Attach link</button> <button class="btn sm" data-d-file>${icon('upload')}Upload file</button><input type="file" hidden data-d-input accept="${Object.keys(FILE_TYPES).join(',')}">`;
      const t = tools('documents');
      t.querySelector('[data-d-link]').addEventListener('click', () => formModal({ title: 'Attach a link', intro: 'For large files, store them on your shared drive and attach the link here.', fields: [{ name: 'name', label: 'Document name', req: true }, { name: 'category', label: 'Category', type: 'select', opts: DOC_CATEGORIES }, { name: 'url', label: 'Web address (https://…)', type: 'url', req: true, wide: true }], onSubmit: (v) => R.addLink(coll, pid, rid, v) }));
      const input = t.querySelector('[data-d-input]');
      t.querySelector('[data-d-file]').addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const f = input.files[0]; input.value = ''; if (!f) return;
        const r = await formModal({ title: `Upload ${f.name}`, intro: `Files up to ${store.settings().maxInlineFileKb || 500} KB are stored in the database. Allowed: PDF, Excel, CSV, Word, text, images.`, fields: [{ name: 'category', label: 'Category', type: 'select', opts: DOC_CATEGORIES }], submitLabel: 'Upload', successMessage: 'Uploaded.', onSubmit: (v) => R.addFile(coll, pid, rid, f, v.category) });
        return r;
      });
    }
    ctx.onCleanup(R.watchDocuments(coll, pid, rid, (docs) => {
      const b = body('documents'); if (!b) return;
      b.innerHTML = docs.length ? `<div class="table-wrap"><table class="tbl stack"><thead><tr><th>Document</th><th>Category</th><th>Added by</th><th>Added on</th><th></th></tr></thead><tbody>${docs.map((d) => `<tr><td data-label="Document">${d.kind === 'link' ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${icon('link')} ${esc(d.name)}</a>` : `<button class="linkbtn" data-d-open="${esc(d.id)}">${icon('clip')} ${esc(d.name)}</button> <span class="muted small">${Math.ceil((d.size || 0) / 1024)} KB</span>`}</td><td data-label="Category">${esc(d.category || '')}</td><td data-label="Added by">${esc(d.uploadedByName || '')}</td><td data-label="Added on">${esc(fmtDate(d.at))}</td><td>${d.uploadedBy === session.userId || can(`${d.module}.delete`, pid) ? `<button class="btn sm ghost" data-d-del="${esc(d.id)}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="muted">No documents attached.${mayAdd ? '' : ' You do not have permission to attach documents here.'}</div>`;
      b.querySelectorAll('[data-d-open]').forEach((el) => el.addEventListener('click', async () => {
        const d = docs.find((x) => x.id === el.dataset.dOpen);
        try { const data = await R.fileData(pid, d); const a = document.createElement('a'); a.href = data; a.download = d.name; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { showError(e); }
      }));
      b.querySelectorAll('[data-d-del]').forEach((el) => el.addEventListener('click', async () => { const d = docs.find((x) => x.id === el.dataset.dDel); if (await confirmDialog({ title: 'Remove document', body: `Remove “${esc(d.name)}” from this record?`, confirmLabel: 'Remove', danger: true })) R.removeDocument(pid, d).then(() => toast('Removed.')).catch(showError); }));
    }));
  }

  if (body('history')) {
    if (!can('activity.view', pid)) body('history').innerHTML = '<div class="empty">You do not have permission to view the activity history.</div>';
    else R.recordHistory(coll, pid, rid).then((logs) => { const b = body('history'); if (b) b.innerHTML = logRowsHtml(logs); }).catch(() => { const b = body('history'); if (b) b.innerHTML = '<div class="empty">History could not be loaded.</div>'; });
  }
}
export { $ };
