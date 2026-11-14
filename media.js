// BOBI : sources gratuites supplémentaires (images, vidéos, documents, simulations PhET, cartes, génération d'images/fichiers, recherche).
// Module autonome : chaque source est protégée (timeout + try/catch). Si l'une tombe, les autres prennent le relais.
import crypto from 'crypto';

const UA = { 'User-Agent': 'BobiBot/1.0 (https://bobi-57i1.onrender.com; chatbot educatif)' };
const enc = encodeURIComponent;
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const clean = x => String(x || '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'photo', 'image', 'video', 'file', 'des', 'les', 'une', 'dans', 'pour', 'avec', 'sur', 'est', 'qui', 'que']);
const jget = async (u, ms = 7000, headers = {}) => { const r = await fetch(u, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const tget = async (u, ms = 7000) => { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
const https = u => /^https:\/\//.test(String(u || '')) ? String(u) : (/^http:\/\//.test(String(u || '')) ? String(u).replace(/^http:/, 'https:') : '');

/* ---------- utilitaires de classement ---------- */
export const kws = q => fold(q).split(/[^a-z0-9]+/).filter(w => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w));
const score = (title, q) => { const t = fold(title), ks = kws(q); return ks.filter(k => t.includes(k.length > 6 ? k.slice(0, -1) : k)).length; };
export const variants = q => { // plusieurs formulations de la même requête (la 1re qui donne des résultats gagne)
  const base = String(q || '').replace(/[?!.,"«»]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90), w = base.split(' ').filter(Boolean), out = [base];
  const f = fold(base); if (f !== base.toLowerCase()) out.push(f);
  if (w.length > 3) out.push(w.slice(0, 3).join(' '));
  if (w.length > 2) out.push(w.slice(-2).join(' '));
  return [...new Set(out.filter(Boolean))].slice(0, 3);
};
// lance les sources en parallèle, garde ce qui répond dans le délai, trie : meilleur titre d'abord, puis priorité de la source
async function gather(jobs, ms = 7500) {
  const res = await Promise.all(jobs.map(j => Promise.race([Promise.resolve().then(j).catch(() => null), sleep(ms).then(() => null)])));
  return res.flat().filter(Boolean);
}
const pick = (cands, q, skip = [], key = c => c.url || c.embed || c.file || c.dl) => {
  const ok = cands.filter(c => key(c) && !skip.includes(key(c)));
  ok.sort((a, b) => (score(b._t || b.title, q) - score(a._t || a.title, q)) || ((a._p ?? 5) - (b._p ?? 5)));
  const c = ok[0]; if (!c) return undefined; const o = { ...c }; delete o._t; delete o._p; return o;
};

/* ---------- IMAGES ---------- */
const imgSources = q => {
  const E = enc(q), J = [];
  const wiki = lang => async () => { const r = await jget(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=8&prop=pageimages&piprop=thumbnail&pithumbsize=900&origin=*&gsrsearch=${E}`); return Object.values(r?.query?.pages || {}).filter(p => p.thumbnail?.source).map(p => ({ type: 'image', url: p.thumbnail.source, title: p.title, credit: 'Wikipédia : ' + p.title, page: `https://${lang}.wikipedia.org/wiki/` + enc(p.title.replace(/ /g, '_')), _t: p.title, _p: lang === 'fr' ? 1 : 2 })); };
  J.push(wiki('fr'), wiki('en'));
  J.push(async () => { const r = await jget(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=900&origin=*&gsrsearch=${E}`); return Object.values(r?.query?.pages || {}).filter(p => /^image\/(jpeg|png|webp|gif)/.test(p.imageinfo?.[0]?.mime || '') && p.imageinfo[0].thumburl).map(p => { const i = p.imageinfo[0]; return { type: 'image', url: i.thumburl, title: clean(p.title.replace(/^File:/, '')), credit: clean(i.extmetadata?.Artist?.value) || 'Wikimedia Commons', page: i.descriptionurl, _t: p.title, _p: 3 }; }); });
  J.push(async () => { const r = await jget(`https://images-api.nasa.gov/search?media_type=image&page_size=8&q=${E}`); return (r?.collection?.items || []).filter(i => https(i.links?.[0]?.href)).map(i => ({ type: 'image', url: https(i.links[0].href), title: clean(i.data?.[0]?.title), credit: 'NASA : ' + clean(i.data?.[0]?.title), page: 'https://images.nasa.gov/details/' + enc(i.data?.[0]?.nasa_id), _t: (i.data?.[0]?.title || '') + ' ' + (i.data?.[0]?.keywords || []).join(' '), _p: 2 })); });
  J.push(async () => { const r = await jget(`https://api.openverse.org/v1/images/?page_size=8&mature=false&q=${E}`); return (r?.results || []).filter(x => https(x.thumbnail || x.url)).map(x => ({ type: 'image', url: https(x.thumbnail || x.url), title: clean(x.title), credit: 'Openverse : ' + (clean(x.creator) || 'auteur inconnu'), page: x.foreign_landing_url || '', _t: x.title, _p: 4 })); });
  J.push(async () => { const r = await jget(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${E}`); const ids = (r?.objectIDs || []).slice(0, 5); const os = await Promise.all(ids.map(id => jget('https://collectionapi.metmuseum.org/public/collection/v1/objects/' + id, 5000).catch(() => null))); return os.filter(o => o?.primaryImageSmall && o.isPublicDomain).map(o => ({ type: 'image', url: https(o.primaryImageSmall), title: clean(o.title), credit: 'The Met : ' + clean(o.artistDisplayName || o.title), page: o.objectURL, _t: o.title + ' ' + (o.artistDisplayName || '') + ' ' + (o.objectName || ''), _p: 5 })); });
  J.push(async () => { const r = await jget(`https://api.artic.edu/api/v1/artworks/search?limit=6&fields=id,title,image_id,artist_title&q=${E}`); return (r?.data || []).filter(a => a.image_id).map(a => ({ type: 'image', url: `https://www.artic.edu/iiif/2/${a.image_id}/full/843,/0/default.jpg`, title: clean(a.title), credit: 'Art Institute of Chicago : ' + clean(a.artist_title || a.title), page: 'https://www.artic.edu/artworks/' + a.id, _t: a.title + ' ' + (a.artist_title || ''), _p: 5 })); });
  const PX = process.env.PEXELS_API_KEY, UN = process.env.UNSPLASH_ACCESS_KEY, PB = process.env.PIXABAY_KEY;
  if (PX) J.push(async () => { const r = await jget(`https://api.pexels.com/v1/search?per_page=6&query=${E}`, 7000, { Authorization: PX }); return (r?.photos || []).map(p => ({ type: 'image', url: https(p.src?.large), title: clean(p.alt), credit: 'Pexels : ' + clean(p.photographer), page: p.url, _t: p.alt, _p: 1 })); });
  if (UN) J.push(async () => { const r = await jget(`https://api.unsplash.com/search/photos?per_page=6&query=${E}&client_id=${UN}`); return (r?.results || []).map(p => ({ type: 'image', url: https(p.urls?.regular), title: clean(p.alt_description || p.description), credit: 'Unsplash : ' + clean(p.user?.name), page: p.links?.html, _t: (p.alt_description || '') + ' ' + (p.description || ''), _p: 1 })); });
  if (PB) J.push(async () => { const r = await jget(`https://pixabay.com/api/?key=${PB}&q=${E}&image_type=photo&per_page=6&safesearch=true`); return (r?.hits || []).map(p => ({ type: 'image', url: https(p.webformatURL), title: clean(p.tags), credit: 'Pixabay : ' + clean(p.user), page: p.pageURL, _t: p.tags, _p: 1 })); });
  return J;
};
export async function moreImage(query, skip = []) {
  for (const q of variants(query)) { const c = await gather(imgSources(q), 7500); const r = pick(c, q, skip); if (r) return r; }
  return undefined;
}

/* ---------- VIDÉOS ---------- */
export async function moreVideo(query, skip = [], YT = '') {
  for (const q of variants(query)) {
    const E = enc(q), J = [];
    if (YT) J.push(async () => { const r = await jget(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=moderate&maxResults=8&order=relevance&q=${E}&key=${YT}`); return (r?.items || []).filter(v => v.id?.videoId).map(v => ({ type: 'video', embed: 'https://www.youtube-nocookie.com/embed/' + v.id.videoId, title: clean(v.snippet?.title), credit: 'YouTube : ' + clean(v.snippet?.channelTitle), page: 'https://www.youtube.com/watch?v=' + v.id.videoId, _t: v.snippet?.title, _p: 1 })); });
    J.push(async () => { const r = await jget(`https://api.dailymotion.com/videos?search=${E}&fields=id,title,duration&limit=8&sort=relevance&family_filter=true`); return (r?.list || []).filter(v => v.duration < 1500).map(v => ({ type: 'video', embed: 'https://www.dailymotion.com/embed/video/' + v.id, title: clean(v.title), credit: 'Dailymotion', page: 'https://www.dailymotion.com/video/' + v.id, _t: v.title, _p: 2 })); });
    J.push(async () => { const r = await jget(`https://sepiasearch.org/api/v1/search/videos?search=${E}&count=8&sort=-match&nsfw=false`); return (r?.data || []).filter(v => https(v.embedUrl) && v.duration < 1500).map(v => ({ type: 'video', embed: https(v.embedUrl), title: clean(v.name), credit: 'PeerTube : ' + clean(v.channel?.displayName), page: https(v.url), _t: v.name, _p: 3 })); });
    J.push(async () => { const r = await jget(`https://archive.org/advancedsearch.php?fl[]=identifier&fl[]=title&rows=8&output=json&sort[]=downloads+desc&q=${enc('(' + q + ') AND mediatype:movies')}`); return (r?.response?.docs || []).map(d => ({ type: 'video', embed: 'https://archive.org/embed/' + enc(d.identifier), title: clean(d.title), credit: 'Internet Archive', page: 'https://archive.org/details/' + enc(d.identifier), _t: d.title, _p: 4 })); });
    const c = await gather(J, 8000), r = pick(c, q, skip); if (r) return r;
  }
  return undefined;
}

/* ---------- DOCUMENTS ---------- */
const mkFile = (title, author, url, format, page, credit, t) => { const fn = (clean(title) || 'document').replace(/[^\w -]/gi, '').trim().slice(0, 60) + '.' + format.toLowerCase(); return { type: 'file', title: clean(title), author: clean(author), url, format, page, credit, dl: '/api/dl?u=' + enc(url) + '&n=' + enc(fn), _t: t || title, _p: 3 }; };
export async function moreFile(query, skip = []) {
  for (const q of variants(query)) {
    const E = enc(q), J = [];
    J.push(async () => { const x = await tget(`https://export.arxiv.org/api/query?search_query=all:${E}&max_results=6&sortBy=relevance`); return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => { const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<\s]+)<\/id>/.exec(m[1])?.[1], t = /<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1], a = /<name>([^<]+)<\/name>/.exec(m[1])?.[1]; return id && t ? mkFile(t, a, 'https://arxiv.org/pdf/' + id, 'PDF', 'https://arxiv.org/abs/' + id, 'arXiv') : null; }); });
    J.push(async () => { const r = await jget(`https://api.archives-ouvertes.fr/search/?q=${E}&fl=title_s,fileMain_s,authFullName_s,uri_s&wt=json&rows=8&fq=submitType_s:file`); return (r?.response?.docs || []).filter(d => https(d.fileMain_s)).map(d => { const o = mkFile((d.title_s || [])[0], (d.authFullName_s || [])[0], https(d.fileMain_s), 'PDF', d.uri_s, 'HAL (archive ouverte)'); o._p = 2; return o; }); });
    J.push(async () => { const r = await jget(`https://zenodo.org/api/records?q=${E}&size=8&type=publication&sort=bestmatch`); return (r?.hits?.hits || []).map(h => { const f = (h.files || []).find(x => /\.(pdf|epub)$/i.test(x.key || '')); return f && https(f.links?.self) ? mkFile(h.metadata?.title, (h.metadata?.creators || [])[0]?.name, https(f.links.self), /epub$/i.test(f.key) ? 'EPUB' : 'PDF', h.links?.html, 'Zenodo') : null; }); });
    const c = await gather(J, 8000), r = pick(c, q, skip, c => c.url); if (r) return r;
  }
  return undefined;
}

/* ---------- CARTES (OpenStreetMap, gratuit) ---------- */
async function mapCard(q, base) {
  const r = await jget(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=fr&q=${enc(q)}`, 7000);
  const p = r?.[0]; if (!p?.boundingbox) return undefined;
  const [s, n, w, e] = p.boundingbox.map(Number), pad = Math.max(0.004, (n - s) * 0.1);
  return { ...base, type: 'map', title: base.title || clean(p.display_name.split(',')[0]), caption: base.caption || clean(p.display_name), src: `https://www.openstreetmap.org/export/embed.html?bbox=${w - pad},${s - pad},${e + pad},${n + pad}&layer=mapnik&marker=${p.lat},${p.lon}`, credit: '© OpenStreetMap' };
}

/* ---------- SIMULATIONS PhET (officielles, gratuites, interactives) ---------- */
const PHET = `projectile-motion|projectile trajectoire lancer parabole balle canon tir obus angle portee
forces-and-motion-basics|forces force mouvement ramp rampe plan incline incliner frottement friction newton acceleration pousser tirer
friction|frottement friction chaleur atomes
gravity-force-lab|gravite gravitation force masse distance newton planetes attraction
hookes-law|ressort hooke loi elasticite raideur
masses-and-springs|ressort masse oscillation harmonique pesanteur
pendulum-lab|pendule oscillation periode gravite
energy-skate-park|energie cinetique potentielle skate skateboard conservation rampe piste
energy-forms-and-changes|energie chaleur transformation formes thermique
collision-lab|collision choc impulsion quantite mouvement elastique
balance-and-torque|moment torque equilibre balance levier couple
moving-man|mouvement vitesse position acceleration cinematique
vector-addition|vecteur vecteurs somme addition composantes
ohms-law|ohm loi tension intensite resistance courant electricite
resistance-in-a-wire|resistance fil resistivite longueur section
circuit-construction-kit-dc|circuit electrique ampoule pile resistance serie parallele courant tension
circuit-construction-kit-ac|circuit alternatif condensateur bobine inductance
capacitor-lab-basics|condensateur capacite charge tension
faradays-law|faraday induction aimant bobine electromagnetique flux
magnets-and-electromagnets|aimant electroaimant champ magnetique
magnet-and-compass|boussole aimant champ magnetique pole
charges-and-fields|charge champ electrique potentiel equipotentielle
coulombs-law|coulomb force electrostatique charges
balloons-and-static-electricity|electricite statique ballon electrons
wave-on-a-string|onde corde vague propagation frequence amplitude
waves-intro|onde vague son lumiere eau propagation
wave-interference|interference ondes diffraction fentes
sound-waves|son onde sonore frequence hauteur
bending-light|refraction lumiere reflexion snell prisme indice
geometric-optics|lentille optique miroir image focale loupe
color-vision|couleur vision lumiere rgb filtre
blackbody-spectrum|corps noir spectre temperature rayonnement
greenhouse-effect|effet de serre climat co2 rechauffement atmosphere
states-of-matter|etats matiere solide liquide gaz molecules temperature changement etat
gas-properties|gaz pression volume temperature gaz parfait boyle
density|densite masse volume flottaison
buoyancy|flottabilite poussee archimede flotte coule fluide
fluid-pressure-and-flow|pression fluide debit tuyau bernoulli
under-pressure|pression profondeur eau fluide
rutherford-scattering|rutherford diffusion atome noyau alpha
nuclear-fission|fission nucleaire uranium reaction chaine neutron
alpha-decay|desintegration alpha radioactivite
radioactive-dating-game|datation radioactive carbone 14 demi-vie
photoelectric|photoelectrique effet photon electron lumiere
lasers|laser emission stimulee photon
models-of-the-hydrogen-atom|hydrogene atome modele bohr quantique niveaux
build-an-atom|atome proton neutron electron noyau isotope ion construire
isotopes-and-atomic-mass|isotope masse atomique abondance
neuron|neurone influx nerveux synapse potentiel action
plate-tectonics|tectonique plaques continents seisme volcan
natural-selection|selection naturelle evolution darwin adaptation genetique
gene-expression-essentials|adn arn gene proteine expression transcription traduction
membrane-channels|membrane canaux diffusion cellule transport
balancing-chemical-equations|equilibrer equation chimique reaction coefficients atomes bilan
molecule-polarity|polarite molecule electronegativite dipole
molecule-shapes|geometrie molecule vsepr forme liaison doublet
build-a-molecule|construire molecule atomes formule
reactants-products-and-leftovers|reactif limitant produit reste stoechiometrie
ph-scale|ph acide base solution echelle
acid-base-solutions|acide base solution force dissociation
concentration|concentration solution molarite dilution
beers-law-lab|beer lambert absorbance concentration spectrophotometrie
salts-and-solubility|sel solubilite precipitation ions
sugar-and-salt-solutions|sucre sel solution conductivite dissolution
reversible-reactions|equilibre chimique reaction reversible
fractions-intro|fraction fractions numerateur denominateur
fractions-equality|fractions equivalentes egalite
build-a-fraction|construire fraction
graphing-lines|droite equation pente ordonnee graphique lineaire
graphing-quadratics|parabole second degre quadratique fonction sommet racines
graphing-slope-intercept|pente ordonnee origine droite
equation-grapher|equation graphique courbe fonction
function-builder|fonction machine entree sortie
calculus-grapher|derivee integrale calcul primitive courbe
area-model-algebra|aire algebre factorisation developpement polynome
area-model-multiplication|multiplication aire
area-builder|aire perimetre surface rectangle
number-line-integers|entiers relatifs droite graduee nombres negatifs
plinko-probability|probabilite loi binomiale distribution hasard
least-squares-regression|regression droite moindres carres nuage points correlation
trig-tour|trigonometrie sinus cosinus tangente cercle trigonometrique angle
proportion-playground|proportion proportionnalite
equality-explorer|equation egalite balance resolution inconnue`.split('\n').map(l => { const [id, kw] = l.split('|'); return { id, kw: kw.split(' '), name: id.replace(/-/g, ' ') }; });
async function phetCard(q, base) {
  const ks = kws(q).map(k => k.replace(/s$/, ''));
  const ranked = PHET.map(p => ({ p, s: ks.filter(k => p.kw.some(w => w.replace(/s$/, '') === k || (k.length > 4 && w.startsWith(k.slice(0, 5))))).length + (ks.some(k => fold(p.id).includes(k)) ? 1 : 0) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
  for (const { p } of ranked) {
    const url = `https://phet.colorado.edu/sims/html/${p.id}/latest/${p.id}_all.html`;
    try { const r = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'follow', signal: AbortSignal.timeout(5000) }); if (!r.ok) continue; } catch { continue; }
    return { ...base, type: 'phet', title: base.title || 'Simulation PhET : ' + p.name, src: url + '?locale=fr', credit: 'PhET Interactive Simulations, Université du Colorado' };
  }
  return undefined;
}

/* ---------- GÉNÉRATION D'IMAGES (Gemini si disponible, sinon Pollinations, gratuit) ---------- */
export const gimgs = new Map(); // id -> { buf, mime, t }
const store = (map, v) => { const id = crypto.randomBytes(8).toString('hex'); map.set(id, { ...v, t: Date.now() }); if (map.size > 120) map.delete(map.keys().next().value); return id; };
export const genLog = []; // derniers échecs de génération (visibles via /api/diag)
const glog = s => { genLog.push(new Date().toISOString().slice(11, 19) + ' ' + s); if (genLog.length > 12) genLog.shift(); };
async function genImage(prompt, KEY) {
  const P = String(prompt || '').slice(0, 500) + ', clear, high quality illustration';
  const GK = process.env.GEMINI_API_KEY_IMAGE || KEY;
  if (GK) for (const model of [...new Set([process.env.GEMINI_IMAGE_MODEL, 'gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation', 'gemini-2.0-flash-exp-image-generation'].filter(Boolean))]) { try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: AbortSignal.timeout(28000), headers: { 'content-type': 'application/json', 'x-goog-api-key': GK }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Generate an image: ' + P }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) });
    if (!r.ok) { glog(model + ' HTTP ' + r.status); continue; }
    const j = await r.json(), part = (j.candidates?.[0]?.content?.parts || []).find(x => (x.inlineData || x.inline_data)?.data);
    if (part) { const d = part.inlineData || part.inline_data; return { id: store(gimgs, { buf: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || 'image/png' }), credit: 'Image générée par Gemini' }; }
    glog(model + ' réponse sans image');
  } catch (e) { glog(model + ' ' + e.message); } }
  const CFA = process.env.CLOUDFLARE_ACCOUNT_ID, CFT = process.env.CLOUDFLARE_API_TOKEN;
  if (CFA && CFT) { try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CFA}/ai/run/@cf/black-forest-labs/flux-1-schnell`, { method: 'POST', signal: AbortSignal.timeout(28000), headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + CFT }, body: JSON.stringify({ prompt: P, steps: 6 }) });
    if (r.ok) { const j = await r.json(); if (j?.result?.image) return { id: store(gimgs, { buf: Buffer.from(j.result.image, 'base64'), mime: 'image/jpeg' }), credit: 'Image générée par IA (Cloudflare FLUX)' }; }
    glog('cloudflare HTTP ' + r.status);
  } catch (e) { glog('cloudflare ' + e.message); } }
  if (process.env.HF_TOKEN) { try {
    const r = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + process.env.HF_TOKEN }, body: JSON.stringify({ inputs: P }) });
    const mime = r.headers.get('content-type') || ''; if (r.ok && /^image\//.test(mime)) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2000) return { id: store(gimgs, { buf, mime }), credit: 'Image générée par IA (FLUX)' }; }
    glog('huggingface HTTP ' + r.status);
  } catch (e) { glog('huggingface ' + e.message); } }
  for (const model of ['flux', 'turbo']) { try {
    const r = await fetch(`https://image.pollinations.ai/prompt/${enc(P)}?width=768&height=768&nologo=true&model=${model}&seed=${Math.floor(Math.random() * 1e6)}`, { headers: UA, signal: AbortSignal.timeout(30000) });
    const mime = r.headers.get('content-type') || ''; if (r.ok && /^image\//.test(mime)) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2000) return { id: store(gimgs, { buf, mime }), credit: 'Image générée par IA (Pollinations)' }; }
    glog('pollinations ' + model + ' HTTP ' + r.status);
  } catch (e) { glog('pollinations ' + model + ' ' + e.message); } }
  return undefined;
}

/* ---------- FICHIERS GÉNÉRÉS PAR BOBI (code, texte, html, csv…) ---------- */
export const gfiles = new Map(); // id -> { buf, name, mime, t }
const FMT = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', csv: 'text/csv', py: 'text/x-python', svg: 'image/svg+xml', xml: 'application/xml', ics: 'text/calendar' };
function genFile(m, base) {
  const raw = String(m.content || '').slice(0, 60000); if (raw.length < 3) return undefined;
  let name = String(m.title || m.filename || 'fichier.txt').replace(/[^\w.\- ()]/g, '_').slice(0, 60); if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.txt';
  const ext = name.split('.').pop().toLowerCase(); if (!FMT[ext]) name = name.replace(/\.[^.]+$/, '') + '.txt';
  const e2 = name.split('.').pop().toLowerCase(), id = store(gfiles, { buf: Buffer.from(raw.replace(/^```[a-z]*\n|\n```\s*$/g, ''), 'utf8'), name, mime: FMT[e2] || 'text/plain' });
  return { ...base, type: 'file', title: name, author: 'Créé par Bobi', format: e2.toUpperCase(), dl: '/api/gf/' + id, credit: 'Fichier généré par Bobi' };
}

/* ---------- RECHERCHE DOCUMENTAIRE (faits fiables injectés dans la réponse de Bobi) ---------- */
export async function facts(q) {
  const text = String(q || '').replace(/[?!]/g, ' ').slice(0, 120); if (kws(text).length === 0) return '';
  const one = async lang => { const r = await jget(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=2&prop=extracts&exintro=1&explaintext=1&exchars=650&exlimit=2&origin=*&gsrsearch=${enc(text)}`, 3500); return Object.values(r?.query?.pages || {}).sort((a, b) => a.index - b.index).filter(p => p.extract).map(p => `• ${p.title} : ${clean(p.extract).slice(0, 600)}`); };
  const fr = await Promise.race([one('fr').catch(() => []), sleep(3000).then(() => [])]);
  const out = fr.length ? fr : await Promise.race([one('en').catch(() => []), sleep(2000).then(() => [])]);
  return out.join('\n');
}


/* ---------- CARTES DE SCHÉMAS (rendues par le navigateur avec des bibliothèques gratuites : KaTeX, Mermaid, Chart.js) ---------- */
const stripFence = s => String(s || '').replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
const vizBase = (m, kind, extra) => ({ type: 'viz', kind, title: String(m.title || '').slice(0, 100), caption: String(m.caption || '').slice(0, 200), ...extra });
const vizJson = m => { try { return JSON.parse(stripFence(m.content)); } catch { return null; } };
async function vizCard(m) {
  const t = m.type;
  if (t === 'formula') { const lines = stripFence(m.content).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8).map(l => l.slice(0, 300)); return lines.length ? vizBase(m, 'formula', { data: lines.join('\n') }) : undefined; }
  if (t === 'diagram') { let c = stripFence(m.content).slice(0, 3000).replace(/^\s*click\s.*$/gim, '').replace(/<script|javascript:/gi, ''); return /^\s*(%%.*\n)*\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|gitGraph)/i.test(c) ? vizBase(m, 'diagram', { data: c }) : undefined; }
  if (t === 'chartjs') { const j = vizJson(m); if (!j) return undefined; const type = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea'].includes(j.type) ? j.type : 'bar';
    const labels = (Array.isArray(j.labels) ? j.labels : []).slice(0, 30).map(x => String(x).slice(0, 30)), datasets = (Array.isArray(j.datasets) ? j.datasets : []).slice(0, 4).map(d => ({ label: String(d?.label || '').slice(0, 40), data: (Array.isArray(d?.data) ? d.data : []).slice(0, 30).map(Number).filter(Number.isFinite) })).filter(d => d.data.length);
    return datasets.length ? vizBase(m, 'chartjs', { data: JSON.stringify({ type, labels, datasets, xTitle: String(j.xTitle || '').slice(0, 40), yTitle: String(j.yTitle || '').slice(0, 40) }) }) : undefined; }
  if (t === 'svg') { let s = stripFence(m.content).slice(0, 16000); const i = s.search(/<svg/i); if (i < 0) return undefined; s = s.slice(i).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '').replace(/<image[^>]*>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(xlink:)?href\s*=\s*(["'])(?!#)[^"']*\2/gi, '');
    if (!/xmlns=/.test(s)) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"'); return vizBase(m, 'svg', { data: s }); }
  if (t === 'table') { const j = vizJson(m); if (!j || !Array.isArray(j.rows)) return undefined; const cell = c => String(c ?? '').slice(0, 80);
    return vizBase(m, 'table', { data: JSON.stringify({ headers: (Array.isArray(j.headers) ? j.headers : []).slice(0, 8).map(cell), rows: j.rows.slice(0, 25).filter(Array.isArray).map(r => r.slice(0, 8).map(cell)) }) }); }
  if (t === 'molecule') { const q = String(m.query || m.title || '').trim().slice(0, 80); if (!q) return undefined;
    for (const name of [q, q.replace(/\s*\(.*?\)\s*/g, '').trim()]) { const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${enc(name)}/PNG?image_size=large`;
      try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(7000) }); if (r.ok && /image\//.test(r.headers.get('content-type') || '')) return vizBase(m, 'molecule', { url, credit: 'PubChem (NIH)' }); } catch { } }
    return undefined; }
  return undefined;
}

/* ---------- POINT D'ENTRÉE POUR LES TYPES SPÉCIAUX ---------- */
export async function special(m, { emit = () => {}, KEY = '' } = {}) {
  const base = { title: String(m.title || '').slice(0, 120), caption: String(m.caption || '').slice(0, 200) }, q = String(m.query || m.title || '').slice(0, 200);
  if (m.type === 'map') { emit({ icon: '🗺️', label: 'Je cherche sur la carte : ' + q.slice(0, 40) }); return q ? await mapCard(q, base).catch(() => undefined) : undefined; }
  if (m.type === 'phet') { emit({ icon: '🧪', label: 'Je cherche une simulation PhET' }); return q ? await phetCard(q, base).catch(() => undefined) : undefined; }
  if (m.type === 'genimage') { emit({ icon: '🎨', label: 'Je génère ton image…', gen: 'image' }); const g = q ? await genImage(q, KEY) : undefined; return g ? { ...base, type: 'image', url: '/api/gimg/' + g.id, credit: g.credit, caption: base.caption, generated: true } : undefined; }
  if (['formula', 'diagram', 'chartjs', 'svg', 'table', 'molecule'].includes(m.type)) { emit({ icon: '📐', label: 'Je prépare un schéma' }); return await vizCard(m).catch(() => undefined); }
  if (m.type === 'filegen') { emit({ icon: '📄', label: 'Je prépare le fichier' }); return genFile(m, base); }
  return undefined;
}
export const SPECIAL_TYPES = ['map', 'phet', 'genimage', 'filegen', 'formula', 'diagram', 'chartjs', 'svg', 'table', 'molecule'];
export { genImage };
