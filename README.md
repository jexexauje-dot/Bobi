# Bobi — backend (Gemini texte + gestes, Gemini voix, Render)

Ce serveur est le cerveau de Bobi : il appelle Gemini, **valide** tout ce que l'IA renvoie, ajoute images/schémas/vidéos/sites, gère la mémoire et fabrique la voix. Ton site (design inchangé) n'a qu'à appeler 4 routes.

**Structure :** `index.html` (à la racine, comme tous les fichiers) = le site Bobi, servi directement par `server.js` sur `/` (même serveur que l'API : pas de CORS, une seule URL). Ouvre http://localhost:8787/ après `npm start`.

---------------------------------------------------------------------
## PARTIE A — Obtenir les clés Gemini (10 min)
1. Va sur https://aistudio.google.com/apikey et connecte-toi avec ton compte Google.
2. Clique **Create API key** → choisis (ou crée) un projet → copie la clé (commence par `AIza…`). C'est ta **clé TEXTE**.
3. (Option, pour séparer les quotas) Crée un **second projet** dans AI Studio et une seconde clé = **clé VOIX**. ⚠ Relis les conditions d'utilisation de l'API Gemini : multiplier les comptes/projets uniquement pour contourner le gratuit peut être interdit. Si tu hésites, utilise **une seule clé** (laisse la clé VOIX vide : le serveur réutilise la clé texte).
4. Ne mets JAMAIS ces clés dans le HTML, GitHub ou une capture d'écran. Elles vont seulement dans Render (partie C).
5. Dans AI Studio, ouvre la page des **limites/quotas** (Rate limits) et note : requêtes/minute et par jour du modèle texte et du modèle TTS. Vérifie aussi que les noms de modèles de `.env.example` existent encore (`gemini-2.5-flash`, `gemini-2.5-flash-preview-tts`) ; sinon remplace-les par ceux listés dans AI Studio (ils changent avec le temps).

## PARTIE B — Tester en local (10 min)
1. Installe Node.js 18+ (https://nodejs.org).
2. Dans le dossier : `npm install`
3. Copie `.env.example` en `.env`, colle ta/tes clé(s).
4. `npm start`, puis ouvre http://localhost:8787/api/health → tu dois voir `"mock":false` et `"tts":true`.
5. Test texte : `curl -X POST localhost:8787/api/chat -H "content-type: application/json" -d '{"message":"Explique la gravité"}'` → tu reçois des `beats` (phrases + gestes + média).
6. Test voix : `curl -X POST localhost:8787/api/tts -H "content-type: application/json" -d '{"text":"Salut, moi c est Bobi","emotion":"joy"}' --output test.wav` → écoute `test.wav`. Si tu reçois `{"fallback":true,...}`, lis le champ `why` (clé absente, quota, nom de modèle faux).

## PARTIE C — Héberger sur Render (15 min)
1. Crée un compte GitHub, puis un dépôt **privé** `bobi-backend`. Envoie-y le contenu du dossier (le `.gitignore` empêche d'envoyer `.env` et `node_modules`). Vérifie que `.env` n'apparaît pas sur GitHub.
2. Sur https://render.com : **New → Web Service** → connecte GitHub → choisis le dépôt. (Ou **New → Blueprint** : `render.yaml` remplit tout.)
3. Réglages : Runtime **Node**, Build `npm install`, Start `npm start`, Plan **Free**, Health Check Path `/api/health`.
4. **Environment** → ajoute : `GEMINI_API_KEY_TEXT`, `GEMINI_API_KEY_TTS` (optionnel), `GEMINI_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE=Charon`, `TTS_DAILY_CAP=60`, `ALLOWED_ORIGIN` (l'URL exacte de ton site, ex. `https://bobi.netlify.app`, sans `/` final ; `*` seulement pour les tests).
5. Clique **Create Web Service**. Au bout de ~3 min tu as une URL `https://bobi-backend-xxxx.onrender.com`. Teste `/api/health`.
6. Limites du plan gratuit Render à connaître :
   - le serveur **s'endort après ~15 min** sans visite ; le premier appel suivant prend 30-60 s. Solution : un ping gratuit toutes les 10 min sur `/api/health` (UptimeRobot), et côté site afficher Bobi « qui se réveille » (geste `think`).
   - le **disque est effacé** à chaque redémarrage/déploiement : `users.json` (mémoire, séries de jours) sera perdu. Pour la mémoire durable, branche plus tard une base gratuite (Supabase ou MongoDB Atlas). Pour tester, ce n'est pas gênant.
7. Héberge le **site** hors Artifact (Netlify, GitHub Pages ou Cloudflare Pages) : un Artifact ne peut pas appeler ton serveur. Mets son URL dans `ALLOWED_ORIGIN` et redéploie.

## PARTIE D — Brancher le site (design inchangé)
```js
const API = 'https://bobi-backend-xxxx.onrender.com';
const uid = localStorage.bobiId || (localStorage.bobiId = crypto.randomUUID());
const post = (p, b) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: uid, ...b }) });

async function say(beat) {                          // voix : Gemini TTS, sinon voix du navigateur
  const r = await post('/api/tts', { text: beat.say, emotion: beat.emotion });
  if (r.ok) { const a = new Audio(URL.createObjectURL(await r.blob())); await a.play(); return new Promise(ok => a.onended = ok); }
  return speakWithBrowserVoice(beat.say);            // ta fonction actuelle = filet de sécurité
}
async function ask(message) {
  const out = await (await post('/api/chat', { message })).json();
  for (const b of out.beats) {                       // chaque beat = voix + mouvement + média ENSEMBLE
    if (b.media) showMedia(b.media);                 // image / mermaid / chart / simulation / video / site
    playBody(b);                                     // b.gesture OU b.timeline (poses clés, radians) + b.look + b.emotion
    await say(b);
  }
  showSuggestions(out.suggestions, out.teaser);
}
```
- `playBody` : pour `gesture` utilise tes gestes existants ; pour `timeline`, pour chaque pose clé fixe la cible (rotation des os `hips, chest, head, armP, armN, footP, footN`) à l'instant `t` ; ton ressort-amortisseur fait la fluidité.
- Pour un chargement fluide : lance l'audio du beat suivant (`/api/tts`) pendant que le beat courant parle.
- Mermaid (schémas) : charge `https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js` et rends `media.mermaid`.
- Site : si `media.mode==='iframe'` → `<iframe src=url sandbox="allow-scripts allow-same-origin">` ; sinon carte avec `media.logo` + lien. Vidéo : `<iframe src=media.embed>` ou lien `media.search`.
- Image : affiche toujours `media.credit` sous l'image.
- Accueil : `POST /api/greet` à l'ouverture ; veille : `GET /api/idle` toutes les ~15 s sans action.

## PARTIE E — Quotas : ne pas tomber à sec
- Le serveur limite : 20 messages/min/IP, `TTS_DAILY_CAP` phrases vocales/jour/utilisateur, cache des 80 dernières voix et des médias. Au-delà, `/api/tts` répond `{fallback:true}` → le site retombe sur la voix du navigateur sans erreur visible.
- Les erreurs 429 de Gemini déclenchent 1 nouvelle tentative, puis Bobi dit une phrase d'excuse avec un haussement d'épaules.
- Si les utilisateurs arrivent : active la facturation sur le projet Google avec un **plafond de budget** (Google Cloud → Billing → Budgets & alerts). Le coût est généralement faible par message ; suis-le la première semaine.
- Voix pour économiser : réserve le TTS aux phrases importantes, joue les petites réactions avec la voix du navigateur.

## PARTIE F — Check-list « rien ne rate »
- [ ] `/api/health` OK en local puis sur Render
- [ ] `.env` absent de GitHub
- [ ] clés uniquement dans Render
- [ ] `ALLOWED_ORIGIN` = URL exacte du site
- [ ] test `/api/chat` et `/api/tts` depuis le site déployé (console navigateur sans erreur CORS)
- [ ] ping UptimeRobot configuré
- [ ] test du repli : coupe la clé TTS → Bobi parle quand même avec la voix du navigateur
- [ ] 20 vraies questions de cours testées ; ajuste le prompt `SYSTEM` dans `server.js` si les gestes ne collent pas
- [ ] budget/alertes Google réglés avant le lancement public

## Routes
`GET /api/health` · `GET /api/vocab` · `POST /api/greet` · `POST /api/chat {userId,message}` · `POST /api/tts {userId,text,emotion}` (renvoie `audio/wav`, en-tête `x-duration-ms`) · `GET /api/idle`
