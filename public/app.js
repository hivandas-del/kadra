import { totaux, eur, r2, CATEGORIES } from './calc.js';
import { renderDoc, renderEdit, docContext } from '/templates.js';
import { traducteur, observer } from './i18n.js';

// ---------- Outils ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dlg = $('#dlg'), kdlg = $('#kdlg');
let view, S, ME;
// dates dans la langue de l'appli (les montants restent au format français, comme sur les devis)
const LOC = (() => { try { return localStorage.getItem('kadra_langue_site') || 'fr-FR'; } catch { return 'fr-FR'; } })();
const today = () => new Date().toISOString().slice(0, 10);
const dfr = d => (d ? new Date(d.length === 10 ? d + 'T12:00' : d).toLocaleDateString(LOC) : '');
const dlong = d => new Date(d + 'T12:00').toLocaleDateString(LOC, { day: 'numeric', month: 'long' });
const getP = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const setP = (o, p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((x, k) => (x[k] ||= {}), o)[last] = v; };
const fileToURL = f => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(f); });
// Photo réduite à 1200 px (une photo de téléphone ferait plusieurs Mo dans chaque PDF).
const imageURL = (f, max = 1200) => new Promise((ok, ko) => {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
    ok(c.toDataURL(f.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
  };
  img.onerror = () => ko(new Error('Image illisible.'));
  img.src = URL.createObjectURL(f);
});
const plural = (n, s, p = s + 's') => `${n} ${n > 1 ? p : s}`;

const sansReseau = () => Object.assign(new Error('Pas de réseau : réessayez quand le téléphone capte.'), { reseau: true });
async function api(p, method = 'GET', body, cle) {
  let r;
  try { r = await fetch('/api/' + p, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', ...(cle && { 'X-Kadra-Cle': cle }) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }); }
  catch { throw sansReseau(); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !p.startsWith('auth/')) { login(); throw Object.assign(new Error(j.error), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}

// ---------- Mode chantier : sans réseau, les dictées de devis et les notes attendent sur l'appareil, puis partent toutes seules ----------
// ponytail: localStorage (~5 Mo : quelques devis avec photos) ; passer à IndexedDB si les artisans en gardent beaucoup.
const cleAtt = () => 'kadra_attente_' + ME?.user.id; // par utilisateur : rien ne part dans le compte d'un autre
const attente = () => { try { return JSON.parse(localStorage.getItem(cleAtt())) || []; } catch { return []; } };
const garderAtt = l => { try { localStorage.setItem(cleAtt(), JSON.stringify(l)); return true; } catch { return false; } };
// type : 'devis' | 'note' ; chemin/methode : par défaut la création (une note modifiée : notes/ID en PUT)
function mettreEnAttente(type, body, chemin, methode) {
  if (!garderAtt([...attente(), { id: Date.now(), type, body, chemin, methode, le: new Date().toISOString() }])) throw new Error('Plus de place sur l’appareil : enlevez des photos ou envoyez quand vous aurez du réseau.');
  reseau();
}
// Bandeau en haut : hors réseau, et ce qui attend
function reseau(txt) {
  const l = ME ? attente() : [], nd = l.filter(a => a.type === 'devis').length, nn = l.length - nd;
  const quoi = [nd && plural(nd, 'devis', 'devis'), nn && plural(nn, 'note')].filter(Boolean).join(' et ');
  const msg = txt || (!navigator.onLine ? `Pas de réseau · ${quoi ? quoi + ' en attente' : 'dernières données chargées'}` : quoi ? `${quoi} en attente d’envoi` : '');
  let el = $('#reseau');
  if (!msg) return el?.remove();
  el ||= document.body.appendChild(Object.assign(document.createElement('div'), { id: 'reseau', role: 'status' }));
  el.innerHTML = icon(navigator.onLine ? 'clock' : 'alert', 14) + h(msg);
}
let envoiAtt = false;
async function envoyerAttente() {
  if (envoiAtt || !ME || !navigator.onLine || !attente().length) return reseau();
  envoiAtt = true;
  let fait = 0;
  try {
    for (const a of attente()) {
      reseau(a.type === 'devis' ? 'Kadra rédige un devis dicté sans réseau…' : 'Envoi d’une note…');
      try {
        // la clé fait que le serveur ne refait pas un envoi déjà reçu (réseau coupé pendant la réponse)
        const r = await api(a.chemin || (a.type === 'devis' ? 'ai/devis' : 'notes'), a.methode || 'POST', a.body, 'att-' + a.id);
        garderAtt(attente().filter(x => x.id !== a.id)); fait++;
        toast(a.type === 'devis' ? `Devis dicté sans réseau rédigé : ${r.numero || 'voir Devis'}` : 'Note gardée sans réseau envoyée');
      } catch (e) {
        if (e.reseau || [401, 409, 429].includes(e.status) || !(e.status < 500)) break; // réessayé plus tard ; rien n'est perdu
        toast(`Un élément en attente est refusé : ${e.message}`, 'crit'); // il reste dans la file, les suivants partent
      }
    }
  } finally { envoiAtt = false; reseau(); }
  if (fait && /^#\/(devis|notes)?$|^$/.test(location.hash)) route();
}
addEventListener('online', envoyerAttente);
addEventListener('offline', () => reseau());
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && envoyerAttente());
setInterval(envoyerAttente, 120e3);
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.innerHTML = icon(kind === 'crit' ? 'alert' : 'check', 16) + `<span>${h(msg)}</span>`;
  $('#toasts').append(t); setTimeout(() => t.remove(), 4000);
}
async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'crit'); } finally { btn.disabled = false; }
}

// ---------- Icônes (traits 1,8 px) ----------
const IC = {
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  chart: '<path d="M3.5 3.5v17h17"/><path d="M8 16v-4M12.5 16V8M17 16v-6"/>',
  file: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M8.5 13h7M8.5 17h4.5"/>',
  receipt: '<path d="M5.5 2.5h13v19l-2.6-1.8-2.2 1.8-2.2-1.8-2.2 1.8-2.2-1.8-1.6 1.8z"/><path d="M9 7.5h6M9 11h6M9 14.5h3.5"/>',
  helmet: '<path d="M2.5 18.5h19M4.5 18.5V15a7.5 7.5 0 0 1 15 0v3.5"/><path d="M9.5 8.2V5.5h5v2.7M12 5.5v6"/>',
  layers: '<path d="m12 2.5 9.5 5-9.5 5-9.5-5z"/><path d="m2.5 12.5 9.5 5 9.5-5M2.5 17l9.5 5 9.5-5"/>',
  users: '<circle cx="9" cy="8" r="3.8"/><path d="M2 20.5a7 7 0 0 1 14 0"/><path d="M15.5 4.4a3.8 3.8 0 0 1 0 7.2M22 20.5a7 7 0 0 0-4-6.3"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M21.5 2.5 10.5 13.5M21.5 2.5l-7 19-4-8-8-4z"/>',
  download: '<path d="M12 3v12.5M7 10.5l5 5 5-5M4.5 21h15"/>',
  printer: '<path d="M6.5 9V2.5h11V9M6.5 18h-2a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6.5" y="14" width="11" height="7.5"/>',
  link: '<path d="M10 13.5a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10.5a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  trash: '<path d="M3.5 6h17M9 6V3.5h6V6M18.5 6l-1 15h-11l-1-15M10 10.5v6M14 10.5v6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  alert: '<path d="M12 3.5 2.5 20.5h19z"/><path d="M12 10v4.5M12 17.5v.3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>',
  copy: '<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2"/><path d="M15.5 8.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5"/>',
  star: '<path d="m12 2.8 2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4-4.9-4.4 6.5-.7z"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6.5 15h3"/>',
  undo: '<path d="M9 14.5 4 9.5l5-5"/><path d="M4 9.5h11a5.5 5.5 0 0 1 0 11h-3"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
  menu: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="m3 6 9 7 9-7"/>',
  upload: '<path d="M12 21V8.5M7 13.5l5-5 5 5M4.5 3h15"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>', alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>', alignR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  shield: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.8 8 10 4.6-1.2 8-5 8-10v-6z"/>',
  euro: '<path d="M18 6.5a7.5 7.5 0 1 0 0 11M3.5 10h11M3.5 14h11"/>',
  building: '<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2.5 21h19M8 8h3M8 12h3M8 16h3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17.5 5.5l3 3M15 8l2 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  phone: '<path d="M5 3.5h3.5l1.8 4.6-2.3 1.4a11 11 0 0 0 6.5 6.5l1.4-2.3 4.6 1.8V19a2 2 0 0 1-2 2A16.5 16.5 0 0 1 3 5.5a2 2 0 0 1 2-2z"/>',
  note: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  pin: '<path d="M12 21.5s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9.5" r="2.5"/>',
  chevL: '<path d="m15 5-7 7 7 7"/>', chevR: '<path d="m9 5 7 7-7 7"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2.5 3.5h3l2.4 11.5h11l2-8H6.6"/>',
  clip: '<path d="m20.5 11.5-8.2 8.2a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
};
const icon = (n, s = 18) => `<svg class="i" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#14213D"/><path d="M15.5 16l7.5 8.5" stroke="#A9C1FF" stroke-width="3.25" stroke-linecap="round"/><path d="M14 7.5H9.5v17H14M23 7.5L15.5 16" fill="none" stroke="#fff" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round"/></svg>'; // même dessin que /logo.svg
const initials = n => (String(n || '').replace(/^(m\.|mme|mlle|m|mr|madame|monsieur)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
const avatar = (n, cls = '') => `<span class="av ${cls}" aria-hidden="true">${h(initials(n))}</span>`;

// ---------- Fenêtres (remplacent alert/confirm/prompt) ----------
const field = ({ name, label, type = 'text', value = '', required, options, rows, hint, step, placeholder, cls = '' }) => `<label class="f ${type === 'checkbox' ? 'check' : ''} ${cls}">${type === 'checkbox' ? `<input type="checkbox" name="${name}" ${value ? 'checked' : ''}><span>${label}</span>` : `<span>${label}</span>`}${
  type === 'textarea' ? `<textarea name="${name}" rows="${rows || 4}" placeholder="${h(placeholder)}">${h(value)}</textarea>`
  : type === 'select' ? `<select name="${name}">${options.map(([v, l]) => `<option value="${h(v)}" ${String(v) === String(value) ? 'selected' : ''}>${h(l)}</option>`).join('')}</select>`
  : type === 'checkbox' ? '' : `<input name="${name}" type="${type}" value="${h(value)}" ${required ? 'required' : ''} ${step ? `step="${step}"` : ''} placeholder="${h(placeholder)}">`}${hint ? `<small>${hint}</small>` : ''}</label>`;
function modal({ title, text = '', fields = [], ok = 'Valider', danger = false, wide = false, html = '', alt = '' }) {
  return new Promise(res => {
    dlg.className = wide ? 'wide' : '';
    dlg.innerHTML = `<form method="dialog" class="mform"><h2>${h(title)}</h2>${text ? `<p class="ink2">${text}</p>` : ''}${fields.map(field).join('')}${html}
<div class="mact"><button class="btn" value="" formnovalidate>Annuler</button>${alt ? `<button class="btn" value="alt" formnovalidate>${h(alt)}</button>` : ''}<button class="btn ${danger ? 'danger-solid' : 'primary'}" value="ok">${h(ok)}</button></div></form>`;
    dlg.returnValue = '';
    dlg.showModal();
    $('input:not([type=checkbox]),textarea,select', dlg)?.focus();
    dlg.onclose = () => {
      if (dlg.returnValue === 'alt') return res({ alt: true });
      if (dlg.returnValue !== 'ok') return res(null);
      const f = $('form', dlg), v = Object.fromEntries(new FormData(f));
      $$('input[type=checkbox]', f).forEach(c => { v[c.name] = c.checked; });
      res(v);
    };
  });
}
const confirmer = (title, text, ok = 'Supprimer') => modal({ title, text, ok, danger: true }).then(Boolean);

// ---------- Statuts ----------
const P = (txt, k = '', ic) => `<span class="pill ${k}">${ic ? icon(ic, 13) : ''}${txt}</span>`;
function pill(d) {
  if (d.type === 'modele') return P('Devis type', '', 'layers');
  if (d.type === 'facture') {
    if (d.kind === 'avoir') return P(d.numero ? 'Avoir émis' : 'Avoir brouillon', '', 'undo');
    if (d.statut === 'brouillon') return P('Brouillon');
    if (d.regle >= d.total_ttc - 0.005) return P('Payée', 'good', 'check');
    if (d.echeance < today()) return P('En retard', 'crit', 'alert');
    return d.regle > 0 ? P('Payée en partie', 'warn', 'clock') : P('À payer', 'plan', 'clock');
  }
  return { brouillon: P('Brouillon'), envoye: P('Envoyé', 'plan', 'send'), accepte: P('Accepté', 'good', 'check'), refuse: P('Refusé', 'crit', 'x') }[d.statut] || '';
}
const kindLabel = d => (d.type === 'modele' ? 'Devis type' : d.type === 'devis' ? 'Devis' : d.kind === 'avoir' ? 'Avoir' : d.kind === 'acompte' ? 'Facture d’acompte' : d.kind === 'situation' ? 'Situation de travaux' : 'Facture');
const docTable = (list, empty = 'Rien pour le moment.') => list.length ? `<table class="list docs"><thead><tr><th>Document</th><th>Client</th><th class="hide-m">Objet</th><th class="hide-m">Date</th><th class="n">Total TTC</th><th>Statut</th></tr></thead><tbody>
${list.map(d => `<tr data-href="#/doc/${d.id}"><td><span class="num">${h(d.type === 'modele' ? d.nom : d.numero || 'Brouillon')}</span>${['acompte', 'avoir', 'situation'].includes(d.kind) ? `<small class="muted">${kindLabel(d)}</small>` : ''}</td>
<td><div class="who">${avatar(d.client_nom || d.data.client?.nom)}<span>${h(d.client_nom || d.data.client?.nom || '—')}</span></div></td>
<td class="hide-m">${h(d.data.objet)}</td><td class="hide-m">${dfr(d.date)}</td><td class="n amt">${eur(d.total_ttc)}</td><td>${pill(d)}</td></tr>`).join('')}</tbody></table>`
  : `<div class="empty">${icon('file', 28)}<p>${empty}</p></div>`;
document.addEventListener('click', e => {
  const r = e.target.closest('[data-href]');
  if (r && !e.target.closest('a,button,input,select,textarea,label,summary')) location.hash = r.dataset.href;
});

// ---------- Avancement des chantiers : une barre et des phrases, sans calcul à faire ----------
const joursJusqua = d => Math.round((new Date(d + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5);
function chantierInfo(c) {
  const late = c.statut !== 'termine' && c.date_fin_prevue && c.date_fin_prevue < today();
  return { late, jours: late ? -joursJusqua(c.date_fin_prevue) : 0 };
}
const avance = (c, cls = '') => `<div class="prog ${cls} ${chantierInfo(c).late ? 'late' : ''}" role="img" aria-label="Travaux faits : ${c.avancement || 0} %"><i style="width:${c.avancement || 0}%"></i></div>`;
function finTexte(c) {
  if (c.statut === 'termine') return c.date_fin_reelle ? `Terminé le ${dfr(c.date_fin_reelle)}` : 'Terminé';
  if (c.statut === 'a_venir' && c.date_debut) { const j = joursJusqua(c.date_debut); return `Commence le ${dfr(c.date_debut)}${j > 0 ? ` (dans ${plural(j, 'jour')})` : ''}`; }
  if (!c.date_fin_prevue) return 'Pas de date de fin prévue';
  const j = joursJusqua(c.date_fin_prevue);
  return j < 0 ? `Devait finir le ${dfr(c.date_fin_prevue)} : ${plural(-j, 'jour')} de retard` : j === 0 ? 'Doit finir aujourd’hui' : `Fin prévue le ${dfr(c.date_fin_prevue)} (dans ${plural(j, 'jour')})`;
}
const payeTexte = c => (c.budget ? `Payé : <b>${eur(c.encaisse)}</b> sur ${eur(c.budget)}` : '');
const STATUTS_CH = { a_venir: 'À venir', en_cours: 'En cours', suspendu: 'Suspendu', termine: 'Terminé' };
const chantierPill = c => {
  const i = chantierInfo(c);
  return i.late ? P(`${plural(i.jours, 'jour')} de retard`, 'crit', 'alert')
    : c.statut === 'termine' ? P('Terminé', 'good', 'check') : P(STATUTS_CH[c.statut] || c.statut, c.statut === 'en_cours' ? 'plan' : '');
};
const chCard = c => `<a class="chcard" href="#/chantier/${c.id}">
  <div class="hd"><div><b>${h(c.nom)}</b><small>${h(c.client_nom || '')}</small></div>${chantierPill(c)}</div>
  ${c.statut === 'a_venir' ? '' : `<div><div class="pc"><strong>${c.avancement || 0} %</strong><small>des travaux faits</small></div>${avance(c)}</div>`}
  <small class="${chantierInfo(c).late ? 'crit' : ''}">${finTexte(c)}</small>${c.budget ? `<small>${payeTexte(c)}</small>` : ''}</a>`;

// ---------- E-mails : chaque message lisible tel quel (qui, quand, objet, texte) ----------
const quand = m => new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const mailEtat = m => (m.sens === 'recu' ? P('Reçu', 'plan', 'mail')
  : m.statut.startsWith('envoyé') ? P(m.statut === 'envoyé avec PDF' ? 'Envoyé, PDF joint' : m.statut === 'envoyé depuis la boîte mail' ? 'Envoyé depuis votre boîte mail' : 'Envoyé', 'good', 'check')
  : m.statut.startsWith('simulé') ? P('Pas parti : envoi d’e-mails non configuré', 'warn', 'alert') : P('L’envoi a échoué', 'crit', 'alert'));
function mailList(list, { reply = false, compact = false, empty = 'Aucun e-mail pour le moment.' } = {}) {
  if (!list.length) return `<div class="empty">${icon('mail', 26)}<p>${empty}</p></div>`;
  return `<div class="mails ${compact ? 'compact' : ''}">${list.map(m => {
    const recu = m.sens === 'recu', pourMoi = !recu && S.email && (m.a || '').toLowerCase() === S.email.toLowerCase();
    const long = String(m.corps).length > (compact ? 120 : 280) || String(m.corps).split('\n').length > (compact ? 2 : 5);
    const echange = recu || (!pourMoi && !m.document_id && !m.chantier_id); // un vrai message (pas un envoi automatique) : peut fixer un rendez-vous
    return `<article class="mail ${recu ? 'in' : ''} ${m.lu === 0 ? 'nouveau' : ''}">
<header><span class="dir">${icon(recu ? 'mail' : 'send', 15)}${recu ? `Reçu de ${h(m.client_nom || m.de || '')}` : pourMoi ? 'Avis pour vous' : `Envoyé à ${h(m.client_nom || m.a || '(aucune adresse)')}`}</span><time>${quand(m)}</time>${m.lu === 0 ? P('Nouveau', 'crit') : mailEtat(m)}</header>
<h3>${h(m.sujet)}</h3>${compact ? `<div class="apercu">${h(String(m.corps).replace(/\s+/g, ' '))}</div>` : ''}<div class="corps">${h(m.corps)}</div>
<footer>${long ? '<button type="button" class="lien" data-lire>Lire tout le message</button>' : ''}${JSON.parse(m.pieces || '[]').map(p => `<a class="btn ghost" href="/api/pieces/${p.id}" target="_blank" rel="noopener" title="Pièce jointe">${icon('download', 15)}${h(p.nom)}</a>`).join('')}${m.statut.startsWith('échec') ? `<small style="color:var(--crit)">${h(m.statut)}</small>` : ''}
${reply && recu ? `<button class="btn yellow" data-rep="${m.id}">${icon('sparkle', 15)}Répondre avec Kadra</button><button class="btn" data-repm="${m.id}">Répondre</button>` : ''}
${echange ? `<button class="btn ghost" data-rdv="${m.id}" title="Kadra lit l’e-mail et prépare le rendez-vous">${icon('calendar', 15)}Ajouter à l’agenda</button>` : ''}
${m.document_id ? `<a class="btn ghost" href="#/doc/${m.document_id}">${icon('file', 15)}Voir le document</a>` : m.chantier_id ? `<a class="btn ghost" href="#/chantier/${m.chantier_id}">${icon('helmet', 15)}Voir le chantier</a>` : ''}</footer></article>`;
  }).join('')}</div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-lire]');
  if (b) b.textContent = b.closest('.mail').classList.toggle('open') ? 'Réduire' : 'Lire tout le message';
  const r = e.target.closest('[data-rdv]');
  if (r) busy(r, async () => {
    toast('Kadra lit l’e-mail…');
    const s = await api(`emails/${r.dataset.rdv}/rdv`, 'POST');
    if (await editRdv({ ...s, note: s.trouve ? 'Rendez-vous trouvé dans l’e-mail : vérifiez avant d’enregistrer.' : 'Pas de date précise dans cet e-mail : complétez le rendez-vous.' })) route();
  });
  const ev = e.target.closest('[data-ev]');
  if (ev && !e.target.closest('a')) api('rdv/' + ev.dataset.ev).then(editRdv).then(x => x && route()).catch(err => toast(err.message, 'crit'));
});

// Écrire à un client, ou lui répondre (consigne dictée → Claude rédige → relecture avant envoi). Fiche client et rubrique E-mails.
function mailTools(c, mails) {
  const ecrire = async ({ sujet = '', corps = `Bonjour ${c.nom},\n\n\n\nCordialement,\n${S.nom}`, reponse_a } = {}) => {
    if (!c.email) return toast('Ajoutez d’abord l’e-mail du client (fiche client, Modifier).', 'crit');
    const v = await modal({ title: 'Écrire à ' + c.nom, ok: 'Envoyer', wide: true, text: 'À : ' + h(c.email),
      fields: [{ name: 'sujet', label: 'Objet', required: true, value: sujet }, { name: 'corps', label: 'Message', type: 'textarea', rows: 12, required: true, value: corps }] });
    if (v) { toast('E-mail ' + (await api(`clients/${c.id}/email`, 'POST', { ...v, reponse_a })).statut); route(); }
  };
  const rediger = async reponse_a => {
    const m = reponse_a && mails.find(x => x.id === reponse_a);
    const p = modal({ title: m ? `Répondre à « ${m.sujet} »` : 'Rédiger avec Kadra', ok: 'Rédiger', wide: true,
      text: `${m ? 'Laissez vide : Kadra répond tout seul. Ou dites ce qu’il faut répondre, dans votre langue.' : `À ${h(c.nom)}. Dites ce que vous voulez écrire, dans votre langue.`} Kadra écrit l’e-mail ; vous le relisez avant l’envoi.`,
      fields: [{ name: 'consigne', label: 'Votre consigne', type: 'textarea', rows: 4, required: !m, placeholder: 'Ex. : dis-lui que je passe lundi à 9 h pour finir la faïence, et rappelle l’acompte.' }],
      html: `<div class="voice" style="margin:4px 0 8px"><button type="button" class="mic sm" id="cmic" aria-pressed="false" aria-label="Dicter la consigne">${icon('mic', 20)}</button><span class="live muted" id="clive">Appuyez pour dicter.</span></div>` });
    const b = $('#cmic', dlg), ta = $('textarea', dlg);
    mic(b, { initial: () => ta.value, onLive: (f, i) => { ta.value = f; $('#clive', dlg).textContent = i || 'Je vous écoute…'; }, onFinal: f => { if (f) ta.value = f; } });
    const v = await p;
    if (b.getAttribute('aria-pressed') === 'true') b.click();
    if (!v) return;
    toast('Kadra rédige l’e-mail…');
    try { await ecrire({ ...(await api(`clients/${c.id}/brouillon`, 'POST', { consigne: v.consigne, reponse_a })), reponse_a }); }
    catch (e) { toast(e.message, 'crit'); }
  };
  const repondre = m => ecrire({ sujet: /^re ?:/i.test(m.sujet) ? m.sujet : 'Re: ' + m.sujet, reponse_a: m.id });
  return { ecrire, rediger, repondre };
}

// ---------- Rendez-vous ----------
const hfr = t => (t ? t.replace(/^0(\d)/, '$1').replace(':', ' h ').replace(/ h 00$/, ' h') : '');
const evTime = r => (r.debut.length > 10 ? hfr(r.debut.slice(11)) + (r.fin ? ' – ' + hfr(r.fin.slice(11)) : '') : 'Journée');
const dshort = j => new Date(j + 'T12:00').toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short' });
const maps = a => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(a).replace(/\n/g, ', '));
const telLink = t => 'tel:' + String(t).replace(/[^\d+]/g, '');
// Liste de rendez-vous (et repères de chantier) : heure, objet, client, adresse ; itinéraire et appel en un geste.
const evList = (items, empty, jour = false) => (items.length ? `<ul class="evs">${items.map(e => `<li ${e.k === 'ch' ? `data-href="#/chantier/${e.id}"` : `data-ev="${e.id}"`} class="${e.k === 'ch' ? 'ch' : ''}">
<span class="hr">${jour ? `<b>${dshort(e.debut.slice(0, 10))}</b>` : ''}${e.k === 'ch' ? icon('helmet', 16) : evTime(e)}</span>
<div class="t"><b>${h(e.titre)}</b><small>${[e.client_nom, e.lieu].filter(Boolean).map(h).join(' · ')}</small></div>
${e.lieu ? `<a class="btn ghost icon" target="_blank" rel="noopener" href="${h(maps(e.lieu))}" title="Itinéraire" aria-label="Itinéraire">${icon('pin', 17)}</a>` : ''}
${e.client_tel ? `<a class="btn ghost icon" href="${h(telLink(e.client_tel))}" title="Appeler ${h(e.client_nom)}" aria-label="Appeler">${icon('phone', 17)}</a>` : ''}</li>`).join('')}</ul>`
  : `<p class="muted">${empty}</p>`);
// Rendez-vous à enregistrer : client repris du chantier, adresse du chantier ou du client si rien n'est dit.
function rdvBody(v, clients, chs) {
  const ch = chs.find(c => c.id === +v.chantier_id), cl = clients.find(c => c.id === (+v.client_id || ch?.client_id));
  return { titre: v.titre.trim(), debut: v.date + (v.heure ? 'T' + v.heure : ''), fin: v.heure && v.heure_fin > v.heure ? `${v.date}T${v.heure_fin}` : null, client_id: cl?.id ?? null,
    chantier_id: ch?.id ?? null, lieu: v.lieu.trim() || ch?.adresse || cl?.adresse?.replace(/\n/g, ', ') || '', notes: v.notes, statut: 'confirme', email_id: v.email_id ?? null };
}
// Fenêtre de rendez-vous (nouveau, modification, ou proposition de Claude à confirmer). Renvoie la ligne enregistrée, ou null.
async function editRdv(r = {}) {
  const [clients, chs] = await Promise.all([api('clients'), api('chantiers')]);
  const [date = today(), heure = ''] = (r.debut || '').split('T');
  const v = await modal({
    title: r.id ? (r.statut === 'propose' ? 'Rendez-vous à confirmer' : 'Rendez-vous') : 'Nouveau rendez-vous', ok: r.statut === 'propose' || r.trouve ? 'Ajouter à l’agenda' : 'Enregistrer',
    text: r.note || (r.email_sujet ? `Trouvé par Kadra dans l’e-mail « ${h(r.email_sujet)} ».` : ''),
    fields: [
      { name: 'titre', label: 'Objet', value: r.titre, required: true, placeholder: 'Ex. Métré salle de bain' },
      { name: 'date', label: 'Jour', type: 'date', value: date, required: true, cls: 'third' },
      { name: 'heure', label: 'Heure', type: 'time', value: heure, cls: 'third' },
      { name: 'heure_fin', label: 'Fin', type: 'time', value: (r.fin || '').split('T')[1] || '', cls: 'third' },
      { name: 'client_id', label: 'Client', type: 'select', value: r.client_id ?? '', options: [['', 'Aucun'], ...clients.map(c => [c.id, c.nom])], cls: 'half' },
      { name: 'chantier_id', label: 'Chantier', type: 'select', value: r.chantier_id ?? '', options: [['', 'Aucun'], ...chs.filter(c => c.statut !== 'termine' || c.id === r.chantier_id).map(c => [c.id, c.nom])], cls: 'half' },
      { name: 'lieu', label: 'Adresse', value: r.lieu, placeholder: 'Vide : adresse du chantier ou du client' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: r.notes },
      ...(r.id ? [{ name: 'supprimer', label: r.statut === 'propose' ? 'Ignorer cette proposition' : 'Supprimer ce rendez-vous', type: 'checkbox' }] : []),
    ],
  });
  if (!v) return null;
  if (v.supprimer) { await api('rdv/' + r.id, 'DELETE'); toast('Rendez-vous retiré'); return {}; }
  const out = await api(r.id ? 'rdv/' + r.id : 'rdv', r.id ? 'PUT' : 'POST', rdvBody({ ...v, email_id: r.email_id }, clients, chs));
  toast('Rendez-vous enregistré');
  return out;
}

// ---------- Assistant vocal « Parler à Kadra » (bandeau du haut, gros micro du téléphone) ----------
// Bouton rond en bas à droite (téléphone : gros micro de la barre). Un clic : il s'allonge en « J’écoute… » avec des ondes, sans fenêtre ;
// on peut naviguer en parlant (ouvrir un devis, puis dire quoi changer).
// Second clic : la phrase part à Claude, qui prépare l'action ; l'artisan relit toujours avant que rien ne soit enregistré ou envoyé. Échap : annuler.
let dicteeVocale = ''; // devis demandé à l'assistant : la page de dictée reprend le texte et lance la rédaction
let docOuvert = null; // document modifiable à l'écran ({ id, saveNow }) : « ajoute une ligne… » le modifie directement
const reflechir = p => { document.body.classList.add('reflechit'); return p.finally(() => document.body.classList.remove('reflechit')); };
// Fil de la conversation : les derniers échanges partent avec chaque phrase (« oui, ouvre-le » se comprend). Oublié après 5 min de silence.
let fil = [], filT = 0;
async function commande(texte) {
  if (!texte.trim()) return;
  $('#bulle')?.remove();
  if (Date.now() - filT > 5 * 60e3) fil = [];
  toast(`Kadra réfléchit… « ${texte.trim()} »`);
  try {
    await docOuvert?.saveNow(); // Claude part du document tel qu'il est à l'écran
    let r;
    try { r = await reflechir(api('ai/commande', 'POST', { texte, doc_id: docOuvert?.id, fil, langue: langueMic() })); }
    catch (e) {
      if (!e.reseau) throw e;
      mettreEnAttente('note', { texte: texte.trim(), client_id: null, chantier_id: null });
      return toast('Pas de réseau : votre phrase est gardée dans Notes. Vous la retrouverez quand le réseau revient.');
    }
    fil = [...fil, { dit: texte, kadra: r.action === 'reponse' ? r.reponse : `(action « ${r.action} » proposée)`, client_id: r.client_id, chantier_id: r.chantier_id, document_id: r.document_id }].slice(-6);
    filT = Date.now();
    await agir(r);
  } catch (e) { toast(e.message, 'crit'); }
}
// Réponse de Kadra : bulle au-dessus du micro (sans fenêtre à fermer), lue à voix haute ; Kadra écoute déjà pendant qu'il parle.
function bulle(texte, lang) {
  $('#bulle')?.remove();
  const d = document.createElement('div'); d.id = 'bulle'; d.setAttribute('role', 'status');
  d.innerHTML = `<button type="button" class="btn ghost icon" aria-label="Fermer">${icon('x', 16)}</button><b>Kadra</b><p>${h(texte)}</p><small></small>`;
  d.querySelector('button').onclick = () => { d.remove(); taire(); couperEcoute(); };
  document.body.append(d);
  ecouterSuite(texte, lang);
}
let ecouterSuite = () => {}, couperEcoute = () => {}; // branchés par assistant()
// Le micro entend aussi la voix de Kadra : un morceau qui reprend sa réponse dans le même ordre est de l'écho, pas l'artisan
// (« ouvre-le » après « je vous l'ouvre ? » n'en est pas : les mots n'y sont pas à la suite).
const mots = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const OUI_NON = new Set(['oui', 'non', 'ok', 'vas', 'y', 'evet', 'hayir', 'tamam', 'sim', 'nao', 'si', 'yes', 'no']);
const paires = m => m.slice(1).map((x, i) => m[i] + ' ' + x);
function echo(t, dit) {
  const m = mots(t).filter(x => !OUI_NON.has(x)), d = mots(dit);
  if (m.length < 2) return m.length === 1 && d.includes(m[0]);
  const p = new Set(paires(d));
  return paires(m).filter(x => p.has(x)).length / (m.length - 1) >= 0.6;
}
function assistant() {
  const b = $('#voix');
  const ecoute = () => document.body.classList.contains('ecoute');
  let annule = false, entendu = false, suite = false, attente, silence, dit = '', ditFin = 0; // dit : ce que Kadra lit à voix haute ; suite : écoute d'une réponse à Kadra
  const kadraParle = () => dit && (!ditFin || Date.now() - ditFin < 2500); // les derniers mots entendus arrivent un peu après
  couperEcoute = () => { if (ecoute()) { annule = true; b.click(); } };
  ecouterSuite = (texte, lang) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition, s = $('#bulle small');
    const fini = () => { // fin de la lecture : 8 s sans rien dire = on arrête sans rien envoyer
      ditFin = Date.now(); clearTimeout(attente);
      if (SR) attente = setTimeout(() => { if (!entendu && ecoute()) { couperEcoute(); const s = $('#bulle small'); if (s) s.textContent = 'Appuyez sur le micro pour me répondre'; } }, 8000);
    };
    dit = texte; ditFin = 0;
    dire(texte, lang, fini);
    if (!SR) { if (s) s.textContent = 'Appuyez sur le bouton Kadra pour me répondre'; return; }
    if (s) s.textContent = 'Je vous écoute : répondez quand vous voulez';
    if (!ecoute()) { entendu = false; suite = true; b.click(); }
  };
  // L'artisan parle : Kadra se tait. Il appuie quand il a fini (une pause pour réfléchir ne coupe rien).
  // Seule une réponse à Kadra (« oui, ouvre-le ») part toute seule après 2 s de silence.
  const entend = (f, i) => {
    if (!(f + i).trim() || (kadraParle() && !f.trim() && echo(i, dit))) return;
    entendu = true;
    if (dit && !ditFin) taire();
    dit = ''; // l'artisan a la parole : plus rien n'est filtré
    clearTimeout(silence); if (suite) silence = setTimeout(() => { if (ecoute()) b.click(); }, 2000);
  };
  $('.tabbar .fab').onclick = () => b.click();
  if (window.SpeechRecognition || window.webkitSpeechRecognition) badgeLangue($('.tabbar .fab'));
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) { // Firefox : la demande s'écrit
    b.onclick = async () => {
      const v = await modal({ title: 'Parler à Kadra', text: 'La dictée vocale fonctionne avec Chrome, Edge ou Safari. Écrivez ce que vous voulez faire :', fields: [{ name: 'texte', label: 'Votre demande', type: 'textarea', rows: 3, required: true }] });
      if (v) commande(v.texte);
    };
    return;
  }
  mic(b, { onLive: entend, garder: t => !(kadraParle() && echo(t, dit)), onFinal: t => { if (!annule) commande(t); annule = false; },
    onState: on => {
      if (!on) { clearTimeout(attente); clearTimeout(silence); suite = false; } else entendu = false;
      document.body.classList.toggle('ecoute', on); b.setAttribute('aria-label', on ? 'Envoyer maintenant' : 'Parler à Kadra');
    } });
  addEventListener('keydown', e => { if (e.key === 'Escape' && ecoute()) { couperEcoute(); toast('Écoute annulée'); } });
}
// Récap de ce que Claude a compris : se lit d'un coup d'œil, se valide en un geste. Renvoie 'ok', 'modifier', ou null si annulé.
async function recap({ title, texte, lignes, alertes = [], corps = '', ok = 'Confirmer', wide = false }) {
  const p = modal({ title, ok, wide, alt: 'Modifier', html: `<dl class="recap">${lignes.filter(l => l[1]).map(([k, v]) => `<dt>${k}</dt><dd>${h(v)}</dd>`).join('')}</dl>
${corps ? `<div class="recap-corps">${h(corps)}</div>` : ''}${alertes.map(a => `<p class="recap-alerte">${icon('alert', 16)}<span>${h(a)}</span></p>`).join('')}
<p class="muted recap-dit">Vous avez dit : « ${h(texte)} »</p>` });
  $('.btn.primary', dlg).focus();
  const v = await p;
  return v?.alt ? 'modifier' : v ? 'ok' : null;
}
const MODES = ['Virement', 'Chèque', 'Espèces', 'Carte'];
async function agir(r) {
  const introuvable = quoi => toast(`Je n’ai pas trouvé ${quoi}. Dites le nom comme dans vos fiches, ou faites-le à la main.`, 'crit');
  if (r.action === 'modifier') {
    await reflechir(api('ai/devis', 'POST', { transcript: r.texte, doc_id: r.document_id }));
    toast('C’est modifié');
    if (location.hash === '#/doc/' + r.document_id) route();
    return;
  }
  if (r.action === 'note') { // une note ne coûte rien à défaire : gardée tout de suite, sans fenêtre
    await api('notes', 'POST', { texte: r.texte, client_id: r.client_id, chantier_id: r.chantier_id });
    toast('C’est noté (rubrique Notes)');
    if (location.hash.startsWith('#/notes')) route();
    return;
  }
  if (r.action === 'devis') { dicteeVocale = r.texte; if (location.hash === '#/nouveau') route(); else location.hash = '#/nouveau'; return; }
  if (r.action === 'rdv') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '', heure = /^\d{2}:\d{2}$/.test(r.heure) ? r.heure : '', heure_fin = /^\d{2}:\d{2}$/.test(r.heure_fin) ? r.heure_fin : '';
    const formulaire = note => editRdv({ titre: r.titre, debut: date + (heure ? 'T' + heure : ''), fin: date && heure && heure_fin ? `${date}T${heure_fin}` : null,
      lieu: r.lieu, client_id: r.client_id, chantier_id: r.chantier_id, trouve: true, note }).then(ok => { if (ok) route(); });
    if (!date || !r.titre?.trim()) return formulaire(`Vous avez dit : « ${h(r.texte)} ». Il me manque ${date ? 'l’objet' : 'le jour'} : complétez puis ajoutez.`);
    const [clients, chs] = await Promise.all([api('clients'), api('chantiers')]);
    const body = rdvBody({ titre: r.titre, date, heure, heure_fin, client_id: r.client_id, chantier_id: r.chantier_id, lieu: r.lieu || '', notes: '' }, clients, chs);
    const jour = new Date(date + 'T12:00').toLocaleDateString(LOC, { weekday: 'long', day: 'numeric', month: 'long' });
    const q = await recap({ title: 'Nouveau rendez-vous', texte: r.texte, ok: 'Ajouter à l’agenda', lignes: [['Objet', body.titre],
      ['Quand', heure ? (body.fin ? `${jour}, de ${hfr(heure)} à ${hfr(heure_fin)}` : `${jour} à ${hfr(heure)}`) : `${jour}, toute la journée`],
      ['Client', clients.find(c => c.id === body.client_id)?.nom], ['Chantier', chs.find(c => c.id === body.chantier_id)?.nom], ['Adresse', body.lieu]],
      alertes: [date < today() && 'Cette date est déjà passée.', !heure && 'Pas d’heure : noté sur toute la journée.', !body.client_id && 'Aucun client reconnu : ce rendez-vous ne sera lié à aucune fiche.', !body.lieu && 'Pas d’adresse.'].filter(Boolean) });
    if (q === 'modifier') return formulaire('');
    if (q) { await api('rdv', 'POST', body); toast('Rendez-vous enregistré'); route(); }
    return;
  }
  if (r.action === 'email') {
    if (!r.client_id) return introuvable('ce client');
    const c = await api('clients/' + r.client_id);
    if (!c.email) return toast(`Ajoutez d’abord l’e-mail de ${c.nom} (fiche client, Modifier).`, 'crit');
    toast('Kadra rédige l’e-mail…');
    const b = await api(`clients/${c.id}/brouillon`, 'POST', { consigne: r.consigne || r.texte });
    const q = await recap({ title: 'E-mail à ' + c.nom, texte: r.texte, ok: 'Envoyer', wide: true, lignes: [['À', c.email], ['Objet', b.sujet]], corps: b.corps });
    if (q === 'modifier') return mailTools(c, []).ecrire(b);
    if (q) { toast('E-mail ' + (await api(`clients/${c.id}/email`, 'POST', b)).statut); route(); }
    return;
  }
  if (r.action === 'paiement') {
    const f = r.facture;
    if (!f) return introuvable('de facture à payer pour ce client');
    const montant = r.montant > 0 ? r.montant : f.reste, mode = MODES.includes(r.mode) ? r.mode : 'Virement', reste = r2(f.reste - montant);
    const q = await recap({ title: 'Enregistrer un règlement', texte: r.texte, ok: 'Enregistrer', lignes: [['Montant', eur(montant)], ['Facture', f.numero], ['Client', f.client], ['Mode', mode], ['Date', dfr(today())],
      ['Restera à payer', reste > 0 ? eur(reste) : 'Rien, la facture sera soldée']],
      alertes: [!(r.montant > 0) && 'Pas de montant dit : je compte tout le reste à payer.', reste < 0 && `C’est plus que le reste à payer (${eur(f.reste)}).`, !MODES.includes(r.mode) && 'Mode de paiement non dit : « Virement » par défaut.',
        r.autres > 0 && `Ce client a ${plural(r.autres, 'autre facture', 'autres factures')} à payer : vérifiez que c’est la bonne.`].filter(Boolean) });
    if (!q) return;
    let body = { document_id: f.id, montant, date: today(), mode };
    if (q === 'modifier') {
      const v = await modal({ title: 'Enregistrer un règlement', ok: 'Enregistrer', text: `${h(f.numero)}, ${h(f.client || '')} : il reste ${eur(f.reste)} à payer.`, fields: [
        { name: 'montant', label: 'Montant', type: 'number', step: '0.01', required: true, value: montant, cls: 'third' },
        { name: 'date', label: 'Date', type: 'date', value: today(), cls: 'third' },
        { name: 'mode', label: 'Mode', type: 'select', value: mode, options: MODES.map(m => [m, m]), cls: 'third' }] });
      if (!v) return;
      body = { document_id: f.id, montant: +v.montant, date: v.date, mode: v.mode };
    }
    await api('payments', 'POST', body);
    toast('Règlement enregistré'); return route();
  }
  if (r.action === 'client') {
    const c = { nom: r.nom, email: r.email, tel: r.tel, adresse: r.adresse };
    if (!r.nom?.trim() || (r.email && !/^\S+@\S+\.\S+$/.test(r.email))) return editClient(c); // nom absent ou e-mail mal entendu : à corriger dans le formulaire
    const q = await recap({ title: 'Nouveau client', texte: r.texte, lignes: [['Nom', r.nom], ['Téléphone', r.tel], ['E-mail', r.email], ['Adresse', r.adresse]], alertes: r.tel || r.email ? [] : ['Ni téléphone ni e-mail pour le moment.'] });
    if (q === 'modifier') return editClient(c);
    if (q) { await api('clients', 'POST', c); toast('Client enregistré'); route(); }
    return;
  }
  if (r.action === 'ouvrir') {
    const ids = { client: r.client_id, chantier: r.chantier_id, document: r.document_id };
    if (r.page in ids && !ids[r.page]) return introuvable('ce que vous cherchez');
    location.hash = { accueil: '#/', factures_retard: '#/factures?retard', client: '#/client/' + ids.client, chantier: '#/chantier/' + ids.chantier, document: '#/doc/' + ids.document }[r.page] || '#/' + r.page;
    return;
  }
  bulle(r.reponse, /^[a-z]{2}(-[A-Z]{2})?$/.test(r.langue) ? r.langue : langueMic());
}

// ---------- Dictée vocale + onde du micro ----------
function mic(btn, { initial = () => '', onLive, onFinal, canvas, onState = () => {}, garder = () => true }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec, on = false, final = '', stream, actx, raf, cur;
  badgeLangue(btn);
  const stop = () => {
    on = false; langueLive = null; btn.classList.remove('rec'); btn.setAttribute('aria-pressed', 'false'); rec?.stop(); onState(false); pastilleLangue(false);
    cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); actx?.close(); stream = actx = null;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  };
  btn.onclick = () => {
    if (!SR) return toast('La dictée vocale fonctionne avec Chrome, Edge ou Safari. Vous pouvez aussi écrire.', 'crit');
    if (on) return stop();
    on = true; final = initial().trim(); if (final) final += ' ';
    btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true'); onState(true);
    cur = langueMic(); go();
    // changer de langue sans couper : stop() rend ce qui a été entendu, onend relance dans la nouvelle langue
    langueLive = l => { cur = l; rec?.stop(); };
    pastilleLangue(true);
    if (canvas) wave();
  };
  function go() {
    rec = new SR(); rec.lang = cur; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { if (garder(t)) final += t + ' '; } else interim += t;
      }
      onLive(final, interim);
    };
    rec.onerror = e => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) { stop(); toast('Micro indisponible : autorisez l’accès au micro dans le navigateur.', 'crit'); }
      if (e.error === 'network') { stop(); toast('Sans réseau, ce micro ne marche pas : utilisez le micro du clavier de votre téléphone, ou écrivez.', 'crit'); }
    };
    rec.onend = () => (on ? go() : onFinal(final.trim()));
    rec.start();
  }
  async function wave() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      actx = new AudioContext();
      const an = actx.createAnalyser(); an.fftSize = 256;
      actx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.frequencyBinCount), cx = canvas.getContext('2d');
      canvas.width = canvas.clientWidth * devicePixelRatio; canvas.height = canvas.clientHeight * devicePixelRatio;
      const draw = () => {
        an.getByteFrequencyData(data);
        const W = canvas.width, H = canvas.height, n = 48, bw = W / n;
        cx.clearRect(0, 0, W, H); cx.fillStyle = '#5b8cff';
        for (let i = 0; i < n; i++) {
          const v = data[Math.floor(i * data.length / n / 1.6)] / 255, bh = Math.max(3 * devicePixelRatio, v * H);
          cx.fillRect(i * bw + bw * 0.25, (H - bh) / 2, bw * 0.5, bh);
        }
        raf = requestAnimationFrame(draw);
      };
      draw();
    } catch { /* l'onde est décorative : la dictée continue sans elle */ }
  }
}
const LANGS = [['fr-FR', 'Français'], ['pt-PT', 'Português'], ['pt-BR', 'Português (Brasil)'], ['es-ES', 'Español'], ['it-IT', 'Italiano'],
  ['ar-MA', 'العربية (المغرب)'], ['ar-DZ', 'العربية (الجزائر)'], ['ar-TN', 'العربية (تونس)'], ['tr-TR', 'Türkçe'], ['ro-RO', 'Română'], ['pl-PL', 'Polski'],
  ['en-GB', 'English'], ['de-DE', 'Deutsch'], ['nl-NL', 'Nederlands'], ['uk-UA', 'Українська'], ['ru-RU', 'Русский'], ['bg-BG', 'Български'],
  ['sr-RS', 'Srpski'], ['hr-HR', 'Hrvatski'], ['sq-AL', 'Shqip'], ['zh-CN', '中文'], ['vi-VN', 'Tiếng Việt'], ['ta-IN', 'தமிழ்']];
const maLangue = () => ME.user.langue || 'fr-FR';
// Langue de l'appli (par appareil, l'écran de connexion la suit aussi). Les devis et factures restent en français.
const langueSite = () => LOC;
const choixLangueSite = () => `<select data-lgsite translate="no" aria-label="Langue de l’appli">${LANGS.map(([c, n]) => `<option value="${c}"${c === langueSite() ? ' selected' : ''}>${h(n)}</option>`).join('')}</select>`;
document.addEventListener('change', e => {
  if (!e.target.matches('[data-lgsite]')) return;
  try { localStorage.setItem('kadra_langue_site', e.target.value); } catch {}
  location.reload(); // repartir de l'original français, puis traduire
});
async function langueAppli() {
  const code = langueSite();
  if (code === 'fr-FR') return;
  document.documentElement.lang = code.split('-')[0];
  let obs;
  const charger = async () => {
    const r = await fetch('/api/i18n/' + code).then(x => x.ok ? x.json() : null).catch(() => null);
    if (!r) return;
    obs ? obs.changer(traducteur(r.dict)) : (obs = observer(traducteur(r.dict)));
    let b = $('#traduit');
    if (r.reste) { // 1re fois dans cette langue : Kadra traduit l'appli (quelques minutes), la page se traduit au fur et à mesure
      if (!b) { b = document.createElement('div'); b.id = 'traduit'; b.setAttribute('translate', 'no'); document.body.append(b); }
      b.textContent = `${nomLangue(code)} : Kadra traduit l’appli… ${r.reste} textes`;
      setTimeout(charger, 10e3);
    } else b?.remove();
  };
  await charger();
}
// 2e langue du micro (Paramètres > Langue de dictée) ; null = une seule langue, pas de pastille
const langue2 = () => ME.user.langue2 && ME.user.langue2 !== maLangue() ? ME.user.langue2 : null;
const nomLangue = c => LANGS.find(l => l[0] === c)?.[1] || c;
// Langue du micro : la dernière choisie (badge FR/TR ou pastille) est gardée d'une écoute à l'autre, sur cet appareil.
let langueVue = (() => { try { return localStorage.getItem('kadra_langue_mic'); } catch { return null; } })();
const langueMic = () => (langue2() && langueVue === langue2() ? langue2() : maLangue());
let langueLive = null; // micro en train d'écouter : change de langue sans couper
function changerLangueMic(c) {
  if (c === langueMic()) return;
  langueVue = c; try { localStorage.setItem('kadra_langue_mic', c); } catch { /* gardée pour cette page seulement */ }
  langueLive?.(c); badgesLangue(); if ($('#mlang')) pastilleLangue(true);
}
// Badge « FR » / « TR » sur chaque micro (si 2 langues) : on voit la langue écoutée, un appui dessus passe à l'autre.
function badgeLangue(btn) {
  if (!btn.querySelector('.ml')) btn.insertAdjacentHTML('beforeend', '<span class="ml"></span>');
  if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
  badgesLangue();
}
function badgesLangue() {
  const c = langueMic();
  document.querySelectorAll('.ml').forEach(e => { e.hidden = !langue2(); e.textContent = c.slice(0, 2).toUpperCase(); e.title = `Le micro écoute : ${nomLangue(c)}. Appuyez ici pour passer en ${nomLangue(c === maLangue() ? langue2() : maLangue())}.`; });
}
document.addEventListener('click', e => { // avant le micro lui-même : un appui sur le badge ne lance ni n'arrête l'écoute
  if (!e.target.closest?.('.ml')) return;
  e.preventDefault(); e.stopPropagation();
  changerLangueMic(langueMic() === maLangue() ? langue2() : maLangue());
}, true);
// Pastille « Français | Türkçe ▾ » affichée pendant l'écoute (pour choisir une autre 2e langue) ; false : retirée
function pastilleLangue(on) {
  let p = $('#mlang');
  if (!on || !langue2()) return p?.remove();
  if (!p) {
    p = document.createElement('div'); p.id = 'mlang'; p.setAttribute('role', 'group'); p.setAttribute('aria-label', 'Langue du micro');
    (document.querySelector('dialog[open]') || document.body).append(p); // hors d'une fenêtre ouverte, elle ne serait pas cliquable
    p.onmousedown = e => { if (e.target.closest('button')) e.preventDefault(); }; // le curseur reste dans le texte
    p.onclick = e => { const b = e.target.closest('button[data-l]'); if (b) changerLangueMic(b.dataset.l); };
    p.onchange = e => { ME.user.langue2 = e.target.value; api('me/langue', 'PUT', { langue2: e.target.value }).catch(() => {}); badgesLangue(); changerLangueMic(e.target.value); };
  }
  p.innerHTML = [maLangue(), langue2()].map(c => `<button type="button" data-l="${c}" aria-pressed="${c === langueMic()}">${h(nomLangue(c))}</button>`).join('')
    + `<label title="Choisir l’autre langue">▾<select aria-label="Autre langue">${LANGS.filter(l => l[0] !== maLangue()).map(([c, n]) => `<option value="${c}"${c === langue2() ? ' selected' : ''}>${h(n)}</option>`).join('')}</select></label>`;
}
// Voix de Kadra. Avec la voix du serveur (Azure, ME.voix) : une vraie voix native par langue, la même sur tous les appareils.
// Sinon : les voix de l'appareil (une langue peut manquer, ex. pas de turc sur un PC Windows en français).
// Choix par langue gardé sur l'appareil : '' = automatique, 'k:<nom>' = voix du serveur, sinon une voix de l'appareil.
const voixListe = lang => (window.speechSynthesis?.getVoices() || []).filter(v => v.lang.replace('_', '-').toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
const voixServeur = lang => ME.voix && (ME.voix[lang] || Object.entries(ME.voix).find(([k]) => k.startsWith(lang.slice(0, 2)))?.[1]) || null;
const voixChoisies = () => { try { return JSON.parse(localStorage.getItem('kadra_voix') || '{}'); } catch { return {}; } };
function voixPour(lang) { // voix de l'appareil
  const vs = voixListe(lang), exact = vs.filter(v => v.lang.replace('_', '-') === lang);
  return vs.find(v => v.voiceURI === voixChoisies()[lang.slice(0, 2)]) || [...exact, ...vs].find(v => /natural|online|google|premium|enhanced/i.test(v.name)) || exact[0] || vs[0] || null;
}
const prenom = n => n.split('-').pop().replace('Neural', '');
function voixServeurPour(lang) { // nom de la voix du serveur à utiliser, ou null pour celle de l'appareil
  const ch = voixChoisies()[lang.slice(0, 2)] || '', srv = voixServeur(lang);
  return ch.startsWith('k:') && srv?.includes(ch.slice(2)) ? ch.slice(2) : !ch && srv ? srv[0] : null;
}
const nomVoix = lang => (voixServeurPour(lang) ? prenom(voixServeurPour(lang)) + ' (voix Kadra)' : voixPour(lang)?.name || 'aucune voix sur cet appareil');
window.speechSynthesis?.getVoices(); // Chrome charge les voix en arrière-plan : on le lance dès l'ouverture
// Un seul lecteur audio, débloqué au premier appui (Safari n'accepte le son qu'après un geste) puis réutilisé.
const lecteur = new Audio();
addEventListener('pointerdown', () => {
  const b = new ArrayBuffer(46), v = new DataView(b), t = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  t(0, 'RIFF'); v.setUint32(4, 38, true); t(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); t(36, 'data'); v.setUint32(40, 2, true);
  lecteur.src = URL.createObjectURL(new Blob([b], { type: 'audio/wav' })); lecteur.play().catch(() => {}); // une demi-milliseconde de silence
}, { once: true, capture: true });
let lecture = null; // lecture en cours : { fini } ; taire() l'arrête et prévient comme la fin normale
function taire() {
  window.speechSynthesis?.cancel();
  const l = lecture; lecture = null;
  if (l) { lecteur.pause(); l.fini(); }
}
function direAppareil(texte, lang, fini) {
  // pas de voix de cette langue sur l'appareil : on ne lit pas avec un faux accent, la réponse reste écrite
  // (liste vide = voix pas encore chargées par le navigateur : on lit quand même)
  if (window.speechSynthesis?.getVoices().length && !voixPour(lang)) {
    $('#bulle')?.insertAdjacentHTML('beforeend', `<small class="sans-voix">Pas de voix ${h(nomLangue(lang))} sur cet appareil : réponse écrite seulement.</small>`);
    return fini();
  }
  try {
    const u = new SpeechSynthesisUtterance(texte); u.lang = lang; u.voice = voixPour(lang); u.onend = u.onerror = fini;
    speechSynthesis.speak(u);
  } catch { fini(); } // lecture à voix haute facultative
}
async function dire(texte, lang, fini = () => {}) {
  taire();
  const voix = voixServeurPour(lang);
  if (!voix) return direAppareil(texte, lang, fini);
  const l = lecture = { fini };
  try {
    const r = await fetch('/api/voix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texte, voix }) });
    if (!r.ok) throw new Error();
    const url = URL.createObjectURL(await r.blob());
    if (lecture !== l) return URL.revokeObjectURL(url); // coupé pendant le chargement (l'artisan parle déjà)
    lecteur.onended = lecteur.onerror = () => { URL.revokeObjectURL(url); if (lecture === l) { lecture = null; fini(); } };
    lecteur.src = url; await lecteur.play();
  } catch { if (lecture === l) { lecture = null; direAppareil(texte, lang, fini); } } // serveur muet : la voix de l'appareil prend le relais
}
const ESSAI_VOIX = { fr: 'Bonjour, je suis Kadra. Je vous ouvre le devis ?', tr: 'Merhaba, ben Kadra. Teklifi açayım mı?', pt: 'Olá, sou a Kadra. Abro o orçamento?',
  es: 'Hola, soy Kadra. ¿Le abro el presupuesto?', it: 'Ciao, sono Kadra. Le apro il preventivo?', en: 'Hello, I am Kadra. Shall I open the quote?', de: 'Hallo, ich bin Kadra. Soll ich das Angebot öffnen?',
  ar: 'مرحبا، أنا كادرا. هل أفتح لك عرض السعر؟', ro: 'Bună, sunt Kadra. Vă deschid devizul?', pl: 'Dzień dobry, jestem Kadra. Otworzyć kosztorys?' };
async function choisirVoix() {
  const langs = [maLangue(), langue2()].filter(Boolean), ch = voixChoisies();
  const p = modal({ title: 'Voix de Kadra', ok: 'Enregistrer', text: 'Choisissez la voix qui vous lit les réponses, pour chaque langue. Changer de voix la fait entendre.',
    fields: langs.map(l => {
      const vs = voixListe(l), srv = voixServeur(l) || [];
      const opts = [...srv.map((n, i) => ['k:' + n, `${prenom(n)}, voix ${i ? 'd’homme' : 'de femme'} (accent ${nomLangue(l)})`]), ...vs.map(v => [v.voiceURI, `${v.name} · voix de l’appareil`])];
      return { name: l.slice(0, 2), label: nomLangue(l), type: 'select', value: ch[l.slice(0, 2)] || '',
        options: opts.length ? [['', `Automatique (${nomVoix(l)})`], ...opts] : [['', 'Aucune voix dans cette langue sur cet appareil']],
        hint: opts.length ? '' : 'Sur ordinateur, Microsoft Edge a des voix dans toutes les langues ; ou ajoutez la langue dans Windows (Paramètres > Heure et langue > Voix).' };
    }) });
  dlg.querySelectorAll('select').forEach(s => { s.onchange = () => { // essai : la voix choisie lit une phrase
    try { localStorage.setItem('kadra_voix', JSON.stringify({ ...voixChoisies(), [s.name]: s.value })); } catch { /* voix automatique */ }
    dire(ESSAI_VOIX[s.name] || ESSAI_VOIX.fr, langs.find(x => x.slice(0, 2) === s.name));
  }; });
  const v = await p;
  taire();
  try { localStorage.setItem('kadra_voix', JSON.stringify(v ? { ...voixChoisies(), ...v } : ch)); } catch { /* voix automatique */ }
}
const LANGUE_AIDE = 'Le micro écoute une langue à la fois. Si vous mélangez deux langues en parlant, choisissez la deuxième : un badge « FR », « TR »… sur le micro montre la langue écoutée, un appui dessus passe à l’autre (Kadra garde la dernière choisie). Kadra rédige toujours le devis en français.';
async function choisirLangue(first) {
  const v = await modal({ title: first ? 'Dans quelle langue parlez-vous ?' : 'Langue de dictée', text: LANGUE_AIDE, ok: 'Enregistrer',
    fields: [{ name: 'langue', label: 'Langue que vous parlez le plus', type: 'select', value: maLangue(), options: LANGS },
      { name: 'langue2', label: 'Vous mélangez avec une autre langue ?', type: 'select', value: langue2() || '', options: [['', 'Non, je parle une seule langue'], ...LANGS] }] });
  if (!v && !first) return;
  ME.user.langue = v?.langue || maLangue();
  ME.user.langue2 = v?.langue2 && v.langue2 !== ME.user.langue ? v.langue2 : null;
  await api('me/langue', 'PUT', { langue: ME.user.langue, langue2: ME.user.langue2 || '' });
}

const emptyData = () => ({
  client: { nom: '', adresse: '', email: '', tel: '' }, objet: '', adresse_chantier: '', remise_pct: 0, acompte_pct: S.acompte_defaut, notes: '',
  lignes: [{ type: 'ligne', designation: '', description: '', qte: 1, unite: 'u', pu: 0, tva: S.franchise_tva ? 0 : S.tva_defaut }],
});

// ---------- Coque de l'application ----------
const NAV = [
  ['', 'Tableau de bord', 'home'], ['analyse', 'Analyse', 'chart'], ['agenda', 'Agenda', 'calendar'], ['notes', 'Notes', 'note'], ['mails', 'E-mails', 'mail'], ['chantiers', 'Chantiers', 'helmet'],
  ['Documents'], ['devis', 'Devis', 'file'], ['factures', 'Factures', 'receipt'], ['depenses', 'Dépenses', 'cart'], ['modeles', 'Devis types', 'layers'],
  ['Fichiers'], ['clients', 'Clients', 'users'], ['catalogue', 'Catalogue de prix', 'tag'], ['templates', 'Mise en page', 'layout'],
]; // Paramètres : roue en bas du menu, à côté de la déconnexion (le menu tient sans défiler)
function shell() {
  $('#app').innerHTML = `<div class="shell">
<aside class="side" id="side" aria-label="Navigation">
  <a class="mark" href="#/">${LOGO}<span>Kadra</span></a>
  ${[...NAV, ...(ME.kadra ? [['Kadra'], ['kadra', 'Modèles à reproduire', 'layout']] : [])].map(([r, l, ic]) => (l ? `<a class="nav" href="#/${r}" data-r="${r}">${icon(ic)}${l}<em class="badge" data-badge="${r}" hidden></em></a>` : `<div class="grp">${r}</div>`)).join('')}
  <button class="nav inst" data-install data-installer hidden>${icon('download')}Installer l’appli</button>
  <div class="me">${avatar(ME.user.nom || ME.user.email)}<div><b>${h(ME.user.nom || ME.user.email)}</b><small>${h(ME.entreprise)}</small></div>
  <a class="nav-ic" href="#/parametres" data-r="parametres" title="Paramètres" aria-label="Paramètres">${icon('sliders')}</a><button id="logout" title="Se déconnecter" aria-label="Se déconnecter">${icon('logout')}</button></div>
</aside>
<div class="main">
  <header class="top"><div class="tt"><h1 id="title"></h1><p class="sub" id="sub"></p></div><div class="tacts" id="tacts"></div>
  <button class="btn search" id="openK" aria-label="Rechercher">${icon('search', 16)}<span>Rechercher</span><kbd>Ctrl K</kbd></button></header>
  <main id="view" class="page" tabindex="-1"></main>
</div>
<button class="voix" id="voix" aria-label="Parler à Kadra" title="Parler à Kadra"><span class="o">${icon('mic', 24)}</span><i class="ondes" aria-hidden="true"><b></b><b></b><b></b><b></b></i>
  <span class="l">J’écoute… appuyez pour envoyer</span><span class="r">Kadra réfléchit…</span></button>
<nav class="tabbar" aria-label="Navigation rapide">
  <a href="#/">${icon('home', 22)}Accueil</a><a href="#/agenda">${icon('calendar', 22)}Agenda</a>
  <button class="fab" data-talk aria-label="Parler à Kadra">${icon('mic', 26)}</button>
  <a href="#/devis">${icon('file', 22)}Devis</a><button id="openSide">${icon('menu', 22)}Menu<em class="badge dot" data-badge="menu" hidden></em></button>
</nav></div>`;
  $('#logout').onclick = async () => { await api('auth/logout', 'POST'); login(); };
  $('#openK').onclick = palette;
  assistant();
  $('#openSide').onclick = () => $('#side').classList.toggle('open');
  montrerInstall();
}
// Téléphone : un appui à côté du menu ouvert le ferme (sans déclencher ce qui est dessous)
document.addEventListener('click', e => {
  const s = $('#side');
  if (s?.classList.contains('open') && !e.target.closest('#side,#openSide')) { e.preventDefault(); e.stopPropagation(); s.classList.remove('open'); }
}, true);

// ---------- Installer Kadra comme une appli (écran d'accueil du téléphone, sans la barre du navigateur) ----------
let installEvt = null;
const estAppli = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const estIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; montrerInstall(); });
addEventListener('appinstalled', () => { installEvt = null; montrerInstall(); toast('Kadra est installé : ouvrez-le depuis l’écran d’accueil'); });
function montrerInstall() {
  let vu = false; try { vu = localStorage.getItem('kadra_install_vu') === '1'; } catch {}
  $$('[data-install]').forEach(b => { b.hidden = estAppli() || !(installEvt || estIOS) || (vu && b.classList.contains('installer')); });
}
async function installer() {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; return montrerInstall(); }
  const chrome = /CriOS|EdgiOS|FxiOS/.test(navigator.userAgent);
  modal({ title: 'Installer Kadra sur l’iPhone', ok: 'Compris', html: `<ol class="etapes"><li>${chrome ? 'Dans la barre d’adresse en haut' : 'Dans <b>Safari</b>'}, touchez le bouton <b>Partager</b> (le carré avec une flèche vers le haut ; sur les iPhone récents, il est parfois dans le menu <b>•••</b>).</li>
<li>Choisissez <b>« Sur l’écran d’accueil »</b>.</li><li>Touchez <b>Ajouter</b>. Kadra s’ouvre ensuite comme une appli, sans la barre du navigateur.</li></ol>` });
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-installer]')) installer();
  if (e.target.closest('[data-install-non]')) { try { localStorage.setItem('kadra_install_vu', '1'); } catch {} montrerInstall(); }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Pastilles du menu : e-mails non lus, rendez-vous à confirmer.
async function badges(k) {
  k ||= await api('compteurs').catch(() => null);
  if (!k) return;
  const set = (r, n) => $$(`[data-badge="${r}"]`).forEach(b => { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; });
  set('mails', k.non_lus); set('agenda', k.rdv_proposes);
  $$('[data-badge="menu"]').forEach(b => { b.hidden = !(k.non_lus + k.rdv_proposes); });
}
function head(title, sub = '', actions = '') {
  const t = $('#tacts'), n = t.cloneNode(false); t.replaceWith(n); // pas d'écouteurs hérités de la page précédente
  $('#title').textContent = title; $('#sub').innerHTML = sub; n.innerHTML = actions;
  document.title = `${title} – Kadra`;
}
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && ME) { e.preventDefault(); palette(); } });

// ---------- Recherche rapide (Ctrl K) ----------
async function palette() {
  kdlg.innerHTML = `<input id="kq" placeholder="Chercher un devis, un client, un chantier, une action…" aria-label="Rechercher" autocomplete="off"><ul id="kres" role="listbox"></ul>`;
  kdlg.showModal();
  const [docs, chs, cls] = await Promise.all([api('documents'), api('chantiers'), api('clients')]);
  const actions = [['Dicter un devis', '#/nouveau', 'mic'], ['Notes : dicter une note de chantier', '#/notes', 'note'],['Nouveau rendez-vous', '#/agenda?new', 'calendar'], ['Agenda', '#/agenda', 'calendar'], ['Analyse : qui paie bien, ce qui rapporte', '#/analyse', 'chart'], ['E-mails', '#/mails', 'mail'], ['Nouveau chantier', '#/chantiers?new', 'helmet'], ['Nouvelle dépense (photo du ticket)', '#/depenses?new', 'cart'], ['Pour le comptable : exports', '#/depenses?export', 'download'], ['Importer mes anciens devis et factures', '#/import', 'upload'],['Paramètres', '#/parametres', 'sliders'], ['Factures en retard', '#/factures?retard', 'alert']];
  let items = [], sel = 0;
  const draw = () => {
    const q = $('#kq').value.trim().toLowerCase(), m = s => !q || String(s).toLowerCase().includes(q);
    items = [
      ...actions.filter(a => m(a[0])).map(([l, href, ic]) => ({ g: 'Actions', l, href, ic })),
      ...docs.filter(d => m([d.numero, d.nom, d.client_nom, d.data.objet].join(' '))).slice(0, 8).map(d => ({ g: 'Documents', l: `${d.numero || d.nom || 'Brouillon'}, ${d.client_nom || d.data.objet || ''}`, s: eur(d.total_ttc), href: '#/doc/' + d.id, ic: d.type === 'facture' ? 'receipt' : 'file' })),
      ...chs.filter(c => m([c.nom, c.client_nom].join(' '))).slice(0, 5).map(c => ({ g: 'Chantiers', l: c.nom, s: c.client_nom || '', href: '#/chantier/' + c.id, ic: 'helmet' })),
      ...cls.filter(c => m([c.nom, c.email].join(' '))).slice(0, 5).map(c => ({ g: 'Clients', l: c.nom, s: c.email || '', href: '#/client/' + c.id, ic: 'users' })),
    ];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let g = '';
    $('#kres').innerHTML = items.map((it, i) => `${it.g !== g ? `<li class="grp">${(g = it.g)}</li>` : ''}<li role="option" data-i="${i}" class="${i === sel ? 'on' : ''}">${icon(it.ic, 16)}<span>${h(it.l)}</span><small>${h(it.s || '')}</small></li>`).join('') || '<li class="grp">Aucun résultat</li>';
  };
  const go = i => { if (items[i]) { kdlg.close(); location.hash = items[i].href; } };
  $('#kq').oninput = () => { sel = 0; draw(); };
  $('#kq').onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') go(sel);
  };
  $('#kres').onclick = e => { const li = e.target.closest('[data-i]'); if (li) go(+li.dataset.i); };
  kdlg.onclick = e => { if (e.target === kdlg) kdlg.close(); };
  draw();
}

// ---------- Connexion / inscription ----------
// Panneau de gauche : petites scènes qui montrent Kadra au travail, l'une après l'autre (façon « stories »).
// La barre de la scène en cours se remplit en CSS ; sa fin passe à la suivante (survol = pause, « réduire les animations » = pas de défilement).
function scenesLogin() {
  const ap = (d, x, cls = '') => `<div class="ap ${cls}" style="--d:${d}">${x}</div>`;
  const mots = (t, d0, pas) => t.split(' ').map((m, k) => `<span class="mo" style="--d:${(d0 + k * pas).toFixed(2)}">${m}</span>`).join(' ');
  const swap = (d, a, b) => `<span class="sc-swap" style="--d:${d}">${a}${b}</span>`;
  const pill = (c, x) => `<span class="sc-pill ${c}">${x}</span>`;
  const notif = (d, ic, c, titre, texte, quand = 'maintenant') => ap(d, `<i style="background:${c}">${icon(ic, 18)}</i><div><small><b>KADRA</b>${quand}</small><strong>${titre}</strong><span>${texte}</span></div>`, 'sc-c au-notif');
  const mail = (d, ini, nom, objet, heure, texte) => ap(d, `<div class="sc-de"><i>${ini}</i><div><b>${nom}</b><small>${objet}</small></div><time>${heure}</time></div><p>${texte}</p>`, 'sc-c');
  const S = [
    { t: 'Dictée', d: 8, h: 'Dictez le devis sur le chantier.', p: 'Kadra l’écrit pendant que vous parlez : lignes, prix, TVA.',
      x: ap(0, `<b class="sc-rond">${icon('mic', 20)}</b><div><small>J’écoute…</small><p>${mots('Salle de bain chez Madame Lambert : dépose de la baignoire, receveur de douche à 450 euros, faïence 24 mètres carrés à 55 euros, et le nettoyage.', 0.4, 0.09)}</p></div>`, 'sc-c sc-mic')
        + ap(3, `<header><b>DEV-2026-0042</b><span>Mme Lambert · Salle de bain</span></header>
${[['Dépose de la baignoire', '1 u', '190,00'], ['F/P receveur de douche', '1 u', '450,00'], ['Faïence murale', '24 m²', '1 320,00'], ['Nettoyage fin de chantier', '1 F', '120,00']].map(([a, q, m], k) => ap(3.4 + k * 0.35, `<span>${a}</span><em>${q}</em><b>${m}</b>`, 'sc-l')).join('')}
${ap(4.9, '<span>Total TTC</span><b>2 288,00 €</b>', 'sc-tot')}${ap(5.4, pill('ok', icon('check', 13) + ' Prêt à envoyer'))}`, 'sc-c sc-devis') },
    { t: 'E-mails', d: 7.5, h: 'Vos e-mails, déjà rédigés.', p: 'Kadra prépare la réponse, vous relisez, vous envoyez.',
      x: mail(0, 'PM', 'M. Martin', 'Facture de la cuisine', '08:42', 'Bonjour, pouvez-vous me renvoyer la facture ? Je fais le virement aujourd’hui.')
        + ap(1.2, `${pill('bleu', icon('sparkle', 13) + ' Kadra rédige')}<p>${mots('Bonjour Monsieur Martin, voici la facture FAC-2026-0012 de 1 450,00 € en pièce jointe, avec notre RIB. Merci et bonne journée.', 1.7, 0.1)}</p>
${ap(4.1, `${icon('file', 14)} FAC-2026-0012.pdf`, 'sc-pj')}${swap(5.2, `<span class="sc-btn">${icon('send', 14)} Envoyer</span>`, pill('ok', icon('check', 13) + ' Envoyé'))}`, 'sc-c sc-rep') },
    { t: 'Agenda', d: 7, h: 'Les rendez-vous se notent tout seuls.', p: 'Kadra les trouve dans vos e-mails et les met à l’agenda.',
      x: mail(0, 'SR', 'Mme Roche', 'Terrasse', '11:05', 'Bonjour, je suis disponible <mark class="sc-mk">jeudi à 10 h</mark> pour que vous passiez voir la terrasse.')
        + ap(1.8, `${icon('sparkle', 14)} Kadra a trouvé un rendez-vous`, 'sc-fl')
        + ap(2.3, `<div class="sc-jour"><small>jeu.</small><b>12</b><small>nov.</small></div><div><b>10:00 · Visite de la terrasse</b><span>Mme Roche · 14 rue Garibaldi, Lyon</span>${swap(4.4, `<span class="sc-btn">Confirmer</span>`, pill('ok', icon('check', 13) + ' Dans l’agenda'))}</div>`, 'sc-c sc-rdv') },
    { t: 'Relances', d: 7, h: 'Les relances partent sans vous.', p: 'Factures en retard relancées, paiements suivis.',
      x: ap(0, `<div><b>FAC-2026-0009</b><span>M. Haddad · Rénovation cuisine</span></div><div><b>1 930,00 €</b>${swap(2.6, pill('rouge', '12 jours de retard'), pill('ok', icon('check', 13) + ' Payée'))}</div>`, 'sc-c sc-fac')
        + notif(1, 'mail', '#14213d', 'Relance envoyée', 'Kadra a écrit à M. Haddad pour vous', 'lundi 08:00')
        + notif(2.4, 'euro', '#1f9d55', 'Paiement reçu', 'M. Haddad · 1 930,00 €')
        + ap(3.3, `<small>Vos clients vous doivent</small>${swap(4, '<b>4 287,52 €</b>', '<b>2 357,52 €</b>')}`, 'sc-c sc-du') },
    { t: 'Signature', d: 7, h: 'Signé en ligne, chantier lancé.', p: 'Le client signe sur son téléphone, Kadra crée le chantier.',
      x: ap(0, `<small>DEV-2026-0042 · Salle de bain · 2 288,00 € TTC</small><b>Bon pour accord</b>
<svg viewBox="0 0 240 64" class="sc-trait"><path pathLength="1" d="M8 46C22 12 40 8 44 34s14 22 24-4 22-18 26 12 16 10 26-10 18-12 22 8 14 14 26-2 26-8 54-4"/></svg>
${ap(2, 'Signé par Mme Lambert, le 19/11 à 14:32', 'sc-signe')}`, 'sc-c sc-sig')
        + notif(2.5, 'check', '#1f9d55', 'Devis signé', 'Mme Lambert · 2 288,00 €')
        + notif(3.3, 'helmet', 'var(--plan)', 'Chantier créé', 'Salle de bain Lambert · début le 23 nov.')
        + notif(4.1, 'receipt', '#14213d', 'Facture d’acompte prête', '30 % · 686,40 €') },
    { t: 'Assistant', d: 8, h: 'Demandez, Kadra s’en occupe.', p: 'Une question, un rendez-vous, un e-mail : dites-le simplement.',
      x: ap(0, `<span class="sc-ondes"><b></b><b></b><b></b><b></b></span>J’écoute…`, 'sc-ecoute')
        + ap(0.3, mots('Qui me doit encore de l’argent ?', 0.5, 0.14), 'sc-c sc-moi')
        + ap(1.9, `${LOGO}<p>${mots('Trois clients vous doivent 2 357,52 €. M. Girard vous doit 1 000,00 € depuis 20 jours. Je le relance ?', 2.2, 0.08)}</p>`, 'sc-c sc-kadra')
        + ap(4.6, 'Oui, vas-y.', 'sc-c sc-moi')
        + notif(5.4, 'send', 'var(--plan)', 'Relance envoyée', 'M. Girard · FAC-2026-0007') },
  ];
  const scene = $('.au-scene'), slogan = $('.au-slogan'), bars = $('.au-bars');
  let i = 0;
  const va = n => {
    if (!document.contains(scene)) return; // on s'est connecté entre-temps
    i = (n + S.length) % S.length; const s = S[i];
    scene.innerHTML = `<div class="sc">${s.x}</div>`;
    slogan.innerHTML = `<h2>${s.h}</h2><p>${s.p}</p>`;
    bars.innerHTML = S.map((b, k) => `<button type="button" class="${k < i ? 'fait' : k === i ? 'on' : ''}" style="--dur:${b.d}s" ${k === i ? 'aria-current="true"' : ''}><i></i><span>${b.t}</span></button>`).join('');
    $$('button', bars).forEach((b, k) => { b.onclick = () => va(k); });
    $('.on i', bars).onanimationend = () => { scene.firstChild.classList.add('sort'); const j = i; setTimeout(() => i === j && va(j + 1), 350); };
  };
  va(0);
}

function login(mode = 'login') {
  ME = null; $('#reseau')?.remove();
  self.caches?.delete('kadra-donnees').catch(() => {}); // données gardées pour le mode chantier : rien ne reste après la déconnexion
  // cadre dessiné une fois : changer de mode ne relance pas l'arrivée des icônes
  if (!$('#app .auth')) { $('#app').innerHTML = `<div class="auth">
  <section class="au-photo">
    <span class="au-mark">${LOGO}Kadra</span>
    <div class="au-scene" aria-hidden="true"></div>
    <div class="au-slogan"></div>
    <nav class="au-bars" aria-label="Ce que fait Kadra"></nav>
  </section>
  <section class="au-droite"><main class="au-main">
    <div class="au-icons" aria-hidden="true"><i style="--n:0">${icon('helmet', 22)}</i><i class="b" style="--n:1">${icon('file', 24)}</i><i class="k" style="--n:2">${LOGO}</i><i class="b" style="--n:3">${icon('building', 24)}</i><i style="--n:4">${icon('receipt', 22)}</i></div>
    <div class="au-in"></div>
  </main>
  <footer class="au-pied"><span class="au-pt">Kadra · devis, factures et chantiers pour les artisans du bâtiment · </span>©${new Date().getFullYear()} · Photo : Annie Spratt (Unsplash) · <label class="au-lg">${icon('globe', 14)}${choixLangueSite()}</label></footer></section></div>`; scenesLogin(); }
  const T = { login: ['Connectez-vous à Kadra', 'Vos devis, vos chantiers et vos factures, au même endroit.'], signup: ['Créez votre entreprise', 'Votre espace est prêt en une minute.'], oubli: ['Mot de passe oublié', 'Indiquez votre e-mail : nous vous envoyons un lien pour en choisir un nouveau.'], reset: ['Nouveau mot de passe', 'Choisissez-le, vous serez connecté juste après.'] }[mode];
  const fl = (name, label, type, ac, req = true) => `<label class="fl"><input name="${name}" type="${type}" autocomplete="${ac}" placeholder=" " ${req ? 'required' : ''}><span>${label}</span></label>`;
  const mdp = fl('password', mode === 'reset' ? 'Nouveau mot de passe' : 'Mot de passe', 'password', mode === 'login' ? 'current-password' : 'new-password');
  const champs = {
    login: fl('email', 'E-mail', 'email', 'username') + `<div class="mdp">${mdp}</div>`,
    signup: fl('entreprise', 'Nom de l’entreprise', 'text', 'organization') + fl('nom', 'Votre nom (facultatif)', 'text', 'name', false) + fl('email', 'E-mail', 'email', 'email') + mdp,
    oubli: fl('email', 'E-mail', 'email', 'email'), reset: mdp,
  }[mode];
  const liens = {
    login: '<button type="button" class="au-lien" data-m="oubli">Mot de passe oublié ?</button><span>Pas encore de compte ? <button type="button" class="au-lien" data-m="signup">Créer votre entreprise</button></span>',
    signup: '<span>Déjà un compte ? <button type="button" class="au-lien" data-m="login">Se connecter</button></span>',
  }[mode] || '<button type="button" class="au-lien" data-m="login">Retour à la connexion</button>';
  $('.au-in').innerHTML = `<h1>${T[0]}</h1><p class="au-sub">${T[1]}</p>
<form id="af" novalidate><div class="grp${mode === 'login' ? ' etape1' : ''}">${champs}<button class="fleche" aria-label="Continuer">${icon('arrowR', 18)}</button></div>
${mode === 'signup' ? '<p class="au-note">Mot de passe : 8 caractères minimum.</p>' : ''}<p class="au-err" id="aerr" role="alert" hidden></p></form>
<nav class="au-liens">${liens}</nav>`;
  const f = $('#af'), grp = $('.grp', f), fleche = $('.fleche', f);
  const actifs = () => [...f.querySelectorAll('input[required]')].filter(i => !grp.classList.contains('etape1') || i.name !== 'password');
  const pret = () => grp.classList.toggle('pret', actifs().every(i => i.value.trim()));
  const mdpCache = $('.mdp input', f); if (mdpCache) mdpCache.tabIndex = -1; // replié : pas de Tab dedans, mais le navigateur peut le remplir
  f.oninput = () => { grp.classList.remove('faux'); $('#aerr').hidden = true; pret(); };
  $$('.auth [data-m]').forEach(b => { b.onclick = () => login(b.dataset.m); });
  if (matchMedia('(min-width:901px)').matches) $('input', f).focus(); // pas sur téléphone : le clavier cacherait l'écran
  const err = m => { const e = $('#aerr'); e.textContent = m; e.hidden = false; grp.classList.remove('faux'); void grp.offsetWidth; grp.classList.add('faux'); };
  f.onsubmit = async e => {
    e.preventDefault();
    const vide = actifs().find(i => !i.value.trim());
    if (vide) { vide.focus(); return err(`Indiquez ${vide.name === 'email' ? 'votre e-mail' : vide.name === 'entreprise' ? 'le nom de l’entreprise' : 'le mot de passe'}.`); }
    if (grp.classList.contains('etape1') && !mdpCache.value) { // façon Apple : l'e-mail d'abord, puis le mot de passe
      grp.classList.remove('etape1'); mdpCache.tabIndex = 0; pret(); setTimeout(() => mdpCache.focus(), 60); return;
    }
    const v = Object.fromEntries(new FormData(f));
    fleche.classList.add('charge'); fleche.disabled = true;
    try {
      if (mode === 'oubli') {
        await api('auth/oubli', 'POST', v);
        $('.au-in').innerHTML = `<div class="au-ok">${icon('mail', 28)}</div><h1>Regardez vos e-mails</h1><p class="au-sub">Si un compte existe avec <b>${h(v.email)}</b>, un lien vient d’être envoyé (valable 1 heure). Pensez aux indésirables.</p><nav class="au-liens"><button type="button" class="au-lien" data-m="login">Retour à la connexion</button></nav>`;
        $('.au-in [data-m]').onclick = () => login(); return;
      }
      if (mode === 'reset') { await api('auth/reset', 'POST', { ...v, token: location.hash.split('/')[2] }); history.replaceState(null, '', '#/'); }
      else await api('auth/' + mode, 'POST', v);
      await boot();
    } catch (ex) { err(ex.message); fleche.classList.remove('charge'); fleche.disabled = false; }
  };
}

// ---------- Tableau de bord ----------
function barPath(x, top, w, base) {
  const ht = base - top; if (ht < 0.5) return '';
  const r = Math.min(w / 2, ht); // barres arrondies en gélule
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}
// mois : [{ mois: 'AAAA-MM' ou l: 'libellé', facture, encaisse }] ; noms = séries (une seule : pas de 2e barre, montant écrit au-dessus)
function chart(mois, noms = ['facturé', 'encaissé']) {
  // largeur réelle de la carte : le texte garde sa taille (sinon 23 px sur grand écran, 6 px sur téléphone)
  const W = Math.max(300, Math.min(1180, view.clientWidth - 52)), narrow = W < 560, H = narrow ? 200 : 260, L = narrow ? 48 : 80, B = 30, T = 24, two = noms.length > 1;
  const max = Math.max(1, ...mois.flatMap(m => [m.facture, two ? m.encaisse : 0]));
  const p = 10 ** Math.floor(Math.log10(max)), top = Math.ceil(max / p) * p;
  const y = v => H - B - (Math.max(0, v) / top) * (H - B - T), bw = (W - L) / mois.length;
  const lbl = (m, w = 'short') => new Date(m + '-15').toLocaleDateString(LOC, { month: w });
  const ax = v => (narrow && v >= 1000 ? `${(v / 1000).toLocaleString('fr-FR')} k€` : `${Math.round(v).toLocaleString('fr-FR')} €`);
  const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W}" y1="${y(top * f)}" y2="${y(top * f)}" style="stroke:var(${f ? '--line2' : '--line'})"/><text x="${L - 8}" y="${y(top * f) + 4}" text-anchor="end">${ax(top * f)}</text>`).join('');
  const nom = m => m.l ?? `${lbl(m.mois)} ${m.mois.slice(0, 4)}`;
  const bars = mois.map((m, i) => {
    const w = Math.min(two ? (bw * 0.6 - 2) / 2 : bw * 0.6, 56), x = L + i * bw + (bw - (two ? 2 * w + 2 : w)) / 2, c = L + i * bw + bw / 2;
    return `<g><title>${nom(m)} : ${noms[0]} ${eur(m.facture)}${two ? `, ${noms[1]} ${eur(m.encaisse)}` : ''}</title><rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - B - T}" fill="transparent"/>
${two ? `<path class="m" d="${barPath(x, y(m.facture), w, H - B)}" fill="var(--s1)"/><path class="m" d="${barPath(x + w + 2, y(m.encaisse), w, H - B)}" fill="var(--s3)"/>`
    : `<path class="m" d="${barPath(x, y(m.facture), w, H - B)}" fill="var(--s3)"/>${m.facture && bw > 46 ? `<text x="${c}" y="${y(m.facture) - 7}" text-anchor="middle" style="font-weight:700">${ax(m.facture)}</text>` : ''}`}
<text x="${c}" y="${H - 7}" text-anchor="middle">${m.l ?? lbl(m.mois, narrow ? 'narrow' : 'short')}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${h(noms.join(' et '))}">${grid}${bars}</svg>${chiffres(mois, noms)}`;
}
const chiffres = (mois, noms) => { const two = noms.length > 1, nom = m => m.l ?? MOIS_FR(m.mois);
  return `<details><summary class="muted" style="font-size:13px;cursor:pointer">Voir les chiffres</summary><table class="list">${two ? `<tr><th></th><th class="n">${h(noms[0])}</th><th class="n">${h(noms[1])}</th></tr>` : ''}${mois.map(m => `<tr><td>${nom(m)}</td><td class="n">${eur(m.facture)}</td>${two ? `<td class="n">${eur(m.encaisse)}</td>` : ''}</tr>`).join('')}</table></details>`; };

const calme = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const anime = (duree, pas, fin) => { // pas(k) avec k de 0 à 1, freiné à la fin
  if (calme()) { pas(1); return fin?.(); }
  const t0 = performance.now(), f = now => { const k = Math.min(1, (now - t0) / duree); pas(1 - (1 - k) ** 3); k < 1 ? requestAnimationFrame(f) : fin?.(); };
  requestAnimationFrame(f);
};
let introFinie = Promise.resolve(); // l'ouverture du matin retarde les animations de la page

// Chiffres qui défilent jusqu'à leur valeur : « 8 420,00 € », « 3 », « 62 % » (le texte affiché donne la valeur et le format)
const NUM = /^-?\d[\d\s  ]*(?:,\d+)?/;
const lireNombre = s => { const m = String(s).trim().match(NUM); return m ? +m[0].replace(/[^\d,-]/g, '').replace(',', '.') : null; };
function compter(el, depuis = 0, duree = 1000) {
  const t = el.firstChild; if (!t || t.nodeType !== 3) return;
  const txt = t.data.replace(/^\s+/, ''), m = txt.match(NUM); if (!m) return; // l'espace de fin (avant « HT ») reste dans le suffixe
  const num = m[0].replace(/[\s  ]+$/, ''), suf = txt.slice(num.length), fin = lireNombre(num), dec = (num.split(',')[1] || '').length;
  if (!fin || fin === depuis) return;
  const f = v => v.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
  t.data = f(depuis);
  introFinie.then(() => anime(duree, k => { t.data = f(depuis + (fin - depuis) * k); }));
}

// Le K s'allume à la première ouverture de la journée, puis la page arrive
function ouverture() {
  try { if (localStorage.kadra_ouvert === today()) return; localStorage.kadra_ouvert = today(); } catch { return; }
  if (calme()) return;
  const o = document.createElement('div'); o.id = 'intro'; o.innerHTML = `<div>${LOGO}<b>Kadra</b></div>`;
  document.body.append(o); document.body.classList.add('intro');
  o.querySelector('svg').animate([{ transform: 'scale(.55)', opacity: 0, boxShadow: '0 0 0 0 rgba(91,140,255,0)' }, { transform: 'scale(1.06)', opacity: 1, boxShadow: '0 0 0 18px rgba(91,140,255,.18)', offset: .6 },
    { transform: 'scale(1)', opacity: 1, boxShadow: '0 0 0 36px rgba(91,140,255,0)' }], { duration: 900, easing: 'cubic-bezier(.2,.7,.2,1)' });
  o.querySelector('b').animate([{ opacity: 0, letterSpacing: '.4em' }, { opacity: 1, letterSpacing: '0' }], { duration: 800, delay: 200, easing: 'ease-out', fill: 'backwards' });
  introFinie = new Promise(ok => setTimeout(() => {
    document.body.classList.remove('intro'); ok();
    o.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-in' }).onfinish = () => o.remove();
  }, 1100));
}

// La couleur de l'entreprise teinte l'appli ; trop claire pour un texte blanc, elle est assombrie
function teinte(c = S?.couleur) {
  if (!/^#[0-9a-f]{6}$/i.test(c || '')) c = '#2f5bea';
  let rgb = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const lum = () => rgb.map(v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (let n = 0; lum() > 0.18 && n < 30; n++) rgb = rgb.map(v => Math.round(v * 0.9));
  document.documentElement.style.setProperty('--plan', `rgb(${rgb.join(' ')})`);
}

const ym = (y, m) => new Date(y, m, 15).toISOString().slice(0, 7);
const moisDe = (y, m, n) => [...Array(n)].map((_, i) => ym(y, m + i));
// Chaque liste tient dans sa case : ce qui dépasse est caché et compté dans « + N autres » (pas de défilement)
function ajuster() {
  $$('.cockpit .fit').forEach(ul => {
    const box = ul.closest('.box'), plus = box.querySelector('[data-plus]');
    const lis = [...ul.children].filter(li => !li.classList.contains('hors'));
    lis.forEach(li => li.classList.remove('deborde'));
    const bas = ul.getBoundingClientRect().bottom + 1, cache = lis.filter(li => li.getBoundingClientRect().bottom > bas);
    cache.forEach(li => li.classList.add('deborde'));
    const der = lis.filter(li => !cache.includes(li)).at(-1);
    if (der?.classList.contains('sep')) der.classList.add('deborde'); // pas de titre « Ensuite » sans rien dessous
    if (!plus) return;
    const lien = box.dataset.lien || cache[0]?.dataset.lien;
    plus.hidden = !lien;
    if (lien) { plus.href = lien; plus.innerHTML = (cache.length ? `+ ${plural(cache.length, 'autre')}` : 'Tout voir') + icon('chevR', 15); }
  });
}
let ajusteT;
addEventListener('resize', () => { clearTimeout(ajusteT); ajusteT = setTimeout(() => { if ($('.cockpit')) ajuster(); }, 120); });
let caseVue = 'todo'; // téléphone : la case affichée sous les chiffres (« Attend votre accord » d'abord)
const encoreDu = k => k.a_encaisser - k.en_retard > 0.005 ? `${k.en_retard ? 'et' : 'rien en retard,'} ${eur(k.a_encaisser - k.en_retard)} à venir` : k.en_retard ? 'C’est tout ce qu’on vous doit' : 'Personne ne vous doit rien';

// Accueil « cockpit » : tout tient dans l'écran, sur ordinateur comme sur téléphone (Hivan ne veut pas descendre)
async function dashboard() {
  const k = await api('dashboard');
  const enRetard = k.chantiers.filter(c => chantierInfo(c).late);
  const depuis = d => { const n = -joursJusqua(d.slice(0, 10)); return n <= 0 ? 'aujourd’hui' : n === 1 ? 'hier' : `il y a ${n} jours`; };
  // Boutons en toutes lettres sous chaque ligne : le 1er = ce que Kadra propose, le 2e = l'autre choix
  const bt = (attr, t, autre) => `<button class="btn sm ${autre ? 'ghost' : 'primary'}" ${attr}>${t}</button>`, va = href => `data-go="${href}"`;
  const quandRdv = r => new Date(r.debut.length > 10 ? r.debut : r.debut + 'T12:00').toLocaleDateString(LOC, { weekday: 'long', day: 'numeric', month: 'long' }) + (r.debut.length > 10 ? ' à ' + r.debut.slice(11, 16) : '');
  // « Attend votre accord » : une seule liste, les sujets en filtres au-dessus
  const groupes = [
    k.rdv_prop.length && { g: 'rdv', l: 'Rendez-vous', href: '#/agenda',
      items: k.rdv_prop.map(r => ({ href: '#/agenda/' + r.debut.slice(0, 10), av: r.client_nom ? avatar(r.client_nom) : `<span class="av">${icon('calendar', 16)}</span>`, t: r.client_nom || r.titre, s: `Rendez-vous trouvé dans un e-mail : ${quandRdv(r)}`,
        a: bt(`data-okp="${r.id}"`, 'Mettre à l’agenda') + bt(`data-nop="${r.id}"`, 'Ignorer', 1) })) },
    k.non_lus && { g: 'mails', l: 'E-mails', n: k.non_lus, href: '#/mails',
      items: k.mails.map(m => ({ href: '#/mails/' + m.id, av: avatar(m.client_nom || m.de), t: m.client_nom || m.de || 'Inconnu', s: `E-mail : ${m.sujet || '(sans objet)'}`, r: `<small>${quandCourt(m)}</small>`, a: bt(va('#/mails/' + m.id), 'Lire et répondre') })) },
    k.factures_retard.length && { g: 'argent', l: 'Impayés', href: '#/factures?retard',
      items: [...k.factures_retard].sort((a, b) => a.echeance.localeCompare(b.echeance)).map(f => ({ href: '#/doc/' + f.id, av: avatar(f.client_nom), t: f.client_nom || 'Un client', s: `Impayé, ${plural(-joursJusqua(f.echeance), 'jour')} de retard${f.relances ? `, ${plural(f.relances, 'relance')}` : ''}`,
        r: `<b class="crit">${eur(f.total_ttc - f.regle)}</b><small>${f.numero}</small>`, a: bt(`data-relance="${f.id}"`, 'Relancer') + bt(`data-encaisser="${f.id}"`, 'Il a payé', 1) })) },
    k.a_facturer.length && { g: 'facturer', l: 'À facturer', href: k.a_facturer.length === 1 ? k.a_facturer[0].href : '#/chantiers',
      items: k.a_facturer.map(x => ({ href: x.href, av: avatar(x.nom), t: x.nom || 'Un client', s: x.quoi, r: `<b>${eur(x.montant)}</b>`, a: bt(va(x.href), 'Faire la facture') })) },
    k.devis_a_relancer.length && { g: 'devis', l: 'Devis', href: '#/devis',
      items: [...k.devis_a_relancer].sort((a, b) => String(a.envoye_le).localeCompare(String(b.envoye_le))).map(d => ({ href: '#/doc/' + d.id, av: avatar(d.client_nom), t: d.client_nom || 'Un client', s: `Devis sans réponse${d.envoye_le ? `, envoyé ${depuis(d.envoye_le)}` : ''}`, r: `<b>${eur(d.total_ttc)}</b>`, a: bt(`data-relance="${d.id}"`, 'Relancer') })) },
    enRetard.length && { g: 'chantiers', l: 'Chantiers', href: '#/chantiers',
      items: enRetard.map(c => ({ href: '#/chantier/' + c.id, av: avatar(c.client_nom || c.nom), t: c.nom, s: `En retard : ${finTexte(c).toLowerCase()}`, a: bt(va('#/chantier/' + c.id), 'Voir le chantier', 1) })) },
  ].filter(Boolean);
  // « Kadra a fait pour vous » : ce qui s'est fait tout seul aujourd'hui, le plus récent en haut
  const heureDe = at => new Date(at).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' });
  const fait = k.fait.map(f => `<li data-href="${f.href}" class="${f.k}"><span class="hr">${heureDe(f.at)}</span><i aria-hidden="true"></i><div class="t"><b>${h(f.t)}</b><small>${h(f.s)}</small></div></li>`).join('');
  const nbTodo = groupes.reduce((s, g) => s + (g.n || g.items.length), 0);
  const ligne = (i, g) => `<li data-g="${g.g}" data-lien="${g.href}" data-href="${i.href}">${i.av}<div class="t"><b>${h(i.t)}</b><small>${h(i.s)}</small></div>${i.r ? `<div class="r">${i.r}</div>` : ''}${i.a || ''}</li>`;
  const plus = '<a class="plus" data-plus hidden></a>';
  const chLigne = c => { const late = chantierInfo(c).late;
    return `<li data-href="#/chantier/${c.id}"><div class="t"><b>${h(c.nom)}</b><small${late ? ' class="crit"' : ''}>${h([c.client_nom, finTexte(c)].filter(Boolean).join(' · '))}</small>${c.statut === 'a_venir' ? '' : avance(c)}</div>
<div class="r">${late || c.statut === 'a_venir' ? chantierPill(c) : `<b>${c.avancement || 0} %</b>`}</div></li>`; };
  const cases = [['todo', 'À valider', nbTodo], ['kfait', 'Kadra', k.fait.length], ['rdv', 'Aujourd’hui'], ['ch', 'Chantiers', k.chantiers.length]];
  // « Aujourd'hui » : les rendez-vous du jour d'abord, puis ceux des jours suivants
  const auj = k.rdv.filter(r => r.debut.slice(0, 10) === today()), ensuite = k.rdv.filter(r => !auj.includes(r));
  const evs = (a, jour) => evList(a, '', jour).replace(/^<ul class="evs">|<\/ul>$/g, '');
  const aFacturer = k.a_facturer.reduce((s, x) => s + x.montant, 0), av = k.a_venir;
  // CA HT de l'année (avoirs déduits), comparé à l'an dernier à la même date
  const an = new Date().getFullYear(), jour = today().slice(4), ca = k.ca.filter(r => r[0].startsWith(an)).reduce((s, r) => s + r[1], 0);
  const caAvant = k.ca.filter(r => r[0].startsWith(an - 1) && r[0].slice(4) <= jour).reduce((s, r) => s + r[1], 0), pct = caAvant > 0 ? Math.round(100 * (ca - caAvant) / caAvant) : null;
  const on = b => (b === caseVue ? ' on' : '');
  badges(k);
  const prenom = (ME.user.nom || '').split(' ')[0], late = enRetard.length, heure = new Date().getHours();
  head(prenom ? (heure >= 18 ? `Bonsoir ${prenom}` : `Bonjour ${prenom}`) : heure >= 18 ? 'Bonsoir' : 'Bonjour', `${new Date().toLocaleDateString(LOC, { weekday: 'long', day: 'numeric', month: 'long' })}. ${nbTodo ? `${plural(nbTodo, 'chose')} ${nbTodo > 1 ? 'attendent' : 'attend'} votre accord.` : 'Rien n’attend votre accord.'}`);
  view.innerHTML = `<div class="cockpit">
<div class="installer" data-install hidden>${LOGO}<div><b>Installez Kadra sur votre téléphone</b><small>Il s’ouvrira comme une appli, en plein écran.</small></div>
<button class="btn primary sm" data-installer>Installer</button><button class="btn ghost icon" data-install-non aria-label="Plus tard" title="Plus tard">${icon('x', 16)}</button></div>
<section class="kpis" aria-label="En bref">
  <a class="kpi ca-an" href="#/analyse"><span class="ki">${icon('chart', 20)}</span><span class="l" data-c="CA ${an}">Chiffre d’affaires ${an}</span><span class="v">${eur(ca)} <small>HT</small></span><small>${pct === null ? `${eur(k.encaisse_annee)} encaissés` : Math.abs(pct) < 100 ? `${pct >= 0 ? '+' : ''}${pct} % par rapport à ${an - 1} à la même date` : `${an - 1} à la même date : ${eur(caAvant)} HT`}</small></a>
  <a class="kpi crit" href="#/factures?retard"><span class="ki">${icon('euro', 20)}</span><span class="l" data-c="En retard">Paiements en retard</span><span class="v">${eur(k.en_retard)}</span><small>${encoreDu(k)}</small></a>
  <a class="kpi" href="${k.a_facturer.length === 1 ? k.a_facturer[0].href : '#/'}" data-voir="facturer"><span class="ki">${icon('file', 20)}</span><span class="l" data-c="À facturer">À facturer</span><span class="v">${eur(aFacturer)}</span><small>${k.a_facturer.length ? `${plural(k.a_facturer.length, 'facture')} à faire` : 'Rien d’oublié'}</small></a>
  <a class="kpi" href="#/chantiers"><span class="ki">${icon('helmet', 20)}</span><span class="l" data-c="Signé à venir">Travail signé à venir</span><span class="v">${eur(av.ht)} <small>HT</small></span><small>${av.nb ? `${plural(av.nb, 'chantier')}${av.jusqua ? `, jusqu’au ${new Date(av.jusqua).toLocaleDateString(LOC, { day: 'numeric', month: 'long' })}` : ''}` : 'Aucun chantier signé'}${late ? ` · ${late} en retard` : ''}</small></a>
</section>
<div class="seg ctabs" role="group" aria-label="Afficher">${cases.map(([b, l, n]) => `<button data-case="${b}" class="${on(b)}">${l}${n ? ` <em>${n}</em>` : ''}</button>`).join('')}</div>
<section class="box todo${on('todo')}" data-lien="${groupes.length === 1 ? groupes[0].href : ''}"><div class="bh"><h2>Attend votre accord</h2>${plus}</div>
${groupes.length > 1 ? `<div class="seg filtres" role="group" aria-label="Sujet"><button data-g="" class="on">Tout <em>${nbTodo}</em></button>${groupes.map(g => `<button data-g="${g.g}">${g.l} <em>${g.n || g.items.length}</em></button>`).join('')}</div>` : ''}
${groupes.length ? `<ul class="lig fit">${groupes.flatMap(g => g.items.map(i => ligne(i, g))).join('')}</ul>`
    : `<div class="empty fait"><span class="ok">${icon('check', 30)}</span><p><b>Tout est à jour.</b><br>Rien en retard, aucun message à lire.</p></div>`}</section>
<section class="box rdv${on('rdv')}" data-lien="#/agenda"><div class="bh"><h2>Aujourd’hui</h2><button class="btn ghost sm icon" id="addrdv" title="Ajouter un rendez-vous" aria-label="Ajouter un rendez-vous">${icon('plus', 16)}</button>${plus}</div>
<ul class="evs fit">${auj.length ? evs(auj) : '<li class="rien">Aucun rendez-vous aujourd’hui.</li>'}${ensuite.length ? `<li class="sep">Ensuite</li>${evs(ensuite, true)}` : ''}</ul></section>
<section class="box ch${on('ch')}" data-lien="#/chantiers"><div class="bh"><h2>Vos chantiers</h2>${plus}</div>
${k.chantiers.length ? `<ul class="lig fit">${k.chantiers.map(chLigne).join('')}</ul>` : `<p class="muted">Aucun chantier en cours. Un devis signé crée son chantier automatiquement.</p>`}</section>
<section class="box kfait${on('kfait')}" data-lien="#/mails"><div class="bh"><h2>Kadra a fait pour vous</h2>${plus}</div>
${fait ? `<p class="fsous">Aujourd’hui, sans vous déranger : <b>${plural(k.fait.length, 'chose')}</b>.</p><ul class="tl fit">${fait}</ul>`
    : `<p class="muted">Rien encore aujourd’hui. Kadra relance vos clients, relève vos e-mails et note ici chaque signature et chaque paiement en ligne.</p>`}</section>
</div>`;
  montrerInstall();
  ajuster(); document.fonts?.ready.then(() => $('.cockpit') && ajuster());
  $('#addrdv').onclick = async () => { if (await editRdv()) route(); };
  $('.ctabs').onclick = e => {
    const b = e.target.closest('[data-case]'); if (!b) return;
    caseVue = b.dataset.case;
    $$('.ctabs [data-case]').forEach(x => x.classList.toggle('on', x === b));
    $$('.cockpit .box').forEach(x => x.classList.toggle('on', x.classList.contains(caseVue)));
    ajuster();
  };
  const filtres = $('.filtres');
  if (filtres) filtres.onclick = e => {
    const b = e.target.closest('[data-g]'); if (!b) return;
    const g = b.dataset.g;
    $$('.filtres [data-g]').forEach(x => x.classList.toggle('on', x === b));
    $$('.todo .fit li').forEach(li => li.classList.toggle('hors', !!g && li.dataset.g !== g));
    $('.box.todo').dataset.lien = g ? groupes.find(x => x.g === g).href : '';
    ajuster();
  };
  // « À facturer » (plusieurs) : montre la liste dans « À faire » au lieu de changer de page
  $('[data-voir]').onclick = e => {
    if (k.a_facturer.length < 2) return;
    e.preventDefault();
    $(`.ctabs [data-case="todo"]`).click();
    $('.filtres [data-g="facturer"]')?.click();
  };
  view.addEventListener('click', e => {
    const b = e.target.closest('[data-relance]');
    if (b) busy(b, async () => { const r = await api(`documents/${b.dataset.relance}/relancer`, 'POST'); toast('Relance : ' + r.statut); b.outerHTML = P('Relancé', 'good', 'check'); });
    const en = e.target.closest('[data-encaisser]');
    if (en) encaisser(k, k.factures_retard.find(f => f.id === +en.dataset.encaisser), en.closest('li'));
    const go = e.target.closest('[data-go]');
    if (go) location.hash = go.dataset.go;
    const ok = e.target.closest('[data-okp],[data-nop]');
    if (ok) busy(ok, async () => {
      if (ok.dataset.okp) { await api('rdv/' + ok.dataset.okp, 'PUT', { statut: 'confirme' }); toast('Ajouté à l’agenda'); }
      else { await api('rdv/' + ok.dataset.nop, 'DELETE'); toast('Proposition ignorée'); }
      route();
    });
  });
}

// Encaisser depuis l'accueil : la ligne se coche, s'en va, et les montants dus descendent
async function encaisser(k, f, li) {
  const reste = r2(f.total_ttc - f.regle);
  const v = await modal({ title: 'Encaisser', ok: 'Enregistrer', text: `${h(f.numero)}, ${h(f.client_nom || '')} : il reste ${eur(reste)} à payer.`, fields: [
    { name: 'montant', label: 'Montant', type: 'number', step: '0.01', required: true, value: reste, cls: 'third' },
    { name: 'date', label: 'Date', type: 'date', value: today(), cls: 'third' },
    { name: 'mode', label: 'Mode', type: 'select', value: 'Virement', options: MODES.map(m => [m, m]), cls: 'third' }] });
  if (!v) return;
  const montant = r2(+v.montant);
  try { await api('payments', 'POST', { document_id: f.id, montant, date: v.date, mode: v.mode }); } catch (err) { return toast(err.message, 'crit'); }
  f.regle = r2(f.regle + montant);
  const baisse = (el, de, a) => { if (!el?.firstChild) return; el.firstChild.data = eur(a); compter(el, de, 800); };
  k.a_encaisser = r2(k.a_encaisser - montant);
  baisse($('.kpi.crit .v'), k.en_retard, k.en_retard = r2(Math.max(0, k.en_retard - montant)));
  $('.kpi.crit>small').textContent = encoreDu(k);
  if (montant < reste - 0.005) { li.querySelector('.r b').textContent = eur(reste - montant); return toast('Règlement enregistré'); }
  li.classList.add('paye');
  li.querySelectorAll('.btn').forEach(b => b.remove());
  li.querySelector('.r').innerHTML = P('Payé', 'good', 'check');
  toast(`${f.numero} payée`);
  setTimeout(() => {
    const ul = li.parentElement, fin = () => { li.remove(); if (!ul.children.length) ul.outerHTML = '<p class="vide">Tout est encaissé. Bien joué.</p>'; ajuster(); };
    if (calme()) return fin();
    li.style.overflow = 'hidden';
    li.animate([{ height: li.offsetHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }],
      { duration: 420, easing: 'cubic-bezier(.4,0,.2,1)' }).onfinish = fin;
  }, 900);
}

// ---------- Analyse : qui paie bien, ce qui rapporte, ce qui se signe ----------
// Barres horizontales en HTML (lisibles sur téléphone sans recalcul de SVG).
// Cartes chiffrées en haut des pages, comme sur l'accueil : pastille d'icône, chiffre qui défile, phrase dessous
const kpiRow = items => `<section class="kpis" aria-label="En bref">${items.map(k => { const t = k.href ? 'a' : 'div';
  return `<${t} class="kpi vio"${k.href ? ` href="${k.href}"` : ''}><span class="ki">${icon(k.ic, 20)}</span><span class="l">${k.l}</span><span class="v">${k.v}</span>${k.s ? (k.s.startsWith('<') ? k.s : `<small>${k.s}</small>`) : ''}</${t}>`; }).join('')}</section>`;
const NOTE = { bon: 'Paie à temps', moyen: 'Un peu en retard', mauvais: 'Paie mal' };
const conseilsHTML = c => c ? `<ul class="todo rows">${c.conseils.map(x => `<li><span class="chip plan">${icon({ client: 'users', chantier: 'helmet', devis: 'file' }[x.sujet] || 'sparkle')}</span><div class="t"><b>${h(x.titre)}</b><small>${h(x.texte)}</small></div></li>`).join('')}</ul>
<p class="muted" style="font-size:13px;margin:10px 0 0">Conseils du ${dfr(c.le)}, d’après vos chiffres de ce jour-là.</p>`
  : `<div class="empty">${icon('sparkle', 28)}<p>Kadra lit vos clients, vos chantiers et vos devis, et vous dit quoi changer pour gagner plus et être payé plus vite.</p></div>`;

// Frise du chiffre d'affaires HT : 12 mois d'une année (comparés à l'année d'avant) ou une barre par année
let friseVue = null;
function frise(ca) {
  const now = new Date(), cur = now.getFullYear(), { p, y } = friseVue;
  const somme = pre => ca.filter(r => r[0].startsWith(pre)).reduce((s, r) => s + r[1], 0);
  const debut = Math.min(cur, ...ca.map(r => +r[0].slice(0, 4)).filter(Boolean));
  const ans = [...Array(cur - debut + 1)].map((_, i) => String(debut + i));
  const moisN = y === cur ? now.getMonth() + 1 : 12, mL = mo => new Date(mo + '-15T12:00').toLocaleDateString(LOC, { month: 'long' });
  const mini = items => `<div class="mini">${items.map(([l, v, s]) => `<div><small>${l}</small><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`).join('')}</div>`;
  let haut, graph;
  if (p === 'annee') {
    const rows = ans.map(a => ({ l: a, facture: somme(a) })), best = rows.reduce((b, r) => (r.facture > b.facture ? r : b));
    haut = mini([['Depuis ' + debut, `${eur(rows.reduce((s, r) => s + r.facture, 0))} HT`], ['Meilleure année', best.facture ? best.l : '–', best.facture ? eur(best.facture) + ' HT' : ''], ['Moyenne par an', `${eur(rows.reduce((s, r) => s + r.facture, 0) / rows.length)} HT`]]);
    graph = chart(rows, ['Chiffre d’affaires HT']);
  } else {
    const rows = moisDe(y, 0, 12).map(mo => ({ mois: mo, facture: somme(`${y - 1}${mo.slice(4)}`), encaisse: somme(mo) }));
    const ht = rows.reduce((s, r) => s + r.encaisse, 0), avant = rows.slice(0, moisN).reduce((s, r) => s + r.facture, 0);
    const pct = avant > 0 ? Math.round((100 * (ht - avant)) / avant) : null, best = rows.reduce((b, r) => (r.encaisse > b.encaisse ? r : b));
    haut = mini([[`Chiffre d’affaires ${y}${y === cur ? ' à ce jour' : ''}`, `${eur(ht)} HT`, pct === null ? `rien en ${y - 1} sur la même période` : `${pct >= 0 ? '+' : ''}${pct} % par rapport à ${y - 1}${y === cur ? ` (janvier à ${mL(rows[moisN - 1].mois)})` : ''}`],
      ['Meilleur mois', best.encaisse ? mL(best.mois) : '–', best.encaisse ? eur(best.encaisse) + ' HT' : ''], ['Moyenne par mois', `${eur(ht / moisN)} HT`, y === cur ? `sur ${plural(moisN, 'mois', 'mois')}` : '']]);
    graph = `<div class="legend" style="margin-bottom:8px"><span><i style="background:var(--s1);border-radius:50%"></i>${y - 1}</span><span><i style="background:var(--s3);border-radius:50%"></i>${y}</span></div>${chart(rows, [String(y - 1), String(y)])}`;
  }
  return `<div class="ph"><h2>Évolution du chiffre d’affaires</h2><div class="seg" role="group" aria-label="Affichage">${[['mois', 'Par mois'], ['annee', 'Par année']].map(([k, l]) => `<button data-fp="${k}" class="${k === p ? 'on' : ''}">${l}</button>`).join('')}</div></div>
<div class="pb">${p === 'mois' ? `<div class="canav"><button class="btn icon ghost" data-fy="-1" aria-label="Année précédente" ${y <= debut ? 'disabled' : ''}>${icon('chevL')}</button><b>${y}${y === cur ? ' <small class="muted">(en cours)</small>' : ''}</b><button class="btn icon ghost" data-fy="1" aria-label="Année suivante" ${y >= cur ? 'disabled' : ''}>${icon('chevR')}</button></div>` : ''}${haut}${graph}</div>`;
}

async function analyse() {
  const a = await api('analyse');
  friseVue ||= { p: 'mois', y: new Date().getFullYear() };
  head('Analyse', 'Qui paie bien, quels chantiers rapportent, quels devis se signent.');
  const payeurs = a.clients.filter(c => c.note), ch = a.chantiers.filter(c => c.par_jour), tr = a.devis.tranches.filter(t => t.total);
  const top = ch[0], pctSigne = a.devis.envoyes ? Math.round((100 * a.devis.signes) / a.devis.envoyes) : null;
  if (!payeurs.length && !ch.length && !tr.length) {
    view.innerHTML = `<div class="panel empty">${icon('chart', 28)}<p>Pas encore assez de chiffres. L’analyse se remplit dès que vos premières factures sont payées et vos premiers chantiers terminés.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="stack">
${kpiRow([
  { ic: 'clock', l: 'On vous paie en moyenne en', v: `${a.delai_moyen ?? '–'} <small>jours</small>`, s: 'entre la facture et le dernier paiement' },
  { ic: 'file', l: 'Devis signés', v: `${pctSigne ?? '–'} %`, s: `${a.devis.envoyes ? `${a.devis.signes} sur ${a.devis.envoyes} devis avec une réponse` : 'Aucun devis avec une réponse'}${a.devis.jours_signature !== null ? `, signés en ${plural(a.devis.jours_signature, 'jour')} en moyenne` : ''}` },
  { ic: 'helmet', l: 'Chantier qui rapporte le plus', v: top ? `${eur(top.par_jour)} <small>/ jour</small>` : '–', s: top ? h(top.nom) : 'Pas de chantier avec des dates' },
])}
<section class="panel" id="frise">${frise(a.ca)}</section>
<section class="panel" id="conseils"><div class="ph"><h2>Conseils de Kadra</h2><button class="btn yellow" id="ask">${icon('sparkle', 15)}${a.conseils ? 'Mettre à jour' : 'Demander des conseils'}</button></div>
<div class="pb" id="cb">${conseilsHTML(a.conseils)}</div></section>
<section class="panel"><div class="ph"><h2>Vos clients : qui paie bien ?</h2></div><div class="pb">
<p class="ink2" style="margin:0 0 10px">Du meilleur payeur au moins bon : nombre de jours entre la facture et le paiement complet.</p>
<div class="tscroll"><table class="list"><thead><tr><th>Client</th><th class="n">Paie en</th><th class="n hide-m">Facturé HT</th><th class="n">Reste à payer</th><th class="n hide-m">Relances</th><th class="n hide-m">Devis signés</th><th class="hide-m">Bilan</th></tr></thead><tbody>
${[...a.clients].sort((x, y) => !x.note - !y.note || (x.en_retard ? Math.max(x.delai || 0, x.retard_max) : x.delai ?? 1e9) - (y.en_retard ? Math.max(y.delai || 0, y.retard_max) : y.delai ?? 1e9)).map(c => `<tr ${c.id ? `data-href="#/client/${c.id}"` : ''}>
<td><div class="who">${avatar(c.nom)}<div><b>${h(c.nom)}</b>${c.en_retard ? `<small>impayé depuis ${plural(c.retard_max, 'jour')}</small>` : ''}</div></div></td>
<td class="n">${c.delai !== null ? plural(c.delai, 'jour') : '–'}</td><td class="n amt hide-m">${eur(c.ht)}</td><td class="n amt">${c.reste ? eur(c.reste) : '–'}</td>
<td class="n hide-m">${c.relances || '–'}</td><td class="n hide-m">${c.devis ? `${c.signes} / ${c.devis}` : '–'}</td><td class="hide-m">${c.note ? `<span class="note-${c.note}">${NOTE[c.note]}</span>` : '<span class="muted">Pas encore payé</span>'}</td></tr>`).join('')}</tbody></table></div>
</div></section>
<section class="panel"><div class="ph"><h2>Ce que rapporte une journée de chantier</h2></div><div class="pb">
${ch.length ? `<p class="ink2" style="margin:0 0 10px">Prix HT du chantier moins vos dépenses, divisé par sa durée. Vos heures ne sont pas comptées : c’est une comparaison, pas un bénéfice.</p>
<div class="tscroll"><table class="list"><thead><tr><th>Chantier</th><th class="n hide-m">Prix HT</th><th class="n hide-m">Dépenses</th><th class="n hide-m">Durée</th><th class="n">Par jour</th></tr></thead><tbody>
${ch.map(c => `<tr data-href="#/chantier/${c.id}"><td><b>${h(c.nom)}</b><small class="muted" style="display:block">${[c.retard && `${plural(c.retard, 'jour')} de retard`, { en_cours: 'en cours', a_venir: 'à venir, d’après les dates prévues' }[c.statut]].filter(Boolean).join(' · ')}</small></td>
<td class="n amt hide-m">${eur(c.ht)}</td><td class="n amt hide-m">${c.depenses ? eur(c.depenses) : '–'}</td><td class="n hide-m">${plural(c.duree, 'jour')}</td><td class="n amt"><b>${eur(c.par_jour)}</b></td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">Aucun chantier avec une date de début et de fin.</p>`}
</div></section>
<section class="panel"><div class="ph"><h2>Quels devis se signent ?</h2></div><div class="pb">
${tr.length ? `<p class="ink2" style="margin:0 0 10px">Part des devis signés, selon leur montant HT (devis acceptés ou refusés).</p>
<table class="list"><thead><tr><th>Montant du devis</th><th class="n">Signés</th><th class="n">Taux</th></tr></thead><tbody>
${tr.map(t => `<tr><td>${h(t.label)}</td><td class="n">${t.signes} sur ${t.total}</td><td class="n"><b>${Math.round((100 * t.signes) / t.total)} %</b></td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">Aucun devis accepté ou refusé pour l’instant.</p>`}
</div></section>
</div>`;
  $('#frise').onclick = e => {
    const p = e.target.closest('[data-fp]')?.dataset.fp, dir = +e.target.closest('[data-fy]')?.dataset.fy || 0;
    if (p) friseVue = { ...friseVue, p }; else if (dir) friseVue = { ...friseVue, y: friseVue.y + dir }; else return;
    $('#frise').innerHTML = frise(a.ca);
  };
  $('#ask').onclick = e => busy(e.currentTarget, async () => {
    const b = $('#ask'); b.innerHTML = `${icon('sparkle', 15)}Kadra lit vos chiffres…`;
    try { $('#cb').innerHTML = conseilsHTML(await api('ai/analyse', 'POST')); b.innerHTML = `${icon('sparkle', 15)}Mettre à jour`; }
    catch (err) { b.innerHTML = `${icon('sparkle', 15)}Réessayer`; throw err; }
  });
}

// Photos jointes à la dictée d'un devis (pièce, plan) : gardées avec le devis, copiées dans le chantier quand il est créé
async function photosDevis(id) {
  const zone = $('#dphs'), list = await api('doc_photos?document_id=' + id).catch(() => []);
  if (!zone?.isConnected) return;
  zone.innerHTML = list.length ? `<div class="photos">${list.map(p => `<button data-dp="${p.id}" title="Agrandir"><img src="${h(p.image)}" alt="Photo du devis" loading="lazy"></button>`).join('')}</div>`
    : '<p class="muted">Photos de la pièce ou plan coté : Kadra les lit quand vous dictez, et elles suivent le devis jusqu’au chantier.</p>';
  zone.onclick = async e => {
    const p = list.find(x => x.id === +e.target.closest('[data-dp]')?.dataset.dp);
    if (p && await modal({ title: 'Photo du devis', wide: true, html: `<img class="photo-big" src="${h(p.image)}" alt="">`, ok: 'Supprimer la photo', danger: true })) { await api('doc_photos/' + p.id, 'DELETE'); toast('Photo supprimée'); photosDevis(id); }
  };
  $('#dadd').onchange = async e => {
    const fs = [...e.target.files]; e.target.value = '';
    try { for (const f of fs) await api('doc_photos', 'POST', { document_id: +id, image: await imageURL(f, 1600) }); toast(fs.length > 1 ? 'Photos ajoutées' : 'Photo ajoutée'); photosDevis(id); }
    catch (err) { toast(err.message, 'crit'); }
  };
}

// ---------- Nouveau devis à la voix ----------
async function nouveau(baseId) {
  const base = baseId && await api('documents/' + baseId);
  head('Dicter un devis', base ? `À partir du devis type « ${h(base.nom || base.data.objet)} ».` : '');
  view.innerHTML = `<div class="dictee" id="dictee">
<section class="studio" aria-label="Dictée">
  <div class="micwrap"><button class="mic" id="mic" aria-pressed="false" aria-label="Démarrer ou arrêter la dictée">${icon('mic', 52)}</button>
  <canvas class="wave" id="wave" aria-hidden="true"></canvas><p class="state" id="state">Appuyez et parlez.</p></div>
  <div class="carnet"><textarea id="txt" rows="4" aria-label="Texte dicté" placeholder="Ce que vous dites s’écrit ici."></textarea></div>
  <p class="interim" id="interim"></p>
  <div class="dphotos" id="phs"></div>
  <div class="row"><label class="btn" title="Une photo de la pièce, du chantier ou d’un plan coté">${icon('image', 16)}Ajouter une photo<input type="file" id="ph" accept="image/*" multiple hidden></label>
  <button class="btn yellow big" id="go">${icon('sparkle')}Rédiger le devis</button></div>
  <button class="vide" id="vide">ou partir d’un devis vide</button>
  ${(S.style?.devis?.length || S.regles?.length) ? `<a class="vide" style="text-align:center" href="#/parametres/style">${icon('sparkle', 13)} Kadra écrit comme vous : ${plural((S.style?.devis?.length || 0) + (S.regles?.length || 0), 'habitude')} retenue${(S.style?.devis?.length || 0) + (S.regles?.length || 0) > 1 ? 's' : ''}</a>` : ''}
</section>
<aside class="paper" id="live" hidden><div class="bar">${icon('sparkle', 16)}<span id="lst">Kadra rédige votre devis…</span></div><iframe id="lpv" title="Devis en cours de rédaction"></iframe></aside>
</div>`;
  const txt = $('#txt');
  const ETAT = 'Appuyez et parlez.';
  // Photos du chantier ou d'un plan, lues par Kadra avec la dictée (1600 px : les cotes d'un plan restent lisibles)
  let photos = [];
  const montrerPhotos = () => { $('#phs').innerHTML = photos.map((p, i) => `<span><img src="${p}" alt="Photo ${i + 1}"><button data-i="${i}" title="Enlever la photo" aria-label="Enlever la photo ${i + 1}">${icon('x', 14)}</button></span>`).join(''); };
  $('#ph').onchange = async e => {
    const fs = [...e.target.files].slice(0, 4 - photos.length); e.target.value = '';
    if (!fs.length) return toast('4 photos au plus.', 'crit');
    try { for (const f of fs) photos.push(await imageURL(f, 1600)); } catch (err) { toast(err.message, 'crit'); }
    montrerPhotos();
  };
  $('#phs').onclick = e => { const b = e.target.closest('[data-i]'); if (b) { photos.splice(+b.dataset.i, 1); montrerPhotos(); } };
  // Sans réseau : la dictée et les photos attendent sur l'appareil ; Kadra rédige dès que le réseau revient.
  const plusTard = () => {
    mettreEnAttente('devis', { transcript: txt.value, photos, base_id: base?.id || null });
    txt.value = ''; photos = []; montrerPhotos();
    toast('Pas de réseau : la dictée est gardée sur le téléphone. Kadra rédigera le devis dès que le réseau revient.');
  };
  // Le devis s'affiche à côté pendant que Claude l'écrit (réponse en flux : une ligne JSON par étape).
  let vues = 0; // lignes affichées : un aperçu qui repart de zéro n'efface pas les lignes déjà montrées
  const apercu = html => {
    vues = (html.match(/<tr/g) || []).length;
    const d = $('#lpv').contentDocument;
    d.open(); d.write(html); d.close();
    d.querySelector('table.lignes tbody tr:last-child')?.scrollIntoView({ block: 'center' });
  };
  const envoyer = (plus, signal) => fetch('/api/ai/devis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ transcript: txt.value.trim(), photos, base_id: base?.id || null, live: true, ...(visiteEn() && !VIS.devis && { exemple: true }), ...plus }) });
  // Lit la réponse en flux ; rend l'id du devis enregistré (null si la session a expiré).
  const lire = async (r, sansRecul) => {
    if (r.status === 401) { login(); return null; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const rd = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let reste = '', cache = null;
    for (;;) {
      const { value, done } = await rd.read();
      if (done) { if (cache) apercu(cache); return; } // le devis complet s'affiche toujours, même plus court
      const ls = (reste + value).split('\n');
      reste = ls.pop();
      for (const l of ls.filter(Boolean)) {
        const m = JSON.parse(l);
        if (m.error) throw new Error(m.error);
        if (m.html) { if (sansRecul && (m.html.match(/<tr/g) || []).length < vues) cache = m.html; else { apercu(m.html); cache = null; } }
        if (m.id) return m.id;
      }
    }
  };
  const montrer = () => { $('#dictee').classList.add('live'); $('#live').hidden = false; };
  // Pendant la dictée, à chaque phrase finie, Kadra remplit le devis à côté (un seul à la fois ; le dernier texte gagne).
  // « Rédiger le devis » reprend ensuite ce devis sans attendre si rien n'a changé depuis.
  let ap = null, encore = false, dernier = '', fini = false;
  const previsu = async () => {
    const t = txt.value.trim();
    if (!txt.isConnected) return;
    if (ap) { encore = true; return; }
    if (fini || t.length < 15 || t === dernier || !navigator.onLine) return;
    dernier = t; ap = new AbortController();
    montrer(); $('#lst').textContent = 'Kadra remplit le devis pendant que vous parlez…';
    try { await lire(await envoyer({ apercu: true }, ap.signal), true); } catch { /* aperçu seulement : la vraie rédaction se fait au bouton */ }
    ap = null;
    if (encore) { encore = false; if (txt.value.trim() !== dernier) return previsu(); }
    if (!fini && $('#lst')) $('#lst').textContent = 'Devis à jour. Continuez à parler, ou « Rédiger le devis » pour le garder.';
  };
  const gen = () => busy($('#go'), async () => {
    if (!txt.value.trim() && !photos.length) throw new Error('Dictez ou écrivez d’abord le contenu du devis, ou ajoutez une photo.');
    if (!navigator.onLine) return plusTard();
    fini = true;
    if (ap && txt.value.trim() !== dernier) ap.abort(); // texte changé depuis l'aperçu : on refait
    $('#state').textContent = 'Rédaction en cours…'; $('#lst').textContent = 'Kadra rédige votre devis…';
    montrer();
    if (matchMedia('(max-width: 900px)').matches) $('#live').scrollIntoView({ behavior: 'smooth' });
    let r;
    try { r = await envoyer({}); }
    catch { fini = false; return plusTard(); }
    const id = await lire(r);
    if (id === null) return;
    if (!id) throw new Error('La rédaction a été interrompue : réessayez.');
    $('#lst').textContent = 'Devis rédigé'; toast('Devis rédigé'); location.hash = '#/doc/' + id;
  }).finally(() => {
    fini = false;
    if (!$('#state')) return;
    $('#state').textContent = ETAT;
    if (!location.hash.startsWith('#/doc/')) { $('#dictee').classList.remove('live'); $('#live').hidden = true; }
  });
  mic($('#mic'), {
    initial: () => txt.value, canvas: $('#wave'),
    onState: on => { $('#state').textContent = on ? 'Je vous écoute… Appuyez pour terminer.' : ETAT; },
    onLive: (f, i) => { const neuf = f !== txt.value; txt.value = f; $('#interim').textContent = i; if (neuf) previsu(); },
    onFinal: f => { $('#interim').textContent = ''; if (f) txt.value = f; previsu(); },
  });
  $('#go').onclick = gen;
  if (dicteeVocale) { txt.value = dicteeVocale; dicteeVocale = ''; gen(); }
  $('#vide').onclick = async () => {
    const d = base ? await api(`documents/${base.id}/dupliquer`, 'POST', { type: 'devis' }) : await api('documents', 'POST', { type: 'devis', data: emptyData() });
    location.hash = '#/doc/' + d.id;
  };
}

// Situation de travaux : l'artisan donne l'avancement total (cumulé) ; ce qui a déjà été facturé est déduit tout seul.
async function demanderAvancement(av = 0) {
  const v = await modal({ title: 'Situation de travaux', ok: 'Créer la situation', text: 'Indiquez où en sont les travaux au total, depuis le début. Kadra facture la différence avec les acomptes et situations déjà faits.',
    fields: [{ name: 'pct', label: 'Travaux réalisés (%)', type: 'number', value: av || '', step: 'any', required: true, placeholder: 'Ex. 60' }] });
  return v && +v.pct;
}

// ---------- Listes de documents ----------
const FILTRES = {
  devis: [['tous', 'Tous', () => true], ['brouillon', 'Brouillons', d => d.statut === 'brouillon'], ['envoye', 'Envoyés', d => d.statut === 'envoye'], ['accepte', 'Acceptés', d => d.statut === 'accepte'], ['refuse', 'Refusés', d => d.statut === 'refuse']],
  facture: [['tous', 'Toutes', () => true], ['apayer', 'À payer', d => d.kind !== 'avoir' && d.numero && d.regle < d.total_ttc - 0.005], ['retard', 'En retard', d => d.kind !== 'avoir' && d.numero && d.regle < d.total_ttc - 0.005 && d.echeance < today()],
    ['payee', 'Payées', d => d.kind !== 'avoir' && d.numero && d.regle >= d.total_ttc - 0.005], ['brouillon', 'Brouillons', d => !d.numero], ['avoir', 'Avoirs', d => d.kind === 'avoir']],
  modele: [['tous', 'Tous', () => true]],
};
async function liste(type, filtre = 'tous') {
  const docs = await api('documents?type=' + type);
  const sum = (a, f = d => d.total_ttc) => eur(a.reduce((s, d) => s + f(d), 0));
  const F = FILTRES[type];
  if (type === 'devis') head('Devis', `${plural(docs.length, 'devis', 'devis')}, ${sum(docs.filter(d => d.statut === 'envoye'))} en attente de réponse`,
    `<button class="btn primary" id="nouvDevis">${icon('plus')}Nouveau devis</button>`);
  if ($('#nouvDevis')) $('#nouvDevis').onclick = () => nouveauDevis();
  if (type === 'facture') head('Factures', `${sum(docs.filter(F[1][2]), d => d.total_ttc - d.regle)} à encaisser, dont ${sum(docs.filter(F[2][2]), d => d.total_ttc - d.regle)} en retard`,
    `<button class="btn" id="compta">${icon('download', 16)}Pour le comptable</button><button class="btn primary" id="new" title="Facture sans devis (dépannage, petite intervention)">${icon('plus')}Nouvelle facture</button>`);
  if ($('#compta')) $('#compta').onclick = exportCompta;
  if (type === 'modele') head('Devis types', 'Vos devis génériques : choisissez-en un, dictez le client et les ajustements.', `<button class="btn primary" id="new">${icon('plus')}Nouveau devis type</button>`);
  const an = String(new Date().getFullYear()), cetteAnnee = d => String(d.date || '').startsWith(an);
  const rep = docs.filter(d => d.statut === 'accepte' || d.statut === 'refuse'), signes = docs.filter(d => d.statut === 'accepte');
  const reste = d => d.total_ttc - d.regle, nbF = f => docs.filter(f).length;
  const chiffres = type === 'devis' ? kpiRow([
    { ic: 'send', l: 'En attente de réponse', v: nbF(F[2][2]), s: `pour ${sum(docs.filter(F[2][2]))} de travaux`, href: '#/devis' },
    { ic: 'check', l: `Signés en ${an}`, v: signes.filter(cetteAnnee).length, s: `${sum(signes.filter(cetteAnnee))} TTC` },
    { ic: 'chart', l: 'Taux de signature', v: rep.length ? `${Math.round((100 * signes.length) / rep.length)} %` : '–', s: rep.length ? `${signes.length} signés sur ${rep.length} avec une réponse` : 'Aucune réponse pour l’instant', href: '#/analyse' },
  ]) : type === 'facture' ? kpiRow([
    { ic: 'euro', l: 'À encaisser', v: sum(docs.filter(F[1][2]), reste), s: plural(nbF(F[1][2]), 'facture') + ' à payer' },
    { ic: 'alert', l: 'En retard', v: sum(docs.filter(F[2][2]), reste), s: nbF(F[2][2]) ? P(plural(nbF(F[2][2]), 'facture') + ' après l’échéance', 'crit', 'alert') : 'Rien en retard' },
    { ic: 'receipt', l: `Facturé en ${an}`, v: sum(docs.filter(d => d.numero && cetteAnnee(d))), s: 'TTC, avoirs déduits' },
  ]) : '';
  view.innerHTML = `${chiffres ? `<div style="margin-bottom:18px">${chiffres}</div>` : ''}<div class="row" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
${F.length > 1 ? `<div class="seg" role="tablist">${F.map(([k, l, f]) => `<button data-f="${k}" class="${k === filtre ? 'on' : ''}">${l} <em>${docs.filter(f).length}</em></button>`).join('')}</div>` : ''}
<input id="q" style="flex:1 1 240px;max-width:380px" placeholder="Rechercher un client, un objet, un numéro" aria-label="Rechercher"></div>
<section class="panel" id="rows"></section>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase(), f = F.find(x => x[0] === filtre)[2];
    $('#rows').innerHTML = docTable(docs.filter(d => f(d) && (!q || JSON.stringify([d.numero, d.nom, d.client_nom, d.data.objet]).toLowerCase().includes(q))),
      type === 'facture' ? 'Aucune facture ici. Une facture se crée depuis un devis accepté.<br><a href="#/import">Vous en avez déjà ailleurs ? Importez-les</a>' : type === 'modele' ? 'Aucun devis type. Créez-en un, ou enregistrez un devis existant comme devis type.' : 'Aucun devis ici. Dictez votre premier devis.<br><a href="#/import">Vous en avez déjà ailleurs ? Importez-les</a>');
  };
  draw();
  $('#q').oninput = draw;
  $$('[data-f]', view).forEach(b => { b.onclick = () => { filtre = b.dataset.f; $$('[data-f]', view).forEach(x => x.classList.toggle('on', x === b)); draw(); }; });
  if ($('#new')) $('#new').onclick = async () => { location.hash = '#/doc/' + (await api('documents', 'POST', type === 'modele' ? { type: 'modele', nom: 'Nouveau devis type', data: emptyData() } : { type: 'facture', data: { ...emptyData(), acompte_pct: 0 } })).id; };
}

// ---------- Nouveau devis : d'abord le client (nouveau ou déjà connu), puis le devis s'ouvre avec ce client ----------
function choisirClient(clients) {
  return new Promise(res => {
    let choisi = null;
    const liste = () => {
      dlg.innerHTML = `<div class="mform"><h2>Pour quel client ?</h2>
<button type="button" class="pick neuf" id="cneuf"><span class="av">${icon('plus', 16)}</span><span><b>Nouveau client</b><small>Il n’est pas encore dans votre liste</small></span></button>
${clients.length ? `<input id="cq" placeholder="Chercher parmi vos ${clients.length} clients" aria-label="Chercher un client" autocomplete="off"><ul class="picks" id="cl"></ul>` : ''}
<div class="mact"><button type="button" class="btn" id="cx">Annuler</button></div></div>`;
      const draw = () => {
        const q = $('#cq').value.trim().toLowerCase();
        $('#cl').innerHTML = clients.filter(c => !q || [c.nom, c.email, c.tel, c.adresse].join(' ').toLowerCase().includes(q))
          .map(c => `<li><button type="button" class="pick" data-c="${c.id}">${avatar(c.nom)}<span><b>${h(c.nom)}</b><small>${h([String(c.adresse || '').split('\n').pop(), c.tel].filter(Boolean).join(' · '))}</small></span></button></li>`).join('')
          || '<li class="muted" style="padding:10px 12px">Aucun client trouvé. Créez-le avec « Nouveau client ».</li>';
      };
      if (clients.length) { draw(); $('#cq').oninput = draw; $('#cq').focus(); }
      $('#cneuf').onclick = fiche;
      $('#cx').onclick = () => dlg.close();
      dlg.onclick = e => { const b = e.target.closest('[data-c]'); if (b) { choisi = clients.find(c => c.id === +b.dataset.c); dlg.close(); } };
    };
    const fiche = () => {
      dlg.innerHTML = `<form class="mform" id="cf"><h2>Nouveau client</h2>${CLIENT_FIELDS({}).map(field).join('')}
<div class="mact"><button type="button" class="btn" id="cback">Retour à la liste</button><button class="btn primary">Créer et faire le devis</button></div></form>`;
      $('#cback').onclick = liste;
      $('#cf').onsubmit = async e => {
        e.preventDefault();
        try { choisi = await api('clients', 'POST', Object.fromEntries(new FormData(e.target))); dlg.close(); } catch (err) { toast(err.message, 'crit'); }
      };
      $('input', dlg).focus();
    };
    dlg.className = 'wide';
    dlg.onclose = () => { dlg.onclick = null; res(choisi); };
    liste();
    dlg.showModal();
  });
}
async function nouveauDevis(c) {
  c ||= await choisirClient(await api('clients'));
  if (!c) return;
  const data = { ...emptyData(), client: { nom: c.nom, adresse: c.adresse || '', email: c.email || '', tel: c.tel || '', siret: c.siret || '' } };
  location.hash = '#/doc/' + (await api('documents', 'POST', { type: 'devis', client_id: c.id, data })).id;
}

// ---------- Éditeur de document ----------
async function sendDialog(id) {
  const m = await api(`documents/${id}/mail`);
  const v = await modal({
    title: 'Envoyer au client', ok: 'Envoyer', wide: true,
    text: 'Le PDF est joint automatiquement. Les {variables} (numéro, montant, lien de signature ou de paiement) sont remplies à l’envoi.',
    fields: [{ name: 'to', label: 'Destinataire', type: 'email', value: m.to, required: true }, { name: 'sujet', label: 'Objet', value: m.sujet }, { name: 'corps', label: 'Message', type: 'textarea', value: m.corps, rows: 9 }],
  });
  if (!v) return false;
  const r = await api(`documents/${id}/send`, 'POST', v);
  toast('E-mail ' + r.statut);
  return true;
}

const TVAS = [0, 5.5, 10, 20];
// Habillage de la feuille dans la fiche document : page posée sur fond gris, textes modifiables signalés au survol (rien de tout ça au PDF).
const DOC_ED_CSS = `<style>
.kd-sug{position:absolute;z-index:9;background:#fff;border:1px solid #dde2ec;border-radius:12px;box-shadow:0 10px 30px rgba(20,27,45,.16);padding:4px;font:14px system-ui;max-width:460px}
.kd-sug div{padding:7px 10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:14px}.kd-sug div.on,.kd-sug div:hover{background:#eef2fd}.kd-sug small{color:#5a6478;white-space:nowrap}
html{background:#e9edf4}body{background:transparent!important;padding:28px 12px 44px;margin:0}
.page{background:#fff;box-shadow:0 1px 3px rgba(20,27,45,.08),0 14px 36px rgba(20,27,45,.08);border-radius:4px;min-height:1050px;padding:var(--ed-marge,44px 48px)!important;overflow:visible}
.ed{outline:none;border-radius:3px;min-width:.6em;padding:0 1px;cursor:text;transition:background-color .1s}
.ed:hover{background:rgba(47,91,234,.08)}.ed:focus{background:rgba(47,91,234,.1);box-shadow:0 0 0 1.5px rgba(47,91,234,.55)}
.ed:empty::before{content:attr(data-ph);color:#9aa3b5;font-style:italic}.ed.ml{white-space:pre-line}.desc .ed{display:block}
tr:not(:hover):not(:focus-within) .desc .ed:empty{display:none}.ed.opt:empty::before{opacity:.6}
.ed-tools{position:absolute;left:100%;top:0;display:none;gap:1px;background:#fff;background-clip:padding-box;border:1px solid #dde2ec;border-left:12px solid transparent;
  border-radius:9px;padding:2px;box-shadow:0 4px 14px rgba(20,27,45,.1);z-index:2;white-space:nowrap}
tr:hover .ed-tools,tr:focus-within .ed-tools{display:flex}
.ed-tools button{font:14px system-ui;border:0;background:none;width:28px;height:28px;border-radius:7px;cursor:pointer;color:#5a6478}
.ed-tools button:hover{background:#eef1f7;color:#141b2d}.ed-tools button[data-act=del]:hover{background:#fce8e6;color:#c0362c}
.ed-add{display:flex;gap:8px;margin:-6px 0 16px}
.ed-add button{font:600 13px system-ui;border:1px dashed #b9c4dc;background:#fff;color:#2448c4;border-radius:999px;padding:7px 15px;cursor:pointer}
.ed-add button:hover{background:#e7edfd;border-style:solid}
.ed-date,.ed-tva{font:inherit;color:inherit;border:0;background:transparent;padding:0 2px;border-radius:3px;cursor:pointer}
.ed-tva{text-align:right;-webkit-appearance:none;appearance:none}.ed-date:hover,.ed-tva:hover{background:rgba(47,91,234,.08)}
.ed-tvabis{font-size:11px;color:#6b7487;margin-top:2px}.ed-vide{color:#9aa3b5;font-style:italic;text-align:center;padding:18px!important}
@media (max-width:760px){.page{padding:22px 16px!important}.ed-tools{left:auto;right:0;top:-34px;border-left-width:1px}}
</style>`;
async function editDoc(id) {
  const d = await api('documents/' + id);
  const [tpls, cat, clients, pays] = await Promise.all([api('templates'), api('catalog'), api('clients'), d.type === 'facture' ? api('payments?document_id=' + id) : []]);
  const isDevis = d.type === 'devis', isFac = d.type === 'facture', isMod = d.type === 'modele', isAvoir = d.kind === 'avoir';
  d.data.client ||= { nom: '', adresse: '', email: '', tel: '' };
  d.data.lignes ||= [];
  // Devis en 3 gammes : data.lignes = la gamme affichée (même tableau, donc chaque modification va dans la bonne gamme)
  const G = () => (isDevis && !d.signature && d.data.gammes?.length > 1 ? d.data.gammes : null);
  if (G()) { if (!G()[d.data.gamme]) d.data.gamme = 1; G()[d.data.gamme].lignes = d.data.lignes; }
  const emise = isFac && !!d.numero, reste = r2(d.total_ttc - (d.regle || 0));
  const menu = [
    ['printer', 'Imprimer', 'print'],
    !isMod && ['link', isFac ? 'Copier le lien de paiement' : 'Copier le lien de signature', 'link'],
    isDevis && '-', isDevis && ['receipt', 'Facture d’acompte', 'acompte'], isDevis && ['receipt', 'Situation de travaux (avancement)', 'situation'], isDevis && ['receipt', 'Facture finale', 'solde'],
    isDevis && (d.chantier_id ? ['helmet', 'Voir le chantier', 'gochantier'] : ['helmet', 'Créer le chantier', 'chantier']),
    isDevis && !d.signature && (G() ? ['layers', 'Retirer les gammes', 'sansgammes'] : ['sparkle', 'Proposer 3 gammes au client', 'gammes']),
    isDevis && ['layers', 'Enregistrer comme devis type', 'tomod'],
    emise && '-', emise && ['code', 'Télécharger le Factur-X (XML)', 'xml'],
    emise && !isAvoir && reste > 0 && ['send', 'Relancer maintenant', 'relancer'],
    emise && !isAvoir && ['undo', 'Créer un avoir', 'avoir'],
    isFac && d.parent_id && ['file', isAvoir ? 'Voir la facture d’origine' : 'Voir le devis', 'parent'], isFac && d.chantier_id && ['helmet', 'Voir le chantier', 'gochantier'],
    '-', ['copy', 'Dupliquer', 'dup'], !emise && ['trash', 'Supprimer', 'del'],
  ].filter(Boolean);
  head(`${kindLabel(d)} ${isMod ? d.nom || '' : d.numero || '(brouillon)'}`, `${h(d.data.client.nom || 'Client à renseigner')}, <b id="subttc">${eur(d.total_ttc)}</b> TTC ${pill(d)}`,
    `<a class="btn" href="/api/documents/${id}/pdf" target="_blank" rel="noopener">${icon('download', 16)}PDF</a>
${isMod ? `<a class="btn yellow" href="#/nouveau/${id}">${icon('mic')}Faire un devis avec ce modèle</a>` : `<button class="btn primary" id="send">${icon('send', 16)}${isFac && !emise ? 'Émettre et envoyer' : 'Envoyer'}</button>`}
<details class="menu"><summary class="btn icon" aria-label="Plus d’actions">${icon('more')}</summary><div class="mp">${menu.map(m => (m === '-' ? '<hr>' : `<button data-act="${m[2]}" class="${m[2] === 'del' ? 'danger' : ''}">${icon(m[0], 16)}${m[1]}</button>`)).join('')}</div></details>`);

  const steps = isDevis ? [['brouillon', 'Brouillon'], ['envoye', 'Envoyé'], ['accepte', 'Accepté'], ['refuse', 'Refusé']] : isFac ? [['brouillon', 'Brouillon'], ['envoyee', isAvoir ? 'Émis' : 'Émise']] : [];
  const order = steps.map(s => s[0]);
  const opts = { paye: isFac && !isAvoir ? d.paye || 0 : 0, avoirs: isFac && !isAvoir ? d.avoirs || 0 : 0 };
  view.innerHTML = `${steps.length ? `<div class="stepper" role="group" aria-label="Statut">${steps.map(([v, l]) => `<button data-st="${v}" ${emise ? 'disabled' : ''} class="${v === d.statut ? 'on' : ''} ${v === 'refuse' ? 'refuse' : ''} ${order.indexOf(v) < order.indexOf(d.statut) && v !== 'refuse' ? 'done' : ''}">${order.indexOf(v) < order.indexOf(d.statut) && v !== 'refuse' ? icon('check', 14) : ''}${l}</button>`).join('')}</div>` : ''}
<div class="docwrap">
 ${d.signature ? `<div class="ask" style="background:var(--good-t);border-color:#bfe3bf">${icon('check')}<div>Signé en ligne par <b>${h(d.signe_par)}</b> le ${new Date(d.signe_le).toLocaleString('fr-FR')}.</div></div>` : ''}
 ${d.data.importe ? `<div class="ask" style="background:var(--plan-t);border-color:transparent">${icon('upload')}<div>Repris de votre ancien logiciel le ${dfr(d.data.importe.le)}. <a href="/api/documents/${id}/original" target="_blank" rel="noopener">Voir l’original</a></div></div>` : ''}
 ${emise ? `<div class="ask">${icon('shield')}<div>${isAvoir ? 'Avoir émis' : 'Facture émise'} : la loi interdit de la modifier ou de la supprimer. ${isAvoir ? '' : 'Pour corriger, créez un avoir (menu ⋯).'}</div></div>` : ''}
 <div id="qs"></div>
 <div class="gammes" id="gammes" hidden></div>
 <div class="docbar">
  ${emise ? '' : `<div class="voice nu"><button class="mic sm" id="mic" aria-pressed="false" aria-label="Modifier à la voix" title="Modifier à la voix">${icon('mic', 20)}</button><span class="live" id="live"></span></div>`}
  <details class="docopts"><summary class="btn">${icon('sliders', 16)}Options</summary><div class="docopts-in">
   ${isMod ? '<label class="f"><span>Nom du devis type</span><input data-o="nom" style="width:200px"></label>' : ''}
   ${emise ? '' : `<label class="f"><span>Remise %</span><input type="number" step="0.1" min="0" data-o="data.remise_pct" data-num></label>`}
   ${isFac || emise ? '' : '<label class="f"><span>Acompte %</span><input type="number" step="1" min="0" data-o="data.acompte_pct" data-num></label>'}
   ${isFac && !isAvoir && !emise ? '<label class="f"><span>Retenue de garantie %</span><input type="number" step="1" min="0" max="5" data-o="data.retenue_pct" data-num placeholder="0 ou 5"></label>' : ''}
   <label class="f"><span>Mise en page</span><select data-o="template_id" data-num>${tpls.map(t => `<option value="${t.id}">${h(t.nom)}</option>`).join('')}</select></label>
  </div></details>
   <span id="saved" class="muted" aria-live="polite"></span>
 </div>
 <iframe id="pv" class="docsheet" title="${kindLabel(d)} : cliquez sur un texte pour le modifier"></iframe>
 ${isDevis ? `<section class="panel"><div class="ph"><h2>Photos et plans</h2><label class="btn">${icon('image', 16)}Ajouter<input type="file" id="dadd" accept="image/*" multiple hidden></label></div><div class="pb" id="dphs"><p class="muted">Chargement…</p></div></section>` : ''}
 ${isFac && !isAvoir ? `<section class="panel"><div class="ph"><h2>Règlements</h2><span class="amt">${eur(d.regle)} sur ${eur(d.total_ttc)}</span></div><div class="pb stack" style="gap:12px">
  <div class="prog"><i style="width:${Math.min(100, 100 * (d.regle || 0) / (d.total_ttc || 1))}%"></i></div>
  ${pays.length || d.avoirs ? `<table class="list">${pays.map(p => `<tr><td>${dfr(p.date)}</td><td>${h(p.mode)}</td><td class="muted">${h(p.note)}</td><td class="n amt">${eur(p.montant)}</td><td class="n"><button class="btn ghost icon" data-delpay="${p.id}" aria-label="Supprimer ce règlement">${icon('trash', 16)}</button></td></tr>`).join('')}
  ${d.avoirs ? `<tr><td colspan="3">Avoirs émis</td><td class="n amt">${eur(d.avoirs)}</td><td></td></tr>` : ''}</table>` : ''}
  ${reste > 0 ? `<form id="pf" class="fg" style="align-items:end"><label class="f"><span>Montant</span><input name="montant" type="number" step="0.01" required value="${reste}"></label>
  <label class="f"><span>Date</span><input name="date" type="date" value="${today()}"></label>
  <label class="f"><span>Mode</span><select name="mode"><option>Virement</option><option>Chèque</option><option>Espèces</option><option>Carte</option></select></label>
  <button class="btn primary">${icon('plus', 16)}Enregistrer le règlement</button></form>` : `<p>${icon('check')} Facture soldée.</p>`}
  ${emise && reste > 0 ? `<p class="muted" style="font-size:13px">${ME.stripe ? 'Le lien envoyé au client permet de payer par carte : le règlement s’enregistre tout seul.' : 'Activez le paiement par carte dans Paramètres, Paiement en ligne.'}</p>` : ''}
 </div></section>` : ''}
</div>`;

  if (isDevis) photosDevis(id);
  let timer;
  const drawGammes = () => {
    const gs = G(), el = $('#gammes');
    if (!el) return; // page quittée
    el.hidden = !gs;
    if (gs) el.innerHTML =`<div class="seg" role="group" aria-label="Gamme affichée">${gs.map((x, i) => `<button data-g="${i}" class="${i === d.data.gamme ? 'on' : ''}">${h(x.nom)} <em>${eur(totaux({ ...d.data, lignes: x.lignes }, S.franchise_tva).ttc)}</em></button>`).join('')}</div>
<span class="muted">Le client choisit sa gamme sur sa page en ligne, puis signe. Vous modifiez la gamme ${h(gs[d.data.gamme].nom)}.</span>`;
  };
  $('#gammes').onclick = e => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    d.data.gamme = +b.dataset.g; d.data.lignes = G()[d.data.gamme].lignes;
    zones(['lignes', 'totaux', 'mentions']); drawGammes(); save();
  };
  const save = () => { $('#saved').textContent = 'Modifié…'; drawGammes(); clearTimeout(timer); timer = setTimeout(saveNow, 700); };
  async function saveNow() {
    clearTimeout(timer);
    try {
      const nd = await api('documents/' + id, 'PUT', emise ? { template_id: d.template_id }
        : { data: d.data, date: d.date, echeance: d.echeance, template_id: d.template_id, nom: d.nom, client_id: d.client_id });
      Object.assign(d, { client_id: nd.client_id, total_ttc: nd.total_ttc });
      if ($('#saved')) { $('#saved').textContent = 'Enregistré'; $('#subttc').textContent = eur(nd.total_ttc); } // la page a pu être quittée entre-temps
    } catch (e) { if ($('#saved')) $('#saved').textContent = e.message; else toast(e.message, 'crit'); }
  }
  if (!emise) docOuvert = { id, saveNow };
  $$('[data-st]').forEach(b => {
    b.onclick = async () => {
      if (b.dataset.st === d.statut) return;
      if (isFac && b.dataset.st !== 'brouillon' && !(await modal({ title: isAvoir ? 'Émettre l’avoir ?' : 'Émettre la facture ?', text: 'Elle recevra son numéro définitif et ne pourra plus être modifiée ni supprimée.', ok: 'Émettre' }))) return;
      try { await saveNow(); await api('documents/' + id, 'PUT', { statut: b.dataset.st }); toast('Statut mis à jour'); route(); } catch (e) { toast(e.message, 'crit'); }
    };
  });

  // ----- Le document lui-même, modifiable en place (même rendu que le PDF) -----
  const pv = $('#pv'), L = () => d.data.lignes, NUM = ['qte', 'pu', 'tva'];
  const tplOf = () => tpls.find(t => t.id === d.template_id) || tpls.find(t => t.id === S.template_id) || tpls[0];
  const txt = el => el.innerText.replace(/\n$/, '');
  const toNum = s => +String(s).replace(/[\s€%]/g, '').replace(',', '.') || 0;
  const selOf = el => el?.dataset?.k ? `[data-i="${el.dataset.i}"][data-k="${el.dataset.k}"]` : el?.dataset?.f ? `[data-f="${el.dataset.f}"]` : null;
  const render = () => { pv.srcdoc = (emise ? renderDoc : renderEdit)(d, S, tplOf().html, opts).replace(/<\/head>/i, DOC_ED_CSS + '</head>'); };
  const D = () => pv.contentDocument;
  const zones = (names, focus) => {
    const ctx = docContext(d, S, { ...opts, edit: true, tpl: tplOf().html });
    for (const z of names) { const el = D().querySelector(`[data-zone="${z}"]`); if (el) el.outerHTML = ctx[z]; }
    if (focus) D().querySelector(focus)?.focus();
  };
  pv.onload = () => {
    const doc = D(), fit = () => { pv.style.height = Math.ceil(doc.body.getBoundingClientRect().height) + 'px'; } // la feuille, pas la fenêtre (sinon la hauteur ne redescend jamais);
    // téléphone : marges réduites, puis la feuille A4 est rétrécie pour tenir dans la largeur (le texte reste modifiable)
    if (pv.clientWidth < 700) { doc.body.style.padding = '8px 0 24px'; const pg = doc.querySelector('.page'); if (pg) pg.style.cssText += ';padding:18px 14px!important;min-height:0'; }
    const z = pv.clientWidth / doc.documentElement.scrollWidth;
    if (z < 1) doc.documentElement.style.zoom = z;
    new pv.contentWindow.ResizeObserver(fit).observe(doc.body); fit();
    if (emise) return;
    // Suggestions pendant la frappe : prestations du catalogue (désignation d'une ligne), clients existants (nom du client).
    const sug = doc.createElement('div'); sug.className = 'kd-sug'; sug.hidden = true; doc.body.append(sug);
    let sugItems = [], sugSel = 0, sugEl = null;
    const sugHide = () => { sug.hidden = true; sugItems = []; };
    const sugDraw = () => { sug.innerHTML = sugItems.map((x, i) => `<div data-sug="${i}" class="${i === sugSel ? 'on' : ''}"><b>${h(x.t)}</b><small>${h(x.s)}</small></div>`).join(''); };
    const sugShow = el => {
      const q = txt(el).trim().toLowerCase(), cli = el.dataset.f === 'data.client.nom', l = !cli && L()[+el.dataset.i];
      sugItems = q.length < 2 || l?.type === 'section' ? [] : (cli ? clients.map(c => ({ c, t: c.nom, s: c.adresse?.split('\n').pop() || c.email || '' }))
        : cat.map(c => ({ c, t: c.designation, s: `${eur(c.pu)} / ${c.unite || 'u'}` }))).filter(x => x.t.toLowerCase().includes(q) && x.t.toLowerCase() !== q).slice(0, 6);
      if (!sugItems.length) return sugHide();
      const r = el.getBoundingClientRect(), w = doc.defaultView;
      sugEl = el; sugSel = 0; sugDraw();
      Object.assign(sug.style, { left: r.left + w.scrollX + 'px', top: r.bottom + w.scrollY + 4 + 'px', minWidth: Math.max(240, r.width) + 'px' });
      sug.hidden = false;
    };
    const sugPick = i => {
      const x = sugItems[i], el = sugEl;
      sugHide();
      if (!x) return;
      if (el.dataset.f) {
        d.client_id = x.c.id;
        for (const f of ['nom', 'email', 'tel', 'adresse', 'siret']) { d.data.client[f] = x.c[f] || ''; const z = doc.querySelector(`[data-f="data.client.${f}"]`); if (z) z.textContent = x.c[f] || ''; }
      } else {
        const l = L()[+el.dataset.i];
        Object.assign(l, { designation: x.c.designation, description: l.description || x.c.description || '', unite: x.c.unite, pu: x.c.pu, tva: x.c.tva });
        zones(['lignes', 'totaux', 'mentions'], `[data-i="${el.dataset.i}"][data-k="qte"]`);
      }
      save();
    };
    sug.addEventListener('mousedown', e => { const it = e.target.closest('[data-sug]'); if (it) { e.preventDefault(); sugPick(+it.dataset.sug); } }); // mousedown : le champ garde le curseur
    doc.addEventListener('focusout', sugHide);
    doc.addEventListener('keydown', e => {
      if (sug.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { sugSel = (sugSel + (e.key === 'ArrowDown' ? 1 : sugItems.length - 1)) % sugItems.length; sugDraw(); e.preventDefault(); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); sugPick(sugSel); }
      if (e.key === 'Escape') { e.stopImmediatePropagation(); sugHide(); }
    });
    doc.addEventListener('input', e => { if (e.target.dataset.k === 'designation' || e.target.dataset.f === 'data.client.nom') sugShow(e.target); });
    doc.addEventListener('input', e => {
      const el = e.target, v = el.isContentEditable ? txt(el) : el.value;
      if (el.dataset.f) { setP(d, el.dataset.f, v); save(); return; }
      if (!el.dataset.k) return;
      const k = el.dataset.k, l = L()[+el.dataset.i];
      l[k] = NUM.includes(k) ? toNum(v) : v;
      if (NUM.includes(k)) {
        const t = D().querySelector(`[data-tot="${el.dataset.i}"]`);
        if (t) t.textContent = eur(l.qte * l.pu);
        zones(k === 'tva' ? ['totaux', 'mentions'] : ['totaux']);
      }
      save();
    });
    doc.addEventListener('focusout', e => {
      const el = e.target, k = el.dataset.k, next = selOf(e.relatedTarget);
      if (el.dataset.f === 'data.client.nom') {
        const c = clients.find(c => c.nom.toLowerCase() === (d.data.client.nom || '').trim().toLowerCase());
        d.client_id = c?.id ?? null;
        if (c) for (const f of ['email', 'tel', 'adresse', 'siret']) if (!d.data.client[f] && c[f]) { d.data.client[f] = c[f]; doc.querySelector(`[data-f="data.client.${f}"]`).textContent = c[f]; }
        save();
      }
      if (k === 'designation') {
        const l = L()[+el.dataset.i], c = l.type !== 'section' && !l.pu && cat.find(c => c.designation.toLowerCase() === l.designation.trim().toLowerCase());
        if (c) { Object.assign(l, { description: l.description || c.description || '', unite: c.unite, pu: c.pu, tva: c.tva }); zones(['lignes', 'totaux', 'mentions'], next); save(); }
      }
      // remet les nombres en forme et recalcule les sous-totaux (sauf si on clique un bouton de ligne, qui redessine lui-même)
      if ((k === 'qte' || k === 'pu') && !e.relatedTarget?.closest?.('[data-act]')) zones(['lignes', 'totaux'], next);
    });
    doc.addEventListener('keydown', e => {
      const el = e.target;
      if (e.key === 'Escape') el.blur();
      if (e.key !== 'Enter' || !el.isContentEditable || el.classList.contains('ml')) return;
      e.preventDefault(); // Entrée : champ suivant, comme une tabulation
      const all = [...doc.querySelectorAll('.ed')];
      (all[all.indexOf(el) + 1] || el).focus();
    });
    doc.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = +b.dataset.i, a = b.dataset.act;
      let focus;
      if (a === 'cat') {
        const l = L()[i];
        cat.push(await api('catalog', 'POST', { designation: l.designation, description: l.description, unite: l.unite, pu: l.pu, tva: l.tva }));
        return toast(`« ${l.designation} » gardé dans le catalogue`);
      }
      if (a === 'del') L().splice(i, 1);
      if (a === 'dup') L().splice(i + 1, 0, { ...L()[i] });
      if (a === 'up' && i > 0) L().splice(i - 1, 0, ...L().splice(i, 1));
      if (a === 'down' && i < L().length - 1) L().splice(i + 1, 0, ...L().splice(i, 1));
      if (a === 'addL' || a === 'addS') {
        L().push(a === 'addL' ? { type: 'ligne', designation: '', description: '', qte: 1, unite: 'u', pu: 0, tva: S.franchise_tva ? 0 : S.tva_defaut } : { type: 'section', designation: '' });
        focus = `[data-i="${L().length - 1}"][data-k="designation"]`;
      }
      zones(['lignes', 'totaux', 'mentions'], focus); save();
    });
  };
  $$('[data-o]', view).forEach(el => {
    el.value = getP(d, el.dataset.o) ?? '';
    el.oninput = () => {
      setP(d, el.dataset.o, 'num' in el.dataset ? (el.value === '' ? null : +el.value) : el.value);
      if (el.dataset.o === 'template_id') render(); else if (!isMod || el.dataset.o !== 'nom') zones(['totaux', 'mentions']);
      save();
    };
  });

  const drawQs = () => {
    const q = d.data.questions || [];
    $('#qs').innerHTML = q.length ? `<div class="ask">${icon('sparkle')}<div style="flex:1"><b>Kadra vous demande de vérifier :</b><ul>${q.map(x => `<li>${h(x)}</li>`).join('')}</ul></div><button class="btn" id="qok">C’est vérifié</button></div>` : '';
    if (q.length) $('#qok').onclick = () => { d.data.questions = []; drawQs(); save(); };
  };
  if (!emise) mic($('#mic'), {
    onLive: (f, i) => { $('#live').textContent = f + i; },
    onFinal: async f => {
      if (!f) return;
      $('#live').textContent = 'Modification en cours : ' + f;
      try { await saveNow(); await api('ai/devis', 'POST', { transcript: f, doc_id: id }); toast('Devis modifié'); route(); }
      catch (e) { $('#live').textContent = e.message; }
    },
  });

  const actions = {
    print: () => open(`/api/documents/${id}/html?print=1`),
    link: async () => { await navigator.clipboard.writeText(`${location.origin}/p/${d.token}`); toast('Lien copié'); },
    xml: () => open(`/api/documents/${id}/facturx.xml`),
    acompte: async () => {
      const v = await modal({ title: 'Facture d’acompte', text: 'Calculée sur le devis, taux de TVA par taux de TVA.', ok: 'Créer la facture', fields: [{ name: 'pct', label: 'Pourcentage de l’acompte', type: 'number', value: d.data.acompte_pct || S.acompte_defaut, step: 'any', required: true }] });
      if (v) location.hash = '#/doc/' + (await api(`documents/${id}/facture`, 'POST', { mode: 'acompte', pct: +v.pct })).id;
    },
    situation: async () => { const pct = await demanderAvancement(); if (pct) location.hash = '#/doc/' + (await api(`documents/${id}/facture`, 'POST', { mode: 'situation', pct })).id; },
    solde: async () => { location.hash = '#/doc/' + (await api(`documents/${id}/facture`, 'POST', { mode: 'solde' })).id; toast('Facture finale créée, acomptes et situations déduits'); },
    chantier: async () => { location.hash = '#/chantier/' + (await api(`documents/${id}/chantier`, 'POST')).id; },
    gochantier: () => { location.hash = '#/chantier/' + d.chantier_id; },
    parent: () => { location.hash = '#/doc/' + d.parent_id; },
    gammes: async () => {
      toast('Kadra rédige les gammes Essentiel et Premium… (environ 30 s)');
      await saveNow(); await api('ai/gammes', 'POST', { doc_id: id });
      toast('3 gammes prêtes : vérifiez les prix de Kadra'); route();
    },
    sansgammes: async () => {
      if (!(await confirmer('Retirer les gammes ?', `Seule la gamme ${h(G()[d.data.gamme].nom)} est gardée.`))) return;
      delete d.data.gammes; delete d.data.gamme; await saveNow(); route();
    },
    tomod: async () => {
      const v = await modal({ title: 'Enregistrer comme devis type', text: 'Le client est retiré : vous réutiliserez les prestations et les prix.', ok: 'Enregistrer', fields: [{ name: 'nom', label: 'Nom du devis type', value: d.data.objet, required: true }] });
      if (v) location.hash = '#/doc/' + (await api(`documents/${id}/dupliquer`, 'POST', { type: 'modele', nom: v.nom })).id;
    },
    relancer: async () => { toast('Relance : ' + (await api(`documents/${id}/relancer`, 'POST')).statut); },
    avoir: async () => {
      if (await modal({ title: 'Créer un avoir ?', text: `Un avoir annule tout ou partie de la facture ${h(d.numero)}. Il est créé pour la totalité : ajustez les lignes pour un avoir partiel, puis émettez-le.`, ok: 'Créer l’avoir' }))
        location.hash = '#/doc/' + (await api(`documents/${id}/avoir`, 'POST')).id;
    },
    dup: async () => { location.hash = '#/doc/' + (await api(`documents/${id}/dupliquer`, 'POST')).id; toast('Copie créée'); },
    del: async () => { if (await confirmer('Supprimer ce document ?', 'Cette action est définitive.')) { await api('documents/' + id, 'DELETE'); toast('Document supprimé'); history.back(); } },
  };
  $('#tacts').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    b.closest('details')?.removeAttribute('open');
    Promise.resolve(actions[b.dataset.act]()).catch(err => toast(err.message, 'crit'));
  });
  if ($('#send')) $('#send').onclick = async () => {
    await saveNow();
    if (isFac && !emise && !(await modal({ title: 'Émettre et envoyer ?', text: 'La facture reçoit son numéro définitif et ne pourra plus être modifiée.', ok: 'Continuer' }))) return;
    try { if (await sendDialog(id)) route(); } catch (e) { toast(e.message, 'crit'); }
  };
  if ($('#pf')) $('#pf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    await api('payments', 'POST', { document_id: d.id, montant: +f.montant.value, date: f.date.value, mode: f.mode.value });
    toast('Règlement enregistré'); route();
  };
  view.addEventListener('click', async e => {
    const b = e.target.closest('[data-delpay]');
    if (b && await confirmer('Supprimer ce règlement ?', '')) { await api('payments/' + b.dataset.delpay, 'DELETE'); route(); }
  });
  drawQs(); drawGammes(); render();
}

// ---------- Chantiers ----------
async function chantiers(arg) {
  const list = await api('chantiers');
  const late = list.filter(c => chantierInfo(c).late).length;
  head('Chantiers', `${plural(list.filter(c => c.statut === 'en_cours').length, 'chantier')} en cours${late ? `, dont ${late} en retard` : ''}.`,
    `<button class="btn primary" id="new">${icon('plus')}Nouveau chantier</button>`);
  // Par ordre d'urgence : en retard puis en cours, à venir, suspendus ; les terminés repliés en bas. Le statut se change sur la fiche.
  const par = (k, tri) => list.filter(c => c.statut === k).sort(tri);
  const enCours = par('en_cours', (a, b) => chantierInfo(b).late - chantierInfo(a).late || (a.date_fin_prevue || '9').localeCompare(b.date_fin_prevue || '9'));
  const aVenir = par('a_venir', (a, b) => (a.date_debut || '9').localeCompare(b.date_debut || '9'));
  const susp = par('suspendu', () => 0), fini = par('termine', (a, b) => (b.date_fin_reelle || '').localeCompare(a.date_fin_reelle || ''));
  // Un tableau par groupe : nom et client, état en mots, avancement en chiffre, échéance, argent. Pas de barre de couleur (Hivan).
  const ligne = c => { const i = chantierInfo(c);
    return `<tr data-href="#/chantier/${c.id}"><td><div class="who">${avatar(c.client_nom || c.nom)}<div><b>${h(c.nom)}</b><small>${h(c.client_nom || 'Sans client')}</small></div></div></td>
<td class="hide-m">${i.late ? `<span class="etat crit">${plural(i.jours, 'jour')} de retard</span>` : `<span class="etat">${STATUTS_CH[c.statut] || c.statut}</span>`}</td>
<td class="n">${c.statut === 'a_venir' ? '–' : `<b>${c.avancement || 0} %</b>`}</td>
<td class="hide-m">${c.statut === 'termine' ? (c.date_fin_reelle ? dfr(c.date_fin_reelle) : '–') : c.statut === 'a_venir' ? (c.date_debut ? `Début le ${dfr(c.date_debut)}` : '–') : c.date_fin_prevue ? dfr(c.date_fin_prevue) : '–'}</td>
<td class="n amt">${c.budget ? `${eur(c.encaisse)}<small class="muted" style="display:block">sur ${eur(c.budget)}</small>` : '–'}</td></tr>`; };
  const table = cs => `<table class="list chl"><thead><tr><th>Chantier</th><th class="hide-m">État</th><th class="n">Fait</th><th class="hide-m">Fin</th><th class="n">Payé</th></tr></thead><tbody>${cs.map(ligne).join('')}</tbody></table>`;
  const grp = (t, cs, vide = '') => (cs.length || vide ? `<section class="panel"><div class="ph"><h2>${t} <span class="muted">${cs.length}</span></h2></div>${cs.length ? `<div class="pb" style="padding:4px 0">${table(cs)}</div>` : `<div class="pb"><p class="muted" style="margin:0">${vide}</p></div>`}</section>` : '');
  const actifs = list.filter(c => c.statut !== 'termine'), reste = actifs.reduce((s, c) => s + Math.max(0, (c.budget || 0) - (c.encaisse || 0)), 0);
  view.innerHTML = list.length ? `<div class="stack">${kpiRow([
    { ic: 'helmet', l: 'En cours', v: enCours.length, s: late ? P(`dont ${late} en retard`, 'crit', 'alert') : 'Aucun en retard' },
    { ic: 'calendar', l: 'À venir', v: aVenir.length, s: aVenir[0]?.date_debut ? `Prochain début le ${dfr(aVenir[0].date_debut)}` : 'Rien de prévu' },
    { ic: 'euro', l: 'Reste à encaisser', v: eur(reste), s: 'sur les chantiers en cours et à venir' },
  ])}${grp('En cours', enCours, 'Aucun chantier en cours.')}${grp('À venir', aVenir)}${grp('Suspendus', susp)}
${fini.length ? `<details class="panel fini"><summary class="ph"><h2>Terminés <span class="muted">${fini.length}</span></h2></summary><div class="pb" style="padding:4px 0">${table(fini)}</div></details>` : ''}</div>`
    : `<div class="panel empty">${icon('helmet', 28)}<p>Aucun chantier. Un devis signé crée son chantier automatiquement, ou créez-en un avec « Nouveau chantier ».</p></div>`;
  const nouveauChantier = async () => {
    const clients = await api('clients');
    const v = await modal({ title: 'Nouveau chantier', ok: 'Créer', fields: [{ name: 'nom', label: 'Nom du chantier', required: true, placeholder: 'Ex. Salle de bain Martin' },
      { name: 'client_id', label: 'Client', type: 'select', options: [['', 'Aucun'], ...clients.map(c => [c.id, c.nom])] }, { name: 'date_debut', label: 'Début', type: 'date' }, { name: 'date_fin_prevue', label: 'Fin prévue', type: 'date' }] });
    if (v) location.hash = '#/chantier/' + (await api('chantiers', 'POST', { ...v, client_id: v.client_id ? +v.client_id : null, statut: 'a_venir' })).id;
  };
  $('#new').onclick = nouveauChantier;
  if (location.hash.endsWith('?new')) nouveauChantier();
}

async function chantier(id) {
  const c = await api('chantiers/' + id);
  const [docs, clients, emails, rdvs, photos, deps] = await Promise.all([api('documents?chantier_id=' + id), api('clients'), api('emails?chantier_id=' + id), api('rdv?chantier_id=' + id), api('photos?chantier_id=' + id), api('depenses?chantier_id=' + id)]);
  deps.sort((a, b) => b.date.localeCompare(a.date));
  const laisse = r2(c.budget_ht - c.depenses);
  const avenir = rdvs.filter(r => r.statut === 'confirme' && r.debut.slice(0, 10) >= today()).sort((a, b) => a.debut.localeCompare(b.debut));
  const facs = docs.filter(d => d.type === 'facture'), devis = docs.find(d => d.id === c.devis_id) || docs.find(d => d.type === 'devis');
  const pays = (await Promise.all(facs.map(f => api('payments?document_id=' + f.id).then(ps => ps.map(p => ({ ...p, numero: f.numero })))))).flat();
  const i = chantierInfo(c), resteAFacturer = Math.max(0, c.budget - c.facture), resteAPayer = Math.max(0, c.budget - c.encaisse);
  head(c.nom, `${h(c.client_nom || 'Sans client')}${c.adresse ? ', ' + h(c.adresse) : ''} ${chantierPill(c)}`,
    `${c.adresse ? `<a class="btn" target="_blank" rel="noopener" href="${h(maps(c.adresse))}">${icon('pin', 16)}Itinéraire</a>` : ''}<button class="btn" id="rdv">${icon('calendar', 16)}Planifier un rendez-vous</button>
<button class="btn primary" id="point">${icon('mail', 16)}Envoyer un point d’avancement</button>
<details class="menu"><summary class="btn icon" aria-label="Plus d’actions">${icon('more')}</summary><div class="mp">${devis ? `<a href="#/doc/${devis.id}">${icon('file', 16)}Voir le devis ${h(devis.numero)}</a>` : ''}
<button id="del" class="danger">${icon('trash', 16)}Supprimer le chantier</button></div></details>`);
  const F = (k, l, t = 'text') => `<label class="f"><span>${l}</span><input data-c="${k}" type="${t}" value="${h(c[k])}"></label>`;
  view.innerHTML = `<div class="stack">
<section class="panel"><div class="ph"><h2>Où en sont les travaux ?</h2><div class="seg" role="group" aria-label="Statut">${Object.entries(STATUTS_CH).map(([k, l]) => `<button data-statut="${k}" class="${k === c.statut ? 'on' : ''}">${l}</button>`).join('')}</div></div>
<div class="pb stack" style="gap:12px">
<div class="avbig"><strong id="av">${c.avancement || 0} %</strong><span>des travaux faits</span></div>${avance(c, 'xl')}
<div class="avset"><div class="seg" role="group" aria-label="Travaux faits">${[0, 25, 50, 75, 100].map(p => `<button data-av="${p}" class="${p === (c.avancement || 0) ? 'on' : ''}">${p} %</button>`).join('')}</div>
<label class="avnum">ou exactement <input type="number" inputmode="numeric" min="0" max="100" step="5" data-c="avancement" value="${c.avancement || 0}" aria-label="Travaux faits, en pourcentage"> %</label></div>
<p style="margin:0;font-weight:600;${i.late ? 'color:var(--crit)' : ''}">${i.late ? icon('alert', 15) + ' ' : ''}${finTexte(c)}</p>
<div class="fg">${F('date_debut', 'Début', 'date')}${F('date_fin_prevue', 'Fin prévue', 'date')}${F('date_fin_reelle', 'Fin réelle', 'date')}</div>
${c.retard_notifie_le ? `<p class="muted" style="font-size:13px;margin:0">Le client a été prévenu du retard le ${dfr(c.retard_notifie_le)}.</p>` : ''}</div></section>
<div class="grid2">
<section class="panel"><div class="ph"><h2>Argent du chantier</h2></div><div class="pb stack" style="gap:12px">
  <div class="releve" style="border:0;border-radius:0;box-shadow:none">
    <div><span class="l">Prix du chantier</span><div class="v">${eur(c.budget)}</div></div>
    <div><span class="l">Déjà payé</span><div class="v">${eur(c.encaisse)}</div></div>
    <div><span class="l">Reste à payer</span><div class="v ${resteAPayer && i.late ? 'crit' : ''}">${eur(resteAPayer)}</div></div></div>
  ${devis && resteAFacturer > 0 ? `<p style="margin:0">Il reste <b>${eur(resteAFacturer)}</b> à facturer au client.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-fac="acompte">${icon('receipt', 16)}Facture d’acompte</button><button class="btn" data-fac="situation">${icon('receipt', 16)}Situation de travaux</button><button class="btn" data-fac="solde">${icon('receipt', 16)}Facture finale</button></div>`
    : c.budget ? '<p class="muted" style="margin:0">Tout le chantier est facturé.</p>' : ''}
  ${c.budget_ht ? `<p style="margin:0">Vos dépenses : <b>${eur(c.depenses)} HT</b>. Une fois ces achats payés, le chantier vous laisse <b style="${laisse < 0 ? 'color:var(--crit)' : ''}">${eur(laisse)} HT</b> <span class="muted">(vos heures ne sont pas comptées)</span>.</p>` : ''}
</div></section>
<section class="panel"><div class="ph"><h2>Informations</h2></div><div class="pb fg">
  <label class="f wide"><span>Nom du chantier</span><input data-c="nom" value="${h(c.nom)}"></label>
  <label class="f"><span>Client</span><select data-c="client_id"><option value="">Aucun</option>${clients.map(x => `<option value="${x.id}" ${x.id === c.client_id ? 'selected' : ''}>${h(x.nom)}</option>`).join('')}</select></label>
  ${F('email_suivi', 'E-mail des alertes', 'email')}${F('adresse', 'Adresse du chantier')}
  <label class="f wide"><span>Notes de chantier</span><textarea data-c="notes" rows="3">${h(c.notes)}</textarea></label></div></section>
</div>
<section class="panel"><div class="ph"><h2>Dépenses du chantier</h2><button class="btn" id="adddep">${icon('plus', 16)}Ajouter une dépense</button></div>
<div class="pb" style="padding:4px 0">${deps.length ? depTable(deps, false) : `<div class="empty">${icon('cart', 26)}<p>Matériaux, location, sous-traitance : prenez le ticket en photo, Kadra le lit. Vous saurez ce que ce chantier vous laisse.</p></div>`}</div></section>
<section class="panel"><div class="ph"><h2>Photos</h2><label class="btn">${icon('image', 16)}Ajouter des photos<input type="file" id="addph" accept="image/*" multiple hidden></label></div>
<div class="pb">${photos.length ? `<div class="photos">${photos.map(p => `<button data-ph="${p.id}" title="Photo du ${dfr(p.created_at.slice(0, 10))}"><img src="${h(p.image)}" alt="Photo du chantier, ${dfr(p.created_at.slice(0, 10))}" loading="lazy"></button>`).join('')}</div>`
  : '<p class="muted">Avant, pendant, après : prenez les photos depuis votre téléphone, elles restent rangées ici avec le chantier.</p>'}</div></section>
<section class="panel"><div class="ph"><h2>Prochains rendez-vous</h2></div><div class="pb">${evList(avenir, 'Aucun rendez-vous prévu sur ce chantier.', true)}</div></section>
<section class="panel"><div class="ph"><h2>Documents</h2></div><div class="pb" style="padding:4px 0">${docTable(docs, 'Aucun document lié.')}</div></section>
<div class="grid2">
<section class="panel"><div class="ph"><h2>Acomptes et règlements</h2></div><div class="pb" style="padding:4px 0">${pays.length ? `<table class="list"><thead><tr><th>Date</th><th>Facture</th><th>Mode</th><th class="n">Montant</th></tr></thead><tbody>
${pays.map(p => `<tr><td>${dfr(p.date)}</td><td>${h(p.numero)}</td><td>${h(p.mode)}</td><td class="n amt">${eur(p.montant)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${icon('euro', 26)}<p>Aucun règlement reçu.</p></div>`}</div></section>
<section class="panel"><div class="ph"><h2>E-mails envoyés</h2></div><div class="pb">${mailList(emails, { empty: 'Aucun e-mail envoyé pour ce chantier.' })}</div></section></div></div>`;
  const put = async body => { await api('chantiers/' + id, 'PUT', body); toast('Enregistré'); };
  $('#addph').onchange = async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast(files.length > 1 ? `Envoi de ${files.length} photos…` : 'Envoi de la photo…');
    try { for (const f of files) await api('photos', 'POST', { chantier_id: +id, image: await imageURL(f) }); toast('Photos ajoutées'); route(); }
    catch (err) { toast(err.message, 'crit'); }
  };
  $('#adddep').onclick = async () => { if (await editDepense({ chantier_id: c.id })) route(); };
  view.addEventListener('click', async e => { const r = e.target.closest('[data-dep]'); if (r && await editDepense(deps.find(x => x.id === +r.dataset.dep))) route(); });
  view.addEventListener('click', async e => {
    const b = e.target.closest('[data-ph]');
    if (!b) return;
    const p = photos.find(x => x.id === +b.dataset.ph);
    if (await modal({ title: 'Photo du ' + dfr(p.created_at.slice(0, 10)), wide: true, html: `<img class="photo-big" src="${h(p.image)}" alt="">`, ok: 'Supprimer la photo', danger: true })) { await api('photos/' + p.id, 'DELETE'); toast('Photo supprimée'); route(); }
  });
  view.addEventListener('change', async e => {
    const k = e.target.dataset.c;
    if (!k) return;
    const v = k === 'avancement' || k === 'client_id' ? (e.target.value === '' ? null : +e.target.value) : e.target.value;
    const body = { [k]: v };
    if (k === 'date_fin_prevue') body.retard_notifie_le = null;
    if (k === 'avancement' && v === 100 && c.statut !== 'termine' && await modal({ title: 'Travaux terminés ?', text: 'Passer le chantier en « Terminé » avec la date de fin d’aujourd’hui.', ok: 'Terminer le chantier' }))
      Object.assign(body, { statut: 'termine', date_fin_reelle: c.date_fin_reelle || today() });
    try { await put(body); if (k !== 'notes' && k !== 'nom' && k !== 'email_suivi') route(); } catch (err) { toast(err.message, 'crit'); }
  });
  const avIn = $('[data-c="avancement"]');
  avIn.addEventListener('change', () => { avIn.value = Math.min(100, Math.max(0, Math.round(+avIn.value || 0))); }, true);
  $$('[data-av]').forEach(b => { b.onclick = () => { avIn.value = b.dataset.av; avIn.dispatchEvent(new Event('change', { bubbles: true })); }; });
  $$('[data-statut]').forEach(b => { b.onclick = async () => { await put({ statut: b.dataset.statut, ...(b.dataset.statut === 'termine' && { avancement: 100, date_fin_reelle: c.date_fin_reelle || today() }) }); route(); }; });
  $$('[data-fac]').forEach(b => {
    b.onclick = () => busy(b, async () => {
      let pct;
      if (b.dataset.fac === 'acompte') { const v = await modal({ title: 'Facture d’acompte', ok: 'Créer', fields: [{ name: 'pct', label: 'Pourcentage', type: 'number', value: devis.data.acompte_pct || S.acompte_defaut, required: true, step: 'any' }] }); if (!v) return; pct = +v.pct; }
      if (b.dataset.fac === 'situation' && !(pct = await demanderAvancement(c.avancement))) return;
      location.hash = '#/doc/' + (await api(`documents/${devis.id}/facture`, 'POST', { mode: b.dataset.fac, pct })).id;
    });
  });
  $('#rdv').onclick = async () => { if (await editRdv({ chantier_id: c.id, client_id: c.client_id, lieu: c.adresse })) route(); };
  $('#point').onclick = e => busy(e.currentTarget, async () => { toast('E-mail ' + (await api(`chantiers/${id}/point`, 'POST')).statut); route(); });
  $('#del').onclick = async () => { if (await confirmer('Supprimer ce chantier ?', 'Les devis et factures liés sont conservés.')) { await api('chantiers/' + id, 'DELETE'); location.hash = '#/chantiers'; } };
}

// ---------- Dépenses (achats, location, sous-traitance) et fichiers pour le comptable ----------
const catLabel = k => (CATEGORIES[k] || CATEGORIES.autre)[0];
const moisLong = m => { const s = new Date(m + '-15T12:00').toLocaleDateString(LOC, { month: 'long', year: 'numeric' }); return s[0].toUpperCase() + s.slice(1); };
const somme = (l, k) => l.reduce((s, d) => s + d[k], 0);
const depTable = (list, chantier = true) => `<table class="list"><thead><tr><th class="hide-m">Date</th><th>Achat</th>${chantier ? '<th class="hide-m">Chantier</th>' : ''}<th class="hide-m">Catégorie</th><th class="n">TTC</th></tr></thead><tbody>
${list.map(d => `<tr data-dep="${d.id}"><td class="hide-m">${dfr(d.date)}</td><td><b>${h(d.fournisseur || 'Sans fournisseur')}</b>${d.justif ? ` <span title="Justificatif joint">${icon('clip', 13)}</span>` : ''}<small class="muted" style="display:block"><span class="dm">${dfr(d.date)}${d.libelle ? ' · ' : ''}</span>${h(d.libelle)}</small></td>
${chantier ? `<td class="hide-m">${h(d.chantier_nom || '–')}</td>` : ''}<td class="hide-m">${h(catLabel(d.categorie))}</td><td class="n amt">${eur(d.ttc)}${d.tva ? `<small class="muted" style="display:block">dont TVA ${eur(d.tva)}</small>` : ''}</td></tr>`).join('')}</tbody></table>`;

// Saisie d'une dépense ; la photo du ticket (ou le PDF du fournisseur) est lue par Claude, qui remplit les champs à relire.
async function editDepense(d = {}, fichier = undefined) { // fichier : undefined = justificatif inchangé, sinon data URL
  const chs = await api('chantiers'), ordre = { en_cours: 0, a_venir: 1, suspendu: 2, termine: 3 };
  chs.sort((a, b) => ordre[a.statut] - ordre[b.statut] || b.id - a.id);
  const pr = modal({ title: d.id ? 'Dépense' : 'Nouvelle dépense', ok: 'Enregistrer', alt: d.id ? 'Supprimer' : '',
    text: `<label class="btn yellow">${icon('image', 16)}${d.justif || fichier ? 'Remplacer la photo du ticket' : 'Photo du ticket ou facture PDF'}<input type="file" id="tk" accept="image/*,application/pdf" hidden></label><br>
<span id="tkst" style="display:inline-block;margin-top:8px;font-size:13px">${fichier ? 'Photo prête, enregistrée avec la dépense.' : d.justif ? `<a href="/api/depenses/${d.id}/justificatif" target="_blank" rel="noopener">${icon('clip', 13)} Voir le justificatif</a>` : 'Kadra lit le ticket et remplit la dépense. Vous relisez.'}</span>`,
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: d.date || today(), required: true },
      { name: 'fournisseur', label: 'Fournisseur', value: d.fournisseur, placeholder: 'Ex. Point P' },
      { name: 'libelle', label: 'Achat', value: d.libelle, placeholder: 'Ex. Placo BA13 et rails' },
      { name: 'categorie', label: 'Catégorie', type: 'select', value: d.categorie || 'materiaux', options: Object.entries(CATEGORIES).map(([k, [l]]) => [k, l]) },
      { name: 'ttc', label: 'Montant payé (TTC)', type: 'number', step: '0.01', value: d.ttc ?? '', required: true },
      ...(S.franchise_tva ? [] : [{ name: 'tva', label: 'Dont TVA', type: 'number', step: '0.01', value: d.tva || '', hint: 'Écrite sur le ticket. Laissez vide s’il n’y en a pas.' }]),
      { name: 'chantier_id', label: 'Chantier', type: 'select', value: d.chantier_id ?? '', options: [['', 'Aucun (frais généraux : carburant, outillage…)'], ...chs.map(c => [c.id, c.nom + (c.client_nom ? ' – ' + c.client_nom : '')])] },
    ] });
  const form = $('form', dlg), st = $('#tkst', form);
  $('#tk', form).onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.type === 'application/pdf') { if (f.size > 8e6) throw new Error('PDF trop lourd (8 Mo au plus).'); fichier = await fileToURL(f); } else fichier = await imageURL(f);
      st.textContent = 'Kadra lit le ticket…';
      const r = await api('ai/ticket', 'POST', { justificatif: fichier });
      if (!form.isConnected) return; // fenêtre fermée entre-temps
      for (const k of ['date', 'fournisseur', 'libelle', 'categorie']) if (r[k]) form[k].value = r[k];
      if (r.ttc) { form.ttc.value = r.ttc; if (form.tva) form.tva.value = r.tva || ''; }
      st.textContent = r.ttc ? 'Rempli par Kadra : relisez avant d’enregistrer.' : 'Montant illisible : tapez-le. La photo est gardée.';
    } catch (err) { st.textContent = `${err.message} ${fichier ? 'La photo est gardée : remplissez à la main.' : ''}`; }
  };
  const v = await pr;
  if (!v) return false;
  if (v.alt) {
    if (!(await confirmer('Supprimer cette dépense ?', 'Elle disparaît aussi des exports pour le comptable.'))) return false;
    await api('depenses/' + d.id, 'DELETE'); toast('Dépense supprimée'); return true;
  }
  const body = { date: v.date, fournisseur: v.fournisseur.trim(), libelle: v.libelle.trim(), categorie: v.categorie, ttc: +v.ttc, tva: +(v.tva || 0), chantier_id: v.chantier_id ? +v.chantier_id : null };
  try { await api(d.id ? 'depenses/' + d.id : 'depenses', d.id ? 'PUT' : 'POST', { ...body, ...(fichier !== undefined && { justificatif: fichier }) }); toast('Dépense enregistrée'); return true; }
  catch (err) { toast(err.message, 'crit'); return editDepense({ ...d, ...body }, fichier); } // rien de perdu : la fenêtre revient remplie
}

async function depenses() {
  const list = (await api('depenses')).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const ceMois = list.filter(d => d.date.startsWith(today().slice(0, 7)));
  head('Dépenses', `${eur(somme(ceMois, 'ttc'))} ce mois-ci${S.franchise_tva ? '' : `, dont ${eur(somme(ceMois, 'tva'))} de TVA à récupérer`}`,
    `<button class="btn" id="compta">${icon('download', 16)}Pour le comptable</button><button class="btn primary" id="new">${icon('plus')}Nouvelle dépense</button>`);
  const an = list.filter(d => d.date.startsWith(today().slice(0, 4)));
  view.innerHTML = list.length ? `<div style="margin-bottom:18px">${kpiRow([
    { ic: 'cart', l: 'Ce mois-ci', v: eur(somme(ceMois, 'ttc')), s: ceMois.length ? plural(ceMois.length, 'achat') : 'Aucun achat pour l’instant' },
    ...(S.franchise_tva ? [] : [{ ic: 'receipt', l: 'TVA à récupérer ce mois-ci', v: eur(somme(ceMois, 'tva')), s: 'à déduire de votre déclaration' }]),
    { ic: 'chart', l: `Depuis janvier`, v: eur(somme(an, 'ttc')), s: `${plural(an.length, 'achat')}, dont ${plural(an.filter(d => d.chantier_id).length, 'achat')} sur un chantier` },
  ])}</div><input id="q" style="width:100%;max-width:380px;margin-bottom:14px" placeholder="Rechercher un fournisseur, un achat, un chantier" aria-label="Rechercher"><div class="stack" id="rows"></div>`
    : `<div class="panel empty">${icon('cart', 28)}<p>Matériaux, location, sous-traitance, carburant : prenez vos tickets en photo, Kadra lit le montant. Vous saurez ce que chaque chantier vous laisse, et votre comptable aura tout.</p></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase(), g = {};
    for (const d of list) if (!q || JSON.stringify([d.fournisseur, d.libelle, d.chantier_nom, catLabel(d.categorie)]).toLowerCase().includes(q)) (g[d.date.slice(0, 7)] ||= []).push(d);
    $('#rows').innerHTML = Object.entries(g).map(([m, ds]) => `<section class="panel"><div class="ph"><h2>${moisLong(m)}</h2><span class="muted">${eur(somme(ds, 'ttc'))}${S.franchise_tva ? '' : ` dont ${eur(somme(ds, 'tva'))} de TVA`}</span></div>
<div class="pb" style="padding:4px 0">${depTable(ds)}</div></section>`).join('') || '<p class="muted">Aucune dépense trouvée.</p>';
  };
  if (list.length) { draw(); $('#q').oninput = draw; }
  view.onclick = async e => { const r = e.target.closest('[data-dep]'); if (r && await editDepense(list.find(x => x.id === +r.dataset.dep))) route(); };
  $('#new').onclick = async () => { if (await editDepense()) route(); };
  $('#compta').onclick = exportCompta;
  const [, arg] = location.hash.split('?');
  if (arg) { history.replaceState(null, '', '#/depenses'); arg === 'export' ? exportCompta() : $('#new').click(); }
}

// Fichiers pour le comptable : 3 tableaux Excel (CSV) et les écritures au format FEC, sur la période choisie.
function exportCompta() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const PER = { mois: [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))], annee: [`${y}-01-01`, today()], avant: [`${y - 1}-01-01`, `${y - 1}-12-31`] };
  const pr = modal({ title: 'Pour votre comptable', ok: 'Fermer', wide: true, text: 'Choisissez la période, téléchargez les fichiers, puis envoyez-les à votre comptable.',
    fields: [{ name: 'du', label: 'Du', type: 'date', value: PER.annee[0], required: true }, { name: 'au', label: 'Au', type: 'date', value: PER.annee[1], required: true }],
    html: `<div class="seg" id="per" role="group" aria-label="Période" style="margin:2px 0 14px">${[['mois', 'Mois dernier'], ['annee', `${y} à ce jour`], ['avant', String(y - 1)]].map(([k, l]) => `<button type="button" data-per="${k}" class="${k === 'annee' ? 'on' : ''}">${l}</button>`).join('')}</div>
<ul class="todo rows">${[['factures', 'receipt', 'Factures et avoirs', 'Tableau Excel : numéro, client, HT, TVA par taux, TTC, réglé, reste à payer.'],
    ['reglements', 'euro', 'Règlements reçus', 'Tableau Excel : date, facture, client, mode de paiement, montant.'],
    ['depenses', 'cart', 'Dépenses', 'Tableau Excel : fournisseur, chantier, catégorie, HT, TVA, TTC.'],
    ['fec', 'file', 'Écritures pour son logiciel (FEC)', 'Ventes, règlements et achats au format officiel, à importer chez le comptable. Comptes standards (704, 411, 445…) : il les ajuste si besoin.']]
    .map(([k, ic, t, s]) => `<li><span class="chip plan">${icon(ic)}</span><div class="t"><b>${t}</b><small>${s}</small></div><a class="btn" data-x="${k}" href="#">${icon('download', 15)}Télécharger</a></li>`).join('')}</ul>
<p class="muted" id="xmsg" style="font-size:13px;margin:12px 0 0">Les photos des tickets restent dans Kadra, sur chaque dépense.</p>` });
  const f = $('form', dlg);
  $('#per', f).onclick = e => {
    const b = e.target.closest('[data-per]');
    if (!b) return;
    [f.du.value, f.au.value] = PER[b.dataset.per];
    $$('[data-per]', f).forEach(x => x.classList.toggle('on', x === b));
  };
  $$('[data-x]', f).forEach(a => {
    a.onclick = e => { // le serveur répond en pièce jointe : le téléchargement part sans quitter la page
      if (!f.du.value || !f.au.value || f.du.value > f.au.value) { e.preventDefault(); $('#xmsg', f).textContent = 'Période invalide : la date de début doit précéder la date de fin.'; return; }
      a.href = `/api/export/${a.dataset.x}?du=${f.du.value}&au=${f.au.value}`;
    };
  });
  return pr;
}

// ---------- Clients ----------
const CLIENT_FIELDS = c => [{ name: 'nom', label: 'Nom', value: c.nom, required: true }, { name: 'email', label: 'E-mail', type: 'email', value: c.email }, { name: 'tel', label: 'Téléphone', value: c.tel },
  { name: 'siret', label: 'SIRET (client professionnel)', value: c.siret, hint: 'Obligatoire sur les factures électroniques entre professionnels.' }, { name: 'adresse', label: 'Adresse', type: 'textarea', rows: 3, value: c.adresse }];
async function editClient(c) {
  const v = await modal({ title: c.id ? c.nom : 'Nouveau client', ok: 'Enregistrer', fields: [...CLIENT_FIELDS(c), ...(c.id ? [{ name: 'supprimer', label: 'Supprimer ce client (ses documents sont conservés)', type: 'checkbox' }] : [])] });
  if (!v) return;
  const { supprimer, ...body } = v;
  if (supprimer) await api('clients/' + c.id, 'DELETE');
  else c.id ? await api('clients/' + c.id, 'PUT', body) : await api('clients', 'POST', body);
  toast(supprimer ? 'Client supprimé' : 'Client enregistré');
  if (supprimer) location.hash = '#/clients'; else route();
}
// ponytail: numéro français supposé (0… → 33…) ; saisir +XX pour un numéro étranger
const waNum = tel => { const n = String(tel || '').replace(/\D/g, ''); return n.startsWith('00') ? n.slice(2) : n.startsWith('0') ? '33' + n.slice(1) : n; };
async function client(id) {
  const [c, docs, chs, mails, rdvs] = await Promise.all([api('clients/' + id), api('documents'), api('chantiers'), api(`clients/${id}/emails`), api('rdv?client_id=' + id)]);
  const ds = docs.filter(d => d.client_id === c.id), cs = chs.filter(x => x.client_id === c.id);
  const avenir = rdvs.filter(r => r.statut === 'confirme' && r.debut.slice(0, 10) >= today()).sort((a, b) => a.debut.localeCompare(b.debut));
  head(c.nom, [c.email, c.tel].filter(Boolean).map(h).join(' · ') || 'Aucune coordonnée',
    `${c.tel ? `<a class="btn" href="${h(telLink(c.tel))}">${icon('phone', 16)}Appeler</a><a class="btn" target="_blank" rel="noopener" href="https://wa.me/${waNum(c.tel)}">WhatsApp</a>` : ''}<button class="btn" id="write">${icon('mail', 16)}Écrire</button><button class="btn yellow" id="ai">${icon('sparkle', 16)}Rédiger avec Kadra</button>
<button class="btn" id="rdv">${icon('calendar', 16)}Rendez-vous</button><button class="btn" id="edit">${icon('sliders', 16)}Modifier</button>`);
  const recus = mails.filter(m => m.sens === 'recu').length;
  view.innerHTML = `<div class="stack">
${c.adresse ? `<section class="panel"><div class="pb addr">${icon('pin')}<span>${h(c.adresse)}</span><a class="btn" target="_blank" rel="noopener" href="${h(maps(c.adresse))}">Itinéraire</a></div></section>` : ''}
<section class="panel"><div class="ph"><h2>Devis et factures</h2><button class="btn ghost" id="nouvDevis">${icon('plus', 15)}Nouveau devis</button></div><div class="pb" style="padding:4px 0">${docTable(ds, 'Aucun document pour ce client.')}</div></section>
${cs.length ? `<section class="panel"><div class="ph"><h2>Chantiers</h2></div><div class="pb" style="padding:6px 0">${cs.map(x => `<a class="chrow" href="#/chantier/${x.id}"><div><b>${h(x.nom)}</b><small>${finTexte(x)}</small></div><div><small><b>${x.avancement || 0} %</b> des travaux faits</small>${avance(x)}</div><small>${payeTexte(x)}</small><div>${chantierPill(x)}</div></a>`).join('')}</div></section>` : ''}
<section class="panel"><div class="ph"><h2>Prochains rendez-vous</h2></div><div class="pb">${evList(avenir, 'Aucun rendez-vous prévu avec ce client.', true)}</div></section>
<section class="panel"><div class="ph"><h2>E-mails avec ce client</h2><span class="muted">${plural(mails.length - recus, 'envoyé')}, ${plural(recus, 'reçu')}</span>${S.imap_host ? `<button class="btn ghost" id="relever">${icon('undo', 15)}Relever la boîte mail</button>` : ''}${mails.length ? `<a class="btn ghost" href="#/mails?client=${c.id}">${icon('mail', 15)}Toute la conversation</a>` : ''}</div>
<div class="pb">${mailList(mails.slice(0, 5), { reply: true, empty: 'Aucun e-mail pour le moment. Les devis, factures, relances et messages envoyés à ce client s’afficheront ici.' })}</div></section>
</div>`;
  $('#edit').onclick = () => editClient(c);
  $('#nouvDevis').onclick = () => nouveauDevis(c);
  $('#rdv').onclick = async () => { if (await editRdv({ client_id: c.id, chantier_id: cs.filter(x => x.statut !== 'termine').length === 1 ? cs.find(x => x.statut !== 'termine').id : null })) route(); };
  const { ecrire, rediger, repondre } = mailTools(c, mails);
  $('#write').onclick = () => ecrire();
  $('#ai').onclick = () => rediger();
  view.addEventListener('click', e => {
    const r = e.target.closest('[data-rep]'), rm = e.target.closest('[data-repm]');
    if (r) rediger(+r.dataset.rep);
    if (rm) repondre(mails.find(x => x.id === +rm.dataset.repm));
  });
  if ($('#relever')) $('#relever').onclick = e => busy(e.currentTarget, async () => { const r = await api('boite/relever', 'POST'); toast(r.nouveaux ? plural(r.nouveaux, 'nouvel e-mail', 'nouveaux e-mails') : 'Aucun nouvel e-mail'); if (r.nouveaux) route(); });
}
async function clients() {
  const [list, docs] = await Promise.all([api('clients'), api('documents')]);
  const stats = id => { const ds = docs.filter(d => d.client_id === id); return { n: ds.length, ca: ds.filter(d => d.type === 'facture' && d.numero).reduce((s, d) => s + d.total_ttc, 0), du: ds.filter(d => d.type === 'facture' && d.numero && d.kind !== 'avoir').reduce((s, d) => s + Math.max(0, d.total_ttc - d.regle), 0) }; };
  head('Clients', `${plural(list.length, 'client')}. Ceux que vous dictez dans un devis sont ajoutés automatiquement.`, `<button class="btn primary" id="new">${icon('plus')}Nouveau client</button>`);
  const tous = list.map(c => stats(c.id)), doivent = tous.filter(x => x.du > 0.005).length;
  view.innerHTML = `${list.length ? `<div style="margin-bottom:18px">${kpiRow([
    { ic: 'users', l: 'Clients', v: list.length, s: `dont ${plural(list.filter((c, i) => tous[i].n).length, 'client')} avec un devis ou une facture` },
    { ic: 'euro', l: 'Vous doivent', v: eur(tous.reduce((t, x) => t + x.du, 0)), s: doivent ? plural(doivent, 'client') + ' à relancer' : 'Personne ne vous doit rien' },
    { ic: 'receipt', l: 'Facturé au total', v: eur(tous.reduce((t, x) => t + x.ca, 0)), s: 'TTC, depuis le début' },
  ])}</div>` : ''}<input id="q" style="max-width:380px;margin-bottom:14px" placeholder="Rechercher un client" aria-label="Rechercher"><section class="panel" id="rows"></section>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase(), rows = list.filter(c => !q || [c.nom, c.email, c.tel, c.adresse].join(' ').toLowerCase().includes(q));
    $('#rows').innerHTML = rows.length ? `<table class="list"><thead><tr><th>Client</th><th class="hide-m">Téléphone</th><th class="n hide-m">Documents</th><th class="n hide-m">Facturé</th><th class="n">Reste dû</th></tr></thead><tbody>
${rows.map(c => { const s = stats(c.id); return `<tr data-href="#/client/${c.id}"><td><div class="who">${avatar(c.nom)}<div><b>${h(c.nom)}</b><small>${h(c.email || '')}</small></div></div></td>
<td class="hide-m">${h(c.tel)}</td><td class="n hide-m">${s.n}</td><td class="n amt hide-m">${eur(s.ca)}</td><td class="n amt" style="${s.du ? 'color:var(--crit)' : ''}">${eur(s.du)}</td></tr>`; }).join('')}</tbody></table>`
      : `<div class="empty">${icon('users', 28)}<p>Aucun client. Ils apparaissent ici dès votre premier devis.</p></div>`;
  };
  draw();
  $('#q').oninput = draw;
  $('#new').onclick = () => editClient({});
}

// ---------- Catalogue ----------
async function catalogue() {
  let [list, sug] = await Promise.all([api('catalog'), api('catalog/suggestions').catch(() => [])]);
  head('Catalogue de prix', 'Vos prix habituels : l’IA les reprend quand vous ne dictez pas de prix.', `<button class="btn primary" id="new">${icon('plus')}Nouvelle prestation</button>`);
  view.innerHTML = `${sug.length ? `<details class="panel plus" id="sug" style="margin-bottom:18px"><summary style="gap:10px">${icon('sparkle', 15)}<span id="sugn" style="flex:1">${plural(sug.length, 'prix trouvé', 'prix trouvés')} dans vos devis, pas encore au catalogue</span></summary><div class="pb">
<p class="ink2" style="margin-bottom:12px">Kadra les reprend déjà quand vous ne dictez pas de prix. Ajoutez au catalogue ceux qui sont vos prix habituels : vous pourrez les modifier.</p>
<table class="list"><tbody>${sug.map((c, i) => `<tr><td><b style="font-weight:600">${h(c.designation)}</b><br><small class="muted">${c.signe ? 'devis signé' : 'devis envoyé'} ${h(c.devis)}${c.fois > 1 ? ` · utilisé ${c.fois} fois` : ''}</small></td><td class="n amt">${eur(c.pu)}<small class="muted" style="display:block">/ ${h(c.unite)}</small></td>
<td class="n"><button class="btn" data-sug="${i}" aria-label="Ajouter au catalogue">${icon('plus', 15)}<span class="hide-m">Ajouter</span></button></td></tr>`).join('')}</tbody></table>
<div class="row" style="margin-top:12px"><button class="btn primary" id="sugall">Tout ajouter au catalogue</button></div></div></details>` : ''}
<input id="q" style="max-width:380px;margin-bottom:14px" placeholder="Rechercher une prestation" aria-label="Rechercher"><section class="panel" id="rows"></section>`;
  const ajouter = c => api('catalog', 'POST', { designation: c.designation, description: c.description || '', unite: c.unite || 'u', pu: +c.pu, tva: +(c.tva ?? S.tva_defaut) });
  if (sug.length) {
    // Ajout d'un prix : la ligne s'en va, la liste reste ouverte pour enchaîner les suivants.
    $('#sug').onclick = e => { const b = e.target.closest('[data-sug]'); if (b) busy(b, async () => {
      await ajouter(sug[+b.dataset.sug]); sug[+b.dataset.sug] = null; b.closest('tr').remove(); toast('Ajouté au catalogue');
      const reste = sug.filter(Boolean).length;
      if (!reste) return route();
      $('#sugn').textContent = `${plural(reste, 'prix trouvé', 'prix trouvés')} dans vos devis, pas encore au catalogue`;
      list = await api('catalog'); draw();
    }); };
    $('#sugall').onclick = e => busy(e.currentTarget, async () => { const r = sug.filter(Boolean); for (const c of r) await ajouter(c); toast(`${plural(r.length, 'prix ajouté', 'prix ajoutés')} au catalogue`); route(); });
  }
  const draw = () => {
    const q = $('#q').value.toLowerCase(), rows = list.filter(c => !q || [c.designation, c.description].join(' ').toLowerCase().includes(q));
    $('#rows').innerHTML = rows.length ? `<table class="list"><thead><tr><th>Prestation</th><th class="hide-m">Unité</th><th class="n">Prix HT</th><th class="n hide-m">TVA</th></tr></thead><tbody>
${rows.map(c => `<tr data-cat="${c.id}" style="cursor:pointer"><td><b style="font-weight:600">${h(c.designation)}</b>${c.description ? `<br><small class="muted">${h(c.description)}</small>` : ''}</td><td class="hide-m">${h(c.unite)}</td><td class="n amt">${eur(c.pu)}<small class="dm muted"> / ${h(c.unite)}</small></td><td class="n hide-m">${String(c.tva).replace('.', ',')} %</td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">${icon('tag', 28)}<p>Catalogue vide. Ajoutez vos prix, ou cliquez sur ${icon('star', 14)} dans une ligne de devis.</p></div>`;
  };
  const edit = async c => {
    const v = await modal({ title: c.id ? 'Modifier la prestation' : 'Nouvelle prestation', ok: 'Enregistrer', fields: [{ name: 'designation', label: 'Désignation', value: c.designation, required: true },
      { name: 'description', label: 'Détail', type: 'textarea', rows: 2, value: c.description }, { name: 'unite', label: 'Unité', value: c.unite || 'u' },
      { name: 'pu', label: 'Prix unitaire HT (€)', type: 'number', step: '0.01', value: c.pu ?? 0 }, { name: 'tva', label: 'TVA', type: 'select', value: c.tva ?? S.tva_defaut, options: TVAS.map(t => [t, `${String(t).replace('.', ',')} %`]) },
      ...(c.id ? [{ name: 'supprimer', label: 'Supprimer cette prestation', type: 'checkbox' }] : [])] });
    if (!v) return;
    if (v.supprimer) await api('catalog/' + c.id, 'DELETE');
    else { const body = { ...v, pu: +v.pu, tva: +v.tva }; delete body.supprimer; c.id ? await api('catalog/' + c.id, 'PUT', body) : await api('catalog', 'POST', body); }
    toast(v.supprimer ? 'Prestation supprimée' : 'Prestation enregistrée'); route();
  };
  draw();
  $('#q').oninput = draw;
  $('#new').onclick = () => edit({});
  $('#rows').onclick = e => { const tr = e.target.closest('[data-cat]'); if (tr) edit(list.find(c => c.id === +tr.dataset.cat)); };
}

// ---------- Notes : ce que l'artisan dit sur place (mesures, matériaux, travaux), repris plus tard pour faire le devis ----------
async function notes() {
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('chantier');
  // Sans réseau et sans données gardées : la page s'ouvre quand même, pour dicter une note
  const [list, clients, chs] = await Promise.all(['notes', 'clients', 'chantiers'].map(k => api(k).catch(e => { if (e.reseau) return []; throw e; })));
  const att = attente().filter(a => a.type === 'note');
  head('Notes', 'Sur place, dites ce que vous voyez : mesures, travaux, matériaux. Vous en ferez le devis plus tard.');
  const lie = n => (n.chantier_id ? 'ch:' + n.chantier_id : n.client_id ? 'cl:' + n.client_id : '');
  chs.sort((a, b) => (a.statut === 'termine') - (b.statut === 'termine'));
  // Comme un bloc-notes : une zone d'écriture blanche avec un petit micro, puis les notes en cartes
  view.innerHTML = `<div class="stack">
<section class="panel ncompose">
  <textarea id="ntxt" rows="3" aria-label="Texte de la note" placeholder="Ex. : chez M. Martin, salle de bain 2 m sur 3, refaire la faïence, prévoir 6 sacs de colle."></textarea>
  <div class="nbar"><button class="mic sm" id="nmic" aria-pressed="false" aria-label="Dicter une note">${icon('mic', 20)}</button><span class="muted" id="nst">Dictez ou écrivez</span>
  <select id="nlie" aria-label="Pour quel chantier ou client"><option value="">Pour : rien de précis</option>
  <optgroup label="Chantiers">${chs.map(c => `<option value="ch:${c.id}">${h(c.nom)}${c.client_nom ? ' – ' + h(c.client_nom) : ''}</option>`).join('')}</optgroup>
  <optgroup label="Clients">${clients.map(c => `<option value="cl:${c.id}">${h(c.nom)}</option>`).join('')}</optgroup></select>
  <button class="btn" id="nannule" hidden>Annuler</button><button class="btn primary" id="nok">${icon('check', 16)}<span>Garder la note</span></button></div>
</section>
<div class="ngrid" id="nlist">${att.map(a => `<article class="ncard attente"><header><span class="chip">${icon('clock', 15)}</span><div><b>${a.methode === 'PUT' ? 'Modification en attente' : 'En attente de réseau'}</b><small>${dfr(a.le.slice(0, 10))}</small></div></header><p>${h(a.body.texte)}</p></article>`).join('')}</div>
${list.length || att.length ? '' : `<div class="panel empty">${icon('note', 28)}<p>Aucune note pour l’instant. Depuis n’importe quelle page, vous pouvez aussi dire à Kadra « note : … ».</p></div>`}</div>`;
  const txt = $('#ntxt'), sel = $('#nlie');
  if (pre) sel.value = 'ch:' + pre;
  // Faire le devis = toutes les notes du même chantier (ou client), de la plus ancienne à la plus récente
  const groupe = n => (lie(n) ? list.filter(x => lie(x) === lie(n)) : [n]).sort((a, b) => a.id - b.id);
  $('#nlist').insertAdjacentHTML('beforeend', list.map(n => {
    const g = groupe(n).length;
    return `<article class="ncard" data-n="${n.id}"><header><span class="chip">${icon(n.chantier_id ? 'helmet' : n.client_id ? 'users' : 'note', 15)}</span><div><b>${h(n.chantier_nom || n.client_nom || 'Note libre')}</b><small>${dfr(n.created_at.slice(0, 10))}${n.chantier_nom && n.client_nom ? ' · ' + h(n.client_nom) : ''}</small></div>
</header>
<p>${h(n.texte)}</p><footer><button class="btn yellow sm" data-devis>${icon('sparkle', 14)}Faire le devis${g > 1 ? ` avec ces ${g} notes` : ''}</button><span style="flex:1"></span>
<button class="btn ghost icon sm" data-edit title="Modifier ou compléter" aria-label="Modifier ou compléter">${icon('note', 15)}</button><button class="btn ghost icon sm" data-del title="Supprimer la note" aria-label="Supprimer la note">${icon('trash', 15)}</button></footer></article>`;
  }).join(''));
  let edit = null;
  const reset = () => { edit = null; txt.value = ''; sel.value = pre ? 'ch:' + pre : ''; $('#nok span').textContent = 'Garder la note'; $('#nannule').hidden = true; };
  $('#nok').onclick = e => busy(e.currentTarget, async () => {
    if (!txt.value.trim()) throw new Error('Dictez ou écrivez d’abord la note.');
    const [k, v] = sel.value.split(':');
    const body = { texte: txt.value.trim(), chantier_id: k === 'ch' ? +v : null, client_id: k === 'cl' ? +v : null };
    try { await (edit ? api('notes/' + edit.id, 'PUT', body) : api('notes', 'POST', body)); }
    catch (err) {
      if (!err.reseau) throw err;
      if (edit) mettreEnAttente('note', body, 'notes/' + edit.id, 'PUT'); else mettreEnAttente('note', body);
      toast(`Pas de réseau : ${edit ? 'modification gardée' : 'note gardée'} sur le téléphone, elle partira toute seule.`); return route();
    }
    toast(edit ? 'Note modifiée' : 'Note gardée'); route();
  });
  $('#nannule').onclick = reset;
  mic($('#nmic'), { initial: () => txt.value, // on peut redicter pour compléter : la suite s'ajoute
    onState: on => { $('#nst').textContent = on ? 'Je vous écoute… appuyez pour terminer' : 'Dictez ou écrivez'; },
    onLive: (f, i) => { txt.value = f + i; }, onFinal: f => { if (f) txt.value = f; } });
  $('#nlist').onclick = async e => {
    const b = e.target.closest('button'), n = list.find(x => x.id === +e.target.closest('[data-n]')?.dataset.n);
    if (!b || !n) return;
    if ('devis' in b.dataset) {
      const g = groupe(n), c = n.client_nom || '', ch = n.chantier_nom || '';
      dicteeVocale = `${c ? `Client : ${c}. ` : ''}${ch ? `Chantier : ${ch}. ` : ''}${g.map(x => x.texte).join('\n')}`;
      location.hash = '#/nouveau';
    } else if ('edit' in b.dataset) {
      edit = n; txt.value = n.texte; sel.value = lie(n); $('#nok span').textContent = 'Enregistrer la note'; $('#nannule').hidden = false;
      scrollTo({ top: 0, behavior: 'smooth' }); txt.focus();
    } else if ('del' in b.dataset && await modal({ title: 'Supprimer cette note ?', text: h(n.texte.slice(0, 200)), ok: 'Supprimer', danger: true })) {
      await api('notes/' + n.id, 'DELETE'); toast('Note supprimée'); route();
    }
  };
}

// ---------- Mise en page ----------
async function templates() {
  let list, demandes;
  [list, demandes, S] = await Promise.all([api('templates'), ME.kadra ? [] : api('demandes-modele').catch(() => []), api('settings')]); // S rechargé : Kadra a pu changer la mise en page par défaut
  head('Mise en page', 'L’apparence de vos devis et factures. Choisissez un modèle ou faites reproduire le vôtre.');
  // Équipe Kadra : import direct par l'IA. Artisan : il envoie son devis, l'équipe Kadra le reproduit (prestation payante).
  const zone = ME.kadra ? `<b>Importer votre propre modèle</b><br>
<span class="ink2">Déposez votre devis actuel (photo, PDF ou fichier Excel) : l’IA reproduit sa mise en page et vos couleurs. Vous pourrez ensuite tout retoucher comme dans Word.</span>`
    : `<b>Gardez la présentation de vos devis actuels</b><br>
<span class="ink2">Envoyez-nous le devis que vous utilisez aujourd’hui (Word, Excel, PDF ou photo) : l’équipe Kadra le reproduit à l’identique, avec vos couleurs et votre logo, et le met dans votre compte. Vous seul y avez accès. Service payant : nous vous contactons avec le tarif avant de commencer.</span>`;
  view.innerHTML = `<div class="stack"><label class="drop" id="drop">${icon('upload', 28)}<div style="flex:1;min-width:220px">${zone}<br><span id="st" class="muted" aria-live="polite"></span></div>
<span class="btn">${ME.kadra ? 'Choisir un fichier' : 'Envoyer mon modèle'}</span><input type="file" id="file" class="sr" accept="${ME.kadra ? 'image/png,image/jpeg,image/webp,application/pdf,.xlsx,.html,.htm' : 'image/*,application/pdf,.xlsx,.xls,.ods,.docx,.doc,.odt'}"></label>
${demandes.length ? `<section class="panel"><div class="pb">${demandes.map(d => `<p style="margin:6px 0">${d.statut === 'faite' ? P('Prêt', 'good', 'check') : P('En cours chez Kadra', 'plan', 'clock')} ${h(d.nom)}, envoyé le ${dfr(d.created_at.slice(0, 10))}</p>`).join('')}</div></section>` : ''}
<div class="gallery">${list.map(t => `<section class="panel tpl"><div class="thumb"><iframe src="/templates/${t.id}/apercu" loading="lazy" title="Aperçu ${h(t.nom)}" tabindex="-1"></iframe></div>
<div class="pb"><b style="flex:1">${h(t.nom)}</b>${S.template_id == t.id ? P('Par défaut', 'good', 'check') : `<button class="btn" data-def="${t.id}">Par défaut</button>`}
<details class="menu"><summary class="btn icon" aria-label="Actions">${icon('more')}</summary><div class="mp"><button data-dup="${t.id}">${icon('copy', 16)}Dupliquer et personnaliser</button>
${t.builtin ? '' : `<a href="#/template/${t.id}">${icon('layout', 16)}Modifier</a><button class="danger" data-del="${t.id}">${icon('trash', 16)}Supprimer</button>`}</div></details></div></section>`).join('')}</div></div>`;
  view.querySelector('.gallery').onclick = async e => {
    const { def, dup, del } = e.target.closest('button')?.dataset || {};
    if (def) { S = await api('settings', 'PUT', { template_id: +def }); toast('Mise en page par défaut changée'); route(); }
    if (dup) { const t = list.find(x => x.id == dup); location.hash = '#/template/' + (await api('templates', 'POST', { nom: t.nom + ' (personnalisé)', html: t.html })).id; }
    if (del && await confirmer('Supprimer ce modèle ?', '')) { await api('templates/' + del, 'DELETE'); route(); }
  };
  const importer = async f => {
    if (!f) return;
    if (f.size > 15e6) return toast('Fichier trop lourd (15 Mo maximum).', 'crit');
    if (!ME.kadra) {
      const v = await modal({ title: 'Envoyer votre modèle à Kadra', text: `<b>${h(f.name)}</b><br>L’équipe Kadra le reproduit dans votre compte et vous prévient par e-mail quand il est prêt. Nous vous contactons d’abord avec le tarif.`,
        fields: [{ name: 'message', label: 'Une précision ? (facultatif)', type: 'textarea', rows: 3, placeholder: 'Ex. : gardez le bandeau bleu en haut, mon numéro de portable est le 06…' }], ok: 'Envoyer' });
      if (!v) return;
      try { await api('demandes-modele', 'POST', { file: await fileToURL(f), nom: f.name, message: v.message }); toast('Modèle envoyé : vous recevrez un e-mail quand il sera prêt.'); route(); }
      catch (err) { toast(err.message, 'crit'); }
      return;
    }
    if (/\.(xls|ods|numbers)$/i.test(f.name)) return toast('Enregistrez d’abord votre fichier au format Excel .xlsx (Fichier > Enregistrer sous).', 'crit');
    const nom = f.name.replace(/\.\w+$/, '');
    try {
      if (/\.html?$/i.test(f.name)) { location.hash = '#/template/' + (await api('templates', 'POST', { nom, html: await f.text() })).id; return; }
      $('#st').textContent = 'L’IA analyse votre document, environ une minute…';
      location.hash = '#/template/' + (await api('ai/template', 'POST', { file: await fileToURL(f), nom })).id;
      toast('Modèle reproduit');
    } catch (err) { $('#st').textContent = err.message; }
  };
  $('#file').onchange = e => importer(e.target.files[0]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); importer(e.dataTransfer.files[0]); };
}
// Éditeur visuel, comme dans Word : la page d'exemple est modifiable directement. Les balises du gabarit ({{x}}, {{{x}}})
// deviennent des zones en pointillé non modifiables (remplies à chaque devis) ; à l'enregistrement elles redeviennent des balises.
const BALISE = /\{\{(\{?)\s*([\w.]+)\s*\}?\}\}/g;
const POLICES = ['Arial', 'Calibri', 'Georgia', 'Helvetica', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Courier New'];
const TAILLES = [['1', 'Très petit'], ['2', 'Petit'], ['3', 'Normal'], ['4', 'Moyen'], ['5', 'Grand'], ['6', 'Très grand'], ['7', 'Énorme']];
const ED_CSS = `<style>[data-ph]{outline:1px dashed #9aa3ad;outline-offset:1px;background:rgba(31,79,182,.06);border-radius:2px;cursor:default}
[data-ph]:hover{outline-color:#1f4fb6}.ed-sel{outline:2px solid #1f4fb6!important;outline-offset:3px}img{cursor:pointer}.page{padding:var(--ed-marge,24px)!important}</style>`;
// Marges de la page (comme Word) : une balise <style id="kd-marges"> dans l'en-tête du modèle, lue par le PDF (@page) et par les éditeurs (--ed-marge).
const MARGES = [[6, 'Étroites'], [10, 'Moyennes'], [12, 'Normales'], [20, 'Larges']];
const KD_MARGES = /<style id="kd-marges">[\s\S]*?<\/style>/;
const INTERLIGNES = [['1', '1'], ['1.15', '1,15'], ['1.45', '1,5'], ['2', '2']];
async function editTemplate(id) {
  const [t, ex, ph] = await Promise.all([api('templates/' + id), api('templates/exemple?id=' + id), api('placeholders')]);
  head('Modifier la mise en page', 'Cliquez dans la page pour écrire, sélectionnez du texte pour le mettre en forme. Les zones en pointillé se remplissent toutes seules à chaque devis.',
    `<a class="btn" href="#/templates">Retour</a><button class="btn primary" id="save">${icon('check', 16)}Enregistrer</button>`);
  const B = (c, label, ic) => `<button type="button" data-c="${c}" title="${label}" aria-label="${label}">${ic}</button>`;
  view.innerHTML = `<div class="word"><div class="wbar" role="toolbar" aria-label="Mise en forme">
<input id="nom" class="wnom" value="${h(t.nom)}" aria-label="Nom de la mise en page">
<select id="police" aria-label="Police"><option value="">Police</option>${POLICES.map(p => `<option style="font-family:'${p}'">${p}</option>`).join('')}</select>
<select id="taille" aria-label="Taille du texte"><option value="">Taille</option>${TAILLES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
<span class="grp">${B('bold', 'Gras', '<b>G</b>')}${B('italic', 'Italique', '<i>I</i>')}${B('underline', 'Souligné', '<u>S</u>')}</span>
<label class="clr" title="Couleur du texte"><span>A</span><input type="color" id="fg" value="#1d1d1b" aria-label="Couleur du texte"></label>
<span class="grp">${B('justifyLeft', 'Aligner à gauche', icon('alignL'))}${B('justifyCenter', 'Centrer', icon('alignC'))}${B('justifyRight', 'Aligner à droite', icon('alignR'))}</span>
<span class="grp">${B('up', 'Monter le bloc sélectionné', icon('up'))}${B('down', 'Descendre le bloc sélectionné', icon('down'))}</span>
<button type="button" id="img" title="Insérer une image ou un logo">${icon('image')}Image</button><input type="file" id="imgf" class="sr" accept="image/png,image/jpeg,image/webp">
<label class="clr" id="imgw" hidden>Taille <input type="range" min="10" max="100" aria-label="Taille de l’image"></label>
<select id="champ" aria-label="Insérer un champ"><option value="">Insérer un champ…</option>${Object.entries(ph).filter(([k]) => !['{css_base}', 'entreprise.couleur'].includes(k)).map(([k, l]) => `<option value="${h(k)}">${h(l.replace(/ \(HTML\)$/, ''))}</option>`).join('')}</select>
<label class="clr" title="Couleur principale de l’entreprise">Couleur <input type="color" id="coul" value="${h(ex.entreprise.couleur)}" aria-label="Couleur principale de l’entreprise"></label>
<span class="grp"><select id="marges" aria-label="Marges de la page"><option value="">Marges</option>${MARGES.map(([v, l]) => `<option value="${v}">${l} (${v} mm)</option>`).join('')}</select>
<select id="interl" aria-label="Interligne du bloc sélectionné"><option value="">Interligne</option>${INTERLIGNES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
<label class="clr" title="Espace au-dessus du bloc sélectionné">Avant <input type="number" id="avant" min="0" max="120" step="2" aria-label="Espace avant, en pixels"></label>
<label class="clr" title="Espace sous le bloc sélectionné">Après <input type="number" id="apres" min="0" max="120" step="2" aria-label="Espace après, en pixels"></label>
<label class="clr" title="Largeur du bloc sélectionné">Largeur <input type="range" id="larg" min="20" max="100" aria-label="Largeur du bloc, en %"></label></span>
</div><div class="sheet"><iframe id="ed" title="Page à modifier"></iframe></div></div>`;

  const src = new DOMParser().parseFromString(t.html, 'text/html');
  let rawHead = src.head.innerHTML;
  const lang = src.documentElement.lang || 'fr';
  const val = (raw, p) => { const v = getP(ex, p) ?? ''; return raw ? String(v) : h(v); };
  const remplir = s => s.replace(BALISE, (_, raw, p) => val(raw, p));
  const fr = $('#ed'), d = fr.contentDocument;
  d.open(); d.write(`<!doctype html><html lang="${lang}"><head>${remplir(rawHead)}${ED_CSS}</head><body>${src.body.innerHTML}</body></html>`); d.close();
  for (const a of src.body.attributes) d.body.setAttribute(a.name, a.value);
  const puce = (tok, raw, p) => {
    const e = d.createElement(raw ? 'div' : 'span');
    e.dataset.ph = tok; e.contentEditable = 'false'; e.title = `${ph[raw ? `{${p}}` : p] || p} : rempli automatiquement`.replace(' (HTML)', '');
    e.innerHTML = val(raw, p);
    return e;
  };
  const w = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT), textes = [];
  while (w.nextNode()) if (w.currentNode.data.includes('{{') && !/^(STYLE|SCRIPT|TITLE)$/.test(w.currentNode.parentNode.nodeName)) textes.push(w.currentNode);
  for (const n of textes) {
    const frag = d.createDocumentFragment();
    let i = 0;
    n.data.replace(BALISE, (tok, raw, p, at) => { frag.append(n.data.slice(i, at), puce(tok, raw, p)); i = at + tok.length; });
    frag.append(n.data.slice(i)); n.replaceWith(frag);
  }
  // Balise dans un attribut (ex. style="color:{{entreprise.couleur}}") : valeur affichée, balise gardée de côté.
  const attrs = () => [d.body, ...d.body.querySelectorAll('*')];
  for (const el of attrs()) for (const a of [...el.attributes]) if (a.value.includes('{{') && !a.name.startsWith('data-')) { el.setAttribute('data-raw-' + a.name, a.value); a.value = remplir(a.value); }
  d.body.contentEditable = 'true'; d.body.spellcheck = false;
  d.execCommand('styleWithCSS', false, true);

  let bloc;
  const choisir = el => {
    // une zone seule dans son cadre : on prend le cadre (on déplace l'encadré client, pas son contenu)
    while (el?.parentElement && el.parentElement !== d.body && el.parentElement.children.length === 1 && el.parentElement.textContent.trim() === el.textContent.trim()) el = el.parentElement;
    bloc?.classList.remove('ed-sel');
    bloc = el && el !== d.body ? el : null;
    bloc?.classList.add('ed-sel');
    $('#imgw').hidden = bloc?.nodeName !== 'IMG';
    if (bloc?.nodeName === 'IMG') $('#imgw input').value = parseInt(bloc.style.width) || 100;
    if (!bloc) return;
    const cs = fr.contentWindow.getComputedStyle(bloc);
    $('#avant').value = parseInt(cs.marginTop) || 0; $('#apres').value = parseInt(cs.marginBottom) || 0;
    $('#larg').value = Math.round(bloc.offsetWidth / (bloc.parentElement.clientWidth || 1) * 100);
  };
  const style = (prop, v) => {
    if (!bloc) return toast('Cliquez d’abord sur un bloc de la page.');
    // zone automatique : redevient sa balise à l'enregistrement, le style va donc sur un cadre autour
    if (bloc.matches('[data-ph]')) { const c = d.createElement('div'); bloc.before(c); c.append(bloc); bloc.classList.remove('ed-sel'); bloc = c; c.classList.add('ed-sel'); }
    bloc.style[prop] = v;
  };
  $('#avant').oninput = e => style('marginTop', (+e.target.value || 0) + 'px');
  $('#apres').oninput = e => style('marginBottom', (+e.target.value || 0) + 'px');
  $('#larg').oninput = e => { style('width', e.target.value + '%'); if (bloc) bloc.style.maxWidth = 'none'; };
  $('#interl').onchange = e => { if (e.target.value) style('lineHeight', e.target.value); e.target.value = ''; };
  const mm = (KD_MARGES.exec(rawHead)?.[0].match(/margin:(\d+)mm/) || [])[1];
  if (mm) $('#marges').value = mm;
  $('#marges').onchange = e => {
    const v = +e.target.value;
    if (!v) return;
    rawHead = rawHead.replace(KD_MARGES, '') + `<style id="kd-marges">@page{margin:${v}mm}:root{--ed-marge:${v}mm}</style>`;
    d.head.innerHTML = remplir(rawHead) + ED_CSS;
  };
  d.addEventListener('click', e => {
    const atome = e.target.closest('img, [data-ph]');
    if (atome) { const r = d.createRange(); r.selectNode(atome); d.getSelection().removeAllRanges(); d.getSelection().addRange(r); }
    choisir(e.target.closest('img, div[data-ph], p, h1, h2, h3, h4, h5, h6, table, ul, ol, div'));
  });
  const bouger = sens => {
    if (!bloc) return toast('Cliquez d’abord sur un bloc de la page.');
    const voisin = sens < 0 ? bloc.previousElementSibling : bloc.nextElementSibling;
    if (voisin) voisin[sens < 0 ? 'before' : 'after'](bloc);
    else if (bloc.parentElement !== d.body) bloc.parentElement[sens < 0 ? 'before' : 'after'](bloc); // sort de son cadre
    bloc.scrollIntoView({ block: 'nearest' });
  };
  const cmd = (c, v = null) => { fr.contentWindow.focus(); return d.execCommand(c, false, v); };
  const bar = $('.wbar');
  bar.onmousedown = e => { if (e.target.closest('button')) e.preventDefault(); }; // garde la sélection dans la page
  bar.onclick = e => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'up' || c === 'down') bouger(c === 'up' ? -1 : 1); else if (c) cmd(c);
  };
  $('#police').onchange = e => { if (e.target.value) cmd('fontName', e.target.value); e.target.value = ''; };
  $('#taille').onchange = e => { if (e.target.value) cmd('fontSize', e.target.value); e.target.value = ''; };
  $('#fg').onchange = e => cmd('foreColor', e.target.value);
  $('#img').onclick = () => $('#imgf').click();
  $('#imgf').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const tag = `<img src="${await imageURL(f)}" alt="" style="width:30%;height:auto">`;
    if (!cmd('insertHTML', tag)) (bloc || d.body.firstElementChild || d.body).insertAdjacentHTML('afterbegin', tag);
  };
  $('#imgw input').oninput = e => { if (bloc?.nodeName === 'IMG') bloc.style.width = e.target.value + '%'; };
  $('#champ').onchange = e => {
    const k = e.target.value;
    e.target.value = '';
    if (!k) return;
    const raw = k.startsWith('{'), p = raw ? k.slice(1, -1) : k, c = puce(raw ? `{{{${p}}}}` : `{{${p}}}`, raw, p), s = d.getSelection();
    if (s.rangeCount && d.body.contains(s.anchorNode)) { const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(c); } else (bloc || d.body).append(c);
  };
  $('#coul').oninput = e => {
    ex.entreprise.couleur = e.target.value;
    d.head.innerHTML = remplir(rawHead) + ED_CSS;
    for (const el of attrs()) for (const a of [...el.attributes]) if (a.name.startsWith('data-raw-')) el.setAttribute(a.name.slice(9), remplir(a.value));
  };
  $('#save').onclick = () => busy($('#save'), async () => {
    const b = d.body.cloneNode(true);
    b.querySelectorAll('[data-ph]').forEach(c => c.replaceWith(c.dataset.ph));
    for (const el of [b, ...b.querySelectorAll('*')]) {
      el.classList.remove('ed-sel');
      if (el.getAttribute('class') === '') el.removeAttribute('class');
      for (const a of [...el.attributes]) if (a.name.startsWith('data-raw-')) {
        const n = a.name.slice(9);
        if (el.getAttribute(n) === remplir(a.value)) el.setAttribute(n, a.value); // pas retouché : on remet la balise
        el.removeAttribute(a.name);
      }
    }
    b.removeAttribute('contenteditable'); b.removeAttribute('spellcheck');
    await api('templates/' + id, 'PUT', { nom: $('#nom').value, html: `<!doctype html><html lang="${lang}"><head>${rawHead}</head>${b.outerHTML}</html>` });
    if (ex.entreprise.couleur !== S.couleur) { S = await api('settings', 'PUT', { couleur: ex.entreprise.couleur }); teinte(); }
    toast('Mise en page enregistrée');
  });
}

// ---------- Paramètres ----------
const TABS = [['entreprise', 'Entreprise', 'building'], ['documents', 'Devis et factures', 'file'], ['paiement', 'Paiement en ligne', 'card'],
  ['relances', 'Automatismes', 'mail'], ['style', 'Kadra vous connaît', 'sparkle'], ['equipe', 'Équipe', 'users'], ['compte', 'Mon compte', 'key'], ['import', 'Importer mes données', 'upload']];
// Image des paramètres (logo, cachet) : aperçu + Ajouter/Changer + Retirer
const imgChamp = (k, l, hint) => `<div class="f"><span>${l}</span><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${S[k] ? `<img src="${h(S[k])}" alt="${l} actuel" style="max-height:48px;max-width:160px">` : ''}<label class="btn">${icon('upload', 16)}${S[k] ? 'Changer' : 'Ajouter'}<input type="file" id="${k}" class="sr" accept="image/*"></label>${S[k] ? `<button class="btn ghost" id="no${k}">Retirer</button>` : ''}</div><small class="muted">${hint}</small></div>`;
async function parametres(tab = 'entreprise') {
  head('Paramètres', 'Chaque modification est enregistrée automatiquement.');
  view.innerHTML = `<div class="settings"><nav class="vtabs" aria-label="Rubriques">${TABS.map(([k, l, ic]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</nav><div id="tab" class="stack"></div></div>`;
  $$('[data-tab]').forEach(b => { b.onclick = () => { location.hash = b.dataset.tab === 'import' ? '#/import' : '#/parametres/' + b.dataset.tab; }; });
  const F = (k, label, type = 'text', extra = {}) => field({ name: k, label, type, value: S[k], ...extra }).replace(`name="${k}"`, `name="${k}" data-s="${k}"`);
  const sec = (t, body, sub = '') => `<section class="panel"><div class="ph"><h2>${t}</h2></div><div class="pb">${sub ? `<p class="ink2" style="margin-bottom:14px">${sub}</p>` : ''}<div class="fg">${body}</div></div></section>`;
  const T = $('#tab');
  // ce qui sert rarement est replié : l'artisan voit d'abord l'essentiel
  const plus = (t, body, sub = '') => `<details class="panel plus"><summary>${t}</summary><div class="pb">${sub ? `<p class="ink2" style="margin-bottom:14px">${sub}</p>` : ''}<div class="fg">${body}</div></div></details>`;
  if (tab === 'entreprise') T.innerHTML = sec('Identité', F('nom', 'Raison sociale') + F('tel', 'Téléphone', 'tel') + F('email', 'E-mail (reçoit les avis de signature et de paiement)', 'email') + F('site', 'Site web')
    + F('adresse', 'Adresse', 'textarea', { rows: 3, hint: 'Code postal et ville sur une ligne : « 69003 Lyon ».' }) + F('couleur', 'Couleur de vos documents', 'color')
    + imgChamp('logo', 'Logo', 'Placé en haut de chaque devis et facture, quelle que soit la mise en page.')
    + imgChamp('cachet', 'Cachet et signature', 'Photo de votre tampon signé, sur fond blanc : il s’ajoute dans la case « L’entreprise » de vos devis.'))
    + sec('Obligatoire sur vos devis et factures', F('siret', 'SIRET') + F('iban', 'IBAN (pour être payé par virement)')
    + F('assurance', 'Assurance décennale', 'textarea', { rows: 2, hint: 'Assureur, n° de contrat, zone géographique couverte.', cls: 'wide' }))
    + plus('Autres mentions (RCS, TVA intracommunautaire, BIC)', F('rcs', 'RCS ou RM') + F('tva_intra', 'N° de TVA intracommunautaire') + F('bic', 'BIC'));
  if (tab === 'documents') T.innerHTML = sec('TVA et délais', F('franchise_tva', 'Franchise en base de TVA (micro-entreprise)', 'checkbox') + F('tva_defaut', 'TVA par défaut (%)', 'number', { step: 'any' })
    + F('validite_jours', 'Validité des devis (jours)', 'number') + F('delai_paiement_jours', 'Délai de paiement (jours)', 'number') + F('acompte_defaut', 'Acompte par défaut (%)', 'number'))
    + plus('Facture électronique (réglages rares)', F('categorie_operation', 'Catégorie des opérations', 'select', { options: [['prestation de services', 'Prestation de services'], ['livraison de biens', 'Livraison de biens'], ['mixte (biens et services)', 'Mixte']] })
    + F('tva_debits', 'Option pour la TVA sur les débits', 'checkbox'),
    'Chaque facture émise est un PDF Factur-X (profil EN 16931), lisible par les plateformes agréées de la réforme 2026-2027. Les nouvelles mentions obligatoires sont ajoutées automatiquement.')
    + plus('Textes en bas des documents', F('conditions_paiement', 'Conditions de paiement', 'textarea', { rows: 2, cls: 'wide' }) + F('mentions', 'Mentions en bas de document', 'textarea', { rows: 3, cls: 'wide' }));
  if (tab === 'paiement') T.innerHTML = sec('Paiement par carte avec Stripe', F('stripe_secret', 'Clé secrète Stripe', 'password', { value: '', placeholder: 'sk_live_…', hint: S.stripe_secret ? 'Une clé est enregistrée. Saisissez-en une nouvelle pour la remplacer.' : 'Tableau de bord Stripe, Développeurs, Clés API.' })
    + F('stripe_webhook_secret', 'Secret du webhook (facultatif)', 'password', { value: '', placeholder: 'whsec_…', hint: 'Enregistre le paiement même si le client ferme la page trop tôt.' })
    + `<div class="f wide"><span>Adresse du webhook à déclarer dans Stripe (événement checkout.session.completed)</span><code class="url">${location.origin}/stripe/webhook/${ME.compte}</code></div>`
    + F('acompte_auto', 'À la signature d’un devis, émettre et envoyer automatiquement la facture d’acompte', 'checkbox', { cls: 'wide' }),
    'Vos clients paient vos factures par carte depuis le lien reçu par e-mail. L’argent arrive sur votre compte Stripe et le règlement s’enregistre tout seul.');
  if (tab === 'relances') {
    // L'essentiel : des cases à cocher en phrases. Délais, textes des e-mails et réglages de la boîte mail sont repliés.
    T.innerHTML = sec('Ce que Kadra fait pour vous', F('relances_auto', 'Relancer les devis sans réponse et les factures impayées', 'checkbox', { cls: 'wide' })
      + F('rappel_rdv', 'La veille d’un rendez-vous, envoyer un rappel par e-mail au client (vers 17 h)', 'checkbox', { cls: 'wide' })
      + F('alerte_retard_chantier', 'Prévenir le client quand un chantier dépasse sa date de fin', 'checkbox', { cls: 'wide' })
      + F('resume_quotidien', `Chaque matin à 7 h, m’envoyer ce qui est à traiter (à ${h(S.email || 'l’adresse de l’entreprise')})`, 'checkbox', { cls: 'wide' })
      + F('rdv_auto', 'Repérer les rendez-vous dans les e-mails de mes clients et me les proposer dans l’agenda', 'checkbox', { cls: 'wide' })
      + `<div class="f wide" style="flex-direction:row;gap:8px;flex-wrap:wrap"><button class="btn" id="apercu">Voir le résumé d’aujourd’hui</button><button class="btn" id="run">${icon('send', 16)}Lancer les relances maintenant</button></div>`,
      'Rien n’est envoyé à un client sans une de ces cases cochées ; les rendez-vous trouvés attendent votre accord dans l’Agenda.')
      + sec('Ma boîte mail', `<div class="f wide"><span>${S.imap_host ? 'Kadra lit votre boîte toutes les 10 minutes et range les e-mails de vos clients sur leur fiche.' : 'Branchez votre boîte mail pour voir dans Kadra les réponses de vos clients.'}</span><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${S.imap_erreur ? P(h(S.imap_erreur), 'crit', 'alert') : S.imap_releve_le ? P('Relevée le ' + new Date(S.imap_releve_le).toLocaleString(LOC, { dateStyle: 'short', timeStyle: 'short' }), 'good', 'check') : P('Pas encore branchée')}${S.imap_host ? '<button class="btn" id="relever">Relever maintenant</button>' : ''}</div></div>`)
      + plus('Brancher ou changer la boîte mail', F('imap_user', 'Adresse e-mail', 'email') + F('imap_pass', 'Mot de passe d’application', 'password', { value: '', placeholder: S.imap_pass ? '••••••••' : '', hint: S.imap_pass ? 'Enregistré. Saisissez-en un nouveau pour le remplacer.' : 'Gmail : Compte Google, Sécurité, Mots de passe des applications.' })
        + F('imap_host', 'Serveur IMAP', 'text', { placeholder: 'imap.gmail.com' }) + F('imap_port', 'Port', 'number', { placeholder: '993' }),
        'Seuls les e-mails échangés avec vos clients sont lus et gardés ; la première fois, les 90 derniers jours.')
      + plus('Délais des relances', F('relance_devis_jours', 'Relancer un devis après (jours)', 'number') + F('relance_facture_jours', 'Intervalle entre relances de facture (jours)', 'number') + F('relances_max', 'Relances au maximum', 'number'))
      + plus('Textes des e-mails', F('mail_envoi', 'Envoi d’un document', 'textarea', { rows: 6, cls: 'wide' }) + F('mail_relance_devis', 'Relance de devis', 'textarea', { rows: 5, cls: 'wide' })
      + F('mail_relance_facture', 'Relance de facture', 'textarea', { rows: 5, cls: 'wide' }) + F('mail_retard_chantier', 'Retard de chantier', 'textarea', { rows: 5, cls: 'wide' }) + F('mail_point', 'Point d’avancement', 'textarea', { rows: 5, cls: 'wide' }) + F('mail_rappel_rdv', 'Rappel de rendez-vous ({quand}, {lieu}, {objet})', 'textarea', { rows: 5, cls: 'wide' }),
      'Variables : {client} {numero} {montant} {reste} {echeance} {lien} {entreprise} {chantier} {date_fin} {avancement} {budget} {encaisse}. Tous les e-mails envoyés sont dans la rubrique E-mails.');
    if (!S.imap_host) $('[data-s="imap_user"]').addEventListener('change', e => { if (/@gmail\.com$/i.test(e.target.value)) api('settings', 'PUT', { imap_host: 'imap.gmail.com', imap_port: 993 }).then(x => { S = x; }); }); // Gmail : serveur rempli tout seul
    if ($('#relever')) $('#relever').onclick = e => busy(e.currentTarget, async () => { try { const r = await api('boite/relever', 'POST'); toast(plural(r.nouveaux, 'nouvel e-mail', 'nouveaux e-mails') + ' rangé' + (r.nouveaux > 1 ? 's' : '')); } finally { S = await api('settings'); route(); } });
    $('#apercu').onclick = async () => { const r = await api('resume'); modal({ title: r.n ? r.sujet : 'Rien à traiter aujourd’hui', ok: 'Fermer', wide: true, html: r.n ? `<pre style="white-space:pre-wrap;font:inherit">${h(r.corps)}</pre>` : '' }); };
    $('#run').onclick = e => busy(e.currentTarget, async () => { const r = await api('relances', 'POST'); toast(r.length ? `${plural(r.length, 'e-mail')} traité${r.length > 1 ? 's' : ''}` : 'Rien à relancer pour le moment'); route(); });
  }
  if (tab === 'style') {
    // Kadra apprend seul (devis envoyés, corrections, e-mails écrits par l'artisan) ; l'artisan peut retirer une habitude ou donner ses consignes.
    let st = await api('style');
    const liste = (l, k) => (l?.length ? `<ul class="habitudes">${l.map((r, i) => `<li><span>${h(r)}</span><button class="btn ghost icon" data-ret="${k}:${i}" title="Kadra se trompe : retirer" aria-label="Retirer cette habitude">${icon('x', 15)}</button></li>`).join('')}</ul>` : '');
    const draw = () => {
      const appris = (st.style?.devis?.length || 0) + (st.style?.mails?.length || 0);
      T.innerHTML = `<section class="panel"><div class="ph"><h2>Ce que Kadra a remarqué</h2><button class="btn" id="relire">${icon('sparkle', 16)}${st.style ? 'Relire mes devis' : 'Apprendre maintenant'}</button></div><div class="pb">
<p class="ink2" style="margin-bottom:14px">Kadra observe vos devis envoyés, ce que vous corrigez dans ses propositions et les e-mails que vous écrivez vous-même, puis rédige comme vous. Vous n’avez rien à faire : il se met à jour tout seul. Si une habitude est fausse, retirez-la, il ne la reprendra pas.</p>
${appris ? `${st.style.devis.length ? `<h3 class="hh">Dans vos devis</h3>${liste(st.style.devis, 'devis')}` : ''}${st.style.mails.length ? `<h3 class="hh">Dans vos e-mails</h3>${liste(st.style.mails, 'mails')}` : ''}
<p class="muted" style="font-size:13px;margin-top:10px">Mis à jour le ${dfr(st.style.le.slice(0, 10))}, d’après ${plural(st.matiere.devis, 'devis', 'devis')} et ${plural(st.matiere.mails, 'e-mail')}.</p>`
    : `<p class="muted">${st.matiere.devis + st.matiere.mails ? 'Rien de net pour l’instant : Kadra en saura plus après quelques devis envoyés.' : 'Pas encore de devis envoyé : Kadra commencera à apprendre dès vos premiers devis.'}</p>`}</div></section>
<section class="panel"><div class="ph"><h2>Vos consignes permanentes</h2></div><div class="pb">
<p class="ink2" style="margin-bottom:14px">Ce que Kadra doit toujours faire, en une phrase. Exemples : « Ajoute toujours une ligne de nettoyage de fin de chantier », « Écris F/P devant les fournitures posées », « Acompte de 40 % ».</p>
${liste(st.regles, 'regle')}
<form id="nreg" class="row" style="margin-top:10px;align-items:flex-end"><label class="f" style="flex:1;min-width:220px"><span>Nouvelle consigne</span><input name="r" maxlength="300" required placeholder="Ex. : Ajoute toujours l’évacuation des gravats"></label><button class="btn primary">${icon('plus', 16)}Ajouter</button></form></div></section>`;
      $('#nreg').onsubmit = async e => { e.preventDefault(); try { st = { ...st, ...(await api('style', 'PUT', { regles: [...st.regles, e.target.r.value] })) }; S = await api('settings'); draw(); toast('Consigne retenue'); } catch (err) { toast(err.message, 'crit'); } };
      $('#relire').onclick = e => busy(e.currentTarget, async () => {
        e.currentTarget.innerHTML = `${icon('sparkle', 16)}Kadra relit vos devis…`;
        try { st = { ...st, style: await api('ai/style', 'POST') }; S = await api('settings'); toast('Kadra a relu vos devis'); } finally { draw(); }
      });
    };
    draw();
    T.onclick = async e => {
      const b = e.target.closest('[data-ret]');
      if (!b) return;
      const [k, i] = b.dataset.ret.split(':');
      try { st = { ...st, ...(await api('style', 'PUT', k === 'regle' ? { regles: st.regles.filter((_, j) => j !== +i) } : { retirer: { liste: k, i: +i } })) }; S = await api('settings'); draw(); toast(k === 'regle' ? 'Consigne retirée' : 'Habitude retirée : Kadra ne la reprendra pas'); }
      catch (err) { toast(err.message, 'crit'); }
    };
  }
  if (tab === 'equipe') {
    const users = await api('equipe'), adm = ME.user.role === 'admin';
    T.innerHTML = `<section class="panel"><div class="ph"><h2>Membres de ${h(ME.entreprise)}</h2>${adm ? `<button class="btn primary" id="add">${icon('plus', 16)}Ajouter un membre</button>` : ''}</div><div class="pb" style="padding:4px 0">
<table class="list"><tbody>${users.map(u => `<tr><td><div class="who">${avatar(u.nom || u.email)}<div><b>${h(u.nom || u.email)}</b><small>${h(u.email)}</small></div></div></td><td>${u.role === 'admin' ? P('Administrateur', 'plan') : P('Membre')}</td>
<td class="n">${adm && u.id !== ME.user.id ? `<button class="btn ghost danger" data-deluser="${u.id}">${icon('trash', 16)}Retirer</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>
<p class="muted">Chaque membre a son propre accès et voit les données de l’entreprise. Seuls les administrateurs gèrent l’équipe.</p>`;
    if (adm) $('#add').onclick = async () => {
      const v = await modal({ title: 'Ajouter un membre', ok: 'Créer l’accès', text: 'Communiquez-lui son mot de passe provisoire : il pourra le changer dans Mon compte.',
        fields: [{ name: 'nom', label: 'Nom' }, { name: 'email', label: 'E-mail', type: 'email', required: true }, { name: 'password', label: 'Mot de passe provisoire', required: true, hint: '8 caractères minimum' },
          { name: 'role', label: 'Rôle', type: 'select', options: [['membre', 'Membre'], ['admin', 'Administrateur']] }] });
      if (v) { try { await api('equipe', 'POST', v); toast('Accès créé'); route(); } catch (e) { toast(e.message, 'crit'); } }
    };
    T.onclick = async e => { const b = e.target.closest('[data-deluser]'); if (b && await confirmer('Retirer ce membre ?', 'Il ne pourra plus se connecter.', 'Retirer')) { await api('equipe/' + b.dataset.deluser, 'DELETE'); route(); } };
  }
  if (tab === 'compte') {
    T.innerHTML = `<section class="panel"><div class="ph"><h2>Mot de passe</h2></div><div class="pb"><form id="pw" class="fg" style="align-items:end">
${field({ name: 'ancien', label: 'Mot de passe actuel', type: 'password', required: true })}${field({ name: 'nouveau', label: 'Nouveau mot de passe', type: 'password', required: true, hint: '8 caractères minimum' })}
<button class="btn primary">Changer le mot de passe</button></form></div></section>
<section class="panel"><div class="ph"><h2>Langue de l’appli</h2></div><div class="pb" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span class="muted">Les menus, boutons et messages de Kadra, sur cet appareil. Vos devis et factures restent en français.</span>${choixLangueSite()}</div></section>
<section class="panel"><div class="ph"><h2>Langue de dictée</h2></div><div class="pb" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><b>${h(nomLangue(maLangue()))}${langue2() ? ` + ${h(nomLangue(langue2()))}` : ' seulement'}</b><br><span class="muted">${LANGUE_AIDE}</span></div><button class="btn" id="lg">Changer</button></div></section>
<section class="panel"><div class="ph"><h2>Voix de Kadra</h2></div><div class="pb" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><b>${[maLangue(), langue2()].filter(Boolean).map(l => `${h(nomLangue(l))} : ${h(nomVoix(l))}`).join('<br>')}</b><br><span class="muted">La voix qui vous lit les réponses de Kadra, dans la langue où vous lui parlez. Propre à cet appareil.</span></div><button class="btn" id="vx">Changer</button></div></section>
<section class="panel"><div class="ph"><h2>Visite guidée</h2></div><div class="pb" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span class="muted">Refaire pas à pas un chantier d’exemple, du devis au paiement. L’exemple s’efface à la fin.</span><button class="btn" id="revis">${icon('sparkle', 16)}Revoir la visite</button></div></section>
<section class="panel"><div class="pb" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><b>${h(ME.user.email)}</b><br><span class="muted">${h(ME.entreprise)}</span></div><button class="btn" id="out">${icon('logout', 16)}Se déconnecter</button></div></section>`;
    $('#pw').onsubmit = async e => { e.preventDefault(); try { await api('me/password', 'PUT', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast('Mot de passe changé'); } catch (err) { toast(err.message, 'crit'); } };
    $('#out').onclick = async () => { await api('auth/logout', 'POST'); login(); };
    $('#lg').onclick = async () => { await choisirLangue(); badgesLangue(); route(); };
    $('#vx').onclick = async () => { await choisirVoix(); route(); };
    $('#revis').onclick = () => visiteDemarrer(true);
  }
  T.addEventListener('change', async e => {
    const k = e.target.dataset.s;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? +e.target.value : e.target.value;
    try { S = await api('settings', 'PUT', { [k]: v }); toast('Enregistré'); if (k === 'couleur') teinte(); if (k === 'stripe_secret' || k === 'nom') { ME = await api('me'); shell(); route(); } } catch (err) { toast(err.message, 'crit'); }
  });
  for (const k of ['logo', 'cachet']) {
    if ($('#' + k)) $('#' + k).onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      const img = new Image(); img.src = await fileToURL(f); await img.decode();
      const r = Math.min(1, 600 / img.width), cv = document.createElement('canvas');
      cv.width = img.width * r; cv.height = img.height * r; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      S = await api('settings', 'PUT', { [k]: cv.toDataURL('image/png') }); toast('Enregistré'); route();
    };
    if ($('#no' + k)) $('#no' + k).onclick = async () => { S = await api('settings', 'PUT', { [k]: '' }); route(); };
  }
}

// ---------- Agenda : mois en grille, journée choisie à côté, propositions de Claude en haut ----------
const MOIS_FR = m => new Date(m + '-15T12:00').toLocaleDateString(LOC, { month: 'long', year: 'numeric' });
async function agenda(arg) {
  const [list, chs] = await Promise.all([api('rdv'), api('chantiers')]);
  const prop = list.filter(r => r.statut === 'propose').sort((a, b) => a.debut.localeCompare(b.debut));
  // rendez-vous confirmés + repères de chantier (début, fin prévue), triés : « journée » avant les heures
  const evs = [...list.filter(r => r.statut !== 'propose'),
    ...chs.filter(c => c.statut !== 'termine').flatMap(c => [
      c.date_debut && { k: 'ch', id: c.id, debut: c.date_debut, titre: `Début du chantier : ${c.nom}`, client_nom: c.client_nom, lieu: c.adresse },
      c.date_fin_prevue && { k: 'ch', id: c.id, debut: c.date_fin_prevue, titre: `Fin prévue : ${c.nom}`, client_nom: c.client_nom, lieu: c.adresse }].filter(Boolean)),
  ].sort((a, b) => a.debut.localeCompare(b.debut));
  const du = j => evs.filter(e => e.debut.slice(0, 10) === j);
  let sel = /^\d{4}-\d{2}-\d{2}$/.test(arg || '') ? arg : today(), mois = sel.slice(0, 7);
  const demande = location.hash.endsWith('?new'); // « Nouveau rendez-vous » depuis la recherche Ctrl K
  const semaine = evs.filter(e => !e.k && e.debut.slice(0, 10) >= today() && e.debut.slice(0, 10) < new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)).length;
  head('Agenda', `${semaine ? `${plural(semaine, 'rendez-vous', 'rendez-vous')} dans les 7 prochains jours` : 'Aucun rendez-vous dans les 7 prochains jours'}${prop.length ? `, ${prop.length} à confirmer` : ''}.`,
    `<button class="btn" id="scan" title="Kadra lit vos derniers échanges avec les clients">${icon('sparkle', 16)}Chercher dans mes e-mails</button>
<button class="btn" id="tel">${icon('phone', 16)}Sur mon téléphone</button><button class="btn primary" id="new">${icon('plus')}Nouveau rendez-vous</button>`);
  // Tout tient dans l'écran (Hivan) : le calendrier à gauche sur toute la hauteur, le reste à droite dans une colonne qui défile seule
  view.innerHTML = `<div class="agenda"><section class="panel" id="cal"></section><div class="acol">
<section class="panel" id="jour"></section>
${prop.length ? `<section class="panel propw"><div class="ph"><h2>${icon('sparkle')} Trouvés dans vos e-mails <span class="muted">${prop.length}</span></h2></div><div class="pb"><ul class="evs prop">${prop.map(r => `<li>
<span class="hr"><b>${dshort(r.debut.slice(0, 10))}</b>${evTime(r)}</span><div class="t"><b>${h(r.titre)}</b><small>${[r.client_nom, r.email_sujet && `e-mail « ${r.email_sujet} »`].filter(Boolean).map(h).join(' · ')}</small></div>
<div class="pacts"><button class="btn primary sm" data-okp="${r.id}">${icon('check', 14)}Confirmer</button><button class="btn sm" data-ev="${r.id}">Modifier</button><button class="btn ghost sm" data-nop="${r.id}">Ignorer</button></div></li>`).join('')}</ul></div></section>` : ''}
<section class="panel"><div class="ph"><h2>À venir</h2></div><div class="pb">${evList(evs.filter(e => !e.k && e.debut.slice(0, 10) >= today()).slice(0, 8), 'Aucun rendez-vous à venir.', true)}</div></section></div></div>`;
  const draw = () => {
    history.replaceState(null, '', '#/agenda/' + sel); // après un enregistrement, route() revient sur ce jour (et ce mois)
    const [y, m] = mois.split('-').map(Number), off = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7, nb = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const jours = [...Array(Math.ceil((off + nb) / 7) * 7)].map((_, i) => new Date(Date.UTC(y, m - 1, 1 + i - off)).toISOString().slice(0, 10));
    $('#cal').innerHTML = `<div class="ph calh"><button class="btn icon ghost" data-m="-1" aria-label="Mois précédent">${icon('chevL')}</button><h2>${MOIS_FR(mois)}</h2>
<button class="btn icon ghost" data-m="1" aria-label="Mois suivant">${icon('chevR')}</button>${mois === today().slice(0, 7) ? '' : '<button class="btn" data-m="0">Aujourd’hui</button>'}</div>
<div class="pb"><div class="calg" style="--sem:${jours.length / 7}">${['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'].map(d => `<div class="dow">${d}</div>`).join('')}${jours.map(j => {
      const e = du(j);
      return `<button class="day ${j.slice(0, 7) !== mois ? 'out' : ''} ${j === today() ? 'tod' : ''} ${j === sel ? 'sel' : ''}" data-j="${j}" aria-label="${dlong(j)}${e.length ? `, ${plural(e.length, 'événement')}` : ''}">
<span class="dn">${+j.slice(8)}</span>${e.slice(0, 3).map(x => `<span class="ev ${x.k || ''}">${!x.k && x.debut.length > 10 ? `<b>${x.debut.slice(11)}</b> ` : ''}${h(x.titre)}</span>`).join('')}${e.length > 3 ? `<span class="more">+${e.length - 3}</span>` : ''}</button>`;
    }).join('')}</div></div>`;
    $('#jour').innerHTML = `<div class="ph"><h2>${new Date(sel + 'T12:00').toLocaleDateString(LOC, { weekday: 'long', day: 'numeric', month: 'long' })}</h2><button class="btn ghost" id="addj">${icon('plus', 15)}Ajouter</button></div>
<div class="pb">${evList(du(sel), 'Rien de prévu ce jour-là.')}</div>`;
  };
  draw();
  view.addEventListener('click', async e => {
    const t = e.target.closest('[data-m],[data-j],#addj,[data-okp],[data-nop]');
    if (!t) return;
    if (t.dataset.m) { const [y, m] = mois.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + +t.dataset.m, 1)); if (t.dataset.m === '0') sel = today(); mois = t.dataset.m === '0' ? today().slice(0, 7) : d.toISOString().slice(0, 7); }
    if (t.dataset.j) { sel = t.dataset.j; if (sel.slice(0, 7) !== mois) mois = sel.slice(0, 7); }
    if (t.id === 'addj' && await editRdv({ debut: sel })) return route();
    if (t.dataset.okp) { await api('rdv/' + t.dataset.okp, 'PUT', { statut: 'confirme' }); toast('Ajouté à l’agenda'); return route(); }
    if (t.dataset.nop) { await api('rdv/' + t.dataset.nop, 'DELETE'); toast('Proposition ignorée'); return route(); }
    draw();
  });
  $('#new').onclick = async () => { if (await editRdv({ debut: sel })) route(); };
  $('#scan').onclick = e => busy(e.currentTarget, async () => {
    toast('Kadra lit vos derniers e-mails…');
    const r = await api('rdv/chercher', 'POST');
    toast(r.trouves ? `${plural(r.trouves, 'rendez-vous trouvé', 'rendez-vous trouvés')} : à confirmer` : 'Aucun nouveau rendez-vous dans vos e-mails');
    if (r.trouves) route();
  });
  $('#tel').onclick = async () => {
    const { url } = await api('agenda/lien');
    const local = /localhost|127\.0\.0\.1/.test(url);
    modal({ title: 'Voir l’agenda sur votre téléphone', ok: 'Fermer', wide: true,
      text: 'Abonnez l’agenda de votre téléphone à ce lien : vos rendez-vous Kadra s’y affichent et se mettent à jour tout seuls (toutes les quelques heures).',
      html: `<code class="url">${h(url)}</code><div><button type="button" class="btn" id="cp">${icon('copy', 16)}Copier le lien</button></div>
<ul class="ink2" style="margin:0;padding-left:18px;display:grid;gap:6px"><li><b>Google Agenda</b> (sur ordinateur) : Autres agendas, +, À partir de l’URL, collez le lien.</li>
<li><b>iPhone</b> : Réglages, Calendrier, Comptes, Ajouter un compte, Autre, Ajouter un calendrier avec abonnement.</li><li><b>Outlook</b> : Ajouter un calendrier, S’abonner à partir du web.</li></ul>
${local ? `<p class="ask">${icon('alert')}<span>Ce lien pointe sur cet ordinateur (localhost) : il ne marchera sur le téléphone qu’une fois le site en ligne (adresse publique).</span></p>` : ''}
<p class="muted" style="font-size:13px">Gardez ce lien pour vous : il donne accès à vos rendez-vous.</p>` });
    $('#cp', dlg).onclick = async () => { await navigator.clipboard.writeText(url); toast('Lien copié'); };
  };
  if (demande) $('#new').click();
}

// ---------- E-mails : boîte façon messagerie (dossiers, conversations, réponse sur place) ----------
const sujetNu = s => String(s || '').replace(/^\s*((re|tr|fwd?)\s*:\s*)+/i, '').trim();
const quandCourt = m => {
  const d = new Date(m.created_at.replace(' ', 'T') + 'Z'), t = new Date();
  return d.toDateString() === t.toDateString() ? d.toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(LOC, { day: 'numeric', month: 'short', ...(d.getFullYear() !== t.getFullYear() && { year: 'numeric' }) });
};
const initiale = s => (String(s).replace(/^(M\.|Mme|SCI|SARL|Cabinet)\s+(et Mme\s+)?/i, '')[0] || '?').toUpperCase();
// Conversation = même client + même numéro de document cité (DEV-/FAC-/AV-), sinon même objet sans « Re: ». Les avis de Kadra restent seuls.
function conversations(list, pourMoi) {
  const conv = new Map();
  for (const m of [...list].reverse()) {
    const num = /\b(?:DEV|FAC|AV)-\d{4}-\d{4}\b/.exec(m.sujet)?.[0];
    const k = pourMoi(m) ? 'avis' + m.id : `${m.cli ?? (m.sens === 'recu' ? m.de : m.a)}|${num || sujetNu(m.sujet).toLowerCase()}`;
    (conv.get(k) || conv.set(k, []).get(k)).push(m);
  }
  return [...conv.values()].map(ms => ({ id: ms[0].id, ms, der: ms.at(-1) })).sort((a, b) => b.der.created_at.localeCompare(a.der.created_at) || b.der.id - a.der.id);
}
const boiteEtat = { f: null, cli: '', q: '' }; // dossier, client et recherche gardés quand on revient d'une conversation
async function mails(id) {
  const [list, clients] = await Promise.all([api('mails'), api('clients')]);
  const moi = (S.email || '').toLowerCase(), pourMoi = m => m.sens !== 'recu' && moi && (m.a || '').toLowerCase() === moi;
  const convs = conversations(list, pourMoi), nonLu = c => c.ms.some(m => m.lu === 0);
  const F = [['recus', 'Boîte de réception', 'mail', c => c.ms.some(m => m.sens === 'recu')], ['envoyes', 'Envoyés', 'send', c => c.ms.some(m => m.sens !== 'recu' && !pourMoi(m))],
    ['avis', 'Avis de Kadra', 'star', c => pourMoi(c.der)], ['tous', 'Tous les e-mails', 'layers', () => true]];
  const qcli = new URLSearchParams(location.hash.split('?')[1] || '').get('client');
  if (qcli) Object.assign(boiteEtat, { cli: qcli, f: 'tous' });
  boiteEtat.f ||= convs.some(F[0][3]) ? 'recus' : 'tous';
  const avec = clients.filter(c => list.some(m => m.cli === c.id)).map(c => ({ ...c, n: convs.filter(x => x.der.cli === c.id && !pourMoi(x.der)).length, nl: convs.some(x => x.der.cli === c.id && nonLu(x)) }));
  const nonLus = convs.filter(c => F[0][3](c) && nonLu(c)).length;
  head('E-mails', `Tous vos échanges avec vos clients, rangés par conversation.${nonLus ? ` ${plural(nonLus, 'conversation non lue', 'conversations non lues')}.` : ''}`,
    `${S.imap_host ? `<button class="btn" id="relever">${icon('undo', 16)}Relever la boîte mail</button>` : ''}<button class="btn yellow" id="ai">${icon('sparkle', 16)}Rédiger avec Kadra</button>`);
  const conv = id && convs.find(c => c.ms.some(m => m.id === +id));
  view.innerHTML = `${S.imap_host ? '' : `<div class="ask" style="margin-bottom:14px">${icon('mail')}<div>Seuls les e-mails envoyés depuis Kadra apparaissent. <a href="#/parametres/relances">Branchez votre boîte mail</a> pour recevoir ici les réponses de vos clients.</div></div>`}
<div class="boite ${conv ? 'lit' : ''}">
<aside class="dossiers"><button class="btn primary" id="write">${icon('plus', 16)}Nouveau message</button>
<nav>${F.map(([k, l, ic]) => `<button data-f="${k}" class="${!boiteEtat.cli && k === boiteEtat.f ? 'on' : ''}">${icon(ic, 17)}<span>${l}</span>${k === 'recus' && nonLus ? `<em>${nonLus}</em>` : ''}</button>`).join('')}</nav>
${avec.length ? `<h4>Clients</h4><nav class="clis">${avec.map(c => `<button data-cli="${c.id}" class="${String(c.id) === boiteEtat.cli ? 'on' : ''} ${c.nl ? 'nl' : ''}"><span class="av">${initiale(c.nom)}</span><span>${h(c.nom)}</span><em>${c.n}</em></button>`).join('')}</nav>` : ''}</aside>
<section class="panel boitep" id="main"></section></div>`;
  const main = $('#main');
  const nomConv = c => (pourMoi(c.der) ? 'Kadra' : c.der.client_nom || c.ms.find(m => m.sens === 'recu')?.de || c.der.a || '(sans adresse)');

  const drawList = () => {
    const f = F.find(x => x[0] === boiteEtat.f)[3], q = boiteEtat.q.toLowerCase(), cl = clients.find(c => String(c.id) === boiteEtat.cli);
    const rows = convs.filter(c => (cl ? c.der.cli === cl.id && !pourMoi(c.der) : f(c)) && (!q || c.ms.some(m => [m.sujet, m.corps, m.client_nom, m.de, m.a].join(' ').toLowerCase().includes(q))));
    let n = 50;
    main.innerHTML = `<div class="lh"><input id="q" type="search" placeholder="Rechercher un client, un objet, un mot…" aria-label="Rechercher dans les e-mails" value="${h(boiteEtat.q)}">
${cl ? `<span class="pill plan">${h(cl.nom)}<button class="lien" id="sanscli" aria-label="Voir tous les clients">${icon('x', 14)}</button></span><a class="btn ghost" href="#/client/${cl.id}">Fiche client</a>` : ''}</div>
<div id="rows"></div>`;
    const draw = () => {
      $('#rows', main).innerHTML = rows.length ? rows.slice(0, n).map(c => {
        const envoi = !F[0][3](c) && !pourMoi(c.der), pj = c.ms.some(m => JSON.parse(m.pieces || '[]').length), rate = /^(échec|simulé)/.test(c.der.statut);
        return `<a class="mrow ${nonLu(c) ? 'nl' : ''}" href="#/mails/${c.id}"><span class="av ${pourMoi(c.der) ? 'k' : ''}">${initiale(nomConv(c))}</span>
<span class="qui">${envoi ? '<small>À :</small> ' : ''}${h(nomConv(c))}${c.ms.length > 1 ? ` <em>${c.ms.length}</em>` : ''}</span>
<span class="obj"><b>${h(sujetNu(c.ms[0].sujet) || '(sans objet)')}</b><span> – ${h(String(c.der.corps).replace(/\s+/g, ' ').slice(0, 160))}</span></span>
<span class="meta">${rate ? '<small class="crit">Pas parti</small>' : ''}${pj ? icon('download', 15) : ''}<time>${quandCourt(c.der)}</time></span></a>`;
      }).join('') + (rows.length > n ? `<div style="text-align:center;padding:14px"><button class="btn" id="plus">Afficher plus (${rows.length - n})</button></div>` : '')
        : `<div class="empty">${icon('mail', 26)}<p>${q ? 'Aucun e-mail ne correspond à la recherche.' : boiteEtat.f === 'recus' && !cl ? 'Aucun e-mail reçu pour le moment.' : 'Aucun e-mail ici.'}</p></div>`;
      if ($('#plus', main)) $('#plus', main).onclick = () => { n += 100; draw(); };
    };
    draw();
    $('#q', main).oninput = e => { boiteEtat.q = e.target.value.trim(); const pos = e.target.selectionStart; drawList(); const i = $('#q', main); i.focus(); i.setSelectionRange(pos, pos); };
    if ($('#sanscli', main)) $('#sanscli', main).onclick = () => { boiteEtat.cli = ''; history.replaceState(null, '', '#/mails'); route(); };
  };

  const drawConv = async () => {
    const c = clients.find(x => x.id === conv.der.cli) || clients.find(x => conv.ms.some(m => m.cli === x.id)), avis = pourMoi(conv.der);
    const dernierRecu = [...conv.ms].reverse().find(m => m.sens === 'recu');
    main.innerHTML = `<div class="convh"><a class="btn ghost icon" href="#/mails" aria-label="Retour à la liste" title="Retour">${icon('chevL', 20)}</a>
<h2>${h(sujetNu(conv.ms[0].sujet) || '(sans objet)')}</h2>${c ? `<a class="btn ghost" href="#/client/${c.id}">${icon('users', 15)}${h(c.nom)}</a>` : ''}</div>
<div class="fil">${conv.ms.map((m, i) => {
      const recu = m.sens === 'recu', ouvert = i === conv.ms.length - 1 || m.lu === 0 || conv.ms.length <= 3;
      const de = recu ? (m.client_nom || m.de) : pourMoi(m) ? 'Kadra' : S.nom || 'Vous', vers = recu || pourMoi(m) ? 'vous' : m.client_nom || m.a;
      const echange = recu || (!pourMoi(m) && !m.document_id && !m.chantier_id);
      return `<article class="msg ${ouvert ? 'open' : ''} ${recu ? 'in' : ''}">
<header><span class="av ${recu ? '' : 'moi'}">${initiale(de)}</span><div class="t"><b>${h(de)}</b> <small>${recu && m.de ? `&lt;${h(m.de)}&gt;` : ''}</small><small class="vers">à ${h(vers)}</small><span class="apercu">${h(String(m.corps).replace(/\s+/g, ' ').slice(0, 140))}</span></div>
<time>${quand(m)}</time></header>
<div class="corps">${h(m.corps)}</div>
<footer>${recu ? '' : mailEtat(m)}${JSON.parse(m.pieces || '[]').map(p => `<a class="btn ghost" href="/api/pieces/${p.id}" target="_blank" rel="noopener">${icon('download', 15)}${h(p.nom)}</a>`).join('')}
${echange ? `<button class="btn ghost" data-rdv="${m.id}" title="Kadra lit l’e-mail et prépare le rendez-vous">${icon('calendar', 15)}Ajouter à l’agenda</button>` : ''}
${m.document_id ? `<a class="btn ghost" href="#/doc/${m.document_id}">${icon('file', 15)}Voir le document</a>` : m.chantier_id ? `<a class="btn ghost" href="#/chantier/${m.chantier_id}">${icon('helmet', 15)}Voir le chantier</a>` : ''}</footer></article>`;
    }).join('')}</div>
${avis ? '<p class="muted pad">Message envoyé par Kadra pour vous informer : pas de réponse à faire.</p>'
    : !c ? '<p class="muted pad">Cet e-mail n’est rattaché à aucun client : ajoutez son adresse sur une fiche client pour lui répondre d’ici.</p>'
    : !c.email ? `<p class="muted pad">Ajoutez l’e-mail de ${h(c.nom)} sur sa <a href="#/client/${c.id}">fiche</a> pour lui répondre.</p>`
    : `<div class="rep"><div class="to">${icon('send', 15)}Répondre à <b>${h(c.nom)}</b> <span class="muted">&lt;${h(c.email)}&gt;</span></div>
<textarea id="rep" rows="7" placeholder="Écrivez votre réponse.&#10;Ou cliquez sur « Kadra rédige » : il répond tout seul (si vous écrivez d’abord quelques mots, il s’en sert comme consigne).&#10;Ou appuyez sur le micro et dites-lui quoi répondre : « dis-lui que je suis disponible demain à 10 h »."></textarea>
<div class="ra"><button class="btn primary" id="envoyer">${icon('send', 16)}Envoyer</button><button class="btn yellow" id="claude">${icon('sparkle', 16)}Kadra rédige</button>
<button type="button" class="mic sm" id="rmic" aria-pressed="false" aria-label="Dire à Kadra quoi répondre" title="Dites à Kadra quoi répondre : il écrit l’e-mail">${icon('mic', 18)}</button><span class="muted" id="rlive"></span></div></div>`}`;
    main.addEventListener('click', e => { const a = e.target.closest('.msg:not(.open) header'); if (a) a.parentElement.classList.add('open'); });
    const ta = $('#rep', main);
    if (ta) {
      const sujet = 'Re: ' + sujetNu(conv.ms[0].sujet), reponse_a = dernierRecu?.id || conv.der.id;
      const rediger = (btn, corps) => busy(btn, async () => {
        toast('Kadra rédige la réponse…');
        const r = await api(`clients/${c.id}/brouillon`, 'POST', corps);
        ta.value = r.corps; ta.rows = Math.min(18, r.corps.split('\n').length + 2); ta.focus();
        toast('Relisez, modifiez si besoin, puis envoyez.');
      });
      // Le micro parle à Kadra : la phrase dite est une consigne (« dis-lui que je suis dispo demain 10 h »),
      // Kadra écrit la réponse à la façon de l'artisan, en reprenant ce qui est déjà dans le cadre.
      const rl = $('#rlive', main);
      mic($('#rmic', main), { onLive: (f, i) => { rl.textContent = (f + ' ' + i).trim() || 'Dites à Kadra quoi répondre…'; },
        onFinal: f => { rl.textContent = ''; if (f) rediger($('#claude', main), { consigne: f, actuel: ta.value, reponse_a }); } });
      $('#claude', main).onclick = e => rediger(e.currentTarget, { consigne: ta.value, reponse_a });
      $('#envoyer', main).onclick = e => {
        if (!ta.value.trim()) return ta.focus();
        busy(e.currentTarget, async () => {
          const r = await api(`clients/${c.id}/email`, 'POST', { sujet, corps: ta.value, reponse_a });
          toast('E-mail ' + r.statut, /^(échec|simulé)/.test(r.statut) ? 'crit' : undefined); route();
        });
      };
    }
    const lus = conv.ms.filter(m => m.lu === 0).map(m => m.id);
    if (lus.length) { await api('mails/lus', 'POST', { ids: lus }); badges(); }
  };
  if (conv) drawConv(); else { if (id) toast('Conversation introuvable.', 'crit'); drawList(); }

  const aller = () => (location.hash === '#/mails' ? route() : (location.hash = '#/mails'));
  $$('[data-f]', view).forEach(b => { b.onclick = () => { Object.assign(boiteEtat, { f: b.dataset.f, cli: '' }); aller(); }; });
  $$('[data-cli]', view).forEach(b => { b.onclick = () => { boiteEtat.cli = b.dataset.cli; aller(); }; });
  const choisir = async () => {
    const c = clients.find(x => String(x.id) === boiteEtat.cli || (conv && x.id === conv.der.cli));
    if (c?.email) return c;
    const v = await modal({ title: 'À quel client ?', ok: 'Continuer', fields: [{ name: 'c', label: 'Client', type: 'select', options: clients.filter(x => x.email).map(x => [x.id, x.nom]) }] });
    return v && clients.find(x => x.id === +v.c);
  };
  $('#write').onclick = async () => { const c = await choisir(); if (c) mailTools(c, []).ecrire(); };
  $('#ai').onclick = async () => { const c = await choisir(); if (c) mailTools(c, []).rediger(); };
  if ($('#relever')) $('#relever').onclick = e => busy(e.currentTarget, async () => { const r = await api('boite/relever', 'POST'); toast(r.nouveaux ? plural(r.nouveaux, 'nouvel e-mail', 'nouveaux e-mails') : 'Aucun nouvel e-mail'); if (r.nouveaux) route(); });
}

// ---------- Équipe Kadra : modèles à reproduire (prestation) ----------
async function kadraAdmin() {
  const list = await api('kadra/demandes');
  head('Modèles à reproduire', 'Devis envoyés par les artisans. « Reproduire » crée la mise en page dans leur compte, la met par défaut et les prévient par e-mail.');
  view.innerHTML = list.length ? `<div class="stack">${list.map(d => `<section class="panel" data-d="${d.id}"><div class="pb">
<p style="margin:0 0 6px">${d.statut === 'faite' ? P('Fait', 'good', 'check') : P('À faire', 'warn', 'clock')} <b>${h(d.entreprise)}</b> <span class="muted">${h(d.user_email)}, le ${dfr(d.created_at.slice(0, 10))}</span></p>
<p style="margin:0 0 6px"><a href="/api/kadra/demandes/${d.id}/fichier" target="_blank" rel="noopener">${icon('download', 16)} ${h(d.nom)}</a>${d.lisible || d.template_id ? '' : ' <span class="muted">(Word ou ancien Excel : ouvrez-le, enregistrez-le en PDF ou en .xlsx, puis « Avec un autre fichier »)</span>'}</p>
${d.message ? `<p class="ink2" style="margin:0 0 6px;white-space:pre-wrap">${h(d.message)}</p>` : ''}
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${d.lisible ? `<button class="btn primary" data-go>${icon('layout', 16)}Reproduire</button>` : ''}
<label class="btn">${icon('upload', 16)}Avec un autre fichier<input type="file" class="sr" data-autre accept="image/png,image/jpeg,image/webp,application/pdf,.xlsx"></label>
${d.template_id ? `<a class="btn" href="/api/kadra/templates/${d.template_id}/apercu" target="_blank" rel="noopener">Voir le résultat</a>` : ''}
<button class="btn ghost danger" data-del>${icon('trash', 16)}Supprimer</button><span class="muted" data-st aria-live="polite"></span></div></div></section>`).join('')}</div>`
    : `<div class="empty">${icon('layout', 28)}<p>Aucune demande pour l’instant.</p></div>`;
  const go = async (sec, file) => {
    $('[data-st]', sec).textContent = 'L’IA reproduit le modèle, environ une minute…';
    $$('button', sec).forEach(b => { b.disabled = true; });
    try { await api(`kadra/demandes/${sec.dataset.d}/importer`, 'POST', file ? { file } : {}); toast('Modèle reproduit, l’artisan est prévenu'); route(); }
    catch (err) { $('[data-st]', sec).textContent = err.message; $$('button', sec).forEach(b => { b.disabled = false; }); }
  };
  view.onclick = async e => {
    const sec = e.target.closest('[data-d]'), b = e.target.closest('button');
    if (!sec || !b) return;
    if ('go' in b.dataset) go(sec);
    if ('del' in b.dataset && await confirmer('Supprimer cette demande ?', 'Le fichier envoyé par l’artisan sera effacé.')) { await api('kadra/demandes/' + sec.dataset.d, 'DELETE'); route(); }
  };
  view.onchange = async e => { const f = e.target.files?.[0]; if (f && 'autre' in e.target.dataset) go(e.target.closest('[data-d]'), await fileToURL(f)); };
}

// ---------- Routeur ----------
// ---------- Visite guidée (1re connexion) ----------
// Un chantier d'exemple, du devis au paiement : l'artisan fait chaque geste lui-même, la bulle passe à la suite quand c'est fait.
// Le devis dicté pendant la visite porte data.exemple : sa facture ne prend jamais de numéro et Kadra n'en apprend rien (server.js).
// État par utilisateur : { e: étape (-1 = finie), devis, chantier, facture, avant: clients déjà là, vus: pages déjà expliquées }.
// ponytail: gardé sur l'appareil (localStorage) : sur un 2e appareil d'un compte encore vide, la visite repart ; passer dans users si ça gêne.
const cleVis = () => 'kadra_visite_' + ME?.user.id;
let VIS = null, visTimer = 0, visCle = '', visVu = '', visBusy = false, visDoc = { t: 0, id: 0, d: null };
const visLire = () => { try { return JSON.parse(localStorage.getItem(cleVis())); } catch { return null; } };
const visGarder = () => { try { localStorage.setItem(cleVis(), JSON.stringify(VIS)); } catch { /* sans stockage : la visite ne reprend pas au rechargement */ } };
const visiteEn = () => VIS?.e >= 0;
const ou = () => '#/' + location.hash.split('?')[0].replace(/^#?\/?/, '');
const sur = p => { const h = ou(); return h === p || (p !== '#/' && h.startsWith(p + '/')); };
const docIci = () => +(ou().match(/^#\/doc\/(\d+)/) || [])[1] || 0;
const visDocVu = async id => { // le document suivi, relu au plus toutes les 2 s
  if (id !== visDoc.id || Date.now() - visDoc.t > 2000) { const t = Date.now(); visDoc.t = t; visDoc = { t, id, d: await api('documents/' + id).catch(() => null) }; } // t posé avant l'appel : pas de 2e appel en attendant
  return visDoc.d;
};
const phraseExemple = () => `Devis pour Madame Exemple, 12 rue des Lilas à Lyon, e-mail ${ME.user.email}. Rénovation de la salle de bain : dépose de l’ancienne baignoire 350 euros, fourniture et pose d’un receveur de douche 450 euros, faïence murale 12 mètres carrés à 65 euros le mètre carré, nettoyage de fin de chantier 120 euros.`;
const pDevis = () => '#/doc/' + VIS.devis, pChantier = () => '#/chantier/' + VIS.chantier, pFacture = () => '#/doc/' + VIS.facture;
// page : où se passe l'étape (on y va tout seul) ; cible : ce que la bulle montre ; fini : le geste est fait → étape suivante ;
// ok : [bouton, action] (sans action : étape suivante) ; besoin : étape sautée s'il manque ce morceau de l'exemple ; centre : bulle au milieu, écran assombri.
const ETAPES = [
  { centre: true, titre: 'Bienvenue sur Kadra', texte: 'On va faire ensemble un chantier d’exemple, du devis jusqu’au paiement. Vous faites chaque geste vous-même, ça prend 5 minutes. À la fin, on efface l’exemple.', ok: ['C’est parti'], non: 'Plus tard' },
  { page: '#/parametres', cible: '#tab > :first-child', titre: 'Votre entreprise', texte: 'Votre nom, votre adresse et votre logo s’impriment sur chaque devis et chaque facture (le SIRET et l’IBAN juste en dessous). Remplissez ce que vous avez sous la main : c’est enregistré tout seul.', ok: ['C’est fait'] },
  { page: '#/nouveau', cible: '.micwrap', titre: 'Dictez le devis', texte: 'Appuyez sur le micro et décrivez les travaux comme à un collègue : le client, ce qu’il faut faire, les prix. Rappuyez quand c’est fini. Pas de micro sous la main ? Prenez une phrase d’exemple.',
    ok: ['Phrase d’exemple', () => { if ($('#txt')) $('#txt').value = phraseExemple(); }], fini: () => $('#txt')?.value.trim().length > 30 && $('#mic')?.getAttribute('aria-pressed') !== 'true' },
  { page: '#/nouveau', cible: '#go', titre: 'Kadra rédige', texte: 'Relisez le texte (il se corrige au clavier), puis appuyez sur « Rédiger le devis » : Kadra le met en forme, en français, avec les prix et la TVA. Comptez une quinzaine de secondes.',
    fini: () => { const id = docIci(); if (id) VIS.devis = id; return !!id; } },
  { page: pDevis, besoin: 'devis', cible: '#pv', titre: 'Votre devis', texte: 'Il se modifie comme sur papier : cliquez sur un prix, une quantité ou un texte et changez-le, les totaux suivent. Essayez !', ok: ['Suivant'], fini: () => $('#saved')?.textContent === 'Enregistré' },
  { page: pDevis, besoin: 'devis', cible: '.voice .mic', titre: 'Ou à la voix', texte: 'Ce micro modifie le devis quand vous parlez. Dites par exemple « ajoute 3 prises électriques à 45 euros ».', ok: ['Suivant'] },
  { page: pDevis, besoin: 'devis', cible: '#send', titre: 'Envoyez-le au client', texte: 'Appuyez sur « Envoyer ». Pour l’essai, l’e-mail part à votre propre adresse : vous recevez ce que reçoit le client, avec le PDF et le lien pour signer.',
    fini: async () => { const d = await visDocVu(VIS.devis); return !!d && d.statut !== 'brouillon'; } },
  { centre: true, besoin: 'devis', titre: 'Le client signe', texte: 'Le client ouvre le lien sur son téléphone, lit le devis et signe du doigt. Jouez le client : ouvrez sa page, signez tout en bas, puis revenez ici.',
    ok: ['Ouvrir la page du client', () => (visDoc.d?.token ? open('/p/' + visDoc.d.token, '_blank') : toast('Un instant…'))],
    fini: async () => { const d = await visDocVu(VIS.devis); if (d?.statut === 'accepte' && d.chantier_id) VIS.chantier = d.chantier_id; return !!VIS.chantier; } },
  { centre: true, besoin: 'chantier', titre: 'Signé ! Le chantier est créé', texte: 'Kadra a passé le devis en « accepté », créé le chantier tout seul et vous a prévenu par e-mail. Allons le voir.',
    ok: ['Voir le chantier', () => { location.hash = pChantier(); }], fini: () => sur(pChantier()) },
  { page: pChantier, besoin: 'chantier', cible: 'section.panel:has(.avbig)', titre: 'Le suivi du chantier', texte: 'Touchez 25 %, 50 %… pour dire où en sont les travaux. Plus bas : l’argent du chantier, vos achats et les photos.', ok: ['Suivant'] },
  { page: pChantier, besoin: 'chantier', cible: '[data-fac="acompte"]', titre: 'Demandez l’acompte', texte: 'Avant de commencer, on demande un acompte. Appuyez sur « Facture d’acompte » : Kadra la calcule d’après le devis.',
    fini: () => { const id = docIci(); if (id && id !== VIS.devis) VIS.facture = id; return !!VIS.facture; } },
  { page: pFacture, besoin: 'facture', cible: '#send', titre: 'La facture d’acompte', texte: 'D’habitude, « Émettre et envoyer » lui donne son numéro définitif et l’envoie au client ; ensuite, elle ne se modifie plus. Pour l’exemple, on passe directement au paiement.', ok: ['Suivant'] },
  { page: pFacture, besoin: 'facture', cible: 'section.panel:has(#pf)', titre: 'Le client a payé', texte: 'Il vous a fait un virement ? Enregistrez-le ici avec « Enregistrer le règlement » : le montant, la date et le mode sont déjà remplis.',
    fini: async () => (await visDocVu(VIS.facture))?.regle > 0 },
  { centre: true, titre: 'Les relances, c’est Kadra', texte: 'Un devis sans réponse, une facture pas payée à l’échéance : Kadra relance le client tout seul par e-mail, et vous tient au courant. C’est réglable dans Paramètres, « Automatismes ».', ok: ['Suivant'] },
  { page: '#/mails', titre: 'Vos e-mails', texte: 'Branchez votre boîte mail (Paramètres, « Automatismes ») : les e-mails de vos clients arrivent ici, rangés par client. Pour répondre, dites ce que vous voulez dire : Kadra écrit la réponse.', ok: ['Suivant'] },
  { page: '#/agenda', titre: 'Votre agenda', texte: 'Un client écrit « jeudi 10 h, ça vous va ? » : Kadra le repère dans l’e-mail et vous propose le rendez-vous. Vous n’avez qu’à confirmer.', ok: ['Suivant'] },
  { page: '#/', cible: '#voix, .tabbar .fab', titre: 'Parlez à Kadra', texte: 'Le plus simple : appuyez ici et parlez. « Mets-moi un rendez-vous jeudi à 9 h chez Madame Exemple », « Qui me doit de l’argent ? ». Essayez !', ok: ['Suivant'], fini: () => document.body.classList.contains('reflechit') },
  { page: '#/', centre: true, fin: true, titre: 'Vous savez tout', texte: 'L’accueil vous dit chaque jour ce qui compte : qui doit vous payer, ce qu’il reste à facturer, vos rendez-vous. Les autres pages s’expliquent la première fois que vous les ouvrez. On efface le chantier d’exemple ?',
    ok: ['Effacer l’exemple', () => visEffacer()], non: 'Le garder' },
];
const visPage = et => (typeof et.page === 'function' ? et.page() : et.page);
const cibleEl = sel => [...document.querySelectorAll(sel)].find(e => { const r = e.getBoundingClientRect(); return r.width && r.height; });

async function visiteDemarrer(force) {
  VIS = visLire();
  if (force) VIS = { e: 0, vus: VIS?.vus || [] };
  else if (!VIS) {
    if ((await api('documents').catch(() => [0])).length) return; // compte déjà utilisé : ni visite ni bulles d'aide
    VIS = { e: 0, vus: [] };
  }
  if (VIS.e < 0) return;
  VIS.avant ??= (await api('clients').catch(() => [])).map(c => c.id); // ses vrais clients ne seront jamais effacés avec l'exemple
  visGarder();
  await introFinie;
  clearInterval(visTimer); visTimer = setInterval(visTick, 400); visCle = '';
  visAller(); visPlacer();
}
function visAller() { // à l'arrivée sur une étape : on ouvre sa page
  const p = visPage(ETAPES[VIS.e]);
  if (p) { const r = p.split('/')[1]; if (!VIS.vus.includes(r)) VIS.vus.push(r); if (!sur(p)) location.hash = p; }
  visGarder();
}
function visSuite() {
  do VIS.e++; while (ETAPES[VIS.e]?.besoin && !VIS[ETAPES[VIS.e].besoin]);
  if (!ETAPES[VIS.e]) return visFin();
  visAller(); visPlacer();
}
function visFin(msg) {
  VIS.e = -1; visGarder(); clearInterval(visTimer);
  $('#vt')?.remove(); $('#vt-spot')?.remove();
  if (msg) toast(msg);
}
async function visEffacer() { // seulement ce qui vient de la visite : devis et factures marqués « exemple », son chantier, son client s'il est nouveau
  const d = VIS.devis && await api('documents/' + VIS.devis).catch(() => null);
  if (d?.data.exemple) {
    for (const f of await api('documents?parent_id=' + d.id)) if (f.data.exemple && !f.numero) await api('documents/' + f.id, 'DELETE');
    await api('documents/' + d.id, 'DELETE');
    if (d.chantier_id) await api('chantiers/' + d.chantier_id, 'DELETE').catch(() => {});
    if (d.client_id && !VIS.avant.includes(d.client_id) && !(await api('documents?client_id=' + d.client_id)).length) await api('clients/' + d.client_id, 'DELETE');
  }
  visFin('Exemple effacé. À vous de jouer !');
  if (ou() === '#/') route(); else location.hash = '#/';
}
async function visAction(a) {
  const et = ETAPES[VIS.e];
  if (a === 'ok') { if (et.ok[1]) await et.ok[1](); else visSuite(); }
  else if (a === 'non') visFin(et.fin ? 'L’exemple reste dans vos devis.' : 'Vous pourrez lancer la visite plus tard : Paramètres, Mon compte.');
  else if (a === 'passer') visSuite();
  else if (a === 'aller') location.hash = visPage(et);
  else if (a === 'quitter') { if (VIS.devis && !et.fin) { VIS.e = ETAPES.length - 1; visAller(); visPlacer(); } else visFin('Vous pourrez revoir la visite : Paramètres, Mon compte.'); }
}
async function visTick() {
  if (!visiteEn() || !ME) { clearInterval(visTimer); $('#vt')?.remove(); $('#vt-spot')?.remove(); return; } // déconnecté : la visite reprendra à la connexion
  const et = ETAPES[VIS.e];
  if (et.fini && !visBusy) {
    visBusy = true;
    const ok = await Promise.resolve().then(et.fini).catch(() => false);
    visBusy = false;
    if (ok && ETAPES[VIS.e] === et) return visSuite();
  }
  visPlacer();
}
function visPlacer() {
  if (!visiteEn() || !ME) return;
  const et = ETAPES[VIS.e], p = visPage(et), ici = !p || sur(p);
  let b = $('#vt'), spot = $('#vt-spot');
  if (!b) {
    spot = document.createElement('div'); spot.id = 'vt-spot';
    b = document.createElement('div'); b.id = 'vt'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-label', 'Visite guidée');
    b.onclick = e => { const a = e.target.closest('[data-v]'); if (a) visAction(a.dataset.v).catch(err => toast(err.message, 'crit')); };
    spot.style.transition = b.style.transition = 'none'; // 1re pose sans glisser depuis le coin
    document.body.append(spot, b);
    requestAnimationFrame(() => requestAnimationFrame(() => { spot.style.transition = b.style.transition = ''; }));
  }
  const k = VIS.e + (ici ? 'i' : 'a'), n = ETAPES.length - 1;
  if (k !== visCle) {
    visCle = k;
    b.innerHTML = `<div class="vt-h"><span>${VIS.e ? `Étape ${VIS.e} sur ${n}` : 'Visite guidée'}</span>${et.non ? '' : `<button data-v="quitter" aria-label="Quitter la visite" title="Quitter la visite">${icon('x', 16)}</button>`}</div>
${VIS.e ? `<i class="vt-p"><b style="width:${(100 * VIS.e) / n}%"></b></i>` : ''}<h3>${et.titre}</h3><p>${ici ? et.texte : 'Cette étape se passe sur une autre page.'}</p>
<div class="vt-a">${!ici ? '<button class="btn primary" data-v="aller">Revenir à l’étape</button>'
    : `${et.ok ? `<button class="btn primary" data-v="ok">${et.ok[0]}</button>` : '<span class="vt-att">À vous de jouer</span>'}${et.non ? `<button class="btn ghost" data-v="non">${et.non}</button>` : '<button class="vt-passer" data-v="passer">Passer</button>'}`}</div>`;
    b.classList.toggle('centre', !!et.centre);
  }
  const cache = !!document.querySelector('dialog[open]') || document.body.classList.contains('intro'); // une fenêtre ouverte a ses propres explications
  b.hidden = spot.hidden = cache;
  if (cache) return;
  const t = ici && et.cible && cibleEl(et.cible);
  if (t && visVu !== k) { visVu = k; const r0 = t.getBoundingClientRect(); if ((r0.top < 0 || r0.bottom > innerHeight) && r0.height < innerHeight * .6) t.scrollIntoView({ block: 'center', behavior: calme() ? 'auto' : 'smooth' }); }
  let r = t && t.getBoundingClientRect();
  if (r) { r = { top: Math.max(r.top, 6), left: Math.max(r.left, 6), bottom: Math.min(r.bottom, innerHeight - 6), right: Math.min(r.right, innerWidth - 6) }; if (r.bottom - r.top < 8) r = null; }
  const P = 6, W = innerWidth, H = innerHeight, mob = W <= 900;
  spot.hidden = !(ici && (r || et.centre));
  Object.assign(spot.style, r ? { top: r.top - P + 'px', left: r.left - P + 'px', width: r.right - r.left + 2 * P + 'px', height: r.bottom - r.top + 2 * P + 'px' } : { top: H / 2 + 'px', left: W / 2 + 'px', width: 0, height: 0 });
  spot.classList.toggle('vide', !r);
  const bw = b.offsetWidth, bh = b.offsetHeight, G = 14;
  let x, y;
  if (!ici || (et.centre && !r)) { x = (W - bw) / 2; y = ici ? (H - bh) / 2 : H - bh - (mob ? 90 : 24); }
  else if (mob) { x = (W - bw) / 2; y = r && (r.top + r.bottom) / 2 > H / 2 ? 12 : H - bh - 90; }
  else if (!r) { x = W - bw - 24; y = H - bh - 100; }
  else if (r.bottom + G + bh < H - 8) { x = r.left; y = r.bottom + G; }
  else if (r.top - G - bh > 8) { x = r.left; y = r.top - G - bh; }
  else if (r.right + G + bw < W - 8) { x = r.right + G; y = r.top; }
  else if (r.left - G - bw > 8) { x = r.left - G - bw; y = r.top; }
  else { x = W - bw - 24; y = H - bh - 24; }
  b.style.transform = `translate(${Math.round(Math.min(Math.max(x, 12), W - bw - 12))}px,${Math.round(Math.min(Math.max(y, 12), H - bh - 12))}px)`;
}
addEventListener('scroll', () => visiteEn() && visPlacer(), { passive: true, capture: true });
addEventListener('resize', () => visiteEn() && visPlacer());

// Bulle d'aide la première fois qu'on ouvre une page (comptes passés par la visite) : à quoi elle sert, en deux phrases.
// ---------- Importer ses anciens devis et factures (changement de logiciel, rien à retaper) ----------
// Kadra lit chaque PDF ou photo, retrouve les clients (et leur téléphone dans les e-mails) ; l'artisan vérifie, puis tout entre d'un coup.
const choixImport = {}, clientsNon = new Set(); // gardés pendant la lecture (la page se redessine toutes les 4 s)
const TYPE_IMP = { devis: 'Devis', facture: 'Facture', acompte: 'Facture d’acompte', avoir: 'Avoir' };
const MIME_IMP = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const extF = f => f.name.split('.').pop().toLowerCase();
async function pageImport() {
  head('Importer mes données', 'Vos anciens devis et factures dans Kadra, sans rien retaper.');
  view.innerHTML = `<div class="stack">
<label class="drop" id="drop">${icon('upload', 28)}<div style="flex:1;min-width:220px"><b>Déposez vos anciens devis et factures</b><br>
<span class="ink2">PDF, Word, Excel ou photos, autant que vous voulez. Kadra lit chaque document : le client, les lignes, les montants. Rien n’entre dans Kadra avant que vous ayez vérifié.</span><br><span id="st" class="muted" aria-live="polite"></span></div>
<span class="btn primary">Choisir des fichiers</span><input type="file" id="file" class="sr" multiple accept="application/pdf,image/*,.docx,.xlsx"></label>
<div style="margin-top:-6px"><label class="btn ghost">${icon('layers', 16)}Choisir tout un dossier<input type="file" id="dir" class="sr" webkitdirectory multiple></label></div>
<div id="imp"></div></div>`;
  const v = view;
  let dernier = '', timer;
  const tick = async () => {
    clearTimeout(timer);
    if (v !== view) return; // page quittée
    const r = await api('imports').catch(e => (toast(e.message, 'crit'), null));
    if (!r || v !== view) return;
    if (JSON.stringify(r) !== dernier) { dernier = JSON.stringify(r); dessiner(r); }
    if (r.n.attente || r.n.lecture || r.lecture || r.boite) timer = setTimeout(tick, 4000);
  };
  const envoyer = async files => {
    const vieux = [...files].filter(f => ['doc', 'xls'].includes(extF(f)));
    if (vieux.length) toast(`${plural(vieux.length, 'ancien fichier')} Word ou Excel (.doc, .xls) : ouvrez-le${vieux.length > 1 ? 's' : ''} et enregistrez en .docx, .xlsx ou PDF.`, 'crit');
    const ok = [...files].filter(f => MIME_IMP[extF(f)] || f.type.startsWith('image/'));
    if (!ok.length) return vieux.length || toast('Choisissez des PDF, des fichiers Word ou Excel, ou des photos de vos devis et factures.', 'crit');
    let i = 0, deja = 0;
    for (const f of ok) {
      $('#st').textContent = `Envoi ${++i} sur ${ok.length}…`;
      try {
        if (f.size > 15e6) throw new Error('trop lourd (15 Mo maximum)');
        const fichier = MIME_IMP[extF(f)] ? (await fileToURL(f)).replace(/^data:[^;]*;/, `data:${MIME_IMP[extF(f)]};`) : await imageURL(f, 2000); // type sûr (Windows le laisse parfois vide)
        deja += !(await api('imports', 'POST', { nom: f.name, fichier })).ajoute;
      } catch (e) { toast(`${f.name} : ${e.message}`, 'crit'); }
    }
    $('#st').textContent = deja ? `${plural(deja, 'fichier')} déjà envoyé${deja > 1 ? 's' : ''} avant : pas repris.` : '';
    tick();
  };
  $('#file').onchange = e => envoyer(e.target.files);
  $('#dir').onchange = e => envoyer(e.target.files);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); envoyer(e.dataTransfer.files); };

  function dessiner(r) {
    const total = (r.n.attente || 0) + (r.n.lecture || 0) + (r.n.lu || 0) + (r.n.erreur || 0), lus = (r.n.lu || 0) + (r.n.erreur || 0);
    const enCours = r.n.attente || r.n.lecture;
    const devis = r.docs.filter(d => d.type === 'devis'), facs = r.docs.filter(d => d.type !== 'devis');
    const gardes = r.docs.filter(d => choixImport[d.id] !== 'ignore'), cls = r.clients.filter(c => !clientsNon.has(c.cle));
    const opts = d => (d.type === 'devis' ? [['envoye', 'En attente de réponse'], ['accepte', 'Signé'], ['refuse', 'Sans suite']] : d.type === 'avoir' ? [] : [['payee', 'Payée'], ['a_payer', 'Pas encore payée']]);
    const ligne = d => {
      const c = choixImport[d.id] || d.defaut, ecart = d.ecart || Math.abs(d.ttc - d.ttc_calc) > 0.05, ign = c === 'ignore';
      return `<tr class="${ign ? 'off' : ''}"><td><span class="num">${h(d.numero || 'Sans numéro')}</span><small class="muted" style="display:block">${TYPE_IMP[d.type]}${d.date ? ' · ' + dfr(d.date) : ''}</small></td>
<td><b>${h(d.client || '—')}</b><small class="muted" style="display:block">${h(d.objet || '')}</small></td>
<td class="n amt">${eur(d.ttc_calc)}${ecart ? `<br><span title="Total écrit sur le document : ${eur(d.ttc)}. Total des lignes lues par Kadra : ${eur(d.ttc_calc)}.">${P('Total à vérifier', 'warn', 'alert')}</span>` : ''}</td>
<td>${ign ? '<i class="muted">Pas importé</i>' : opts(d).length ? `<select data-ch="${d.id}" aria-label="État de ${h(d.numero || 'ce document')}">${opts(d).map(([k, l]) => `<option value="${k}" ${k === c ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}</td>
<td class="n" style="white-space:nowrap"><a class="btn ghost icon" href="/api/imports/${d.id}/fichier" target="_blank" rel="noopener" title="Voir l’original" aria-label="Voir l’original">${icon('file', 16)}</a>${ecart ? `<button class="btn ghost icon" data-relire="${d.id}" title="Faire relire par Kadra" aria-label="Faire relire par Kadra">${icon('undo', 16)}</button>` : ''}<button class="btn ghost icon" data-ign="${d.id}" title="${ign ? 'Importer quand même' : 'Ne pas importer'}" aria-label="${ign ? 'Importer quand même' : 'Ne pas importer'}">${icon(ign ? 'plus' : 'x', 16)}</button></td></tr>`;
    };
    const table = (titre, l, aide) => (l.length ? `<section class="panel"><div class="ph"><h2>${titre} (${l.length})</h2></div><div class="pb"><p class="ink2" style="margin-bottom:10px">${aide}</p>
<table class="list imp"><thead><tr><th>Numéro</th><th>Client</th><th class="n">Total TTC</th><th>État</th><th></th></tr></thead><tbody>${l.map(ligne).join('')}</tbody></table></div></section>` : '');
    $('#imp').innerHTML = `<div class="stack">
${r.arret ? `<div class="ask">${icon('alert')}<div>${h(r.arret)}<br><button class="btn" id="reprendre" style="margin-top:8px">Reprendre</button></div></div>` : ''}
<section class="panel"><div class="pb" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${icon('mail', 22)}<div style="flex:1;min-width:220px">
${r.boite ? '<b>Kadra cherche dans vos e-mails envoyés…</b><br><span class="ink2">Les devis et factures en PDF que vous avez envoyés à vos clients ces 2 dernières années.</span>'
  : r.imap ? '<b>Vos devis sont aussi dans vos e-mails</b><br><span class="ink2">Kadra retrouve les devis et factures en PDF que vous avez envoyés à vos clients ces 2 dernières années, et leurs coordonnées.</span>'
  : '<b>Branchez votre boîte mail</b><br><span class="ink2">Kadra y retrouvera aussi les devis et factures que vous avez envoyés, et le téléphone de vos clients dans leurs e-mails.</span>'}</div>
${r.boite ? '' : r.imap ? `<button class="btn" id="boite">${icon('search', 16)}Chercher dans mes e-mails</button>` : `<a class="btn" href="#/parametres/relances">Brancher ma boîte mail</a>`}</div></section>
${enCours ? `<section class="panel"><div class="pb stack" style="gap:10px"><b>Kadra lit vos documents : ${lus} sur ${total}…</b><div class="prog"><i style="width:${total ? Math.round(100 * lus / total) : 0}%"></i></div>
<small class="muted">Environ 20 secondes par document. Vous pouvez quitter la page : la lecture continue. Vous pouvez déjà vérifier ceux qui sont lus.</small></div></section>` : ''}
${r.clients.length ? `<section class="panel"><div class="ph"><h2>Vos clients (${r.clients.length})</h2></div><div class="pb"><p class="ink2" style="margin-bottom:10px">Kadra les a retrouvés dans vos documents${r.imap ? ' et vos e-mails' : ''}. C’est bien eux ? Décochez ceux qui ne sont pas bons. Ce qui manque se complète plus tard sur leur fiche.</p>
<table class="list imp"><tbody>${r.clients.map(c => `<tr class="${clientsNon.has(c.cle) ? 'off' : ''}"><td style="width:34px"><input type="checkbox" data-cl="${h(c.cle)}" ${clientsNon.has(c.cle) ? '' : 'checked'} aria-label="Garder ${h(c.nom)}"></td>
<td><b>${h(c.nom)}</b><small class="muted" style="display:block">${h([c.adresse.replace(/\n/g, ', '), c.email, c.tel].filter(Boolean).join(' · ') || 'Pas encore de coordonnées')}</small>${c.mail ? `<small class="trouve">${icon('mail', 13)}${h(c.mail[0].toUpperCase() + c.mail.slice(1))}</small>` : ''}</td>
<td class="hide-m muted">${plural(c.docs, 'document')}</td><td>${c.existe ? P('Déjà dans Kadra', 'good', 'check') : P('Nouveau', 'plan', 'plus')}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
${table('Devis', devis, 'Signé, en attente ou sans suite : Kadra a deviné d’après le document (signature, facture qui a suivi, date). Corrigez si besoin.')}
${table('Factures', facs, `Elles gardent leur numéro d’origine. Vérifiez surtout lesquelles sont payées : celles « pas encore payées » iront dans vos impayés et Kadra les relancera comme les autres (pas avant ${S.relance_facture_jours} jours).`)}
${r.erreurs.length ? `<section class="panel"><div class="ph"><h2>Pas réussi à lire (${r.erreurs.length})</h2></div><div class="pb"><table class="list imp"><tbody>${r.erreurs.map(e => `<tr><td>${h(e.nom)}<small class="muted" style="display:block">${h(e.erreur)}</small></td>
<td class="n" style="white-space:nowrap"><a class="btn ghost icon" href="/api/imports/${e.id}/fichier" target="_blank" rel="noopener" aria-label="Voir le fichier">${icon('file', 16)}</a><button class="btn" data-relire="${e.id}">Réessayer</button><button class="btn ghost" data-oubli="${e.id}">Laisser</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}
${r.autres.length || r.doublons ? `<p class="muted">${[r.autres.length && `${plural(r.autres.length, 'fichier')} sans devis ni facture (plan, facture d’un fournisseur…) : laissé${r.autres.length > 1 ? 's' : ''} de côté.`, r.doublons && `${plural(r.doublons, 'document')} en double ou déjà dans Kadra : pas repris.`].filter(Boolean).join(' ')}</p>` : ''}
${r.n.importe ? `<p class="muted">${icon('check', 14)} ${plural(r.n.importe, 'document')} déjà mis dans Kadra : <a href="#/devis">vos devis</a>, <a href="#/factures">vos factures</a>, <a href="#/clients">vos clients</a>.</p>` : ''}
${gardes.length ? `<div class="imp-go"><button class="btn primary" id="go">${icon('check', 16)}Mettre dans Kadra : ${[devis.filter(d => choixImport[d.id] !== 'ignore').length && plural(devis.filter(d => choixImport[d.id] !== 'ignore').length, 'devis', 'devis'), facs.filter(d => choixImport[d.id] !== 'ignore').length && plural(facs.filter(d => choixImport[d.id] !== 'ignore').length, 'facture'), cls.length && plural(cls.length, 'client')].filter(Boolean).join(', ')}</button></div>` : ''}
${!total && !r.n.importe ? `<div class="empty">${icon('file', 28)}<p>Déposez vos fichiers ci-dessus${r.imap ? ' ou cherchez dans vos e-mails' : ''} : Kadra vous montre ce qu’il a compris avant de mettre quoi que ce soit dans votre compte.</p></div>` : ''}
</div>`;
  }
  $('#imp').addEventListener('change', e => {
    const s = e.target.closest('[data-ch]'), c = e.target.closest('[data-cl]');
    if (s) choixImport[s.dataset.ch] = s.value;
    if (c) { c.checked ? clientsNon.delete(c.dataset.cl) : clientsNon.add(c.dataset.cl); c.closest('tr').classList.toggle('off', !c.checked); }
    dernier = ''; tick(); // le bouton du bas recompte
  });
  $('#imp').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const { ign, relire, oubli } = b.dataset;
    if (ign) { choixImport[ign] = choixImport[ign] === 'ignore' ? undefined : 'ignore'; dernier = ''; return tick(); }
    if (relire || oubli) return busy(b, async () => { await api('imports/' + (relire || oubli), 'PUT', { etat: relire ? 'attente' : 'ignore' }); tick(); });
    if (b.id === 'reprendre') return busy(b, async () => { await api('imports/lire', 'POST'); tick(); });
    if (b.id === 'boite') return busy(b, async () => { await api('imports/boite', 'POST'); tick(); });
    if (b.id === 'go') return busy(b, async () => {
      const r = await api('imports/valider', 'POST', { choix: choixImport, refuses: [...clientsNon] });
      toast(`Dans Kadra : ${[r.devis && plural(r.devis, 'devis', 'devis'), r.factures && plural(r.factures, 'facture'), r.clients && plural(r.clients, 'nouveau client', 'nouveaux clients')].filter(Boolean).join(', ') || 'rien de nouveau'}`);
      if (r.sautes.length) toast(`Déjà dans Kadra, pas repris : ${r.sautes.join(', ')}`, 'crit');
      dernier = ''; tick();
    });
  });
  tick();
}

const AIDES = {
  devis: ['Vos devis', 'Tous vos devis, du plus récent au plus ancien, avec où ils en sont : brouillon, envoyé, signé, refusé. Un devis sans réponse est relancé tout seul.'],
  factures: ['Vos factures', 'Une facture prend son numéro quand vous l’émettez, puis ne se modifie plus (c’est la loi) : pour corriger, on fait un avoir. « Pour le comptable » prépare ses fichiers en un clic.'],
  depenses: ['Vos dépenses', 'Prenez en photo un ticket ou une facture de fournisseur : Kadra le lit et remplit tout. Rattachez l’achat à un chantier pour savoir ce qu’il vous laisse.'],
  notes: ['Vos notes', 'Sur le chantier, dictez ce que vous voyez : mesures, travaux, matériaux. Plus tard, « Faire le devis » transforme vos notes en devis.'],
  chantiers: ['Vos chantiers', 'Un chantier se crée tout seul quand le client signe le devis. Ici : ce qui est en cours, ce qui arrive et ce qui a du retard.'],
  clients: ['Vos clients', 'Ils se créent tout seuls avec vos devis. Sur une fiche : l’appeler, l’itinéraire, ses documents et tous vos e-mails avec lui.'],
  catalogue: ['Votre catalogue de prix', 'Vos prestations et leurs prix : Kadra s’en sert quand vous dictez un devis sans dire le prix. Il vous propose aussi les prix trouvés dans vos devis.'],
  analyse: ['Analyse', 'Qui vous paie bien ou mal, ce que vous rapporte une journée de chantier, quels devis se signent le mieux, et les conseils de Kadra.'],
  modeles: ['Devis types', 'Un devis que vous refaites souvent (salle de bain, peinture…) : enregistrez-le comme devis type depuis son menu, puis dictez seulement ce qui change.'],
  templates: ['Mise en page', 'L’allure de vos devis et factures : choisissez un modèle, retouchez-le comme dans Word, ou envoyez-nous le vôtre.'],
  mails: ['Vos e-mails', 'Les e-mails de vos clients, rangés par client, une fois votre boîte branchée (Paramètres, « Automatismes »). Kadra vous aide à répondre.'],
  agenda: ['Votre agenda', 'Vos rendez-vous et vos chantiers. Kadra trouve les rendez-vous dans vos e-mails : vous n’avez qu’à confirmer.'],
};
function aidePage(r) {
  if (!VIS || visiteEn() || !AIDES[r] || VIS.vus.includes(r)) return;
  const a = document.createElement('div'); a.className = 'aide';
  a.innerHTML = `<span class="aide-i">${icon('sparkle', 18)}</span><div><b>${AIDES[r][0]}</b><p>${AIDES[r][1]}</p></div><button class="btn" data-ok>Compris</button>`;
  a.querySelector('[data-ok]').onclick = () => { VIS.vus.push(r); visGarder(); a.remove(); };
  view.prepend(a);
}

const ROUTES = {
  '': dashboard, analyse, nouveau, doc: editDoc, import: pageImport, client, chantiers, chantier, templates, template: editTemplate, parametres, kadra: kadraAdmin, catalogue, agenda, mails, depenses, notes,
  devis: () => liste('devis'), factures: () => liste('facture', location.hash.includes('?retard') ? 'retard' : 'tous'), modeles: () => liste('modele'),
  clients: () => clients(location.hash.split('?')[1]),
};
async function route() {
  if (!ME || !$('#side')) return; // coque pas encore dessinée (boot en cours)
  const [r = '', id] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  $$('.side a[data-r]').forEach(a => a.classList.toggle('on', a.dataset.r === r || (r === 'doc' && a.dataset.r === 'devis') || (r === 'chantier' && a.dataset.r === 'chantiers') || (r === 'client' && a.dataset.r === 'clients')));
  $('#side').classList.remove('open');
  docOuvert = null; // la fiche document le remet si elle s'affiche
  const fresh = $('#view').cloneNode(false); $('#view').replaceWith(fresh); view = fresh; // repart sans les écouteurs de la page précédente
  view.innerHTML = '<p class="muted">Chargement…</p>';
  if (r) badges(); // l'accueil les met à jour avec ses propres chiffres
  try { await (ROUTES[r] || dashboard)(id); } catch (e) { if (ME) view.innerHTML = `<div class="empty">${icon('alert', 28)}<p>${h(e.message)}</p><a class="btn" href="#/">Retour au tableau de bord</a></div>`; }
  view.querySelectorAll('.kpi .v, .chcard .pc strong').forEach(el => compter(el)); // les chiffres défilent jusqu'à leur valeur
  aidePage(r);
  scrollTo(0, 0);
}
addEventListener('hashchange', route);

async function boot() {
  langueAppli();
  if (location.hash.startsWith('#/reset/')) return login('reset'); // lien « mot de passe oublié » reçu par e-mail
  try { ME = await api('me'); } catch { return login(); }
  S = await api('settings');
  teinte(); ouverture();
  VIS = visLire(); // avant la 1re page : son aide peut s'afficher
  shell(); route(); envoyerAttente();
  if (navigator.onLine) setTimeout(() => ['dashboard', 'documents', 'clients', 'chantiers', 'notes', 'rdv', 'catalog', 'depenses', 'templates'].forEach(k => api(k).catch(() => {})), 4000);
  if (!ME.user.langue) await choisirLangue(true);
  visiteDemarrer();
}
boot();
