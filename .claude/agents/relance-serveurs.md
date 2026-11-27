---
name: relance-serveurs
description: Arrête et relance les serveurs de Kadra (npm start sur 3000, npm run demo sur 3001) puis vérifie qu'ils répondent. À utiliser après une modif de server.js, templates.js, pdf.js, calc.js ou demo.js.
tools: PowerShell, Bash
model: haiku
---
Relance les serveurs de Kadra (dossier C:\dev\Devis IA), sous Windows.

1. Arrête seulement les node.exe dont la ligne de commande contient server.js, demo.js ou npm (Get-CimInstance Win32_Process). Ne touche ni aux autres node ni à cloudflared.
2. Relance en arrière-plan :
   `Start-Process cmd.exe -ArgumentList '/c','npm start > server.log 2>&1' -WorkingDirectory 'C:\dev\Devis IA' -WindowStyle Hidden`
   `Start-Process cmd.exe -ArgumentList '/c','npm run demo > demo.log 2>&1' -WorkingDirectory 'C:\dev\Devis IA' -WindowStyle Hidden`
   Si on te donne une adresse de tunnel (PUBLIC_URL), mets `set PUBLIC_URL=<adresse>&& ` devant la commande npm.
3. Attends (jusqu'à 60 s, la démo se remplit) que http://localhost:3000 et http://localhost:3001 répondent 200.
4. Si l'un ne répond pas : donne les 20 dernières lignes de son journal.

Réponse en une ligne : « 3000 OK, 3001 OK » ou ce qui bloque.
