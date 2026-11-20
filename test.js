// Vérifications des calculs d'argent et du rendu. Lancer : npm test
import assert from 'node:assert/strict';
import { totaux, lignesAcompte, lignesSolde, lignesSituation, retenue, r2 } from './public/calc.js';
import { renderDoc, fill, BUILTINS, SAMPLE } from './templates.js';

const devis = { numero: 'DEV-2026-0001', data: { remise_pct: 10, lignes: [
  { type: 'section', designation: 'Lot 1' },
  { type: 'ligne', designation: 'A', qte: 18, pu: 55, tva: 10 },   // 990
  { type: 'ligne', designation: 'B', qte: 1, pu: 1000, tva: 20 },  // 1000
] } };
const t = totaux(devis.data);
assert.equal(t.brut, 1990);
assert.equal(t.ht, 1791);                       // 891 + 900
assert.deepEqual(t.tva.map(v => v.montant), [89.1, 180]);
assert.equal(t.ttc, 2060.1);
assert.equal(totaux(devis.data, true).ttc, 1791); // franchise : pas de TVA

// Acompte 30 % puis solde : la somme des factures = le devis.
const ac = { numero: 'FAC-2026-0001', data: { lignes: lignesAcompte(devis, 30) } };
assert.equal(ac.data.lignes.length, 2);
const tac = totaux(ac.data);
const solde = { data: { remise_pct: 10, lignes: lignesSolde(devis, [ac]) } };
const tso = totaux(solde.data);
assert.equal(Math.round((tac.ttc + tso.ttc) * 100) / 100, t.ttc);
assert.equal(Math.round((tac.ht + tso.ht) * 100) / 100, t.ht);

// Situations 30 % puis 70 % (cumulés) après l'acompte, puis solde : la somme des factures = le devis.
const s1 = { data: { lignes: lignesSituation(devis, 30, [ac], 1) } };
assert.equal(totaux(s1.data).ht, 0);              // 30 % déjà couverts par l'acompte de 30 %
const s2 = { data: { lignes: lignesSituation(devis, 70, [ac, s1], 2) } };
assert.equal(totaux(s2.data).ht, r2(t.ht * 0.4));
const fin = { data: { remise_pct: 10, lignes: lignesSolde(devis, [ac, s1, s2]) } };
assert.equal(r2(tac.ttc + totaux(s1.data).ttc + totaux(s2.data).ttc + totaux(fin.data).ttc), t.ttc);
assert.equal(retenue({ retenue_pct: 5 }, 2060.1), 103.01);

// Moteur de gabarit : échappement par défaut, brut avec triples accolades.
assert.equal(fill('{{a}}|{{{a}}}|{{b.c}}', { a: '<b>', b: { c: 1 } }), '&lt;b&gt;|<b>|1');
const html = renderDoc(SAMPLE, { nom: 'ACME <script>', couleur: '#123456' }, BUILTINS[0].html);
assert.ok(html.includes('Pose de faïence murale') && html.includes('ACME &lt;script&gt;') && !html.includes('{{'));
// Colonnes choisies par le modèle (import d'un devis à 4 colonnes) ; secrets jamais affichables.
const quatre = renderDoc(SAMPLE, { nom: 'X', stripe_secret: 'sk_live_x' }, '<meta name="kadra-colonnes" content="designation=Description;qte=Quantité;pu=Prix unitaire;total=Montant">{{{lignes}}}{{entreprise.stripe_secret}}');
assert.deepEqual([...quatre.matchAll(/<th\s[^>]*>([^<]*)/g)].map(m => m[1]), ['Description', 'Quantité', 'Prix unitaire', 'Montant']);
assert.ok(quatre.includes('18 m²') && !quatre.includes('Sous-total') && !quatre.includes('sk_live'));
assert.ok(html.includes('Sous-total Carrelage')); // modèles intégrés : colonnes et sous-totaux d'origine
// « {{x}}} » (accolade du CSS collée à une balise) est lu comme une balise brute et casse la fin du style du modèle.
for (const t of BUILTINS) assert.ok(!/(^|[^{])\{\{[^{}]+\}\}\}/.test(t.html), `accolade collée à une balise dans « ${t.nom} »`);
const simple = renderDoc(SAMPLE, { nom: 'X' }, BUILTINS.find(t => t.nom === 'Simple').html);
assert.ok(simple.includes('@page{margin:8mm}') && !simple.includes('>1.1<'));
console.log('OK : tous les tests passent');

// Factur-X (EN 16931) : cohérence des montants, y compris remise multi-taux, franchise et avoir.
import { ciiXml } from './pdf.js';
const tag = (xml, t) => [...xml.matchAll(new RegExp(`<ram:${t}[^>]*>([-0-9.]+)</ram:${t}>`, 'g'))].map(m => +m[1]);
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} ≠ ${b}`);
for (const [doc, s] of [
  [{ numero: 'FAC-1', date: '2026-10-30', data: devis.data }, { nom: 'X', siret: '12345678900012' }],
  [{ numero: 'FAC-2', date: '2026-10-30', data: solde.data }, { nom: 'X' }],
  [{ numero: 'FAC-3', date: '2026-10-30', data: devis.data }, { nom: 'X', franchise_tva: true }],
  [{ numero: 'AV-1', kind: 'avoir', parent_numero: 'FAC-1', date: '2026-10-30', data: { ...devis.data, lignes: devis.data.lignes.map(l => ({ ...l, pu: -l.pu || 0 })) } }, { nom: 'X' }],
]) {
  const x = ciiXml(doc, s);
  const [lignes, entete] = [tag(x, 'LineTotalAmount').slice(0, -1), tag(x, 'LineTotalAmount').at(-1)];
  close(lignes.reduce((a, b) => a + b, 0), entete);                                       // BR-CO-10
  close(entete - (tag(x, 'AllowanceTotalAmount')[0] || 0), tag(x, 'TaxBasisTotalAmount')[0]); // BR-CO-13
  close(tag(x, 'BasisAmount').reduce((a, b) => a + b, 0), tag(x, 'TaxBasisTotalAmount')[0]);
  close(tag(x, 'CalculatedAmount').reduce((a, b) => a + b, 0), tag(x, 'TaxTotalAmount')[0]); // BR-CO-14
  close(tag(x, 'TaxBasisTotalAmount')[0] + tag(x, 'TaxTotalAmount')[0], tag(x, 'GrandTotalAmount')[0]); // BR-CO-15
  assert.ok(tag(x, 'ChargeAmount').every(v => v >= 0));                                     // BR-27 : prix net jamais négatif
  assert.ok(tag(x, 'GrandTotalAmount')[0] >= 0);                                             // avoir : montants positifs, type 381
}
console.log('OK : Factur-X cohérent');

// Aperçu en direct : JSON coupé à n'importe quel endroit → objet lisible, et le JSON complet → identique.
import { partialJSON } from './templates.js';
const complet = JSON.stringify({ objet: 'Salle de bain "Lilas"', client: { nom: 'Mme Martin' }, lignes: [{ type: 'ligne', designation: 'Faïence', qte: 18, pu: 55.5 }, { type: 'section', designation: 'Plomberie' }] });
for (let i = 1; i < complet.length; i++) { const p = partialJSON(complet.slice(0, i)); assert.ok(p === undefined || typeof p === 'object', complet.slice(0, i)); }
assert.deepEqual(partialJSON(complet), JSON.parse(complet));
assert.deepEqual(partialJSON('{"objet": "Trav'), { objet: 'Trav' });
assert.deepEqual(partialJSON('{"objet":"x","lig'), { objet: 'x' });
assert.equal(partialJSON('{"lignes":[{"designation":"A","pu": 4').lignes[0].pu, 4);
console.log('OK : aperçu en direct');

// Excel → grille HTML : zip minimal écrit ici (deflate), texte partagé, fusion, couleur de fond, pourcentage.
import zlib from 'node:zlib';
import { xlsxToHtml } from './xlsx.js';
function zip(files) {
  const loc = [], cen = [];
  let off = 0;
  for (const [name, txt] of Object.entries(files)) {
    const n = Buffer.from(name), raw = Buffer.from(txt), data = zlib.deflateRawSync(raw);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(8, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    loc.push(l, n, data); cen.push(c, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(cen.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cd, e]);
}
const grille = xlsxToHtml(zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Devis" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>DEVIS &amp; FACTURE</t></si></sst>',
  'xl/styles.xml': '<styleSheet><fonts><font/><font><b/><color rgb="FFC83C1E"/></font></fonts><fills><fill/><fill/><fill><patternFill patternType="solid"><fgColor rgb="FFFBE9E5"/></patternFill></fill></fills><borders><border/></borders><cellXfs><xf/><xf fontId="1" fillId="2"/><xf numFmtId="9"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" s="1" t="s"><v>0</v></c></row><row r="2"><c r="B2" s="2"><v>0.3</v></c></row></sheetData><mergeCells><mergeCell ref="A1:C1"/></mergeCells></worksheet>',
}));
assert.match(grille, /<td class="x1" colspan="3">DEVIS &amp; FACTURE<\/td>/);
assert.match(grille, /\.x1\{font-weight:700;color:#C83C1E;background:#FBE9E5\}/);
assert.match(grille, />30 %</);
console.log('OK : import Excel');

// Écritures comptables (FEC) : chaque écriture équilibrée, avoir à l'envers, franchise sans TVA.
import { ecritures } from './public/calc.js';
const avoirData = { lignes: [{ type: 'ligne', qte: 1, pu: -100, tva: 20 }] };
const ecr = ecritures({
  factures: [{ numero: 'FAC-1', date: '2026-03-02', client_id: 7, client_nom: 'Martin', data: devis.data }, { numero: 'AV-1', kind: 'avoir', date: '2026-03-05', client_id: 7, data: avoirData }],
  paiements: [{ date: '2026-03-10', montant: 500, mode: 'Espèces', numero: 'FAC-1', client_id: 7 }, { date: '2026-03-11', montant: 1460.1, mode: 'Virement', numero: 'FAC-1', client_id: 7 }],
  depenses: [{ id: 3, date: '2026-03-01', fournisseur: 'Point P', categorie: 'materiaux', ttc: 120, tva: 20 }],
});
for (const e of ecr) close(e.lignes.reduce((s, l) => s + l.debit, 0), e.lignes.reduce((s, l) => s + l.credit, 0));
assert.deepEqual(ecr.map(e => e.num), ['AC00001', 'VT00001', 'VT00002', 'CA00001', 'BQ00001']);
const vt = ecr[1].lignes;
assert.equal(vt[0].debit, t.ttc); assert.equal(vt[0].aux, 'C00007');
assert.deepEqual(vt.filter(l => l.compte === '445710').map(l => l.credit), [89.1, 180]);
assert.equal(ecr[2].lignes[0].credit, 120); // avoir : client crédité
assert.deepEqual(ecr[0].lignes.map(l => [l.compte, l.debit, l.credit]), [['601000', 100, 0], ['445660', 20, 0], ['401000', 0, 120]]);
assert.equal(ecr[0].lignes[2].aux, 'FPOINTP');
const fr = ecritures({ factures: [{ numero: 'FAC-1', date: '2026-03-02', data: devis.data }], depenses: [{ id: 1, date: '2026-03-01', ttc: 120, tva: 20 }], franchise: true });
assert.ok(fr.every(e => e.lignes.every(l => !l.compte.startsWith('4456') && !l.compte.startsWith('4457'))));
assert.equal(fr.find(e => e.journal === 'AC').lignes[0].debit, 120); // franchise : TVA non récupérable
console.log('OK : écritures comptables');

// Langue de l'interface : extraction des textes et remplacement à l'écran
{
  const { extraire, traducteur } = await import('./public/i18n.js');
  const t = extraire("const a = 'btn primary', b = `${icon('x')}Nouveau client`; // 'Commentaire ignoré'\nx = s.replace(/'/g, '') + `<b>${n}</b> jours de retard` + \"Mot de passe\";");
  assert.ok(t.includes('Nouveau client') && t.includes('jours de retard') && t.includes('Mot de passe'));
  assert.ok(!t.some(x => x.includes('Commentaire')));
  const tr = traducteur({ 'Mot de passe': 'Şifre', '{0} jours de retard': '{0} gün gecikme', '{0} sur {1}': '{1} içinde {0}', '{0} doit {1} depuis le {2}': '{2} tarihinden beri {0}, {1} borçlu' });
  assert.equal(tr('  Mot de passe '), '  Şifre ');
  assert.equal(tr('12 jours de retard'), '12 gün gecikme');
  assert.equal(tr('M. Girard doit 300 € depuis le 2 mars'), '2 mars tarihinden beri M. Girard, 300 € borçlu');
  assert.equal(tr('Pose de faïence sur mur'), 'Pose de faïence sur mur'); // motif trop court : texte de l'artisan intact
  assert.equal(tr('8 420,00 €'), '8 420,00 €');
}
console.log('Langue de l’interface : OK');
