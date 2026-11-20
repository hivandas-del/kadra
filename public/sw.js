// Rend Kadra installable comme une appli et utilisable sur un chantier sans réseau (« mode chantier »).
// Toujours le réseau d'abord : le code et les données restent à jour. La dernière version gardée sert quand le réseau
// manque, ou au bout de 8 s si le téléphone capte mal. Les données (/api, lecture seule) sont effacées à la déconnexion (app.js).
const COQUE = 'kadra-coque', DONNEES = 'kadra-donnees';
const FICHIERS = ['/', '/app.js', '/style.css', '/calc.js', '/i18n.js', '/templates.js', '/logo.svg', '/manifest.webmanifest', '/fonts/manrope-latin.woff2', '/fonts/manrope-latin-ext.woff2'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(COQUE).then(c => Promise.all(FICHIERS.map(f => c.add(f).catch(() => {})))));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function reseauDabord(req, nom, garder) {
  const reseau = fetch(req).then(async rep => {
    if (rep.ok && garder(rep)) await (await caches.open(nom)).put(req, rep.clone());
    return rep;
  });
  const vieux = await caches.match(req, { cacheName: nom });
  if (!vieux) return reseau;
  return Promise.race([reseau.catch(() => vieux), new Promise(ok => setTimeout(() => ok(vieux), 8000))]);
}

self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) {
    // seulement les réponses JSON (pas les PDF, pièces jointes, exports)
    return e.respondWith(reseauDabord(req, DONNEES, rep => (rep.headers.get('Content-Type') || '').startsWith('application/json')));
  }
  if (FICHIERS.includes(u.pathname) || /^\/(fonts\/[\w.-]+|[\w.-]+\.(png|svg))$/.test(u.pathname)) e.respondWith(reseauDabord(req, COQUE, () => true));
});
