// Devis / facture → Word (.docx) et Excel (.xlsx) avec la mise en page du modèle. Sans dépendance : un fichier Office est un zip de XML.
// Chrome affiche le document comme pour le PDF ; on relève la place de chaque texte, fond, trait et image,
// puis on refait la même grille : un tableau sans quadrillage dans Word, des cellules fusionnées dans Excel.
import zlib from 'node:zlib';
import { withPage } from './pdf.js';

export function zip(files) {
  const loc = [], cen = [];
  let off = 0;
  for (const [nom, contenu] of files) {
    const data = Buffer.from(contenu), z = zlib.deflateRawSync(data), n = Buffer.from(nom), crc = zlib.crc32(data);
    const h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(z.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(z.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    loc.push(h, n, z); cen.push(c, n); off += 30 + n.length + z.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cd, e]);
}

const x = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---------- Relevé dans Chrome ----------
// Exécuté dans la page. Bloc de texte = élément non « inline » qui a du texte à lui (le sien et celui de ses enfants inline).
function releve() {
  const px = v => parseFloat(v) || 0, vu = c => c && c !== 'transparent' && !/,\s*0\)$/.test(c);
  const R = r => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
  const enLigne = cs => /^inline/.test(cs.display) && cs.display !== 'inline-table';
  const st = cs => ({ sz: px(cs.fontSize), b: +cs.fontWeight >= 600, i: cs.fontStyle === 'italic', u: /underline/.test(cs.textDecorationLine), c: cs.color, f: cs.fontFamily });
  const casse = (t, cs) => cs.textTransform === 'uppercase' ? t.toUpperCase() : cs.textTransform === 'lowercase' ? t.toLowerCase() : t;
  const pseudo = (el, q) => { const c = getComputedStyle(el, q).content; try { return /^".*"$/.test(c) ? JSON.parse(c) : ''; } catch { return ''; } };
  const out = { blocs: [], fonds: [], bords: [], imgs: [] };
  function runs(el, cs, acc, propres, f) {
    const ws = cs.whiteSpace, net = t => /^(pre|break-spaces)/.test(ws) && ws !== 'pre-line' ? t : ws === 'pre-line' ? t.replace(/[ \t\r]+/g, ' ') : t.replace(/\s+/g, ' ');
    const ajoute = t => { t = net(t); if (t) acc.push({ t: casse(t, cs), ...st(cs) }); };
    ajoute(pseudo(el, '::before'));
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { ajoute(n.data); propres.push(n); continue; }
      if (n.nodeType !== 1 || !n.getClientRects().length) continue;
      const c = getComputedStyle(n);
      if (n.tagName === 'BR') acc.push({ t: '\n', ...st(cs) });
      else if (n.tagName === 'IMG') f.bloc = true; // image dans le bloc (logo au-dessus de l'adresse) : on prend la place du texte seul
      else if (enLigne(c)) { // marge autour d'un élément inline (« Total <span>1 474 €</span> ») = une espace
        if (px(c.marginLeft) > 2) acc.push({ t: ' ', ...st(cs) });
        runs(n, c, acc, propres, f);
        if (px(c.marginRight) > 2) acc.push({ t: ' ', ...st(cs) });
      }
      else f.bloc = true;
    }
    ajoute(pseudo(el, '::after'));
  }
  for (const el of document.body.querySelectorAll('*')) {
    if (!el.getClientRects().length) continue; // caché (display:none, ou dans un parent caché)
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden') continue;
    if (el.tagName === 'IMG') { if (r.width && r.height) out.imgs.push({ ...R(r), src: el.currentSrc || el.src }); continue; }
    if (enLigne(cs)) continue;
    if (r.width && r.height) {
      if (vu(cs.backgroundColor)) out.fonds.push({ ...R(r), c: cs.backgroundColor });
      const cote = k => { const w = px(cs[`border${k}Width`]), s = cs[`border${k}Style`]; return w && s !== 'none' && s !== 'hidden' && vu(cs[`border${k}Color`]) ? [w, cs[`border${k}Color`], s] : null; };
      const b = { t: cote('Top'), r: cote('Right'), b: cote('Bottom'), l: cote('Left') };
      if (b.t || b.r || b.b || b.l) out.bords.push({ ...R(r), ...b });
    }
    const acc = [], propres = [], f = { bloc: false };
    runs(el, cs, acc, propres, f);
    if (!acc.some(a => a.t.trim())) continue;
    let z;
    if (!f.bloc) { // boîte du contenu (sans marges intérieures ni bordure) : les colonnes s'alignent comme sur la feuille
      const g = px(cs.borderLeftWidth) + px(cs.paddingLeft), d = px(cs.borderRightWidth) + px(cs.paddingRight), hh = px(cs.borderTopWidth) + px(cs.paddingTop), bb = px(cs.borderBottomWidth) + px(cs.paddingBottom);
      z = { x: r.left + g + scrollX, y: r.top + hh + scrollY, w: r.width - g - d, h: r.height - hh - bb };
    } else { // texte mêlé à des blocs enfants : seulement la place de son propre texte
      const rg = document.createRange(), rs = propres.map(n => (rg.selectNodeContents(n), rg.getBoundingClientRect())).filter(q => q.width && q.height);
      if (!rs.length) continue;
      const x0 = Math.min(...rs.map(q => q.left)), y0 = Math.min(...rs.map(q => q.top));
      z = { x: x0 + scrollX, y: y0 + scrollY, w: Math.max(...rs.map(q => q.right)) - x0, h: Math.max(...rs.map(q => q.bottom)) - y0 };
    }
    // tw / th : place du texte lui-même (une case de tableau est souvent bien plus haute que son texte)
    const rg = document.createRange(); rg.selectNodeContents(el); const t = rg.getBoundingClientRect();
    if (z.w > 0 && z.h > 0) out.blocs.push({ ...z, runs: acc, a: cs.textAlign, lh: px(cs.lineHeight) || px(cs.fontSize) * 1.2, tw: f.bloc ? z.w : t.width, th: f.bloc ? z.h : t.height || z.h });
  }
  return out;
}

const MM = 96 / 25.4, UNITE = { mm: 1, cm: 10, in: 25.4, px: 25.4 / 96, pt: 25.4 / 72 };
async function mesurer(html) {
  // marges de la page (@page) en mm : haut, droite, bas, gauche ; la largeur de la grille = A4 moins les marges
  const v = ([...html.matchAll(/@page\s*\{[^}]*?margin\s*:\s*([^;}]+)/g)].at(-1)?.[1] || '12mm').trim().split(/\s+/).map(t => { const [, n, u] = /^([\d.]+)(mm|cm|in|px|pt)?$/.exec(t) || [, 12, 'mm']; return +n * UNITE[u || 'px']; });
  const mm = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]], W = Math.round((210 - mm[1] - mm[3]) * MM);
  const r = await withPage(html, async p => { await p.setViewport({ width: W, height: 1100 }); await p.emulateMediaType('print'); return p.evaluate(releve); });
  return { ...r, W, mm, titre: (/<title>([^<]*)<\/title>/i.exec(html)?.[1] || 'Document').trim() };
}

const hex = c => {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || '');
  if (!m) return '000000';
  const a = m[4] === undefined ? 1 : +m[4]; // transparence posée sur du blanc
  return [m[1], m[2], m[3]].map(v => Math.round(v * a + 255 * (1 - a)).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const GEN = /^(system-ui|-apple-system|blinkmacsystemfont|sans-serif|serif|monospace|ui-[\w-]+|cursive|fantasy|emoji)$/i;
const police = f => String(f).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).find(s => s && !GEN.test(s)) || 'Arial';
const meme = (a, b) => a.sz === b.sz && a.b === b.b && a.i === b.i && a.u === b.u && a.c === b.c && a.f === b.f;

// Morceaux de texte : collés quand le style est le même, espaces en trop retirés (début, fin, autour des retours à la ligne).
function propre(runs) {
  const out = [];
  for (const r of runs) {
    const l = out.at(-1), t = l && /[ \n]$/.test(l.t) ? r.t.replace(/^ +/, '') : r.t;
    if (!t) continue;
    if (l && meme(l, r)) l.t += t; else out.push({ ...r, t });
  }
  for (const r of out) r.t = r.t.replace(/ *\n */g, '\n');
  if (out.length) { out[0].t = out[0].t.replace(/^\s+/, ''); out.at(-1).t = out.at(-1).t.replace(/\s+$/, ''); }
  return out.filter(r => r.t);
}

// Grille : chaque bord de texte, fond, trait ou image devient une limite de colonne / de rangée (limites à moins de `tol` px fondues).
function axe(vals, tol) { const out = []; for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out.at(-1) > tol) out.push(v); return out; }
const proche = (A, v) => { let i = 0; for (let k = 1; k < A.length; k++) if (Math.abs(A[k] - v) < Math.abs(A[i] - v)) i = k; return i; };
function grille(m, maxCols = Infinity) {
  const H = Math.max(1, ...[...m.blocs, ...m.bords, ...m.imgs].map(o => o.y + o.h));
  const items = [...m.blocs, ...m.fonds, ...m.bords, ...m.imgs].filter(o => o.x < m.W && o.y < H);
  const borne = (v, M) => Math.min(Math.max(v, 0), M);
  let X, tol = 2;
  // ponytail: Word refuse plus de 63 colonnes : on fond des limites de plus en plus éloignées jusqu'à tenir.
  do { X = axe([0, m.W, ...items.flatMap(o => [o.x, o.x + o.w]).map(v => borne(v, m.W))], tol); tol *= 1.5; } while (X.length - 1 > maxCols);
  const Y = axe([0, H, ...items.flatMap(o => [o.y, o.y + o.h]).map(v => borne(v, H))], 2);
  const nr = Y.length - 1, nc = X.length - 1;
  const zone = o => {
    let c0 = proche(X, o.x), c1 = proche(X, o.x + o.w), r0 = proche(Y, o.y), r1 = proche(Y, o.y + o.h);
    if (c1 <= c0) { c1 = Math.min(c0 + 1, nc); c0 = c1 - 1; }
    if (r1 <= r0) { r1 = Math.min(r0 + 1, nr); r0 = r1 - 1; }
    return { r0, r1, c0, c1 };
  };
  const occ = Array.from({ length: nr }, () => Array(nc).fill(-1)), blocs = [];
  const libre = z => { for (let r = z.r0; r < z.r1; r++) for (let c = z.c0; c < z.c1; c++) if (occ[r][c] >= 0) return false; return true; };
  for (const b of m.blocs) {
    const runs = propre(b.runs);
    if (!runs.length) continue;
    let z = zone(b);
    if (!libre(z)) {
      const z1 = { r0: z.r0, r1: z.r0 + 1, c0: z.c0, c1: z.c0 + 1 };
      if (libre(z1)) z = z1;
      else { blocs[occ[z.r0][z.c0]].runs.push({ ...runs[0], t: '\n' }, ...runs); continue; } // chevauchement : texte mis à la suite
    }
    const k = blocs.push({ ...b, runs, ...z }) - 1;
    for (let r = z.r0; r < z.r1; r++) for (let c = z.c0; c < z.c1; c++) occ[r][c] = k;
  }
  const fond = (px, py) => {
    let best = null, a = Infinity;
    for (const f of m.fonds) if (px >= f.x && px <= f.x + f.w && py >= f.y && py <= f.y + f.h && f.w * f.h <= a) { a = f.w * f.h; best = hex(f.c); }
    return best === 'FFFFFF' ? null : best;
  };
  const fill = Y.slice(0, -1).map((y, r) => X.slice(0, -1).map((xx, c) => fond((X[c] + X[c + 1]) / 2, (Y[r] + Y[r + 1]) / 2)));
  const hb = Array.from({ length: nr + 1 }, () => Array(nc).fill(null)), vb = Array.from({ length: nr }, () => Array(nc + 1).fill(null));
  for (const o of m.bords) {
    const z = zone(o);
    for (let c = z.c0; c < z.c1; c++) { if (o.t) hb[z.r0][c] = o.t; if (o.b) hb[z.r1][c] = o.b; }
    for (let r = z.r0; r < z.r1; r++) { if (o.l) vb[r][z.c0] = o.l; if (o.r) vb[r][z.c1] = o.r; }
  }
  // Une ligne de texte peut déborder dans les cases vides voisines (même fond, pas de trait) du côté où elle n'est pas calée :
  // Word et Excel écrivent un peu plus large que Chrome, sans cela un numéro ou un titre passerait à la ligne ou serait coupé.
  const colLibre = (b, c, bord) => { for (let r = b.r0; r < b.r1; r++) if (occ[r][c] >= 0 || vb[r][bord] || fill[r][c] !== fill[r][b.c0]) return false; return true; };
  blocs.forEach((b, k) => {
    if (Math.round(b.th / b.lh) > b.runs.reduce((n, q) => n + (q.t.match(/\n/g) || []).length, 1)) return; // texte qui passe à la ligne de lui-même : il garde sa largeur
    // au plus un tiers de sa largeur (au moins une case) : le texte voisin garde de la place pour déborder lui aussi
    const lim = Math.max(24, b.w * 0.35);
    const versG = () => { const c = b.c0; while (b.c0 > 0 && colLibre(b, b.c0 - 1, b.c0) && (b.c0 === c || X[c] - X[b.c0 - 1] <= lim)) b.c0--; return b.c0 < c; };
    const versD = () => { const c = b.c1; while (b.c1 < nc && colLibre(b, b.c1, b.c1) && (b.c1 === c || X[b.c1 + 1] - X[c] <= lim)) b.c1++; return b.c1 > c; };
    const serre = b.tw >= b.w - 3; // boîte à la largeur du texte : calée à gauche ou à droite, c'est pareil
    if (/center/.test(b.a)) return;
    if (/right|end/.test(b.a)) { if (!versG() && serre && versD()) b.a = 'left'; } else if (!versD() && serre && versG()) b.a = 'right';
    for (let r = b.r0; r < b.r1; r++) for (let c = b.c0; c < b.c1; c++) occ[r][c] = k;
  });
  // image plus large que la page (Chrome rétrécit alors tout le PDF) : ramenée à la largeur de la page
  const imgs = m.imgs.map(i => { const k = Math.min(1, (m.W - i.x) / i.w); return { ...i, w: i.w * k, h: i.h * k, ...zone(i), img: /^data:image\/(png|jpeg);base64,(.+)$/.exec(i.src) }; }).filter(i => i.img);
  return { X, Y, nr, nc, occ, blocs, fill, hb, vb, imgs };
}
const medias = imgs => { const vus = new Map(); for (const i of imgs) if (!vus.has(i.src)) vus.set(i.src, { n: vus.size + 1, ext: i.img[1], data: Buffer.from(i.img[2], 'base64') }); return vus; };

// ---------- Word ----------
const tw = v => Math.round(v * 15); // px → twips
const emu = v => Math.round(v * 9525);
const bordW = (k, b) => b ? `<w:${k} w:val="${{ dashed: 'dashed', dotted: 'dotted', double: 'double' }[b[2]] || 'single'}" w:sz="${Math.min(96, Math.max(2, Math.round(b[0] * 6)))}" w:space="0" w:color="${hex(b[1])}"/>` : `<w:${k} w:val="nil"/>`;
const JC = { center: 'center', right: 'right', end: 'right', justify: 'both' };
const runW = r => `<w:r><w:rPr><w:rFonts w:ascii="${x(police(r.f))}" w:hAnsi="${x(police(r.f))}" w:cs="${x(police(r.f))}"/>${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}<w:color w:val="${hex(r.c)}"/><w:sz w:val="${Math.max(2, Math.round(r.sz * 1.5))}"/>${r.u ? '<w:u w:val="single"/>' : ''}</w:rPr>${r.t.split('\n').map(l => `<w:t xml:space="preserve">${x(l)}</w:t>`).join('<w:br/>')}</w:r>`;
const VIDE = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>';

export async function docWord(html) {
  const m = await mesurer(html), g = grille(m, 63), med = medias(g.imgs), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Rangées de cellules : un texte = une cellule fusionnée ; les cases vides voisines semblables sont fusionnées aussi.
  const rows = [];
  for (let r = 0; r < g.nr; r++) {
    const tcs = [];
    for (let c = 0; c < g.nc;) {
      const k = g.occ[r][c];
      if (k >= 0) { const b = g.blocs[k]; tcs.push({ c0: b.c0, c1: b.c1, b, debut: r === b.r0, extra: [] }); c = b.c1; continue; }
      let c1 = c + 1;
      while (c1 < g.nc && g.occ[r][c1] < 0 && !g.vb[r][c1] && g.fill[r][c1] === g.fill[r][c] && same(g.hb[r][c1], g.hb[r][c]) && same(g.hb[r + 1][c1], g.hb[r + 1][c])) c1++;
      tcs.push({ c0: c, c1, extra: [] }); c = c1;
    }
    rows.push(tcs);
  }
  // Images : posées par-dessus, dans la cellule de leur coin haut gauche (décalées si la cellule commence plus haut ou plus à gauche).
  g.imgs.forEach((im, n) => {
    let tc = rows[im.r0].find(t => t.c0 <= im.c0 && im.c0 < t.c1), dy = 0;
    if (tc.b && !tc.debut) { dy = g.Y[im.r0] - g.Y[tc.b.r0]; tc = rows[tc.b.r0].find(t => t.b === tc.b); }
    const id = n + 1, cx = emu(im.w), cy = emu(im.h);
    tc.extra.push(`<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>${emu(g.X[im.c0] - g.X[tc.c0])}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>${emu(dy)}</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Image ${id}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg${med.get(im.src).n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`);
  });
  const premier = (l, c0, c1) => l.slice(c0, c1).find(Boolean) || null;
  // Word ajoute l'épaisseur du trait du haut à la hauteur de la rangée : on la retire pour garder la même hauteur de page.
  const lignes = rows.map((tcs, r) => `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(Math.max(1, g.Y[r + 1] - g.Y[r] - Math.max(0, ...g.hb[r].map(q => q?.[0] || 0))))}" w:hRule="atLeast"/></w:trPr>${tcs.map(t => {
    const fusion = t.b && t.b.r1 - t.b.r0 > 1 ? `<w:vMerge${t.debut ? ' w:val="restart"' : ''}/>` : '';
    const f = g.fill[r][t.c0], b = t.b;
    const texte = b && t.debut ? `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${tw(b.lh)}" w:lineRule="atLeast"/><w:jc w:val="${JC[b.a] || 'left'}"/></w:pPr>${t.extra.join('')}${b.runs.map(runW).join('')}</w:p>` : '';
    const p = texte || (t.extra.length ? VIDE.replace('</w:pPr>', `</w:pPr>${t.extra.join('')}`) : VIDE);
    return `<w:tc><w:tcPr><w:tcW w:w="${tw(g.X[t.c1] - g.X[t.c0])}" w:type="dxa"/>${t.c1 - t.c0 > 1 ? `<w:gridSpan w:val="${t.c1 - t.c0}"/>` : ''}${fusion}<w:tcBorders>${bordW('top', premier(g.hb[r], t.c0, t.c1))}${bordW('left', g.vb[r][t.c0])}${bordW('bottom', premier(g.hb[r + 1], t.c0, t.c1))}${bordW('right', g.vb[r][t.c1])}</w:tcBorders>${f ? `<w:shd w:val="clear" w:color="auto" w:fill="${f}"/>` : ''}</w:tcPr>${p}</w:tc>`;
  }).join('')}</w:tr>`).join('');
  const zero = ['top', 'left', 'bottom', 'right'].map(k => `<w:${k} w:w="0" w:type="dxa"/>`).join('');
  // ponytail: Word écrit un peu plus haut que Chrome (quelques px par page) : marge du bas réduite de 40 % pour qu'une page pleine
  // ne déborde pas d'une ligne sur une 2e page. Si une page déborde encore, réduire les rangées vides plutôt que cette marge.
  const marge = m.mm.map((v, i) => Math.round(v * (i === 2 ? 0.6 : 1) * 56.693));
  const document = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:tbl><w:tblPr><w:tblW w:w="${tw(m.W)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar>${zero}</w:tblCellMar></w:tblPr><w:tblGrid>${g.X.slice(1).map((v, i) => `<w:gridCol w:w="${tw(v - g.X[i])}"/>`).join('')}</w:tblGrid>${lignes}</w:tbl>${VIDE}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${marge[0]}" w:right="${marge[1]}" w:bottom="${marge[2]}" w:left="${marge[3]}" w:header="300" w:footer="300" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="18"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/_rels/document.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${[...med.values()].map(i => `<Relationship Id="rImg${i.n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i.n}.${i.ext}"/>`).join('')}</Relationships>`],
    ['word/document.xml', document], ['word/styles.xml', styles],
    ...[...med.values()].map(i => [`word/media/image${i.n}.${i.ext}`, i.data]),
  ]);
}

// ---------- Excel ----------
const colL = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const EURO = /^([−-]?)\s?(\d{1,3}(?:[   .]\d{3})*|\d+)(?:,(\d+))?\s?€$/;
const nombreDe = t => { const m = EURO.exec(t); if (m) return { n: (m[1] ? -1 : 1) * +`${m[2].replace(/\D/g, '')}.${m[3] || 0}`, eur: true }; if (/^\d{1,6}(,\d+)?$/.test(t)) return { n: +t.replace(',', '.') }; return null; };
const bordX = (k, b) => b ? `<${k} style="${b[2] === 'dashed' ? 'dashed' : b[2] === 'dotted' ? 'dotted' : b[2] === 'double' ? 'double' : b[0] <= 1.2 ? 'thin' : b[0] <= 2.5 ? 'medium' : 'thick'}"><color rgb="FF${hex(b[1])}"/></${k}>` : `<${k}/>`;
const fontX = r => `<font>${r.b ? '<b/>' : ''}${r.i ? '<i/>' : ''}${r.u ? '<u/>' : ''}<sz val="${+(r.sz * 0.75).toFixed(1)}"/><color rgb="FF${hex(r.c)}"/><name val="${x(police(r.f))}"/></font>`;
const rprX = r => `<rPr><rFont val="${x(police(r.f))}"/>${r.b ? '<b/>' : ''}${r.i ? '<i/>' : ''}<color rgb="FF${hex(r.c)}"/><sz val="${+(r.sz * 0.75).toFixed(1)}"/>${r.u ? '<u/>' : ''}</rPr>`;
function registre(base) { const m = new Map(base.map((v, i) => [v, i])), l = [...base]; return [v => { if (!m.has(v)) m.set(v, l.push(v) - 1); return m.get(v); }, l]; }

// ponytail: Excel écrit plus large et plus haut que Chrome et n'agrandit pas une cellule fusionnée : toute la grille (colonnes,
// rangées, images) est agrandie de K, l'impression la remet à la largeur de la page. Texte encore coupé : monter K.
const K = 1.16;
export async function docExcel(html) {
  const m = await mesurer(html), g = grille(m), med = medias(g.imgs);
  const [font, fonts] = registre(['<font><sz val="11"/><name val="Calibri"/></font>']);
  const [fill, fills] = registre(['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']);
  const [bord, bords] = registre(['<border><left/><right/><top/><bottom/><diagonal/></border>']);
  const [xf, xfs] = registre(['<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>']);
  const fusions = [], data = [];
  for (let r = 0; r < g.nr; r++) {
    const cells = [];
    for (let c = 0; c < g.nc; c++) {
      const k = g.occ[r][c], b = k >= 0 ? g.blocs[k] : null, debut = b && b.r0 === r && b.c0 === c;
      const fi = g.fill[r][c] ? fill(`<fill><patternFill patternType="solid"><fgColor rgb="FF${g.fill[r][c]}"/></patternFill></fill>`) : 0;
      const bo = bord(`<border>${bordX('left', g.vb[r][c])}${bordX('right', g.vb[r][c + 1])}${bordX('top', g.hb[r][c])}${bordX('bottom', g.hb[r + 1][c])}<diagonal/></border>`);
      let s, val = '';
      if (debut) {
        const t = b.runs.map(q => q.t).join(''), n = b.runs.length === 1 && nombreDe(t);
        const enroule = t.includes('\n') || b.th > b.lh * 1.6;
        s = xf(`<xf numFmtId="${n?.eur ? 164 : 0}" fontId="${font(fontX(b.runs[0]))}" fillId="${fi}" borderId="${bo}" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"${n?.eur ? ' applyNumberFormat="1"' : ''}><alignment horizontal="${{ center: 'center', right: 'right', end: 'right', justify: 'justify' }[b.a] || 'left'}" vertical="top"${enroule ? ' wrapText="1"' : ' shrinkToFit="1"'}/></xf>`);
        val = n ? `<v>${n.n}</v>` : `<is>${b.runs.length > 1 ? b.runs.map(q => `<r>${rprX(q)}<t xml:space="preserve">${x(q.t)}</t></r>`).join('') : `<t xml:space="preserve">${x(t)}</t>`}</is>`;
        if (b.r1 - b.r0 > 1 || b.c1 - b.c0 > 1) fusions.push(`${colL(b.c0)}${b.r0 + 1}:${colL(b.c1 - 1)}${b.r1}`);
        cells.push(`<c r="${colL(c)}${r + 1}" s="${s}"${n ? '' : ' t="inlineStr"'}>${val}</c>`);
      } else if (fi || bo) cells.push(`<c r="${colL(c)}${r + 1}" s="${xf(`<xf numFmtId="0" fontId="0" fillId="${fi}" borderId="${bo}" applyFill="1" applyBorder="1"/>`)}"/>`);
    }
    data.push(`<row r="${r + 1}" ht="${+((g.Y[r + 1] - g.Y[r]) * 0.75 * K).toFixed(2)}" customHeight="1">${cells.join('')}</row>`);
  }
  const larg = p => +(p < 12 ? p / 12 : (p - 5) / 7).toFixed(2); // px → largeur Excel (Calibri 11)
  const cols = g.X.slice(1).map((v, i) => `<col min="${i + 1}" max="${i + 1}" width="${larg((v - g.X[i]) * K)}" customWidth="1"/>`).join('');
  const [ph, pd, pb, pg] = m.mm.map(v => +(v / 25.4).toFixed(2));
  const sheet = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><cols>${cols}</cols><sheetData>${data.join('')}</sheetData>${fusions.length ? `<mergeCells count="${fusions.length}">${fusions.map(f => `<mergeCell ref="${f}"/>`).join('')}</mergeCells>` : ''}<pageMargins left="${pg}" right="${pd}" top="${ph}" bottom="${pb}" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>${g.imgs.length ? '<drawing r:id="rDessin"/>' : ''}</worksheet>`;
  const dessin = `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${g.imgs.map((im, n) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${im.c0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${im.r0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${emu(im.w * K)}" cy="${emu(im.h * K)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${n + 2}" name="Image ${n + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rImg${med.get(im.src).n}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(im.w * K)}" cy="${emu(im.h * K)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('')}</xdr:wsDr>`;
  const styles = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${bords.length}">${bords.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs></styleSheet>`;
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${g.imgs.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}</Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="${x(m.titre.replace(/[\\/?*[\]:]/g, '-').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', sheet], ['xl/styles.xml', styles],
    ...(g.imgs.length ? [
      ['xl/worksheets/_rels/sheet1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDessin" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`],
      ['xl/drawings/drawing1.xml', dessin],
      ['xl/drawings/_rels/drawing1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[...med.values()].map(i => `<Relationship Id="rImg${i.n}" Type="${REL}/image" Target="../media/image${i.n}.${i.ext}"/>`).join('')}</Relationships>`],
      ...[...med.values()].map(i => [`xl/media/image${i.n}.${i.ext}`, i.data]),
    ] : []),
  ]);
}
