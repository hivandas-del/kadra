// Vidéo explicative de Kadra : npm run video → video/kadra-explications.mp4 (1440×810, voix off + sous-titres).
// Lance une démo à part (video.db, port 3005 : demo.db n'est pas touchée), y joue le parcours devis → signature → chantier
// → acompte → paiement → e-mails → agenda → « Parler à Kadra » avec un curseur visible et un faux micro,
// enregistre l'écran (puppeteer + ffmpeg) et pose les voix (edge-tts : narratrice, artisan qui dicte, réponse de Kadra).
// À relancer après un changement d'interface : la vidéo suit toute seule. Demande Chrome, ffmpeg, Python + edge-tts, Claude Code connecté.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';

const PORT = 3005, URL = `http://localhost:${PORT}`, DIR = 'video';
const VOIX = { narr: 'fr-FR-DeniseNeural', artisan: 'fr-FR-HenriNeural', kadra: 'fr-FR-VivienneMultilingualNeural' };
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(f => f && fs.existsSync(f));

// ---------- Texte ----------
const N = {
  intro: 'Bienvenue sur Kadra, le logiciel de devis et de factures fait pour les artisans du bâtiment. En quelques minutes, voici comment ça marche, du devis jusqu’au paiement.',
  accueil: 'En arrivant, l’accueil vous montre ce qui compte : votre chiffre d’affaires, les clients qui vous doivent de l’argent, ce qu’il reste à facturer, et vos rendez-vous du jour.',
  dicter: 'Pour faire un devis, pas besoin de clavier. Appuyez sur le micro, et décrivez les travaux comme à un collègue.',
  redige: 'Pendant que vous parlez, Kadra rédige le devis à côté : en bon français, avec les prix, les quantités et la TVA. Quand c’est fini, appuyez sur « Rédiger le devis ».',
  modifier: 'Le devis se modifie comme sur papier. Cliquez sur un prix, changez-le : les totaux suivent tout seuls.',
  envoyer: 'Il est prêt ? Appuyez sur « Envoyer ». Le client reçoit un e-mail avec le PDF et un lien pour signer.',
  client: 'De son côté, le client ouvre le lien, sur son téléphone ou son ordinateur. Il lit le devis, et il signe du doigt, en ligne.',
  chantier: 'Le devis est signé : Kadra crée le chantier tout seul et vous prévient. Pour dire où en sont les travaux, un seul geste.',
  acompte: 'Avant de commencer, demandez l’acompte. Kadra calcule la facture d’après le devis.',
  paye: 'Le client a payé ? Enregistrez le règlement en un clic. Et si une facture n’est pas payée à temps, Kadra relance le client tout seul, par e-mail.',
  mails: 'Les e-mails de vos clients arrivent ici, rangés par client, comme dans votre boîte mail. Pour répondre, dites simplement ce que vous voulez dire : Kadra écrit la réponse.',
  agenda: 'Un client vous propose « jeudi dix heures » dans un e-mail ? Kadra le repère et vous propose le rendez-vous dans l’agenda. Vous n’avez qu’à confirmer.',
  voix: 'Et à tout moment, appuyez sur ce bouton et parlez à Kadra : un rendez-vous à noter, un client à relancer, une question.',
  fin: 'Kadra : vous dictez le devis sur le chantier, Kadra s’occupe du reste.',
};
const DICTEE = [
  'Devis pour Madame Lambert, rénovation de la salle de bain.',
  'Dépose de l’ancienne baignoire, trois cent cinquante euros.',
  'Fourniture et pose d’un receveur de douche, quatre cent cinquante euros.',
  'Faïence murale, dix-huit mètres carrés à soixante-cinq euros le mètre.',
];
const QUESTION = 'Qui me doit de l’argent ?';

// ---------- Outils ----------
const dodo = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const duree = f => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();
function tts(texte, voix, fichier) { // gardé d'un tournage à l'autre ; changer le texte ou la voix refait le fichier
  fichier = fichier.replace('.mp3', '-' + crypto.createHash('md5').update(voix + texte).digest('hex').slice(0, 8) + '.mp3');
  if (!fs.existsSync(fichier)) execFileSync('python', ['-m', 'edge_tts', '-v', voix, '--rate=+4%', '-t', texte, '--write-media', fichier]);
  return { file: fichier, dur: duree(fichier) };
}

// Calque posé dans chaque page (et chaque iframe ignorée) : curseur, onde du clic, sous-titres, carte de titre. Faux micro aussi.
const CALQUE = () => {
  if (window !== top) return;
  const R = []; let rec = null;
  class SR { start() { rec = this; R.length = 0; } stop() { if (rec === this) rec = null; setTimeout(() => this.onend?.(), 30); } abort() { this.stop(); } }
  window.SpeechRecognition = window.webkitSpeechRecognition = SR;
  window.__entendre = (t, fin) => {
    if (!rec) return;
    const i = R.length && !R[R.length - 1].isFinal ? R.length - 1 : R.length;
    const r = [{ transcript: t, confidence: 1 }]; r.isFinal = fin; R[i] = r;
    rec.onresult?.({ resultIndex: i, results: R });
  };
  addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = `#__cur{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:30px;height:30px;transform:translate(-4px,-3px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
#__rip{position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(47,91,234,.35);transform:scale(0);opacity:0}
#__rip.go{animation:__r .55s ease-out}@keyframes __r{from{transform:scale(.2);opacity:1}to{transform:scale(1.6);opacity:0}}
#__st{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;max-width:min(980px,86vw);text-align:center;
 background:rgba(20,33,61,.92);color:#fff;font:600 21px/1.4 Manrope,system-ui,sans-serif;padding:12px 24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);transition:opacity .3s}
#__st:empty{opacity:0}#__st.art{background:#fff;color:#14213d;font-style:italic;border:2px solid #2F5BEA}#__st.art::before{content:'🎙  '}
#__card{position:fixed;inset:0;z-index:2147483644;display:grid;place-content:center;justify-items:center;gap:18px;background:#14213D;color:#fff;text-align:center;
 font-family:Manrope,system-ui,sans-serif;transition:opacity .8s}#__card.off{opacity:0}#__card img{width:120px;height:120px;border-radius:28px}
#__card h1{font-size:64px;margin:0;letter-spacing:-.02em}#__card p{font-size:26px;margin:0;color:#A9C1FF;max-width:900px;line-height:1.4}`;
    document.head.append(s);
    document.body.insertAdjacentHTML('beforeend', `<div id="__st"></div><div id="__rip"></div><svg id="__cur" viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.6 1 3.9 7.6-2.9 1.4-3.8-7.7L4 20z" fill="#fff" stroke="#14213d" stroke-width="1.5" stroke-linejoin="round"/></svg>`);
    const c = sessionStorage.__pos?.split(',');
    if (c) __cur(+c[0], +c[1]);
  });
  window.__cur = (x, y) => { const e = document.getElementById('__cur'); if (e) e.style.left = x + 'px', e.style.top = y + 'px'; sessionStorage.__pos = x + ',' + y; };
  window.__rip = (x, y) => { const e = document.getElementById('__rip'); e.style.left = x + 'px'; e.style.top = y + 'px'; e.classList.remove('go'); void e.offsetWidth; e.classList.add('go'); };
  window.__st = (t, art) => { const e = document.getElementById('__st'); if (e) { e.textContent = t || ''; e.classList.toggle('art', !!art); } };
  window.__card = (titre, texte) => {
    document.getElementById('__card')?.remove();
    if (titre) document.body.insertAdjacentHTML('beforeend', `<div id="__card"><img src="/logo.svg" alt=""><h1>${titre}</h1><p>${texte}</p></div>`);
  };
  window.__cardOff = () => { const e = document.getElementById('__card'); if (e) { e.classList.add('off'); setTimeout(() => e.remove(), 900); } };
};

// ---------- Démo à part ----------
fs.mkdirSync(DIR, { recursive: true });
console.log('Voix off…');
const V = Object.fromEntries(Object.entries(N).map(([k, t]) => [k, tts(t, VOIX.narr, `${DIR}/n-${k}.mp3`)]));
const VD = DICTEE.map((t, i) => tts(t, VOIX.artisan, `${DIR}/a-${i}.mp3`));
const VQ = tts(QUESTION, VOIX.artisan, `${DIR}/a-q.mp3`);

console.log('Démo sur le port', PORT, '…');
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'demo.js'], { env: { ...process.env, DB_FILE: 'video.db', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok, ko) => {
  srv.stdout.on('data', b => String(b).includes('Démo prête') && ok());
  srv.on('exit', () => ko(new Error('La démo s’est arrêtée')));
  setTimeout(() => ko(new Error('La démo ne démarre pas')), 120000);
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1440, height: 810, deviceScaleFactor: 4 / 3 } });
const page = await browser.newPage();
await page.evaluateOnNewDocument(CALQUE);
page.on('pageerror', e => console.log('Erreur JS :', e.message));
await page.goto(URL);
await page.evaluate(async () => {
  await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@kadra.fr', password: 'demo1234' }) });
  localStorage.kadra_ouvert = new Date().toISOString().slice(0, 10); // pas l'animation d'ouverture : la carte de titre la remplace
});
await page.goto(URL + '/?video#/agenda'); // ?video : vraie recharge (un simple # ne recharge pas) // l'accueil s'affiche sous la carte de titre, ses chiffres défilent à l'arrivée
await page.waitForSelector('#__st');
const api = p => page.evaluate(p => fetch('/api/' + p).then(r => r.json()), p);

// ---------- Gestes ----------
let pos = [720, 600];
async function bouger(x, y, n = 22) {
  const [x0, y0] = pos;
  for (let i = 1; i <= n; i++) {
    const k = i / n, e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const px = x0 + (x - x0) * e, py = y0 + (y - y0) * e;
    await page.mouse.move(px, py); await page.evaluate((a, b) => __cur(a, b), px, py); await dodo(14);
  }
  pos = [x, y];
}
async function viser(cible, frame = page) {
  const el = typeof cible === 'string' ? await frame.waitForSelector(cible, { visible: true, timeout: 60000 }) : cible;
  await el.evaluate(e => e.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); await dodo(600);
  const b = await el.boundingBox();
  await bouger(b.x + b.width / 2, b.y + b.height / 2);
  return el;
}
async function clic(cible, frame) {
  await viser(cible, frame); await dodo(250);
  await page.evaluate((a, b) => __rip(a, b), ...pos);
  await page.mouse.click(...pos);
}
const attendre = (fn, ms = 90000, ...args) => page.waitForFunction(fn, { timeout: ms, polling: 300 }, ...args);

// Une scène = sous-titre + voix off posée à l'instant t ; on ne passe à la suite qu'à la fin de la phrase.
const PISTE = []; let T0;
async function dit(cle, gestes = async () => {}) {
  const v = V[cle], t = Date.now();
  PISTE.push([v.file, t - T0]);
  await page.evaluate(s => __st(s), N[cle]);
  await gestes();
  await dodo(t + v.dur * 1000 + 450 - Date.now());
}
// L'artisan parle : sa voix + les mots qui arrivent dans le micro au même rythme.
async function parle(v, texte) {
  const t = Date.now(), mots = texte.split(' ');
  PISTE.push([v.file, t - T0]);
  await page.evaluate(s => __st(s, true), texte);
  for (let i = 1; i <= mots.length; i++) {
    await dodo(t + (v.dur * 1000 * i) / mots.length - Date.now());
    await page.evaluate((s, f) => __entendre(s, f), mots.slice(0, i).join(' '), i === mots.length);
  }
  await dodo(350);
}

// ---------- Tournage ----------
try {
await page.evaluate((a, b) => __card(a, b), 'Kadra', 'Comment ça marche');
const rec = await page.screencast({ path: `${DIR}/brut.webm` });
T0 = Date.now();
await dodo(600);
await dit('intro');
await page.evaluate(() => { location.hash = '#/'; __cardOff(); });
await dit('accueil', async () => {
  await dodo(1200);
  for (const s of ['.kpi.ca-an', '.kpi:nth-child(2)', '.kpi:nth-child(3)', '.cockpit .box']) { const e = await page.$(s); if (e) { await viser(e); await dodo(900); } }
});

console.log('Dictée…');
await page.evaluate(() => { location.hash = '#/nouveau'; });
await dit('dicter', async () => { await dodo(1500); await clic('#mic'); });
await page.evaluate(() => __st(''));
for (const [i, t] of DICTEE.entries()) await parle(VD[i], t);
await clic('#mic');
await dit('redige', async () => {
  await attendre(() => /à jour/.test(document.querySelector('#lst')?.textContent || ''));
  await clic('#go');
});
await attendre(() => /^#\/doc\/\d+/.test(location.hash));
const docId = +(await page.evaluate(() => location.hash.split('/')[2]));

console.log('Devis', docId, '…');
await page.waitForSelector('#pv');
const pv = await (await page.$('#pv')).contentFrame();
await dit('modifier', async () => {
  const pu = await pv.waitForSelector('[data-k="pu"]', { visible: true });
  await clic(pu, pv);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('390', { delay: 140 }); await page.keyboard.press('Enter');
});
await dit('envoyer', async () => {
  await clic('#send');
  await dodo(1500);
  const to = await page.waitForSelector('dialog[open] input[name="to"]');
  if (!(await to.evaluate(e => e.value))) { await clic(to); await page.keyboard.type('claire.lambert@example.com', { delay: 45 }); }
  await clic('dialog[open] button[value="ok"]');
});
await attendre(id => fetch('/api/documents/' + id).then(r => r.json()).then(d => d.statut !== 'brouillon' && d.token), 30000, docId);
const { token } = await api('documents/' + docId);

console.log('Signature…');
await page.goto(`${URL}/p/${token}`);
await dit('client', async () => {
  await page.waitForSelector('#f input[name="nom"]');
  await clic('#f input[name="nom"]');
  await page.keyboard.type('Claire Lambert', { delay: 80 });
  const c = await viser('#c'), b = await c.boundingBox();
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) { // signature : une boucle et un trait
    const k = i / 60, x = b.x + 30 + k * (b.width - 60), y = b.y + b.height / 2 + Math.sin(k * 14) * 28 * (1 - k * .4);
    await page.mouse.move(x, y); await page.evaluate((a, z) => __cur(a, z), x, y); pos = [x, y]; await dodo(16);
  }
  await page.mouse.up();
  await clic('#f input[type="checkbox"]');
  await clic('#f button.go');
});
await attendre(id => fetch('/api/documents/' + id).then(r => r.json()).then(d => d.chantier_id), 30000, docId).catch(() => {});
const { chantier_id: chId } = await api('documents/' + docId);

console.log('Chantier', chId, '…');
await page.goto(`${URL}/#/chantier/${chId}`);
await dit('chantier', async () => { await dodo(2200); await clic('[data-av="25"]'); });
await page.evaluate(() => document.querySelector('dialog[open] button[value="ok"]')?.click());
await dit('acompte', async () => {
  await clic('[data-fac="acompte"]');
  await dodo(1200);
  await clic('dialog[open] button[value="ok"]');
});
await attendre(id => /^#\/doc\/\d+/.test(location.hash) && location.hash !== '#/doc/' + id, 30000, docId);
await dit('paye', async () => { await dodo(1500); await clic('#pf button.primary'); });

console.log('E-mails, agenda, voix…');
await page.evaluate(() => { location.hash = '#/mails'; });
await dit('mails', async () => { await attendre(() => !/Chargement/.test(document.querySelector('main')?.innerText || document.body.innerText), 20000).catch(() => {}); await dodo(1200); const e = await page.$('.conv, [data-conv], .boite li'); if (e) await viser(e); });
await page.evaluate(() => { location.hash = '#/agenda'; });
await dit('agenda', async () => { await dodo(2000); const e = await page.$('.propose, .trouves, [data-ok]'); if (e) await viser(e); });
await page.evaluate(() => { location.hash = '#/'; });
await dit('voix', async () => { await dodo(1000); await viser('#voix'); });
await clic('#voix');
await page.evaluate(() => __st(''));
await parle(VQ, QUESTION);
await clic('#voix');
await page.evaluate(() => __st(''));
const reponse = await attendre(() => document.querySelector('#bulle')?.innerText.replace(/\s+/g, ' ').trim(), 60000).then(h => h.jsonValue()).catch(() => '');
if (reponse) {
  const court = reponse.replace(/^Kadra\s*:?\s*/, '').match(/^.{0,260}[.!?]/)?.[0] || reponse.slice(0, 260); // 2-3 phrases suffisent
  await page.evaluate(t => { document.getElementById('bulle')?.remove(); __st('Kadra : ' + t); }, court);
  const vr = tts(court, VOIX.kadra, `${DIR}/k-rep.mp3`);
  PISTE.push([vr.file, Date.now() - T0]);
  await dodo(vr.dur * 1000 + 600);
}
await page.evaluate((a, b) => { document.getElementById('bulle')?.remove(); __st(''); __card(a, b); }, 'Kadra', 'Dictez le devis sur le chantier.<br>Kadra s’occupe du reste.');
await dit('fin');
await dodo(1200);
await rec.stop();
await browser.close(); srv.kill();

} catch (e) { // tournage bloqué : capture de l'écran à ce moment-là, pour voir pourquoi
  await page.screenshot({ path: `${DIR}/bloque.png` }).catch(() => {});
  console.log('Bloqué :', e.message, '(capture : video/bloque.png)');
  srv.kill(); process.exit(1);
}

// ---------- Montage : voix posées à leur instant sur l'image ----------
console.log('Montage…');
const sortie = `${DIR}/kadra-explications.mp4`;
const entrees = PISTE.flatMap(([f]) => ['-i', f]);
const filtres = PISTE.map(([, t], i) => `[${i + 1}:a]adelay=${Math.round(t)}:all=1[a${i}]`).join(';') + ';' + PISTE.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${PISTE.length}:normalize=0:duration=longest[a]`;
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', `${DIR}/brut.webm`, ...entrees, '-filter_complex', filtres, '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', sortie]);
for (const f of fs.readdirSync(DIR)) if (f.startsWith('k-rep')) fs.rmSync(`${DIR}/${f}`); // la réponse de Kadra change à chaque tournage
console.log(`Vidéo prête : ${sortie} (${Math.round(duree(sortie))} s)`);
process.exit(0);
