import { totaux, eur, retenue } from './public/calc.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nl2br = s => esc(s).replace(/\n/g, '<br>');
const dateFr = d => (d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR') : '');

// Mini-moteur : {{chemin}} échappé, {{{chemin}}} brut.
export function fill(tpl, ctx) {
  return tpl.replace(/\{\{(\{?)\s*([\w.]+)\s*\}?\}\}/g, (_, raw, p) => {
    const v = p.split('.').reduce((o, k) => o?.[k], ctx) ?? '';
    return raw ? String(v) : esc(v);
  });
}

export const PLACEHOLDERS = {
  'doc.titre': 'DEVIS / FACTURE / FACTURE D’ACOMPTE', 'doc.numero': 'Numéro', 'doc.date': 'Date', 'doc.echeance': 'Validité ou échéance',
  'doc.objet': 'Objet', 'doc.adresse_chantier': 'Adresse du chantier', 'doc.notes': 'Notes',
  'doc.total_ht': 'Total HT', 'doc.total_ttc': 'Total TTC',
  'entreprise.nom': 'Raison sociale', 'entreprise.couleur': 'Couleur principale (#hex)', 'entreprise.adresse': 'Adresse', 'entreprise.tel': 'Téléphone',
  'entreprise.email': 'E-mail', 'entreprise.site': 'Site web', 'entreprise.siret': 'SIRET', 'entreprise.rcs': 'RCS', 'entreprise.tva_intra': 'N° TVA',
  'entreprise.iban': 'IBAN', 'entreprise.bic': 'BIC', 'entreprise.assurance': 'Assurance décennale',
  'client.nom': 'Nom du client', 'client.adresse': 'Adresse du client', 'client.tel': 'Téléphone du client', 'client.email': 'E-mail du client',
  '{bloc_entreprise}': 'Coordonnées entreprise (HTML)', '{bloc_client}': 'Coordonnées client (HTML)', '{logo}': 'Logo (HTML)',
  '{lignes}': 'Tableau des lignes (HTML)', '{totaux}': 'Tableau des totaux (HTML)', '{mentions}': 'Mentions légales (HTML)',
  '{signature}': 'Bloc signature / paiement (HTML)', '{css_base}': 'CSS de base des tableaux',
};

const CSS_BASE = `
@page{size:A4;margin:12mm}*{box-sizing:border-box}body{margin:0;font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1b;background:#fff}
.page{max-width:820px;margin:0 auto;padding:24px}h1{margin:0;font-size:26px;letter-spacing:.04em}
table.lignes{width:100%;border-collapse:collapse;margin:18px 0}table.lignes th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:7px 6px;border-bottom:2px solid #1d1d1b}
table.lignes td{padding:7px 6px;border-bottom:1px solid #e3e2dc;vertical-align:top}.n{text-align:right;white-space:nowrap}
tr.section td{font-weight:700;padding-top:14px;border-bottom:1px solid #1d1d1b}tr.st td{font-style:italic;color:#555;text-align:right}
.desc{color:#5b5a55;font-size:11px;white-space:pre-line}table.totaux{margin-left:auto;border-collapse:collapse;min-width:280px}
table.totaux td{padding:4px 8px}table.totaux tr.ttc td{font-weight:700;font-size:14px;border-top:2px solid #1d1d1b}
.mentions{font-size:10px;color:#5b5a55;margin-top:22px}.sign{display:flex;gap:24px;margin-top:22px}.sign>div{flex:1;border:1px solid #c9c8c0;min-height:110px;padding:8px;font-size:11px}
.sign img{max-height:80px;display:block}.logo{max-height:70px;max-width:220px;display:block;margin-bottom:8px}
@media print{.page{padding:0}.noprint{display:none!important}}`;

export const BUILTINS = [
  { nom: 'Classique', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title><style>{{{css_base}}}
.top{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid {{entreprise.couleur}};padding-bottom:16px}
h1{color:{{entreprise.couleur}};text-align:right}.meta{text-align:right}.cli{margin:18px 0 0 auto;width:48%;border:1px solid #d8d7d0;padding:10px 12px}
.obj{margin-top:16px}</style></head><body><div class="page">
<div class="top"><div>{{{logo}}}{{{bloc_entreprise}}}</div><div><h1>{{doc.titre}}</h1><p class="meta">N° {{doc.numero}}<br>Date : {{doc.date}}<br>{{doc.echeance}}</p></div></div>
<div class="cli">{{{bloc_client}}}</div>
<div class="obj"><b>Objet :</b> {{doc.objet}}<br><b>Adresse du chantier :</b> {{doc.adresse_chantier}}</div>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
  { nom: 'Moderne', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title><style>{{{css_base}}}
.band{background:{{entreprise.couleur}};color:#fff;padding:22px 24px;display:flex;justify-content:space-between;align-items:flex-end;border-radius:10px}
.band h1{font-size:30px}.band p{margin:0;text-align:right}.cols{display:flex;gap:24px;margin-top:18px}.cols>div{flex:1;background:#f4f4f1;border-radius:8px;padding:12px}
.cols small{display:block;text-transform:uppercase;letter-spacing:.06em;color:{{entreprise.couleur}};font-weight:700;margin-bottom:4px}
table.lignes th{border-bottom-color:{{entreprise.couleur}};color:{{entreprise.couleur}};}table.totaux tr.ttc td{color:{{entreprise.couleur}};border-top-color:{{entreprise.couleur}};}
</style></head><body><div class="page">{{{logo}}}
<div class="band"><h1>{{doc.titre}}</h1><p>N° {{doc.numero}}<br>{{doc.date}}<br>{{doc.echeance}}</p></div>
<div class="cols"><div><small>Émetteur</small>{{{bloc_entreprise}}}</div><div><small>Client</small>{{{bloc_client}}}</div></div>
<p><b>{{doc.objet}}</b><br>{{doc.adresse_chantier}}</p>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
  { nom: 'Épuré', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title><style>{{{css_base}}}
body{font-family:Georgia,"Times New Roman",serif}h1{font-weight:400;font-size:34px}.row{display:flex;justify-content:space-between;gap:24px;margin-top:22px}
table.lignes th{border-bottom:1px solid #1d1d1b;font-weight:400}hr{border:0;border-top:1px solid {{entreprise.couleur}};margin:18px 0}</style></head><body><div class="page">
<div class="row"><div>{{{logo}}}<h1>{{doc.titre}}</h1><p>N° {{doc.numero}} · {{doc.date}}<br>{{doc.echeance}}</p></div><div>{{{bloc_entreprise}}}</div></div><hr>
<div class="row"><div><b>Pour</b><br>{{{bloc_client}}}</div><div><b>Objet</b><br>{{doc.objet}}<br>{{doc.adresse_chantier}}</div></div>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
  // Disposition la plus répandue chez les artisans (logiciels BTP) : entreprise en haut à gauche, cadre du numéro à droite,
  // client à droite (fenêtre d'enveloppe), tableau quadrillé à en-tête gris, totaux encadrés, « Bon pour accord », pied de page légal.
  { nom: 'Bâtiment', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title>
<meta name="kadra-colonnes" content="num=N°;designation=Désignation;qte=Qté;unite=U;pu=PU HT;tva=TVA;total=Total HT;soustotaux"><style>{{{css_base}}}
body{font-family:Arial,Helvetica,sans-serif;font-size:11.5px}.hd{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}
.ref{border:1.5px solid {{entreprise.couleur}};min-width:240px}.ref h1{background:{{entreprise.couleur}};color:#fff;font-size:20px;padding:8px 12px;letter-spacing:.06em}
.ref table{width:100%;border-collapse:collapse}.ref td{padding:4px 12px}.ref td:first-child{color:#666;width:45%}
.cli{margin:22px 0 0 auto;width:46%;border:1px solid #bbb;border-radius:4px;padding:10px 14px;min-height:92px}.cli small{display:block;color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.obj{margin-top:18px;padding:8px 12px;background:#f3f3f3;border-left:3px solid {{entreprise.couleur}};}
table.lignes{border:1px solid #bbb}table.lignes th{background:#ececec;border:1px solid #bbb;color:#222;padding:6px}table.lignes td{border-left:1px solid #ddd;border-right:1px solid #ddd;border-bottom:1px solid #e6e6e6;padding:5px 6px}
tr.section td{background:#f7f7f7;border-bottom:1px solid #bbb;text-transform:uppercase;font-size:11px}
table.totaux{border:1px solid #bbb}table.totaux td{border-bottom:1px solid #e6e6e6;padding:5px 10px}table.totaux tr.ttc td{background:{{entreprise.couleur}};color:#fff;border-top:0}
.sign>div{border-color:#bbb;border-radius:4px}.mentions{border-top:1px solid #ccc;padding-top:8px;text-align:center}</style></head><body><div class="page">
<div class="hd"><div>{{{logo}}}{{{bloc_entreprise}}}</div><div class="ref"><h1>{{doc.titre}}</h1><table><tr><td>Numéro</td><td><b>{{doc.numero}}</b></td></tr><tr><td>Date</td><td>{{doc.date}}</td></tr><tr><td colspan="2">{{doc.echeance}}</td></tr></table></div></div>
<div class="cli"><small>Client</small>{{{bloc_client}}}</div>
<div class="obj"><b>Objet :</b> {{doc.objet}}<br><b>Lieu des travaux :</b> {{doc.adresse_chantier}}</div>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
  // En-tête de couleur pleine largeur, bloc d'infos en 3 cases, tableau à en-tête de couleur et lignes alternées.
  { nom: 'Entreprise', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title>
<meta name="kadra-colonnes" content="designation=Description des travaux;qte=Quantité;unite=Unité;pu=Prix unitaire HT;total=Montant HT"><style>{{{css_base}}}
.hd{display:flex;justify-content:space-between;align-items:center;gap:24px;padding-bottom:14px}.hd .logo{margin:0}.hd .ent{text-align:right;font-size:11px;color:#444}
.bar{background:{{entreprise.couleur}};color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:baseline;border-radius:4px}.bar h1{font-size:22px}
.info{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #ddd;border-top:0}.info>div{padding:8px 12px}.info>div+div{border-left:1px solid #ddd}
.info small,.dest small{display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:{{entreprise.couleur}};font-weight:700;margin-bottom:2px}
.dest{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.dest>div{padding:10px 12px;border:1px solid #ddd;border-radius:4px}
table.lignes th{background:{{entreprise.couleur}};color:#fff;border:0;padding:8px 6px}table.lignes tbody tr:nth-child(even) td{background:#f7f8fa}
tr.section td{color:{{entreprise.couleur}};border-bottom-color:{{entreprise.couleur}};}
table.totaux tr.ttc td{background:{{entreprise.couleur}};color:#fff;border:0;padding:8px}</style></head><body><div class="page">
<div class="hd"><div>{{{logo}}}<b style="font-size:15px">{{entreprise.nom}}</b></div><div class="ent">{{{bloc_entreprise}}}</div></div>
<div class="bar"><h1>{{doc.titre}}</h1><b>N° {{doc.numero}}</b></div>
<div class="info"><div><small>Date</small>{{doc.date}}</div><div><small>Validité / échéance</small>{{doc.echeance}}</div><div><small>Lieu des travaux</small>{{doc.adresse_chantier}}</div></div>
<div class="dest"><div><small>Client</small>{{{bloc_client}}}</div><div><small>Objet</small>{{doc.objet}}</div></div>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
  // Sobre et compact, en noir et gris : tout tient sur une page pour les petits devis et les dépannages.
  { nom: 'Sobre', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title>
<meta name="kadra-colonnes" content="designation=Désignation;qte=Qté;pu=Prix unitaire HT;tva=TVA;total=Total HT"><style>{{{css_base}}}
body{font-size:11px}.hd{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;border-bottom:1px solid #1d1d1b;padding-bottom:12px}
h1{font-size:30px;font-weight:300;letter-spacing:.12em}.hd p{margin:4px 0 0;color:#555}.two{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:16px}
.two small{display:block;color:#888;font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}.obj{margin-top:14px;font-size:12.5px}
table.lignes th{border-bottom:1px solid #1d1d1b;font-weight:600;color:#555}table.totaux tr.ttc td{border-top:1px solid #1d1d1b}
.sign>div{border:0;border-top:1px solid #999;min-height:90px}</style></head><body><div class="page">
<div class="hd"><div>{{{logo}}}<h1>{{doc.titre}}</h1><p>N° {{doc.numero}} · {{doc.date}} · {{doc.echeance}}</p></div><div style="text-align:right">{{{bloc_entreprise}}}</div></div>
<div class="two"><div><small>Client</small>{{{bloc_client}}}</div><div><small>Chantier</small>{{doc.adresse_chantier}}</div></div>
<p class="obj"><b>{{doc.objet}}</b></p>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
  // Comme les devis Word d'un artisan : liste des travaux sans numéro ni détail dessous, marges fines, blocs sur toute la largeur.
  { nom: 'Simple', html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>{{doc.titre}} {{doc.numero}}</title>
<meta name="kadra-colonnes" content="designation=Description;qte=Quantité;pu=Prix unitaire;total=Montant"><style>{{{css_base}}}
.hd{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.hd .r{text-align:right;white-space:nowrap}h1{font-size:24px;color:{{entreprise.couleur}};}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:14px}.two small{display:block;color:#777;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
table.lignes{margin:12px 0}table.lignes td{padding:5px 6px}tr.section td{padding-top:10px;border-bottom:0}
.desc{display:inline!important;font-size:inherit;color:inherit}.desc .ed:not(:empty){display:inline!important}.desc:not(:empty)::before{content:" – "}.desc:has(.ed:empty)::before{content:none}
</style><style id="kd-marges">@page{margin:8mm}:root{--ed-marge:8mm}</style></head><body><div class="page">
<div class="hd"><div>{{{logo}}}{{{bloc_entreprise}}}</div><div class="r"><h1>{{doc.titre}}</h1>N° {{doc.numero}}<br>Date : {{doc.date}}<br>{{doc.echeance}}</div></div>
<div class="two"><div><small>Client</small>{{{bloc_client}}}</div><div><small>Adresse du chantier</small>{{doc.adresse_chantier}}<br><b>Objet :</b> {{doc.objet}}</div></div>
{{{lignes}}}{{{totaux}}}<p>{{doc.notes}}</p>{{{signature}}}{{{mentions}}}</div></body></html>` },
];

// Mode édition (fiche document) : texte modifiable en place, repéré par data-f (chemin dans le document) ou data-i/data-k (ligne, champ).
export const TVAS = [0, 5.5, 10, 20];
const ed = (attrs, v, ph, cls = '') => `<span class="ed ${cls}" contenteditable="plaintext-only" ${attrs} data-ph="${ph}">${esc(v)}</span>`;
const num = (v, d = 0) => (+v || 0).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: 2 });
const OUTILS = [['up', '↑', 'Monter'], ['down', '↓', 'Descendre'], ['dup', '⧉', 'Dupliquer'], ['cat', '★', 'Garder ce prix au catalogue'], ['del', '✕', 'Supprimer']];
const outils = (i, section) => `<div class="ed-tools noprint">${OUTILS.filter(o => !section || o[0] !== 'cat').map(([a, t, l]) => `<button type="button" data-act="${a}" data-i="${i}" title="${l}" aria-label="${l}">${t}</button>`).join('')}</div>`;

// Colonnes du tableau des lignes, choisies par le modèle de mise en page :
// <meta name="kadra-colonnes" content="designation=Description;qte=Quantité;pu=Prix unitaire;total=Montant">
// Clés : num, designation, qte, unite, pu, tva, total ; « soustotaux » ajoute un sous-total après chaque section.
const COLONNES = 'num=N°;designation=Désignation;qte=Qté;unite=Unité;pu=PU HT;tva=TVA;total=Total HT;soustotaux';
const CLES = ['num', 'designation', 'qte', 'unite', 'pu', 'tva', 'total'];
export function colonnes(tplHtml = '') {
  const m = /<meta\s+name=["']kadra-colonnes["']\s+content="([^"]*)"/i.exec(tplHtml) || /<meta\s+name=["']kadra-colonnes["']\s+content='([^']*)'/i.exec(tplHtml);
  const items = (m ? m[1] : COLONNES).split(';').map(x => x.trim()).filter(Boolean).map(x => { const [k, ...l] = x.split('='); return { k: k.trim(), l: l.join('=').trim() }; });
  const cols = items.filter(c => CLES.includes(c.k));
  if (!cols.some(c => c.k === 'designation')) cols.unshift({ k: 'designation', l: 'Désignation' });
  return { cols, soustotaux: items.some(c => c.k === 'soustotaux') };
}

function tableLignes(lignes, franchise, edit, { cols, soustotaux }) {
  const has = k => cols.some(c => c.k === k), n = cols.length, NUMS = ['qte', 'pu', 'tva', 'total'];
  let s = 0, i = 0, sous = null, rows = '';
  const st = () => { if (sous && soustotaux && n > 1) rows += `<tr class="st"><td colspan="${n - 1}">Sous-total ${esc(sous.nom)}</td><td class="n">${eur(sous.total)}</td></tr>`; };
  lignes.forEach((l, k) => {
    const E = (key, v, ph, cls) => (edit ? ed(`data-i="${k}" data-k="${key}"`, v, ph, cls) : esc(v));
    if (l.type === 'section') {
      st(); s++; i = 0; sous = { nom: l.designation, total: 0 };
      const titre = `${E('designation', l.designation, 'Titre de la section')}${edit ? outils(k, true) : ''}`;
      rows += `<tr class="section">${cols[0].k === 'num' && n > 1 ? `<td class="c-num">${s}</td><td colspan="${n - 1}" style="position:relative">${titre}</td>` : `<td colspan="${n}" style="position:relative">${titre}</td>`}</tr>`;
      return;
    }
    i++;
    const total = Math.round(l.qte * l.pu * 100) / 100;
    if (sous) sous.total += total;
    const tvaSel = `<select class="ed-tva" data-i="${k}" data-k="tva" aria-label="TVA">${[...new Set([...TVAS, +l.tva])].sort((a, b) => a - b).map(t => `<option value="${t}" ${+l.tva === t ? 'selected' : ''}>${num(t)} %</option>`).join('')}</select>`;
    // Unité ou TVA sans colonne : l'unité suit la quantité, la TVA reste modifiable sous la désignation (hors impression).
    const unite = has('unite') ? '' : edit ? ` ${E('unite', l.unite, 'u')}` : l.unite ? ` ${esc(l.unite)}` : '';
    const cell = {
      num: () => (s ? `${s}.${i}` : i),
      designation: () => `${E('designation', l.designation, 'Désignation')}${edit ? `<div class="desc">${E('description', l.description, 'Détail (facultatif)', 'opt ml')}</div>` : l.description ? `<div class="desc">${esc(l.description)}</div>` : ''}${edit && !has('tva') && !franchise ? `<div class="noprint ed-tvabis">TVA ${tvaSel}</div>` : ''}`,
      qte: () => `${edit ? E('qte', num(l.qte), '0') : num(l.qte)}${unite}`,
      unite: () => E('unite', l.unite, 'u'),
      pu: () => (edit ? `${E('pu', num(l.pu, 2), '0,00')} €` : eur(l.pu)),
      tva: () => (franchise ? '–' : edit ? tvaSel : `${num(l.tva)} %`),
      total: () => `<span data-tot="${k}">${eur(total)}</span>`,
    };
    rows += `<tr>${cols.map((c, j) => `<td class="c-${c.k}${NUMS.includes(c.k) ? ' n' : ''}"${j === n - 1 ? ' style="position:relative"' : ''}>${cell[c.k]()}${j === n - 1 && edit ? outils(k) : ''}</td>`).join('')}</tr>`;
  });
  st();
  if (edit && !lignes.length) rows = `<tr><td colspan="${n}" class="ed-vide">Aucune ligne pour le moment : ajoutez-en une ci-dessous.</td></tr>`;
  return `<table class="lignes"><thead><tr>${cols.map(c => `<th class="c-${c.k}${NUMS.includes(c.k) ? ' n' : ''}">${esc(c.l)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
${edit ? '<div class="ed-add noprint"><button type="button" data-act="addL">+ Ligne</button><button type="button" data-act="addS">+ Section</button></div>' : ''}`;
}

function tableTotaux(t, franchise, paye, avoirs, ret = 0, retPct = 0) {
  const r = (a, b, c = '') => `<tr class="${c}"><td>${a}</td><td class="n">${b}</td></tr>`;
  return `<table class="totaux">${t.remise ? r('Total brut HT', eur(t.brut)) + r('Remise', '− ' + eur(t.remise)) : ''}${r('Total HT', eur(t.ht))}
${franchise ? '' : t.tva.map(v => r(`TVA ${v.taux.toLocaleString('fr-FR')} % (base ${eur(v.base)})`, eur(v.montant))).join('')}
${r(franchise ? 'Net à payer' : 'Total TTC', eur(t.ttc), 'ttc')}${avoirs ? r('Avoirs', '− ' + eur(avoirs)) : ''}${paye ? r('Déjà réglé', '− ' + eur(paye)) : ''}
${ret ? r(`Retenue de garantie ${retPct.toLocaleString('fr-FR')} %`, '− ' + eur(ret)) : ''}
${paye || avoirs || ret ? r(`<b>${paye || avoirs ? 'Reste à payer' : 'Net à payer'}</b>`, `<b>${eur(t.ttc - paye - avoirs - ret)}</b>`) : ''}</table>`;
}

// JSON coupé en cours de rédaction (aperçu en direct) → objet : on referme chaînes et crochets, on retire la dernière clé sans valeur.
export function partialJSON(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (const c of s) {
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let t = s + (inStr ? '"' : '');
  for (let i = 0; i < 4; i++) {
    try { return JSON.parse(t + stack.slice().reverse().join('')); } catch { t = t.replace(/(,|"(?:[^"\\]|\\.)*"\s*:?|[\w.+-]+)\s*$/, ''); }
  }
}

// doc = ligne de la table documents (data parsé), s = paramètres entreprise.
export function renderDoc(doc, s, tplHtml, opts) { return fill(tplHtml, docContext(doc, s, { ...opts, tpl: tplHtml })); }

// Version modifiable en place : les champs {{doc.x}} sont posés en marqueurs (fill les échapperait), puis remplacés par des zones
// modifiables dans le texte ; dans une balise ou le <title>, le marqueur redevient du texte simple.
const MK = /\u0001([\w.]+)\u0001/g;
const PH = { 'data.objet': 'Objet des travaux', 'data.adresse_chantier': 'Adresse du chantier', 'data.notes': 'Notes (facultatif)' };
export function renderEdit(doc, s, tplHtml, opts) {
  const val = p => getPath(doc, p) ?? '';
  const plain = (_, p) => esc(p === 'date' || p === 'echeance' ? dateFr(val(p)) : val(p));
  return fill(tplHtml, docContext(doc, s, { ...opts, edit: true, tpl: tplHtml }))
    .replace(/<title>[\s\S]*?<\/title>|<[^>]*>/g, t => t.replace(MK, plain))
    .replace(MK, (_, p) => (p === 'date' || p === 'echeance'
      ? `<input type="date" class="ed-date" data-f="${p}" value="${esc(val(p))}" aria-label="${p === 'date' ? 'Date' : 'Échéance'}">`
      : ed(`data-f="${p}"`, val(p), PH[p], p === 'data.objet' ? '' : 'ml')));
}
const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);

export function docContext(doc, s, { paye = 0, avoirs = 0, edit = false, tpl = '' } = {}) {
  const d = doc.data, c = d.client || {}, franchise = !!s.franchise_tva;
  const t = totaux(d, franchise);
  const avoir = doc.kind === 'avoir', fac = doc.type === 'facture';
  const titre = doc.type === 'modele' ? 'MODÈLE DE DEVIS' : doc.type === 'devis' ? 'DEVIS' : avoir ? 'AVOIR' : doc.kind === 'acompte' ? 'FACTURE D’ACOMPTE' : doc.kind === 'situation' ? 'SITUATION DE TRAVAUX' : 'FACTURE';
  const ret = fac && !avoir ? retenue(d, t.ttc) : 0;
  const mentions = [
    franchise && 'TVA non applicable, article 293 B du CGI.',
    !franchise && t.tva.some(v => v.taux < 20) && 'Taux réduit de TVA : le client certifie que les travaux portent sur un local d’habitation achevé depuis plus de deux ans.',
    doc.type === 'devis' && s.conditions_paiement && `Conditions de paiement : ${s.conditions_paiement}`,
    doc.type === 'devis' && d.acompte_pct && `Acompte de ${d.acompte_pct} % à la signature, soit ${eur(t.ttc * d.acompte_pct / 100)}.`,
    avoir && doc.parent_numero && `Avoir se rapportant à la facture ${doc.parent_numero}.`,
    fac && !avoir && doc.echeance && `Paiement à réception, au plus tard le ${dateFr(doc.echeance)}.`,
    ret && `Retenue de garantie de ${d.retenue_pct} % (loi n° 71-584 du 16 juillet 1971), soit ${eur(ret)}, payable un an après la réception des travaux, sauf réserves.`,
    fac && `Catégorie de l’opération : ${s.categorie_operation || 'prestation de services'}.`,
    fac && !franchise && s.tva_debits && 'Option pour le paiement de la TVA d’après les débits.',
    s.mentions,
    s.assurance && `Assurance décennale : ${s.assurance}`,
  ].filter(Boolean);
  const signature = fac
    ? (s.iban && !avoir ? `<div class="sign"><div><b>Règlement par virement</b><br>IBAN : ${esc(s.iban)}<br>BIC : ${esc(s.bic)}<br>Référence : ${esc(doc.numero || '')}</div></div>` : '')
    : `<div class="sign"><div><b>L’entreprise</b><br>${esc(s.nom)}${s.cachet ? `<img src="${esc(s.cachet)}" alt="Cachet et signature de l’entreprise">` : ''}</div><div><b>Le client</b> : date et signature précédées de « Bon pour accord »<br>${doc.signature
      ? `<img src="${esc(doc.signature)}" alt="Signature"><small>Signé électroniquement par ${esc(doc.signe_par)} le ${new Date(doc.signe_le).toLocaleString('fr-FR')}</small>` : ''}</div></div>`;
  const mk = p => `\u0001${p}\u0001`, zone = (z, html) => (edit ? `<div data-zone="${z}">${html}</div>` : html);
  const ech = doc.type === 'facture' ? 'Échéance : ' : 'Valable jusqu’au ';
  return {
    css_base: CSS_BASE,
    doc: {
      titre, numero: doc.numero || (doc.type === 'facture' ? 'Brouillon' : doc.nom || ''),
      date: edit ? mk('date') : dateFr(doc.date), objet: edit ? mk('data.objet') : d.objet,
      adresse_chantier: edit ? mk('data.adresse_chantier') : d.adresse_chantier, notes: edit ? mk('data.notes') : d.notes,
      echeance: edit ? ech + mk('echeance') : doc.echeance ? ech + dateFr(doc.echeance) : '',
      total_ht: eur(t.ht), total_ttc: eur(t.ttc),
    },
    entreprise: { ...s, stripe_secret: '', stripe_webhook_secret: '', imap_pass: '' }, // un modèle ne peut jamais afficher un secret
    client: c,
    logo: s.logo ? `<img class="logo" src="${esc(s.logo)}" alt="">` : '',
    bloc_entreprise: `<b>${esc(s.nom)}</b><br>${nl2br(s.adresse)}${s.tel ? `<br>Tél. ${esc(s.tel)}` : ''}${s.email ? `<br>${esc(s.email)}` : ''}${s.site ? `<br>${esc(s.site)}` : ''}
${s.siret ? `<br>SIRET ${esc(s.siret)}` : ''}${s.rcs ? `<br>${esc(s.rcs)}` : ''}${s.tva_intra && !franchise ? `<br>TVA ${esc(s.tva_intra)}` : ''}`,
    bloc_client: edit
      ? `<b>${ed('data-f="data.client.nom"', c.nom, 'Nom du client')}</b><br>${ed('data-f="data.client.adresse"', c.adresse, 'Adresse du client', 'ml')}
<br>${ed('data-f="data.client.tel"', c.tel, 'Téléphone')}<br>${ed('data-f="data.client.email"', c.email, 'E-mail (pour l’envoi)')}<br>${ed('data-f="data.client.siret"', c.siret, 'SIRET (client pro)', 'opt')}`
      : `<b>${esc(c.nom)}</b><br>${nl2br(c.adresse)}${c.tel ? `<br>${esc(c.tel)}` : ''}${c.email ? `<br>${esc(c.email)}` : ''}${c.siret ? `<br>SIRET ${esc(c.siret)}` : ''}`,
    lignes: zone('lignes', tableLignes(d.lignes || [], franchise, edit, colonnes(tpl))),
    totaux: zone('totaux', tableTotaux(t, franchise, paye, avoirs, ret, +d.retenue_pct || 0)),
    mentions: zone('mentions', `<div class="mentions">${mentions.map(nl2br).join('<br>')}</div>`),
    signature,
  };
}

export const SAMPLE = {
  type: 'devis', numero: 'DEV-2026-0042', date: '2026-10-30', echeance: '2026-11-29',
  data: {
    client: { nom: 'Mme Claire Martin', adresse: '12 rue des Lilas\n69003 Lyon', email: 'claire.martin@example.fr', tel: '06 12 34 56 78' },
    objet: 'Rénovation salle de bain', adresse_chantier: '12 rue des Lilas, 69003 Lyon', acompte_pct: 30, notes: '',
    lignes: [
      { type: 'section', designation: 'Démolition' },
      { type: 'ligne', designation: 'Dépose baignoire et évacuation', description: 'Y compris mise en décharge', qte: 1, unite: 'forfait', pu: 350, tva: 10 },
      { type: 'section', designation: 'Carrelage' },
      { type: 'ligne', designation: 'Pose de faïence murale', description: 'Fourniture comprise, colle et joints', qte: 18, unite: 'm²', pu: 55, tva: 10 },
    ],
  },
};
