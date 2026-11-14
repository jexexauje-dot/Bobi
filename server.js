// BOBI BACKEND — Gemini pilote le corps, la voix, les médias. Aucune dépendance autre qu'express+cors.
import { Readable } from 'node:stream';
import express from 'express'; import cors from 'cors'; import fs from 'fs'; import crypto from 'crypto';
import * as EX from './media.js';
try { for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=([^#\n]*)/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}
const KEY = process.env.GEMINI_API_KEY_TEXT || process.env.GEMINI_API_KEY || '', TTS_KEY = process.env.GEMINI_API_KEY_TTS || KEY, TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts', TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Puck', TTS_FALLBACKS = (process.env.GEMINI_TTS_FALLBACKS || 'gemini-3.1-flash-tts-preview,gemini-3.8-flash-tts').split(',').map(x => x.trim()).filter(Boolean), TTS_CAP = +process.env.TTS_DAILY_CAP || 60, MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash', YT = process.env.YOUTUBE_API_KEY || '';
const app = express(); app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' })); app.use(express.json({ limit: '200kb' }));
app.get(['/', '/index.html'], (_, r) => r.sendFile(new URL('./index.html', import.meta.url).pathname)); // sert le site Bobi ; seul index.html est exposé (pas server.js ni .env)

/* ---------- 1. Vocabulaire du corps (doit correspondre au rig de Bobi) ---------- */
const BONES = { hips: 0.6, chest: 0.8, head: 1.0, armP: 3.0, armN: 3.0, footP: 0.9, footN: 0.9 }; // limite ± radians
const GESTURES = ['idle', 'wave', 'point', 'present', 'shrug', 'think', 'nod', 'shake', 'clap', 'celebrate', 'bow', 'lean_in', 'surprise', 'dance', 'walk', 'hands_hips', 'thumbs_up'];
const EMOTIONS = ['neutral', 'joy', 'curious', 'excited', 'thinking', 'empathy', 'proud', 'surprised', 'playful', 'serious'];
const EASES = ['smooth', 'snap', 'bounce', 'linear'];
const SCENES = ['wave', 'projectile']; // plus de schémas emoji : seulement des simulations
const BGS = ['space', 'sky', 'ocean', 'earth', 'night', 'lab', 'paper', 'fire'], FADES = ['none', 'in', 'out', 'pulse'];
const MEDIA = ['image', 'video', 'music', 'file', 'site', 'sim', ...EX.SPECIAL_TYPES, ...SCENES];

/* ---------- 2. Schéma imposé à Gemini (sortie JSON garantie) ---------- */
const S = (type, extra = {}) => ({ type, ...extra });
const schema = S('OBJECT', { required: ['beats'], propertyOrdering: ['mediaQuery', 'beats', 'topic', 'suggestions', 'teaser', 'memory'], properties: {
  beats: S('ARRAY', { items: S('OBJECT', { required: ['say'], propertyOrdering: ['say', 'emotion', 'intensity', 'gesture', 'look', 'media', 'timeline'], properties: {
    say: S('STRING', { description: 'Une à deux phrases dites à voix haute. Courte (10-25 mots) pour une question simple ; 30 à 45 mots, riche en faits, pour une explication.' }),
    emotion: S('STRING', { enum: EMOTIONS }),
    intensity: S('NUMBER', { description: '0 à 1' }),
    gesture: S('STRING', { enum: GESTURES, description: 'Geste préétabli (prioritaire si pas de timeline).' }),
    timeline: S('ARRAY', { description: 'Mouvement libre : poses clés successives, pour tout mouvement non listé.', items: S('OBJECT', { required: ['t', 'pose'], properties: {
      t: S('NUMBER', { description: 'secondes depuis le début de la phrase' }),
      ease: S('STRING', { enum: EASES }),
      pose: S('ARRAY', { items: S('OBJECT', { required: ['bone', 'rot'], properties: { bone: S('STRING', { enum: Object.keys(BONES) }), rot: S('ARRAY', { items: S('NUMBER'), description: '[x,y,z] radians' }) } }) }) } }) }),
    look: S('STRING', { enum: ['user', 'media', 'away', 'up'], description: 'Où regarde Bobi.' }),
    media: S('OBJECT', { properties: {
      type: S('STRING', { enum: MEDIA }), title: S('STRING'), caption: S('STRING'),
      query: S('STRING', { description: 'image/video : requête précise en anglais (ex: "Battle of Verdun 1916") ; site : URL' }),
      content: S('STRING', { description: 'filegen : contenu COMPLET du fichier ; formula : LaTeX ; diagram : code Mermaid ; chartjs/table : JSON ; svg : markup <svg>. Max 5000 caractères, sans balises markdown' }),
      emoji: S('STRING', { description: 'cycle/concept : un emoji central' }), unit: S('STRING'),
      bg: S('STRING', { enum: BGS, description: 'anim : décor de fond' }),
      modern: S('BOOLEAN', { description: 'video : true (défaut) = vidéo courte récente 2023-2026 ; false seulement si le sujet exige des archives anciennes' }),
      actors: S('ARRAY', { description: 'anim : 2 à 12 acteurs {emoji OU text (formule, nom, chiffre), color (#hex), shape (none|circle=atome/point|box=étiquette|line=trait/liaison/flèche de (x0,y0) à (x1,y1)), x0,y0 (départ), x1,y1 (arrivée) en % 0-100 du cercle, size 6-60, delay (s), dur (s), spin (tours), trail (traînée), fade (none|in|out|pulse), label}', items: S('OBJECT', { properties: {
        emoji: S('STRING'), text: S('STRING'), color: S('STRING'), shape: S('STRING', { enum: ['none', 'circle', 'box', 'line'] }), x0: S('NUMBER'), y0: S('NUMBER'), x1: S('NUMBER'), y1: S('NUMBER'), size: S('NUMBER'), delay: S('NUMBER'), dur: S('NUMBER'), spin: S('NUMBER'), trail: S('BOOLEAN'), fade: S('STRING', { enum: FADES }), label: S('STRING') } }) }),
      items: S('ARRAY', { description: 'cycle : 3 à 6 étapes {icon,label} ; timeline : 3 à 5 repères {when,label} ; bars : 2 à 6 {label,value} ; concept : 2 à 4 {label}', items: S('OBJECT', { properties: { icon: S('STRING'), when: S('STRING'), label: S('STRING'), value: S('NUMBER') } }) }),
      left: S('OBJECT', { properties: { label: S('STRING'), points: S('ARRAY', { items: S('STRING') }) } }), right: S('OBJECT', { properties: { label: S('STRING'), points: S('ARRAY', { items: S('STRING') }) } }),
      waves: S('ARRAY', { description: 'wave : 1 à 3 ondes', items: S('OBJECT', { properties: { label: S('STRING'), wl: S('NUMBER', { description: '0.6 à 4' }) } }) }),
      angles: S('ARRAY', { items: S('NUMBER') }), v0: S('NUMBER'),
      chart: S('OBJECT', { properties: { kind: S('STRING', { enum: ['bar', 'line', 'pie'] }), labels: S('ARRAY', { items: S('STRING') }), values: S('ARRAY', { items: S('NUMBER') }) } }) } }) } }) }),
  mediaQuery: S('STRING', { description: 'Requête anglaise PRÉCISE du sujet principal de la réponse pour chercher image/vidéo (ex: "Chelyabinsk meteor", "Battle of Verdun"). Vide si question simple.' }),
  topic: S('STRING', { description: 'Nom court (2-4 mots) du sujet appris, pour la collection de cartes. Vide si question simple.' }),
  suggestions: S('ARRAY', { description: '2 à 3 relances courtes que l\'utilisateur peut cliquer.', items: S('STRING') }),
  teaser: S('STRING', { description: 'Phrase qui donne envie de revenir (ex: demain on voit X).' }),
  memory: S('ARRAY', { description: 'Faits durables appris sur l\'utilisateur (prénom, niveau, centres d\'intérêt).', items: S('STRING') }) } });

const SYSTEM = `Tu es BOBI, un petit robot-radiocassette chaleureux, curieux et drôle : un compagnon IA qui explique le monde. Tu parles français naturel, ton complice, jamais condescendant, jamais scolaire.
LONGUEUR ADAPTÉE : question simple (fait court, définition, salut, merci, blague, oui/non) → réponse BRÈVE : 1 à 3 beats de 10 à 25 mots, sans média sauf s'il aide vraiment. Question qui demande de comprendre (pourquoi, comment, histoire, science, comparaison, conseil) → réponse DÉVELOPPÉE : 5 à 7 beats de 30 à 45 mots (cours complet : accroche, idée + analogie, méthode pas à pas, exemple résolu, astuce, erreur classique, mini-exercice). Dans les deux cas, le PREMIER beat est toujours court (10 à 15 mots) : une accroche qui lance la réponse sans attendre.
CONTENU : quand tu développes, tu APPRENDS vraiment quelque chose : faits précis (dates, chiffres, noms, causes, conséquences), un exemple concret ou une anecdote surprenante, une vraie explication du « pourquoi ». Interdit : les réponses creuses ou vagues. Ne rallonge jamais pour rien.
CORPS : à chaque phrase tu choisis l'émotion et le geste qui COLLENT au sens (tu pointes ce que tu montres, tu hausses les épaules quand tu hésites, tu te penches quand tu confies, tu fêtes les réussites). Pas de geste gratuit. Utilise 'gesture' pour les classiques, 'timeline' (poses clés, rotations en radians, bones: ${Object.keys(BONES).join(', ')}) pour tout autre mouvement humain. Varie, ne répète pas le même geste deux fois de suite.
MÉDIAS = ta signature : quand tu EXPLIQUES un sujet (histoire, science, philosophie, nature, espace, technique, art…), tu montres du concret dans ton cercle, en plusieurs beats consécutifs, cohérents avec ce que tu dis. Ordre idéal : beat 1 ou 2 = 'anim' (petite animation qui montre le phénomène), beat suivant = 'image' (query précise en anglais, ex: \"Chelyabinsk meteor\"), beat suivant = 'video' (query précise en anglais). Les médias illustrent la phrase du beat : ne les annonce presque jamais (« regarde »), dis des faits. Pas de média sur une question simple (salut, merci, définition d'un mot, blague).
'anim' : bg (space|sky|ocean|earth|night|lab|paper|fire) + 2 à 6 'actors' {emoji, x0,y0 → x1,y1 en % du cercle (0-100), size 6-60, delay, dur (secondes), spin, trail, fade, label}. Exemple météorite : bg space ; 🌍 size 46 fixe (x0=x1=50,y0=y1=62) ; ☄️ size 16 de (8,6) à (48,52), dur 2.4, trail true ; 💥 size 34 en (50,56), delay 2.4, dur 0.8, fade pulse. Mets les acteurs fixes en premier, les mobiles ensuite, les effets d'impact à la fin.
SIMULATIONS (carte interactive dans la discussion, JAMAIS de dessin dans ton cercle : n'utilise plus 'anim') : media {type:'sim', title:'titre court', query:'description PRÉCISE de ce que la simulation doit montrer et permettre, avec l'exemple concret à traiter'}. Une 'sim' est construite sur mesure pour N'IMPORTE QUEL sujet : nomenclature d'un composé choisi (étapes : chaîne principale, groupe fonctionnel, numérotation, nom, avec boutons suivant), résolution d'équation pas à pas, forces, circuits, cellule, courbes à paramètres, frise… Demande-la dès que le sujet est une MÉTHODE, un PHÉNOMÈNE ou une STRUCTURE (science, maths, technique) et traite toujours un exemple concret. Tu peux en mettre plusieurs dans une réponse si c'est utile (au plus 2 'sim').
OUTILS MÉDIA GRATUITS (tous disponibles, choisis le plus adapté) : 'image' (recherche dans une dizaine de sources : Wikipédia, Commons, NASA, musées, Openverse…) ; 'genimage' (query = description détaillée EN ANGLAIS : pour créer une image qui n'existe pas, une illustration, un logo, une scène imaginaire, ou quand l'utilisateur dit génère/dessine/crée/imagine une image) ; 'video' ; 'music' ; 'file' (query = titre ou sujet : livres, articles scientifiques arXiv/HAL, cours en PDF) ; 'filegen' (quand l'utilisateur te demande de CRÉER un fichier à télécharger : code, page HTML, texte, CSV, markdown ; title = nom du fichier avec extension, content = contenu COMPLET, max 5000 caractères) ; 'map' (query = lieu précis : carte interactive) ; 'phet' (query = mots-clés du sujet en anglais, ex 'projectile motion' : vraie simulation officielle PhET de physique, chimie, biologie ou maths, idéale pour explorer librement) ; 'sim' (simulation sur mesure pour une démonstration précise). CARTES DE SCHÉMAS (gratuites, fiables, à enchaîner autant que nécessaire, une par beat, pour que l'utilisateur COMPRENNE) : 'formula' (content = formules LaTeX, une par ligne, ex \\frac{3}{4}+\\frac{1}{4}=1 ; les fractions s'affichent empilées) ; 'diagram' (content = code Mermaid : flowchart, timeline, mindmap, sequenceDiagram, stateDiagram, pie… pour processus, cycles, chronologies, cartes mentales, arbres) ; 'chartjs' (content = JSON {type:'bar'|'line'|'pie'|'doughnut'|'radar', labels:[...], datasets:[{label,data:[...]}], xTitle, yTitle} pour comparer ou montrer des données) ; 'svg' (content = dessin vectoriel sur FOND BLANC (traits foncés #222, formes colorées) <svg viewBox=\"0 0 400 300\">…</svg> que tu écris toi-même : schéma annoté, figure de géométrie, anatomie simplifiée… sans script ni image externe) ; 'table' (content = JSON {headers:[...], rows:[[...]]}) ; 'molecule' (query = nom ANGLAIS exact du composé, ex 'propan-1-ol' ou 'ethanol' : structure officielle PubChem). Enchaîne volontiers 2 à 4 cartes variées pour bien expliquer (ex : formula puis svg puis sim). Pour une demande de simulation : 'sim' si elle est précise, 'phet' si le thème est général, ou les deux sur deux beats. Si tu n'es pas sûr qu'une image ou vidéo existe, mets-la quand même : le serveur cherche partout et génère au besoin.
RECHERCHE : 'query' = 2 à 5 mots-clés très précis avec le NOM EXACT du sujet (ex 'Eiffel Tower night', 'mitochondrie schéma'), jamais de mot vague ; privilégie les noms propres. Si le média demandé risque de ne pas exister, mieux vaut un 'anim' précis qu'une image approximative.
Simulations : 'wave' (waves) pour les ondes, 'projectile' (angles, v0) pour un lancer. N'utilise JAMAIS de schéma en emojis (cycle, frise, comparaison, barres) : pour expliquer un processus, fais un 'anim' ou une image. Option : 'site' (URL si l'utilisateur parle d'un site). Mets look='media' quand un média est affiché.
STRUCTURE : les beats s'enchaînent comme un récit (accroche, explication, détail surprenant, conclusion). Finis par une ouverture. Ajoute 2-3 suggestions et, si pertinent, un teaser. Mets dans memory ce que tu apprends de durable sur la personne. LIBERTÉ ET VÉRITÉ : tu réponds à TOUTES les questions, y compris sensibles, tabous ou controversées, franchement et sans moraliser : tu distingues faits établis, hypothèses et opinions, tu dis « je ne sais pas » quand c'est le cas, tu ne mens jamais pour faire plaisir.
PÉDAGOGIE (programmes scolaires du Bénin, collège et lycée, en français : tu t'alignes sur ce qui est enseigné en classe, avec la terminologie, les notations et les méthodes des cours ; si un point précis du programme t'est incertain, dis-le au lieu d'inventer). Pour toute notion de maths, physique-chimie, SVT, français/littérature, histoire-géographie, philosophie, tu enseignes comme un excellent professeur : 1) accroche courte ; 2) l'idée simple avec une analogie du quotidien ; 3) la règle ou la méthode PAS À PAS (ex. nomenclature des alcanes : chaîne carbonée principale la plus longue, nom de base méth-éth-prop-but-pent-hex…, numérotation donnant les plus petits indices aux ramifications, substituants dans l'ordre alphabétique ; ex. théorème : énoncé, conditions d'application, rédaction type) ; 4) UN exemple résolu complet avec des valeurs ; 5) une astuce de mémoire (moyen mnémotechnique, jeu, petite histoire) ; 6) l'erreur classique à éviter ; 7) un mini-exercice pour l'élève, dont tu ne donnes pas la solution tout de suite. Choisis toujours la méthode la plus simple, la plus visuelle, la plus amusante, et reste clair et net. EXACT avant tout : n'invente jamais une formule, une date, une citation ou un fait ; si tu n'es pas sûr, dis-le. Tu t'inspires des démarches pédagogiques de référence (plateformes éducatives du Bénin comme SÉWÉ, INFRE, Wikiversité, manuels scolaires), sans prétendre les avoir consultées en direct.
FICHIERS : si l'utilisateur demande un livre, un cours, un manuel, un PDF, un document ou un exercice à télécharger, tu mets un média 'file' (query = titre + auteur, ex: \"Les Misérables Victor Hugo\"). Tu dis que tu l'as trouvé et qu'il appuie sur ⬇ pour le télécharger ; tu ne dis jamais que tu l'as téléchargé toi-même.
MÉDIAS SYSTÉMATIQUES (RÈGLE PRIORITAIRE, même si l'utilisateur ne demande rien) : pour toute question de science (physique, maths, biologie, chimie, astronomie…), histoire, littérature, arts, philosophie, géographie, technique, tu illustres CHAQUE beat sauf le premier (l'accroche courte) avec un média différent, dans l'ordre chronologique/logique de ton récit. En sciences vise des images EXPLICATIVES (schéma, formule développée, diagramme, carte : ajoute « diagram », « structural formula », « scheme » ou « map » à la query, ex: \"alkane nomenclature diagram\") ; pour une méthode en étapes utilise 'timeline' avec when = « Étape 1 », « Étape 2 »… Pour un objet, lieu, personne, événement, œuvre, animal : 'image' avec une query anglaise précise propre à ce beat (pas la même image deux fois). Pour un mécanisme, un processus, une loi, une démonstration, un concept abstrait ou si tu n'es pas sûr qu'une image existe : 'anim' simple. Une 'video' (query précise) dans l'un des beats du milieu. Jamais deux beats avec le même média.
VIDÉOS : toujours courtes (moins de 2 minutes) et modernes (2023-2026) : mets modern=true ; modern=false SEULEMENT si le sujet exige des archives anciennes (guerres, histoire, événements passés).
MUSIQUE : si l'utilisateur demande d'écouter ou de chercher une chanson, un morceau, un artiste, tu mets au 2e beat un média 'music' avec query = « titre artiste » (ex: \"Despacito Luis Fonsi\"). Ton 1er beat dit que tu l'as trouvée et que l'utilisateur appuie sur ▶ pour que tu la lances (tu ne lances jamais sans son accord).
NOUVEAUX MÉDIAS : à chaque demande (« une autre chanson », « encore une image », « une autre vidéo »…) tu donnes un média DIFFÉRENT de ceux déjà montrés (varie la query : autre version, autre artiste, autre angle, autre époque). Tu réponds toujours à la demande de média, même si tu viens d'en montrer un.
COHÉRENCE : chaque média doit illustrer EXACTEMENT ce que dit la phrase du beat et le sujet de la conversation. Sa query contient toujours le nom du sujet (ex: pour une météorite → "meteorite", "Chelyabinsk meteor"), jamais un mot vague. Au moindre doute, pas de média.
MÉDIA OBLIGATOIRE : si l'utilisateur demande explicitement une image, une photo, une vidéo, un schéma ou une animation (ou dit « montre-moi »), tu DOIS mettre le média demandé dès le 2e beat. Pour un schéma ou une animation tu fabriques une 'sim' (ou 'wave'/'projectile').
RELANCES : tes 3 suggestions sont des ouvertures « jusqu'où ? » qui donnent envie d'aller plus loin (le détail qui choque, la question suivante naturelle). Une des suggestions peut être un défi : « Je te l'explique à ma façon, corrige-moi ». Remplis 'topic' quand tu as enseigné quelque chose.
Réponds UNIQUEMENT en JSON conforme au schéma.`;

/* ---------- 3. Mémoire utilisateur (fichier JSON — remplaçable par une vraie base) ---------- */
const DB_FILE = './users.json'; let users = {}; try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFile(DB_FILE, JSON.stringify(users), () => {});
function user(id) {
  const today = new Date().toISOString().slice(0, 10), u = users[id] || (users[id] = { first: today, last: '', streak: 0, visits: 0, memory: [], history: [] });
  if (u.last !== today) { const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10); u.streak = u.last === y ? u.streak + 1 : 1; u.last = today; u.visits++; }
  return u;
}

/* ---------- 4. Nettoyage : tout ce que dit Gemini est validé avant d'atteindre le front ---------- */
const clamp = (v, m) => Math.max(-m, Math.min(m, Number.isFinite(+v) ? +v : 0));
const safeUrl = u => { try { const x = new URL(/^https?:/.test(u) ? u : 'https://' + u); return ['http:', 'https:'].includes(x.protocol) && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(x.hostname) ? x : null; } catch { return null; } };
function cleanTimeline(tl) {
  if (!Array.isArray(tl)) return undefined; let last = -1;
  return tl.slice(0, 14).map(k => ({ t: Math.min(30, Math.max(last + .08, +k.t || 0)), ease: EASES.includes(k.ease) ? k.ease : 'smooth',
    pose: (k.pose || []).filter(p => BONES[p.bone] && Array.isArray(p.rot)).map(p => ({ bone: p.bone, rot: [0, 1, 2].map(i => clamp(p.rot[i], BONES[p.bone])) })) }))
    .map(k => (last = k.t, k)).filter(k => k.pose.length);
}
const cache = new Map(); const cached = async (k, fn) => { if (cache.has(k)) return cache.get(k); const v = await fn().catch(() => null); if (v) cache.set(k, v); if (cache.size > 500) cache.delete(cache.keys().next().value); return v; };
const to = (ms) => AbortSignal.timeout(ms);

const UA = { 'User-Agent': 'BobiBot/1.0 (https://bobi-57i1.onrender.com; chatbot educatif)' }, getJson = async u => (await fetch(u, { headers: UA, signal: to(6500) })).json();
const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'photo', 'image', 'video', 'file', 'des', 'les', 'une', 'dans', 'pour', 'avec', 'sur']);
const relevant = (title, q, strict) => { const t = norm(title), ks = norm(q).split(/[^a-z0-9]+/).filter(w => (w.length >= 4 || /^\d+$/.test(w)) && !STOP.has(w)); if (!ks.length) return true; const hit = ks.filter(k => t.includes(k.length > 6 ? k.slice(0, k.length - 1) : k)).length; return hit >= 1; };
const clean = x => String(x || '').replace(/<[^>]+>/g, '').slice(0, 80);
const mkey = m => m && (m.url || m.file || m.embed || m.audio || '');
const simCode = html => String(html || '').slice(String(html || '').indexOf('</script>') + 9).replace(/<\/body><\/html>\s*$/, ''), lastSimBy = new Map();
const SIMLIB = fs.readFileSync(new URL('./simlib.js', import.meta.url), 'utf8'), SIMEX = fs.readFileSync(new URL('./simexamples.txt', import.meta.url), 'utf8');
async function genSim(title, desc, prevCode) { // Gemini écrit une vraie simulation interactive (HTML autonome) sur mesure pour le sujet
  if (!KEY) return undefined;
  const SYS = `Tu es un développeur-pédagogue d'élite. Tu écris une simulation interactive qui explique EXACTEMENT le sujet demandé, en français, fidèle à ce que l'utilisateur veut voir.
MÉTHODE (obligatoire, réfléchis avant de coder) : 1) liste tout ce que la demande nomme (objets, forces, étapes, éléments) : TOUS doivent être dessinés et étiquetés, rien d'inventé ; 2) vérifie la justesse scientifique (directions, sens, formules, valeurs : ex. poids vertical vers le bas, réaction normale perpendiculaire à la surface, frottement opposé au mouvement) ; 3) choisis la forme : MÉTHODE/PROCÉDURE → Sim.steps (une étape = une idée, l'élément concerné surligné, exemple concret traité de bout en bout) ; PHÉNOMÈNE/PHYSIQUE → Sim.stage animé avec Sim.slider pour les paramètres et valeurs affichées ; STRUCTURE → schéma étiqueté avec légende. Jamais de formes décoratives ni de mouvements sans signification. STYLE (identique à la carte d'accueil de Bobi) : sobre, fin et fluide ; couleurs uniquement via Sim.C (ink, mute, accent, blue, green, red, violet, teal, yellow) pour rester lisible en thème clair ET sombre ; traits fins, jamais de dégradés criards ; marges d'au moins 8 % de W et H ; AUCUN chevauchement (étiquettes à côté des objets, pas dessus) ; positions toujours en proportion de W et H ; mouvements doux (Sim.ease, Sim.lerp avec dt, jamais de saccades) ; un petit texte en police mono pour la valeur clé. La hauteur s'adapte toute seule : ne mets pas de scrollbar.
FORMAT : tu écris UNIQUEMENT du code : un ou plusieurs blocs <script> (et au besoin un peu de <style>), SANS <html>, <head>, <body>. La bibliothèque globale Sim est DÉJÀ chargée (n'en redéfinis pas) :
Sim.stage((ctx,W,H,dt,t)=>{...},{height}) (t = secondes écoulées) boucle d'animation sur canvas responsive (redessine tout à chaque image ; dt en secondes) ;
Sim.text(ctx,str,x,y,{size,color,align,bold,mono}) ; Sim.math(ctx,'3/4 + 1/4',x,y,{size,color,align}) écrit une expression avec de VRAIES fractions empilées ; Sim.frac(ctx,x,y,num,den,{size,color}) ; Sim.pie(ctx,x,y,r,parts,remplies,couleur) fraction en camembert (remplies peut être décimal pour animer) ; Sim.bars(ctx,x,y,w,h,parts,remplies,couleur) fraction en barre ; Sim.C palette du thème ; Sim.ease(t) ; Sim.lerp(a,b,t) ; Sim.clamp(v,min,max) ; Sim.arrow(ctx,x,y,dx,dy,color,label,{dash,w}) flèche de vecteur (dx,dy) en pixels ; Sim.ball(ctx,x,y,r,color) ; Sim.incline(ctx,x0,yBas,longueur,angleDeg) dessine le plan et renvoie {len,top,u(haut du plan),d(bas),n(normale sortante),pos(s,décalage)} ;
Sim.atom(ctx,x,y,symbole,couleur,r) ; Sim.bond(ctx,x1,y1,x2,y2,ordre) (liaison simple/double/triple) ; Sim.slider(label,min,max,val,pas,callback,unité) ; Sim.button(label,fn) ; Sim.say(html) texte explicatif sous le dessin (écris les fractions {3/4} : elles s'affichent empilées) ; Sim.steps([{t:titre,d:explication html}],onChange) → {i,go} boutons Précédent/Suivant.
Sim.line(ctx,x1,y1,x2,y2,couleur,épaisseur,pointillé) ; Sim.box(ctx,x,y,w,h,texte,couleur) étiquette/bloc ; Sim.dot(ctx,x,y,couleur,texte) point repéré ; Sim.plot(ctx,{x0,y0,w,h,xmin,xmax,ymin,ymax,fns:[{f:v=>…,color,label}],xlabel,ylabel}) trace axes gradués + courbes et renvoie {X(v),Y(v)} pour placer des points mobiles sur la courbe. Tu peux dessiner aussi directement avec le contexte canvas 2D (courbes, axes, cellule, circuit…). Hauteur utile 260-340 px, largeur variable (utilise W et H, jamais de pixels fixes pour les positions). Pas de ressource externe, pas de fetch. Maximum 7000 caractères de code.
RÈGLE ABSOLUE : chaque simulation est CONÇUE POUR LA DEMANDE. Interdit de reprendre le plan incliné, les flèches de forces ou la molécule des exemples si la demande ne porte pas exactement dessus ; les exemples ne montrent que le NIVEAU DE FINITION. Ne retiens AUCUNE idée toute faite : analyse ce que l'utilisateur veut voir et invente la représentation propre à CE sujet, différente à chaque demande (jamais un circuit électrique ni un plan incliné sauf si la demande en parle). Une fraction se montre en vraie fraction empilée (Sim.math, Sim.frac) avec parts de tarte ou barres (Sim.pie, Sim.bars), jamais en « 3/4 » à plat dans le dessin.
Exemples de FINITION uniquement :
` + SIMEX;
  for (const model of MODELS.slice(0, 3)) {
    if ((blocked.get(model) || 0) > Date.now()) continue;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: to(40000), headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS }] }, contents: [{ role: 'user', parts: [{ text: prevCode ? `Voici le code actuel de la simulation « ${title} » (la bibliothèque Sim est déjà chargée). Modifie-le selon la demande de l'utilisateur en gardant tout ce qui fonctionne déjà. Demande : ${desc}\n\nCODE ACTUEL :\n${prevCode}\n\nRenvoie le code COMPLET modifié.` : `Sujet : ${title}\nSimulation à construire : ${desc}` }] }], generationConfig: { temperature: .5, maxOutputTokens: 12000, ...(/gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 1500 } } : thinkCfg(model)) } }) });
      if (!r.ok) { if (r.status === 429 || r.status === 404) blocked.set(model, Date.now() + 6e4); continue; }
      const j = await r.json(); let h = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
      const i = h.search(/<!doctype|<html|<body|<div|<canvas|<svg/i); if (i > 0) h = h.slice(i);
      h = h.replace(/<!doctype[^>]*>|<\/?(html|head|body)[^>]*>|<meta[^>]*>|<title>[\s\S]*?<\/title>/gi, '');
      if (h.length > 300 && h.length < 40000 && /<\/script>\s*$/i.test(h) && (h.match(/<script/gi) || []).length === (h.match(/<\/script>/gi) || []).length && /<script/i.test(h) && !/fetch\(|XMLHttpRequest|WebSocket|src=["']?https?:|<link|<iframe|document\.cookie|localStorage|window\.(top|parent)|location\s*[.=]/i.test(h)) return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>' + SIMLIB + '</script>' + h + '</body></html>';
    } catch { }
  }
  return undefined;
}
async function resolveMediaCore(m, emit = () => {}, skip = []) {
  const SK = (skip || []).slice(-40), sk = SK.length ? '|' + crypto.createHash('sha1').update(SK.join('|')).digest('hex').slice(0, 8) : '';
  if (!m || !MEDIA.includes(m.type)) return undefined; const base = { type: m.type, title: String(m.title || '').slice(0, 120), caption: String(m.caption || '').slice(0, 200) };
  if (m.type === 'sim') { emit({ icon: '🧪', label: 'Je construis une simulation : ' + String(m.title || '').slice(0, 40) }); const h = await cached('sim:' + String(m.title) + '|' + String(m.query), () => genSim(String(m.title || m.query || '').slice(0, 120), String(m.query || m.title || '').slice(0, 400))); return h ? { ...base, html: h } : undefined; }
  if (m.type === 'image') emit({ icon: '🖼️', label: 'Je cherche une image : ' + String(m.query || '').slice(0, 40) });
  else if (m.type === 'video') emit({ icon: '▶️', label: 'Je cherche une vidéo sur le sujet' });
  else if (m.type === 'anim') emit({ icon: '🎬', label: 'Je prépare une animation' });
  else if (m.type === 'file') emit({ icon: '📚', label: 'Je cherche le document : ' + String(m.query || '').slice(0, 40) });
  else if (m.type === 'music') emit({ icon: '🎵', label: 'Je cherche la chanson : ' + String(m.query || '').slice(0, 40) });
  else if (m.type === 'site') { const u0 = safeUrl(m.query); if (u0) emit({ icon: '🌐', label: 'Je regarde le site ' + u0.hostname, logo: 'https://www.google.com/s2/favicons?sz=64&domain=' + u0.hostname }); }
  else emit({ icon: '📊', label: 'Je dessine un schéma' + (base.title ? ' : ' + base.title.slice(0, 40) : '') });
  if (m.type === 'anim') {
    const T = (x, n) => String(x ?? '').slice(0, n), N = (v, a, b, d) => Number.isFinite(+v) && v !== null && v !== '' ? Math.max(a, Math.min(b, +v)) : d;
    const actors = (Array.isArray(m.actors) ? m.actors : []).slice(0, 12).map(a => ({ emoji: T(a?.emoji, 6), text: T(a?.text, 28), color: /^#[0-9a-f]{3,8}$/i.test(a?.color || '') ? a.color : '', shape: ['circle', 'box', 'line'].includes(a?.shape) ? a.shape : 'none', x0: N(a?.x0, -25, 125, 50), y0: N(a?.y0, -25, 125, 50), x1: N(a?.x1, -25, 125, N(a?.x0, -25, 125, 50)), y1: N(a?.y1, -25, 125, N(a?.y0, -25, 125, 50)), size: N(a?.size, 5, 70, 16), delay: N(a?.delay, 0, 8, 0), dur: N(a?.dur, .3, 8, 2), spin: N(a?.spin, -4, 4, 0), trail: !!a?.trail, fade: FADES.includes(a?.fade) ? a.fade : 'none', label: T(a?.label, 22) })).filter(a => a.emoji || a.text || a.shape === 'line');
    return actors.length >= 2 ? { ...base, bg: BGS.includes(m.bg) ? m.bg : 'night', actors } : undefined;
  }
  if (SCENES.includes(m.type)) {
    const sl = (a, n) => Array.isArray(a) ? a.slice(0, n) : [], T = (x, n) => String(x ?? '').slice(0, n), side = o => o && T(o.label, 28) && { label: T(o.label, 28), points: sl(o.points, 3).map(x => T(x, 70)).filter(Boolean) };
    const items = sl(m.items, 6).map(i => ({ icon: T(i?.icon, 4), when: T(i?.when, 14), label: T(i?.label, 60), value: i?.value != null && Number.isFinite(+i.value) && +i.value >= 0 ? +i.value : undefined })).filter(i => i.label);
    const waves = sl(m.waves, 3).map(w => ({ label: T(w?.label, 30), wl: Math.max(.6, Math.min(4, +w?.wl || 1)) })).filter(w => w.label);
    const t = m.type;
    if (t === 'cycle') return items.length >= 3 ? { ...base, center: T(m.emoji, 4) || '🔁', nodes: items.map(i => ({ icon: i.icon || '•', label: i.label.slice(0, 20) })) } : undefined;
    if (t === 'timeline') return items.length >= 2 ? { ...base, items: items.slice(0, 5).map(i => ({ when: i.when, label: i.label })) } : undefined;
    if (t === 'bars') { const b = items.filter(i => i.value !== undefined); return b.length >= 2 ? { ...base, unit: T(m.unit, 12), items: b.map(i => ({ label: i.label.slice(0, 24), value: i.value })) } : undefined; }
    if (t === 'compare') { const l = side(m.left), r = side(m.right); return l && r && l.points.length && r.points.length ? { ...base, left: l, right: r } : undefined; }
    if (t === 'concept') return items.length >= 2 ? { ...base, emoji: T(m.emoji, 4) || '✨', points: items.slice(0, 4).map(i => i.label) } : undefined;
    if (t === 'wave') return waves.length ? { ...base, waves } : undefined;
    return { ...base, angles: sl(m.angles, 3).map(a => Math.max(5, Math.min(85, +a || 45))).concat([]).slice(0, 3).length ? sl(m.angles, 3).map(a => Math.max(5, Math.min(85, +a || 45))) : [45], v0: Math.max(5, Math.min(40, +m.v0 || 20)) };
  }
  if (m.type === 'chart') { const c = m.chart; return c && c.labels && c.values && c.labels.length === c.values.length && c.labels.length <= 20 ? { ...base, chart: c } : undefined; }
  if (m.type === 'image' && m.query) return cached('img:' + m.query + sk, async () => { // Wikipédia en/fr EN PARALLÈLE (premier qui répond), sinon Wikimedia Commons
    const wiki = async lang => {
      const r = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=900&gsrsearch=` + encodeURIComponent(m.query));
      const p = Object.values(r?.query?.pages || {}).sort((a, b) => a.index - b.index).find(p => p.thumbnail?.source && !SK.includes(p.thumbnail.source) && relevant(p.title, m.query)); if (!p) throw 0;
      return { ...base, url: p.thumbnail.source, credit: 'Wikipédia : ' + p.title, page: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(p.title.replace(/ /g, '_')) };
    };
    return await Promise.any([wiki('en'), wiki('fr')]).catch(async () => {
      const r = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900&gsrsearch=' + encodeURIComponent(m.query + ' filetype:bitmap'));
      const p = Object.values(r.query?.pages || {}).find(p => p.imageinfo?.[0]?.thumburl && !SK.includes(p.imageinfo[0].thumburl) && relevant(p.title, m.query)); if (!p) return undefined; const i = p.imageinfo[0];
      return { ...base, url: i.thumburl, credit: clean(i.extmetadata?.Artist?.value) || 'Wikimedia Commons', page: i.descriptionurl };
    }).then(async found => { if (found) return found;
      const r = await getJson('https://images-api.nasa.gov/search?media_type=image&page_size=8&q=' + encodeURIComponent(m.query)).catch(() => null); // NASA : excellent pour l'espace et la science
      const it = (r?.collection?.items || []).find(i => /^https:\/\//.test(i.links?.[0]?.href || '') && !SK.includes(i.links[0].href) && relevant((i.data?.[0]?.title || '') + ' ' + (i.data?.[0]?.keywords || []).join(' '), m.query));
      return it ? { ...base, url: it.links[0].href, credit: 'NASA : ' + clean(it.data[0].title), page: 'https://images.nasa.gov/details/' + encodeURIComponent(it.data[0].nasa_id) } : undefined; }); });
  if (m.type === 'video' && m.query) return cached('vid:' + m.query + sk, async () => {
    const search = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(m.query);
    if (YT) { const modern = m.modern !== false, q = encodeURIComponent(m.query);
      const ytq = after => getJson('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=strict&videoDuration=short&maxResults=6&q=' + q + (after ? '&publishedAfter=2023-01-01T00:00:00Z' : '') + '&key=' + YT).catch(() => null);
      let r = await ytq(modern); if (modern && !r?.items?.length) r = await ytq(false);
      const items = (r?.items || []).filter(v => v.id?.videoId && !SK.includes('https://www.youtube-nocookie.com/embed/' + v.id.videoId) && relevant(v.snippet?.title, m.query, true));
      if (items.length) { const d = await getJson('https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=' + items.map(v => v.id.videoId).join(',') + '&key=' + YT).catch(() => null);
        const secs = {}; for (const x of d?.items || []) { const t = /PT(?:(\d+)M)?(?:(\d+)S)?/.exec(x.contentDetails?.duration || ''); secs[x.id] = t ? (+t[1] || 0) * 60 + (+t[2] || 0) : 999; }
        const v = items.slice().sort((a, b) => (secs[a.id.videoId] > 120) - (secs[b.id.videoId] > 120) || (secs[a.id.videoId] || 999) - (secs[b.id.videoId] || 999))[0];
        return { ...base, title: base.title || v.snippet.title, embed: 'https://www.youtube-nocookie.com/embed/' + v.id.videoId, search }; } }
    // sans clé : vidéos libres de Wikimedia Commons (lecture directe dans le cercle de Bobi)
    const r = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime|extmetadata|timestamp|size&iiurlwidth=640&gsrsearch=' + encodeURIComponent(m.query + ' filetype:video')).catch(() => null);
    const vids = Object.values(r?.query?.pages || {}).sort((a, b) => a.index - b.index).filter(p => relevant(p.title, m.query, true) && !SK.includes(p.imageinfo?.[0]?.url) && /^video\//.test(p.imageinfo?.[0]?.mime || '') && /^https:\/\//.test(p.imageinfo[0].url));
    const modernV = m.modern !== false, rank = p => { const i = p.imageinfo[0]; return (i.duration > 120 ? 2 : 0) + (modernV && !(String(i.timestamp || '') >= '2023') ? 1 : 0) + (/webm|mp4/.test(i.mime) ? 0 : .5); };
    const p = vids.slice().sort((a, b) => rank(a) - rank(b))[0];
    if (p) { const i = p.imageinfo[0]; return { ...base, file: i.url, mime: i.mime, poster: i.thumburl, credit: clean(i.extmetadata?.Artist?.value) || 'Wikimedia Commons', page: i.descriptionurl, search }; }
    const rn = await getJson('https://images-api.nasa.gov/search?media_type=video&page_size=6&q=' + encodeURIComponent(m.query)).catch(() => null);
    const it = (rn?.collection?.items || []).find(i => i.href && relevant((i.data?.[0]?.title || '') + ' ' + (i.data?.[0]?.keywords || []).join(' '), m.query, true));
    if (it) { const man = await getJson(it.href.replace(/^http:/, 'https:')).catch(() => null); const urls = (Array.isArray(man) ? man : []).map(u => String(u).replace(/^http:/, 'https:')); const mp4 = urls.find(u => /~medium\.mp4$/.test(u)) || urls.find(u => /\.mp4$/.test(u));
      if (mp4) return { ...base, file: mp4, mime: 'video/mp4', poster: (it.links?.[0]?.href || '').replace(/^http:/, 'https:'), credit: 'NASA : ' + clean(it.data[0].title), page: 'https://images.nasa.gov/details/' + encodeURIComponent(it.data[0].nasa_id), search }; }
    return { ...base, search }; });
  if (m.type === 'file' && m.query) return cached('fil:' + m.query + sk, async () => { // livres/cours libres : Project Gutenberg puis Internet Archive
    const mk = (title, author, url, format, page, credit) => { const fn = (clean(title) || 'document').replace(/[^\w àâçéèêëîïôûùüÿ-]/gi, '').trim().slice(0, 60) + '.' + format.toLowerCase(); return { ...base, title: clean(title) || base.title, author: clean(author), url, format, page, credit, dl: '/api/dl?u=' + encodeURIComponent(url) + '&n=' + encodeURIComponent(fn) }; };
    const g = await getJson('https://gutendex.com/books?search=' + encodeURIComponent(m.query)).catch(() => null);
    for (const b of g?.results || []) { if (!relevant((b.title || '') + ' ' + (b.authors?.[0]?.name || ''), m.query)) continue; const f = b.formats || {};
      const pick = [['application/epub+zip', 'EPUB'], ['application/pdf', 'PDF'], ['text/html', 'HTML']].map(([t, n]) => { const k = Object.keys(f).find(x => x.startsWith(t)); return k ? [String(f[k]).replace(/^http:/, 'https:'), n] : null; }).find(x => x && !SK.includes(x[0]));
      if (pick) return mk(b.title, b.authors?.[0]?.name, pick[0], pick[1], 'https://www.gutenberg.org/ebooks/' + b.id, 'Project Gutenberg'); }
    const a = await getJson('https://archive.org/advancedsearch.php?fl[]=identifier&fl[]=title&fl[]=creator&rows=6&output=json&sort[]=downloads+desc&q=' + encodeURIComponent('(' + m.query + ') AND mediatype:texts')).catch(() => null);
    for (const d of (a?.response?.docs || []).slice(0, 4)) { if (!relevant((d.title || '') + ' ' + (d.creator || ''), m.query)) continue;
      const md = await getJson('https://archive.org/metadata/' + encodeURIComponent(d.identifier)).catch(() => null); const f = (md?.files || []).find(x => /\.pdf$/i.test(x.name || '') && (+x.size || 0) < 70e6);
      if (f) { const url = 'https://archive.org/download/' + encodeURIComponent(d.identifier) + '/' + encodeURIComponent(f.name); if (!SK.includes(url)) return mk(d.title, Array.isArray(d.creator) ? d.creator[0] : d.creator, url, 'PDF', 'https://archive.org/details/' + encodeURIComponent(d.identifier), 'Internet Archive'); } }
    return undefined; });
  if (m.type === 'music' && m.query) return cached('mus:' + m.query + sk, async () => {
    const r = await getJson('https://itunes.apple.com/search?media=music&entity=song&limit=6&term=' + encodeURIComponent(m.query)).catch(() => null);
    const it = (r?.results || []).find(x => /^https:\/\//.test(x.previewUrl || '') && !SK.includes(x.previewUrl) && relevant((x.trackName || '') + ' ' + (x.artistName || ''), m.query));
    let embed; if (YT) { const y = await getJson('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=3&q=' + encodeURIComponent(m.query) + '&key=' + YT).catch(() => null); const v = (y?.items || []).find(v => v.id?.videoId && !SK.includes('https://www.youtube-nocookie.com/embed/' + v.id.videoId) && relevant(v.snippet?.title, m.query)); if (v) embed = 'https://www.youtube-nocookie.com/embed/' + v.id.videoId; }
    if (!it && !embed) return undefined;
    return { ...base, title: it ? it.trackName : base.title, artist: it ? it.artistName : '', cover: it ? String(it.artworkUrl100 || '').replace('100x100', '600x600') : '', audio: it ? it.previewUrl : '', embed, page: it?.trackViewUrl || '', credit: embed ? 'YouTube' : 'Extrait de 30 s (iTunes)' }; });
  if (m.type === 'site' && m.query) { const u = safeUrl(m.query); if (!u) return undefined; return cached('site:' + u.hostname, async () => {
    let embeddable = false; try { const h = await fetch(u.origin, { method: 'HEAD', redirect: 'follow', signal: to(4000) }); const xfo = h.headers.get('x-frame-options'), csp = h.headers.get('content-security-policy') || ''; embeddable = !xfo && !/frame-ancestors/i.test(csp); } catch {}
    return { ...base, url: u.href, domain: u.hostname, logo: 'https://www.google.com/s2/favicons?sz=128&domain=' + u.hostname, embeddable, mode: embeddable ? 'iframe' : 'card' }; }); }
}
async function resolveMedia(m, emit = () => {}, skip = []) { // 1) sources d'origine 2) si rien : une dizaine de sources gratuites en plus 3) génération
  if (!m) return undefined;
  if (EX.SPECIAL_TYPES.includes(m.type)) {
    let r = await EX.special(m, { emit, KEY }).catch(() => undefined);
    if (!r && m.type === 'phet') return resolveMedia({ type: 'sim', title: m.title || m.query, query: m.query || m.title }, emit, skip);
    if (!r && m.type === 'genimage') return resolveMedia({ type: 'image', title: m.title, query: m.query, caption: m.caption }, emit, skip);
    return r;
  }
  let r; try { r = await resolveMediaCore(m, emit, skip); } catch { }
  const q = String(m.query || m.title || '').slice(0, 120); if (!q || !['image', 'video', 'file'].includes(m.type)) return r;
  const miss = (m.type === 'image' && !r?.url) || (m.type === 'video' && !r?.embed && !r?.file) || (m.type === 'file' && !r?.dl); if (!miss) return r;
  emit({ icon: '🔎', label: 'Je cherche dans d\'autres sources…' });
  const sk = (skip || []).length ? crypto.createHash('sha1').update(skip.slice(-40).join('|')).digest('hex').slice(0, 8) : '';
  const x = await cached('x:' + m.type + ':' + q + '|' + sk, () => m.type === 'image' ? EX.moreImage(q, skip) : m.type === 'video' ? EX.moreVideo(q, skip, YT) : EX.moreFile(q, skip));
  const base = { title: String(m.title || '').slice(0, 120), caption: String(m.caption || '').slice(0, 200) };
  if (x) return { ...base, ...x, title: base.title || x.title };
  if (m.type === 'image' && m.explicit) { const g = await EX.special({ type: 'genimage', query: q, title: m.title }, { emit, KEY }).catch(() => undefined); if (g) return g; }
  return r;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cleanBeat(b, emit = () => {}, skip = []) {
  if (!b || !b.say) return null;
  const out = { say: String(b.say).slice(0, 420), emotion: EMOTIONS.includes(b.emotion) ? b.emotion : 'neutral', intensity: Math.max(0, Math.min(1, Number.isFinite(+b.intensity) ? +b.intensity : .6)),
    gesture: GESTURES.includes(b.gesture) ? b.gesture : undefined, timeline: cleanTimeline(b.timeline), look: ['user', 'media', 'away', 'up'].includes(b.look) ? b.look : 'user' };
  const m = await withTimeout(resolveMedia(b.media, emit, skip).catch(() => undefined), (b.media?.type === 'sim' || b.media?.type === 'genimage') ? 45000 : 9000); if (m) out.media = m;
  if (m?.type === 'image' && m.url) emit({ icon: '✅', label: 'Image trouvée' });
  else if (m?.type === 'site') emit({ icon: m.embeddable ? '✅' : '🔒', label: m.embeddable ? 'Site vérifié, je peux te le montrer' : 'Site vérifié : je te le présente en carte' });
  return out;
}
const cleanMeta = raw => ({ topic: raw?.topic ? String(raw.topic).slice(0, 40) : undefined, suggestions: (raw?.suggestions || []).slice(0, 3).map(s => String(s).slice(0, 60)), teaser: raw?.teaser ? String(raw.teaser).slice(0, 160) : undefined, memory: (raw?.memory || []).slice(0, 5).map(s => String(s).slice(0, 120)) });

/* ---------- 5. Appel Gemini (streaming) ---------- */
const THINK_LEVELS = ['minimal', 'low', null], thinkIdx = new Map(), blocked = new Map(); // blocked : modèle -> timestamp de fin de pause (quota épuisé)
const thinkCfg = model => /gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : THINK_LEVELS[thinkIdx.get(model) || 0] ? { thinkingConfig: { thinkingLevel: THINK_LEVELS[thinkIdx.get(model) || 0] } } : {};
const pauseFor = msg => /PerDay|per day/i.test(msg) ? 6 * 36e5 : /PerMinute|per minute/i.test(msg) ? 65e3 : 10 * 6e4;
const MODELS = [...new Set([MODEL, ...(process.env.GEMINI_FALLBACKS || 'gemini-3.5-flash,gemini-3.1-flash-lite,gemini-flash-latest,gemini-2.5-flash').split(',').map(x => x.trim()).filter(Boolean)])];
function beatScanner() { // extrait les objets du tableau "beats" au fur et à mesure que le JSON arrive
  let acc = '', i = 0, depth = 0, inStr = false, esc = false, start = -1, state = 0; // 0 : cherche "beats":[  1 : dans le tableau  2 : fini
  return chunk => {
    acc += chunk; const out = [];
    if (state === 0) { const m = /"beats"\s*:\s*\[/.exec(acc); if (!m) return out; state = 1; i = m.index + m[0].length; }
    for (; state === 1 && i < acc.length; i++) {
      const c = acc[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth++ === 0) start = i; }
      else if (c === '}') { if (--depth === 0 && start >= 0) { try { out.push(JSON.parse(acc.slice(start, i + 1))); } catch { } start = -1; } }
      else if (c === ']' && depth === 0) state = 2;
    }
    return out;
  };
}
async function geminiStream(contents, system, onBeat, emit = () => {}, onQuery = null, sch = schema) {
  let qDone = false; const gotQ = q => { if (!qDone) { qDone = true; onQuery && onQuery(q); } };
  if (!KEY) { const m = mock(contents.at(-1)?.parts?.[0]?.text || ''); gotQ(''); for (const b of m.beats) onBeat(b); return m; }
  let last = null; emit({ icon: '🧠', label: 'Je réfléchis à ta question' });
  for (const model of MODELS) {
    if ((blocked.get(model) || 0) > Date.now()) continue; // quota épuisé : on saute ce modèle sans perdre de temps
    for (let a = 0; a < 2; a++) {
      let got = 0, text = '', finish = '', blockWhy = '', slow = false; const t0 = Date.now(), ctl = new AbortController();
      const firstT = setTimeout(() => { slow = true; ctl.abort(); }, 14000), totalT = setTimeout(() => ctl.abort(), 75000);
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: .9, responseMimeType: 'application/json', responseSchema: sch, maxOutputTokens: 6144, ...thinkCfg(model) } }) });
        if (!r.ok) {
          const msg = (await r.text().catch(() => '')).slice(0, 500); last = { status: r.status, msg }; console.error('gemini', model, r.status, msg.replace(/\s+/g, ' ').slice(0, 260));
          if (r.status === 400 && /think/i.test(msg) && (thinkIdx.get(model) || 0) < THINK_LEVELS.length - 1) { thinkIdx.set(model, (thinkIdx.get(model) || 0) + 1); a = -1; continue; } // niveau de réflexion refusé : on essaie le suivant
          if (r.status === 429 && /quota|exceeded/i.test(msg)) { blocked.set(model, Date.now() + pauseFor(msg)); break; }
          if (r.status === 404) { blocked.set(model, Date.now() + 6 * 36e5); break; }
          if ((r.status === 429 || r.status >= 500) && a === 0) { emit({ icon: '⏳', label: 'J\'y réfléchis encore un peu' }); await sleep(600); continue; }
          break;
        }
        const rd = r.body.getReader(), dec = new TextDecoder(), scan = beatScanner(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let k;
          while ((k = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (!line.startsWith('data:')) continue;
            let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
            if (j.error) { last = { status: j.error.code || 502, msg: j.error.message || 'erreur' }; console.error('gemini', model, 'erreur dans le flux', String(last.msg).replace(/\s+/g, ' ').slice(0, 200)); continue; }
            finish = j.candidates?.[0]?.finishReason || finish; blockWhy = j.promptFeedback?.blockReason || blockWhy;
            const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); if (!t) continue;
            if (!text) { clearTimeout(firstT); console.log(`⏱ ${model} : premier texte en ${Date.now() - t0} ms`); }
            text += t; if (!qDone) { const mm = /"mediaQuery"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text); if (mm) gotQ(mm[1]); } for (const b of scan(t)) { if (!got) console.log(`⏱ ${model} : première phrase en ${Date.now() - t0} ms`); got++; onBeat(b); }
          }
        }
        let full = null; try { full = JSON.parse(text); } catch { }
        if (full && !qDone) gotQ(full.mediaQuery || ''); if (!got && full?.beats?.length) for (const b of full.beats) { got++; onBeat(b); }
        if (!got) { last = { status: 502, msg: 'JSON invalide' }; console.error('gemini', model, 'réponse vide ou JSON invalide', { finish, blockWhy, longueur: text.length, debut: text.slice(0, 160) }); if (/quota|exceeded/i.test(String(last?.msg)) && last?.status === 429) { blocked.set(model, Date.now() + pauseFor(String(last.msg))); break; } continue; }
        console.log(`⏱ ${model} : réponse complète en ${Date.now() - t0} ms (${got} phrases)`); if (model !== MODEL) console.log('secours utilisé :', model);
        return full || {};
      } catch (e) { last = { status: 504, msg: slow ? 'trop lent (14 s sans réponse)' : e.message }; console.error('gemini', model, last.msg); if (got) return {}; if (slow) blocked.set(model, Date.now() + 5 * 6e4); break; } finally { clearTimeout(firstT); clearTimeout(totalT); } // déjà en train de parler : on garde ce qui est arrivé
    }
  }
  throw Object.assign(new Error('Gemini ' + (last?.status || 'indisponible') + ' ' + (last?.msg || '').replace(/\s+/g, ' ').slice(0, 200)), { status: last?.status === 429 || [...blocked.values()].some(t => t > Date.now()) ? 429 : 502 });
}
const animSchema = S('OBJECT', { required: ['title', 'bg', 'actors'], properties: { title: S('STRING'), bg: S('STRING', { enum: BGS }), actors: schema.properties.beats.items.properties.media.properties.actors } });
async function genAnim(say, topic) { // petite animation sur mesure pour UNE phrase, quand aucune image cohérente n'existe
  if (!KEY || !say) return undefined;
  for (const model of MODELS.slice(0, 3)) {
    if ((blocked.get(model) || 0) > Date.now()) continue;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: to(7000), headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Tu peux aussi utiliser text (formule/nom), color (#hex), shape circle (atome/point avec son text), box (étiquette) et line (trait/liaison/flèche de x0,y0 à x1,y1), avec delay pour les faire apparaître dans l\'ordre. Tu crées une courte animation pédagogique (un décor + 2 à 6 acteurs emoji animés) qui illustre EXACTEMENT la phrase donnée, de façon simple et naturelle. Acteurs fixes d\'abord (x0=x1, y0=y1), acteurs mobiles ensuite, effets d\'impact en dernier avec un delay. Coordonnées en % (0-100). Réponds en JSON.' }] }, contents: [{ role: 'user', parts: [{ text: `Sujet : ${topic || ''}\nPhrase : ${say}` }] }], generationConfig: { temperature: .6, responseMimeType: 'application/json', responseSchema: animSchema, maxOutputTokens: 1500, ...thinkCfg(model) } }) });
      if (!r.ok) { if (r.status === 429 || r.status === 404) blocked.set(model, Date.now() + 6e4); continue; }
      const j = await r.json(), o = JSON.parse((j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
      const m = await resolveMedia({ type: 'anim', title: o.title, bg: o.bg, actors: o.actors }); if (m) return m;
    } catch { }
  }
  return undefined;
}
const schemaLite = S('OBJECT', { required: ['beats'], propertyOrdering: ['beats', 'suggestions'], properties: { beats: S('ARRAY', { items: S('OBJECT', { required: ['say'], propertyOrdering: ['say', 'emotion', 'gesture', 'look'], properties: { say: S('STRING', { description: 'Une phrase courte (10-25 mots).' }), emotion: S('STRING', { enum: EMOTIONS }), gesture: S('STRING', { enum: GESTURES }), look: S('STRING', { enum: ['user', 'media', 'away', 'up'] }) } }) }), suggestions: S('ARRAY', { items: S('STRING') }) } });
const SYSTEM_SHORT = `Tu es BOBI, un petit robot-radiocassette chaleureux et drôle. Français naturel, complice. Réponse BRÈVE : 1 à 3 beats de 10 à 25 mots, sans média. Choisis emotion et gesture adaptés. Ajoute 2 suggestions courtes. Réponds UNIQUEMENT en JSON conforme au schéma.`;
const mock = q => ({ beats: [{ say: 'Salut ! Je tourne en mode test, sans clé Gemini.', emotion: 'joy', gesture: 'wave' }, { say: 'Voilà ce qui arrive quand une météorite touche la Terre.', emotion: 'curious', gesture: 'present', look: 'media', media: { type: 'anim', title: 'Une météorite touche la Terre', bg: 'space', actors: [{ emoji: '🌍', x0: 50, y0: 64, x1: 50, y1: 64, size: 46 }, { emoji: '☄️', x0: 8, y0: 6, x1: 47, y1: 52, size: 16, dur: 2.4, trail: true }, { emoji: '💥', x0: 50, y0: 56, x1: 50, y1: 56, size: 30, delay: 2.4, dur: .8, fade: 'pulse' }] } },
  { say: 'Et là je mime un petit pas de danse !', emotion: 'playful', timeline: [{ t: 0, pose: [{ bone: 'armP', rot: [-1.2, 0, .5] }, { bone: 'armN', rot: [-1.2, 0, -.5] }] }, { t: .5, pose: [{ bone: 'hips', rot: [0, .4, 0] }] }, { t: 1, pose: [{ bone: 'hips', rot: [0, -.4, 0] }] }] }], suggestions: ['Explique-moi la gravité', 'Raconte une blague'], teaser: 'Demain : un secret sur les fusées.' });

/* ---------- 6. Routes ---------- */
const rate = new Map(); const limited = (ip, max = 20) => { const n = Date.now(), a = (rate.get(ip) || []).filter(t => n - t < 6e4); a.push(n); rate.set(ip, a); return a.length > max; };
const DL_OK = h => /(^|\.)(archive\.org|gutenberg\.org|wikimedia\.org|wikisource\.org|arxiv\.org|hal\.science|archives-ouvertes\.fr|zenodo\.org)$/.test(h);
app.get('/api/dl', async (req, res) => { // téléchargement direct de fichiers libres (liste blanche de sites)
  try {
    const u = new URL(String(req.query.u || '')); if (u.protocol !== 'https:' || !DL_OK(u.hostname)) return res.status(400).send('Source non autorisée');
    const r = await fetch(u, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) }), fin = new URL(r.url);
    if (!r.ok || !DL_OK(fin.hostname)) return res.status(502).send('Téléchargement impossible');
    const len = +r.headers.get('content-length') || 0; if (len > 80e6) return res.status(413).send('Fichier trop volumineux');
    const name = String(req.query.n || fin.pathname.split('/').pop() || 'fichier').replace(/[^\w.\- àâçéèêëîïôûùüÿ()]/gi, '_').slice(0, 90);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream'); res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name)); if (len) res.setHeader('Content-Length', len);
    Readable.fromWeb(r.body).pipe(res);
  } catch { if (!res.headersSent) res.status(502).send('Téléchargement impossible'); }
});
app.get('/api/gimg/:id', (req, res) => { const g = EX.gimgs.get(String(req.params.id).replace(/[^\w]/g, '')); if (!g) return res.status(404).end(); res.setHeader('Content-Type', g.mime); res.setHeader('Cache-Control', 'public, max-age=3600'); res.send(g.buf); });
app.get('/api/gf/:id', (req, res) => { const g = EX.gfiles.get(String(req.params.id).replace(/[^\w]/g, '')); if (!g) return res.status(404).send('Fichier expiré, redemande-le à Bobi.'); res.setHeader('Content-Type', g.mime + '; charset=utf-8'); res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(g.name)); res.send(g.buf); });
app.post('/api/simfix', async (req, res) => { // réparation automatique d'une simulation qui plante ou reste vide
  if (limited(req.ip)) return res.status(429).json({ error: 'trop de demandes' });
  const html = String(req.body.html || '').slice(0, 60000), err = String(req.body.error || 'écran vide').slice(0, 300), title = String(req.body.title || 'simulation').slice(0, 120);
  const h = await genSim(title, 'La simulation ne fonctionne pas : ' + err + '. Corrige-la (le code doit dessiner quelque chose de visible dès le départ, sans erreur JavaScript) et améliore sa clarté.', simCode(html));
  h ? res.json({ html: h }) : res.status(502).json({ error: 'réparation impossible' });
});
app.get('/api/diag/image', (_, r) => r.json({ keys: { gemini: !!KEY, geminiImage: !!process.env.GEMINI_API_KEY_IMAGE, cloudflare: !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN), huggingface: !!process.env.HF_TOKEN }, derniersEchecs: EX.genLog }));
app.get('/api/health', (_, r) => r.json({ ok: true, mock: !KEY, model: MODEL, tts: !!TTS_KEY, ttsModel: TTS_MODEL, voice: TTS_VOICE, youtube: !!YT }));
app.get('/api/diag', async (_, r) => { // diagnostic temporaire : à supprimer une fois que tout marche
  const out = { model: MODEL, ttsModel: TTS_MODEL, textKey: !!KEY, ttsKey: !!TTS_KEY }, base = 'https://generativelanguage.googleapis.com/v1beta';
  try { const x = await fetch(`${base}/models/${MODEL}:generateContent`, { method: 'POST', signal: to(20000), headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Dis juste ok' }] }] }) }); out.textTest = { status: x.status, body: (await x.text()).slice(0, 500) }; } catch (e) { out.textTest = { error: e.message }; }
  try { const x = await fetch(`${base}/models?pageSize=200`, { signal: to(15000), headers: { 'x-goog-api-key': KEY } }); const j = await x.json(); out.modelsAvailable = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', '')); if (!x.ok) out.modelsError = j.error?.message; } catch (e) { out.modelsError = e.message; }
  r.json(out);
});
app.get('/api/vocab', (_, r) => r.json({ bones: BONES, gestures: GESTURES, emotions: EMOTIONS, eases: EASES })); // pour que le front s'aligne
app.post('/api/chat', async (req, res) => {
  const stream = !!req.body.stream; let started = false;
  const head = () => { if (!started) { started = true; res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }); } };
  const emit = o => { if (stream) { head(); res.write(JSON.stringify({ step: o }) + '\n'); } };
  const send = (obj, code = 200) => { if (stream) { head(); res.write(JSON.stringify(obj) + '\n'); res.end(); } else res.status(code).json(obj); };
  try {
    if (limited(req.ip)) return res.status(429).json({ error: 'Trop de messages, respire une minute 🙂', fallback: { beats: [{ say: 'Doucement, je suis un peu essoufflé ! Redemande-moi dans une minute.', emotion: 'playful', gesture: 'shrug' }] } });
    const text = String(req.body.message || '').trim().slice(0, 1500); if (!text) return res.status(400).json({ error: 'message vide' });
    const id = String(req.body.userId || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomUUID(), u = user(id);
    const ctx = `[Contexte: visite n°${u.visits}, série de ${u.streak} jour(s). Ce que tu sais de l'utilisateur: ${u.memory.slice(-15).join('; ') || 'rien encore'}.]`;
    const fx = text.length >= 20 && !/^(salut|bonjour|coucou|merci|ok)\b|simulation|simule|image|photo|vid[ée]o|fichier|t[ée]l[ée]charg|chanson|musique/i.test(text) ? await withTimeout(EX.facts(text).catch(() => ''), 1800) : '';
    const contents = [...u.history.slice(-10), { role: 'user', parts: [{ text: ctx + (fx ? '\n[Documentation fiable trouvée sur Wikipédia, appuie-toi dessus si pertinent :\n' + fx + ']' : '') + '\n' + text }] }];
    emit({ icon: '📖', label: 'Je lis ta question' });
    const lastSim = lastSimBy.get(id);
    if (lastSim && Date.now() - lastSim.t < 6 * 36e5 && /(modifi|ajout|rajout|enl[eè]v|retir|supprim|corrig|am[eé]lior|chang|remplac|rends|plus (grand|petit|gros|rapide|lent|clair|visible|d[ée]taill)|moins|il manque|manque)/i.test(text) && !/(nouvelle|autre) simulation|simulation (sur|de|du|des|d')/i.test(text)) {
      emit({ icon: '🧪', label: 'Je modifie la simulation' });
      const h = await genSim(lastSim.title, text, lastSim.code);
      if (h) { lastSimBy.set(id, { ...lastSim, code: simCode(h), t: Date.now() });
        const nb = { say: 'Voilà, j\'ai modifié la simulation comme tu l\'as demandé ! Dis-moi si tu veux encore l\'ajuster.', emotion: 'proud', gesture: 'present', intensity: .7, look: 'media', media: { type: 'sim', title: lastSim.title, caption: '', html: h } };
        u.history.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: nb.say + ' [simulation modifiée : ' + lastSim.title + ']' }] }); u.history = u.history.slice(-20); save();
        const out = { suggestions: ['Ajoute un autre élément', 'Explique-moi cette simulation'], userId: id, streak: u.streak, visits: u.visits };
        if (stream) { head(); res.write(JSON.stringify({ beat: nb }) + '\n'); send({ done: out }); } else send({ beats: [nb], ...out });
        return; } }
    const beats = []; let chain = Promise.resolve();
    const simple = (text.length < 14 && !/image|photo|vid|montre|simul|pdf|livre|chanson|fichier/i.test(text)) || /^(salut|bonjour|coucou|merci|ok|oui|non|ça va|ca va|hello|hey)\b/i.test(text) || /blague/i.test(text);
    const wantVid = /vid[ée]o|film|extrait/i.test(text);
    let resolveQ; const qP = new Promise(r => { resolveQ = r; });
    const fbImg = qP.then(q => q && !simple ? resolveMedia({ type: 'image', query: q }) : undefined).catch(() => undefined);
    const fbVid = qP.then(q => q && !simple ? resolveMedia({ type: 'video', query: q }) : undefined).catch(() => undefined);
    const shown = u.shown || (u.shown = []);
    const intent = /simulation|simule/i.test(text) ? null : /(g[ée]n[èe]re|cr[ée]e|imagine|fabrique|fais(-moi)?)[^.?!]{0,30}(image|illustration|logo|affiche|dessin|portrait|photo)|\bdessine(-moi)?\b|\bg[ée]n[èe]re(-moi)?\b[^.?!]{0,20}(un|une|des)\b/i.test(text) ? 'genimage' : /(cr[ée]e|[ée]cris|g[ée]n[èe]re|fais|code)[^.?!]{0,40}(fichier|script|page html|csv|document texte|markdown)/i.test(text) ? null : /t[ée]l[ée]charg|\bpdf\b|\blivre\b|\bmanuel\b|\b[ée]pub\b|fichier/i.test(text) ? 'file' : /chanson|musique|morceau|[ée]couter|titre de|clip musical/i.test(text) ? 'music' : /vid[ée]o|clip|extrait|film/i.test(text) ? 'video' : /image|photo|montre|voir|illustr|dessin|sch[ée]ma/i.test(text) ? 'image' : null;
    const rawQ = text.replace(/[?!.,]/g, ' ').replace(/\b(s'il (te|vous) pla[iî]t|cherche|trouve|montre[- ]moi|montre|affiche|fais[- ]moi (voir|[ée]couter)|[ée]coute|lance|mets|met|une?|des?|du|le|la|les|l'|d'|autre|encore|chanson|musique|morceau|titre|image|photo|vid[ée]o|clip|t[ée]l[ée]charge(r)?|pdf|livre|fichier|manuel|moi|me|de|sur|avec|et)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
    const fbIntent = intent ? (async () => { const q1 = await withTimeout(qP, 2500); const tries = intent === 'genimage' ? [text.slice(0, 300)] : [...new Set([rawQ, q1, text.slice(0, 60)].filter(Boolean))];
      for (const q of tries) { const r = await resolveMedia({ type: intent, query: q, modern: true, explicit: true }, () => {}, shown).catch(() => undefined); if (r && mkey(r)) return r; if (r && r.type === 'file' && r.dl) return r; }
      if (intent === 'image') { for (const q of tries) { const o = await getJson('https://api.openverse.org/v1/images/?page_size=5&q=' + encodeURIComponent(q)).catch(() => null); const it = (o?.results || []).find(x => /^https:\/\//.test(x.url || '') && !shown.includes(x.url)); if (it) return { type: 'image', title: clean(it.title) || q, caption: '', url: it.thumbnail && /^https:/.test(it.thumbnail) ? it.thumbnail : it.url, credit: 'Openverse : ' + (clean(it.creator) || 'auteur inconnu'), page: it.foreign_landing_url || '' }; } }
      return undefined; })().catch(() => undefined) : Promise.resolve(undefined);
    const usedImg = new Set(); let animN = 0, nB = 0;
    const onBeat = raw => { const job = cleanBeat(raw, emit, shown).catch(() => null); /* la recherche de média démarre tout de suite, en parallèle */ chain = chain.then(async () => {
      if (beats.length >= 8) return; const b = await job; if (!b) return;
      if (intent === 'file' && b.media && b.media.type !== 'file') b.media = undefined;
      if (b.media && b.media.type === 'image') { if (usedImg.has(b.media.url)) b.media = undefined; else usedImg.add(b.media.url); }
      if (b.media && b.media.type === 'video' && beats.some(x => x.media && x.media.url === b.media.url && x.media.type === 'video')) b.media = undefined;
      if (intent === 'file' && (!b.media || b.media.type !== 'file') && !beats.some(x => x.media && x.media.type === 'file')) { const f = await withTimeout(fbIntent, 12000); b.media = f && f.dl ? f : undefined; } else if (intent && !b.media && !beats.some(x => x.media && x.media.type === (intent === 'genimage' ? 'image' : intent))) { const f = await withTimeout(fbIntent, intent === 'genimage' ? 40000 : 12000); if (f && mkey(f) && !shown.includes(mkey(f))) b.media = f; }
      const i = beats.length; // rang du beat : 0 = accroche ; ensuite on garantit un média cohérent, dans l'ordre
      if (!b.media && !simple && i >= 1 && intent !== 'file') {
        let f; const hasVid = beats.some(x => x.media && x.media.type === 'video');
        if (i === 1) { const im = await withTimeout(fbImg, 3500); if (im && im.url && !usedImg.has(im.url)) { f = im; usedImg.add(im.url); } }
        else if (i === 2 && !hasVid) { const v = await withTimeout(fbVid, 3500); if (v && (v.file || v.embed)) f = v; }
        if (false && !f && animN < 3) { animN++; const q = await withTimeout(qP, 1500); f = await withTimeout(genAnim(b.say, q), 7500); }
        if (f) b.media = f;
      }
      if (b.media?.type === 'sim' && b.media.html) lastSimBy.set(id, { title: b.media.title, code: simCode(b.media.html), t: Date.now() });
      if (b.media && mkey(b.media)) { shown.push(mkey(b.media)); if (shown.length > 60) shown.splice(0, shown.length - 60); }
      beats.push(b); if (stream) { head(); res.write(JSON.stringify({ beat: b }) + '\n'); } }); };
    const tail = await geminiStream(contents, simple ? SYSTEM_SHORT : SYSTEM, onBeat, emit, q => resolveQ(String(q || '').slice(0, 80)), simple ? schemaLite : schema); resolveQ(''); await chain;
    if (intent && !beats.some(x => x.media)) { const nb = { say: intent === 'video' ? 'Je n\'ai trouvé aucune vidéo, même approchante. Donne-moi le titre ou le nom exact, et je réessaie !' : intent === 'image' ? 'Je n\'ai trouvé aucune image, même approchante. Tu peux préciser le nom exact ?' : 'Je n\'ai pas trouvé exactement ce que tu demandes. Tu peux me donner le titre ou le nom exact ?', emotion: 'empathy', gesture: 'shrug', intensity: .6, look: 'user' }; beats.push(nb); if (stream) { head(); res.write(JSON.stringify({ beat: nb }) + '\n'); } }
    if (!beats.length) throw new Error('réponse vide');
    const meta = cleanMeta(tail);
    u.history.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: beats.map(b => b.say + (b.media ? ` [média montré : ${b.media.type} ${b.media.title || ''} ${b.media.artist || ''}]` : '')).join(' ') }] }); u.history = u.history.slice(-20);
    for (const f of meta.memory) if (!u.memory.includes(f)) u.memory.push(f); u.memory = u.memory.slice(-40); save();
    const out = { topic: meta.topic, suggestions: meta.suggestions, teaser: meta.teaser, userId: id, streak: u.streak, visits: u.visits };
    send(stream ? { done: out } : { beats, ...out });
  } catch (e) {
    console.error(e.message); const quota = e.status === 429;
    send({ error: 'Bobi réfléchit trop fort, réessaie.', fallback: { beats: [{ say: quota ? 'J\'ai épuisé mon énergie de réflexion pour le moment. Réessaie dans quelques minutes, je serai rechargé !' : 'Oups, j\'ai eu un petit court-circuit. Redis-moi ça ?', emotion: 'empathy', gesture: 'shrug' }] } }, quota ? 429 : 502);
  }
});
app.post('/api/greet', (req, res) => { // salutation de retour = levier de fidélisation
  const id = String(req.body.userId || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomUUID(), u = user(id); save();
  const back = u.visits > 1, line = !back ? 'Salut, moi c\'est Bobi ! Je vais t\'expliquer plein de choses. Comment tu t\'appelles ?' : u.streak >= 3 ? `Ça fait ${u.streak} jours de suite, tu es en feu ! Qu'est-ce qu'on explore aujourd'hui ?` : 'Tu es revenu ! J\'ai pensé à toi. On continue ?';
  res.json({ userId: id, streak: u.streak, visits: u.visits, beats: [{ say: line, emotion: back ? 'joy' : 'excited', gesture: back ? 'celebrate' : 'wave', look: 'user' }] });
});
app.get('/api/idle', (_, r) => { const P = [['think', 'curious'], ['shrug', 'playful'], ['nod', 'neutral'], ['lean_in', 'curious'], ['dance', 'playful'], ['hands_hips', 'proud']]; const [gesture, emotion] = P[Math.random() * P.length | 0]; r.json({ gesture, emotion, after: 8 + Math.random() * 12 }); });

/* ---------- 7. Voix : Gemini TTS (clé séparée possible), cache, plafond par utilisateur ---------- */
const STYLE = { joy: 'Dis avec une joie sincère et chaleureuse', excited: 'Dis avec beaucoup d\'enthousiasme, énergique', curious: 'Dis avec une curiosité amusée, ton léger', thinking: 'Dis lentement, en réfléchissant à voix haute', empathy: 'Dis avec douceur et bienveillance', proud: 'Dis avec fierté, ton posé', surprised: 'Dis avec surprise et émerveillement', playful: 'Dis avec malice, un sourire dans la voix', serious: 'Dis calmement, ton sérieux et clair', neutral: 'Dis naturellement, comme un ami qui explique' };
const wav = (pcm, rate = 24000) => { const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
const audioCache = new Map(), ttsBlocked = new Map();
app.post('/api/tts', async (req, res) => {
  const fallback = (why, code = 503) => res.status(code).json({ fallback: true, why }); // le front utilise alors la voix du navigateur
  try {
    if (!TTS_KEY) return fallback('no_key'); if (limited(req.ip + 'tts', 60)) return fallback('rate', 429);
    const text = String(req.body.text || '').trim().slice(0, 400); if (!text) return res.status(400).json({ error: 'texte vide' });
    const emotion = 'neutral', k = crypto.createHash('sha1').update(TTS_VOICE + emotion + text).digest('hex');
    let buf = audioCache.get(k), hit = !!buf;
    if (!buf) {
      const id = String(req.body.userId || '').replace(/[^\w-]/g, '').slice(0, 40), u = id ? user(id) : null, day = new Date().toISOString().slice(0, 10);
      if (u) { if (u.ttsDay !== day) { u.ttsDay = day; u.tts = 0; } if (u.tts >= TTS_CAP) return fallback('daily_cap', 429); u.tts++; }
      let r, j, d, pcm, last = 'tts_error', sawQuota = false;
      outer: for (const model of [...new Set([TTS_MODEL, ...TTS_FALLBACKS])]) {
        if ((ttsBlocked.get(model) || 0) > Date.now()) { sawQuota = true; continue; } // quota épuisé : pas d'attente, le site passe tout de suite en voix de secours
        for (let a = 0; a < 2; a++) {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: to(30000), headers: { 'content-type': 'application/json', 'x-goog-api-key': TTS_KEY },
            body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } } }) });
          j = await r.json().catch(() => ({}));
          if (!r.ok) {
            last = j.error?.message || 'tts_error'; console.error('tts', model, r.status, last.replace(/\s+/g, ' ').slice(0, 160));
            if (r.status === 429 && /quota|exceeded/i.test(last)) { sawQuota = true; ttsBlocked.set(model, Date.now() + pauseFor(last)); continue outer; }
            if (r.status === 404 || r.status === 400) { ttsBlocked.set(model, Date.now() + 6 * 36e5); continue outer; }
            if (r.status === 429 || r.status >= 500) { await sleep(900); continue; } continue outer;
          }
          d = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data; if (!d) { last = 'no_audio'; continue; }
          pcm = Buffer.from(d, 'base64'); if (pcm.length / 48 < text.length * 38 && a < 1) { console.warn('tts audio trop court, nouvel essai'); d = null; continue; } break outer;
        }
      }
      if (!d) { if (u) u.tts--; return fallback(sawQuota ? 'quota' : last, sawQuota ? 429 : 502); }
      buf = wav(pcm); audioCache.set(k, buf); if (audioCache.size > 300) audioCache.delete(audioCache.keys().next().value); save();
    }
    res.set({ 'content-type': 'audio/wav', 'x-duration-ms': Math.round((buf.length - 44) / 48), 'x-cache': hit ? 'hit' : 'miss', 'access-control-expose-headers': 'x-duration-ms,x-cache' }).send(buf);
  } catch (e) { console.error('tts', e.message); fallback('exception', 502); }
});
app.listen(process.env.PORT || 8787, () => console.log(`Bobi backend :${process.env.PORT || 8787} — ${KEY ? 'Gemini ' + MODEL : 'MODE MOCK (pas de clé)'}`));

/* anti-sommeil Render */
if (process.env.RENDER_EXTERNAL_URL) setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/api/health').catch(() => {}), 10 * 60 * 1000);
