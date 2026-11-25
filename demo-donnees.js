// Données de l'entreprise d'exemple « Yildiz Rénovation » : un an d'activité (clients, devis, factures, chantiers, e-mails, agenda, dépenses, notes).
// Servent à la démo (demo.js, port 3001) et à la présentation de la 1re connexion (server.js : compte « bac à sable » effacé à la fin).
// Dates calées sur le 31/10/2026 ; jours = décalage pour que « aujourd'hui » tombe au même endroit de l'histoire.
import crypto from 'node:crypto';
import { totaux, lignesAcompte, lignesSolde, r2, eur } from './public/calc.js';

export function remplirDemo(db, cid, { url: URL, jours = 0 } = {}) {
  const ins = (t, o) => { const k = Object.keys(o); return Number(db.prepare(`INSERT INTO ${t} (${k}) VALUES (${k.map(() => '?')})`).run(...k.map(x => (o[x] && typeof o[x] === 'object' ? JSON.stringify(o[x]) : o[x] ?? null))).lastInsertRowid); };
  const set = (t, id, o) => { const k = Object.keys(o); db.prepare(`UPDATE ${t} SET ${k.map(x => `${x}=?`)} WHERE id=?`).run(...k.map(x => o[x]), id); };
  const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5).toISOString().slice(0, 10);
  const svg = s => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');
  // Signature manuscrite factice tirée du nom.
  function signature(nom) {
    let x = 12, d = 'M12 60';
    for (const c of nom.replace(/[^a-z]/gi, '')) { const k = c.charCodeAt(0); x += 9 + k % 7; const y = 25 + (k * 7) % 50; d += ` Q${x - 5} ${y < 50 ? y + 38 : y - 38} ${x} ${y}`; }
    return svg(`<svg xmlns="http://www.w3.org/2000/svg" width="${x + 14}" height="100"><path d="${d}" fill="none" stroke="#1d2a6b" stroke-width="2.4" stroke-linecap="round"/></svg>`);
  }

  // ---------- Entreprise et catalogue ----------
  const S = {
    nom: 'Yildiz Rénovation', adresse: '24 avenue Berthelot\n69007 Lyon', siret: '852 147 963 00021', rcs: 'RCS Lyon 852 147 963', tva_intra: 'FR42852147963',
    tel: '04 78 12 45 67', email: 'contact@example.com', site: 'yildiz-renovation.example', assurance: 'Décennale MAAF n° 125 448 963, couverture France',
    iban: 'FR76 3000 4000 0500 0012 3456 789', bic: 'BNPAFRPPXXX', couleur: '#1e3a8a', acompte_defaut: 30, resume_le: '2026-10-31',
    logo: svg('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="70"><rect width="70" height="70" rx="16" fill="#1e3a8a"/><path d="M35 13l6.5 13.5 15 2-11 10.5 2.7 14.8L35 46.7 21.8 53.8l2.7-14.8-11-10.5 15-2z" fill="#f5b81c"/><text x="84" y="34" font-family="Arial" font-weight="700" font-size="22" fill="#1e3a8a">YILDIZ</text><text x="85" y="56" font-family="Arial" font-size="14" letter-spacing="2" fill="#5b6478">RÉNOVATION</text></svg>'),
  };
  db.prepare('UPDATE comptes SET settings=? WHERE id=?').run(JSON.stringify(S), cid);
  for (const [designation, description, unite, pu, tva] of [
    ['Dépose baignoire et évacuation', 'Y compris mise en décharge', 'forfait', 350, 10], ['Pose de faïence murale', 'Fourniture comprise, colle et joints', 'm²', 55, 10],
    ['Peinture murs, 2 couches', 'Lessivage, rebouchage, impression', 'm²', 24, 10], ['Peinture plafond, 2 couches', '', 'm²', 26, 10],
    ['Parquet chêne contrecollé', 'Pose flottante sur sous-couche', 'm²', 68, 10], ['Isolation combles soufflée R=7', 'Laine de verre, 32 cm', 'm²', 32, 5.5],
    ['Receveur extra-plat 90×120 + paroi', 'Fourniture et pose', 'u', 1150, 10], ['Mitigeur thermostatique', 'Fourniture et pose', 'u', 240, 10],
    ['Spot LED étanche IP65', 'Fourniture et pose', 'u', 85, 10], ['Évacuation gravats', 'Benne et mise en décharge', 'forfait', 380, 10],
  ]) ins('catalog', { compte_id: cid, designation, description, unite, pu, tva });

  // ---------- Clients ----------
  const C = {};
  for (const [k, nom, adresse, email, tel, siret = ''] of [
    ['martin', 'Mme Claire Martin', '12 rue des Lilas\n69003 Lyon', 'claire.martin@example.com', '06 12 34 56 78'],
    ['benali', 'M. et Mme Benali', '15 chemin des Vignes\n69110 Sainte-Foy-lès-Lyon', 'famille.benali@example.com', '06 45 22 18 90'],
    ['tilleuls', 'SCI Les Tilleuls', '3 place des Tilleuls\n69100 Villeurbanne', 'gestion@sci-tilleuls.example.com', '04 72 33 41 10', '791 254 336 00014'],
    ['rhone', 'Cabinet Rhône Gestion (syndic)', '40 rue Garibaldi\n69006 Lyon', 'travaux@rhone-gestion.example.com', '04 78 60 21 44', '502 887 120 00031'],
    ['girard', 'M. Thomas Girard', '7 impasse des Chênes\n69140 Rillieux-la-Pape', 'thomas.girard@example.com', '06 71 09 55 32'],
    ['demir', 'Mme Aylin Demir', '112 cours Gambetta\n69007 Lyon', 'aylin.demir@example.com', '07 68 14 27 03'],
    ['fournil', 'SARL Le Fournil', '5 rue Victor Hugo\n69002 Lyon', 'contact@lefournil.example.com', '04 78 37 92 15', '833 410 572 00018'],
    ['roche', 'M. Julien Roche', '19 route de Lyon\n69570 Dardilly', 'julien.roche@example.com', '06 30 84 61 77'],
    ['lambert', 'Mme Sophie Lambert', '31 rue Pasteur\n69300 Caluire-et-Cuire', 'sophie.lambert@example.com', '06 58 40 12 96'],
    ['haddad', 'M. Karim Haddad', '4 allée des Peupliers\n69130 Écully', 'karim.haddad@example.com', '07 81 26 35 49'],
    ['petit', 'M. Olivier Petit', '58 rue Duguesclin\n69006 Lyon', 'olivier.petit@example.com', '06 22 91 73 05'],
  ]) C[k] = { id: ins('clients', { compte_id: cid, nom, adresse, email, tel, siret, created_at: '2025-10-01' }), nom, adresse, email, tel, siret };

  // ---------- Journal des e-mails ----------
  let heure = 0;
  const mail = (date, o) => ins('emails', { compte_id: cid, sens: 'envoye', statut: 'envoyé avec PDF', created_at: `${date} ${String(8 + heure++ % 10).padStart(2, '0')}:${String(heure * 17 % 60).padStart(2, '0')}:00`, ...o });
  const envoi = (d, date) => mail(date, {
    a: d.data.client.email, document_id: d.id, chantier_id: d.chantier_id, client_id: d.client_id, sujet: `${d.type === 'devis' ? 'Devis' : d.kind === 'avoir' ? 'Avoir' : 'Facture'} ${d.numero} – ${S.nom}`,
    corps: `Bonjour ${d.data.client.nom},\n\nVeuillez trouver ci-joint votre ${d.type === 'devis' ? 'devis' : d.kind === 'avoir' ? 'avoir' : 'facture'} n° ${d.numero} d’un montant de ${eur(d.total_ttc)} TTC.\nVous pouvez aussi le consulter${d.type === 'devis' ? ' et le signer' : ''} en ligne :\n${URL}/p/${d.token}\n\nCordialement,\n${S.nom}`,
  });

  // ---------- Affaires : devis → chantier → factures → règlements ----------
  const L = (...xs) => xs.map(x => (typeof x === 'string' ? { type: 'section', designation: x } : { type: 'ligne', designation: x[0], qte: x[1], unite: x[2], pu: x[3], tva: x[5] ?? 10, description: x[4] || '' }));
  const AFFAIRES = [
    { c: 'martin', objet: 'Rénovation complète de la salle de bain', adr: '12 rue des Lilas, 69003 Lyon', date: '2025-11-04', signe: '2025-11-08', acompte: 30,
      lignes: L('Démolition', ['Dépose baignoire et évacuation', 1, 'forfait', 350, 'Y compris mise en décharge'], ['Dépose faïence existante', 14, 'm²', 18],
        'Plomberie', ['Receveur extra-plat 90×120 + paroi', 1, 'u', 1150, 'Fourniture et pose'], ['Meuble vasque 80 cm', 1, 'u', 690], ['Mitigeur thermostatique', 1, 'u', 240, 'Fourniture et pose'],
        'Carrelage', ['Pose de faïence murale', 18, 'm²', 55, 'Fourniture comprise, colle et joints'], ['Carrelage sol antidérapant', 6, 'm²', 62],
        'Électricité', ['Spot LED étanche IP65', 4, 'u', 85, 'Fourniture et pose']),
      chantier: { statut: 'termine', debut: '2025-11-24', fin: '2025-12-12', reelle: '2025-12-11', av: 100, notes: 'Client très satisfait, photos avant/après prises.' },
      factures: [{ mode: 'acompte', date: '2025-11-10', regle: [['2025-11-14', 'Virement']] }, { mode: 'solde', date: '2025-12-12', regle: [['2025-12-22', 'Chèque']] }] },
    { c: 'benali', objet: 'Ouverture de la cuisine sur le séjour', adr: '15 chemin des Vignes, 69110 Sainte-Foy-lès-Lyon', date: '2026-01-08', signe: '2026-01-15', acompte: 30,
      lignes: L('Gros œuvre', ['Ouverture de mur porteur avec IPN', 1, 'forfait', 3200, 'Étude de structure et étaiement inclus'], ['Évacuation gravats', 1, 'forfait', 380, 'Benne et mise en décharge'],
        'Finitions', ['Reprise de plâtrerie', 12, 'm²', 45], ['Peinture murs, 2 couches', 48, 'm²', 24, 'Lessivage, rebouchage, impression'], ['Parquet chêne contrecollé', 22, 'm²', 68, 'Pose flottante sur sous-couche']),
      chantier: { statut: 'termine', debut: '2026-02-02', fin: '2026-02-27', reelle: '2026-03-03', av: 100, notes: 'Retard de 4 jours : livraison de l’IPN décalée.' },
      factures: [{ mode: 'acompte', date: '2026-01-16', regle: [['2026-01-22', 'Virement']] }, { mode: 'solde', date: '2026-03-04', regle: [['2026-03-18', 'Virement']] }] },
    { c: 'tilleuls', objet: 'Ravalement de façade', adr: '3 place des Tilleuls, 69100 Villeurbanne', date: '2026-02-16', signe: '2026-02-27', signataire: 'Pierre Vasseur, gérant', acompte: 30, remise: 5,
      lignes: L('Installation', ['Échafaudage, montage et démontage', 1, 'forfait', 2400], 'Façade', ['Nettoyage haute pression', 180, 'm²', 6], ['Traitement des fissures', 25, 'ml', 28],
        ['Enduit de façade taloché', 180, 'm²', 38, 'Teinte au choix du nuancier'], ['Peinture des menuiseries extérieures', 12, 'u', 95]),
      chantier: { statut: 'termine', debut: '2026-04-07', fin: '2026-05-15', reelle: '2026-05-13', av: 100 },
      factures: [{ mode: 'acompte', date: '2026-03-02', regle: [['2026-03-10', 'Virement']] }, { mode: 'solde', date: '2026-05-15', regle: [['2026-06-05', 'Virement']] }] },
    { c: 'rhone', objet: 'Peinture de la cage d’escalier, résidence Le Parc', adr: '40 rue Garibaldi, 69006 Lyon', date: '2026-03-24', signe: '2026-04-02', signataire: 'Nadia Morel, gestionnaire', acompte: 0,
      lignes: L(['Protection et préparation des supports', 1, 'forfait', 650], ['Peinture murs, 2 couches', 210, 'm²', 22, 'Lessivage, rebouchage, impression'], ['Peinture plafond, 2 couches', 60, 'm²', 25],
        ['Peinture des rampes métalliques', 45, 'ml', 18], ['Remplacement des nez de marche', 48, 'u', 32]),
      chantier: { statut: 'termine', debut: '2026-05-18', fin: '2026-06-10', reelle: '2026-06-12', av: 100, notes: 'Travaux en site occupé : accès gardien de 8 h à 17 h.' },
      factures: [{ mode: 'standard', date: '2026-06-12', avoir: { date: '2026-06-19', ht: 300, motif: 'Remise commerciale : 2 jours de retard sur la livraison' }, regle: [['2026-07-08', 'Virement']] }] },
    { c: 'girard', objet: 'Isolation des combles perdus', adr: '7 impasse des Chênes, 69140 Rillieux-la-Pape', date: '2026-05-06', signe: '2026-05-11', acompte: 30,
      lignes: L(['Isolation combles soufflée R=7', 85, 'm²', 32, 'Laine de verre, 32 cm', 5.5], ['Pare-vapeur autour de la trappe', 1, 'u', 180, '', 5.5], ['Rehausse de trappe isolée', 1, 'u', 240, '', 5.5],
        ['Capots de protection des spots', 10, 'u', 15, '', 5.5]),
      chantier: { statut: 'termine', debut: '2026-06-15', fin: '2026-06-19', reelle: '2026-06-18', av: 100 },
      factures: [{ mode: 'acompte', date: '2026-05-12', regle: [['2026-05-20', 'Carte (en ligne)']] },
        { mode: 'solde', date: '2026-06-19', regle: [['2026-07-28', 'Chèque', 500]], relances: ['2026-07-27', '2026-09-15', '2026-10-26'] }] },
    { c: 'demir', objet: 'Rénovation d’un appartement T3', adr: '112 cours Gambetta, 69007 Lyon', date: '2026-06-29', signe: '2026-07-06', acompte: 40,
      lignes: L('Préparation', ['Dépose de moquette', 55, 'm²', 8], ['Ragréage des sols', 55, 'm²', 22], 'Sols', ['Parquet stratifié chêne clair', 55, 'm²', 42, 'Pose flottante sur sous-couche'],
        'Peinture', ['Peinture murs, 2 couches', 160, 'm²', 24, 'Lessivage, rebouchage, impression'], ['Peinture plafond, 2 couches', 55, 'm²', 26], ['Peinture des portes intérieures', 6, 'u', 120],
        'Électricité', ['Remplacement prises et interrupteurs', 24, 'u', 35]),
      chantier: { statut: 'en_cours', debut: '2026-10-05', fin: '2026-11-20', av: 65, notes: 'Clés chez la gardienne. Parquet livré le 12/10.' },
      factures: [{ mode: 'acompte', date: '2026-07-07', regle: [['2026-07-15', 'Virement']] }] },
    { c: 'fournil', objet: 'Mise aux normes PMR des sanitaires', adr: '5 rue Victor Hugo, 69002 Lyon', date: '2026-08-17', signe: '2026-08-24', signataire: 'Jérôme Fabre, gérant', acompte: 30,
      lignes: L('Cloisons', ['Démolition de cloison', 1, 'forfait', 450, '', 20], ['Cloison plaque hydrofuge', 9, 'm²', 65, '', 20], ['Bloc-porte 90 cm', 1, 'u', 520, 'Passage PMR', 20],
        'Équipements', ['WC suspendu PMR', 1, 'u', 980, 'Bâti-support et cuvette rehaussée', 20], ['Lave-mains PMR', 1, 'u', 420, '', 20], ['Barres d’appui', 2, 'u', 95, '', 20], ['Carrelage sol antidérapant', 6, 'm²', 70, '', 20]),
      chantier: { statut: 'en_cours', debut: '2026-09-28', fin: '2026-10-23', av: 70, retard: '2026-10-24', notes: 'Attente du WC PMR (rupture fournisseur, livraison prévue le 05/11).' },
      factures: [{ mode: 'acompte', date: '2026-08-25', regle: [['2026-09-02', 'Virement']] }] },
    { c: 'tilleuls', objet: 'Réfection de la toiture du garage', adr: '3 place des Tilleuls, 69100 Villeurbanne', date: '2026-09-01', statut: 'refuse', relances: ['2026-09-08'], acompte: 30,
      lignes: L(['Dépose de la couverture fibrociment', 38, 'm²', 45, 'Désamiantage par entreprise certifiée'], ['Bac acier isolé', 38, 'm²', 72], ['Zinguerie et gouttières', 16, 'ml', 48]) },
    { c: 'roche', objet: 'Création d’une terrasse en bois', adr: '19 route de Lyon, 69570 Dardilly', date: '2026-09-14', signe: '2026-09-29', acompte: 30,
      lignes: L(['Plots réglables et lambourdes', 35, 'm²', 38], ['Lames ipé 21 mm', 35, 'm²', 115, 'Vis inox, fixation invisible'], ['Escalier 3 marches', 1, 'u', 650], ['Garde-corps bois et câbles inox', 6, 'ml', 190]),
      chantier: { statut: 'a_venir', debut: '2026-11-09', fin: '2026-11-20', av: 0 },
      factures: [{ mode: 'acompte', date: '2026-10-05' }] },
    { c: 'lambert', objet: 'Remplacement de 5 menuiseries', adr: '31 rue Pasteur, 69300 Caluire-et-Cuire', date: '2026-10-09', statut: 'envoye', relances: ['2026-10-27'], acompte: 30,
      lignes: L(['Fenêtre PVC double vitrage 120×135', 4, 'u', 780, 'Uw = 1,3, blanc', 5.5], ['Porte-fenêtre 2 vantaux', 1, 'u', 1450, '', 5.5], ['Dépose et évacuation des anciennes menuiseries', 5, 'u', 60, '', 5.5], ['Habillage aluminium extérieur', 5, 'u', 75, '', 5.5]) },
    { c: 'haddad', objet: 'Création d’une salle d’eau sous combles', adr: '4 allée des Peupliers, 69130 Écully', date: '2026-10-26', statut: 'envoye', acompte: 30,
      lignes: L('Plomberie', ['Création des alimentations et évacuations', 1, 'forfait', 1450], ['Receveur extra-plat 90×120 + paroi', 1, 'u', 1150, 'Fourniture et pose'], ['WC suspendu', 1, 'u', 780],
        'Finitions', ['Pose de faïence murale', 16, 'm²', 55, 'Fourniture comprise, colle et joints'], ['Peinture plafond, 2 couches', 7, 'm²', 26], ['VMC hygroréglable', 1, 'u', 420]) },
    { c: 'petit', objet: 'Peinture du séjour et du couloir', adr: '58 rue Duguesclin, 69006 Lyon', date: '2026-10-30', statut: 'brouillon', acompte: 30,
      lignes: L(['Protection des sols et meubles', 1, 'forfait', 120], ['Peinture murs, 2 couches', 72, 'm²', 24, 'Lessivage, rebouchage, impression'], ['Peinture plafond, 2 couches', 34, 'm²', 26]) },
  ];

  const numeros = {};
  const numero = (p, date) => { const k = `${p}-${date.slice(0, 4)}`; numeros[k] = (numeros[k] ?? { 'DEV-2025': 46, 'FAC-2025': 38 }[k] ?? 0) + 1; return `${k}-${String(numeros[k]).padStart(4, '0')}`; };
  const token = () => crypto.randomBytes(24).toString('hex');
  function doc(o) {
    const t = totaux(o.data), r = { compte_id: cid, template_id: 1, total_ht: t.ht, total_ttc: t.ttc, token: token(), created_at: o.date, ...o };
    return { ...r, id: ins('documents', r) };
  }
  const factures = [];
  for (const a of AFFAIRES) {
    const c = C[a.c], client = { nom: c.nom, adresse: c.adresse, email: c.email, tel: c.tel, siret: c.siret };
    const statut = a.statut || 'accepte', envoye = statut !== 'brouillon';
    const d = doc({ type: 'devis', numero: numero('DEV', a.date), client_id: c.id, statut, date: a.date, echeance: addDays(a.date, 30),
      envoye_le: envoye ? `${a.date}T09:30:00.000Z` : null, relances: a.relances?.length || 0, derniere_relance: a.relances ? `${a.relances.at(-1)}T08:00:00.000Z` : null,
      data: { client, objet: a.objet, adresse_chantier: a.adr, acompte_pct: a.acompte, remise_pct: a.remise || 0, notes: '', lignes: a.lignes } });
    if (envoye) envoi(d, a.date);
    for (const r of a.relances || []) mail(r, { a: c.email, document_id: d.id, client_id: c.id, sujet: `Votre devis ${d.numero}`,
      corps: `Bonjour ${c.nom},\n\nAvez-vous pu étudier notre devis n° ${d.numero} (${eur(d.total_ttc)} TTC) ? Vous pouvez le signer en ligne en un clic :\n${URL}/p/${d.token}\n\nCordialement,\n${S.nom}` });
    if (a.signe) {
      const par = a.signataire || c.nom.replace(/^(M\.|Mme) (et Mme )?/, '');
      set('documents', d.id, { signature: signature(par), signe_par: par, signe_le: `${a.signe}T18:42:00.000Z`, signe_ip: '82.64.120.17' });
      mail(a.signe, { a: S.email, document_id: d.id, statut: 'envoyé', sujet: `Devis ${d.numero} signé par ${par}`, corps: `Bonne nouvelle : le devis ${d.numero} (${eur(d.total_ttc)} TTC) vient d’être signé. Le chantier a été créé automatiquement.` });
    }
    if (a.chantier) {
      const ch = a.chantier;
      d.chantier_id = ins('chantiers', { compte_id: cid, nom: a.objet, client_id: c.id, devis_id: d.id, adresse: a.adr, date_debut: ch.debut, date_fin_prevue: ch.fin, date_fin_reelle: ch.reelle,
        avancement: ch.av, statut: ch.statut, email_suivi: c.email, notes: ch.notes || '', retard_notifie_le: ch.retard ? `${ch.retard}T07:00:00.000Z` : null, created_at: a.signe });
      set('documents', d.id, { chantier_id: d.chantier_id });
      if (ch.retard) mail(ch.retard, { a: c.email, chantier_id: d.chantier_id, statut: 'envoyé', sujet: `Chantier « ${a.objet} » : information sur le planning`,
        corps: `Bonjour ${c.nom},\n\nNous vous informons que le chantier « ${a.objet} », dont la fin était prévue le ${new Date(ch.fin).toLocaleDateString('fr-FR')}, a pris du retard (avancement actuel : ${ch.av} %). Nous revenons vers vous très vite avec une nouvelle date.\n\nCordialement,\n${S.nom}` });
    }
    for (const f of a.factures || []) factures.push({ ...f, devis: d, client });
  }

  // Factures créées dans l'ordre chronologique : numérotation sans trou.
  factures.sort((a, b) => a.date.localeCompare(b.date));
  let ref = 0;
  for (const f of factures) {
    const d = f.devis, acomptes = factures.filter(x => x.devis === d && x.mode === 'acompte' && x.doc);
    const lignes = f.mode === 'acompte' ? lignesAcompte(d, d.data.acompte_pct) : lignesSolde(d, acomptes.map(x => x.doc));
    f.doc = doc({ type: 'facture', kind: f.mode, numero: numero('FAC', f.date), client_id: d.client_id, chantier_id: d.chantier_id, parent_id: d.id, statut: 'envoyee', date: f.date,
      echeance: addDays(f.date, 30), envoye_le: `${f.date}T10:00:00.000Z`, relances: f.relances?.length || 0, derniere_relance: f.relances ? `${f.relances.at(-1)}T08:00:00.000Z` : null,
      data: { client: f.client, objet: d.data.objet, adresse_chantier: d.data.adresse_chantier, remise_pct: f.mode === 'acompte' ? 0 : d.data.remise_pct, notes: '', lignes } });
    envoi(f.doc, f.date);
    let du = f.doc.total_ttc;
    if (f.avoir) {
      const av = doc({ type: 'facture', kind: 'avoir', numero: numero('AV', f.avoir.date), client_id: d.client_id, chantier_id: d.chantier_id, parent_id: f.doc.id, statut: 'envoyee', date: f.avoir.date,
        envoye_le: `${f.avoir.date}T10:00:00.000Z`, data: { client: f.client, objet: d.data.objet, remise_pct: 0, notes: `Avoir sur la facture ${f.doc.numero}`, lignes: L([f.avoir.motif, 1, 'forfait', -f.avoir.ht]) } });
      envoi(av, f.avoir.date);
      du = r2(du + av.total_ttc);
    }
    for (const r of f.relances || []) mail(r, { a: f.client.email, document_id: f.doc.id, client_id: d.client_id, sujet: `Relance : facture ${f.doc.numero}`,
      corps: `Bonjour ${f.client.nom},\n\nSauf erreur de notre part, la facture n° ${f.doc.numero} échue le ${new Date(f.doc.echeance).toLocaleDateString('fr-FR')} reste impayée.\nRèglement possible en ligne : ${URL}/p/${f.doc.token}\n\nCordialement,\n${S.nom}` });
    for (const [date, mode, montant = du] of f.regle || []) {
    ins('payments', { compte_id: cid, document_id: f.doc.id, montant, date, mode, note: mode.startsWith('Carte') ? 'Paiement Stripe' : '', ref: mode.startsWith('Carte') ? `pi_demo_${cid}_${++ref}` : null });
      if (mode.startsWith('Carte')) mail(date, { a: S.email, document_id: f.doc.id, statut: 'envoyé', sujet: `Paiement reçu : ${eur(montant)} sur ${f.doc.numero}`, corps: `${f.client.nom} vient de régler ${eur(montant)} en ligne sur la facture ${f.doc.numero}.` });
    }
  }

  // Devis type réutilisable
  ins('documents', { compte_id: cid, type: 'modele', nom: 'Salle de bain clé en main', template_id: 1, token: token(), statut: 'brouillon', date: '2026-03-01', ...(() => {
    const data = { client: { nom: '', adresse: '', email: '', tel: '' }, objet: 'Rénovation de salle de bain', acompte_pct: 30, remise_pct: 0, notes: '', lignes: AFFAIRES[0].lignes };
    const t = totaux(data); return { data, total_ht: t.ht, total_ttc: t.ttc };
  })() });

  // Échanges avec les clients (reçus dans la boîte du pro, et réponses)
  let mid = 0;
  const recu = (k, date, sujet, corps) => ins('emails', { compte_id: cid, sens: 'recu', de: C[k].email, a: S.email, sujet, corps, statut: 'reçu', client_id: C[k].id, message_id: `<demo-${++mid}@example.com>`, created_at: date });
  const reponse = (k, date, sujet, corps) => mail(date.slice(0, 10), { a: C[k].email, client_id: C[k].id, statut: 'envoyé', sujet, corps });
  recu('martin', '2025-12-14 19:05:00', 'Merci !', 'Bonjour,\n\nLa salle de bain est magnifique, merci à toute l’équipe pour le soin apporté. Je vous recommanderai sans hésiter.\n\nClaire Martin');
  recu('tilleuls', '2026-09-14 11:20:00', 'Re: Votre devis DEV-2026-0007', 'Bonjour,\n\nMerci pour votre proposition. Après discussion avec les associés, nous préférons reporter la toiture du garage à l’an prochain.\n\nBien cordialement,\nPierre Vasseur');
  recu('demir', '2026-10-16 08:47:00', 'Parquet', 'Merhaba Mehmet Bey,\n\nParkenin rengini değiştirmek mümkün mü? Biraz daha açık bir meşe istiyorum. Fiyat farkı olursa söyleyin lütfen.\n\nAylin');
  reponse('demir', '2026-10-16 12:10:00', 'Re: Parquet', 'Bonjour Madame Demir,\n\nC’est possible : le chêne blanchi est au même prix, sans supplément. Nous le commandons aujourd’hui pour une pose la semaine prochaine.\n\nCordialement,\nMehmet Yildiz');
  mail('2026-10-23', { a: C.demir.email, chantier_id: db.prepare('SELECT id FROM chantiers WHERE client_id=?').get(C.demir.id).id, statut: 'envoyé', sujet: 'Avancement du chantier « Rénovation d’un appartement T3 »',
    corps: `Bonjour ${C.demir.nom},\n\nPoint d’avancement du chantier « Rénovation d’un appartement T3 » : 65 % réalisé.\n\nCordialement,\n${S.nom}` });
  recu('girard', '2026-10-28 18:32:00', 'Re: Relance : facture', 'Bonjour,\n\nDésolé pour le retard, j’ai eu des frais imprévus. Je vous règle le solde début novembre par virement.\n\nThomas Girard');
  reponse('girard', '2026-10-29 08:15:00', 'Re: Relance : facture', 'Bonjour Monsieur Girard,\n\nMerci pour votre retour. C’est noté pour un règlement début novembre.\n\nCordialement,\nMehmet Yildiz');
  recu('lambert', '2026-10-30 15:42:00', 'Question sur le devis fenêtres', 'Bonjour,\n\nEst-il possible d’avoir les fenêtres en gris anthracite à l’extérieur ? Quel serait le supplément ?\nEt quel délai de pose si je signe cette semaine ?\n\nMerci,\nSophie Lambert');
  recu('fournil', '2026-10-30 07:55:00', 'Travaux sanitaires', 'Bonjour,\n\nPouvez-vous nous donner une date de fin ? Nous avons un contrôle d’accessibilité prévu mi-novembre.\n\nJérôme Fabre\nLe Fournil');
  const mHaddad = recu('haddad', '2026-10-31 07:40:00', 'Re: Devis DEV-2026-0010', 'Bonjour,\n\nAvant de signer, j’aimerais que vous repassiez voir l’emplacement de la VMC dans les combles. Seriez-vous disponible mercredi 4 novembre vers 18 h ?\n\nKarim Haddad');
  // Messages de la veille et du jour pas encore lus ; tous déjà lus par Claude (pas d'analyse au lancement de la démo).
  db.prepare('UPDATE emails SET rdv_vu=1, lu=CASE WHEN sens=\'recu\' AND created_at >= \'2026-10-30\' THEN 0 ELSE 1 END WHERE compte_id=?').run(cid);

  // ---------- Agenda ----------
  const chId = k => db.prepare('SELECT id FROM chantiers WHERE client_id=? ORDER BY id DESC').get(C[k].id)?.id ?? null;
  const adr = k => C[k].adresse.replace('\n', ', ');
  for (const [k, titre, debut, fin, ch, notes = ''] of [
    ['haddad', 'Visite des combles – M. Haddad', '2026-10-27T09:00', '2026-10-27T10:00', false],
    ['fournil', 'Point chantier – Le Fournil', '2026-10-29T08:00', null, true],
    ['demir', 'Point chantier avec Mme Demir', '2026-11-02T08:30', '2026-11-02T09:00', true, 'Valider la teinte des portes.'],
    ['petit', 'Métré séjour et couloir – M. Petit', '2026-11-03T14:00', '2026-11-03T15:00', false],
    ['fournil', 'Livraison du WC PMR – Le Fournil', '2026-11-05T09:00', null, true, 'Prévoir 2 personnes pour la manutention.'],
    ['lambert', 'Visite technique fenêtres – Mme Lambert', '2026-11-06T10:00', '2026-11-06T11:00', false, 'Prendre les cotes des 5 ouvertures.'],
    ['roche', 'Livraison des lames ipé – M. Roche', '2026-11-09', null, true],
    ['fournil', 'Contrôle accessibilité – Le Fournil', '2026-11-16T10:00', null, true],
    ['demir', 'Réception des travaux – Mme Demir', '2026-11-20T17:00', '2026-11-20T18:00', true],
  ]) ins('rdv', { compte_id: cid, titre, debut, fin, client_id: C[k].id, chantier_id: ch ? chId(k) : null, lieu: adr(k), notes, statut: 'confirme' });
  // ---------- Dépenses (TVA 20 % sauf mention) : la fiche chantier et l'Analyse déduisent les achats ----------
  for (const [k, date, fournisseur, libelle, categorie, ttc, tva = r2(ttc / 6)] of [
    ['martin', '2025-11-22', 'Point P', 'Faïence, colle et joints', 'materiaux', 1428], ['martin', '2025-11-25', 'Cedeo', 'Receveur, mitigeur, vasque', 'materiaux', 1896],
    ['benali', '2026-02-03', 'Kiloutou', 'Étais et marteau-piqueur', 'location', 312], ['benali', '2026-02-05', 'Descours & Cabaud', 'IPN 200 et platines', 'materiaux', 987.6],
    ['tilleuls', '2026-04-06', 'Altrad', 'Location échafaudage 6 semaines', 'location', 2760], ['tilleuls', '2026-04-08', 'Zolpan', 'Enduit de façade', 'materiaux', 1854],
    ['rhone', '2026-05-18', 'Tollens', 'Peinture et sous-couche', 'materiaux', 1170],
    ['girard', '2026-06-12', 'Isover Pro', 'Laine soufflée 300 mm', 'materiaux', 1395.6, 72.6], // TVA 5,5 % (rénovation énergétique)
    ['demir', '2026-10-06', 'Point P', 'Placo BA13, rails, montants', 'materiaux', 1362], ['demir', '2026-10-12', 'Parquet Diffusion', 'Parquet chêne 62 m²', 'materiaux', 3348],
    ['demir', '2026-10-20', 'Élec Rhône', 'Tableau électrique (sous-traitance)', 'sous_traitance', 1680],
    ['fournil', '2026-09-29', 'Cedeo', 'Lavabo et barres PMR', 'materiaux', 1146], ['fournil', '2026-10-02', 'Leroy Merlin', 'Carrelage antidérapant', 'materiaux', 655.2],
    [null, '2026-10-15', 'Total', 'Gasoil camion', 'carburant', 112.4], [null, '2026-10-28', 'Würth', 'Forets, disques, visserie', 'outillage', 186],
  ]) ins('depenses', { compte_id: cid, chantier_id: k && chId(k), date, fournisseur, libelle, categorie, ttc, tva });

  // Proposé par Claude à partir de l'e-mail de M. Haddad (à confirmer dans l'Agenda)
  ins('rdv', { compte_id: cid, titre: 'Visite emplacement VMC – M. Haddad', debut: '2026-11-04T18:00', client_id: C.haddad.id, lieu: adr('haddad'), email_id: mHaddad, statut: 'propose' });
  for (const [k, texte, ch] of [
    ['petit', 'Séjour 4,20 × 5,60 m, hauteur 2,50 m. Couloir 6 m de long. Plafond fissuré au-dessus de la fenêtre : prévoir bande et enduit. Le client veut un blanc cassé.', false],
    ['roche', 'Terrasse : vérifier la pente côté maison avant de poser les plots. Prévoir 2 sacs de gravier en plus.', true],
  ]) ins('notes', { compte_id: cid, texte, client_id: C[k].id, chantier_id: ch ? chId(k) : null, created_at: '2026-10-30 17:20:00' });

  if (jours) { // toute l'histoire avance d'autant (le texte des e-mails garde ses dates)
    const n = `'${jours > 0 ? '+' : ''}${jours} days'`;
    for (const [t, cs] of Object.entries({ clients: 'created_at', documents: 'date echeance envoye_le derniere_relance signe_le created_at', chantiers: 'date_debut date_fin_prevue date_fin_reelle retard_notifie_le created_at',
      payments: 'date', emails: 'created_at', rdv: 'debut fin', depenses: 'date', notes: 'created_at' }))
      for (const c of cs.split(' ')) db.prepare(`UPDATE ${t} SET ${c}=date(substr(${c},1,10), ${n}) || substr(${c},11) WHERE compte_id=? AND ${c} GLOB '[0-9][0-9][0-9][0-9]-*'`).run(cid);
  }
  return { S, C, mHaddad };
}
