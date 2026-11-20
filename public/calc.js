// Calculs partagés navigateur + serveur. Montants arrondis au centime ligne par ligne.
export const r2 = n => Math.round((+n || 0) * 100) / 100;
export const eur = n => (+n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Totaux d'un document. La remise globale (%) ne s'applique pas aux lignes `hors_remise` (déductions d'acompte).
export function totaux(data, franchise = false) {
  const k = 1 - (+data.remise_pct || 0) / 100;
  const parTaux = {};
  let brut = 0;
  for (const l of data.lignes || []) {
    if (l.type === 'section') continue;
    const m = r2(l.qte * l.pu);
    brut += m;
    const t = franchise ? 0 : +l.tva || 0;
    parTaux[t] = (parTaux[t] || 0) + m * (l.hors_remise ? 1 : k);
  }
  const bases = Object.entries(parTaux)
    .map(([t, base]) => ({ taux: +t, base: r2(base), montant: r2(r2(base) * t / 100) }))
    .sort((a, b) => a.taux - b.taux);
  const ht = r2(bases.reduce((s, b) => s + b.base, 0));
  const tva = bases.filter(b => b.taux > 0);
  return { brut: r2(brut), remise: r2(brut - ht), ht, bases, tva, ttc: r2(ht + tva.reduce((s, b) => s + b.montant, 0)) };
}

// Facture d'acompte : une ligne par taux de TVA du devis, au prorata.
export function lignesAcompte(devis, pct, franchise = false) {
  const { bases } = totaux(devis.data, franchise);
  return bases.map(b => ({
    type: 'ligne',
    designation: `Acompte ${pct} % sur devis ${devis.numero || ''}${bases.length > 1 ? ` (TVA ${b.taux} %)` : ''}`.trim(),
    description: devis.data.objet || '', qte: 1, unite: 'forfait', pu: r2(b.base * pct / 100), tva: b.taux,
  }));
}

// Facture de solde : lignes du devis moins les acomptes déjà facturés.
export function lignesSolde(devis, acomptes) {
  const ded = acomptes.flatMap(f => (f.data.lignes || []).filter(l => l.type !== 'section').map(l => ({
    type: 'ligne', designation: `Déduction ${f.numero || 'acompte'} : ${l.designation}`, description: '',
    qte: 1, unite: 'forfait', pu: -r2(l.qte * l.pu), tva: l.tva, hors_remise: true,
  })));
  return [...devis.data.lignes, ...(ded.length ? [{ type: 'section', designation: 'Acomptes déjà facturés' }, ...ded] : [])];
}

// Situation de travaux n° n : avancement cumulé (pct) appliqué au devis, moins ce qui est déjà facturé
// (situations et acomptes précédents), taux de TVA par taux de TVA.
export function lignesSituation(devis, pct, deja, n, franchise = false) {
  const { bases } = totaux(devis.data, franchise);
  return bases.map(b => {
    const cumul = r2(b.base * pct / 100);
    const avant = r2(deja.flatMap(f => f.data.lignes || []).filter(l => l.type !== 'section' && (franchise ? 0 : +l.tva || 0) === b.taux).reduce((s, l) => s + r2(l.qte * l.pu), 0));
    return {
      type: 'ligne', designation: `Situation n° ${n} : travaux réalisés à ${pct} % sur devis ${devis.numero || ''}${bases.length > 1 ? ` (TVA ${b.taux} %)` : ''}`.trim(),
      description: `Cumul ${eur(cumul)} HT, déjà facturé ${eur(avant)} HT`, qte: 1, unite: 'forfait', pu: r2(cumul - avant), tva: b.taux,
    };
  });
}

// Retenue de garantie (loi du 16 juillet 1971, 5 % au plus) : part du TTC que le client garde un an après la réception des travaux.
export const retenue = (data, ttc) => r2(ttc * (+data.retenue_pct || 0) / 100);

// Dépenses : catégorie → [libellé, compte de charge, libellé du compte] (plan comptable général ; le comptable ajuste s'il veut).
export const CATEGORIES = {
  materiaux: ['Matériaux', '601000', 'Achats de matériaux'], sous_traitance: ['Sous-traitance', '604000', 'Sous-traitance'],
  location: ['Location de matériel', '613500', 'Locations de matériel'], outillage: ['Petit outillage', '606300', 'Petit outillage'],
  carburant: ['Carburant', '606100', 'Carburant'], autre: ['Autre', '606800', 'Autres achats'],
};

// Écritures comptables (journaux VT ventes, BQ banque, CA caisse, AC achats), chacune équilibrée, pour le fichier FEC.
// ponytail: les factures d'acompte passent en 704 comme les autres (pas de 4191 « avances clients ») et la retenue de garantie reste au 411 : le comptable reclasse.
export function ecritures({ factures = [], paiements = [], depenses = [], franchise = false }) {
  const cli = (id, nom) => ['411000', 'Clients', 'C' + String(id || 0).padStart(5, '0'), nom || 'Client'];
  const L = ([compte, lib, aux = '', auxLib = ''], m, texte = '') => ({ compte, lib, aux, auxLib, texte, debit: m > 0 ? r2(m) : 0, credit: m < 0 ? r2(-m) : 0 });
  const out = [];
  for (const f of factures) {
    const t = totaux(f.data, franchise);
    out.push({ journal: 'VT', date: f.date, piece: f.numero, lib: `${f.kind === 'avoir' ? 'Avoir' : 'Facture'} ${f.numero} ${f.client_nom || ''}`.trim(), lignes: [
      L(cli(f.client_id, f.client_nom), t.ttc),
      ...t.bases.map(b => L(['704000', 'Travaux'], -b.base, t.bases.length > 1 ? `${f.numero} base TVA ${b.taux} %` : '')),
      ...t.tva.map(b => L(['445710', 'TVA collectée'], -b.montant, `${f.numero} TVA ${b.taux} %`)),
    ] });
  }
  for (const p of paiements) {
    const caisse = p.mode === 'Espèces';
    out.push({ journal: caisse ? 'CA' : 'BQ', date: p.date, piece: p.numero, lib: `Règlement ${p.numero} ${p.client_nom || ''}`.trim(), lignes: [
      L(caisse ? ['530000', 'Caisse'] : ['512000', 'Banque'], p.montant), L(cli(p.client_id, p.client_nom), -p.montant)] });
  }
  for (const d of depenses) {
    const [, compte, lib] = CATEGORIES[d.categorie] || CATEGORIES.autre, ttc = r2(d.ttc), tva = franchise ? 0 : r2(d.tva); // franchise : TVA non récupérable, tout en charge
    const four = String(d.fournisseur || '').trim() || 'Divers';
    out.push({ journal: 'AC', date: d.date, piece: 'DEP-' + d.id, lib: `${four} ${d.libelle || ''}`.trim(), lignes: [
      L([compte, lib], r2(ttc - tva)), L(['445660', 'TVA déductible'], tva),
      L(['401000', 'Fournisseurs', 'F' + (four.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || 'DIVERS'), four], -ttc)] });
  }
  const n = {};
  return out.map(e => ({ ...e, lignes: e.lignes.filter(l => l.debit || l.credit) })).filter(e => e.lignes.length)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.journal.localeCompare(b.journal))
    .map(e => ({ ...e, num: e.journal + String((n[e.journal] = (n[e.journal] || 0) + 1)).padStart(5, '0') }));
}
