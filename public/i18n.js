// Langue de l'interface. Le français écrit dans app.js reste la source : le serveur en tire tous les textes (extraire),
// Claude les traduit une fois par langue (i18n/<langue>.json), puis le navigateur remplace les textes affichés (observer).
// Les documents (devis, factures) restent en français : ils sont dans une iframe, jamais touchée.

// Textes d'un fichier JS : chaînes '…', "…" et `…` ; les ${…} deviennent {0}, {1}… ; coupées aux balises HTML.
export function extraire(src) {
  const out = new Set(), n = src.length;
  let i = 0;
  const garder = s => {
    // « ${icon()}Nouveau client » : à l'écran le texte est seul ; on garde aussi la version sans les {n} du bord
    // les attributs traduits à l'écran (title="…", placeholder="…"…) comptent aussi
    const attrs = [...s.matchAll(/\b(?:title|placeholder|aria-label|data-c)="([^"]+)"/g)].map(m => m[1]);
    for (let t of [...s.split(/<[^>]*>/), ...attrs].flatMap(x => [x, x.replace(/^(\s*\{\d+\})+|(\{\d+\}\s*)+$/g, '')])) {
      t = t.replace(/&nbsp;/g, ' ').trim();
      // texte lisible : au moins 2 lettres, une minuscule, et un espace, un accent ou une majuscule au début (pas un nom de classe CSS)
      if (t.length < 300 && /\p{Ll}/u.test(t) && /\p{L}{2}/u.test(t) && (/\s|[à-ÿ’]/.test(t) || /^\p{Lu}/u.test(t))
        && !/[;=$#\\|&]|=>|\(\)|^[.#\[]|rgba?\(|\dpx|^(Content-|application\/|image\/)/.test(t)) out.add(t);
    }
  };
  const chaine = () => {
    const q = src[i++];
    let t = '', k = 0;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { t += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue; }
      if (q === '`' && src[i] === '$' && src[i + 1] === '{') { i += 2; code(true); t += `{${k++}}`; continue; }
      t += src[i++];
    }
    i++;
    garder(t);
  };
  // parcourt du code (jusqu'à l'accolade qui ferme le ${…} si dansGabarit) en ramassant les chaînes
  const code = dansGabarit => {
    let prof = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) i = n; continue; }
      if (c === '/' && src[i + 1] === '*') { const f = src.indexOf('*/', i); i = f < 0 ? n : f + 2; continue; }
      if (c === '/') {
        const avant = src.slice(Math.max(0, i - 12), i).trimEnd();
        if (!avant || /[(,=:[!&|?{};+\-*%<>~^}]$/.test(avant) || /\b(return|typeof|case|in|of)$/.test(avant)) { // expression régulière
          let cl = false;
          for (i++; i < n && (cl || src[i] !== '/'); i++) { if (src[i] === '\\') i++; else if (src[i] === '[') cl = true; else if (src[i] === ']') cl = false; }
          i++;
          continue;
        }
      }
      if (c === "'" || c === '"' || c === '`') { chaine(); continue; }
      if (c === '{') prof++;
      if (c === '}') { if (!prof && dansGabarit) { i++; return; } prof--; }
      i++;
    }
  };
  code(false);
  return [...out];
}

// Fonction texte français → texte traduit (inchangé si inconnu). Les {n} prennent ce qui est à leur place à l'écran.
export function traducteur(dict) {
  const exact = new Map(), motifs = [];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [src, dst] of Object.entries(dict)) {
    if (!dst || dst === src) continue;
    const morceaux = src.split(/\{(\d+)\}/);
    if (morceaux.length === 1) { exact.set(src, dst); continue; }
    const fixes = morceaux.filter((_, j) => j % 2 === 0);
    // ponytail: un motif trop court (« {0} sur {1} ») attraperait les textes de l'artisan ; on exige 5 lettres fixes
    if ((fixes.join('').match(/\p{L}/gu) || []).length < 5) continue;
    motifs.push({
      re: new RegExp('^' + morceaux.map((m, j) => j % 2 ? '(.+?)' : esc(m)).join('') + '$', 's'),
      ordre: morceaux.filter((_, j) => j % 2).map(Number),
      cle: fixes.reduce((a, b) => b.length > a.length ? b : a, ''),
      dst,
    });
  }
  motifs.sort((a, b) => b.cle.length - a.cle.length);
  return t => {
    const s = t.trim();
    if (!s || !/\p{L}/u.test(s)) return t;
    let r = exact.get(s);
    if (r == null) for (const m of motifs) {
      const x = s.includes(m.cle) && m.re.exec(s);
      if (x) { r = m.dst.replace(/\{(\d+)\}/g, (_, k) => x[m.ordre.indexOf(+k) + 1] ?? ''); break; }
    }
    return r == null ? t : t.replace(s, () => r);
  };
}

// Traduit la page et tout ce qui s'y affiche ensuite. Renvoie de quoi changer de dictionnaire.
const ATTRS = ['placeholder', 'title', 'aria-label', 'data-c'], EXCLU = 'script,style,textarea,[contenteditable],[translate=no]';
export function observer(tr, racine = document.body) {
  const attrs = el => { for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const w = tr(v); if (w !== v) el.setAttribute(a, w); } } };
  const noeud = x => {
    if (x.nodeType === 3) {
      if (x.parentElement?.closest(EXCLU)) return;
      const w = tr(x.data);
      if (w !== x.data) x.data = w;
    } else if (x.nodeType === 1 && !x.closest(EXCLU)) {
      attrs(x);
      x.querySelectorAll(ATTRS.map(a => `[${a}]`).join()).forEach(e => e.closest(EXCLU) || attrs(e));
      const w = document.createTreeWalker(x, NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode());) noeud(t);
    }
  };
  new MutationObserver(ms => ms.forEach(m => m.type === 'childList' ? m.addedNodes.forEach(noeud) : m.type === 'attributes' ? attrs(m.target) : noeud(m.target)))
    .observe(racine, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  noeud(racine);
  return { changer: t => { tr = t; noeud(racine); } };
}
