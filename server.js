import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { totaux, lignesAcompte, lignesSolde, lignesSituation, r2, eur, CATEGORIES, ecritures } from './public/calc.js';
import { renderDoc, docContext, partialJSON, BUILTINS, SAMPLE, PLACEHOLDERS } from './templates.js';
import { htmlToPdf, htmlToPng, ciiXml, facturx } from './pdf.js';
import { xlsxToHtml, docxTexte } from './xlsx.js';
import { extraire } from './public/i18n.js';

const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MODEL = 'claude-opus-5-5';

// ---------- Base de données (une ligne `comptes` = une entreprise ; toutes les données portent compte_id) ----------
const DB_FILE = process.env.DB_FILE || 'devis.db';
const db = new DatabaseSync(DB_FILE);
const DOCUMENTS_DDL = `CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('devis','facture','modele')), kind TEXT DEFAULT 'standard', numero TEXT, nom TEXT,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, chantier_id INTEGER REFERENCES chantiers(id) ON DELETE SET NULL,
  parent_id INTEGER, template_id INTEGER, statut TEXT DEFAULT 'brouillon', date TEXT, echeance TEXT, data TEXT NOT NULL DEFAULT '{}',
  total_ht REAL DEFAULT 0, total_ttc REAL DEFAULT 0, token TEXT UNIQUE, signature TEXT, signe_par TEXT, signe_le TEXT, signe_ip TEXT,
  envoye_le TEXT, relances INTEGER DEFAULT 0, derniere_relance TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (compte_id, numero))`;
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS comptes (id INTEGER PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, compte_id INTEGER NOT NULL REFERENCES comptes(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, nom TEXT, hash TEXT NOT NULL, role TEXT DEFAULT 'membre', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resets (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resets (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, nom TEXT NOT NULL,
  adresse TEXT, email TEXT, tel TEXT, siret TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, designation TEXT NOT NULL,
  description TEXT, unite TEXT, pu REAL DEFAULT 0, tva REAL DEFAULT 10);
CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, nom TEXT NOT NULL,
  html TEXT NOT NULL, builtin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS chantiers (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, nom TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, devis_id INTEGER, adresse TEXT, date_debut TEXT, date_fin_prevue TEXT, date_fin_reelle TEXT,
  avancement INTEGER DEFAULT 0, statut TEXT DEFAULT 'a_venir', email_suivi TEXT, notes TEXT, retard_notifie_le TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
${DOCUMENTS_DDL};
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, montant REAL NOT NULL, date TEXT, mode TEXT, note TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY, compte_id INTEGER, a TEXT, sujet TEXT, corps TEXT, statut TEXT, document_id INTEGER,
  chantier_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS rdv (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, titre TEXT NOT NULL,
  debut TEXT NOT NULL, fin TEXT, lieu TEXT, notes TEXT, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  chantier_id INTEGER REFERENCES chantiers(id) ON DELETE SET NULL, email_id INTEGER, statut TEXT DEFAULT 'confirme', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- photos de chantier : image JPEG réduite à 1200 px côté navigateur, en data URL (ponytail: dans la base ; passer sur disque si elle dépasse quelques Go)
CREATE TABLE IF NOT EXISTS pieces (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE, nom TEXT, type TEXT, taille INTEGER, data BLOB);
CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  chantier_id INTEGER NOT NULL REFERENCES chantiers(id) ON DELETE CASCADE, image TEXT NOT NULL, legende TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- dépenses (achats, sous-traitance…) : gardées si le chantier est supprimé (comptabilité). justificatif = data URL (photo réduite ou PDF).
CREATE TABLE IF NOT EXISTS depenses (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  chantier_id INTEGER REFERENCES chantiers(id) ON DELETE SET NULL, date TEXT NOT NULL, fournisseur TEXT, libelle TEXT, categorie TEXT DEFAULT 'materiaux',
  ttc REAL NOT NULL DEFAULT 0, tva REAL NOT NULL DEFAULT 0, justificatif TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// rdv.debut : « AAAA-MM-JJ » (toute la journée) ou « AAAA-MM-JJTHH:MM » (heure locale) ; statut 'propose' = trouvé par Claude dans un e-mail, à confirmer.

// Migration d'une base de la première version (mono-entreprise).
const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (!cols('documents').includes('compte_id')) {
  db.exec('PRAGMA foreign_keys=OFF; BEGIN');
  for (const t of ['clients', 'catalog', 'templates', 'chantiers', 'payments', 'emails']) if (!cols(t).includes('compte_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN compte_id INTEGER`);
  const old = cols('documents');
  db.exec(`${DOCUMENTS_DDL.replace('documents (', 'documents_new (')}; INSERT INTO documents_new (${old}) SELECT ${old} FROM documents;
    DROP TABLE documents; ALTER TABLE documents_new RENAME TO documents; COMMIT; PRAGMA foreign_keys=ON;`);
}
if (!cols('clients').includes('siret')) db.exec('ALTER TABLE clients ADD COLUMN siret TEXT');
if (!cols('users').includes('langue')) db.exec('ALTER TABLE users ADD COLUMN langue TEXT');
if (!cols('users').includes('langue2')) db.exec('ALTER TABLE users ADD COLUMN langue2 TEXT'); // 2e langue du micro (pastille), NULL = une seule langue
if (!cols('payments').includes('ref')) db.exec('ALTER TABLE payments ADD COLUMN ref TEXT');
if (!cols('rdv').includes('rappel_le')) db.exec('ALTER TABLE rdv ADD COLUMN rappel_le TEXT');
for (const [c, def] of [['sens', "TEXT DEFAULT 'envoye'"], ['de', 'TEXT'], ['message_id', 'TEXT'], ['client_id', 'INTEGER'], ['lu', 'INTEGER DEFAULT 1'], ['rdv_vu', 'INTEGER DEFAULT 0']]) if (!cols('emails').includes(c)) db.exec(`ALTER TABLE emails ADD COLUMN ${c} ${def}`);
// notes dictées (sur le chantier, matériaux, travaux à chiffrer) : reprises plus tard pour faire un devis
db.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, texte TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, chantier_id INTEGER REFERENCES chantiers(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS notes_compte ON notes(compte_id);
-- prestation payante : l'artisan envoie son devis habituel, l'équipe Kadra (KADRA_ADMIN) le reproduit dans son compte.
-- fichier = data URL (la colonne ne doit pas s'appeler data : parseRow la lirait comme du JSON)
CREATE TABLE IF NOT EXISTS demandes_modele (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  user_email TEXT, nom TEXT, fichier TEXT NOT NULL, message TEXT, statut TEXT DEFAULT 'nouvelle', template_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- photos jointes à la dictée d'un devis (pièce, plan) ; copiées dans les photos du chantier quand il est créé
CREATE TABLE IF NOT EXISTS doc_photos (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, image TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- envois rejoués par le mode chantier (en-tête X-Kadra-Cle) : la 2e fois, la même réponse sans refaire (pas de doublon). reponse NULL = en cours.
CREATE TABLE IF NOT EXISTS envois (compte_id INTEGER, cle TEXT, reponse TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (compte_id, cle));
-- anciens devis et factures de l'artisan (changement de logiciel) : lus par Claude, vérifiés par l'artisan, puis copiés dans documents.
-- fichier = data URL (gardé : c'est l'original servi en PDF) ; resultat = ce que Claude a lu (JSON) ; etat : attente | lecture | lu | erreur | importe | doublon | ignore
CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY, compte_id INTEGER REFERENCES comptes(id) ON DELETE CASCADE, nom TEXT, fichier TEXT NOT NULL,
  empreinte TEXT, source TEXT DEFAULT 'fichier', email_a TEXT, etat TEXT DEFAULT 'attente', resultat TEXT, erreur TEXT,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (compte_id, empreinte));`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS emails_msgid ON emails(compte_id, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_ref ON payments(ref);
${['clients', 'catalog', 'templates', 'chantiers', 'documents', 'payments', 'emails', 'rdv', 'photos', 'depenses'].map(t => `CREATE INDEX IF NOT EXISTS ${t}_compte ON ${t}(compte_id);`).join('\n')}`);

const all = (sql, ...p) => db.prepare(sql).all(...p).map(parseRow);
const get = (sql, ...p) => parseRow(db.prepare(sql).get(...p));
const run = (sql, ...p) => db.prepare(sql).run(...p);
function parseRow(r) { if (r && typeof r.data === 'string') r = { ...r, data: JSON.parse(r.data) }; return r && { ...r }; }

const DEFAULT_SETTINGS = {
  nom: 'Mon entreprise', adresse: '', siret: '', rcs: '', tva_intra: '', tel: '', email: '', site: '', assurance: '', iban: '', bic: '', logo: '', cachet: '',
  couleur: '#2f5bea', franchise_tva: false, tva_defaut: 10, validite_jours: 30, delai_paiement_jours: 30, acompte_defaut: 30, langue: 'fr-FR', template_id: 1,
  categorie_operation: 'prestation de services', tva_debits: false, acompte_auto: false, stripe_secret: '', stripe_webhook_secret: '',
  conditions_paiement: '30 % d’acompte à la signature, solde à réception de la facture de fin de travaux.',
  mentions: 'Pénalités de retard : 3 fois le taux d’intérêt légal. Indemnité forfaitaire pour frais de recouvrement : 40 € (clients professionnels). Pas d’escompte pour paiement anticipé.',
  resume_quotidien: true, rdv_auto: true, rappel_rdv: true, imap_host: '', imap_port: 993, imap_user: '', imap_pass: '',
  relances_auto: true, relance_devis_jours: 7, relance_facture_jours: 7, relances_max: 3, alerte_retard_chantier: true,
  mail_envoi: 'Bonjour {client},\n\nVeuillez trouver ci-joint votre {type} n° {numero} d’un montant de {montant} TTC.\nVous pouvez aussi le consulter{signer} en ligne :\n{lien}\n\nCordialement,\n{entreprise}',
  mail_relance_devis: 'Bonjour {client},\n\nAvez-vous pu étudier notre devis n° {numero} ({montant} TTC) ? Vous pouvez le signer en ligne en un clic :\n{lien}\n\nCordialement,\n{entreprise}',
  mail_relance_facture: 'Bonjour {client},\n\nSauf erreur de notre part, la facture n° {numero} échue le {echeance} reste impayée (reste dû : {reste}).\nRèglement possible en ligne : {lien}\n\nCordialement,\n{entreprise}',
  mail_retard_chantier: 'Bonjour {client},\n\nNous vous informons que le chantier « {chantier} », dont la fin était prévue le {date_fin}, a pris du retard (avancement actuel : {avancement} %). Nous revenons vers vous très vite avec une nouvelle date.\n\nCordialement,\n{entreprise}',
  mail_rappel_rdv: 'Bonjour {client},\n\nPetit rappel : nous avons rendez-vous demain {quand}{lieu} ({objet}).\nEn cas d’empêchement, merci de nous prévenir en répondant à cet e-mail.\n\nCordialement,\n{entreprise}',
  mail_point: 'Bonjour {client},\n\nPoint d’avancement du chantier « {chantier} » : {avancement} % réalisé.\nMontant du marché : {budget}, déjà réglé : {encaisse}, reste : {reste}.\n\nCordialement,\n{entreprise}',
};
for (const t of BUILTINS) { const b = get('SELECT id FROM templates WHERE builtin=1 AND nom=?', t.nom); if (b) run('UPDATE templates SET html=? WHERE id=?', t.html, b.id); else run('INSERT INTO templates (nom, html, builtin) VALUES (?,?,1)', t.nom, t.html); } // mises en page intégrées : toujours la dernière version, les nouvelles arrivent aussi dans les bases existantes
// Secrets (clé Stripe, mot de passe de la boîte mail) chiffrés en base (AES-256-GCM). La clé vient de KADRA_KEY,
// sinon du fichier .kadra.key créé au premier lancement : à sauvegarder À PART de la base (sans elle, les secrets sont à ressaisir).
const SECRETS = ['stripe_secret', 'stripe_webhook_secret', 'imap_pass'];
const KEYFILE = path.resolve('.kadra.key');
if (!process.env.KADRA_KEY && !fs.existsSync(KEYFILE)) fs.writeFileSync(KEYFILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const CLE = Buffer.from((process.env.KADRA_KEY || fs.readFileSync(KEYFILE, 'utf8')).trim(), 'hex');
const chiffre = v => {
  if (!v || String(v).startsWith('enc:')) return v;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', CLE, iv), ct = Buffer.concat([c.update(String(v)), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const dechiffre = v => {
  if (!String(v).startsWith('enc:')) return v;
  try { const b = Buffer.from(v.slice(4), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', CLE, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(); }
  catch { return ''; } // clé changée : le secret est à ressaisir
};
const settings = cid => {
  const s = { ...DEFAULT_SETTINGS, ...JSON.parse(get('SELECT settings FROM comptes WHERE id=?', cid)?.settings || '{}') };
  for (const k of SECRETS) s[k] = dechiffre(s[k]);
  return s;
};
const saveSettings = (cid, patch) => {
  const s = { ...settings(cid), ...patch };
  for (const k of SECRETS) s[k] = chiffre(s[k]);
  run('UPDATE comptes SET settings=? WHERE id=?', JSON.stringify(s), cid);
};
for (const { id, settings: raw } of all('SELECT id, settings FROM comptes')) if (SECRETS.some(k => JSON.parse(raw)[k] && !String(JSON.parse(raw)[k]).startsWith('enc:'))) saveSettings(id, {}); // anciennes bases : secrets en clair → chiffrés
const masked = s => { for (const k of SECRETS) s[k] = s[k] ? 'configuré' : ''; return s; };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5).toISOString().slice(0, 10);
const daysSince = d => (Date.now() - new Date(d).getTime()) / 864e5;
const plural = (n, s, p = s + 's') => `${n} ${n > 1 ? p : s}`;
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Vues enrichies, toujours filtrées ensuite par entreprise (voir scoped).
const VIEWS = {
  // regle : ce qui n'est plus à payer maintenant (paiements, avoirs, retenue de garantie gardée par le client).
  // ponytail: la retenue compte comme réglée ; pas encore de rappel pour la réclamer un an après la réception.
  documents: `SELECT x.*, CASE WHEN x.retenue > 0 THEN MIN(x.total_ttc, x.paye + x.avoirs + x.retenue) ELSE x.paye + x.avoirs END regle FROM (SELECT d.*, c.nom client_nom, c.email client_email,
    CASE WHEN d.type='facture' AND d.kind!='avoir' THEN ROUND(d.total_ttc * COALESCE(json_extract(d.data, '$.retenue_pct'), 0) / 100, 2) ELSE 0 END retenue,
    (SELECT numero FROM documents pa WHERE pa.id=d.parent_id) parent_numero,
    (SELECT COALESCE(SUM(montant),0) FROM payments p WHERE p.document_id=d.id) paye,
    (SELECT COALESCE(SUM(-a.total_ttc),0) FROM documents a WHERE a.parent_id=d.id AND a.kind='avoir' AND a.numero IS NOT NULL) avoirs
    FROM documents d LEFT JOIN clients c ON c.id=d.client_id) x`,
  chantiers: `SELECT ch.*, c.nom client_nom, c.email client_email, dv.numero devis_numero, COALESCE(dv.total_ttc,0) budget, COALESCE(dv.total_ht,0) budget_ht,
    (SELECT COALESCE(ROUND(SUM(x.ttc - x.tva), 2),0) FROM depenses x WHERE x.chantier_id=ch.id) depenses,
    (SELECT COALESCE(SUM(total_ttc),0) FROM documents f WHERE f.type='facture' AND f.kind!='avoir' AND f.numero IS NOT NULL AND f.chantier_id=ch.id) facture,
    (SELECT COALESCE(SUM(p.montant),0) FROM payments p JOIN documents f ON f.id=p.document_id WHERE f.chantier_id=ch.id) encaisse
    FROM chantiers ch LEFT JOIN clients c ON c.id=ch.client_id LEFT JOIN documents dv ON dv.id=ch.devis_id`,
  rdv: `SELECT r.*, c.nom client_nom, c.tel client_tel, ch.nom chantier_nom, (SELECT sujet FROM emails e WHERE e.id=r.email_id) email_sujet
    FROM rdv r LEFT JOIN clients c ON c.id=r.client_id LEFT JOIN chantiers ch ON ch.id=r.chantier_id`,
  notes: `SELECT n.*, COALESCE(n.client_id, ch.client_id) cli, c.nom client_nom, ch.nom chantier_nom
    FROM notes n LEFT JOIN chantiers ch ON ch.id=n.chantier_id LEFT JOIN clients c ON c.id=COALESCE(n.client_id, ch.client_id)`,
  // sans le justificatif (lourd) : servi à part par /api/depenses/:id/justificatif
  depenses: `SELECT d.id, d.compte_id, d.chantier_id, d.date, d.fournisseur, d.libelle, d.categorie, d.ttc, d.tva, ROUND(d.ttc - d.tva, 2) ht, d.created_at,
    COALESCE(d.justificatif, '') <> '' justif, ch.nom chantier_nom FROM depenses d LEFT JOIN chantiers ch ON ch.id=d.chantier_id`,
};
// Tous les e-mails, avec le client retrouvé (fiche, document, chantier ou adresse) : rubrique E-mails et recherche des rendez-vous.
// Pièces jointes d'un e-mail (sans leur contenu) : [{id, nom}] en JSON.
const PIECES = "(SELECT json_group_array(json_object('id', p.id, 'nom', p.nom)) FROM pieces p WHERE p.email_id=e.id) pieces";
const MAILS = `SELECT x.*, c.nom client_nom FROM (SELECT e.*, ${PIECES}, COALESCE(e.client_id, d.client_id, ch.client_id,
    (SELECT k.id FROM clients k WHERE k.compte_id=e.compte_id AND k.email<>'' AND k.email=e.a COLLATE NOCASE LIMIT 1)) cli
  FROM emails e LEFT JOIN documents d ON d.id=e.document_id LEFT JOIN chantiers ch ON ch.id=e.chantier_id WHERE e.compte_id=?) x LEFT JOIN clients c ON c.id=x.cli`;
const COLS = {
  clients: ['nom', 'adresse', 'email', 'tel', 'siret'],
  catalog: ['designation', 'description', 'unite', 'pu', 'tva'],
  templates: ['nom', 'html'],
  chantiers: ['nom', 'client_id', 'devis_id', 'adresse', 'date_debut', 'date_fin_prevue', 'date_fin_reelle', 'avancement', 'statut', 'email_suivi', 'notes', 'retard_notifie_le'],
  payments: ['document_id', 'montant', 'date', 'mode', 'note'],
  documents: ['type', 'kind', 'nom', 'client_id', 'chantier_id', 'parent_id', 'template_id', 'statut', 'date', 'echeance', 'data'],
  rdv: ['titre', 'debut', 'fin', 'lieu', 'notes', 'client_id', 'chantier_id', 'email_id', 'statut'],
  photos: ['chantier_id', 'image', 'legende'],
  doc_photos: ['document_id', 'image'],
  notes: ['texte', 'client_id', 'chantier_id'],
  depenses: ['chantier_id', 'date', 'fournisseur', 'libelle', 'categorie', 'ttc', 'tva', 'justificatif'],
};
// Clés étrangères vérifiées contre l'entreprise : impossible de pointer vers les données d'une autre.
const REFS = { client_id: 'clients', chantier_id: 'chantiers', parent_id: 'documents', devis_id: 'documents', document_id: 'documents', template_id: 'templates', email_id: 'emails' };
const scoped = (t, cid) => (t === 'templates' ? `SELECT * FROM templates WHERE (compte_id=${+cid} OR builtin=1)` : `SELECT * FROM (${VIEWS[t] || `SELECT * FROM ${t}`}) WHERE compte_id=${+cid}`);
const one = (t, id, cid) => get(`SELECT * FROM (${scoped(t, cid)}) WHERE id=?`, id);
const own = (t, id, cid) => one(t, id, cid) || (() => { throw httpErr(404, 'Introuvable'); })();

function nextNumero(type, cid) {
  const p = `${{ devis: 'DEV', facture: 'FAC', avoir: 'AV' }[type]}-${new Date().getFullYear()}-`;
  // numéros importés d'un ancien logiciel au même format : on continue après ; un autre format (« FAC-2026-12-B ») est ignoré
  const n = all('SELECT numero FROM documents WHERE compte_id=? AND numero LIKE ?', cid, p + '%').map(r => r.numero.slice(p.length)).filter(x => /^\d+$/.test(x)).map(Number);
  return p + String(Math.max(0, ...n) + 1).padStart(4, '0');
}

// Règles métier appliquées à chaque écriture d'un document.
function prepareDoc(row, old, cid) {
  const s = settings(cid), m = { ...old, ...row };
  if (row.data) {
    const t = totaux(row.data, s.franchise_tva);
    row.total_ht = t.ht; row.total_ttc = t.ttc;
    const c = row.data.client;
    if (c?.nom?.trim() && !m.client_id) {
      const ex = get('SELECT id FROM clients WHERE compte_id=? AND lower(nom)=lower(?)', cid, c.nom.trim());
      row.client_id = ex ? ex.id : Number(run('INSERT INTO clients (compte_id, nom, adresse, email, tel, siret) VALUES (?,?,?,?,?,?)', cid, c.nom.trim(), c.adresse || '', c.email || '', c.tel || '', c.siret || '').lastInsertRowid);
    }
  }
  if (!old.id) {
    row.token = crypto.randomBytes(24).toString('hex');
    row.statut ||= 'brouillon';
    row.date ||= today();
    row.template_id ||= s.template_id;
    if (m.type === 'devis') { row.numero = nextNumero('devis', cid); row.echeance ||= addDays(row.date, s.validite_jours); }
    if (m.type === 'facture' && m.kind !== 'avoir') row.echeance ||= addDays(row.date, s.delai_paiement_jours);
  }
  // Facture / avoir : numéro attribué à l'émission (séquence chronologique sans trou).
  // Facture de la visite guidée : jamais de numéro (elle reste effaçable et la vraie numérotation ne bouge pas).
  if (m.type === 'facture' && (row.statut ?? old.statut) !== 'brouillon' && !old.numero && !m.data?.exemple) row.numero = nextNumero(m.kind === 'avoir' ? 'avoir' : 'facture', cid);
  return row;
}

function checkRefs(row, cid) {
  for (const [k, t] of Object.entries(REFS)) if (row[k] != null && row[k] !== '' && !one(t, row[k], cid)) throw httpErr(400, `Référence invalide : ${k}`);
}
const RDV_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
function checkRdv(row) {
  if (('debut' in row && !RDV_DATE.test(row.debut || '')) || (row.fin && !RDV_DATE.test(row.fin))) throw httpErr(400, 'Date du rendez-vous invalide.');
  if ('titre' in row && !String(row.titre || '').trim()) throw httpErr(400, 'Donnez un objet au rendez-vous.');
}
const JUSTIF = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([\w+/=]+)$/;
function checkDepense(row) {
  if ('date' in row && !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) throw httpErr(400, 'Date de la dépense invalide.');
  if ('ttc' in row && !(row.ttc = r2(row.ttc))) throw httpErr(400, 'Indiquez le montant payé (TTC).');
  if ('tva' in row) row.tva = r2(row.tva);
  if ('ttc' in row && 'tva' in row && Math.abs(row.tva) > Math.abs(row.ttc)) throw httpErr(400, 'La TVA ne peut pas dépasser le montant TTC.');
  if ('categorie' in row && !CATEGORIES[row.categorie]) row.categorie = 'autre';
  if (row.justificatif && !JUSTIF.test(row.justificatif)) throw httpErr(400, 'Justificatif illisible : photo ou PDF.');
}
const pick = (t, b) => Object.fromEntries(COLS[t].filter(k => k in b).map(k => [k, b[k]]));
const dbVal = v => (v && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? +v : v ?? null);
const stripScripts = h => String(h || '').replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

function insert(t, body, cid) {
  let row = pick(t, body);
  checkRefs(row, cid);
  if (t === 'rdv') checkRdv(row);
  if (t === 'notes' && !String(row.texte || '').trim()) throw httpErr(400, 'La note est vide.');
  if (t === 'depenses') { row.date ||= today(); row.ttc ??= 0; checkDepense(row); }
  if (t === 'photos' && !/^data:image\/(jpeg|png|webp);base64,[\w+/=]+$/.test(row.image || '')) throw httpErr(400, 'Photo illisible.');
  if (t === 'documents') row = prepareDoc(row, {}, cid);
  if (t === 'templates') row.html = stripScripts(row.html);
  row.compte_id = cid;
  const k = Object.keys(row);
  const id = run(`INSERT INTO ${t} (${k}) VALUES (${k.map(() => '?')})`, ...k.map(x => dbVal(row[x]))).lastInsertRowid;
  return one(t, Number(id), cid);
}
function update(t, id, body, cid) {
  const old = get(`SELECT * FROM ${t} WHERE id=? AND compte_id=?`, id, cid);
  if (!old) throw httpErr(404, t === 'templates' ? 'Modèle intégré : dupliquez-le pour le modifier.' : 'Introuvable');
  let row = pick(t, body);
  checkRefs(row, cid);
  if (t === 'rdv') checkRdv(row);
  if (t === 'depenses') checkDepense(row);
  if (t === 'notes' && 'texte' in row && !String(row.texte || '').trim()) throw httpErr(400, 'La note est vide.');
  if (t === 'photos') delete row.image; // une photo ne se remplace pas : on la supprime
  // Facture émise : contenu figé (seule la mise en page peut changer) ; on corrige par un avoir.
  if (t === 'documents' && old.type === 'facture' && old.numero && Object.keys(row).some(k => k !== 'template_id' && !(k === 'statut' && row.statut !== 'brouillon')))
    throw httpErr(400, 'Facture émise : modification impossible, créez un avoir.');
  if (t === 'documents') row = prepareDoc(row, old, cid);
  if (t === 'templates' && row.html) row.html = stripScripts(row.html);
  const k = Object.keys(row);
  if (k.length) run(`UPDATE ${t} SET ${k.map(x => `${x}=?`)} WHERE id=? AND compte_id=?`, ...k.map(x => dbVal(row[x])), id, cid);
  return one(t, id, cid);
}

function html(doc, extra = '') {
  const s = settings(doc.compte_id);
  const tpl = one('templates', doc.template_id, doc.compte_id) || get('SELECT html FROM templates WHERE builtin=1 ORDER BY id LIMIT 1');
  const fac = doc.type === 'facture' && doc.kind !== 'avoir';
  const out = renderDoc(doc, s, tpl.html, { paye: fac ? doc.paye : 0, avoirs: fac ? doc.avoirs : 0 });
  return extra ? out.replace(/<\/body>/i, extra + '</body>') : out;
}
// PDF du document ; pour une facture émise : Factur-X (XML EN 16931 embarqué).
async function docPdf(doc) {
  const orig = doc.data?.importe && FICHIER_IMPORT.exec(get('SELECT fichier FROM imports WHERE document_id=? AND compte_id=?', doc.id, doc.compte_id)?.fichier || '');
  if (orig?.[1] === 'application/pdf') return Buffer.from(orig[2], 'base64'); // repris de l'ancien logiciel : son PDF d'origine
  const pdf = await htmlToPdf(html(doc));
  if (doc.type !== 'facture' || !doc.numero) return pdf;
  const s = settings(doc.compte_id);
  return facturx(pdf, ciiXml(doc, s), { titre: `${doc.kind === 'avoir' ? 'Avoir' : 'Facture'} ${doc.numero}`, auteur: s.nom });
}
const pdfName = d => `${d.numero || (d.type === 'modele' ? 'modele' : 'brouillon-' + d.id)}.pdf`;

// ---------- E-mails ----------
const mailer = process.env.SMTP_HOST && nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: +process.env.SMTP_PORT === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
const fillMail = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
async function sendMail(cid, { to, sujet, corps, document_id = null, chantier_id = null, client_id = null, joindre = null, reponseA = null }) {
  const s = settings(cid);
  let statut = 'simulé (SMTP non configuré)', attachments = [], mid = null;
  if (joindre) {
    try { attachments = [{ filename: pdfName(joindre), content: await docPdf(joindre) }]; }
    catch (e) { statut += ', PDF non joint : ' + e.message; }
  }
  if (!to) statut = 'échec : aucune adresse e-mail';
  else if (mailer) {
    try {
      mid = (await mailer.sendMail({ from: { name: s.nom, address: process.env.SMTP_FROM || process.env.SMTP_USER }, replyTo: s.email || undefined, to, subject: sujet, text: corps, attachments,
        ...(reponseA && { inReplyTo: reponseA, references: reponseA }) })).messageId || null;
      statut = attachments.length ? 'envoyé avec PDF' : 'envoyé';
    } catch (e) { statut = 'échec : ' + e.message; }
  }
  run('INSERT INTO emails (compte_id, a, sujet, corps, statut, document_id, chantier_id, client_id, message_id) VALUES (?,?,?,?,?,?,?,?,?)', cid, to || '', sujet, corps, statut, document_id, chantier_id, client_id, mid);
  return statut;
}
function docMailVars(d) {
  return {
    client: d.data.client?.nom || '', numero: d.numero || '', reste: eur(d.total_ttc - (d.regle || 0)),
    montant: gammesOuvertes(d) ? gammesOuvertes(d).map(g => totaux({ ...d.data, lignes: g.lignes }, settings(d.compte_id).franchise_tva).ttc).sort((a, b) => a - b).filter((_, i, a) => !i || i === a.length - 1).map(eur).join(' à ') : eur(d.total_ttc),
    echeance: d.echeance ? new Date(d.echeance).toLocaleDateString('fr-FR') : '', lien: `${PUBLIC_URL}/p/${d.token}`,
    type: d.type === 'devis' ? 'devis' : d.kind === 'avoir' ? 'avoir' : 'facture', Type: d.type === 'devis' ? 'Devis' : d.kind === 'avoir' ? 'Avoir' : 'Facture',
    signer: d.type === 'devis' ? ' et le signer' : '', entreprise: settings(d.compte_id).nom,
  };
}
function chantierMailVars(ch) {
  return {
    client: ch.client_nom || '', chantier: ch.nom, avancement: ch.avancement, budget: eur(ch.budget), encaisse: eur(ch.encaisse),
    reste: eur(ch.budget - ch.encaisse), date_fin: ch.date_fin_prevue ? new Date(ch.date_fin_prevue).toLocaleDateString('fr-FR') : '', entreprise: settings(ch.compte_id).nom,
  };
}
async function relancer(d) {
  const s = settings(d.compte_id), facture = d.type === 'facture';
  const statut = await sendMail(d.compte_id, {
    to: d.data.client?.email || d.client_email, sujet: facture ? `Relance : facture ${d.numero}` : `Votre devis ${d.numero}`,
    corps: fillMail(facture ? s.mail_relance_facture : s.mail_relance_devis, docMailVars(d)), document_id: d.id, joindre: d,
  });
  run('UPDATE documents SET relances=relances+1, derniere_relance=? WHERE id=?', new Date().toISOString(), d.id);
  return statut;
}

// Relances automatiques : factures échues, devis sans réponse, chantiers en retard.
async function relances(cid) {
  const s = settings(cid), out = [];
  if (s.relances_auto) {
    for (const f of all(`SELECT * FROM (${scoped('documents', cid)}) WHERE type='facture' AND kind!='avoir' AND numero IS NOT NULL AND regle < total_ttc - 0.005 AND echeance < ?`, today())) {
      if (f.relances >= s.relances_max || (f.derniere_relance && daysSince(f.derniere_relance) < s.relance_facture_jours)) continue;
      out.push(await relancer(f));
    }
    for (const d of all(`SELECT * FROM (${scoped('documents', cid)}) WHERE type='devis' AND statut='envoye' AND envoye_le IS NOT NULL`)) {
      if (d.relances >= s.relances_max || daysSince(d.derniere_relance || d.envoye_le) < s.relance_devis_jours) continue;
      out.push(await relancer(d));
    }
  }
  if (s.alerte_retard_chantier) {
    for (const ch of all(`SELECT * FROM (${scoped('chantiers', cid)}) WHERE statut!='termine' AND date_fin_prevue < ? AND retard_notifie_le IS NULL`, today())) {
      out.push(await sendMail(cid, { to: ch.email_suivi || ch.client_email, sujet: `Chantier « ${ch.nom} » : information sur le planning`, corps: fillMail(s.mail_retard_chantier, chantierMailVars(ch)), chantier_id: ch.id }));
      run('UPDATE chantiers SET retard_notifie_le=? WHERE id=?', new Date().toISOString(), ch.id);
    }
  }
  return out;
}
// ---------- Boîte mail du pro (IMAP) : on ne garde que les échanges avec des clients connus ----------
// Pièces jointes : parties avec un nom de fichier (hors texte du message). 8 par e-mail, 10 Mo chacune au plus.
const piecesDe = n => (n.childNodes ? n.childNodes.flatMap(piecesDe) : (n.dispositionParameters?.filename || n.parameters?.name) && n.size <= 10e6 ? [n] : []);
const textPart = (n, type = 'text/plain') => (n.type === type && n.disposition !== 'attachment' ? n : n.childNodes?.reduce((f, c) => f || textPart(c, type), null));
const htmlText = html => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
// ponytail: coupe la citation de l'e-mail précédent sur les formules usuelles (fr/en) ; un client exotique garde sa citation.
const sansCitation = t => t.replace(/\r/g, '').split(/\n(?:Le .{5,200}a écrit ?:|On .{5,200}wrote:|-{2,} ?(?:Original Message|Message d'origine)|De ?: .+\n(?:Envoyé|Date) ?:|>)/)[0].trim();
const sqlDate = d => new Date(d || Date.now()).toISOString().slice(0, 19).replace('T', ' ');
const enCours = new Set();
const imapOpts = s => ({ host: s.imap_host, port: +s.imap_port || 993, secure: +s.imap_port !== 143, auth: { user: s.imap_user, pass: s.imap_pass }, logger: false });
const nomPj = x => String(x.dispositionParameters?.filename || x.parameters?.name || '');
async function releverBoite(cid) {
  const s = settings(cid);
  if (!s.imap_host || !s.imap_user || !s.imap_pass || enCours.has(cid)) return 0;
  const clients = new Map(all("SELECT id, lower(email) e FROM clients WHERE compte_id=? AND email<>''", cid).map(c => [c.e.trim(), c.id]));
  if (!clients.size) return 0;
  enCours.add(cid);
  const imap = new ImapFlow(imapOpts(s));
  const etat = { ...s.imap_etat };
  let n = 0;
  try {
    await imap.connect();
    const envoyes = (await imap.list()).find(b => b.specialUse === '\\Sent');
    for (const [boite, recu] of [['INBOX', true], ...(envoyes ? [[envoyes.path, false]] : [])]) {
      const lock = await imap.getMailboxLock(boite);
      try {
        const v = String(imap.mailbox.uidValidity), dernier = etat[boite]?.v === v ? etat[boite].uid : 0;
        // Première fois : les 90 derniers jours. Ensuite : seulement les nouveaux messages.
        const uids = ((await imap.search(dernier ? { uid: `${dernier + 1}:*` } : { since: new Date(Date.now() - 90 * 864e5) }, { uid: true })) || []).filter(u => u > dernier);
        const trouves = [];
        let max = dernier;
        if (uids.length) for await (const m of imap.fetch(uids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
          max = Math.max(max, m.uid);
          const de = (m.envelope.from?.[0]?.address || '').toLowerCase(), a = [...(m.envelope.to || []), ...(m.envelope.cc || [])].map(x => (x.address || '').toLowerCase());
          const client = clients.get(recu ? de : a.find(x => clients.has(x)));
          if (client) trouves.push({ m, de, a, client });
        }
        for (const { m, de, a, client } of trouves) { // téléchargements après la boucle fetch (imapflow n'accepte pas de commande pendant un fetch)
          const part = m.bodyStructure && (textPart(m.bodyStructure) || textPart(m.bodyStructure, 'text/html'));
          let corps = '';
          if (part) {
            const id = part.part || '1', r = await imap.downloadMany(m.uid, [id], { uid: true });
            corps = r[id]?.content?.toString('utf8') || '';
            if (part.type === 'text/html') corps = htmlText(corps);
          }
          const ins = run('INSERT OR IGNORE INTO emails (compte_id, sens, de, a, sujet, corps, statut, message_id, client_id, created_at, lu) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            cid, recu ? 'recu' : 'envoye', de, a.join(', '), m.envelope.subject || '(sans objet)', sansCitation(corps).slice(0, 20000), recu ? 'reçu' : 'envoyé depuis la boîte mail',
            m.envelope.messageId || `${boite}:${v}:${m.uid}`, client, sqlDate(m.envelope.date), recu ? 0 : 1);
          n += Number(ins.changes);
          const pj = ins.changes && m.bodyStructure ? piecesDe(m.bodyStructure).slice(0, 8) : [];
          if (pj.length) {
            const r = await imap.downloadMany(m.uid, pj.map(x => x.part), { uid: true });
            for (const x of pj) if (r[x.part]?.content) run('INSERT INTO pieces (compte_id, email_id, nom, type, taille, data) VALUES (?,?,?,?,?,?)', cid, Number(ins.lastInsertRowid),
              String(x.dispositionParameters?.filename || x.parameters?.name).slice(0, 200), x.type, r[x.part].content.length, r[x.part].content);
          }
        }
        etat[boite] = { v, uid: max };
      } finally { lock.release(); }
    }
    saveSettings(cid, { imap_etat: etat, imap_erreur: '', imap_releve_le: new Date().toISOString() });
    if (n && s.rdv_auto) chercherRdv(cid).catch(e => console.error('Rendez-vous :', e.message)); // sans attendre : Claude lit les nouveaux e-mails
    return n;
  } catch (e) {
    const msg = e.authenticationFailed ? 'identifiant ou mot de passe refusé (Gmail : utilisez un mot de passe d’application)' : e.responseText || e.message;
    saveSettings(cid, { imap_erreur: msg });
    throw httpErr(502, 'Boîte mail : ' + msg);
  } finally { enCours.delete(cid); await imap.logout().catch(() => {}); }
}
setInterval(() => { for (const { id } of all('SELECT id FROM comptes')) releverBoite(id).catch(e => console.error(e.message)); }, 600e3);

// Résumé envoyé au pro chaque matin (à partir de 7 h, une fois par jour, seulement s'il y a quelque chose).
function resumeTexte(cid) {
  const s = settings(cid), k = dashboard(cid), t = today(), fr = d => new Date(d).toLocaleDateString('fr-FR');
  const docs = all(`SELECT * FROM (${scoped('documents', cid)}) WHERE type IN ('devis','facture')`);
  const blocs = [
    ['Rendez-vous aujourd’hui', all(`SELECT * FROM (${scoped('rdv', cid)}) WHERE statut='confirme' AND substr(debut,1,10)=? ORDER BY debut`, t)
      .map(r => `${r.debut.length > 10 ? r.debut.slice(11) : 'Journée'} : ${r.titre}${r.lieu ? `, ${r.lieu}` : ''}${r.client_tel ? ` (tél. ${r.client_tel})` : ''}`)],
    ['Rendez-vous trouvés dans vos e-mails, à confirmer', all(`SELECT * FROM (${scoped('rdv', cid)}) WHERE statut='propose' ORDER BY debut`).map(r => `${fr(r.debut.slice(0, 10))}${r.debut.length > 10 ? ' à ' + r.debut.slice(11) : ''} : ${r.titre}`)],
    ['À encaisser', k.factures_retard.map(f => `${f.numero}, ${f.client_nom || 'client'} : ${eur(f.total_ttc - f.regle)} en retard depuis le ${fr(f.echeance)}${f.relances ? ` (${plural(f.relances, 'relance')} envoyée${f.relances > 1 ? 's' : ''})` : ''}`)],
    ['Acomptes à demander', docs.filter(d => d.type === 'devis' && d.statut === 'accepte' && d.data.acompte_pct > 0 && !docs.some(f => f.parent_id === d.id && f.type === 'facture'))
      .map(d => `${d.numero}, ${d.client_nom || 'client'} : signé, facture d’acompte de ${d.data.acompte_pct} % pas encore faite`)],
    ['Devis sans réponse', k.devis_a_relancer.filter(d => d.envoye_le && daysSince(d.envoye_le) >= s.relance_devis_jours).map(d => `${d.numero}, ${d.client_nom || 'client'} : ${eur(d.total_ttc)}, envoyé il y a ${plural(Math.floor(daysSince(d.envoye_le)), 'jour')}`)],
    ['Chantiers', k.chantiers.flatMap(c => c.date_fin_prevue && c.date_fin_prevue < t ? [`${c.nom} : fin prévue le ${fr(c.date_fin_prevue)} dépassée (${c.avancement} %)`] : c.date_debut === t ? [`${c.nom} : démarre aujourd’hui`] : [])],
    ['Messages de clients (24 h)', all("SELECT e.sujet, c.nom FROM emails e LEFT JOIN clients c ON c.id=e.client_id WHERE e.compte_id=? AND e.sens='recu' AND e.created_at >= datetime('now','-1 day') ORDER BY e.created_at", cid)
      .map(e => `${e.nom || 'Client'} : « ${e.sujet} »`)],
  ].filter(b => b[1].length);
  const n = blocs.reduce((x, b) => x + b[1].length, 0);
  return n && { n, sujet: `Votre journée : ${plural(n, 'point')} à traiter`, corps: `Bonjour,\n\n${blocs.map(([t, l]) => `${t}\n${l.map(x => '- ' + x).join('\n')}`).join('\n\n')}\n\nTout voir : ${PUBLIC_URL}\n\nKadra` };
}
async function resumeMatin(cid) {
  const s = settings(cid);
  if (!s.resume_quotidien || !s.email || s.resume_le === today() || new Date().getHours() < 7) return;
  saveSettings(cid, { resume_le: today() });
  await releverBoite(cid).catch(() => {}); // pour inclure les derniers messages
  const r = resumeTexte(cid);
  if (r) await sendMail(cid, { to: s.email, sujet: r.sujet, corps: r.corps });
}

// Sauvegarde quotidienne de la base (copie cohérente même pendant l'utilisation) ; 14 jours gardés.
// SAUVEGARDE_DIR peut viser un dossier OneDrive/Google Drive pour avoir une copie hors du PC.
function sauvegarde() {
  const dir = path.resolve(process.env.SAUVEGARDE_DIR || 'sauvegardes'), nom = path.basename(DB_FILE, '.db'), f = path.join(dir, `${nom}-${today()}.db`);
  if (fs.existsSync(f)) return;
  fs.mkdirSync(dir, { recursive: true });
  db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  fs.readdirSync(dir).filter(n => /^(.+)-\d{4}-\d{2}-\d{2}\.db$/.exec(n)?.[1] === nom).sort().slice(0, -14).forEach(n => fs.rmSync(path.join(dir, n)));
}
// Rappel au client la veille d'un rendez-vous confirmé (à partir de 17 h, une seule fois).
const heureFr = t => t.replace(/^0/, '').replace(':', ' h ').replace(/ h 00$/, ' h');
async function rappelsRdv(cid) {
  const s = settings(cid);
  if (!s.rappel_rdv || new Date().getHours() < 17) return;
  for (const r of all(`SELECT r.*, c.email client_email FROM (${scoped('rdv', cid)}) r JOIN clients c ON c.id=r.client_id WHERE r.statut='confirme' AND r.rappel_le IS NULL AND substr(r.debut,1,10)=? AND c.email<>''`, addDays(today(), 1))) {
    run('UPDATE rdv SET rappel_le=? WHERE id=?', new Date().toISOString(), r.id); // avant l'envoi : jamais deux rappels
    await sendMail(cid, { to: r.client_email, sujet: `Rappel : rendez-vous demain${r.debut.length > 10 ? ' à ' + heureFr(r.debut.slice(11)) : ''}`, client_id: r.client_id, chantier_id: r.chantier_id,
      corps: fillMail(s.mail_rappel_rdv, { client: r.client_nom || '', quand: r.debut.length > 10 ? 'à ' + heureFr(r.debut.slice(11)) : '', lieu: r.lieu ? `, ${r.lieu}` : '', objet: r.titre, entreprise: s.nom }) });
  }
}
async function tacheHoraire() {
  run('DELETE FROM sessions WHERE expires < ?', new Date().toISOString());
  run('DELETE FROM resets WHERE expires < ?', new Date().toISOString());
  try { sauvegarde(); } catch (e) { console.error('Sauvegarde :', e.message); }
  for (const { id } of all('SELECT id FROM comptes')) {
    await relances(id).catch(console.error);
    await resumeMatin(id).catch(console.error);
    await rappelsRdv(id).catch(console.error);
    await apprendreStyle(id).catch(e => console.error('Style :', e.message));
  }
  run("DELETE FROM envois WHERE created_at < datetime('now', '-7 days')");
}
setTimeout(tacheHoraire, 5000);
setInterval(tacheHoraire, 3600e3);

// ---------- IA (Claude) ----------
let client;
const ai = () => (client ||= new Anthropic());
const S = props => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const str = { type: 'string' }, num = { type: 'number' };
const DEVIS_SCHEMA = S({
  transcription_fr: str,
  client: S({ nom: str, adresse: str, email: str, tel: str }),
  objet: str, adresse_chantier: str,
  lignes: { type: 'array', items: S({ type: { type: 'string', enum: ['section', 'ligne'] }, designation: str, description: str, qte: num, unite: str, pu: num, tva: num }) },
  remise_pct: num, acompte_pct: num, notes: str,
  questions: { type: 'array', items: str },
});

// IA : par défaut Claude Code installé sur ce PC, donc l'abonnement Claude connecté (pas de clé API).
// Avec ANTHROPIC_API_KEY dans .env, on passe par l'API à la place.
// onPartial(json incomplet) : appelé pendant la rédaction, pour l'aperçu en direct.
// opts.rapide : modèle plus rapide, effort bas (simple recopie de documents : 2 fois plus rapide, même résultat)
// opts.modele : modèle imposé ; opts.chaud : processus Claude Code lancé d'avance (voir prendreClaude)
async function askClaude(system, prompt, schema, fichier, onPartial, opts = {}) {
  return (process.env.ANTHROPIC_API_KEY ? askApi : askClaudeCode)(system, prompt, schema, fichier, onPartial, opts);
}

// Claude Code met ~1,5 s à démarrer : pour ce que l'artisan attend (opts.chaud), le suivant est lancé d'avance
// et attend sa consigne sur l'entrée standard (un premier '\n' tout de suite : sans rien reçu en 3 s, il abandonne).
// Coupé sans consigne (serveur arrêté), il finit en erreur « only whitespace », sans requête.
const chauds = new Map(); // arguments → processus prêt
function lancerClaude(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devis-ia-'));
  // Sans shell : aucun texte utilisateur n'est interprété ; la consigne passe par l'entrée standard.
  const p = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: dir, windowsHide: true, env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  p.dir = dir;
  p.on('error', e => { p.erreur = e; });
  p.on('close', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  p.stdin.write('\n');
  return p;
}
function prendreClaude(args, chaud) {
  if (!chaud) return lancerClaude(args);
  const cle = JSON.stringify(args), p = chauds.get(cle);
  chauds.delete(cle);
  if (p) clearTimeout(p.oubli);
  const n = lancerClaude(args);
  n.oubli = setTimeout(() => { if (chauds.get(cle) === n) chauds.delete(cle); n.kill(); }, 15 * 60e3); // inutilisé 15 min : libéré
  chauds.set(cle, n);
  if (chauds.size > 6) { const [k, v] = chauds.entries().next().value; chauds.delete(k); clearTimeout(v.oubli); v.kill(); }
  return p && !p.erreur && p.exitCode === null && p.signalCode === null ? p : lancerClaude(args);
}

async function askClaudeCode(system, prompt, schema, fichier, onPartial, opts = {}) {
  const args = ['-p', '--output-format', onPartial ? 'stream-json' : 'json', ...(onPartial ? ['--verbose', '--include-partial-messages'] : []),
    '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', system, '--json-schema', JSON.stringify(schema), '--tools', fichier ? 'Read' : '', ...(fichier ? ['--allowedTools', 'Read'] : []),
    ...(process.env.CLAUDE_MODEL ? ['--model', process.env.CLAUDE_MODEL] : opts.modele ? ['--model', opts.modele] : opts.rapide ? ['--model', 'sonnet', '--effort', 'low'] : [])];
  const p = prendreClaude(args, opts.chaud && !fichier), dir = p.dir;
  if (fichier) {
    const noms = [].concat(fichier).map((f, i) => {
      const nom = `${f.nom || (i ? 'document' + (i + 1) : 'document')}.${f.type === 'application/pdf' ? 'pdf' : f.type.split('/')[1]}`;
      fs.writeFileSync(path.join(dir, nom), Buffer.from(f.data, 'base64'));
      return nom;
    });
    prompt = `${noms.length > 1 ? `Les fichiers ${noms.join(', ')} sont` : `Le document est le fichier ${noms[0]}`} dans le dossier courant : lis-${noms.length > 1 ? 'les' : 'le'} avec l'outil Read.

${prompt}`;
  }
  {
    const out = await new Promise((ok0, ko) => {
      let so = '', se = '', ligne = '', outil = '', acc = '', result;
      const timer = setTimeout(() => { p.kill(); ko(httpErr(504, 'L’IA n’a pas répondu en 3 minutes : réessayez.')); }, 180e3);
      // la réponse est rendue dès qu'elle est lue, sans attendre que Claude Code se ferme (~1 s)
      const ok = r => { clearTimeout(timer); ok0(r); };
      // stream-json : une ligne JSON par événement ; la réponse s'écrit dans l'outil StructuredOutput.
      const evenement = l => {
        let e; try { e = JSON.parse(l); } catch { return; }
        if (e.type === 'result') ok(result = e);
        const ev = e.type === 'stream_event' && e.event;
        if (ev?.type === 'content_block_start') outil = ev.content_block?.name;
        if (ev?.delta?.type === 'input_json_delta' && outil === 'StructuredOutput') { acc += ev.delta.partial_json; onPartial(acc); }
      };
      p.stdout.on('data', c => {
        if (!onPartial) { so += c; try { ok(JSON.parse(so)); } catch {} return; }
        const ls = (ligne + c).split('\n');
        ligne = ls.pop();
        ls.forEach(evenement);
      });
      p.stderr.on('data', c => { se += c; });
      p.on('error', e => { clearTimeout(timer); ko(e.code === 'ENOENT' ? httpErr(503, 'Claude Code est introuvable sur ce PC : installez-le, puis lancez « claude » une fois pour connecter votre compte.') : e); });
      p.on('close', () => {
        clearTimeout(timer);
        if (onPartial) { evenement(ligne); return result ? ok(result) : ko(httpErr(502, 'Réponse illisible de Claude Code : ' + se.slice(0, 300))); }
        try { ok(JSON.parse(so)); } catch { ko(httpErr(502, 'Réponse illisible de Claude Code : ' + (se || so).slice(0, 300))); }
      });
      if (p.erreur) p.emit('error', p.erreur);
      p.stdin.end(prompt);
    });
    if (out.is_error || !out.structured_output) {
      const msg = String(out.result || out.subtype || '');
      if (/login|log in|auth|api key/i.test(msg)) throw httpErr(503, 'Compte Claude non connecté : lancez « claude » dans un terminal puis /login.');
      if (/limit/i.test(msg)) throw httpErr(429, 'Limite d’utilisation de votre abonnement Claude atteinte : réessayez plus tard.');
      throw httpErr(502, 'L’IA n’a pas pu répondre : ' + msg.slice(0, 300));
    }
    return out.structured_output;
  }
}

async function askApi(system, prompt, schema, fichier, onPartial, opts = {}) {
  const blocks = [].concat(fichier || []).map(f => ({ type: f.type === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: f.type, data: f.data } }));
  const params = {
    model: MODEL, max_tokens: 16000, system,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: opts.rapide ? 'low' : 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: blocks.length ? [...blocks, { type: 'text', text: prompt }] : prompt }],
  };
  const msg = onPartial
    ? await ai().beta.messages.stream(params).on('text', (_, snapshot) => onPartial(snapshot)).finalMessage()
    : await ai().beta.messages.create(params);
  if (msg.stop_reason === 'refusal') throw httpErr(422, 'La demande a été refusée par l’IA.');
  if (msg.stop_reason === 'max_tokens') throw httpErr(422, 'Réponse de l’IA trop longue : découpez la dictée.');
  return JSON.parse(msg.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

const devisSystem = s => `Tu rédiges les devis d'un artisan du bâtiment en France. Il dicte à l'oral, souvent dans une autre langue que le français et parfois en mélangeant plusieurs langues dans la même phrase (ex. turc et français, portugais et français), avec des hésitations et des erreurs de reconnaissance vocale. Tu produis le contenu du devis en français professionnel.

La reconnaissance vocale est réglée sur la langue principale de l'artisan : les mots dits dans une autre langue (souvent le français : noms de matériaux, chiffres, unités, noms propres, adresses) sont alors transcrits phonétiquement, de travers. Reconstitue-les d'après le son et le contexte du bâtiment (ex. « placo », « faïence », « ragréage »). Si un mot ou un chiffre reste incertain, garde l'interprétation la plus plausible et ajoute une question.

Règles :
- transcription_fr : traduction française fidèle de la dictée.
- Prix : reprends exactement les montants dictés (« 45 euros le mètre carré » → pu 45, unite « m² »). Les prix sont HT, sauf si le pro dit TTC : convertis alors en HT avec le taux de TVA de la ligne. Un forfait → qte 1, unite « forfait ». Si un total est donné pour une quantité, calcule le prix unitaire.
- Si aucun prix n'est dicté pour une prestation : reprends le prix du catalogue si une prestation correspond ; sinon le prix de la même prestation dans « Prix de vos devis passés » (adapte l'unité si besoin) ; sinon mets 0 et ajoute une question. Si tu reprends des prix de devis passés, ajoute UNE question qui les liste pour vérification (ex. « Prix repris de vos anciens devis, à vérifier : faïence 45 €/m² (DEV-2026-0012) »).
- Photos jointes (chantier, pièce, plan, croquis) : déduis-en les travaux à faire et les mesures lisibles (cotes d'un plan). Une quantité estimée d'après une photo est ta meilleure estimation : ajoute une question pour la faire vérifier. Ne déduis jamais un prix d'une photo. La dictée, si elle existe, passe avant la photo.
- Unités usuelles : u, m², ml, m³, h, jour, kg, forfait, ens.
- Placement : respecte l'organisation demandée (« dans la partie plomberie », « en premier », « à la ligne 3 »). Quand plusieurs lots ou corps de métier apparaissent, regroupe-les sous des lignes de type « section » (designation = titre du lot ; les autres champs à vide ou 0).
- Écris comme l'artisan : ses consignes permanentes passent avant tout, puis sa façon d'écrire apprise et ses devis passés (formulation des désignations, ex. « F/P … », « Fourniture et pose de … » ou « Pose de … », abréviations, majuscules, détail des descriptions, noms des sections, lignes qu'il ajoute toujours). Sans exemple de lui : désignations courtes et professionnelles ; description technique utile (fournitures, mise en œuvre). N'invente jamais de prix ni de quantité.
- TVA : taux dicté, sinon ${s.franchise_tva ? 0 : s.tva_defaut} % (20 % neuf, 10 % rénovation de logement de plus de 2 ans, 5,5 % rénovation énergétique).
- Si un devis actuel est fourni, la dictée le modifie : applique les changements demandés et renvoie le devis complet, en gardant à l'identique tout ce qui n'est pas concerné. Si un modèle de base est fourni, pars de ses lignes et adapte-les à la dictée.
- client, objet, adresse_chantier : ce qui est dicté, sinon la valeur actuelle, sinon chaîne vide. N'invente jamais de coordonnées.
- remise_pct et acompte_pct : valeur dictée, sinon valeur actuelle, sinon 0 pour la remise et ${s.acompte_defaut} pour l'acompte.
- questions : courte liste en français des informations manquantes ou ambiguës (prix absent, quantité floue…). Vide si tout est clair.`;

// onApercu(html) : le devis en cours de rédaction, rendu avec la mise en page (au plus toutes les 300 ms).
// Kadra apprend les prix de l'artisan : la dernière fois qu'il a chiffré chaque prestation dans un devis envoyé, accepté ou refusé
// (les devis signés d'abord ; pas les brouillons, pas encore relus). Ce qui est déjà au catalogue n'est pas répété.
const sansAccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function prixPasses(cid, catalog, sauf) {
  const vus = new Map(), cat = new Set(catalog.map(c => sansAccent(c.designation)));
  for (const r of all(`SELECT d.numero, d.statut, j.value->>'designation' designation, j.value->>'description' description, j.value->>'unite' unite, j.value->>'pu' pu, j.value->>'tva' tva
    FROM documents d, json_each(d.data, '$.lignes') j
    WHERE d.compte_id=? AND d.type='devis' AND d.statut IN ('envoye','accepte','refuse') AND d.data->>'exemple' IS NULL AND d.id IS NOT ? AND j.value->>'type' IS NOT 'section' AND j.value->>'pu' > 0
    ORDER BY d.statut='accepte' DESC, d.date DESC, d.id DESC LIMIT 5000`, cid, sauf ?? null)) {
    const k = sansAccent(r.designation);
    if (!k || cat.has(k)) continue;
    if (vus.has(k)) { vus.get(k).fois++; continue; }
    if (vus.size < 200) vus.set(k, { designation: r.designation, description: String(r.description || '').slice(0, 160), unite: r.unite, pu: r.pu, tva: r.tva, devis: r.numero, signe: r.statut === 'accepte', fois: 1 });
  }
  return [...vus.values()];
}
const PHOTO = /^data:image\/(jpeg|png|webp);base64,([\w+/=]+)$/;

// ---------- Kadra apprend la façon d'écrire de l'artisan, sans qu'il ait à l'expliquer ----------
// Matière : ses devis envoyés (et, quand Kadra les avait rédigés, ce que l'artisan a corrigé : data.ia = la version de Kadra)
// et les e-mails qu'il a écrits lui-même depuis sa boîte mail. Résultat : settings.style = { devis: [habitudes], mails: [habitudes] }.
const compact = lignes => (lignes || []).map(l => (l.type === 'section' ? { section: l.designation } : { designation: l.designation, description: String(l.description || '').slice(0, 200), unite: l.unite, tva: l.tva }));
const iaLignes = lignes => (lignes || []).map(l => (l.type === 'section' ? { section: l.designation } : { designation: l.designation, description: String(l.description || '').slice(0, 200) }));
const DEVIS_FAITS = "type='devis' AND statut IN ('envoye','accepte','refuse') AND data->>'exemple' IS NULL"; // le devis de la visite guidée n'apprend rien à Kadra
const MAILS_A_LUI = "sens='envoye' AND statut='envoyé depuis la boîte mail'"; // écrits par l'artisan lui-même (relevés dans ses envoyés)
function matiereStyle(cid) {
  const devis = all(`SELECT id, numero, data FROM documents WHERE compte_id=? AND ${DEVIS_FAITS} ORDER BY id DESC LIMIT 12`, cid).map(d => {
    const ia = d.data.ia, corrige = ia && JSON.stringify(ia) !== JSON.stringify(iaLignes(d.data.lignes));
    return { devis: d.numero, objet: d.data.objet, lignes: compact(d.data.lignes), notes: d.data.notes || '', acompte_pct: d.data.acompte_pct, remise_pct: d.data.remise_pct, ...(corrige && { propose_par_kadra_avant_correction: ia }) };
  });
  const mails = all(`SELECT sujet, corps FROM emails WHERE compte_id=? AND ${MAILS_A_LUI} ORDER BY id DESC LIMIT 8`, cid).map(e => ({ sujet: e.sujet, corps: String(e.corps).slice(0, 1500) }));
  const sig = `${get(`SELECT COUNT(*) n FROM documents WHERE compte_id=? AND ${DEVIS_FAITS}`, cid).n}/${get(`SELECT COUNT(*) n FROM emails WHERE compte_id=? AND ${MAILS_A_LUI}`, cid).n}`;
  return { devis, mails, sig };
}
const STYLE_SCHEMA = S({ devis: { type: 'array', items: str }, mails: { type: 'array', items: str } });
const STYLE_SYSTEM = `Tu observes comment un artisan du bâtiment rédige ses devis et ses e-mails, pour que l'assistant qui les écrit à sa place écrive exactement comme lui, sans que l'artisan ait à l'expliquer.

Tu reçois ses derniers devis envoyés (parfois avec « propose_par_kadra_avant_correction » : la version de l'assistant, que l'artisan a ensuite corrigée ; ses corrections sont le signal le plus fort) et les e-mails qu'il a écrits lui-même.

Liste ses habitudes concrètes :
- devis : façon de commencer les désignations (ex. « F/P », « Fourniture et pose de », « Pose de », « Fourniture seule »), majuscules, abréviations, longueur et contenu des descriptions, noms et ordre des sections, unités préférées, lignes qu'il ajoute presque toujours (ex. nettoyage de fin de chantier, évacuation des gravats, protection des sols), ce qu'il corrige ou supprime dans les propositions de l'assistant, taux de TVA, acompte, remise, phrases habituelles dans les notes ;
- mails : salutation, vouvoiement ou tutoiement, longueur, ton, formule de fin, signature (prénom, nom de l'entreprise), tournures habituelles.

Règles :
- Seulement ce qui revient au moins deux fois, ou ce qu'il a corrigé. Rien de vague (« écrit de façon professionnelle »).
- Chaque habitude en une phrase courte à l'impératif, avec un exemple entre guillemets tiré de ses documents (ex. « Commence les désignations par “F/P” : “F/P carrelage 60x60 rectifié” »).
- Pas de prix (appris à part), pas de noms de clients ni d'adresses.
- Ne reprends pas une habitude de la liste « refusées par l'artisan ».
- 12 habitudes au plus par liste ; liste vide si rien de net.`;
async function apprendreStyle(cid, force) {
  const s = settings(cid), m = matiereStyle(cid);
  if (!force && (s.style?.sig === m.sig || (m.devis.length < 2 && m.mails.length < 2))) return s.style;
  if (!m.devis.length && !m.mails.length) throw httpErr(400, 'Kadra apprend à partir de vos devis envoyés et de vos e-mails : envoyez d’abord quelques devis.');
  const refuses = s.style?.refuses || [];
  const out = await askClaude(STYLE_SYSTEM, [
    m.devis.length ? `Ses devis :\n${JSON.stringify(m.devis)}` : 'Aucun devis envoyé pour l’instant.',
    m.mails.length ? `Ses e-mails écrits par lui-même :\n${JSON.stringify(m.mails)}` : 'Aucun e-mail écrit par lui-même.',
    refuses.length ? `Habitudes refusées par l'artisan (ne pas les remettre) :\n${refuses.map(r => '- ' + r).join('\n')}` : '',
  ].filter(Boolean).join('\n\n'), STYLE_SCHEMA);
  const style = { devis: out.devis.slice(0, 12), mails: out.mails.slice(0, 12), sig: m.sig, le: new Date().toISOString(), refuses };
  saveSettings(cid, { style });
  return style;
}
// Ce que Kadra sait de l'artisan, ajouté à la consigne de Claude (quoi = 'devis' ou 'mails')
const habitudes = (s, quoi) => [
  s.regles?.length ? `Consignes permanentes de l'artisan (à appliquer à chaque fois quand elles concernent ce document ; elles passent avant tout) :\n${s.regles.map(r => '- ' + r).join('\n')}` : '',
  s.style?.[quoi]?.length ? `Façon d'écrire de l'artisan, apprise de ses ${quoi === 'devis' ? 'devis' : 'e-mails'} (imite-la) :\n${s.style[quoi].map(r => '- ' + r).join('\n')}` : '',
].filter(Boolean).join('\n\n');

// Devis rédigé pendant la dictée (aperçu) : « Rédiger le devis » le reprend tel quel si la dictée n'a pas changé.
const apercus = new Map(); // cid → { cle, p }
async function aiDevis({ transcript, lang, doc_id, base_id, photos = [], apercu, exemple }, cid, onApercu) {
  if (!Array.isArray(photos) || photos.length > 4 || photos.some(p => !PHOTO.test(p) || p.length > 6e6)) throw httpErr(400, 'Photos illisibles (4 au plus, JPEG ou PNG).');
  if (!transcript?.trim() && !photos.length) throw httpErr(400, 'Dictée vide.');
  const s = settings(cid);
  const current = doc_id ? own('documents', doc_id, cid) : null;
  const base = !current && base_id ? own('documents', base_id, cid) : null;
  const rendu = p => html({ type: 'devis', compte_id: cid, template_id: base?.template_id || s.template_id, date: today(),
    data: { ...p, client: p.client || {}, lignes: (p.lignes || []).map(l => ({ type: 'ligne', designation: '', description: '', qte: 1, unite: '', pu: 0, tva: s.tva_defaut, ...l })) } });
  let vu = 0;
  const partiel = onApercu && (json => {
    if (Date.now() - vu < 300) return;
    const p = partialJSON(json);
    if (!p) return;
    vu = Date.now();
    onApercu(rendu(p));
  });
  const cle = JSON.stringify([transcript?.trim(), lang, doc_id, base_id, photos.map(p => p.length + p.slice(-40))]);
  let a = apercus.get(cid);
  if (a?.cle === cle) { if (!apercu) apercus.delete(cid); } else a = null;
  if (!a) {
    const catalog = all('SELECT designation, unite, pu, tva FROM catalog WHERE compte_id=? ORDER BY designation LIMIT 300', cid);
    const strip = d => { const { questions, dictees, ia, ...rest } = d.data; return rest; };
    const exemples = all(`SELECT numero, data FROM documents WHERE compte_id=? AND ${DEVIS_FAITS} AND id IS NOT ? ORDER BY id DESC LIMIT 2`, cid, current?.id ?? null)
      .map(d => ({ devis: d.numero, objet: d.data.objet, lignes: compact(d.data.lignes).slice(0, 40) }));
    a = { cle, p: askClaude(devisSystem(s), [
      `Langue principale de l'artisan (réglage de la reconnaissance vocale) : ${lang || 'fr-FR'}. La dictée peut mélanger d'autres langues.`,
      `Catalogue de prix de l'entreprise :\n${JSON.stringify(catalog)}`,
      `Prix de vos devis passés (dernier prix pratiqué ; signe = devis accepté ; fois = nombre de devis) :\n${JSON.stringify(prixPasses(cid, catalog, current?.id))}`,
      habitudes(s, 'devis'),
      exemples.length ? `Ses derniers devis (modèles de rédaction à imiter, pas à recopier) :\n${JSON.stringify(exemples)}` : '',
      current ? `Devis actuel :\n${JSON.stringify(strip(current))}` : base ? `Modèle de base :\n${JSON.stringify(strip(base))}` : '',
      photos.length ? `${photos.length} photo(s) jointe(s) du chantier ou d'un plan.` : '',
      `Dictée :\n${transcript?.trim() || '(aucune : fais le devis d’après les photos)'}`,
    ].filter(Boolean).join('\n\n'), DEVIS_SCHEMA, photos.length ? photos.map((p, i) => ({ type: 'image/' + PHOTO.exec(p)[1], data: PHOTO.exec(p)[2], nom: 'photo' + (i + 1) })) : null, partiel, { chaud: true }) };
    if (apercu) { apercus.set(cid, a); a.p.catch(() => apercus.get(cid) === a && apercus.delete(cid)); }
  }
  const out = await a.p;
  if (apercu) return { html: rendu(out) };
  const { transcription_fr, ...data } = out;
  data.client = { ...(current || base)?.data.client, ...data.client };
  data.dictees = [...(current?.data.dictees || []), { lang, texte: transcript || '', fr: transcription_fr, ...(photos.length && { photos: photos.length }), le: new Date().toISOString() }];
  if (exemple && !current) data.exemple = true; // devis de la visite guidée (voir prepareDoc)
  data.ia = iaLignes(data.lignes); // ce que Kadra a proposé : comparé plus tard au devis envoyé, pour apprendre des corrections
  const doc = current ? update('documents', current.id, { data: { ...current.data, ...data } }, cid) : insert('documents', { type: 'devis', template_id: base?.template_id, data }, cid);
  for (const p of photos) run('INSERT INTO doc_photos (compte_id, document_id, image) VALUES (?,?,?)', cid, doc.id, p);
  return doc;
}

const MAIL_SCHEMA = S({ sujet: str, corps: str });
const mailSystem = s => `Tu écris les e-mails d'un artisan du bâtiment (entreprise « ${s.nom} ») à ses clients. L'artisan te donne une consigne, souvent dictée à l'oral, parfois dans une autre langue ou en mélangeant plusieurs langues (ex. turc et français), avec des erreurs de reconnaissance vocale : comprends l'intention.

Règles :
- Écris en français, sauf si le client a écrit dans une autre langue ou si la consigne le demande : alors dans cette langue.
- Ton professionnel, simple et chaleureux. Court : quelques phrases. Vouvoiement.
- Utilise le contexte (documents, montants, échanges) seulement quand c'est utile. N'invente jamais un prix, une date, un délai ou un engagement absent de la consigne ou du contexte.
- Si tu réponds à un e-mail, réponds à ses questions d'après la consigne ; sujet « Re: » + sujet d'origine.
- Commence par « Bonjour » + nom du client, termine par « Cordialement, » puis le nom de l'entreprise. Pas de signature inventée (pas de téléphone ni d'adresse).
- Si la façon d'écrire de l'artisan ou ses consignes sont fournies, elles passent avant les règles de forme ci-dessus (salutation, ton, longueur, formule de fin, signature) : écris comme lui.`;
async function aiMail({ consigne, reponse_a, actuel }, c, user, cid) {
  const s = settings(cid);
  const orig = reponse_a && get('SELECT * FROM emails WHERE id=? AND compte_id=?', reponse_a, cid);
  if (!consigne?.trim()) {
    if (!orig) throw httpErr(400, 'Dites ou écrivez ce que vous voulez écrire.');
    // Réponse sans consigne : Claude répond d'après l'e-mail et le contexte, sans rien promettre de lui-même.
    consigne = 'Pas de consigne : réponds toi-même à cet e-mail d’après son contenu et le contexte. Pour ce que le contexte ne dit pas (date, prix, disponibilité), ne décide rien : dis que l’artisan revient vers le client rapidement.';
  }
  const docs = all(`SELECT * FROM (${scoped('documents', cid)}) WHERE client_id=? AND type IN ('devis','facture') ORDER BY id DESC LIMIT 10`, c.id)
    .map(d => ({ numero: d.numero || 'brouillon', type: d.kind === 'acompte' ? 'facture d’acompte' : d.type, statut: d.statut, objet: d.data.objet, total_ttc: d.total_ttc, reste: d.type === 'facture' ? r2(d.total_ttc - d.regle) : undefined, echeance: d.echeance }));
  const fil = clientEmails(c, cid).slice(0, 6).reverse().map(e => `[${e.created_at}] ${e.sens === 'recu' ? 'Client → artisan' : 'Artisan → client'} — ${e.sujet}\n${String(e.corps).slice(0, 1200)}`);
  return askClaude(mailSystem(s), [
    `Client : ${c.nom}${c.email ? ` <${c.email}>` : ''}`,
    `Langue principale de l'artisan : ${user.langue || s.langue}`,
    habitudes(s, 'mails'),
    docs.length ? `Documents du client :\n${JSON.stringify(docs)}` : '',
    fil.length ? `Derniers échanges :\n${fil.join('\n\n')}` : '',
    orig ? `E-mail auquel répondre :\nSujet : ${orig.sujet}\n${orig.corps}` : '',
    actuel?.trim() ? `Réponse déjà écrite (garde-la et modifie-la selon la consigne, sauf si la consigne demande autre chose) :\n${String(actuel).slice(0, 4000)}` : '',
    `Consigne de l'artisan :\n${consigne}`,
  ].filter(Boolean).join('\n\n'), MAIL_SCHEMA, null, null, { chaud: true }); // pas Haiku : il invente des disponibilités
}

// ---------- Rendez-vous repérés dans les e-mails ----------
const RDV_SCHEMA = S({ rdv: { type: 'array', items: S({ email_id: num, titre: str, date: str, heure: str, heure_fin: str, lieu: str }) } });
const RDV_SYSTEM = `Tu lis les e-mails échangés entre un artisan du bâtiment et ses clients, et tu repères les rendez-vous convenus ou proposés : visite, métré, début de travaux, livraison, passage sur le chantier, réception des travaux, appel téléphonique prévu…

Règles :
- Seulement les rendez-vous dont on connaît le jour : une date, ou « demain », « lundi prochain », « jeudi » (calcule la date d'après la date de l'e-mail). Pas de date vague (« début novembre », « la semaine prochaine »), pas de délai, pas d'échéance de paiement.
- date au format AAAA-MM-JJ ; heure et heure_fin au format HH:MM sur 24 h, ou chaîne vide si elles ne sont pas dites.
- titre : court, en français, avec le nom du client (ex. « Visite avant signature – M. Haddad »).
- lieu : l'adresse si elle est écrite, sinon chaîne vide.
- email_id : le numéro de l'e-mail d'où vient le rendez-vous.
- Un rendez-vous cité dans plusieurs e-mails n'apparaît qu'une fois, à sa date la plus récente (s'il a été déplacé).
- Les e-mails peuvent être dans une autre langue que le français.
- Liste vide s'il n'y a aucun rendez-vous.`;
async function extraireRdv(mails, cid) {
  if (!mails.length) return [];
  const out = await askClaude(RDV_SYSTEM, [`Aujourd'hui : ${today()}.`, ...mails.map(m => `[e-mail ${m.id}] envoyé le ${m.created_at}, ${m.sens === 'recu' ? `du client ${m.client_nom || m.de} à l'artisan` : `de l'artisan au client ${m.client_nom || m.a}`}
Sujet : ${m.sujet}
${String(m.corps).slice(0, 2000)}`)].join('\n\n'), RDV_SCHEMA);
  const par = new Map(mails.map(m => [m.id, m])), hh = t => (/^\d{2}:\d{2}$/.test(t) ? t : '');
  return out.rdv.filter(r => par.has(r.email_id) && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).map(r => {
    const m = par.get(r.email_id), debut = r.date + (hh(r.heure) && 'T' + hh(r.heure));
    // un seul chantier en cours pour ce client : le rendez-vous s'y rattache (et prend son adresse)
    const chs = m.cli ? all("SELECT id, adresse FROM chantiers WHERE compte_id=? AND client_id=? AND statut!='termine'", cid, m.cli) : [];
    return { titre: String(r.titre).slice(0, 200), debut, fin: hh(r.heure) && hh(r.heure_fin) ? `${r.date}T${hh(r.heure_fin)}` : null, lieu: r.lieu || (chs.length === 1 && chs[0].adresse) || '',
      client_id: m.cli, chantier_id: chs.length === 1 ? chs[0].id : null, email_id: m.id };
  });
}
// Lit les e-mails pas encore vus (60 derniers jours, échanges réels avec un client) et propose leurs rendez-vous dans l'agenda.
const rdvEnCours = new Set();
async function chercherRdv(cid) {
  if (rdvEnCours.has(cid)) return 0;
  rdvEnCours.add(cid);
  try {
    const mails = all(`${MAILS} WHERE x.rdv_vu=0 AND x.cli IS NOT NULL AND (x.sens='recu' OR (x.document_id IS NULL AND x.chantier_id IS NULL))
      AND x.created_at >= datetime('now','-60 days') ORDER BY x.created_at DESC LIMIT 30`, cid);
    let n = 0;
    for (const r of await extraireRdv(mails, cid)) {
      if (r.debut.slice(0, 10) < today() || get('SELECT id FROM rdv WHERE compte_id=? AND debut=? AND (email_id=? OR client_id IS ?)', cid, r.debut, r.email_id, r.client_id)) continue;
      insert('rdv', { ...r, statut: 'propose' }, cid); n++;
    }
    if (mails.length) run(`UPDATE emails SET rdv_vu=1 WHERE compte_id=? AND id IN (${mails.map(() => '?')})`, cid, ...mails.map(m => m.id));
    return n;
  } finally { rdvEnCours.delete(cid); }
}
// ---------- Assistant vocal : une phrase de l'artisan → une action à valider (rien n'est enregistré ici) ----------
const ACTIONS = ['modifier', 'devis', 'note', 'rdv', 'email', 'paiement', 'client', 'ouvrir', 'reponse'];
const PAGES = ['accueil', 'analyse', 'agenda', 'notes', 'mails', 'chantiers', 'devis', 'factures', 'factures_retard', 'clients', 'catalogue', 'parametres', 'client', 'chantier', 'document'];
const CMD_SCHEMA = S({ action: { type: 'string', enum: ACTIONS }, client_id: num, chantier_id: num, document_id: num,
  titre: str, date: str, heure: str, heure_fin: str, lieu: str, consigne: str, montant: num, mode: str,
  nom: str, email: str, tel: str, adresse: str, page: { type: 'string', enum: PAGES }, reponse: str, langue: str });
const CMD_SYSTEM = `Tu es l'assistant vocal de Kadra, le logiciel d'un artisan du bâtiment. L'artisan te parle (souvent sur un chantier, au téléphone), parfois dans une autre langue ou en mélangeant les langues (ex. turc et français), avec des erreurs de reconnaissance vocale : comprends l'intention et choisis UNE action.

Actions :
- modifier : seulement si un document est ouvert à l'écran : il veut le changer (ajouter, enlever ou changer une ligne, un prix, une quantité, l'objet, le client, la remise…). Des travaux décrits sans parler d'un autre client = modifier ce document, pas un nouveau devis. (Rien d'autre à remplir : la phrase sera reprise telle quelle.)
- devis : il décrit des travaux à chiffrer, ou demande un devis. (Rien d'autre à remplir : la dictée sera reprise telle quelle.)
- note : il veut garder une note pour plus tard, sans faire le devis tout de suite (« note », « prends note », « pense-bête », ce qu'il voit ou mesure sur un chantier, matériaux à acheter, choses à faire). client_id / chantier_id si reconnus. (La phrase sera gardée telle quelle.)
- rdv : il veut noter un rendez-vous. titre court en français avec le nom du client ; date AAAA-MM-JJ (calcule « demain », « jeudi », « lundi prochain » d'après la date du jour) ; heure et heure_fin HH:MM ou vide ; lieu si dit ; client_id / chantier_id si reconnus.
- email : il veut écrire ou répondre à un client. client_id obligatoire ; consigne = ce qu'il faut dire, reformulé clairement en français.
- paiement : un client l'a payé. document_id = la facture non soldée concernée (celle du client, la plus ancienne si plusieurs et rien de précisé) ; montant en euros (0 si non dit = tout le reste) ; mode parmi Virement, Chèque, Espèces, Carte.
- client : il veut ajouter un nouveau client : nom, email, tel, adresse (ce qui est dit).
- ouvrir : il veut voir une page. page = accueil, agenda, notes, mails, chantiers, devis, factures, factures_retard, clients, catalogue, parametres ; ou client / chantier / document avec l'identifiant correspondant.
- reponse : il pose une question sur son activité (rendez-vous, qui doit combien, retrouver un devis…), ou la demande n'entre dans aucune action. reponse = réponse courte (1 à 3 phrases, faite pour être lue à voix haute), dans la langue où l'artisan vient de parler (celle de son micro, sauf s'il a clairement parlé une autre langue), langue = son code (ex. fr-FR, tr-TR) ; seulement d'après les données fournies ; si tu ne sais pas, dis-le et propose ce que tu sais faire. Remplis aussi client_id / chantier_id / document_id de ce dont tu parles, et propose la suite si elle est utile (« Je vous l'ouvre ? »).

Conversation : s'il y a des échanges précédents, la phrase peut y répondre (« oui », « vas-y, ouvre-le », « et pour lui ? », « non laisse ») : reprends alors ce dont on parlait (mêmes identifiants). « Non » ou « c'est bon » = reponse courte (« D'accord. »).

Règles :
- Les identifiants viennent uniquement des listes fournies ; 0 si personne ne correspond (n'invente pas). Noms approximatifs acceptés (« Dupond » = « Dupont »).
- Les champs inutiles pour l'action : chaîne vide ou 0. page = accueil si l'action n'est pas « ouvrir ».
- N'invente jamais un montant, une date ou une heure qui n'a pas été dit.`;
async function aiCommande({ texte, doc_id, fil, langue }, user, cid) {
  if (!texte?.trim()) throw httpErr(400, 'Je n’ai rien entendu : réessayez.');
  const s = settings(cid), q = t => all(`SELECT * FROM (${scoped(t, cid)})`);
  // document affiché par l'artisan, s'il peut encore être modifié (une facture émise est figée)
  const ouvert = doc_id ? one('documents', +doc_id, cid) : null, modifiable = ouvert && !(ouvert.type === 'facture' && ouvert.numero);
  const clients = all('SELECT id, nom, tel, adresse FROM clients WHERE compte_id=? ORDER BY id DESC LIMIT 400', cid);
  const chantiers = q('chantiers').filter(c => c.statut !== 'termine').map(c => ({ id: c.id, nom: c.nom, client_id: c.client_id, adresse: c.adresse, statut: c.statut, debut: c.date_debut, fin_prevue: c.date_fin_prevue, avancement: c.avancement }));
  const docs = q('documents').filter(d => d.type !== 'modele');
  const factures = docs.filter(d => d.type === 'facture' && d.numero && d.kind !== 'avoir' && d.regle < d.total_ttc - 0.005)
    .map(d => ({ id: d.id, numero: d.numero, client_id: d.client_id, client: d.client_nom, reste: r2(d.total_ttc - d.regle), echeance: d.echeance }));
  const devis = docs.filter(d => d.type === 'devis').sort((a, b) => b.id - a.id).slice(0, 80)
    .map(d => ({ id: d.id, numero: d.numero, client: d.client_nom, objet: d.data.objet, total_ttc: d.total_ttc, statut: d.statut, date: d.date }));
  // échanges précédents envoyés par le navigateur : texte court seulement (rien n'en est exécuté tel quel)
  const avant = (Array.isArray(fil) ? fil : []).slice(-6).map(e => ({ artisan: String(e?.dit || '').slice(0, 500), kadra: String(e?.kadra || '').slice(0, 500),
    client_id: +e?.client_id || 0, chantier_id: +e?.chantier_id || 0, document_id: +e?.document_id || 0 }));
  const rdvs = all(`SELECT * FROM (${scoped('rdv', cid)}) WHERE debut >= ? AND debut < date(?, '+15 days') ORDER BY debut`, today(), today())
    .map(r => ({ debut: r.debut, fin: r.fin, titre: r.titre, client: r.client_nom, lieu: r.lieu, a_confirmer: r.statut === 'propose' }));
  const jour = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const out = await askClaude(CMD_SYSTEM, [
    `Aujourd'hui : ${jour} (${today()}). Entreprise : ${s.nom}. Langue du micro de l'artisan : ${/^[a-z]{2}(-[A-Z]{2})?$/.test(langue) ? langue : user.langue || s.langue || 'fr-FR'}.`,
    `Clients :\n${JSON.stringify(clients)}`, `Chantiers en cours ou à venir :\n${JSON.stringify(chantiers)}`,
    `Factures pas encore payées :\n${JSON.stringify(factures)}`, `Devis (les plus récents d'abord ; statut brouillon, envoye = en attente, accepte, refuse) :\n${JSON.stringify(devis)}`,
    `Rendez-vous des 15 prochains jours :\n${JSON.stringify(rdvs)}`,
    modifiable ? `Document ouvert à l'écran :\n${JSON.stringify({ type: ouvert.type, numero: ouvert.numero, client: ouvert.data.client?.nom, objet: ouvert.data.objet, lignes: (ouvert.data.lignes || []).map(l => l.designation).slice(0, 60) })}`
      : 'Aucun document ouvert à l’écran : n’utilise pas l’action modifier.',
    ...(avant.length ? [`Échanges précédents (le plus récent en dernier) :\n${JSON.stringify(avant)}`] : []),
    `Ce que dit l'artisan :\n${texte}`,
  ].join('\n\n'), CMD_SCHEMA, null, null, { modele: 'haiku', chaud: true }); // l'artisan attend en parlant : Haiku (8,5 → ~5 s, mêmes actions)
  // Claude ne choisit que parmi les identifiants fournis : tout le reste devient null.
  const pick = (id, list) => (list.some(x => x.id === id) ? id : null);
  const r = { ...out, texte, client_id: pick(out.client_id, clients), chantier_id: pick(out.chantier_id, chantiers), document_id: pick(out.document_id, [...factures, ...docs]) };
  if (r.action === 'modifier') {
    if (modifiable) r.document_id = ouvert.id;
    else Object.assign(r, { action: 'reponse', reponse: 'Ouvrez d’abord le devis à modifier, puis redites-moi le changement.' });
  }
  if (r.action === 'paiement') {
    r.facture = factures.find(f => f.id === r.document_id) || null;
    r.autres = r.facture ? factures.filter(f => f.client_id === r.facture.client_id).length - 1 : 0;
  }
  return r;
}

// Abonnement agenda (.ics) pour le téléphone : Google Agenda, iPhone, Outlook.
// ponytail: lignes ICS non repliées à 75 octets ; les agendas courants les acceptent.
const icsTxt = s => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDate = d => d.replace(/[-:]/g, '') + (d.length > 10 ? '00' : '');
const plus1h = d => { const [j, t] = d.split('T'), [hr, mn] = t.split(':').map(Number); return hr >= 23 ? `${j}T23:59` : `${j}T${String(hr + 1).padStart(2, '0')}:${String(mn).padStart(2, '0')}`; };
function ics(cid) {
  const s = settings(cid), stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const ev = all(`SELECT * FROM (${scoped('rdv', cid)}) WHERE statut='confirme' AND debut >= ?`, addDays(today(), -90)).map(r => {
    const jour = r.debut.length === 10;
    return ['BEGIN:VEVENT', `UID:rdv-${r.id}-${cid}@kadra`, `DTSTAMP:${stamp}`,
      jour ? `DTSTART;VALUE=DATE:${icsDate(r.debut)}` : `DTSTART:${icsDate(r.debut)}`, jour ? `DTEND;VALUE=DATE:${icsDate(addDays(r.debut, 1))}` : `DTEND:${icsDate(r.fin || plus1h(r.debut))}`,
      `SUMMARY:${icsTxt(r.titre)}`, r.lieu && `LOCATION:${icsTxt(r.lieu)}`,
      `DESCRIPTION:${icsTxt([r.client_nom, r.client_tel && 'Tél. ' + r.client_tel, r.chantier_nom && 'Chantier : ' + r.chantier_nom, r.notes].filter(Boolean).join('\n'))}`, 'END:VEVENT'].filter(Boolean).join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kadra//FR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsTxt('Kadra – ' + s.nom)}`, ...ev, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

const TEMPLATE_SCHEMA = S({ nom: str, html: str });
async function aiTemplate({ file, nom }, cid) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(file || '');
  if (!m) throw httpErr(400, 'Fichier invalide.');
  let [, type, data] = m, grille = '';
  // Excel : on reconstruit la feuille en HTML, Claude reçoit la grille (structure exacte) et sa capture (rendu).
  if (Buffer.from(data.slice(0, 8), 'base64').readUInt32LE(0) === 0x04034b50) {
    grille = xlsxToHtml(Buffer.from(data, 'base64'));
    const png = await htmlToPng(grille).catch(() => null); // sans Chrome : la grille seule suffit
    [type, data] = png ? ['image/png', png.toString('base64')] : [null, null];
  } else if (!/^(application\/pdf|image\/(png|jpeg|webp|gif))$/.test(type)) throw httpErr(400, 'Formats acceptés : PDF, image (PNG, JPEG, WebP) ou Excel (.xlsx).');
  const s = masked(settings(cid)), ex = docContext(SAMPLE, s);
  const system = `Tu convertis un devis ou une facture d'artisan (photo, PDF ou feuille Excel) en gabarit HTML autonome qui reproduit fidèlement sa mise en page pour une impression A4 : disposition, couleurs, typographie, encadrés, colonnes du tableau, totaux, pied de page.

Balises (doubles accolades = texte, triples = HTML) :
${Object.entries(PLACEHOLDERS).map(([k, l]) => `- {{${k}}} : ${l}`).join('\n')}
Les coordonnées de l'entreprise s'écrivent avec les balises {{entreprise.x}} (ex. pied de page « {{entreprise.adresse}} – Tél. {{entreprise.tel}} – SIRET {{entreprise.siret}} »), jamais en dur.

Blocs produits automatiquement : ne les recrée pas, place-les et style-les en CSS. Voici exactement le HTML qu'ils produisent (données d'exemple) :
${['logo', 'bloc_client', 'bloc_entreprise', 'lignes', 'totaux', 'signature', 'mentions'].map(k => `{{{${k}}}} →\n${ex[k] || '(vide : pas de logo dans les paramètres)'}`).join('\n\n')}

Tableau des lignes : ses colonnes se choisissent dans le <head> pour correspondre au document, dans le même ordre et avec les mêmes intitulés :
<meta name="kadra-colonnes" content="designation=Description;qte=Quantité;pu=Prix unitaire;total=Montant">
Clés : num (numéro de ligne), designation, qte, unite, pu (prix unitaire HT), tva, total (montant HT). Ajoute « ;soustotaux » seulement si le document montre un sous-total par section. Sans colonne unité, l'unité suit la quantité.
Chaque cellule porte la classe de sa colonne (th.c-pu, td.c-designation…) ; les titres de section sont des tr.section ; les colonnes chiffrées ont la classe .n (alignées à droite). Style les colonnes par ces classes (largeur, alignement, bordures), jamais par position (pas de :first-child, :not(:first-child), nth-child).
{{{logo}}} est une <img class="logo"> : règle sa taille avec img.logo{…} et ne donne pas la classe « logo » à un autre élément.
Un grand total mis en valeur (bandeau, encadré) utilise {{doc.total_ttc}}.
Commence le <style> par {{{css_base}}}. Le texte fixe (titres, libellés, conditions, pied de page) est gardé tel quel ; les données d'exemple (client, lignes, montants, dates, numéros, taux et montant d'acompte, coordonnées) deviennent des balises ou disparaissent ({{{mentions}}} donne déjà l'acompte et les mentions légales).
Pour une feuille Excel : ne recopie pas la grille du tableur (pas de quadrillage, pas de colonnes fixes) ; retrouve les blocs du devis et reproduis leur place, leur ordre, leurs couleurs, leurs bordures et leurs polices.
Aucun JavaScript, aucune ressource externe (polices système uniquement). nom = nom court du gabarit.`;
  const xl = grille && `Feuille Excel du devis, reconstruite en HTML (cellules fusionnées, couleurs, bordures et polices d'origine)${type ? ' ; la capture de cette feuille est jointe' : ''} :\n${grille}`;
  const original = type && { type, data, nom: 'original' };
  let out = await askClaude(system, [xl, 'Crée le gabarit HTML de ce document.'].filter(Boolean).join('\n\n'), TEMPLATE_SCHEMA, original);
  // Relecture : Claude voit son gabarit rendu à côté de l'original et corrige les écarts (sans Chrome : on garde le premier jet).
  const rendu = await htmlToPng(stripScripts(renderDoc({ ...SAMPLE, compte_id: cid }, s, out.html))).catch(() => null);
  if (rendu) {
    out = await askClaude(system, [xl, `Fichiers : ${original ? '« original » = le document d’origine ; ' : ''}« rendu » = ton gabarit ci-dessous, rempli avec des données d'exemple (elles diffèrent de l'original, c'est normal).
Compare les mises en page et corrige tous les écarts : place et taille des blocs, colonnes du tableau et leurs intitulés, alignements, couleurs, bordures, polices, totaux, pied de page, logo. Renvoie le gabarit complet corrigé.

Gabarit actuel :
${out.html}`].filter(Boolean).join('\n\n'), TEMPLATE_SCHEMA, [original, { type: 'image/png', data: rendu.toString('base64'), nom: 'rendu' }].filter(Boolean)).catch(() => out);
  }
  return insert('templates', { nom: nom || out.nom || 'Mon modèle', html: out.html }, cid);
}

// ---------- Paiement en ligne (Stripe Checkout, sur le compte Stripe de chaque entreprise) ----------
async function stripe(key, p, params) {
  const r = await fetch('https://api.stripe.com/v1/' + p, {
    method: params ? 'POST' : 'GET', body: params && new URLSearchParams(params),
    headers: { Authorization: 'Bearer ' + key, ...(params && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
  });
  const j = await r.json();
  if (!r.ok) throw httpErr(502, 'Stripe : ' + (j.error?.message || r.status));
  return j;
}
async function enregistrerPaiement(doc, montant, ref) {
  if (get('SELECT id FROM payments WHERE ref=?', ref)) return;
  run('INSERT INTO payments (compte_id, document_id, montant, date, mode, note, ref) VALUES (?,?,?,?,?,?,?)', doc.compte_id, doc.id, montant, today(), 'Carte (en ligne)', 'Paiement Stripe', ref);
  const s = settings(doc.compte_id);
  if (s.email) await sendMail(doc.compte_id, { to: s.email, sujet: `Paiement reçu : ${eur(montant)} sur ${doc.numero}`, corps: `${doc.data.client?.nom || 'Le client'} vient de régler ${eur(montant)} en ligne sur la facture ${doc.numero}.`, document_id: doc.id });
}

// ---------- Tableau de bord ----------
function dashboard(cid) {
  const docs = all(scoped('documents', cid)), y = String(new Date().getFullYear()), t = today();
  const fac = docs.filter(d => d.type === 'facture' && d.numero);
  const devis = docs.filter(d => d.type === 'devis');
  const pays = all('SELECT * FROM payments WHERE compte_id=?', cid);
  const impayees = fac.filter(f => f.kind !== 'avoir' && f.regle < f.total_ttc - 0.005);
  const decided = devis.filter(d => ['accepte', 'refuse', 'envoye'].includes(d.statut));
  const sum = (a, f) => r2(a.reduce((s, x) => s + f(x), 0));
  const chs = all(scoped('chantiers', cid)), ouverts = chs.filter(c => c.statut !== 'termine');
  // Argent oublié : acompte prévu au devis signé mais pas facturé, chantier fini dont le solde n'est pas facturé
  const a_facturer = [
    ...devis.filter(d => d.statut === 'accepte' && d.data.acompte_pct > 0 && !docs.some(f => f.parent_id === d.id && f.type === 'facture'))
      .map(d => ({ href: '#/doc/' + d.id, nom: d.client_nom, quoi: `Acompte de ${d.data.acompte_pct} % pas facturé (${d.numero})`, montant: r2(d.total_ttc * d.data.acompte_pct / 100) })),
    ...chs.filter(c => c.statut === 'termine' && c.budget - c.facture > 0.005)
      .map(c => ({ href: '#/chantier/' + c.id, nom: c.client_nom || c.nom, quoi: `Chantier fini, ${c.facture ? 'solde' : 'rien'} pas facturé : ${c.nom}`, montant: r2(c.budget - c.facture) })),
  ];
  // Travail signé qui reste à faire (prix HT × ce qui n'est pas encore fait), et jusqu'à quand
  const a_venir = { ht: sum(ouverts, c => c.budget_ht * (1 - (c.avancement || 0) / 100)), nb: ouverts.length,
    jusqua: ouverts.map(c => c.date_fin_prevue).filter(Boolean).sort().pop() || null };
  return {
    a_facturer, a_venir,
    facture_annee: sum(fac.filter(f => f.date?.startsWith(y)), f => f.total_ttc),
    encaisse_annee: sum(pays.filter(p => p.date?.startsWith(y)), p => p.montant),
    a_encaisser: sum(impayees, f => f.total_ttc - f.regle),
    en_retard: sum(impayees.filter(f => f.echeance < t), f => f.total_ttc - f.regle),
    devis_attente: { nb: devis.filter(d => d.statut === 'envoye').length, montant: sum(devis.filter(d => d.statut === 'envoye'), d => d.total_ttc) },
    taux_transfo: decided.length ? Math.round(100 * decided.filter(d => d.statut === 'accepte').length / decided.length) : null,
    // chiffre d'affaires et graphique calculés dans le navigateur selon la période choisie (avoirs en négatif)
    ca: fac.map(f => [f.date || '', f.total_ht, f.total_ttc]),
    pays: pays.map(p => [p.date || '', p.montant]),
    factures_retard: impayees.filter(f => f.echeance < t),
    devis_a_relancer: devis.filter(d => d.statut === 'envoye'),
    chantiers: ouverts,
    rdv: all(`SELECT * FROM (${scoped('rdv', cid)}) WHERE statut='confirme' AND debut >= ? AND debut < ? ORDER BY debut LIMIT 6`, t, addDays(t, 8)),
    mails: all(`SELECT x.id, x.de, x.sujet, substr(x.corps, 1, 140) apercu, x.created_at, x.client_nom FROM (${MAILS}) x WHERE x.sens='recu' AND x.lu=0 ORDER BY x.created_at DESC LIMIT 4`, cid),
    ...compteurs(cid),
  };
}
// ---------- Analyse : qui paie bien, quels chantiers rapportent, quels devis se signent ----------
// Un chantier « rapporte » = (prix HT − dépenses HT saisies) par jour de chantier. ponytail: les heures de travail ne sont pas comptées.
const jours = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const moyenne = a => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
const TRANCHES = [[0, 'Moins de 2 000 €'], [2000, '2 000 à 5 000 €'], [5000, '5 000 à 15 000 €'], [15000, 'Plus de 15 000 €']];
function analyse(cid) {
  const t = today(), docs = all(scoped('documents', cid)), byId = new Map(docs.map(d => [d.id, d]));
  const dernierPaiement = new Map(all('SELECT document_id, MAX(date) d FROM payments WHERE compte_id=? GROUP BY document_id', cid).map(p => [p.document_id, p.d]));
  const fac = docs.filter(d => d.type === 'facture' && d.numero), devis = docs.filter(d => d.type === 'devis');
  const clients = new Map();
  const cli = d => {
    const k = d.client_id || d.data.client?.nom || '?';
    if (!clients.has(k)) clients.set(k, { id: d.client_id, nom: d.client_nom || d.data.client?.nom || 'Sans nom', ht: 0, ttc: 0, regle: 0, en_retard: 0, retard_max: 0, relances: 0, delais: [], retards: [], devis: 0, signes: 0 });
    return clients.get(k);
  };
  for (const f of fac) {
    const c = cli(f), paye = dernierPaiement.get(f.id);
    c.ht += f.total_ht; c.ttc += f.total_ttc; c.regle += f.kind === 'avoir' ? f.total_ttc : f.regle; c.relances += f.relances || 0;
    if (f.kind === 'avoir') continue;
    if (f.regle >= f.total_ttc - 0.005) { if (paye && f.date) { c.delais.push(jours(f.date, paye)); if (f.echeance) c.retards.push(Math.max(0, jours(f.echeance, paye))); } }
    else if (f.echeance < t) { c.en_retard += f.total_ttc - f.regle; c.retard_max = Math.max(c.retard_max, jours(f.echeance, t)); }
  }
  for (const d of devis.filter(d => ['accepte', 'refuse', 'envoye'].includes(d.statut))) { const c = cli(d); c.devis++; if (d.statut === 'accepte') c.signes++; }
  const liste = [...clients.values()].map(({ delais, retards, ...c }) => {
    const retard = moyenne(retards);
    // bon : paie à l'échéance ; moyen : quelques jours de retard ; mauvais : retard moyen > 15 j ou impayé depuis plus de 30 j
    const note = c.retard_max > 30 || retard > 15 ? 'mauvais' : c.en_retard || retard > 3 ? 'moyen' : retards.length ? 'bon' : null;
    return { ...c, ht: r2(c.ht), ttc: r2(c.ttc), reste: r2(c.ttc - c.regle), en_retard: r2(c.en_retard), delai: moyenne(delais), retard, payees: delais.length, note };
  }).sort((a, b) => b.ht - a.ht);
  const chantiers = all(scoped('chantiers', cid)).map(ch => {
    const ht = r2(byId.get(ch.devis_id)?.total_ht ?? fac.filter(f => f.chantier_id === ch.id).reduce((s, f) => s + f.total_ht, 0));
    const fin = ch.statut === 'termine' ? ch.date_fin_reelle || ch.date_fin_prevue : ch.date_fin_prevue;
    const duree = ch.date_debut && fin ? Math.max(1, jours(ch.date_debut, fin) + 1) : null;
    const retard = ch.date_fin_prevue && ch.statut !== 'a_venir' ? Math.max(0, jours(ch.date_fin_prevue, ch.statut === 'termine' ? ch.date_fin_reelle || ch.date_fin_prevue : t)) : 0;
    return { id: ch.id, nom: ch.nom, client_nom: ch.client_nom, statut: ch.statut, ht, depenses: ch.depenses, encaisse: ch.encaisse, duree, prevu: ch.date_debut && ch.date_fin_prevue ? jours(ch.date_debut, ch.date_fin_prevue) + 1 : null, retard, par_jour: duree && ht ? Math.round((ht - ch.depenses) / duree) : null };
  }).sort((a, b) => (b.par_jour || 0) - (a.par_jour || 0));
  const decides = devis.filter(d => ['accepte', 'refuse'].includes(d.statut));
  return {
    clients: liste, chantiers,
    ca: fac.map(f => [f.date || '', f.total_ht]), // frise du chiffre d'affaires (avoirs en négatif)
    devis: {
      envoyes: decides.length, signes: decides.filter(d => d.statut === 'accepte').length,
      tranches: TRANCHES.map(([min, label], i) => { const ds = decides.filter(d => d.total_ht >= min && d.total_ht < (TRANCHES[i + 1]?.[0] ?? Infinity)); return { label, total: ds.length, signes: ds.filter(d => d.statut === 'accepte').length }; }),
      jours_signature: moyenne(decides.filter(d => d.signe_le && d.envoye_le).map(d => Math.max(0, jours(d.envoye_le.slice(0, 10), d.signe_le.slice(0, 10))))),
    },
    delai_moyen: moyenne(liste.filter(c => c.delai !== null).flatMap(c => Array(c.payees).fill(c.delai))),
    conseils: settings(cid).analyse_conseils || null,
  };
}
const ANALYSE_SCHEMA = S({ conseils: { type: 'array', items: S({ sujet: { type: 'string', enum: ['client', 'chantier', 'devis', 'general'] }, titre: str, texte: str }) } });
const ANALYSE_SYSTEM = `Tu es le conseiller de gestion d'un artisan du bâtiment. Tu reçois ses chiffres : clients (facturé, reste à payer, délai moyen de paiement en jours, retard moyen après l'échéance, relances, devis signés), chantiers (prix HT, dépenses HT saisies par l'artisan : matériaux, sous-traitance, location…, durée en jours, retard, par_jour = (prix HT − dépenses) par jour de chantier) et devis (taux de signature par tranche de prix, délai de signature).

Donne 4 à 6 conseils concrets pour gagner plus et être payé plus vite, du plus utile au moins utile.
Règles :
- Appuie chaque conseil sur un chiffre précis et cite les noms (client, chantier). N'invente aucun chiffre.
- Phrases courtes, mots simples, vouvoiement, en français. Pas de jargon (pas de « KPI », « marge brute », « cash-flow »).
- Actions possibles dans Kadra : demander un acompte plus élevé, raccourcir l'échéance, relancer plus tôt, proposer le paiement en ligne, privilégier un type de chantier, revoir ses prix sur une tranche de devis, relancer un devis après N jours.
- Les heures de travail ne sont pas comptées, et un chantier à 0 € de dépenses n'a peut-être simplement rien de saisi : ne parle pas de bénéfice, parle de ce que laisse une journée de chantier une fois les achats payés.
- titre : 8 mots maximum. texte : 2 phrases maximum.
- S'il y a trop peu de données, dis-le dans un seul conseil « general ».`;
async function aiAnalyse(cid) {
  const { conseils, ca, ...chiffres } = analyse(cid);
  const out = await askClaude(ANALYSE_SYSTEM, `Aujourd'hui : ${today()}.\n\n${JSON.stringify(chiffres)}`, ANALYSE_SCHEMA);
  const r = { le: new Date().toISOString(), conseils: out.conseils };
  saveSettings(cid, { analyse_conseils: r });
  return r;
}
function compteurs(cid) {
  return { non_lus: get("SELECT COUNT(*) n FROM emails WHERE compte_id=? AND sens='recu' AND lu=0", cid).n, rdv_proposes: get("SELECT COUNT(*) n FROM rdv WHERE compte_id=? AND statut='propose'", cid).n };
}

// ---------- Comptes, connexion, équipe ----------
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  const a = crypto.scryptSync(String(pw ?? ''), salt, 64), b = Buffer.from(h || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const SECURE = PUBLIC_URL.startsWith('https');
const sidOf = req => /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
function openSession(ctx, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions VALUES (?,?,?)', sha(token), userId, new Date(Date.now() + 30 * 864e5).toISOString());
  ctx.headers['Set-Cookie'] = `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SECURE ? '; Secure' : ''}`;
}
const userOf = req => {
  const token = sidOf(req);
  return token && get('SELECT u.id, u.compte_id, u.email, u.nom, u.role, u.langue, u.langue2 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires > ?', sha(token), new Date().toISOString());
};
const essais = new Map(); // anti force brute : 10 échecs / 15 min / IP
const fenetre = e => e && Date.now() - e.t < 15 * 60e3;
function limiter(req) { const e = essais.get(req.socket.remoteAddress); if (fenetre(e) && e.n >= 10) throw httpErr(429, 'Trop de tentatives : réessayez dans 15 minutes.'); }
const echec = req => { const ip = req.socket.remoteAddress, e = essais.get(ip); essais.set(ip, { n: fenetre(e) ? e.n + 1 : 1, t: fenetre(e) ? e.t : Date.now() }); };
const validPw = pw => { if (String(pw || '').length < 8) throw httpErr(400, 'Mot de passe : 8 caractères minimum.'); return pw; };
const validEmail = e => { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '')) throw httpErr(400, 'Adresse e-mail invalide.'); return e.trim(); };
const admin = user => { if (user.role !== 'admin') throw httpErr(403, 'Réservé à l’administrateur du compte.'); };
// Équipe Kadra (toutes entreprises) : adresses dans KADRA_ADMIN, séparées par des virgules.
const KADRA_ADMINS = (process.env.KADRA_ADMIN || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const isKadra = user => KADRA_ADMINS.includes(String(user.email).toLowerCase());
const kadra = user => { if (!isKadra(user)) throw httpErr(403, 'Réservé à l’équipe Kadra.'); };
const mailKadra = (to, subject, text) => mailer
  ? mailer.sendMail({ from: { name: 'Kadra', address: process.env.SMTP_FROM || process.env.SMTP_USER }, to, subject, text }).catch(e => console.error('E-mail Kadra :', e.message))
  : console.log(`E-mail Kadra (SMTP non configuré) à ${to} : ${subject}\n${text}`);

// ---------- Routes ----------
const routes = [];
const on = (method, pattern, fn, opts = {}) => routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, opts]);
const PUB = { pub: true };

// Le navigateur réutilise le moteur de rendu des documents (fiche devis modifiable en place).
const TEMPLATES_JS = fs.readFileSync(path.resolve('templates.js'), 'utf8').replace("'./public/calc.js'", "'/calc.js'");
on('GET', '/templates.js', ctx => { ctx.headers['Content-Type'] = 'text/javascript; charset=utf-8'; return TEMPLATES_JS; }, PUB);

on('POST', '/api/auth/signup', (ctx) => {
  if (process.env.ALLOW_SIGNUP === 'false') throw httpErr(403, 'Les inscriptions sont fermées : demandez une invitation.');
  const { entreprise, nom, email, password } = ctx.body;
  if (!entreprise?.trim()) throw httpErr(400, 'Indiquez le nom de votre entreprise.');
  validEmail(email); validPw(password);
  if (get('SELECT id FROM users WHERE email=?', email.trim())) throw httpErr(409, 'Un compte existe déjà avec cette adresse.');
  const premier = !get('SELECT id FROM comptes');
  const legacy = premier && cols('settings').length ? get('SELECT data FROM settings')?.data || {} : {}; // parseRow a déjà décodé `data`
  const cid = Number(run('INSERT INTO comptes (settings) VALUES (?)', JSON.stringify({ ...legacy, nom: entreprise.trim(), email: legacy.email || email.trim() })).lastInsertRowid);
  // La toute première entreprise récupère les données de l'ancienne version mono-entreprise.
  if (premier) {
    for (const t of ['clients', 'catalog', 'chantiers', 'documents', 'payments', 'emails']) run(`UPDATE ${t} SET compte_id=? WHERE compte_id IS NULL`, cid);
    run('UPDATE templates SET compte_id=? WHERE compte_id IS NULL AND builtin=0', cid);
  }
  const uid = Number(run('INSERT INTO users (compte_id, email, nom, hash, role) VALUES (?,?,?,?,?)', cid, email.trim(), (nom || '').trim(), hashPw(password), 'admin').lastInsertRowid);
  openSession(ctx, uid);
  return { ok: true };
}, PUB);
on('POST', '/api/auth/login', (ctx) => {
  limiter(ctx.req);
  const u = get('SELECT * FROM users WHERE email=?', String(ctx.body.email || '').trim());
  if (!u || !checkPw(ctx.body.password, u.hash)) { echec(ctx.req); throw httpErr(401, 'E-mail ou mot de passe incorrect.'); }
  openSession(ctx, u.id);
  return { ok: true };
}, PUB);
on('POST', '/api/auth/logout', (ctx) => {
  const token = sidOf(ctx.req);
  if (token) run('DELETE FROM sessions WHERE token=?', sha(token));
  ctx.headers['Set-Cookie'] = 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
  return { ok: true };
}, PUB);
// Mot de passe oublié : lien valable 1 h, à usage unique. Même réponse que l'adresse existe ou non (on ne révèle pas les comptes).
on('POST', '/api/auth/oubli', async (ctx) => {
  limiter(ctx.req); echec(ctx.req); // compte comme un essai : pas d'envoi en rafale
  const u = get('SELECT * FROM users WHERE email=?', String(ctx.body.email || '').trim());
  if (u) {
    const token = crypto.randomBytes(32).toString('hex'), lien = `${PUBLIC_URL}/#/reset/${token}`;
    run('DELETE FROM resets WHERE user_id=?', u.id);
    run('INSERT INTO resets VALUES (?,?,?)', sha(token), u.id, new Date(Date.now() + 3600e3).toISOString());
    const corps = `Bonjour,\n\nPour choisir un nouveau mot de passe Kadra, ouvrez ce lien (valable 1 heure) :\n${lien}\n\nSi vous n’avez rien demandé, ignorez cet e-mail : votre mot de passe ne change pas.\n\nKadra`;
    if (mailer) await mailer.sendMail({ from: { name: 'Kadra', address: process.env.SMTP_FROM || process.env.SMTP_USER }, to: u.email, subject: 'Kadra : nouveau mot de passe', text: corps }).catch(e => console.error('Mot de passe oublié :', e.message));
    else console.log(`Mot de passe oublié (SMTP non configuré) pour ${u.email} : ${lien}`);
  }
  return { ok: true };
}, PUB);
on('POST', '/api/auth/reset', (ctx) => {
  limiter(ctx.req);
  const r = get('SELECT * FROM resets WHERE token=? AND expires > ?', sha(String(ctx.body.token || '')), new Date().toISOString());
  if (!r) { echec(ctx.req); throw httpErr(400, 'Lien expiré ou déjà utilisé : redemandez un nouveau mot de passe.'); }
  run('UPDATE users SET hash=? WHERE id=?', hashPw(validPw(ctx.body.password)), r.user_id);
  run('DELETE FROM resets WHERE user_id=?', r.user_id);
  run('DELETE FROM sessions WHERE user_id=?', r.user_id); // déconnecte les autres appareils
  openSession(ctx, r.user_id);
  return { ok: true };
}, PUB);
on('GET', '/api/me', ({ user, cid }) => ({ user: { id: user.id, email: user.email, nom: user.nom, role: user.role, langue: user.langue, langue2: user.langue2 }, compte: cid, entreprise: settings(cid).nom, stripe: !!settings(cid).stripe_secret, kadra: isKadra(user),
  voix: process.env.AZURE_SPEECH_KEY ? VOIX : null }));
// Voix de Kadra fabriquée par Azure Speech : une voix native par langue (accent turc pour le turc, marocain pour le darija…), la même sur tous les appareils.
// .env : AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (ex. francecentral). Sans clé : le navigateur lit avec les voix de l'appareil.
const VOIX = Object.fromEntries(Object.entries({ 'fr-FR': 'Denise Henri', 'pt-PT': 'Raquel Duarte', 'pt-BR': 'Francisca Antonio', 'es-ES': 'Elvira Alvaro', 'it-IT': 'Elsa Diego',
  'ar-MA': 'Mouna Jamal', 'ar-DZ': 'Amina Ismael', 'ar-TN': 'Reem Hedi', 'tr-TR': 'Emel Ahmet', 'ro-RO': 'Alina Emil', 'pl-PL': 'Zofia Marek', 'en-GB': 'Sonia Ryan',
  'de-DE': 'Katja Conrad', 'nl-NL': 'Fenna Maarten', 'uk-UA': 'Polina Ostap', 'ru-RU': 'Svetlana Dmitry', 'bg-BG': 'Kalina Borislav', 'sr-RS': 'Sophie Nicholas',
  'hr-HR': 'Gabrijela Srecko', 'sq-AL': 'Anila Ilir', 'zh-CN': 'Xiaoxiao Yunxi', 'vi-VN': 'HoaiMy NamMinh', 'ta-IN': 'Pallavi Valluvar' })
  .map(([l, n]) => [l, n.split(' ').map(x => `${l === 'sr-RS' ? 'sr-Latn-RS' : l}-${x}Neural`)])); // [femme, homme]
// Langue de l'interface : Claude traduit une fois les textes de app.js par langue, gardés dans i18n/<langue>.json.
// Public (l'écran de connexion se traduit aussi) ; borné aux langues connues, et seuls les textes manquants sont traduits.
const I18N = path.resolve('i18n'), traductionEnCours = {};
let textesUI;
on('GET', '/api/i18n/:code', ({ p }) => {
  if (!VOIX[p.code] || p.code === 'fr-FR') throw httpErr(404, 'Langue inconnue.');
  const fichier = path.join(I18N, p.code + '.json');
  const dict = fs.existsSync(fichier) ? JSON.parse(fs.readFileSync(fichier, 'utf8')) : {};
  textesUI ||= extraire(fs.readFileSync(path.join(PUBDIR, 'app.js'), 'utf8'));
  const manque = textesUI.filter(t => !(t in dict));
  if (manque.length && !traductionEnCours[p.code]) traductionEnCours[p.code] = traduireUI(p.code, fichier, manque).finally(() => delete traductionEnCours[p.code]);
  return { dict, reste: manque.length };
}, PUB);
async function traduireUI(code, fichier, manque) {
  const langue = new Intl.DisplayNames(['fr'], { type: 'language' }).of(code);
  const system = `Tu traduis l'interface de Kadra, une application web de devis, factures, chantiers et e-mails pour artisans du bâtiment, du français vers : ${langue}. Chaque élément est un texte de l'écran (bouton, titre, phrase, message, nom de rubrique).
Règles :
- {0}, {1}… sont des valeurs (nombres, montants, noms, dates, icônes) : garde-les tous tels quels, placés là où la phrase traduite les met.
- Garde la ponctuation de fin, les symboles (€, %, →, ✕, …) et les sigles français des documents (TVA, HT, TTC, SIRET, IBAN, FEC, RIB) ; « Kadra » ne se traduit pas.
- Langage simple d'appli grand public ; vouvoiement si la langue le distingue. Phrases courtes, comme l'original.
- Un nom de langue écrit dans sa propre langue (Türkçe, Español…) reste inchangé. Un élément qui n'est pas du texte (code, identifiant) reste inchangé.
Réponds avec t = la liste des traductions, dans le même ordre, exactement autant d'éléments que reçus.`;
  const paquets = [];
  for (let i = 0; i < manque.length; i += 150) paquets.push(manque.slice(i, i + 150));
  const lire = () => fs.existsSync(fichier) ? JSON.parse(fs.readFileSync(fichier, 'utf8')) : {};
  const marqueurs = s => (s.match(/\{\d+\}/g) || []).sort().join();
  const un = async lot => {
    const { t } = await askClaude(system, JSON.stringify(lot), S({ t: { type: 'array', items: str } }));
    if (t.length !== lot.length) throw new Error(`traduction ${code} : ${t.length} au lieu de ${lot.length}`);
    const dict = lire(); // ponytail: relu/écrit à chaque paquet (un seul processus) ; un verrou si plusieurs serveurs partagent i18n/
    lot.forEach((s, i) => { dict[s] = marqueurs(t[i]) === marqueurs(s) ? t[i] : s; });
    fs.mkdirSync(I18N, { recursive: true });
    fs.writeFileSync(fichier, JSON.stringify(dict, null, 1));
  };
  for (let i = 0; i < paquets.length; i += 4) {
    const r = await Promise.allSettled(paquets.slice(i, i + 4).map(un)); // 4 à la fois
    r.forEach(x => x.status === 'rejected' && console.error('Traduction de l’interface :', x.reason.message));
  }
}

const xmlEsc = s => String(s).replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`);
on('POST', '/api/voix', async ({ body }) => {
  if (!process.env.AZURE_SPEECH_KEY) throw httpErr(503, 'Voix du serveur non configurée.');
  const texte = String(body.texte || '').trim().slice(0, 800), voix = Object.values(VOIX).flat().find(v => v === body.voix) || VOIX['fr-FR'][0];
  if (!texte) throw httpErr(400, 'Rien à lire.');
  const lang = voix.split('-').slice(0, -1).join('-');
  const r = await fetch(`https://${process.env.AZURE_SPEECH_REGION || 'francecentral'}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'Kadra' },
    body: `<speak version="1.0" xml:lang="${lang}"><voice name="${voix}">${xmlEsc(texte)}</voice></speak>` });
  if (!r.ok) throw httpErr(502, `Voix indisponible (Azure ${r.status}).`);
  return { file: Buffer.from(await r.arrayBuffer()), type: 'audio/mpeg', name: 'kadra.mp3' };
});
on('PUT', '/api/me/langue', ({ user, body }) => {
  const l = String(body.langue || user.langue || 'fr-FR').slice(0, 10), l2 = body.langue2 === undefined ? user.langue2 : String(body.langue2 || '').slice(0, 10) || null;
  run('UPDATE users SET langue=?, langue2=? WHERE id=?', l, l2 === l ? null : l2, user.id); return { ok: true };
});
on('PUT', '/api/me/password', ({ user, body }) => {
  if (!checkPw(body.ancien, get('SELECT hash FROM users WHERE id=?', user.id).hash)) throw httpErr(400, 'Mot de passe actuel incorrect.');
  run('UPDATE users SET hash=? WHERE id=?', hashPw(validPw(body.nouveau)), user.id);
  return { ok: true };
});
on('GET', '/api/equipe', ({ cid }) => all('SELECT id, email, nom, role, created_at FROM users WHERE compte_id=? ORDER BY id', cid));
on('POST', '/api/equipe', ({ cid, user, body }) => {
  admin(user); validEmail(body.email); validPw(body.password);
  if (get('SELECT id FROM users WHERE email=?', body.email.trim())) throw httpErr(409, 'Cette adresse a déjà un compte.');
  run('INSERT INTO users (compte_id, email, nom, hash, role) VALUES (?,?,?,?,?)', cid, body.email.trim(), (body.nom || '').trim(), hashPw(body.password), body.role === 'admin' ? 'admin' : 'membre');
  return { ok: true };
});
on('DELETE', '/api/equipe/:id', ({ cid, user, p }) => {
  admin(user);
  if (+p.id === user.id) throw httpErr(400, 'Vous ne pouvez pas supprimer votre propre accès.');
  run('DELETE FROM users WHERE id=? AND compte_id=?', p.id, cid);
  return { ok: true };
});

on('GET', '/api/settings', ({ cid }) => masked(settings(cid)));
on('PUT', '/api/settings', ({ cid, body }) => {
  for (const k of SECRETS) if (body[k] === 'configuré') delete body[k];
  saveSettings(cid, body);
  return masked(settings(cid));
});
on('GET', '/api/dashboard', ({ cid }) => dashboard(cid));
on('GET', '/api/analyse', ({ cid }) => analyse(cid));
on('POST', '/api/ai/analyse', ({ cid }) => aiAnalyse(cid));

// ---------- Dépenses : justificatif, lecture du ticket par Claude ----------
on('GET', '/api/depenses/:id/justificatif', ({ cid, p }) => {
  const m = JUSTIF.exec(get('SELECT justificatif FROM depenses WHERE id=? AND compte_id=?', p.id, cid)?.justificatif || '');
  if (!m) throw httpErr(404, 'Pas de justificatif.');
  return { file: Buffer.from(m[2], 'base64'), type: m[1], name: `justificatif-${p.id}.${m[1].split('/')[1]}` };
});
const TICKET_SCHEMA = S({ date: str, fournisseur: str, libelle: str, categorie: { type: 'string', enum: Object.keys(CATEGORIES) }, ttc: num, tva: num });
const TICKET_SYSTEM = `Tu lis le ticket de caisse ou la facture d'un fournisseur d'un artisan du bâtiment en France (photo ou PDF). Rends :
- date : date d'achat au format AAAA-MM-JJ (chaîne vide si illisible) ;
- fournisseur : nom du magasin ou de l'entreprise (ex. « Point P », « Leroy Merlin », « Kiloutou ») ;
- libelle : ce qui a été acheté, 6 mots maximum, en français (ex. « Placo BA13 et rails ») ;
- categorie : materiaux (fournitures posées sur le chantier), sous_traitance (travaux faits par une autre entreprise), location (matériel loué), outillage (outils, petit matériel), carburant, autre ;
- ttc : total payé TTC en euros ; tva : montant total de TVA en euros (0 si aucune TVA n'est indiquée). Un avoir ou un remboursement est négatif.
N'invente rien : un montant illisible vaut 0.`;
on('POST', '/api/ai/ticket', async ({ body }) => {
  const m = JUSTIF.exec(body.justificatif || '');
  if (!m) throw httpErr(400, 'Photo ou PDF illisible.');
  const r = await askClaude(TICKET_SYSTEM, `Aujourd'hui : ${today()}.`, TICKET_SCHEMA, { type: m[1], data: m[2], nom: 'ticket' });
  return { ...r, date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '', ttc: r2(r.ttc), tva: r2(r.tva) };
});

// ---------- Import des anciens devis et factures (l'artisan change de logiciel : rien à retaper) ----------
// 1. Fichiers déposés ou PDF retrouvés dans ses e-mails envoyés → table imports. 2. Claude lit chaque fichier (2 à la fois).
// 3. Clients regroupés par nom, téléphone/e-mail manquants cherchés dans sa boîte. 4. L'artisan vérifie, puis tout entre d'un coup.
// Les factures gardent leur numéro d'origine (archivage légal dans l'ancien logiciel) et sont figées comme les autres.
const AAAAMMJJ = /^\d{4}-\d{2}-\d{2}$/;
const IMPORT_SCHEMA = S({ type: { type: 'string', enum: ['devis', 'facture', 'acompte', 'avoir', 'autre'] }, numero: str, date: str, echeance: str,
  client: S({ nom: str, adresse: str, email: str, tel: str }), objet: str, adresse_chantier: str, lignes: DEVIS_SCHEMA.properties.lignes,
  remise_pct: num, total_ht: num, total_ttc: num, signe: { type: 'boolean' }, paye: { type: 'boolean' } });
const importSystem = s => `Tu lis d'anciens devis ou d'anciennes factures d'un artisan du bâtiment en France (PDF ou photo), faits avec son ancien logiciel, Word ou Excel, pour les recopier tels quels dans son nouveau logiciel.${s.nom && s.nom !== DEFAULT_SETTINGS.nom ? ` Son entreprise : ${s.nom}${s.siret ? `, SIRET ${s.siret}` : ''}.` : ''}
Pour chaque document (chacun séparément, sans rien mélanger entre eux), rends :
- type : devis ; facture ; acompte (facture d'acompte) ; avoir ; autre (tout le reste : facture d'un fournisseur ou d'une autre entreprise adressée à l'artisan, bon de commande, plan, document illisible…).
- numero : le numéro du document, recopié exactement (chaîne vide s'il n'y en a pas).
- date ; echeance (fin de validité du devis, ou échéance de paiement de la facture) : AAAA-MM-JJ, chaîne vide si absente.
- client : le destinataire du document (nom tel qu'écrit avec la civilité ; adresse « rue\\ncode postal ville » ; e-mail et téléphone seulement s'ils sont écrits). Jamais les coordonnées de l'artisan.
- objet : l'objet ou le titre des travaux ; adresse_chantier : seulement si elle est écrite et différente de l'adresse du client.
- lignes : toutes les lignes, dans l'ordre, recopiées mot pour mot (désignation, description, quantité, unité, prix unitaire HT, taux de TVA en %). Un titre de lot ou de partie = type « section » (les autres champs vides ou 0). Une ligne de sous-total, de total ou de report n'est pas une ligne. Avoir : prix unitaires négatifs.
- remise_pct : remise globale en %, sinon 0.
- total_ht, total_ttc : les totaux écrits sur le document (négatifs pour un avoir).
- signe : devis signé par le client ou avec « bon pour accord » rempli. paye : facture marquée acquittée, payée ou réglée, sans reste à payer.
N'invente rien : un montant illisible vaut 0, un texte illisible est vide.`;
// PDF, photo, Word (.docx) ou Excel (.xlsx) : Word et Excel sont donnés à Claude en texte
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FICHIER_IMPORT = /^data:(application\/pdf|image\/(?:jpeg|png|webp)|application\/vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet));base64,([\w+/=]+)$/;
// Lignes du document lu. Devis au forfait (lignes sans prix, seul le total écrit) : une ligne « forfait » au montant écrit, le détail
// des travaux en description. Lignes en partie chiffrées dont la somme ≠ total écrit : une ligne pour l'écart (ecart: true → « à vérifier »).
// Le document importé vaut ainsi toujours le montant de l'original (CA, impayés, relances justes).
function lignesImport(r, s) {
  const avoir = r.type === 'avoir';
  const lignes = (r.lignes || []).map(l => (l.type === 'section' ? { type: 'section', designation: l.designation }
    : { type: 'ligne', designation: l.designation, description: l.description || '', qte: +l.qte || 0, unite: l.unite || 'u', pu: avoir && l.qte * l.pu > 0 ? -l.pu : +l.pu || 0, tva: Number.isFinite(+l.tva) ? +l.tva : s.tva_defaut }));
  const ht = r2(+r.total_ht || 0), rem = 1 - (+r.remise_pct || 0) / 100;
  const ecart = rem > 0 ? r2(ht / rem - lignes.reduce((t, l) => t + (l.type === 'section' ? 0 : r2(l.qte * l.pu)), 0)) : 0;
  if (!ht || Math.abs(ecart) < 0.05) return { lignes, ecart: false };
  const taux = (+r.total_ttc / ht - 1) * 100, tva = [0, 2.1, 5.5, 10, 20].find(t => Math.abs(t - taux) < 0.3) ?? s.tva_defaut;
  const chiffrees = lignes.filter(l => l.type !== 'section' && l.pu);
  const forfait = { type: 'ligne', designation: chiffrees.length ? 'Montant forfaitaire (document d’origine)' : r.objet || 'Travaux', description: '', qte: 1, unite: 'forfait', pu: ecart, tva };
  if (chiffrees.length) return { lignes: [...lignes, forfait], ecart: true };
  forfait.description = lignes.map(l => [l.designation, l.description].filter(Boolean).join(' – ')).filter(Boolean).join('\n');
  return { lignes: [forfait], ecart: false };
}
const lecteurs = new Map(), scans = new Set(), arrets = new Map(); // comptes → nombre de lecteurs en cours / de recherche dans la boîte ; arrêt (Claude non connecté, limite…)
function ajouterImport(cid, { nom, fichier, source = 'fichier', email_a = '' }) {
  const m = FICHIER_IMPORT.exec(fichier || '');
  if (!m) throw httpErr(400, 'Fichier illisible : PDF, photo, Word (.docx) ou Excel (.xlsx). Un ancien .doc ou .xls : enregistrez-le d’abord en PDF.');
  return Number(run('INSERT OR IGNORE INTO imports (compte_id, nom, fichier, empreinte, source, email_a) VALUES (?,?,?,?,?,?)', cid, String(nom || 'document').slice(0, 200), fichier,
    crypto.createHash('sha256').update(m[2]).digest('hex'), source, email_a).changes);
}
// Lecture par lots : 4 fichiers par appel à Claude (le lancement de Claude Code et les allers-retours sont partagés : ~8 s par fichier au lieu de 17),
// 5 lots en même temps. Un lot qui échoue, ou un fichier oublié dans la réponse : relu seul.
const LOT = 4, LOT_TAILLE = 15e6, LECTEURS = 5;
const IMPORT_LOT = S({ docs: { type: 'array', items: S({ fichier: str, ...IMPORT_SCHEMA.properties }) } });
const LIMITE = e => [503, 429].includes(e.status);
async function lireLot(s, lot) {
  const fichiers = [], textes = [], t0 = Date.now();
  lot.forEach((i, k) => {
    const m = FICHIER_IMPORT.exec(i.fichier), nom = `doc${k + 1}`, b = () => Buffer.from(m[2], 'base64');
    const texte = m[1] === DOCX ? `Document Word (texte ; tableaux : une ligne par rangée, cellules séparées par « | ») :\n${docxTexte(b())}`
      : m[1] === XLSX ? `Feuille Excel (tableau HTML) :\n${xlsxToHtml(b()).replace(/<style[\s\S]*?<\/style>|\s(style|class)="[^"]*"/g, '')}` : '';
    if (texte) textes.push(`--- ${nom} ---\n${texte.slice(0, 80000)}`);
    else fichiers.push({ type: m[1], data: m[2], nom });
  });
  const consigne = `${lot.length > 1 ? `${lot.length} documents, à lire chacun séparément` : '1 document'} : ${lot.map((i, k) => `doc${k + 1} (fichier d'origine « ${i.nom} »)`).join(', ')}.
${fichiers.length > 1 ? 'Ouvre tous les fichiers en une seule fois. ' : ''}Rends un élément de docs par document, avec fichier = doc1, doc2… Aujourd'hui : ${today()}.${textes.length ? '\n\n' + textes.join('\n\n') : ''}`;
  const { docs } = await askClaude(importSystem(s), consigne, IMPORT_LOT, fichiers.length ? fichiers : undefined, null, { rapide: true });
  const lus = new Map();
  for (const { fichier, ...r } of docs || []) { const i = lot[+(/doc(\d+)/.exec(fichier)?.[1]) - 1]; if (i && !lus.has(i.id)) lus.set(i.id, r); }
  console.log(`Import : ${lus.size}/${lot.length} fichiers lus en ${Math.round((Date.now() - t0) / 1000)} s (${fichiers.length} PDF/photos, ${textes.length} Word/Excel)`);
  return lus;
}
// Chaque appel (nouveau fichier envoyé, « relire »…) complète jusqu'à LECTEURS lecteurs : un lecteur qui trouve la file vide s'arrête,
// le fichier suivant en relance un (avant : un seul lecteur restait pour tous les fichiers envoyés après le premier).
async function lireImports(cid) {
  const n = lecteurs.get(cid) || 0;
  if (n >= LECTEURS) return;
  if (!n) arrets.delete(cid);
  lecteurs.set(cid, LECTEURS);
  const s = settings(cid);
  const prendre = () => { // sans await entre la lecture et la mise à jour : un fichier n'est jamais pris par deux lecteurs
    const lot = []; let taille = 0;
    for (const i of all("SELECT id, nom, fichier FROM imports WHERE compte_id=? AND etat='attente' ORDER BY id LIMIT ?", cid, LOT)) {
      if (lot.length && taille + i.fichier.length > LOT_TAILLE) break;
      lot.push(i); taille += i.fichier.length;
    }
    lot.forEach(i => run("UPDATE imports SET etat='lecture' WHERE id=?", i.id));
    return lot;
  };
  const lire = async lot => {
    let lus = new Map(), err;
    try { lus = await lireLot(s, lot); } catch (e) { if (LIMITE(e)) throw e; err = e; console.error(`Import : lot de ${lot.length} en échec (${e.message})`); }
    for (const i of lot) {
      if (lus.has(i.id)) run("UPDATE imports SET etat='lu', resultat=?, erreur=NULL WHERE id=?", JSON.stringify(lus.get(i.id)), i.id);
      else if (lot.length > 1) await lire([i]);
      else run("UPDATE imports SET etat='erreur', erreur=? WHERE id=?", String(err?.message || 'Kadra n’a pas su lire ce document.').slice(0, 300), i.id);
    }
  };
  const lecteur = async () => {
    try {
      for (let lot; !arrets.has(cid) && (lot = prendre()).length;) {
        try { await lire(lot); } catch (e) { // limite de l'abonnement, Claude non connecté : on reprendra plus tard
          lot.forEach(i => run("UPDATE imports SET etat='attente' WHERE id=? AND etat='lecture'", i.id)); arrets.set(cid, e.message);
        }
      }
    } finally { lecteurs.set(cid, lecteurs.get(cid) - 1); }
  };
  await Promise.all(Array.from({ length: LECTEURS - n }, lecteur));
  if (lecteurs.get(cid)) return; // d'autres lecteurs tournent encore : le dernier cherchera les contacts
  lecteurs.delete(cid);
  await contactsBoite(cid).catch(e => console.error('Import, contacts :', e.message));
}
// Les PDF joints aux e-mails envoyés depuis 2 ans (devis et factures envoyés aux clients avec l'ancien logiciel)
const NOM_DOC = /dev|fact|fac[\s_-]?\d|avoir|av[\s_-]?\d|quote|invoice/i;
async function pdfsBoite(cid) {
  const s = settings(cid);
  const imap = new ImapFlow(imapOpts(s));
  let n = 0;
  try {
    await imap.connect();
    const envoyes = (await imap.list()).find(b => b.specialUse === '\\Sent');
    if (!envoyes) throw httpErr(400, 'Dossier des e-mails envoyés introuvable dans votre boîte.');
    const lock = await imap.getMailboxLock(envoyes.path);
    try {
      const uids = (await imap.search({ since: new Date(Date.now() - 730 * 864e5) }, { uid: true })) || [], trouves = [];
      if (uids.length) for await (const m of imap.fetch(uids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
        const pj = m.bodyStructure ? piecesDe(m.bodyStructure).filter(x => (x.type === 'application/pdf' || /\.pdf$/i.test(nomPj(x))) && NOM_DOC.test(nomPj(x))) : [];
        if (pj.length) trouves.push({ uid: m.uid, pj, a: (m.envelope.to?.[0]?.address || '').toLowerCase() });
      }
      // ponytail: 600 e-mails au plus (les plus récents) ; relancer la recherche ne reprend pas les fichiers déjà là (empreinte)
      for (const { uid, pj, a } of trouves.slice(-600)) {
        const r = await imap.downloadMany(uid, pj.map(x => x.part), { uid: true });
        for (const x of pj) if (r[x.part]?.content) n += ajouterImport(cid, { nom: nomPj(x), fichier: 'data:application/pdf;base64,' + r[x.part].content.toString('base64'), source: 'mail', email_a: a });
      }
    } finally { lock.release(); }
  } finally { await imap.logout().catch(() => {}); }
  return n;
}
// Clients des documents lus, regroupés par nom (sans la civilité), comparés à ceux déjà dans Kadra et complétés par la boîte mail.
const CIVILITE = /^((m|mr|mme|mlle|madame|monsieur|mademoiselle)\.?\s+)+/i;
const cleNom = n => sansAccent(String(n || '').replace(CIVILITE, '').replace(/[^\p{L}\p{N}]+/gu, ' '));
const importsLus = cid => all("SELECT id, nom, source, email_a, etat, resultat, erreur FROM imports WHERE compte_id=? AND etat='lu' ORDER BY id", cid).map(i => ({ ...i, resultat: JSON.parse(i.resultat) }))
  .filter(i => i.resultat.type !== 'autre');
function propositions(cid, lus = importsLus(cid)) {
  const contacts = settings(cid).import_contacts || {}, clients = all('SELECT id, nom, adresse, email, tel FROM clients WHERE compte_id=?', cid), par = new Map();
  for (const i of lus) {
    const c = i.resultat.client, cle = cleNom(c?.nom);
    if (!cle) continue;
    const p = par.get(cle) || { cle, nom: c.nom.trim(), adresse: '', email: '', tel: '', docs: 0 };
    p.adresse ||= c.adresse || ''; p.email ||= (c.email || '').trim().toLowerCase(); p.tel ||= c.tel || ''; p.docs++;
    if (!p.email && i.source === 'mail') p.envoye_a = i.email_a; // envoyé par e-mail à cette adresse : le plus souvent le client
    par.set(cle, p);
  }
  return [...par.values()].map(({ envoye_a, ...p }) => {
    const t = contacts[p.cle], email = p.email || t?.email || envoye_a || '', tel = p.tel || t?.tel || '';
    const ex = clients.find(k => cleNom(k.nom) === p.cle || (email && k.email?.toLowerCase() === email));
    const vu = [!p.tel && t?.tel && 'téléphone', !p.email && t?.email && 'e-mail'].filter(Boolean);
    return { ...p, email, tel, existe: ex?.id || null, mail: vu.length ? `${vu.join(' et ')} retrouvé${vu.length > 1 ? 's' : ''} dans un e-mail de ${t.de}` : '' };
  });
}
// Téléphone et e-mail des nouveaux clients, d'après le dernier e-mail reçu d'eux (signature). Une seule recherche par client.
const TEL = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g;
const chiffresTel = t => String(t).replace(/\D/g, '').replace(/^33/, '0');
async function contactsBoite(cid) {
  const s = settings(cid);
  if (!s.imap_host || !s.imap_user || !s.imap_pass) return;
  const deja = { ...s.import_contacts }, a_chercher = propositions(cid).filter(p => !p.existe && (!p.tel || !p.email) && !(p.cle in deja)).slice(0, 200);
  if (!a_chercher.length) return;
  const imap = new ImapFlow(imapOpts(s)), moi = chiffresTel(s.tel);
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX');
    try {
      for (const p of a_chercher) {
        const mot = p.email || p.cle.split(' ').sort((a, b) => b.length - a.length)[0]; // le mot le plus long du nom (souvent le nom de famille)
        deja[p.cle] = null;
        if (!mot || mot.length < 3) continue;
        const uid = ((await imap.search({ from: mot }, { uid: true })) || []).at(-1);
        if (!uid) continue;
        const m = await imap.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true }), de = m.envelope.from?.[0];
        if (!de || !sansAccent(`${de.name} ${de.address}`).includes(sansAccent(mot))) continue; // le mot doit être dans l'expéditeur
        const part = m.bodyStructure && (textPart(m.bodyStructure) || textPart(m.bodyStructure, 'text/html'));
        let corps = '';
        if (part) {
          const r = await imap.downloadMany(uid, [part.part || '1'], { uid: true });
          corps = r[part.part || '1']?.content?.toString('utf8') || '';
          if (part.type === 'text/html') corps = htmlText(corps);
        }
        const tel = (sansCitation(corps).match(TEL) || []).find(t => chiffresTel(t) !== moi) || '';
        deja[p.cle] = { email: String(de.address || '').toLowerCase(), tel, de: de.name ? `${de.name} (${de.address})` : de.address };
      }
    } finally { lock.release(); }
  } finally {
    saveSettings(cid, { import_contacts: deja });
    await imap.logout().catch(() => {});
  }
}
// État de l'import pour la page : progression, clients proposés, documents lus avec le choix proposé par défaut.
function etatImports(cid) {
  const s = settings(cid), n = Object.fromEntries(all('SELECT etat, COUNT(*) n FROM imports WHERE compte_id=? GROUP BY etat', cid).map(r => [r.etat, r.n]));
  const lus = importsLus(cid), vieux = d => !d || daysSince(d) > 60;
  // « Devis - 052 », « 052 » et « DEV052 » = le même numéro (mots, signes et zéros de tête ignorés) ; déjà dans Kadra = doublon
  const cleNum = (type, n) => { const k = String(n || '').toLowerCase().replace(/factures?|devis|avoirs?|fac|dev|n°/g, '').replace(/[^\p{L}\p{N}]/gu, '').replace(/^0+(?=.)/, ''); return k && `${type === 'devis' ? 'D' : 'F'}:${k}`; };
  const vus = new Set(all('SELECT type, numero FROM documents WHERE compte_id=? AND numero IS NOT NULL', cid).map(d => cleNum(d.type, d.numero)));
  const factures = lus.filter(i => i.resultat.type !== 'devis');
  // même numéro dans plusieurs fichiers (copies, version PDF + Word) : la version la plus complète (total écrit, puis nombre de lignes) est gardée
  const complet = r => [Math.abs(+r.total_ttc || 0), r.lignes?.length || 0];
  const ordre = [...lus].sort((a, b) => { const [x, y] = [complet(a.resultat), complet(b.resultat)]; return y[0] - x[0] || y[1] - x[1] || a.id - b.id; });
  const docs = ordre.map(({ id, nom, resultat: r }) => {
    const cle = cleNum(r.type, r.numero), doublon = !!cle && vus.has(cle);
    if (cle) vus.add(cle);
    // devis : signé s'il porte la signature ou si le même client a une facture après ; sans réponse depuis 2 mois = sans suite
    const facturé = factures.some(f => cleNom(f.resultat.client?.nom) === cleNom(r.client?.nom) && (f.resultat.date || '') >= (r.date || ''));
    const defaut = r.type === 'devis' ? (r.signe || facturé ? 'accepte' : vieux(r.date) ? 'refuse' : 'envoye')
      : r.type === 'avoir' ? '' : r.paye || vieux(AAAAMMJJ.test(r.echeance) ? r.echeance : r.date) ? 'payee' : 'a_payer';
    const { lignes, ecart } = lignesImport(r, s), ttc_calc = totaux({ ...r, lignes }, s.franchise_tva).ttc;
    return { id, nom, type: r.type, numero: r.numero, date: r.date, client: r.client?.nom || '', objet: r.objet, ttc: r2(r.total_ttc), ttc_calc, ecart: ecart || !ttc_calc, defaut, doublon };
  });
  return {
    n, lecture: lecteurs.has(cid), boite: scans.has(cid), arret: arrets.get(cid) || '', imap: !!(s.imap_host && s.imap_user && s.imap_pass),
    docs: docs.filter(d => !d.doublon).sort((a, b) => a.id - b.id), doublons: docs.filter(d => d.doublon).length, clients: propositions(cid, lus),
    erreurs: all("SELECT id, nom, erreur FROM imports WHERE compte_id=? AND etat='erreur' ORDER BY id", cid),
    autres: all("SELECT id, nom FROM imports WHERE compte_id=? AND etat='lu' AND resultat->>'type'='autre' ORDER BY id", cid),
  };
}
// Validation : clients gardés (complète les fiches existantes sans rien écraser), documents copiés avec le choix de l'artisan. Tout ou rien.
function validerImports(cid, { choix = {}, refuses = [] }) {
  const s = settings(cid), lus = importsLus(cid), props = propositions(cid, lus), ids = new Map(), { docs } = etatImports(cid);
  const out = { devis: 0, factures: 0, clients: 0, sautes: [] };
  db.exec('BEGIN');
  try {
    for (const p of props) {
      if (refuses.includes(p.cle) || !lus.some(i => cleNom(i.resultat.client?.nom) === p.cle && docs.some(d => d.id === i.id && choix[i.id] !== 'ignore'))) continue;
      if (p.existe) run("UPDATE clients SET adresse=COALESCE(NULLIF(adresse,''),?), email=COALESCE(NULLIF(email,''),?), tel=COALESCE(NULLIF(tel,''),?) WHERE id=? AND compte_id=?", p.adresse, p.email, p.tel, p.existe, cid);
      else out.clients++;
      ids.set(p.cle, p.existe || Number(run('INSERT INTO clients (compte_id, nom, adresse, email, tel) VALUES (?,?,?,?,?)', cid, p.nom, p.adresse, p.email, p.tel).lastInsertRowid));
    }
    for (const d of docs) {
      const r = lus.find(i => i.id === d.id).resultat, c = choix[d.id] || d.defaut;
      if (c === 'ignore') { run("UPDATE imports SET etat='ignore' WHERE id=?", d.id); continue; }
      const facture = r.type !== 'devis', kind = { acompte: 'acompte', avoir: 'avoir' }[r.type] || 'standard';
      const numero = String(r.numero || '').trim().slice(0, 60) || (facture ? `IMPORT-${d.id}` : null); // une facture a toujours un numéro (sinon elle resterait modifiable)
      if (numero && get('SELECT 1 FROM documents WHERE compte_id=? AND numero=?', cid, numero)) { out.sautes.push(numero); run("UPDATE imports SET etat='doublon' WHERE id=?", d.id); continue; }
      const p = props.find(x => x.cle === cleNom(r.client?.nom)), date = AAAAMMJJ.test(r.date) ? r.date : today();
      const { lignes } = lignesImport(r, s);
      const data = { client: { nom: r.client?.nom || '', adresse: r.client?.adresse || p?.adresse || '', email: p?.email || r.client?.email || '', tel: p?.tel || r.client?.tel || '' },
        objet: r.objet || '', adresse_chantier: r.adresse_chantier || '', remise_pct: +r.remise_pct || 0, acompte_pct: 0, notes: '', lignes, importe: { fichier: d.nom, le: today() } };
      const t = totaux(data, s.franchise_tva), maintenant = new Date().toISOString();
      const echeance = AAAAMMJJ.test(r.echeance) ? r.echeance : addDays(date, facture ? s.delai_paiement_jours : s.validite_jours);
      const statut = facture ? 'envoyee' : ['envoye', 'accepte', 'refuse'].includes(c) ? c : 'envoye';
      // derniere_relance = maintenant : une relance automatique (devis en attente, facture pas payée) attend le délai habituel, jamais le jour de l'import
      const id = Number(run(`INSERT INTO documents (compte_id, type, kind, numero, client_id, statut, date, echeance, data, total_ht, total_ttc, token, template_id, envoye_le, derniere_relance)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cid, facture ? 'facture' : 'devis', kind, numero, p && ids.get(p.cle) || null, statut, date, echeance, JSON.stringify(data),
        t.ht, t.ttc, crypto.randomBytes(24).toString('hex'), s.template_id, date, maintenant).lastInsertRowid);
      if (facture && kind !== 'avoir' && c !== 'a_payer' && t.ttc > 0) run('INSERT INTO payments (compte_id, document_id, montant, date, mode, note) VALUES (?,?,?,?,?,?)', cid, id, t.ttc, echeance < today() ? echeance : date, '', 'Réglée avant Kadra');
      run("UPDATE imports SET etat='importe', document_id=? WHERE id=?", id, d.id);
      out[facture ? 'factures' : 'devis']++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // nouveaux clients : la boîte mail est relue sur 90 jours pour ranger leurs anciens e-mails (déjà lus : ils ne sont pas nouveaux)
  if (out.clients && settings(cid).imap_host) {
    saveSettings(cid, { imap_etat: {} });
    releverBoite(cid).then(() => run("UPDATE emails SET lu=1 WHERE compte_id=? AND sens='recu' AND created_at < datetime('now', '-2 days')", cid)).catch(e => console.error('Import, e-mails :', e.message));
  }
  return out;
}
on('GET', '/api/imports', ({ cid }) => etatImports(cid));
on('POST', '/api/imports', ({ cid, body }) => { // lecture 2 s après : les fichiers déposés ensemble partent en lots complets
  const n = ajouterImport(cid, body); setTimeout(() => lireImports(cid).catch(console.error), 2000); return { ajoute: n };
});
on('POST', '/api/imports/lire', ({ cid }) => { lireImports(cid).catch(console.error); return { ok: true }; });
on('POST', '/api/imports/boite', ({ cid }) => {
  const s = settings(cid);
  if (!s.imap_host || !s.imap_user || !s.imap_pass) throw httpErr(400, 'Branchez d’abord votre boîte mail (Paramètres, Automatismes).');
  if (!scans.has(cid)) {
    scans.add(cid); arrets.delete(cid);
    pdfsBoite(cid).catch(e => arrets.set(cid, 'Boîte mail : ' + (e.authenticationFailed ? 'identifiant ou mot de passe refusé' : e.message))).finally(() => { scans.delete(cid); lireImports(cid).catch(console.error); });
  }
  return { ok: true };
});
on('POST', '/api/imports/valider', ({ cid, body }) => validerImports(cid, body));
on('PUT', '/api/imports/:id', ({ cid, p, body }) => { // relire (attente) ou ne pas importer (ignore)
  if (!['attente', 'ignore'].includes(body.etat)) throw httpErr(400, 'État inconnu.');
  if (!run("UPDATE imports SET etat=? WHERE id=? AND compte_id=? AND etat IN ('lu','erreur','ignore')", body.etat, p.id, cid).changes) throw httpErr(404, 'Introuvable');
  if (body.etat === 'attente') lireImports(cid).catch(console.error);
  return { ok: true };
});
// PDF et photos s'ouvrent dans le navigateur ; Word et Excel se téléchargent
const fichierImport = (i, nom) => { const m = FICHIER_IMPORT.exec(i?.fichier || ''); if (!m) throw httpErr(404, 'Introuvable'); return { file: Buffer.from(m[2], 'base64'), type: m[1], name: String(nom || 'original').replace(/[^\w.\- ]/g, '_'), attachment: !SURS.includes(m[1]) }; };
on('GET', '/api/imports/:id/fichier', ({ cid, p }) => { const i = get('SELECT nom, fichier FROM imports WHERE id=? AND compte_id=?', p.id, cid); return fichierImport(i, i?.nom); });
on('GET', '/api/documents/:id/original', ({ cid, p }) => { const i = get('SELECT nom, fichier FROM imports WHERE document_id=? AND compte_id=?', p.id, cid); return fichierImport(i, i?.nom); });
run("UPDATE imports SET etat='attente' WHERE etat='lecture'"); // serveur arrêté pendant une lecture : on reprend
setTimeout(() => all("SELECT DISTINCT compte_id FROM imports WHERE etat='attente'").forEach(r => lireImports(r.compte_id).catch(console.error)), 8000);

// ---------- Pour le comptable : factures, règlements, dépenses (CSV pour Excel) et écritures au format FEC ----------
const jjmmaaaa = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
// Excel en français : « ; », virgule décimale, BOM UTF-8. Un texte qui commence par = + - @ est neutralisé (pas de formule).
const csvCell = v => {
  if (typeof v === 'number') return String(r2(v)).replace('.', ',');
  const s = String(v ?? '').replace(/^[=+\-@]/, "'$&");
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = rows => Buffer.from('﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n'), 'utf8');
// FEC (art. A47 A-1 du LPF) : 18 colonnes, tabulations, ISO 8859-15 (ici latin-1 : « € » écrit EUR), dates AAAAMMJJ.
const latin = s => Buffer.from(s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/€/g, 'EUR').replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/[^\x00-\xff]/g, '?'), 'latin1');
const FEC_COLS = ['JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib', 'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit', 'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise'];
const JOURNAUX = { VT: 'Ventes', BQ: 'Banque', CA: 'Caisse', AC: 'Achats' };
const KIND_LIB = { avoir: 'Avoir', acompte: 'Facture d’acompte', situation: 'Situation de travaux' };
function exportCompta(cid, quoi, du, au) {
  if (![du, au].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d || '')) || du > au) throw httpErr(400, 'Période invalide.');
  const s = settings(cid);
  const factures = all(`SELECT * FROM (${scoped('documents', cid)}) WHERE type='facture' AND numero IS NOT NULL AND date BETWEEN ? AND ? ORDER BY date, numero`, du, au)
    .map(f => ({ ...f, client_nom: f.client_nom || f.data.client?.nom || '' }));
  const paiements = all(`SELECT p.date, p.montant, p.mode, p.note, d.numero, d.client_id, COALESCE(c.nom, json_extract(d.data, '$.client.nom')) client_nom FROM payments p
    JOIN documents d ON d.id=p.document_id LEFT JOIN clients c ON c.id=d.client_id WHERE p.compte_id=? AND p.date BETWEEN ? AND ? ORDER BY p.date, p.id`, cid, du, au);
  const depenses = all(`SELECT * FROM (${scoped('depenses', cid)}) WHERE date BETWEEN ? AND ? ORDER BY date, id`, du, au);
  const nom = ext => `${quoi}_${du}_${au}.${ext}`, CSV = 'text/csv; charset=utf-8';
  if (quoi === 'factures') {
    const tv = f => totaux(f.data, s.franchise_tva).tva;
    const taux = [...new Set(factures.flatMap(f => tv(f).map(b => b.taux)))].sort((a, b) => a - b);
    return { file: csv([['Date', 'Numéro', 'Type', 'Client', 'SIRET du client', 'Objet', 'Total HT', ...taux.map(x => `TVA ${String(x).replace('.', ',')} %`), 'Total TTC', 'Réglé à ce jour', 'Reste à payer', 'Échéance', 'Facture d’origine'],
      ...factures.map(f => [jjmmaaaa(f.date), f.numero, KIND_LIB[f.kind] || 'Facture', f.client_nom, f.data.client?.siret || '', f.data.objet || '', f.total_ht, ...taux.map(x => tv(f).find(b => b.taux === x)?.montant || 0), f.total_ttc,
        ...(f.kind === 'avoir' ? ['', ''] : [f.regle, r2(f.total_ttc - f.regle)]), jjmmaaaa(f.echeance), f.parent_numero || ''])]), type: CSV, name: nom('csv'), attachment: true };
  }
  if (quoi === 'reglements') return { file: csv([['Date', 'Facture', 'Client', 'Mode', 'Montant', 'Note'], ...paiements.map(p => [jjmmaaaa(p.date), p.numero, p.client_nom || '', p.mode || '', p.montant, p.note || ''])]), type: CSV, name: nom('csv'), attachment: true };
  if (quoi === 'depenses') return { file: csv([['Date', 'Fournisseur', 'Achat', 'Catégorie', 'Chantier', 'HT', 'TVA', 'TTC', 'Justificatif'],
    ...depenses.map(d => [jjmmaaaa(d.date), d.fournisseur || '', d.libelle || '', (CATEGORIES[d.categorie] || CATEGORIES.autre)[0], d.chantier_nom || '', d.ht, d.tva, d.ttc, d.justif ? 'oui' : 'non'])]), type: CSV, name: nom('csv'), attachment: true };
  if (quoi === 'fec') {
    const n = x => x.toFixed(2).replace('.', ','), dt = d => String(d || '').slice(0, 10).replaceAll('-', ''), net = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
    const lignes = ecritures({ factures, paiements, depenses, franchise: s.franchise_tva }).flatMap(e => e.lignes.map(l =>
      [e.journal, JOURNAUX[e.journal], e.num, dt(e.date), l.compte, l.lib, l.aux, l.auxLib, e.piece, dt(e.date), l.texte || e.lib, n(l.debit), n(l.credit), '', '', dt(e.date), '', ''].map(net).join('\t')));
    const siren = String(s.siret || '').replace(/\D/g, '').slice(0, 9) || '000000000';
    return { file: latin([FEC_COLS.join('\t'), ...lignes].join('\r\n') + '\r\n'), type: 'text/plain; charset=iso-8859-1', name: `${siren}FEC${dt(au)}.txt`, attachment: true };
  }
  throw httpErr(404, 'Export inconnu.');
}
on('GET', '/api/export/:quoi', ({ cid, p, q }) => exportCompta(cid, p.quoi, q.du, q.au));
on('GET', '/api/placeholders', () => PLACEHOLDERS);
on('GET', '/api/emails', ({ cid, q }) => all(`SELECT * FROM emails WHERE compte_id=? AND sens='envoye' ${q.chantier_id ? 'AND chantier_id=?' : q.document_id ? 'AND document_id=?' : ''} ORDER BY id DESC LIMIT 200`, cid, ...[q.chantier_id || q.document_id].filter(Boolean)));
const clientEmails = (c, cid) => all(`SELECT e.*, ${PIECES} FROM emails e WHERE compte_id=? AND (client_id=? OR (a<>'' AND a=? COLLATE NOCASE) OR document_id IN (SELECT id FROM documents WHERE client_id=?)
  OR chantier_id IN (SELECT id FROM chantiers WHERE client_id=?)) ORDER BY created_at DESC, id DESC`, cid, c.id, c.email || '', c.id, c.id);
on('GET', '/api/clients/:id/emails', ({ cid, p }) => clientEmails(own('clients', p.id, cid), cid));
on('POST', '/api/clients/:id/email', async ({ cid, p, body }) => {
  const c = own('clients', p.id, cid);
  if (!body.sujet?.trim() || !body.corps?.trim()) throw httpErr(400, 'Objet et message obligatoires.');
  const orig = body.reponse_a && get('SELECT message_id FROM emails WHERE id=? AND compte_id=?', body.reponse_a, cid);
  return { statut: await sendMail(cid, { to: c.email, sujet: body.sujet, corps: body.corps, client_id: c.id, reponseA: orig?.message_id?.startsWith('<') ? orig.message_id : null }) };
});
on('POST', '/api/clients/:id/brouillon', ({ cid, p, body, user }) => aiMail(body, own('clients', p.id, cid), user, cid));
on('GET', '/api/compteurs', ({ cid }) => compteurs(cid));
on('GET', '/api/mails', ({ cid }) => all(`${MAILS} ORDER BY x.created_at DESC, x.id DESC LIMIT 2000`, cid));
on('POST', '/api/mails/lus', ({ cid, body }) => { // ids : une conversation ouverte ; sans ids : tout
  if (Array.isArray(body?.ids)) for (const id of body.ids) run('UPDATE emails SET lu=1 WHERE compte_id=? AND id=?', cid, Number(id));
  else run('UPDATE emails SET lu=1 WHERE compte_id=? AND lu=0', cid);
  return { ok: true };
});
// Un e-mail → rendez-vous pré-rempli par Claude (rien n'est enregistré : le pro relit puis valide).
on('POST', '/api/emails/:id/rdv', async ({ cid, p }) => {
  const m = get(`${MAILS} WHERE x.id=?`, cid, p.id) || (() => { throw httpErr(404, 'E-mail introuvable'); })();
  const [r] = await extraireRdv([m], cid);
  return r ? { ...r, trouve: true } : { titre: '', client_id: m.cli, email_id: m.id, trouve: false };
});
on('POST', '/api/rdv/chercher', async ({ cid }) => ({ trouves: await chercherRdv(cid) }));
on('GET', '/api/agenda/lien', ({ cid }) => {
  let t = settings(cid).ics_token;
  if (!t) saveSettings(cid, { ics_token: (t = crypto.randomBytes(24).toString('hex')) });
  return { url: `${PUBLIC_URL}/ics/${t}.ics` };
});
on('GET', '/ics/:token', ({ p }) => {
  const t = /^([a-f0-9]{48})\.ics$/.exec(p.token)?.[1], c = t && get("SELECT id FROM comptes WHERE json_extract(settings, '$.ics_token')=?", t);
  if (!c) throw httpErr(404, 'Agenda introuvable');
  return { file: Buffer.from(ics(c.id)), type: 'text/calendar; charset=utf-8', name: 'kadra.ics' };
}, PUB);
// Pièce jointe reçue : seuls PDF et images s'ouvrent dans le navigateur ; le reste est téléchargé (jamais de HTML servi depuis notre site).
const SURS = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
on('GET', '/api/pieces/:id', ({ cid, p }) => {
  const f = get('SELECT * FROM pieces WHERE id=? AND compte_id=?', p.id, cid) || (() => { throw httpErr(404, 'Pièce jointe introuvable'); })();
  return { file: Buffer.from(f.data), type: SURS.includes(f.type) ? f.type : 'application/octet-stream', name: String(f.nom).normalize('NFD').replace(/[^\w.\- ()]/g, '_') };
});
on('POST', '/api/boite/relever', async ({ cid }) => ({ nouveaux: await releverBoite(cid) }));
on('GET', '/api/resume', ({ cid }) => resumeTexte(cid) || { n: 0 });
on('POST', '/api/relances', ({ cid }) => relances(cid));
// live : réponse en NDJSON, {html} à chaque étape de la rédaction puis {id} (ou {error}).
on('POST', '/api/ai/devis', async ({ cid, body, user, res }) => {
  const params = { ...body, lang: user.langue || settings(cid).langue };
  if (!body.live) return aiDevis(params, cid);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  const ligne = o => res.write(JSON.stringify(o) + '\n');
  try { const r = await aiDevis(params, cid, html => ligne({ html })); ligne(body.apercu ? { html: r.html } : { id: r.id }); }
  catch (e) { if (!e.status || e.status >= 500) console.error(e); ligne({ error: e.status ? e.message : 'L’IA n’a pas pu rédiger le devis : réessayez.' }); }
  res.end();
});
// Devis en 3 gammes : le devis actuel devient « Confort », Kadra rédige « Essentiel » et « Premium » ; le client choisit sur sa page en ligne.
// data.gammes = [{ nom, lignes }] ; data.gamme = gamme affichée ; data.lignes = toujours les lignes de cette gamme (factures, chantier, PDF n'en savent rien).
const GAMMES_SCHEMA = S({ essentiel: DEVIS_SCHEMA.properties.lignes, premium: DEVIS_SCHEMA.properties.lignes, questions: { type: 'array', items: str } });
const GAMMES_SYSTEM = `Tu prépares deux variantes du devis d'un artisan du bâtiment en France, pour que son client choisisse entre 3 gammes : Essentiel (moins cher), Confort (le devis fourni, qui ne change pas) et Premium (haut de gamme).

Règles :
- Mêmes travaux, même ordre, mêmes sections, mêmes quantités. Ce qui change : la gamme des fournitures et des finitions (ex. faïence standard → grès cérame grand format rectifié ; mitigeur simple → thermostatique ; peinture acrylique → velours lessivable haut de gamme ; WC posé → WC suspendu).
- Essentiel : fournitures d'entrée de gamme correctes ; tu peux retirer une option de confort non indispensable, jamais un travail nécessaire ni les lignes de protection, d'évacuation des gravats ou de nettoyage.
- Premium : fournitures haut de gamme ; tu peux ajouter 1 à 3 lignes de confort utiles pour ce chantier (ex. niche murale, sèche-serviettes, éclairage LED, robinetterie encastrée).
- Main-d'œuvre : même prix, sauf si la gamme change vraiment le travail (pose grand format, encastrement).
- Prix HT : pars des prix du devis et ajuste de façon réaliste pour le marché français (en général Essentiel 15 à 25 % moins cher au total, Premium 25 à 50 % plus cher). Si la prestation est au catalogue ou dans les devis passés de l'artisan, reprends son prix.
- Désignation et description : dis concrètement ce qui change (matériau, format, finition), sans nom de marque. Écris comme l'artisan (habitudes ci-dessous). TVA : celle de la ligne d'origine.
- questions : 2 au plus, courtes (250 caractères au plus chacune). La 1re liste les principaux prix que tu as estimés toi-même, pour que l'artisan les vérifie (ex. « Prix estimés par Kadra, à vérifier : grès 120x60 55 €/m² (Premium), WC suspendu 1 100 € (Premium) »). La 2e, seulement si un point bloque vraiment.`;
on('POST', '/api/ai/gammes', async ({ cid, body }) => {
  const d = own('documents', body.doc_id, cid), s = settings(cid);
  if (d.type !== 'devis' || d.signature) throw httpErr(400, 'Seul un devis pas encore signé peut avoir des gammes.');
  const lignes = d.data.lignes || [];
  if (!lignes.some(l => l.type !== 'section' && l.pu > 0)) throw httpErr(400, 'Chiffrez d’abord le devis : il servira de gamme Confort.');
  const catalog = all('SELECT designation, unite, pu, tva FROM catalog WHERE compte_id=? ORDER BY designation LIMIT 300', cid);
  const out = await askClaude(GAMMES_SYSTEM, [
    `Catalogue de prix de l'entreprise :\n${JSON.stringify(catalog)}`,
    `Prix de ses devis passés :\n${JSON.stringify(prixPasses(cid, catalog, d.id))}`,
    habitudes(s, 'devis'),
    `Devis (gamme Confort) :\n${JSON.stringify({ objet: d.data.objet, lignes })}`,
  ].filter(Boolean).join('\n\n'), GAMMES_SCHEMA);
  const gammes = [{ nom: 'Essentiel', lignes: out.essentiel }, { nom: 'Confort', lignes }, { nom: 'Premium', lignes: out.premium }];
  const avant = (d.data.questions || []).filter(q => !(d.data.gammes_q || []).includes(q)); // questions d'une proposition précédente : remplacées
  return update('documents', d.id, { data: { ...d.data, gammes, gamme: 1, gammes_q: out.questions, questions: [...avant, ...out.questions] } }, cid);
});
// Ce que Kadra a appris de l'artisan, et ses consignes permanentes (Paramètres > Kadra vous connaît)
on('GET', '/api/style', ({ cid }) => {
  const s = settings(cid), m = matiereStyle(cid);
  return { regles: s.regles || [], style: s.style || null, matiere: { devis: m.devis.length, mails: m.mails.length } };
});
on('PUT', '/api/style', ({ cid, body }) => {
  const s = settings(cid), patch = {};
  if (body.regles) {
    if (!Array.isArray(body.regles) || body.regles.length > 30) throw httpErr(400, '30 consignes au plus.');
    patch.regles = body.regles.map(r => String(r).trim().slice(0, 300)).filter(Boolean);
  }
  if (body.retirer && Array.isArray(s.style?.[body.retirer.liste])) { // habitude retirée : Kadra ne la réapprend pas
    const st = { ...s.style, [body.retirer.liste]: [...s.style[body.retirer.liste]] }, [r] = st[body.retirer.liste].splice(+body.retirer.i, 1);
    if (r) st.refuses = [...(st.refuses || []), r].slice(-40);
    patch.style = st;
  }
  saveSettings(cid, patch);
  const n = settings(cid);
  return { regles: n.regles || [], style: n.style || null };
});
on('POST', '/api/ai/style', ({ cid }) => apprendreStyle(cid, true));
// Prix trouvés dans les devis passés et pas encore au catalogue (page Catalogue : « Ajouter »)
on('GET', '/api/catalog/suggestions', ({ cid }) => prixPasses(cid, all('SELECT designation FROM catalog WHERE compte_id=?', cid)));

// La reproduction d'un modèle est une prestation : seule l'équipe Kadra lance l'IA (pour son compte ou celui d'une demande).
on('POST', '/api/ai/template', ({ cid, body, user }) => { kadra(user); return aiTemplate(body, cid); });

// ---------- Prestation « modèle reproduit par Kadra » ----------
const MODELE_EXT = /\.(pdf|png|jpe?g|webp|gif|xlsx|xls|ods|docx?|odt)$/i;
const IA_LIT = /^data:(application\/pdf|image\/(png|jpeg|webp|gif));base64,|^data:[^;]*;base64,UEsDB/; // PDF, image ou zip (.xlsx ; un .docx est refusé par xlsx.js)
const sansFichier = 'id, compte_id, user_email, nom, message, statut, template_id, created_at';
on('GET', '/api/demandes-modele', ({ cid }) => all(`SELECT ${sansFichier} FROM demandes_modele WHERE compte_id=? ORDER BY id DESC`, cid));
on('POST', '/api/demandes-modele', async ({ cid, user, body }) => {
  const nom = String(body.nom || '').slice(0, 120), message = String(body.message || '').slice(0, 2000);
  if (!MODELE_EXT.test(nom) || !/^data:[\w/+.-]*;base64,[\w+/=]+$/.test(body.file || '')) throw httpErr(400, 'Envoyez un fichier PDF, Word, Excel ou une photo.');
  const id = Number(run('INSERT INTO demandes_modele (compte_id, user_email, nom, fichier, message) VALUES (?,?,?,?,?)', cid, user.email, nom, body.file, message).lastInsertRowid);
  const ent = settings(cid).nom;
  for (const a of KADRA_ADMINS) mailKadra(a, `Kadra : modèle à reproduire pour ${ent}`, `${ent} (${user.email}) a envoyé son modèle de devis : ${nom}.${message ? `\n\nSon message :\n${message}` : ''}\n\nÀ traiter : ${PUBLIC_URL}/#/kadra`);
  return { id };
});
on('GET', '/api/kadra/demandes', ({ user }) => {
  kadra(user);
  return all(`SELECT ${sansFichier}, substr(fichier, 1, 80) AS debut FROM demandes_modele ORDER BY statut='faite', id DESC`)
    .map(({ debut, ...d }) => ({ ...d, entreprise: settings(d.compte_id).nom, lisible: IA_LIT.test(debut) && !/\.(xls|ods|docx?|odt)$/i.test(d.nom) }));
});
const demande = id => get('SELECT * FROM demandes_modele WHERE id=?', id) || (() => { throw httpErr(404, 'Demande introuvable'); })();
on('GET', '/api/kadra/demandes/:id/fichier', ({ user, p }) => {
  kadra(user);
  const d = demande(p.id), [, type, b64] = /^data:([^;]*);base64,(.*)$/s.exec(d.fichier);
  return { file: Buffer.from(b64, 'base64'), type: SURS.includes(type) ? type : 'application/octet-stream', name: d.nom.normalize('NFD').replace(/[^\w.\- ()]/g, '_'), attachment: !SURS.includes(type) };
});
// file (facultatif) : le fichier converti par Kadra (ex. Word enregistré en PDF) ; sinon celui envoyé par l'artisan.
on('POST', '/api/kadra/demandes/:id/importer', async ({ user, p, body }) => {
  kadra(user);
  const d = demande(p.id), file = body.file || d.fichier;
  if (!IA_LIT.test(file) || (!body.file && /\.(xls|ods|docx?|odt)$/i.test(d.nom))) throw httpErr(400, 'Ce format ne se lit pas directement : ouvrez-le et enregistrez-le en PDF (Word) ou en .xlsx (Excel), puis « Avec un autre fichier ».');
  const t = await aiTemplate({ file, nom: d.nom.replace(/\.\w+$/, '') }, d.compte_id);
  saveSettings(d.compte_id, { template_id: t.id }); // devient sa mise en page par défaut
  run("UPDATE demandes_modele SET statut='faite', template_id=? WHERE id=?", t.id, d.id);
  mailKadra(d.user_email, 'Kadra : votre modèle de devis est prêt', `Bonjour,\n\nVotre modèle de devis est maintenant dans Kadra : vos prochains devis et factures auront votre mise en page.\nVous pouvez le retoucher dans Mise en page : ${PUBLIC_URL}/#/templates\n\nL’équipe Kadra`);
  return { template_id: t.id };
});
on('DELETE', '/api/kadra/demandes/:id', ({ user, p }) => { kadra(user); run('DELETE FROM demandes_modele WHERE id=?', demande(p.id).id); return { ok: true }; });
on('GET', '/api/kadra/templates/:id/apercu', ({ user, p }) => {
  kadra(user);
  const t = get('SELECT compte_id FROM templates WHERE id=? AND builtin=0', p.id) || (() => { throw httpErr(404, 'Modèle introuvable'); })();
  return html({ ...SAMPLE, compte_id: t.compte_id, template_id: +p.id });
});
on('POST', '/api/ai/commande', ({ cid, body, user }) => aiCommande(body, user, cid));
// Valeurs d'exemple des balises, pour l'éditeur visuel (paramètres masqués : jamais de secret envoyé au navigateur).
on('GET', '/api/templates/exemple', ({ cid, q }) => docContext(SAMPLE, masked(settings(cid)), { tpl: q.id ? one('templates', q.id, cid)?.html : '' }));
on('GET', '/templates/:id/apercu', ({ cid, p }) => { own('templates', p.id, cid); return html({ ...SAMPLE, compte_id: cid, template_id: +p.id }); });

on('GET', '/api/documents/:id/html', ({ cid, p, q }) => html(own('documents', p.id, cid), q.print ? '<script>onload=()=>print()</script>' : ''));
on('GET', '/api/documents/:id/pdf', async ({ cid, p }) => { const d = own('documents', p.id, cid); return { file: await docPdf(d), type: 'application/pdf', name: pdfName(d) }; });
on('GET', '/api/documents/:id/facturx.xml', ({ cid, p }) => {
  const d = own('documents', p.id, cid);
  if (d.type !== 'facture' || !d.numero) throw httpErr(400, 'Factur-X : émettez d’abord la facture.');
  return { file: Buffer.from(ciiXml(d, settings(cid))), type: 'application/xml', name: `${d.numero}-factur-x.xml` };
});
// Les {variables} restent dans le brouillon d'e-mail : remplies à l'envoi (le n° de facture n'existe qu'à l'émission).
on('GET', '/api/documents/:id/mail', ({ cid, p }) => {
  const d = own('documents', p.id, cid);
  return { to: d.data.client?.email || d.client_email || '', sujet: '{Type} {numero} – {entreprise}', corps: settings(cid).mail_envoi };
});
on('POST', '/api/documents/:id/send', async ({ cid, p, body }) => {
  let d = own('documents', p.id, cid);
  if (d.statut === 'brouillon') update('documents', d.id, { statut: d.type === 'devis' ? 'envoye' : 'envoyee' }, cid);
  run('UPDATE documents SET envoye_le=? WHERE id=?', new Date().toISOString(), d.id);
  d = own('documents', d.id, cid);
  const v = docMailVars(d);
  const statut = await sendMail(cid, { to: body.to, sujet: fillMail(body.sujet, v), corps: fillMail(body.corps, v), document_id: d.id, joindre: d });
  return { statut, doc: d };
});
on('POST', '/api/documents/:id/relancer', async ({ cid, p }) => ({ statut: await relancer(own('documents', p.id, cid)) }));
on('POST', '/api/documents/:id/facture', ({ cid, p, body }) => {
  const d = own('documents', p.id, cid);
  if (d.type !== 'devis') throw httpErr(400, 'Une facture se crée depuis un devis.');
  return creerFacture(d, body.mode, +body.pct || d.data.acompte_pct || settings(cid).acompte_defaut);
});
function creerFacture(d, mode, pct) {
  const s = settings(d.compte_id), base = { client: d.data.client, objet: d.data.objet, adresse_chantier: d.data.adresse_chantier, notes: '', ...(d.data.exemple && { exemple: true }) };
  const acompte = mode === 'acompte', situation = mode === 'situation';
  // acomptes et situations déjà faits (les brouillons comptent : ils seront émis) ; déduits de la situation suivante et de la facture finale
  const acomptes = all("SELECT * FROM documents WHERE type='facture' AND kind IN ('acompte','situation') AND parent_id=? ORDER BY id", d.id);
  if (situation && !(pct > 0 && pct <= 100)) throw httpErr(400, 'Avancement : entre 1 et 100 %.');
  const data = acompte ? { ...base, remise_pct: 0, lignes: lignesAcompte(d, pct, s.franchise_tva) }
    : situation ? { ...base, remise_pct: 0, situation_pct: pct, lignes: lignesSituation(d, pct, acomptes, acomptes.filter(f => f.kind === 'situation').length + 1, s.franchise_tva) }
    : { ...base, remise_pct: d.data.remise_pct || 0, lignes: lignesSolde(d, acomptes) };
  return insert('documents', { type: 'facture', kind: acompte ? 'acompte' : situation ? 'situation' : acomptes.length ? 'solde' : 'standard', client_id: d.client_id, chantier_id: d.chantier_id, parent_id: d.id, template_id: d.template_id, data }, d.compte_id);
}
// Avoir : copie négative de la facture émise (à ajuster ensuite pour un avoir partiel).
on('POST', '/api/documents/:id/avoir', ({ cid, p }) => {
  const f = own('documents', p.id, cid);
  if (f.type !== 'facture' || f.kind === 'avoir' || !f.numero) throw httpErr(400, 'Un avoir se crée depuis une facture émise.');
  const lignes = f.data.lignes.map(l => (l.type === 'section' ? l : { ...l, pu: -l.pu }));
  return insert('documents', {
    type: 'facture', kind: 'avoir', client_id: f.client_id, chantier_id: f.chantier_id, parent_id: f.id, template_id: f.template_id,
    data: { ...f.data, lignes, notes: `Avoir sur la facture ${f.numero}`, questions: [], dictees: [] },
  }, cid);
});
on('POST', '/api/documents/:id/dupliquer', ({ cid, p, body }) => {
  const d = own('documents', p.id, cid), type = body.type || d.type;
  const { questions, dictees, ia, exemple, importe, ...data } = d.data;
  if (type === 'modele') data.client = { nom: '', adresse: '', email: '', tel: '' };
  return insert('documents', { type, kind: type === 'facture' ? d.kind : 'standard', nom: type === 'modele' ? body.nom || d.data.objet || 'Modèle' : null, template_id: d.template_id, client_id: type === 'modele' ? null : d.client_id, data }, cid);
});
on('POST', '/api/documents/:id/chantier', ({ cid, p }) => creerChantier(own('documents', p.id, cid)));
function creerChantier(d) {
  if (d.chantier_id) return one('chantiers', d.chantier_id, d.compte_id);
  const ch = insert('chantiers', { nom: d.data.objet || `Chantier ${d.numero}`, client_id: d.client_id, devis_id: d.id, adresse: d.data.adresse_chantier, email_suivi: d.data.client?.email || d.client_email }, d.compte_id);
  run('UPDATE documents SET chantier_id=? WHERE compte_id=? AND (id=? OR parent_id=?)', ch.id, d.compte_id, d.id, d.id);
  run("INSERT INTO photos (compte_id, chantier_id, image, legende) SELECT compte_id, ?, image, 'Photo du devis' FROM doc_photos WHERE document_id=? AND compte_id=?", ch.id, d.id, d.compte_id);
  return one('chantiers', ch.id, d.compte_id);
}
on('POST', '/api/chantiers/:id/point', async ({ cid, p }) => {
  const ch = own('chantiers', p.id, cid);
  return { statut: await sendMail(cid, { to: ch.email_suivi || ch.client_email, sujet: `Avancement du chantier « ${ch.nom} »`, corps: fillMail(settings(cid).mail_point, chantierMailVars(ch)), chantier_id: ch.id }) };
});
on('DELETE', '/api/documents/:id', ({ cid, p }) => {
  const d = own('documents', p.id, cid);
  if (d.type === 'facture' && d.numero) throw httpErr(400, 'Une facture émise ne peut pas être supprimée (obligation légale) : créez un avoir.');
  run('DELETE FROM documents WHERE id=? AND compte_id=?', p.id, cid); return { ok: true };
});

// CRUD générique, cloisonné par entreprise
const table = t => { if (!COLS[t]) throw httpErr(404, 'Inconnu'); return t; };
on('GET', '/api/:t', ({ cid, p, q }) => {
  const t = table(p.t), w = Object.keys(q).filter(k => COLS[t].includes(k));
  return all(`SELECT * FROM (${scoped(t, cid)}) ${w.length ? 'WHERE ' + w.map(k => `${k}=?`).join(' AND ') : ''} ORDER BY id DESC`, ...w.map(k => q[k]));
});
on('GET', '/api/:t/:id', ({ cid, p }) => own(table(p.t), p.id, cid));
on('POST', '/api/:t', ({ cid, p, body }) => insert(table(p.t), body, cid));
on('PUT', '/api/:t/:id', ({ cid, p, body }) => update(table(p.t), +p.id, body, cid));
on('DELETE', '/api/:t/:id', ({ cid, p }) => { const t = table(p.t); own(t, p.id, cid); run(`DELETE FROM ${t} WHERE id=? AND compte_id=?`, p.id, cid); return { ok: true }; });

// ---------- Espace client public : consultation, PDF, signature, paiement ----------
const docByToken = token => get(`SELECT * FROM (${VIEWS.documents}) WHERE token=?`, token) || (() => { throw httpErr(404, 'Document introuvable'); })();
// Devis en gammes pas encore signé : ?g=0|1|2 montre une gamme au client (rien n'est enregistré tant qu'il ne signe pas)
const gammesOuvertes = d => (d.type === 'devis' && !d.signature && Array.isArray(d.data?.gammes) && d.data.gammes.length > 1 ? d.data.gammes : null);
function voirGamme(d, g) {
  const gs = gammesOuvertes(d);
  if (!gs || !/^\d$/.test(g ?? '') || !gs[g]) return d;
  const data = { ...d.data, lignes: gs[g].lignes, gamme: +g }, t = totaux(data, settings(d.compte_id).franchise_tva);
  return { ...d, data, total_ht: t.ht, total_ttc: t.ttc };
}
function bar(d, s) {
  const reste = r2(d.total_ttc - d.regle), payable = d.type === 'facture' && d.kind !== 'avoir' && d.numero && reste > 0 && s.stripe_secret;
  const signable = d.type === 'devis' && !d.signature && d.statut !== 'refuse';
  const gs = gammesOuvertes(d), g = d.data.gamme ?? 1, esc = x => String(x).replace(/[<>&"]/g, '');
  const choix = gs && signable ? `<div class="gm"><b>Choisissez votre gamme</b><div>${gs.map((x, i) => `<a href="?g=${i}" class="${i === g ? 'on' : ''}">${esc(x.nom)}<small>${eur(totaux({ ...d.data, lignes: x.lignes }, s.franchise_tva).ttc)} TTC</small></a>`).join('')}</div></div>` : '';
  return `<style>.pbar{position:sticky;bottom:0;max-width:820px;margin:24px auto 0;background:#14213d;color:#fff;border-radius:24px 24px 0 0;padding:16px 20px;font:15px system-ui;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.pbar a,.pbar button{font:inherit;border:0;border-radius:999px;padding:10px 18px;cursor:pointer;text-decoration:none;background:#22335a;color:#fff}.pbar .go{background:#2f5bea;color:#fff;font-weight:700}
.pbar form{flex-basis:100%;display:grid;gap:8px}.pbar input{font:inherit;padding:10px;border-radius:12px;border:0}.pbar canvas{background:#fff;border-radius:8px;touch-action:none;max-width:100%}
.pbar .gm{flex-basis:100%;display:grid;gap:8px}.pbar .gm>div{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pbar .gm a{display:grid;gap:2px;text-align:center;border-radius:16px;padding:10px 6px;font-weight:700}.pbar .gm small{font-weight:400;opacity:.85;font-size:13px}.pbar .gm a.on{background:#fff;color:#14213d}
@media print{.pbar{display:none}}</style>
<div class="pbar">${choix}<a href="/p/${d.token}/pdf${gs ? '?g=' + g : ''}">Télécharger le PDF</a><button onclick="print()">Imprimer</button>
${payable ? `<button class="go" id="pay">Payer ${eur(reste)} par carte</button>` : ''}
${signable ? `<form id="f"><b>Signer le devis en ligne${gs ? ` : gamme ${esc(gs[g]?.nom || '')}, ${eur(d.total_ttc)} TTC` : ''}</b><input name="nom" required placeholder="Nom et prénom" aria-label="Nom et prénom">
<canvas id="c" width="420" height="150" aria-label="Zone de signature"></canvas>
<label><input type="checkbox" required> Bon pour accord : j’accepte ce devis et ses conditions.</label>
<div><button class="go">Signer le devis</button> <button type="button" id="clr">Effacer</button></div></form>` : ''}
${d.signature ? `<span>✓ Signé par ${String(d.signe_par).replace(/[<>&"]/g, '')} le ${new Date(d.signe_le).toLocaleDateString('fr-FR')}</span>` : ''}</div>
<script>
const post=(u,b)=>fetch(location.pathname+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error);return j});
const pay=document.getElementById('pay');if(pay)pay.onclick=()=>post('/payer').then(j=>location=j.url).catch(e=>alert(e.message));
const c=document.getElementById('c');if(c){const x=c.getContext('2d');let on=0;x.lineWidth=2.2;x.lineCap='round';
const pt=e=>{const r=c.getBoundingClientRect();return[(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height]};
c.onpointerdown=e=>{on=1;x.beginPath();x.moveTo(...pt(e))};c.onpointermove=e=>{if(on){x.lineTo(...pt(e));x.stroke()}};onpointerup=()=>on=0;
document.getElementById('clr').onclick=()=>x.clearRect(0,0,c.width,c.height);
document.getElementById('f').onsubmit=e=>{e.preventDefault();post('/sign',{nom:e.target.nom.value,signature:c.toDataURL(),gamme:${gs ? g : 'null'}}).then(j=>location=j.acompte?'/p/'+j.acompte:location.href).catch(e=>alert(e.message))}}
</script>`;
}
// Téléphone du client : la barre (gammes, signature) à taille normale, la feuille A4 rétrécie à la largeur de l'écran
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">';
const RETRECIR = '<script>addEventListener("load",()=>{const W=document.documentElement.scrollWidth;if(W>innerWidth)for(const e of document.body.children)if(!e.matches(".pbar,script,style"))e.style.zoom=innerWidth/W})</script>';
on('GET', '/p/:token', ({ p, q }) => { const d = voirGamme(docByToken(p.token), q.g); return html(d, bar(d, settings(d.compte_id)) + RETRECIR).replace(/<head[^>]*>/i, m => m + VIEWPORT); }, PUB);
on('GET', '/p/:token/pdf', async ({ p, q }) => { const d = voirGamme(docByToken(p.token), q.g); return { file: await docPdf(d), type: 'application/pdf', name: pdfName(d) }; }, PUB);
on('POST', '/p/:token/sign', async ({ p, body, req }) => {
  let d = docByToken(p.token);
  const cid = d.compte_id, s = settings(cid), gs = gammesOuvertes(d);
  if (d.type !== 'devis' || d.signature) throw httpErr(400, 'Ce devis ne peut pas être signé.');
  if (!body.nom?.trim() || !/^data:image\/png;base64,[\w+/=]+$/.test(body.signature || '') || body.signature.length > 400e3) throw httpErr(400, 'Signature invalide.');
  if (gs) { // la gamme choisie devient le devis signé (factures et chantier partent de ses lignes)
    if (!Number.isInteger(body.gamme) || !gs[body.gamme]) throw httpErr(400, 'Choisissez une gamme.');
    update('documents', d.id, { data: { ...d.data, lignes: gs[body.gamme].lignes, gamme: +body.gamme } }, cid);
    d = docByToken(p.token);
  }
  run("UPDATE documents SET signature=?, signe_par=?, signe_le=?, signe_ip=?, statut='accepte' WHERE id=?", body.signature, body.nom.trim().slice(0, 120), new Date().toISOString(), req.socket.remoteAddress, d.id);
  creerChantier(own('documents', d.id, cid));
  let acompte = null;
  if (s.acompte_auto && d.data.acompte_pct > 0) {
    const f = creerFacture(own('documents', d.id, cid), 'acompte', d.data.acompte_pct);
    const emise = update('documents', f.id, { statut: 'envoyee' }, cid);
    run('UPDATE documents SET envoye_le=? WHERE id=?', new Date().toISOString(), emise.id);
    await sendMail(cid, { to: d.data.client?.email || d.client_email, sujet: `Facture d’acompte ${emise.numero} – ${s.nom}`, corps: fillMail(s.mail_envoi, docMailVars(emise)), document_id: emise.id, joindre: emise });
    acompte = emise.token;
  }
  if (s.email) await sendMail(cid, { to: s.email, sujet: `Devis ${d.numero} signé par ${body.nom}`, corps: `Bonne nouvelle : le devis ${d.numero} (${eur(d.total_ttc)} TTC) vient d’être signé${gs ? `, gamme ${gs[body.gamme].nom}` : ''}. Le chantier a été créé automatiquement.${acompte ? ' La facture d’acompte a été émise et envoyée au client.' : ''}`, document_id: d.id });
  return { ok: true, acompte };
}, PUB);
on('POST', '/p/:token/payer', async ({ p }) => {
  const d = docByToken(p.token), s = settings(d.compte_id), reste = r2(d.total_ttc - d.regle);
  if (d.type !== 'facture' || d.kind === 'avoir' || !d.numero || reste <= 0 || !s.stripe_secret) throw httpErr(400, 'Paiement en ligne indisponible pour ce document.');
  const email = d.data.client?.email || d.client_email;
  const session = await stripe(s.stripe_secret, 'checkout/sessions', {
    mode: 'payment', 'line_items[0][quantity]': 1, 'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': Math.round(reste * 100), 'line_items[0][price_data][product_data][name]': `Facture ${d.numero} – ${s.nom}`,
    success_url: `${PUBLIC_URL}/p/${d.token}/paye?session={CHECKOUT_SESSION_ID}`, cancel_url: `${PUBLIC_URL}/p/${d.token}`,
    'metadata[token]': d.token, ...(email && { customer_email: email }),
  });
  return { url: session.url };
}, PUB);
on('GET', '/p/:token/paye', async (ctx) => {
  const d = docByToken(ctx.p.token), s = settings(d.compte_id);
  if (/^cs_\w+$/.test(ctx.q.session || '') && s.stripe_secret) {
    const se = await stripe(s.stripe_secret, `checkout/sessions/${ctx.q.session}`);
    if (se.payment_status === 'paid' && se.metadata?.token === d.token) await enregistrerPaiement(d, se.amount_total / 100, se.id);
  }
  ctx.status = 303; ctx.headers.Location = `/p/${d.token}`;
  return '';
}, PUB);
// Webhook Stripe (facultatif) : enregistre le paiement même si le client ferme la page avant la redirection.
on('POST', '/stripe/webhook/:cid', async ({ p, raw, req }) => {
  const s = settings(p.cid);
  const sig = Object.fromEntries(String(req.headers['stripe-signature'] || '').split(',').map(kv => kv.split('=')));
  const expected = crypto.createHmac('sha256', s.stripe_webhook_secret || '-').update(`${sig.t}.${raw}`).digest('hex');
  if (!s.stripe_webhook_secret || sig.v1?.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig.v1), Buffer.from(expected)) || Math.abs(Date.now() / 1000 - sig.t) > 300) throw httpErr(400, 'Signature Stripe invalide');
  const ev = JSON.parse(raw), se = ev.data?.object;
  if (ev.type === 'checkout.session.completed' && se.payment_status === 'paid') {
    const d = get(`SELECT * FROM (${VIEWS.documents}) WHERE token=? AND compte_id=?`, se.metadata?.token, +p.cid);
    if (d) await enregistrerPaiement(d, se.amount_total / 100, se.id);
  }
  return { received: true };
}, { ...PUB, raw: true });

// ---------- Serveur HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg' };
const PUBDIR = path.resolve('public');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ctx = { req, headers: {}, status: 200 };
  const send = (status, body, type, extra = {}) => { res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...ctx.headers, ...extra }); res.end(body); };
  try {
    for (const [m, re, fn, opts] of routes) {
      const match = req.method === m && re.exec(url.pathname);
      if (!match) continue;
      if (!opts.pub) {
        ctx.user = userOf(req);
        if (!ctx.user) throw httpErr(401, 'Session expirée : reconnectez-vous.');
        ctx.cid = ctx.user.compte_id;
      }
      // Anti-CSRF : toute écriture passe par fetch() en JSON, impossible depuis le formulaire d'un autre site.
      if (m !== 'GET' && !opts.raw && !String(req.headers['content-type']).startsWith('application/json')) throw httpErr(415, 'JSON attendu');
      ctx.raw = '';
      if (m !== 'GET') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { chunks.push(chunk); if ((size += chunk.length) > 25e6) throw httpErr(413, 'Fichier trop lourd (25 Mo max).'); }
        ctx.raw = Buffer.concat(chunks).toString('utf8');
      }
      ctx.body = ctx.raw && !opts.raw ? JSON.parse(ctx.raw) : {};
      ctx.p = match.groups || {};
      ctx.q = Object.fromEntries(url.searchParams);
      ctx.res = res;
      // Mode chantier : un envoi rejoué (même clé) rend la réponse de la 1re fois au lieu de recommencer (pas de doublon)
      ctx.cle = m === 'POST' && ctx.cid && req.headers['x-kadra-cle'] ? String(req.headers['x-kadra-cle']).slice(0, 80) : null;
      if (ctx.cle) {
        const deja = get('SELECT reponse FROM envois WHERE compte_id=? AND cle=?', ctx.cid, ctx.cle);
        if (deja) { if (deja.reponse == null) throw httpErr(409, 'Envoi déjà en cours.'); return send(200, deja.reponse, 'application/json'); }
        run('INSERT INTO envois (compte_id, cle) VALUES (?,?)', ctx.cid, ctx.cle);
      }
      const out = await fn(ctx);
      if (ctx.cle) run('UPDATE envois SET reponse=? WHERE compte_id=? AND cle=?', JSON.stringify(out ?? null), ctx.cid, ctx.cle);
      if (res.headersSent) return; // réponse déjà écrite par la route (flux)
      if (out?.file) return send(200, out.file, out.type, { 'Content-Disposition': `${out.attachment ? 'attachment' : 'inline'}; filename="${out.name}"` });
      return typeof out === 'string' ? send(ctx.status, out, 'text/html; charset=utf-8') : send(ctx.status, JSON.stringify(out ?? null), 'application/json');
    }
    const file = path.join(PUBDIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (req.method === 'GET' && file.startsWith(PUBDIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', path.extname(file) === '.woff2' ? { 'Cache-Control': 'max-age=31536000' } : {});
    }
    send(404, JSON.stringify({ error: 'Introuvable' }), 'application/json');
  } catch (e) {
    if (ctx.cle && e.status !== 409) run('DELETE FROM envois WHERE compte_id=? AND cle=? AND reponse IS NULL', ctx.cid, ctx.cle); // échec : on pourra réessayer
    const noKey = e instanceof Anthropic.AuthenticationError;
    const status = noKey ? 503 : e instanceof SyntaxError ? 400 : e.status || (e instanceof Anthropic.APIError ? 502 : 500);
    if (status >= 500 && !noKey) console.error(e);
    send(status, JSON.stringify({ error: noKey ? 'Clé API Anthropic invalide : corrigez ANTHROPIC_API_KEY dans .env, ou retirez-la pour utiliser votre abonnement Claude.' : status === 500 ? 'Erreur interne du serveur.' : e.message }), 'application/json');
  }
}).listen(PORT, () => console.log(`Kadra prêt sur ${PUBLIC_URL}`));
