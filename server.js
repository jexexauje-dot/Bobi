// BOBI BACKEND — Gemini pilote le corps, la voix, les médias. Aucune dépendance autre qu'express+cors.
import express from 'express'; import cors from 'cors'; import fs from 'fs'; import crypto from 'crypto';
try { for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=([^#\n]*)/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}
const KEY = process.env.GEMINI_API_KEY_TEXT || process.env.GEMINI_API_KEY || '', TTS_KEY = process.env.GEMINI_API_KEY_TTS || KEY, TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts', TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Charon', TTS_FALLBACKS = (process.env.GEMINI_TTS_FALLBACKS || 'gemini-3.1-flash-tts-preview,gemini-3.8-flash-tts').split(',').map(x => x.trim()).filter(Boolean), TTS_CAP = +process.env.TTS_DAILY_CAP || 60, MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash', YT = process.env.YOUTUBE_API_KEY || '';
const app = express(); app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' })); app.use(express.json({ limit: '200kb' }));
app.get(['/', '/index.html'], (_, r) => r.sendFile(new URL('./index.html', import.meta.url).pathname)); // sert le site Bobi ; seul index.html est exposé (pas server.js ni .env)

/* ---------- 1. Vocabulaire du corps (doit correspondre au rig de Bobi) ---------- */
const BONES = { hips: 0.6, chest: 0.8, head: 1.0, armP: 3.0, armN: 3.0, footP: 0.9, footN: 0.9 }; // limite ± radians
const GESTURES = ['idle', 'wave', 'point', 'present', 'shrug', 'think', 'nod', 'shake', 'clap', 'celebrate', 'bow', 'lean_in', 'surprise', 'dance', 'walk', 'hands_hips', 'thumbs_up'];
const EMOTIONS = ['neutral', 'joy', 'curious', 'excited', 'thinking', 'empathy', 'proud', 'surprised', 'playful', 'serious'];
const EASES = ['smooth', 'snap', 'bounce', 'linear'];
const SCENES = ['cycle', 'wave', 'bars', 'timeline', 'compare', 'concept', 'projectile'];
const BGS = ['space', 'sky', 'ocean', 'earth', 'night', 'lab', 'paper', 'fire'], FADES = ['none', 'in', 'out', 'pulse'];
const MEDIA = ['image', 'video', 'music', 'site', 'chart', 'anim', ...SCENES];

/* ---------- 2. Schéma imposé à Gemini (sortie JSON garantie) ---------- */
const S = (type, extra = {}) => ({ type, ...extra });
const schema = S('OBJECT', { required: ['beats'], propertyOrdering: ['mediaQuery', 'beats', 'topic', 'suggestions', 'teaser', 'memory'], properties: {
  beats: S('ARRAY', { items: S('OBJECT', { required: ['say'], propertyOrdering: ['say', 'emotion', 'intensity', 'gesture', 'look', 'media', 'timeline'], properties: {
    say: S('STRING', { description: 'Une à deux phrases dites à voix haute. Courte (10-25 mots) pour une question simple ; 20 à 35 mots, riche en faits, pour une explication.' }),
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
      emoji: S('STRING', { description: 'cycle/concept : un emoji central' }), unit: S('STRING'),
      bg: S('STRING', { enum: BGS, description: 'anim : décor de fond' }),
      modern: S('BOOLEAN', { description: 'video : true (défaut) = vidéo courte récente 2023-2026 ; false seulement si le sujet exige des archives anciennes' }),
      actors: S('ARRAY', { description: 'anim : 2 à 6 acteurs animés {emoji, x0,y0 (départ), x1,y1 (arrivée) en % 0-100 du cercle, size 6-60, delay (s), dur (s), spin (tours), trail (traînée), fade (none|in|out|pulse), label}', items: S('OBJECT', { properties: {
        emoji: S('STRING'), x0: S('NUMBER'), y0: S('NUMBER'), x1: S('NUMBER'), y1: S('NUMBER'), size: S('NUMBER'), delay: S('NUMBER'), dur: S('NUMBER'), spin: S('NUMBER'), trail: S('BOOLEAN'), fade: S('STRING', { enum: FADES }), label: S('STRING') } }) }),
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
LONGUEUR ADAPTÉE : question simple (fait court, définition, salut, merci, blague, oui/non) → réponse BRÈVE : 1 à 3 beats de 10 à 25 mots, sans média sauf s'il aide vraiment. Question qui demande de comprendre (pourquoi, comment, histoire, science, comparaison, conseil) → réponse DÉVELOPPÉE : 4 à 5 beats de 20 à 35 mots. Dans les deux cas, le PREMIER beat est toujours court (10 à 15 mots) : une accroche qui lance la réponse sans attendre.
CONTENU : quand tu développes, tu APPRENDS vraiment quelque chose : faits précis (dates, chiffres, noms, causes, conséquences), un exemple concret ou une anecdote surprenante, une vraie explication du « pourquoi ». Interdit : les réponses creuses ou vagues. Ne rallonge jamais pour rien.
CORPS : à chaque phrase tu choisis l'émotion et le geste qui COLLENT au sens (tu pointes ce que tu montres, tu hausses les épaules quand tu hésites, tu te penches quand tu confies, tu fêtes les réussites). Pas de geste gratuit. Utilise 'gesture' pour les classiques, 'timeline' (poses clés, rotations en radians, bones: ${Object.keys(BONES).join(', ')}) pour tout autre mouvement humain. Varie, ne répète pas le même geste deux fois de suite.
MÉDIAS = ta signature : quand tu EXPLIQUES un sujet (histoire, science, philosophie, nature, espace, technique, art…), tu montres du concret dans ton cercle, en plusieurs beats consécutifs, cohérents avec ce que tu dis. Ordre idéal : beat 1 ou 2 = 'anim' (petite animation qui montre le phénomène), beat suivant = 'image' (query précise en anglais, ex: \"Chelyabinsk meteor\"), beat suivant = 'video' (query précise en anglais). Les médias illustrent la phrase du beat : ne les annonce presque jamais (« regarde »), dis des faits. Pas de média sur une question simple (salut, merci, définition d'un mot, blague).
'anim' : bg (space|sky|ocean|earth|night|lab|paper|fire) + 2 à 6 'actors' {emoji, x0,y0 → x1,y1 en % du cercle (0-100), size 6-60, delay, dur (secondes), spin, trail, fade, label}. Exemple météorite : bg space ; 🌍 size 46 fixe (x0=x1=50,y0=y1=62) ; ☄️ size 16 de (8,6) à (48,52), dur 2.4, trail true ; 💥 size 34 en (50,56), delay 2.4, dur 0.8, fade pulse. Mets les acteurs fixes en premier, les mobiles ensuite, les effets d'impact à la fin.
Schémas (si c'est un processus, une chronologie, une comparaison, des chiffres) : 'cycle' (emoji + items 3-6 {icon,label}), 'timeline' (items 3-5 {when,label}), 'bars' (unit + items 2-6 {label,value}), 'compare' (left/right {label,points 2-3}), 'concept' (emoji + items 2-4 {label}), 'wave' (waves), 'projectile' (angles, v0). Option : 'site' (URL si l'utilisateur parle d'un site). Remplis TOUS les champs du type choisi, sinon ne mets pas de média. Mets look='media' quand un média est affiché.
STRUCTURE : les beats s'enchaînent comme un récit (accroche, explication, détail surprenant, conclusion). Finis par une ouverture. Ajoute 2-3 suggestions et, si pertinent, un teaser. Mets dans memory ce que tu apprends de durable sur la personne. LIBERTÉ ET VÉRITÉ : tu réponds à TOUTES les questions, y compris sensibles, tabous ou controversées, franchement et sans moraliser : tu distingues faits établis, hypothèses et opinions, tu dis « je ne sais pas » quand c'est le cas, tu ne mens jamais pour faire plaisir.
MÉDIAS SYSTÉMATIQUES (RÈGLE PRIORITAIRE, même si l'utilisateur ne demande rien) : pour toute question de science (physique, maths, biologie, chimie, astronomie…), histoire, littérature, arts, philosophie, géographie, technique, tu illustres CHAQUE beat sauf le premier (l'accroche courte) avec un média différent, dans l'ordre chronologique/logique de ton récit. Pour un objet, lieu, personne, événement, œuvre, animal : 'image' avec une query anglaise précise propre à ce beat (pas la même image deux fois). Pour un mécanisme, un processus, une loi, une démonstration, un concept abstrait ou si tu n'es pas sûr qu'une image existe : 'anim' simple. Une 'video' (query précise) dans l'un des beats du milieu. Jamais deux beats avec le même média.
VIDÉOS : toujours courtes (moins de 2 minutes) et modernes (2023-2026) : mets modern=true ; modern=false SEULEMENT si le sujet exige des archives anciennes (guerres, histoire, événements passés).
MUSIQUE : si l'utilisateur demande d'écouter ou de chercher une chanson, un morceau, un artiste, tu mets au 2e beat un média 'music' avec query = « titre artiste » (ex: \"Despacito Luis Fonsi\"). Ton 1er beat dit que tu l'as trouvée et que l'utilisateur appuie sur ▶ pour que tu la lances (tu ne lances jamais sans son accord).
COHÉRENCE : chaque média doit illustrer EXACTEMENT ce que dit la phrase du beat et le sujet de la conversation. Sa query contient toujours le nom du sujet (ex: pour une météorite → "meteorite", "Chelyabinsk meteor"), jamais un mot vague. Au moindre doute, pas de média.
MÉDIA OBLIGATOIRE : si l'utilisateur demande explicitement une image, une photo, une vidéo, un schéma ou une animation (ou dit « montre-moi »), tu DOIS mettre le média demandé dès le 2e beat. Pour un schéma ou une animation tu fabriques un 'anim' ou un schéma (cycle, timeline…).
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
const cache = new Map(); const cached = async (k, fn) => { if (cache.has(k)) return cache.get(k); const v = await fn().catch(() => null); cache.set(k, v); if (cache.size > 500) cache.delete(cache.keys().next().value); return v; };
const to = (ms) => AbortSignal.timeout(ms);

const UA = { 'User-Agent': 'BobiBot/1.0 (https://bobi-57i1.onrender.com; chatbot educatif)' }, getJson = async u => (await fetch(u, { headers: UA, signal: to(4000) })).json();
const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'photo', 'image', 'video', 'file', 'des', 'les', 'une', 'dans', 'pour', 'avec', 'sur']);
const relevant = (title, q) => { const t = norm(title), ks = norm(q).split(/[^a-z0-9]+/).filter(w => (w.length >= 4 || /^\d+$/.test(w)) && !STOP.has(w)); if (!ks.length) return true; return ks.some(k => t.includes(k.length > 6 ? k.slice(0, k.length - 1) : k)); };
const clean = x => String(x || '').replace(/<[^>]+>/g, '').slice(0, 80);
async function resolveMedia(m, emit = () => {}) {
  if (!m || !MEDIA.includes(m.type)) return undefined; const base = { type: m.type, title: String(m.title || '').slice(0, 120), caption: String(m.caption || '').slice(0, 200) };
  if (m.type === 'image') emit({ icon: '🖼️', label: 'Je cherche une image : ' + String(m.query || '').slice(0, 40) });
  else if (m.type === 'video') emit({ icon: '▶️', label: 'Je cherche une vidéo sur le sujet' });
  else if (m.type === 'anim') emit({ icon: '🎬', label: 'Je prépare une animation' });
  else if (m.type === 'music') emit({ icon: '🎵', label: 'Je cherche la chanson : ' + String(m.query || '').slice(0, 40) });
  else if (m.type === 'site') { const u0 = safeUrl(m.query); if (u0) emit({ icon: '🌐', label: 'Je regarde le site ' + u0.hostname, logo: 'https://www.google.com/s2/favicons?sz=64&domain=' + u0.hostname }); }
  else emit({ icon: '📊', label: 'Je dessine un schéma' + (base.title ? ' : ' + base.title.slice(0, 40) : '') });
  if (m.type === 'anim') {
    const T = (x, n) => String(x ?? '').slice(0, n), N = (v, a, b, d) => Number.isFinite(+v) && v !== null && v !== '' ? Math.max(a, Math.min(b, +v)) : d;
    const actors = (Array.isArray(m.actors) ? m.actors : []).slice(0, 7).map(a => ({ emoji: T(a?.emoji, 6), x0: N(a?.x0, -25, 125, 50), y0: N(a?.y0, -25, 125, 50), x1: N(a?.x1, -25, 125, N(a?.x0, -25, 125, 50)), y1: N(a?.y1, -25, 125, N(a?.y0, -25, 125, 50)), size: N(a?.size, 5, 70, 16), delay: N(a?.delay, 0, 8, 0), dur: N(a?.dur, .3, 8, 2), spin: N(a?.spin, -4, 4, 0), trail: !!a?.trail, fade: FADES.includes(a?.fade) ? a.fade : 'none', label: T(a?.label, 22) })).filter(a => a.emoji);
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
  if (m.type === 'image' && m.query) return cached('img:' + m.query, async () => { // Wikipédia en/fr EN PARALLÈLE (premier qui répond), sinon Wikimedia Commons
    const wiki = async lang => {
      const r = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=900&gsrsearch=` + encodeURIComponent(m.query));
      const p = Object.values(r?.query?.pages || {}).sort((a, b) => a.index - b.index).find(p => p.thumbnail?.source && relevant(p.title, m.query)); if (!p) throw 0;
      return { ...base, url: p.thumbnail.source, credit: 'Wikipédia : ' + p.title, page: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(p.title.replace(/ /g, '_')) };
    };
    return await Promise.any([wiki('en'), wiki('fr')]).catch(async () => {
      const r = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900&gsrsearch=' + encodeURIComponent(m.query + ' filetype:bitmap'));
      const p = Object.values(r.query?.pages || {}).find(p => p.imageinfo?.[0]?.thumburl && relevant(p.title, m.query)); if (!p) return undefined; const i = p.imageinfo[0];
      return { ...base, url: i.thumburl, credit: clean(i.extmetadata?.Artist?.value) || 'Wikimedia Commons', page: i.descriptionurl };
    }).then(async found => { if (found) return found;
      const r = await getJson('https://images-api.nasa.gov/search?media_type=image&page_size=8&q=' + encodeURIComponent(m.query)).catch(() => null); // NASA : excellent pour l'espace et la science
      const it = (r?.collection?.items || []).find(i => /^https:\/\//.test(i.links?.[0]?.href || '') && relevant((i.data?.[0]?.title || '') + ' ' + (i.data?.[0]?.keywords || []).join(' '), m.query));
      return it ? { ...base, url: it.links[0].href, credit: 'NASA : ' + clean(it.data[0].title), page: 'https://images.nasa.gov/details/' + encodeURIComponent(it.data[0].nasa_id) } : undefined; }); });
  if (m.type === 'video' && m.query) return cached('vid:' + m.query, async () => {
    const search = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(m.query);
    if (YT) { const modern = m.modern !== false, q = encodeURIComponent(m.query);
      const ytq = after => getJson('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=strict&videoDuration=short&maxResults=6&q=' + q + (after ? '&publishedAfter=2023-01-01T00:00:00Z' : '') + '&key=' + YT).catch(() => null);
      let r = await ytq(modern); if (modern && !r?.items?.length) r = await ytq(false);
      const items = (r?.items || []).filter(v => v.id?.videoId && relevant(v.snippet?.title, m.query));
      if (items.length) { const d = await getJson('https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=' + items.map(v => v.id.videoId).join(',') + '&key=' + YT).catch(() => null);
        const secs = {}; for (const x of d?.items || []) { const t = /PT(?:(\d+)M)?(?:(\d+)S)?/.exec(x.contentDetails?.duration || ''); secs[x.id] = t ? (+t[1] || 0) * 60 + (+t[2] || 0) : 999; }
        const v = items.slice().sort((a, b) => (secs[a.id.videoId] > 120) - (secs[b.id.videoId] > 120) || (secs[a.id.videoId] || 999) - (secs[b.id.videoId] || 999))[0];
        return { ...base, title: base.title || v.snippet.title, embed: 'https://www.youtube-nocookie.com/embed/' + v.id.videoId, search }; } }
    // sans clé : vidéos libres de Wikimedia Commons (lecture directe dans le cercle de Bobi)
    const r = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime|extmetadata|timestamp|size&iiurlwidth=640&gsrsearch=' + encodeURIComponent(m.query + ' filetype:video')).catch(() => null);
    const vids = Object.values(r?.query?.pages || {}).sort((a, b) => a.index - b.index).filter(p => relevant(p.title, m.query) && /^video\//.test(p.imageinfo?.[0]?.mime || '') && /^https:\/\//.test(p.imageinfo[0].url));
    const modernV = m.modern !== false, rank = p => { const i = p.imageinfo[0]; return (i.duration > 120 ? 2 : 0) + (modernV && !(String(i.timestamp || '') >= '2023') ? 1 : 0) + (/webm|mp4/.test(i.mime) ? 0 : .5); };
    const p = vids.slice().sort((a, b) => rank(a) - rank(b))[0];
    if (p) { const i = p.imageinfo[0]; return { ...base, file: i.url, mime: i.mime, poster: i.thumburl, credit: clean(i.extmetadata?.Artist?.value) || 'Wikimedia Commons', page: i.descriptionurl, search }; }
    const rn = await getJson('https://images-api.nasa.gov/search?media_type=video&page_size=6&q=' + encodeURIComponent(m.query)).catch(() => null);
    const it = (rn?.collection?.items || []).find(i => i.href && relevant((i.data?.[0]?.title || '') + ' ' + (i.data?.[0]?.keywords || []).join(' '), m.query));
    if (it) { const man = await getJson(it.href.replace(/^http:/, 'https:')).catch(() => null); const urls = (Array.isArray(man) ? man : []).map(u => String(u).replace(/^http:/, 'https:')); const mp4 = urls.find(u => /~medium\.mp4$/.test(u)) || urls.find(u => /\.mp4$/.test(u));
      if (mp4) return { ...base, file: mp4, mime: 'video/mp4', poster: (it.links?.[0]?.href || '').replace(/^http:/, 'https:'), credit: 'NASA : ' + clean(it.data[0].title), page: 'https://images.nasa.gov/details/' + encodeURIComponent(it.data[0].nasa_id), search }; }
    return { ...base, search }; });
  if (m.type === 'music' && m.query) return cached('mus:' + m.query, async () => {
    const r = await getJson('https://itunes.apple.com/search?media=music&entity=song&limit=6&term=' + encodeURIComponent(m.query)).catch(() => null);
    const it = (r?.results || []).find(x => /^https:\/\//.test(x.previewUrl || '') && relevant((x.trackName || '') + ' ' + (x.artistName || ''), m.query));
    let embed; if (YT) { const y = await getJson('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=3&q=' + encodeURIComponent(m.query) + '&key=' + YT).catch(() => null); const v = (y?.items || []).find(v => v.id?.videoId && relevant(v.snippet?.title, m.query)); if (v) embed = 'https://www.youtube-nocookie.com/embed/' + v.id.videoId; }
    if (!it && !embed) return undefined;
    return { ...base, title: it ? it.trackName : base.title, artist: it ? it.artistName : '', cover: it ? String(it.artworkUrl100 || '').replace('100x100', '600x600') : '', audio: it ? it.previewUrl : '', embed, page: it?.trackViewUrl || '', credit: embed ? 'YouTube' : 'Extrait de 30 s (iTunes)' }; });
  if (m.type === 'site' && m.query) { const u = safeUrl(m.query); if (!u) return undefined; return cached('site:' + u.hostname, async () => {
    let embeddable = false; try { const h = await fetch(u.origin, { method: 'HEAD', redirect: 'follow', signal: to(4000) }); const xfo = h.headers.get('x-frame-options'), csp = h.headers.get('content-security-policy') || ''; embeddable = !xfo && !/frame-ancestors/i.test(csp); } catch {}
    return { ...base, url: u.href, domain: u.hostname, logo: 'https://www.google.com/s2/favicons?sz=128&domain=' + u.hostname, embeddable, mode: embeddable ? 'iframe' : 'card' }; }); }
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cleanBeat(b, emit = () => {}) {
  if (!b || !b.say) return null;
  const out = { say: String(b.say).slice(0, 420), emotion: EMOTIONS.includes(b.emotion) ? b.emotion : 'neutral', intensity: Math.max(0, Math.min(1, Number.isFinite(+b.intensity) ? +b.intensity : .6)),
    gesture: GESTURES.includes(b.gesture) ? b.gesture : undefined, timeline: cleanTimeline(b.timeline), look: ['user', 'media', 'away', 'up'].includes(b.look) ? b.look : 'user' };
  const m = await withTimeout(resolveMedia(b.media, emit).catch(() => undefined), 4500); if (m) out.media = m;
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
async function geminiStream(contents, system, onBeat, emit = () => {}, onQuery = null) {
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
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: .9, responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 6144, ...thinkCfg(model) } }) });
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
        body: JSON.stringify({ systemInstruction: { parts: [{ text: 'Tu crées une courte animation pédagogique (un décor + 2 à 6 acteurs emoji animés) qui illustre EXACTEMENT la phrase donnée, de façon simple et naturelle. Acteurs fixes d\'abord (x0=x1, y0=y1), acteurs mobiles ensuite, effets d\'impact en dernier avec un delay. Coordonnées en % (0-100). Réponds en JSON.' }] }, contents: [{ role: 'user', parts: [{ text: `Sujet : ${topic || ''}\nPhrase : ${say}` }] }], generationConfig: { temperature: .6, responseMimeType: 'application/json', responseSchema: animSchema, maxOutputTokens: 1500, ...thinkCfg(model) } }) });
      if (!r.ok) { if (r.status === 429 || r.status === 404) blocked.set(model, Date.now() + 6e4); continue; }
      const j = await r.json(), o = JSON.parse((j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''));
      const m = await resolveMedia({ type: 'anim', title: o.title, bg: o.bg, actors: o.actors }); if (m) return m;
    } catch { }
  }
  return undefined;
}
const mock = q => ({ beats: [{ say: 'Salut ! Je tourne en mode test, sans clé Gemini.', emotion: 'joy', gesture: 'wave' }, { say: 'Voilà ce qui arrive quand une météorite touche la Terre.', emotion: 'curious', gesture: 'present', look: 'media', media: { type: 'anim', title: 'Une météorite touche la Terre', bg: 'space', actors: [{ emoji: '🌍', x0: 50, y0: 64, x1: 50, y1: 64, size: 46 }, { emoji: '☄️', x0: 8, y0: 6, x1: 47, y1: 52, size: 16, dur: 2.4, trail: true }, { emoji: '💥', x0: 50, y0: 56, x1: 50, y1: 56, size: 30, delay: 2.4, dur: .8, fade: 'pulse' }] } },
  { say: 'Et là je mime un petit pas de danse !', emotion: 'playful', timeline: [{ t: 0, pose: [{ bone: 'armP', rot: [-1.2, 0, .5] }, { bone: 'armN', rot: [-1.2, 0, -.5] }] }, { t: .5, pose: [{ bone: 'hips', rot: [0, .4, 0] }] }, { t: 1, pose: [{ bone: 'hips', rot: [0, -.4, 0] }] }] }], suggestions: ['Explique-moi la gravité', 'Raconte une blague'], teaser: 'Demain : un secret sur les fusées.' });

/* ---------- 6. Routes ---------- */
const rate = new Map(); const limited = (ip, max = 20) => { const n = Date.now(), a = (rate.get(ip) || []).filter(t => n - t < 6e4); a.push(n); rate.set(ip, a); return a.length > max; };
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
    const contents = [...u.history.slice(-10), { role: 'user', parts: [{ text: ctx + '\n' + text }] }];
    emit({ icon: '📖', label: 'Je lis ta question' });
    const beats = []; let chain = Promise.resolve();
    const simple = text.length < 14 || /^(salut|bonjour|coucou|merci|ok|oui|non|ça va|ca va|hello|hey)\b/i.test(text) || /blague/i.test(text);
    const wantVid = /vid[ée]o|film|extrait/i.test(text);
    let resolveQ; const qP = new Promise(r => { resolveQ = r; });
    const fbImg = qP.then(q => q && !simple ? resolveMedia({ type: 'image', query: q }) : undefined).catch(() => undefined);
    const fbVid = qP.then(q => q && !simple ? resolveMedia({ type: 'video', query: q }) : undefined).catch(() => undefined);
    const usedImg = new Set(); let animN = 0, nB = 0;
    const onBeat = raw => { const job = cleanBeat(raw, emit).catch(() => null); /* la recherche de média démarre tout de suite, en parallèle */ chain = chain.then(async () => {
      if (beats.length >= 8) return; const b = await job; if (!b) return;
      if (b.media && b.media.type === 'image') { if (usedImg.has(b.media.url)) b.media = undefined; else usedImg.add(b.media.url); }
      if (b.media && b.media.type === 'video' && beats.some(x => x.media && x.media.url === b.media.url && x.media.type === 'video')) b.media = undefined;
      const i = beats.length; // rang du beat : 0 = accroche ; ensuite on garantit un média cohérent, dans l'ordre
      if (!b.media && !simple && i >= 1) {
        let f; const hasVid = beats.some(x => x.media && x.media.type === 'video');
        if (i === 1) { const im = await withTimeout(fbImg, 3500); if (im && im.url && !usedImg.has(im.url)) { f = im; usedImg.add(im.url); } }
        else if (i === 2 && !hasVid) { const v = await withTimeout(fbVid, 3500); if (v && (v.file || v.embed)) f = v; }
        if (!f && animN < 3) { animN++; const q = await withTimeout(qP, 1500); f = await withTimeout(genAnim(b.say, q), 7500); }
        if (f) b.media = f;
      }
      beats.push(b); if (stream) { head(); res.write(JSON.stringify({ beat: b }) + '\n'); } }); };
    const tail = await geminiStream(contents, SYSTEM, onBeat, emit, q => resolveQ(String(q || '').slice(0, 80))); resolveQ(''); await chain;
    if (!beats.length) throw new Error('réponse vide');
    const meta = cleanMeta(tail);
    u.history.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: beats.map(b => b.say).join(' ') }] }); u.history = u.history.slice(-20);
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
      buf = wav(pcm); audioCache.set(k, buf); if (audioCache.size > 80) audioCache.delete(audioCache.keys().next().value); save();
    }
    res.set({ 'content-type': 'audio/wav', 'x-duration-ms': Math.round((buf.length - 44) / 48), 'x-cache': hit ? 'hit' : 'miss', 'access-control-expose-headers': 'x-duration-ms,x-cache' }).send(buf);
  } catch (e) { console.error('tts', e.message); fallback('exception', 502); }
});
app.listen(process.env.PORT || 8787, () => console.log(`Bobi backend :${process.env.PORT || 8787} — ${KEY ? 'Gemini ' + MODEL : 'MODE MOCK (pas de clé)'}`));
