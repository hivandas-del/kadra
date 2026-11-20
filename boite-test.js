// Boîte mail d'essai pour brancher Kadra « comme un vrai artisan », sans vrais clients :
//   npm run boite-test               → compte d'essai sur http://localhost:3000
//   npm run boite-test -- http://localhost:3001
// 1) crée une vraie boîte mail Ethereal (gratuite, rien n'est livré à personne) et y dépose ~2 mois d'échanges avec 8 clients :
//    les e-mails des clients dans la boîte de réception, les réponses de l'artisan (avec sa façon d'écrire) dans « Envoyés » ;
// 2) crée sur Kadra un compte d'entreprise d'essai (Morel Rénovation) avec ces clients et quelques devis déjà envoyés.
// Il ne reste qu'à brancher la boîte dans Kadra (Paramètres > Automatismes) avec les identifiants affichés.
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const KADRA = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const COMPTE = { entreprise: 'Morel Rénovation', nom: 'Lucas Morel', email: 'essai@kadra.fr', password: 'essai1234' };

// ---------- Dates : relatives à aujourd'hui, pour que les rendez-vous à venir le restent ----------
const J = n => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const at = (n, h, m = 0) => { const d = J(n); d.setHours(h, m, 0, 0); return d; };
const jour = n => J(n).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const jourPt = n => J(n).toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' });
const iso = n => J(n).toISOString().slice(0, 10);

// ---------- Les clients ----------
const C = {
  petit: { nom: 'Claire Petit', email: 'claire.petit@example.com', tel: '06 12 45 78 90', adresse: '14 rue Notre-Dame\n33000 Bordeaux', civ: 'Madame Petit' },
  garnier: { nom: 'Antoine Garnier', email: 'a.garnier@example.com', tel: '06 33 21 09 87', adresse: '8 cours de l’Intendance\n33000 Bordeaux', civ: 'Monsieur Garnier' },
  ouali: { nom: 'Fatima Ouali', email: 'f.ouali@example.com', tel: '07 61 22 34 56', adresse: '27 avenue Thiers\n33100 Bordeaux', civ: 'Madame Ouali' },
  ferreira: { nom: 'Paulo Ferreira', email: 'paulo.ferreira@example.com', tel: '06 98 76 54 32', adresse: '5 rue des Vignes\n33130 Bègles', civ: 'Monsieur Ferreira' },
  tilleuls: { nom: 'SCI Les Tilleuls', email: 'gestion@sci-tilleuls.example.com', tel: '05 56 44 12 30', adresse: '3 place Gambetta\n33000 Bordeaux', civ: 'Monsieur Dubreuil' },
  marchand: { nom: 'Hélène Marchand', email: 'h.marchand@example.com', tel: '06 45 67 89 01', adresse: '41 rue Fondaudège\n33000 Bordeaux', civ: 'Madame Marchand' },
  lopez: { nom: 'Kevin Lopez', email: 'kevin.lopez@example.com', tel: '06 07 08 09 10', adresse: '12 allée des Pins\n33600 Pessac', civ: 'Monsieur Lopez' },
  roux: { nom: 'Nathalie Roux', email: 'n.roux@example.com', tel: '06 54 32 10 98', adresse: '9 rue du Palais Gallien\n33000 Bordeaux', civ: 'Madame Roux' },
};
// Façon d'écrire de l'artisan (ce que Kadra doit apprendre) : « Bonjour Madame X, », phrases courtes, « Je reste dispo si besoin. »,
// signature « Bonne journée, / Lucas / Morel Rénovation – 06 71 42 18 90 ».
const SIGNE = '\n\nJe reste dispo si besoin.\n\nBonne journée,\nLucas\nMorel Rénovation – 06 71 42 18 90';
const lucas = (k, corps) => `Bonjour ${C[k].civ},\n\n${corps}${SIGNE}`;

// Conversations : [client, jours (négatif = passé), heure, de l'artisan ?, sujet, corps, pièce jointe]
const FILS = [
  ['petit', -52, 9, false, 'Devis salle de bain', `Bonjour,\n\nNous voudrions refaire entièrement notre salle de bain (environ 6 m²) : remplacer la baignoire par une douche à l'italienne, nouveau meuble vasque et faïence.\nPourriez-vous passer pour un devis ?\n\nCordialement,\nClaire Petit`],
  ['petit', -52, 18, true, 'Re: Devis salle de bain', lucas('petit', `Merci pour votre demande. Je peux passer voir la salle de bain ${jour(-49)} à 17 h 30, si ça vous va.\nPrévoyez de me dire les dimensions de la douche que vous souhaitez.`)],
  ['petit', -51, 8, false, 'Re: Devis salle de bain', `Bonjour,\n\n${jour(-49).replace(/^\w/, c => c.toUpperCase())} 17 h 30 c'est parfait. Pour la douche, 90 x 140 si possible.\n\nClaire Petit`],
  ['petit', -46, 19, true, 'Votre devis salle de bain', lucas('petit', `Comme convenu, voici le devis pour la salle de bain (DEV joint dans Kadra).\nJ'ai prévu un receveur extra-plat 90x140, paroi fixe et faïence jusqu'au plafond côté douche.\nComptez environ 8 jours de travaux.`)],
  ['petit', -44, 10, false, 'Re: Votre devis salle de bain', `Bonjour,\n\nLe devis nous convient. Une question : la faïence est-elle fournie ou faut-il la choisir nous-mêmes ?\n\nClaire Petit`],
  ['petit', -44, 12, true, 'Re: Votre devis salle de bain', lucas('petit', `La faïence est comprise jusqu'à 35 € le m². Vous pouvez la choisir chez Carrelages du Sud à Mérignac, je m'occupe de la commande.`)],
  ['petit', -40, 20, false, 'Re: Votre devis salle de bain', `Bonjour,\n\nNous avons signé le devis. Quand pouvez-vous commencer ?\n\nClaire et Marc Petit`],
  ['petit', -39, 7, true, 'Re: Votre devis salle de bain', lucas('petit', `Merci pour votre confiance. Je peux démarrer le lundi ${J(-31).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à 8 h.\nL'acompte de 30 % est à régler avant le début du chantier.`)],

  ['garnier', -60, 11, false, 'Peinture appartement', `Bonjour Monsieur Morel,\n\nOn m'a donné votre contact. J'aurais besoin de refaire les peintures du séjour et de deux chambres (environ 65 m² au sol). Pouvez-vous me faire un prix ?\n\nAntoine Garnier`],
  ['garnier', -59, 18, true, 'Re: Peinture appartement', lucas('garnier', `Merci pour votre message. Je vous envoie le devis d'ici demain, d'après les surfaces que vous m'avez données.\nLes plafonds sont-ils à refaire aussi ?`)],
  ['garnier', -58, 9, false, 'Re: Peinture appartement', `Oui, les plafonds aussi, en blanc mat.\n\nA. Garnier`],
  ['garnier', -20, 9, true, 'Facture peinture', lucas('garnier', `Le chantier est terminé, voici la facture du solde.\nMerci de la régler par virement sous 30 jours.`)],
  ['garnier', -2, 21, false, 'Re: Facture peinture', `Bonjour,\n\nVirement du solde fait ce soir. Merci pour le travail, c'est très propre.\n\nAntoine Garnier`],

  ['ouali', -15, 14, false, 'Carrelage cuisine', `Bonjour,\n\nJe souhaite changer le carrelage de ma cuisine (12 m²) et poser une crédence. Pouvez-vous venir voir ?\n\nFatima Ouali\n07 61 22 34 56`],
  ['ouali', -15, 19, true, 'Re: Carrelage cuisine', lucas('ouali', `Merci pour votre demande. Je vous ai fait un premier devis d'après les 12 m².\nJe préfère passer mesurer avant de commander le carrelage.`)],
  ['ouali', -1, 16, false, 'Re: Carrelage cuisine', `Bonjour,\n\nLe devis me va. Pouvez-vous passer ${jour(7)} à 14 h pour mesurer ? Je serai là jusqu'à 17 h.\n\nFatima Ouali`],

  ['ferreira', -9, 20, false, 'Orçamento casa de banho', `Boa tarde,\n\nPreciso de um orçamento para remodelar a casa de banho: retirar a banheira, colocar um duche e azulejos novos. O senhor pode vir ${jourPt(4)} às 18h?\n\nObrigado,\nPaulo Ferreira`],

  ['tilleuls', -33, 10, false, 'Remise en état T2 rue Judaïque', `Bonjour,\n\nNotre locataire du T2 rue Judaïque est parti. Il faut refaire les peintures, changer le revêtement de sol de la chambre et réviser la salle d'eau avant la prochaine location au 1er décembre.\nMerci de nous faire parvenir un devis.\n\nP. Dubreuil\nSCI Les Tilleuls`],
  ['tilleuls', -32, 18, true, 'Re: Remise en état T2 rue Judaïque', lucas('tilleuls', `Je suis passé voir l'appartement avec la gardienne. Vous trouverez le devis dans la foulée.\nPour tenir le 1er décembre, il faudrait valider avant la fin de la semaine.`)],
  ['tilleuls', -30, 9, false, 'Re: Remise en état T2 rue Judaïque', `Devis validé, merci. Merci de nous adresser la facture au nom de la SCI avec l'adresse du siège.\n\nP. Dubreuil`],
  ['tilleuls', -3, 11, false, 'Avancement T2', `Bonjour,\n\nPouvez-vous nous dire où en sont les travaux ? Le nouveau locataire souhaite visiter ${jour(3)}.\n\nP. Dubreuil`],
  ['tilleuls', -3, 19, true, 'Re: Avancement T2', lucas('tilleuls', `Les peintures sont finies, le sol de la chambre est posé ce jeudi. La visite peut se faire, il restera juste les joints de la salle d'eau.`)],

  ['marchand', -6, 9, false, 'Joints de douche', `Bonjour,\n\nLes joints silicone de la douche que vous avez posée en mars noircissent déjà. Est-ce normal ? Pouvez-vous repasser ?\n\nHélène Marchand`],
  ['marchand', -6, 13, true, 'Re: Joints de douche', lucas('marchand', `Désolé pour ça. Ce n'est pas normal si vite, c'est souvent un manque d'aération.\nJe repasse les refaire gratuitement ${jour(2)} à 8 h 30, si vous êtes là.`)],
  ['marchand', -5, 8, false, 'Re: Joints de douche', `Merci, ${jour(2)} 8 h 30 c'est noté.\n\nH. Marchand`],

  ['lopez', -4, 22, false, 'Devis cloison placo', `Salut,\n\nJe voudrais créer une cloison en placo pour séparer une chambre en deux, environ 3,50 m de long sur 2,50 m de haut, avec une porte. Je vous mets le croquis en pièce jointe.\nC'est possible avant Noël ?\n\nKevin`, 'croquis'],

  ['roux', 0, 8, false, 'Fuite sous l\'évier', `Bonjour,\n\nJ'ai une fuite sous l'évier de la cuisine depuis ce matin, j'ai coupé l'eau. Pouvez-vous passer demain matin vers 9 h ?\n\nNathalie Roux\n06 54 32 10 98`],
];
// E-mails sans rapport avec un client : Kadra doit les ignorer
const AUTRES = [
  ['Point P <newsletter@pointp.example.com>', -7, 'Promos de la semaine : -20 % sur les plaques de plâtre', 'Profitez de nos offres pro jusqu’à dimanche.'],
  ['URSSAF <ne-pas-repondre@urssaf.example.com>', -12, 'Votre échéance de cotisations', 'Votre prochaine échéance est disponible dans votre espace.'],
];

// ---------- Devis déjà envoyés (dans le style de Lucas : sections en capitales, « F/P », nettoyage et gravats à chaque fois) ----------
const L = (designation, qte, unite, pu, description = '') => ({ type: 'ligne', designation, description, qte, unite, pu, tva: 10 });
const SEC = t => ({ type: 'section', designation: t, description: '', qte: 0, unite: '', pu: 0, tva: 10 });
const FIN = [L('Évacuation des gravats', 1, 'forfait', 120, 'Benne et déchetterie'), L('Nettoyage fin de chantier', 1, 'forfait', 90)];
const DEVIS = [
  ['petit', 'Rénovation salle de bain', 'accepte', -46, [SEC('DÉMOLITION'), L('Dépose baignoire et faïence', 1, 'forfait', 450), SEC('PLOMBERIE'),
    L('F/P receveur extra-plat 90x140', 1, 'u', 520, 'Résine blanc, bonde extra-plate'), L('F/P paroi de douche fixe', 1, 'u', 380, 'Verre 8 mm, profilé noir mat'),
    L('F/P meuble vasque 80 cm', 1, 'u', 690, 'Avec miroir LED'), L('F/P mitigeur thermostatique', 1, 'u', 240, 'Grohe ou équivalent'), SEC('CARRELAGE'),
    L('F/P faïence murale', 22, 'm²', 85, 'Faïence jusqu’à 35 €/m² au choix du client'), L('F/P carrelage de sol', 6, 'm²', 75), ...FIN]],
  ['garnier', 'Peinture séjour et chambres', 'accepte', -57, [SEC('PEINTURE'), L('Protection des sols et mobilier', 1, 'forfait', 150),
    L('Peinture murs 2 couches', 160, 'm²', 22, 'Lessivage, rebouchage, impression'), L('Peinture plafonds 2 couches', 65, 'm²', 26, 'Blanc mat'), ...FIN]],
  ['ouali', 'Carrelage cuisine', 'envoye', -15, [SEC('DÉMOLITION'), L('Dépose carrelage existant', 12, 'm²', 18), SEC('CARRELAGE'),
    L('Ragréage', 12, 'm²', 16), L('F/P carrelage 60x60', 12, 'm²', 70, 'Grès cérame rectifié'), L('F/P crédence', 3.5, 'm²', 95), ...FIN]],
  ['tilleuls', 'Remise en état T2 rue Judaïque', 'accepte', -32, [SEC('PEINTURE'), L('Peinture murs 2 couches', 110, 'm²', 22, 'Blanc cassé'),
    L('Peinture plafonds 2 couches', 42, 'm²', 26), SEC('SOLS'), L('Dépose moquette chambre', 11, 'm²', 8), L('F/P sol vinyle clipsable', 11, 'm²', 48),
    SEC('SALLE D’EAU'), L('Reprise des joints silicone', 1, 'forfait', 120), L('F/P mitigeur lavabo', 1, 'u', 140), ...FIN]],
  ['marchand', 'Remplacement joints douche', 'envoye', -6, [SEC('SALLE DE BAIN'), L('Reprise des joints silicone', 1, 'forfait', 0, 'Pris en charge au titre de la garantie'), ...FIN.slice(1)]],
];

// ---------- 1) Boîte mail ----------
console.log('Création de la boîte mail d’essai (Ethereal)…');
const boite = await nodemailer.createTestAccount();
const ARTISAN = `Lucas Morel – Morel Rénovation <${boite.user}>`;
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true }); // fabrique le message brut sans l'envoyer
const plan = await PDFDocument.create(), pg = plan.addPage([595, 842]), f = await plan.embedFont(StandardFonts.Helvetica);
pg.drawText('Croquis chambre - cloison a creer', { x: 50, y: 780, size: 16, font: f });
pg.drawRectangle({ x: 80, y: 300, width: 430, height: 380, borderWidth: 2 });
pg.drawLine({ start: { x: 295, y: 300 }, end: { x: 295, y: 680 }, thickness: 3 });
pg.drawText('Cloison 3,50 m x 2,50 m + porte 83 cm', { x: 120, y: 270, size: 12, font: f });
const croquis = Buffer.from(await plan.save());

const imap = new ImapFlow({ host: boite.imap.host, port: boite.imap.port, secure: boite.imap.secure, auth: { user: boite.user, pass: boite.pass }, logger: false });
await imap.connect();
const envoyes = (await imap.list()).find(b => b.specialUse === '\\Sent')?.path;
if (!envoyes) throw new Error('Pas de dossier « Envoyés » dans la boîte d’essai.');
const ids = {}; // dernier Message-ID de chaque fil, pour que les réponses s'enchaînent
let nr = 0, ne = 0;
const deposer = async (dossier, opts, date, vu) => {
  const { message } = await composer.sendMail({ ...opts, date });
  await imap.append(dossier, message, vu ? ['\\Seen'] : [], date);
};
for (const [k, j, h, deLui, sujet, corps, pj] of FILS) {
  const fil = k + sujet.replace(/^Re: /, ''), messageId = `<${k}.${Math.abs(j)}.${h}.${Math.random().toString(36).slice(2)}@essai.kadra>`;
  const client = `${C[k].nom} <${C[k].email}>`;
  await deposer(deLui ? envoyes : 'INBOX', {
    from: deLui ? ARTISAN : client, to: deLui ? client : ARTISAN, subject: sujet, text: corps, messageId,
    ...(ids[fil] && { inReplyTo: ids[fil], references: [ids[fil]] }),
    ...(pj === 'croquis' && { attachments: [{ filename: 'croquis-cloison.pdf', content: croquis }] }),
  }, at(j, h, 7 + (nr + ne) % 50), deLui || j < -1);
  ids[fil] = messageId;
  deLui ? ne++ : nr++;
}
for (const [de, j, sujet, corps] of AUTRES) { await deposer('INBOX', { from: de, to: ARTISAN, subject: sujet, text: corps }, at(j, 6), true); nr++; }
await imap.logout();
console.log(`  ${nr} e-mails reçus et ${ne} réponses de l'artisan déposés.`);

// ---------- 2) Compte Kadra d'essai ----------
let cookie = '';
const api = async (p, method = 'GET', body) => {
  const r = await fetch(`${KADRA}/api/${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${p} : ${j.error || r.status}`), { status: r.status });
  return j;
};
try { await api('auth/signup', 'POST', COMPTE); console.log(`Compte Kadra d'essai créé sur ${KADRA}`); }
catch (e) {
  if (e.status !== 409) throw new Error(`Kadra ne répond pas sur ${KADRA} (lancez « npm start ») : ${e.message}`);
  await api('auth/login', 'POST', COMPTE); console.log(`Compte Kadra d'essai déjà là sur ${KADRA} : il est réutilisé.`);
}
await api('settings', 'PUT', { nom: COMPTE.entreprise, email: boite.user, tel: '06 71 42 18 90', adresse: '22 rue Saint-Genès\n33000 Bordeaux', tva_defaut: 10, acompte_defaut: 30,
  imap_host: '', imap_user: '', imap_pass: '', imap_etat: {}, imap_erreur: '', imap_releve_le: null }); // boîte à brancher à la main
await api('me/langue', 'PUT', { langue: 'fr-FR', langue2: '' });
const existants = await api('clients');
for (const c of Object.values(C)) {
  const ex = existants.find(x => x.email === c.email);
  c.id = ex ? ex.id : (await api('clients', 'POST', { nom: c.nom, email: c.email, tel: c.tel, adresse: c.adresse })).id;
}
const deja = (await api('documents')).filter(d => d.type === 'devis').map(d => d.data?.objet);
let nd = 0;
for (const [k, objet, statut, j, lignes] of DEVIS) {
  if (deja.includes(objet)) continue;
  const c = C[k];
  const d = await api('documents', 'POST', { type: 'devis', client_id: c.id, date: iso(j),
    data: { client: { nom: c.nom, adresse: c.adresse, email: c.email, tel: c.tel }, objet, adresse_chantier: c.adresse.replace('\n', ' '), lignes, remise_pct: 0, acompte_pct: 30, notes: '' } });
  await api('documents/' + d.id, 'PUT', { statut, date: iso(j) });
  nd++;
}
console.log(`  ${Object.keys(C).length} clients et ${nd} devis envoyés ou signés${nd < DEVIS.length ? ' (les autres existaient déjà)' : ''}.`);

console.log(`
──────────── À faire dans Kadra ────────────
1. Ouvrez ${KADRA} et connectez-vous : ${COMPTE.email} / ${COMPTE.password}
2. Paramètres > Automatismes > « Brancher ou changer la boîte mail » :
     Adresse e-mail : ${boite.user}
     Mot de passe   : ${boite.pass}
     Serveur IMAP   : ${boite.imap.host}      Port : ${boite.imap.port}
3. « Relever maintenant », puis allez dans E-mails, Agenda (rendez-vous trouvés) et Paramètres > Kadra vous connaît.
La boîte se lit aussi sur https://ethereal.email/login avec ces identifiants. C'est une boîte jetable : relancez « npm run boite-test » pour en refaire une.`);
