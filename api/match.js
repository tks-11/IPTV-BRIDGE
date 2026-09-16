// Vercel serverless function: builds the catalog AND finds the matching
// title(s) in one step, so Cloudflare only ever receives a handful of
// matched items instead of the entire multi-thousand-item catalog.
//
// Called by the Cloudflare Worker as:
//   GET /api/match?kind=movie|series&host=...&username=...&password=...&titles=Title%20One,Title%20Two

const UA = 'IPTVSmartersPro/3.0.0 (Vercel; IPTV Bridge matcher)';

function normalizeHost(host) {
  let h = (host || '').trim();
  if (!h.startsWith('http://') && !h.startsWith('https://')) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function unwrap(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (data && typeof data === 'object') {
    const values = Object.values(data);
    if (values.length && values.every((v) => v && typeof v === 'object')) return values;
  }
  return [];
}

function xtKind(kind) {
  return kind === 'channel' ? 'live' : kind;
}

function movieUrl(host, username, password, streamId, ext) {
  return `${host}/movie/${username}/${password}/${streamId}.${ext}`;
}
function liveUrl(host, username, password, streamId) {
  return `${host}/live/${username}/${password}/${streamId}.m3u8`;
}

function cleanTitle(rawTitle) {
  if (!rawTitle) return { original: '', cleanTitle: '' };
  const title = rawTitle.trim();

  let year;
  const yearMatch = title.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) year = parseInt(yearMatch[1], 10);

  let cleaned = title;
  cleaned = cleaned.replace(/^[A-Z]{2,4}\s*[:\|\-]\s*/i, '');
  cleaned = cleaned.replace(/^\[[A-Z]{2,4}\]\s*/i, '');

  const releaseTag =
    '(?:4K|UHD|2160p|1080p|720p|480p|FHD|HD|SD|HEVC|H\\.?265|H\\.?264|x265|x264|RAW|WEB[ .-]?DL|WEBRip|BluRay|BRRip|DVDRip|HDR10?|Dolby|Atmos|AAC|AC3|DTS|MULTI|MULTiSUB|Dual[ .-]?Audio)';
  cleaned = cleaned.replace(new RegExp(`\\[\\s*${releaseTag}\\s*\\]`, 'gi'), '');
  cleaned = cleaned.replace(new RegExp(`\\b${releaseTag}\\b`, 'gi'), '');
  cleaned = cleaned.replace(
    /\b(?:EN|ENG|English|FR|FRE|French|ES|SPA|Spanish|DE|GER|German|IT|ITA|Italian|PT|POR|Portuguese|HI|HIN|Hindi|AR|ARA|Arabic|TR|TUR|Turkish)\b/gi,
    ''
  );
  cleaned = cleaned.replace(/(?:S|Season\s*)(\d{1,2})\s*(?:E|Ep|Episode\s*|x|\-)\s*(\d{1,3})/gi, '');
  cleaned = cleaned.replace(/(\d{1,2})x(\d{1,3})/gi, '');
  if (year) cleaned = cleaned.replace(new RegExp(`\\b${year}\\b`, 'g'), '');
  cleaned = cleaned.replace(/\[\s*\]|\(\s*\)/g, '');
  cleaned = cleaned.replace(/[\._\-]+/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return { original: rawTitle, cleanTitle: cleaned || rawTitle, year };
}

function tokensOf(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 2);
}

function buildItems(raw, kind, catMap, host, username, password) {
  const xt = xtKind(kind);
  const out = [];
  for (const s of raw) {
    const streamId = s.stream_id ?? s.series_id;
    if (streamId === undefined || streamId === null) continue;
    const title = s.name || s.title || 'Untitled Stream';
    const cleaned = cleanTitle(title);
    const ext = s.container_extension || 'mp4';
    const catId = String(s.category_id ?? '');
    const rawYear = s.year ?? s.releaseDate ?? s.release_date;

    let url = '';
    if (xt === 'live') url = liveUrl(host, username, password, streamId);
    else if (xt === 'movie') url = movieUrl(host, username, password, streamId, ext);

    out.push({
      id: `xt_${xt}_${streamId}`,
      streamId,
      title,
      cleanTitle: cleaned.cleanTitle,
      type: kind,
      category: s.category_name || catMap.get(catId) || 'Uncategorized',
      logo: s.stream_icon || s.cover || s.movie_image,
      url,
      year: cleaned.year || (rawYear ? parseInt(String(rawYear).substring(0, 4), 10) : undefined),
      containerExtension: ext,
      identityTokens: tokensOf(title)
    });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const { kind, host: rawHost, username, password, titles: titlesRaw } = req.query;
    if (!kind || !['channel', 'movie', 'series'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be channel, movie or series' });
    }
    if (!rawHost || !username || !password) {
      return res.status(400).json({ error: 'host, username and password are required' });
    }
    if (!titlesRaw) {
      return res.status(400).json({ error: 'titles is required (comma-separated)' });
    }

    const titles = String(titlesRaw).split(',').map((t) => t.trim()).filter(Boolean);
    const queryTokenSets = titles.map((t) => new Set(tokensOf(t)));

    const host = normalizeHost(rawHost);
    const authBase = `${host}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const xt = xtKind(kind);
    const catAction = xt === 'live' ? 'get_live_categories' : xt === 'movie' ? 'get_vod_categories' : 'get_series_categories';
    const streamAction = xt === 'live' ? 'get_live_streams' : xt === 'movie' ? 'get_vod_streams' : 'get_series';

    const [catsData, streamsData] = await Promise.all([
      getJson(`${authBase}&action=${catAction}`).catch(() => []),
      getJson(`${authBase}&action=${streamAction}`)
    ]);

    const cats = unwrap(catsData, 'categories').map((c) => ({
      category_id: String(c.category_id),
      category_name: c.category_name || 'Uncategorized'
    }));
    const catMap = new Map(cats.map((c) => [c.category_id, c.category_name]));
    const raw = Array.isArray(streamsData) ? streamsData : streamsData?.streams || [];

    const items = buildItems(raw, kind, catMap, host, username, password);

    const matches = [];
    for (const item of items) {
      const itemTokens = item.identityTokens || [];
      if (!itemTokens.length) continue;
      const isMatch = queryTokenSets.some((qs) => itemTokens.some((tok) => qs.has(tok)));
      if (isMatch) {
        matches.push(item);
        if (matches.length >= 300) break;
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(matches);
  } catch (err) {
    return res.status(502).json({ error: err?.message || 'match failed' });
  }
};
