# Kadra

Application web de devis et factures pour les artisans du bâtiment. L'artisan dicte son devis sur le chantier, dans sa langue (même en mélangeant turc et français) : Claude le rédige en français, avec les prix appris de ses anciens devis.

## Ce que fait l'appli
- **Dictée vocale → devis** : le devis se remplit pendant qu'on parle, avec la vraie mise en page, puis se modifie directement dans la feuille, comme dans Word.
- **Devis en 3 gammes** (Essentiel / Confort / Premium) : le client choisit et signe en ligne.
- **Signature et paiement en ligne** (Stripe), acomptes, situations de travaux, avoirs, retenue de garantie.
- **Factur-X** (PDF/A-3 + XML EN 16931) et export **FEC** pour le comptable.
- **Suivi des chantiers**, photos, dépenses (tickets lus par l'IA), analyse de rentabilité.
- **Secrétaire** : boîte mail façon Gmail (IMAP), réponses rédigées par l'IA dans le style de l'artisan, rendez-vous trouvés dans les e-mails, agenda, relances automatiques des impayés.
- **Assistant vocal** « Parler à Kadra » : « mets-moi un rendez-vous jeudi 9 h chez Mme Martin », « qui me doit de l'argent ? ».
- **Appli installable** (PWA), mode chantier sans réseau, interface traduite en 22 langues.
- Multi-entreprises avec équipe, rôles et données cloisonnées.

## Technique
Node.js sans framework ni étape de build : serveur HTTP natif, SQLite intégré (`node:sqlite`), interface en JavaScript pur.
Dépendances : `@anthropic-ai/sdk`, `nodemailer`, `imapflow`, `puppeteer-core` (PDF), `pdf-lib` (Factur-X).

| Fichier | Rôle |
|---|---|
| `server.js` | API, base de données, IA, e-mails, tâches automatiques |
| `public/app.js` | interface (routeur par hash) |
| `public/calc.js` | calculs d'argent (TVA multi-taux, acomptes, FEC), partagés navigateur / serveur |
| `templates.js` | moteur de mise en page des documents |
| `pdf.js` | PDF et Factur-X |
| `test.js` | tests des calculs et des modèles |

## Lancer
Node.js 22.5 ou plus, et Chrome ou Edge installé (pour les PDF).
```
npm install
cp .env.example .env     # facultatif : SMTP, clé API Anthropic…
npm run demo             # site de démo rempli : http://localhost:3001  (demo@kadra.fr / demo1234)
npm start                # http://localhost:3000
npm test
```
L'IA passe par une clé `ANTHROPIC_API_KEY` dans `.env`, ou à défaut par Claude Code installé et connecté sur la machine.
La dictée vocale utilise l'API Web Speech du navigateur (Chrome, Edge, Safari).
