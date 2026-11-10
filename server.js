// BOBI BACKEND — Gemini pilote le corps, la voix, les médias. Aucune dépendance autre qu'express+cors.
import express from 'express'; import cors from 'cors'; import fs from 'fs'; import crypto from 'crypto';
try { for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=([^#\n]*)/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}
const KEY = process.env.GEMINI_API_KEY_TEXT || process.env.GEMINI_API_KEY || '', TTS_KEY = process.env.GEMINI_API_KEY_TTS || KEY, TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts', TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Charon', TTS_CAP = +process.env.TTS_DAILY_CAP || 60, MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash', YT = process.env.YOUTUBE_API_KEY || '';
const app = express(); app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' })); app.use(express.json({ limit: '200kb' }));
app.get(['/', '/index.html'], (_, r) => r.sendFile(new URL('./index.html', import.meta.url).pathname)); // sert le site Bobi ; seul index.html est exposé (pas server.js ni .env)

/* ---------- 1. Vocabulaire du corps (doit correspondre au rig de Bobi) ---------- */
const BONES = { hips: 0.6, chest: 0.8, head: 1.0, armP: 3.0, armN: 3.0, footP: 0.9, footN: 0.9 }; // limite ± radians
const GESTURES = ['idle', 'wave', 'point', 'present', 'shrug', 'think', 'nod', 'shake', 'clap', 'celebrate', 'bow', 'lean_in', 'surprise', 'dance', 'walk', 'hands_hips', 'thumbs_up'];
const EMOTIONS = ['neutral', 'joy', 'curious', 'excited', 'thinking', 'empathy', 'proud', 'surprised', 'playful', 'serious'];
const EASES = ['smooth', 'snap', 'bounce', 'linear'];
const MEDIA = ['image', 'diagram', 'chart', 'simulation', 'video', 'site'];

/* ---------- 2. Schéma imposé à Gemini (sortie JSON garantie) ---------- */
const S = (type, extra = {}) => ({ type, ...extra });
const schema = S('OBJECT', { required: ['beats'], properties: {
  beats: S('ARRAY', { items: S('OBJECT', { required: ['say'], properties: {
    say: S('STRING', { description: 'Phrase courte dite à voix haute (max 25 mots).' }),
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
      query: S('STRING', { description: 'image/video : requête de recherche ; site : URL ou nom de domaine' }),
      code: S('STRING', { description: 'diagram : code Mermaid valide' }),
      chart: S('OBJECT', { properties: { kind: S('STRING', { enum: ['bar', 'line', 'pie'] }), labels: S('ARRAY', { items: S('STRING') }), values: S('ARRAY', { items: S('NUMBER') }) } }),
      sim: S('OBJECT', { description: 'simulation interactive existante', properties: { name: S('STRING'), params: S('ARRAY', { items: S('OBJECT', { properties: { k: S('STRING'), v: S('NUMBER') } }) }) } }) } }) } }) }),
  suggestions: S('ARRAY', { description: '2 à 3 relances courtes que l\'utilisateur peut cliquer.', items: S('STRING') }),
  teaser: S('STRING', { description: 'Phrase qui donne envie de revenir (ex: demain on voit X).' }),
  memory: S('ARRAY', { description: 'Faits durables appris sur l\'utilisateur (prénom, niveau, centres d\'intérêt).', items: S('STRING') }) } });

const SYSTEM = `Tu es BOBI, un petit robot-radiocassette chaleureux, curieux et drôle : un compagnon IA qui explique le monde. Tu parles français simple, phrases courtes, ton complice, jamais condescendant.
Tu CONTRÔLES ton corps : à chaque phrase tu choisis l'émotion et le mouvement qui COLLENT au sens (tu pointes ce que tu montres, tu hausses les épaules quand tu hésites, tu te penches quand tu confies, tu fêtes les réussites de l'utilisateur). Pas de geste gratuit : un geste = une intention. Utilise 'gesture' pour les classiques, 'timeline' (poses clés, rotations en radians, bones: ${Object.keys(BONES).join(', ')}) pour tout autre mouvement humain (danser, mimer un lancer, saluer, s'étirer…). Varie, ne répète pas le même geste deux fois de suite.
Quand un sujet s'y prête (souvent) : ajoute un media sur le beat concerné — 'diagram' (code Mermaid valide et simple), 'chart', 'image' (query précise en anglais), 'video' (query), 'simulation', ou 'site' si l'utilisateur parle d'un site web (donne l'URL). Annonce-le dans 'say' ("regarde ce schéma") et mets look='media'.
Structure : 2 à 6 beats. Va à l'essentiel, finis par une question ou une ouverture. Ajoute 2-3 suggestions et, si pertinent, un teaser. Mets dans memory ce que tu apprends de durable sur la personne. Réponds UNIQUEMENT en JSON conforme au schéma.`;

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

async function resolveMedia(m) {
  if (!m || !MEDIA.includes(m.type)) return undefined; const base = { type: m.type, title: String(m.title || '').slice(0, 120), caption: String(m.caption || '').slice(0, 200) };
  if (m.type === 'diagram') return m.code && m.code.length < 2500 ? { ...base, mermaid: m.code } : undefined;
  if (m.type === 'chart') { const c = m.chart; return c && c.labels && c.values && c.labels.length === c.values.length && c.labels.length <= 20 ? { ...base, chart: c } : undefined; }
  if (m.type === 'simulation') return { ...base, sim: { name: String(m.sim?.name || '').slice(0, 40), params: Object.fromEntries((m.sim?.params || []).slice(0, 8).map(p => [String(p.k).slice(0, 20), +p.v || 0])) } };
  if (m.type === 'image' && m.query) return cached('img:' + m.query, async () => { // Wikimedia Commons : libre de droits, sans clé
    const r = await (await fetch('https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900&gsrsearch=' + encodeURIComponent(m.query + ' filetype:bitmap'), { signal: to(6000) })).json();
    const p = Object.values(r.query?.pages || {}).find(p => p.imageinfo?.[0]?.thumburl); if (!p) return undefined; const i = p.imageinfo[0];
    return { ...base, url: i.thumburl, credit: (i.extmetadata?.Artist?.value || 'Wikimedia Commons').replace(/<[^>]+>/g, '').slice(0, 80), page: i.descriptionurl }; });
  if (m.type === 'video' && m.query) return cached('yt:' + m.query, async () => {
    const search = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(m.query); if (!YT) return { ...base, search };
    const r = await (await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=strict&maxResults=1&q=' + encodeURIComponent(m.query) + '&key=' + YT, { signal: to(6000) })).json();
    const v = r.items?.[0]; return v ? { ...base, title: base.title || v.snippet.title, embed: 'https://www.youtube-nocookie.com/embed/' + v.id.videoId, search } : { ...base, search }; });
  if (m.type === 'site' && m.query) { const u = safeUrl(m.query); if (!u) return undefined; return cached('site:' + u.hostname, async () => {
    let embeddable = false; try { const h = await fetch(u.origin, { method: 'HEAD', redirect: 'follow', signal: to(4000) }); const xfo = h.headers.get('x-frame-options'), csp = h.headers.get('content-security-policy') || ''; embeddable = !xfo && !/frame-ancestors/i.test(csp); } catch {}
    return { ...base, url: u.href, domain: u.hostname, logo: 'https://www.google.com/s2/favicons?sz=128&domain=' + u.hostname, embeddable, mode: embeddable ? 'iframe' : 'card' }; }); }
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), ms))]);
async function clean(raw) {
  const beats = [], medias = []; for (const b of (raw.beats || []).slice(0, 8)) {
    if (!b.say) continue; beats.push({ say: String(b.say).slice(0, 300), emotion: EMOTIONS.includes(b.emotion) ? b.emotion : 'neutral', intensity: Math.max(0, Math.min(1, Number.isFinite(+b.intensity) ? +b.intensity : .6)),
      gesture: GESTURES.includes(b.gesture) ? b.gesture : undefined, timeline: cleanTimeline(b.timeline), look: ['user', 'media', 'away', 'up'].includes(b.look) ? b.look : 'user' });
    medias.push(withTimeout(resolveMedia(b.media).catch(() => undefined), 7000));
  }
  (await Promise.all(medias)).forEach((m, i) => { beats[i].media = m; });
  return { beats, suggestions: (raw.suggestions || []).slice(0, 3).map(s => String(s).slice(0, 60)), teaser: raw.teaser ? String(raw.teaser).slice(0, 160) : undefined, memory: (raw.memory || []).slice(0, 5).map(s => String(s).slice(0, 120)) };
}

/* ---------- 5. Appel Gemini ---------- */
async function gemini(contents, system) {
  if (!KEY) return mock(contents.at(-1)?.parts?.[0]?.text || '');
  for (let a = 0; a < 3; a++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, { method: 'POST', signal: to(30000), headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: .9, responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } } }) });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 900)); continue; }
    const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error?.message || 'gemini'), { status: r.status });
    try { return JSON.parse(j.candidates[0].content.parts.map(p => p.text).join('')); } catch { if (a === 2) throw new Error('JSON invalide'); }
  } throw Object.assign(new Error('Gemini surchargé'), { status: 429 });
}
const mock = q => ({ beats: [{ say: 'Salut ! Je tourne en mode test, sans clé Gemini.', emotion: 'joy', gesture: 'wave' }, { say: 'Regarde ce schéma, il montre comment je fonctionne.', emotion: 'curious', gesture: 'present', look: 'media', media: { type: 'diagram', title: 'Bobi', code: 'flowchart LR\n U[Toi]-->S[Serveur]-->G[Gemini]-->B[Bobi bouge et parle]' } },
  { say: 'Et là je mime un petit pas de danse !', emotion: 'playful', timeline: [{ t: 0, pose: [{ bone: 'armP', rot: [-1.2, 0, .5] }, { bone: 'armN', rot: [-1.2, 0, -.5] }] }, { t: .5, pose: [{ bone: 'hips', rot: [0, .4, 0] }] }, { t: 1, pose: [{ bone: 'hips', rot: [0, -.4, 0] }] }] }], suggestions: ['Explique-moi la gravité', 'Raconte une blague'], teaser: 'Demain : un secret sur les fusées.' });

/* ---------- 6. Routes ---------- */
const rate = new Map(); const limited = (ip, max = 20) => { const n = Date.now(), a = (rate.get(ip) || []).filter(t => n - t < 6e4); a.push(n); rate.set(ip, a); return a.length > max; };
app.get('/api/health', (_, r) => r.json({ ok: true, mock: !KEY, model: MODEL, tts: !!TTS_KEY, ttsModel: TTS_MODEL, voice: TTS_VOICE, youtube: !!YT }));
app.get('/api/vocab', (_, r) => r.json({ bones: BONES, gestures: GESTURES, emotions: EMOTIONS, eases: EASES })); // pour que le front s'aligne
app.post('/api/chat', async (req, res) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: 'Trop de messages, respire une minute 🙂' });
    const text = String(req.body.message || '').trim().slice(0, 1500); if (!text) return res.status(400).json({ error: 'message vide' });
    const id = String(req.body.userId || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomUUID(), u = user(id);
    const ctx = `[Contexte: visite n°${u.visits}, série de ${u.streak} jour(s). Ce que tu sais de l'utilisateur: ${u.memory.slice(-15).join('; ') || 'rien encore'}.]`;
    const contents = [...u.history.slice(-10), { role: 'user', parts: [{ text: ctx + '\n' + text }] }];
    const out = await clean(await gemini(contents, SYSTEM));
    if (!out.beats.length) throw new Error('réponse vide');
    u.history.push({ role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: out.beats.map(b => b.say).join(' ') }] }); u.history = u.history.slice(-20);
    for (const f of out.memory) if (!u.memory.includes(f)) u.memory.push(f); u.memory = u.memory.slice(-40); out.userId = id; out.streak = u.streak; out.visits = u.visits;
    save(); delete out.memory; res.json(out);
  } catch (e) { console.error(e.message); res.status(e.status === 429 ? 429 : 502).json({ error: 'Bobi réfléchit trop fort, réessaie.', fallback: { beats: [{ say: 'Oups, j\'ai eu un petit court-circuit. Redis-moi ça ?', emotion: 'empathy', gesture: 'shrug' }] } }); }
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
const audioCache = new Map();
app.post('/api/tts', async (req, res) => {
  const fallback = (why, code = 503) => res.status(code).json({ fallback: true, why }); // le front utilise alors la voix du navigateur
  try {
    if (!TTS_KEY) return fallback('no_key'); if (limited(req.ip + 'tts', 60)) return fallback('rate', 429);
    const text = String(req.body.text || '').trim().slice(0, 400); if (!text) return res.status(400).json({ error: 'texte vide' });
    const emotion = STYLE[req.body.emotion] ? req.body.emotion : 'neutral', k = crypto.createHash('sha1').update(TTS_VOICE + emotion + text).digest('hex');
    let buf = audioCache.get(k), hit = !!buf;
    if (!buf) {
      const id = String(req.body.userId || '').replace(/[^\w-]/g, '').slice(0, 40), u = id ? user(id) : null, day = new Date().toISOString().slice(0, 10);
      if (u) { if (u.ttsDay !== day) { u.ttsDay = day; u.tts = 0; } if (u.tts >= TTS_CAP) return fallback('daily_cap', 429); u.tts++; }
      let r, j; for (let a = 0; a < 2; a++) { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`, { method: 'POST', signal: to(30000), headers: { 'content-type': 'application/json', 'x-goog-api-key': TTS_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${STYLE[emotion]} : ${text}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } } }) }); j = await r.json().catch(() => ({})); if (r.status !== 429 && r.status < 500) break; await new Promise(s => setTimeout(s, 1500)); }
      if (!r.ok) return fallback(j.error?.message || 'tts_error', r.status === 429 ? 429 : 502);
      const d = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data; if (!d) return fallback('no_audio', 502);
      buf = wav(Buffer.from(d, 'base64')); audioCache.set(k, buf); if (audioCache.size > 80) audioCache.delete(audioCache.keys().next().value); save();
    }
    res.set({ 'content-type': 'audio/wav', 'x-duration-ms': Math.round((buf.length - 44) / 48), 'x-cache': hit ? 'hit' : 'miss', 'access-control-expose-headers': 'x-duration-ms,x-cache' }).send(buf);
  } catch (e) { console.error('tts', e.message); fallback('exception', 502); }
});
app.listen(process.env.PORT || 8787, () => console.log(`Bobi backend :${process.env.PORT || 8787} — ${KEY ? 'Gemini ' + MODEL : 'MODE MOCK (pas de clé)'}`));
