// Base de démonstration : recrée demo.db avec une entreprise fictive et un an d'activité, puis lance le site sur le port 3001.
// npm run demo → http://localhost:3001 (demo@kadra.fr / demo1234). La vraie base devis.db n'est pas touchée.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { remplirDemo } from './demo-donnees.js';
import { totaux } from './public/calc.js';

const DB = (process.env.DB_FILE ||= 'demo.db'); // autre fichier = autre démo (ex. enregistrement de la vidéo), sans toucher demo.db
process.env.PORT ||= '3001';
process.env.KADRA_ADMIN ||= 'equipe@kadra.fr'; // compte « équipe Kadra » de la démo : page Modèles à reproduire
// Pas de .env pour la démo (aucun vrai e-mail), sauf les comptes Claude de secours.
try { process.env.CLAUDE_COMPTES ||= /^CLAUDE_COMPTES=(.*)$/m.exec(fs.readFileSync('.env', 'utf8'))?.[1].trim() || ''; } catch {}
// Boîte mail de test Ethereal (gratuite, fournie par nodemailer) : Kadra y envoie et y relève pour de vrai, rien n'arrive chez personne. Sans internet : envois simulés.
const boite = await nodemailer.createTestAccount().catch(() => null);
if (boite) Object.assign(process.env, { SMTP_HOST: boite.smtp.host, SMTP_PORT: String(boite.smtp.port), SMTP_USER: boite.user, SMTP_PASS: boite.pass });
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
await import('./server.js'); // crée les tables et lance le serveur ; on remplit la base avant la première requête

const db = new DatabaseSync(DB);
const URL = `http://localhost:${process.env.PORT}`;
const ins = (t, o) => { const k = Object.keys(o); return Number(db.prepare(`INSERT INTO ${t} (${k}) VALUES (${k.map(() => '?')})`).run(...k.map(x => (o[x] && typeof o[x] === 'object' ? JSON.stringify(o[x]) : o[x] ?? null))).lastInsertRowid); };
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };

const cid = ins('comptes', { settings: {} });
const { S, C } = remplirDemo(db, cid, { url: URL });
// Modèle DEVIS 015 (reproduit par Kadra, gardé dans demo-015.json, hors GitHub) : remis à chaque lancement, mise en page par défaut.
try {
  const m = JSON.parse(fs.readFileSync('demo-015.json', 'utf8'));
  Object.assign(S, { template_id: ins('templates', { compte_id: cid, nom: m.nom, html: m.html, builtin: 0 }), logo: m.logo || S.logo, cachet: m.cachet || S.cachet });
} catch (e) { if (e.code !== 'ENOENT') console.error('Modèle DEVIS 015 non repris :', e.message); }
if (boite) Object.assign(S, { imap_host: boite.imap.host, imap_port: boite.imap.port, imap_user: boite.user, imap_pass: boite.pass });
db.prepare('UPDATE comptes SET settings=? WHERE id=?').run(JSON.stringify(S), cid);
ins('users', { compte_id: cid, email: 'demo@kadra.fr', nom: 'Mehmet Yildiz', hash: hashPw('demo1234'), role: 'admin', langue: 'fr-FR' });
ins('users', { compte_id: cid, email: 'lea.garnier@example.com', nom: 'Léa Garnier', hash: hashPw('demo1234'), role: 'membre', langue: 'fr-FR' });
ins('users', { compte_id: ins('comptes', { settings: { nom: 'Équipe Kadra' } }), email: 'equipe@kadra.fr', nom: 'Équipe Kadra', hash: hashPw('demo1234'), role: 'admin', langue: 'fr-FR' });
// Compte SARL DAS (son devis Excel « DEVIS DAS 2026-79B » repris en mise en page + le devis lui-même), gardé dans demo-das.json (hors GitHub).
try {
  const j = JSON.parse(fs.readFileSync('demo-das.json', 'utf8')), dc = ins('comptes', { settings: {} });
  const tpl = ins('templates', { compte_id: dc, nom: j.modele.nom, html: j.modele.html, builtin: 0 });
  db.prepare('UPDATE comptes SET settings=? WHERE id=?').run(JSON.stringify({ ...j.entreprise, email: 'das@kadra.fr', template_id: tpl }), dc);
  const cl = ins('clients', { compte_id: dc, ...j.client });
  const t = totaux({ lignes: j.devis.lignes });
  ins('documents', { compte_id: dc, type: 'devis', numero: j.devis.numero, client_id: cl, template_id: tpl, statut: 'brouillon', date: j.devis.date, echeance: j.devis.date,
    total_ht: t.ht, total_ttc: t.ttc, token: crypto.randomBytes(24).toString('hex'),
    data: { client: j.client, objet: j.devis.objet, adresse_chantier: j.devis.adresse_chantier, notes: '', lignes: j.devis.lignes } });
  ins('users', { compte_id: dc, email: 'das@kadra.fr', nom: 'SARL DAS', hash: hashPw('demo1234'), role: 'admin', langue: 'fr-FR' });
} catch (e) { if (e.code !== 'ENOENT') console.error('Compte SARL DAS non créé :', e.message); }

// Nouveaux e-mails de clients déposés dans la boîte de test : à récupérer avec « Relever la boîte mail » (ou tout seuls dans les 10 min).
if (boite) {
  const t = nodemailer.createTransport({ host: boite.smtp.host, port: boite.smtp.port, auth: { user: boite.user, pass: boite.pass } });
  const plan = await PDFDocument.create(), pg = plan.addPage([595, 842]), font = await plan.embedFont(StandardFonts.Helvetica);
  pg.drawText('Plan d\'acces au jardin - 19 route de Lyon, Dardilly', { x: 50, y: 780, size: 16, font });
  pg.drawRectangle({ x: 80, y: 300, width: 430, height: 380, borderWidth: 2 });
  pg.drawText('Portail 2,50 m', { x: 90, y: 310, size: 12, font });
  pg.drawText('Terrasse (35 m2)', { x: 230, y: 560, size: 14, font });
  for (const [k, subject, text, attachments] of [
    ['lambert', 'Re: Question sur le devis fenêtres', `Bonjour,

Merci pour vos réponses. C’est d’accord pour l’anthracite, je vais signer le devis.
Pouvez-vous passer jeudi à 10 h pour reprendre les mesures ?

Sophie Lambert`],
    ['roche', 'Accès pour la livraison', `Bonjour,

Ci-joint le plan d’accès au jardin pour la livraison des lames. Le portail fait 2,50 m de large.

Julien Roche`, [{ filename: 'plan-acces.pdf', content: Buffer.from(await plan.save()) }]],
    ['girard', 'Virement effectué', `Bonjour,

Je viens de faire le virement du solde restant, comme convenu. Merci pour votre patience.

Thomas Girard`],
    ['demir', 'Mutfak', `Merhaba Mehmet Bey,

Cuma günü saat 17’de daireye gelebilir misiniz? Mutfak dolaplarını da konuşmak istiyorum.

Aylin`],
    ['fournil', 'Re: Travaux sanitaires', `Bonjour,

Le WC est-il bien arrivé ? Le contrôle d’accessibilité est maintenu le 16 novembre à 10 h.

Jérôme Fabre`],
  ]) await t.sendMail({ from: { name: C[k].nom, address: C[k].email }, to: S.email, subject, text, attachments });
  console.log(`Boîte mail de test : 5 nouveaux e-mails de clients (relevés tout seuls, ou E-mails > Relever la boîte mail).
Tout ce que Kadra envoie arrive ici : https://ethereal.email/login  ${boite.user} / ${boite.pass}`);
}
console.log(`Démo prête : ${URL}  (artisan : demo@kadra.fr / demo1234 ; équipe Kadra : equipe@kadra.fr / demo1234 ; SARL DAS : das@kadra.fr / demo1234)`);
