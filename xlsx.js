// Fichier Excel (.xlsx) → grille HTML fidèle (fusions, couleurs, bordures, polices, largeurs), pour que Claude voie la mise en page.
// Sans dépendance : un .xlsx est un zip de XML.
import zlib from 'node:zlib';

function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw Object.assign(new Error('Fichier Excel illisible : enregistrez-le au format .xlsx.'), { status: 400 });
  const files = new Map();
  for (let i = 0, p = buf.readUInt32LE(e + 16); i < buf.readUInt16LE(e + 10); i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), n = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + n);
    p += 46 + n + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + size);
    files.set(name, () => (method ? zlib.inflateRawSync(data, { maxOutputLength: 50e6 }) : data).toString('utf8'));
  }
  return name => files.get(name)?.() || '';
}

const ent = s => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (_, c) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[c.toLowerCase()]
  ?? String.fromCodePoint(c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : +c.slice(1)));
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const attr = (tag, a) => (new RegExp(`\\b${a}="([^"]*)"`).exec(tag) || [])[1];
const all = (xml, tag) => xml.match(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g')) || [];
const texte = xml => all(xml, 't').map(t => ent(t.replace(/<[^>]+>/g, ''))).join('');
const col = ref => [...ref.replace(/\d/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const cell = ref => [+ref.replace(/\D/g, '') - 1, col(ref)];

// Couleur Excel (rgb, thème + teinte) → #rrggbb.
// ponytail: teinte appliquée en RGB (mélange avec blanc/noir), pas en HSL comme Excel ; écart minime à l'œil.
function couleur(tag, theme) {
  if (!tag) return;
  let hex = attr(tag, 'rgb')?.slice(-6) || theme[+attr(tag, 'theme')];
  if (!hex) return;
  const t = +(attr(tag, 'tint') || 0);
  if (t) hex = hex.match(/../g).map(h => { const c = parseInt(h, 16); return Math.round(t < 0 ? c * (1 + t) : c + (255 - c) * t).toString(16).padStart(2, '0'); }).join('');
  return '#' + hex;
}

export function xlsxToHtml(buf) {
  const read = unzip(buf);
  const wb = read('xl/workbook.xml'), rels = read('xl/_rels/workbook.xml.rels');
  const sheets = all(wb, 'sheet'), active = sheets[+(attr(all(wb, 'workbookView')[0] || '', 'activeTab') || 0)] || sheets[0];
  if (!active) throw Object.assign(new Error('Aucune feuille dans ce fichier Excel.'), { status: 400 });
  const target = attr(all(rels, 'Relationship').find(r => attr(r, 'Id') === attr(active, 'r:id')) || '', 'Target') || 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const sheet = read(sheetPath);

  // Thème : ordre Excel lt1, dk1, lt2, dk2, accent1…6
  const sch = (/<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(read('xl/theme/theme1.xml')) || [''])[0];
  const clr = n => { const m = new RegExp(`<a:${n}>[\\s\\S]*?(?:val|lastClr)="([\\dA-Fa-f]{6})"`).exec(sch); return m?.[1]; };
  const theme = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(clr);
  theme.splice(0, 4, theme[0] || 'FFFFFF', theme[1] || '000000', theme[2], theme[3]);

  const st = read('xl/styles.xml');
  const sect = n => (new RegExp(`<${n}\\b[\\s\\S]*?</${n}>`).exec(st) || [''])[0];
  const fmts = Object.fromEntries(all(st, 'numFmt').map(f => [attr(f, 'numFmtId'), ent(attr(f, 'formatCode') || '')]));
  const fonts = all(sect('fonts'), 'font').map(f => [
    /<b\/>|<b val="(1|true)"/.test(f) && 'font-weight:700', /<i\/>|<i val="(1|true)"/.test(f) && 'font-style:italic', /<u\b/.test(f) && 'text-decoration:underline',
    attr(all(f, 'sz')[0] || '', 'val') && `font-size:${attr(all(f, 'sz')[0], 'val')}pt`, attr(all(f, 'name')[0] || '', 'val') && `font-family:"${attr(all(f, 'name')[0], 'val')}"`,
    couleur(all(f, 'color')[0], theme) && `color:${couleur(all(f, 'color')[0], theme)}`].filter(Boolean).join(';'));
  const fills = all(sect('fills'), 'fill').map(f => { const c = /patternType="solid"/.test(f) && couleur(all(f, 'fgColor')[0], theme); return c ? `background:${c}` : ''; });
  const W = { thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', mediumDashed: '2px dashed', dotted: '1px dotted', double: '3px double' };
  const borders = all(sect('borders'), 'border').map(b => ['left', 'right', 'top', 'bottom'].map(s => {
    const t = all(b, s)[0] || '', w = W[attr(t, 'style')];
    return w ? `border-${s}:${w} ${couleur(all(t, 'color')[0], theme) || '#000'}` : '';
  }).filter(Boolean).join(';'));
  const xfs = all(sect('cellXfs'), 'xf').map(x => {
    const al = all(x, 'alignment')[0] || '', h = attr(al, 'horizontal'), v = attr(al, 'vertical');
    return {
      fmt: fmts[attr(x, 'numFmtId')] || attr(x, 'numFmtId'),
      css: [+attr(x, 'fontId') ? fonts[+attr(x, 'fontId')] : '', /* police 0 = police par défaut du classeur */fills[+attr(x, 'fillId') || 0], borders[+attr(x, 'borderId') || 0],
        h && h !== 'general' && `text-align:${h === 'centerContinuous' ? 'center' : h}`, v && `vertical-align:${v === 'center' ? 'middle' : v}`,
        attr(al, 'wrapText') === '1' && 'white-space:pre-wrap'].filter(Boolean).join(';'),
    };
  });

  const shared = all(read('xl/sharedStrings.xml'), 'si').map(texte);
  const valeur = (c, xf) => {
    const t = attr(c, 't'), v = ent((/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1] || '');
    if (t === 's') return shared[+v] ?? '';
    if (t === 'inlineStr') return texte(c);
    if (t === 'str' || t === 'b' || t === 'e' || v === '') return v;
    const n = +v, f = String(xf?.fmt || '');
    if (/%/.test(f) || f === '9' || f === '10') return (n * 100).toLocaleString('fr-FR') + ' %';
    if (/^(1[4-9]|2[0-2])$/.test(f) || /d.*m|m.*y/i.test(f.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) return new Date(Date.UTC(1899, 11, 30) + n * 864e5).toLocaleDateString('fr-FR');
    return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + (/€/.test(f) ? ' €' : '');
  };

  // Cellules, fusions, images (logo) ancrées dans la feuille
  const MAXR = 200, MAXC = 30, grid = {};
  let nr = 0, nc = 0;
  const hauteurs = {};
  for (const r of all(sheet, 'row')) {
    const ri = +attr(r, 'r') - 1;
    if (ri >= MAXR) break;
    if (attr(r, 'ht')) hauteurs[ri] = +attr(r, 'ht');
    for (const c of all(r, 'c')) {
      const [y, x] = cell(attr(c, 'r')), s = +(attr(c, 's') || 0);
      if (x >= MAXC) continue;
      // Excel aligne les nombres à droite par défaut
      grid[`${y},${x}`] = { s, v: valeur(c, xfs[s]), droite: !attr(c, 't') && /<v>/.test(c) && !/text-align/.test(xfs[s]?.css) };
      if (grid[`${y},${x}`].v !== '' || xfs[s]?.css.includes('background') || xfs[s]?.css.includes('border')) { nr = Math.max(nr, y + 1); nc = Math.max(nc, x + 1); }
    }
  }
  const spans = {}, caches = new Set();
  for (const m of all(sheet, 'mergeCell')) {
    const [a, b] = attr(m, 'ref').split(':'), [y1, x1] = cell(a), [y2, x2] = cell(b);
    spans[`${y1},${x1}`] = [y2 - y1 + 1, x2 - x1 + 1];
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) if (y !== y1 || x !== x1) caches.add(`${y},${x}`);
  }
  const srels = read(sheetPath.replace(/([^/]+)$/, '_rels/$1.rels'));
  const drawing = attr(all(srels, 'Relationship').find(r => /\/drawing$/.test(attr(r, 'Type') || '')) || '', 'Target');
  const dessin = drawing ? read('xl/' + drawing.replace(/^(\.\.\/)+|^\/?xl\//, '')) : '';
  const ancres = new Set((dessin.match(/<(\w+:)?from>[\s\S]*?<\/(\w+:)?from>/g) || []).map(f => `${/<(?:\w+:)?row>(\d+)/.exec(f)?.[1]},${/<(?:\w+:)?col>(\d+)/.exec(f)?.[1]}`));
  nr = Math.max(nr, ...[...ancres].map(a => +a.split(',')[0] + 1)); nc = Math.max(nc, ...[...ancres].map(a => +a.split(',')[1] + 1));
  if (!nr) throw Object.assign(new Error('La feuille Excel est vide.'), { status: 400 });

  const larg = {};
  for (const c of all(sheet, 'col')) for (let i = +attr(c, 'min') - 1; i < Math.min(+attr(c, 'max'), MAXC); i++) larg[i] = +attr(c, 'width');
  const defW = +(attr(all(sheet, 'sheetFormatPr')[0] || '', 'defaultColWidth') || 9.14);
  let rows = '';
  for (let y = 0; y < nr; y++) {
    rows += `<tr style="height:${Math.round((hauteurs[y] || 15) * 4 / 3)}px">`;
    for (let x = 0; x < nc; x++) {
      const k = `${y},${x}`;
      if (caches.has(k)) continue;
      const g = grid[k], sp = spans[k];
      rows += `<td${g?.s ? ` class="x${g.s}"` : ''}${g?.droite ? ' style="text-align:right"' : ''}${sp?.[0] > 1 ? ` rowspan="${sp[0]}"` : ''}${sp?.[1] > 1 ? ` colspan="${sp[1]}"` : ''}>${ancres.has(k) ? '<span class="img">[image : logo ?]</span>' : ''}${esc(g?.v ?? '')}</td>`;
    }
    rows += '</tr>\n';
  }
  const used = new Set(Object.values(grid).map(g => g.s));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:16px;background:#fff;font:11pt Calibri,Arial,sans-serif}table{border-collapse:collapse;table-layout:fixed}td{padding:1px 4px;overflow:hidden;vertical-align:bottom;white-space:nowrap}
.img{display:inline-block;border:1px dashed #888;color:#888;padding:6px 10px;font-size:9pt}
${[...used].filter(s => xfs[s]?.css).map(s => `.x${s}{${xfs[s].css}}`).join('\n')}
</style></head><body><table><colgroup>${Array.from({ length: nc }, (_, x) => `<col style="width:${Math.round((larg[x] || defW) * 7 + 5)}px">`).join('')}</colgroup>
${rows}</table></body></html>`;
}

// Devis ou facture Word (.docx) → texte lisible par Claude : paragraphes, tableaux en lignes « cellule | cellule », en-têtes et pieds de page.
export function docxTexte(buf) {
  const z = unzip(buf), parts = ['word/document.xml', ...[1, 2, 3].flatMap(i => [`word/header${i}.xml`, `word/footer${i}.xml`])].map(z).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error('Fichier Word illisible : enregistrez-le en .docx ou en PDF.'), { status: 400 });
  const cellule = x => ent(x.replace(/<w:tab\/>|<w:br\/>|<\/w:p>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return parts.join('\n').replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '') // zones de texte : en double (version de secours)
    .replace(/<(wp(?:14)?):(\w+)\b[^>]*>[^<]*<\/\1:\2>/g, '') // position des images et zones de texte (nombres sans intérêt)
    .replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, tr => '\n' + (tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map(cellule).join(' | ') + '\n')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .split('\n').map(l => ent(l).replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
