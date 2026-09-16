// Unified, edge-cached provider layer (Xtream + M3U). Per-user: every cache key
// is namespaced by the config fingerprint so users never see each other's data.
//
// Xtream catalogs are now built on Vercel (repo-root api/catalog.js) instead
// of inline here: building the full item list + search tokens for a large
// catalog was too slow for Cloudflare's free-tier 10ms CPU budget. Vercel has
// a far bigger time budget, so it does the heavy lifting and this file just
// fetches the finished JSON and caches it exactly like before.

import { configFingerprint } from './config';
import { titleIdentity } from './cleaner';
import { edgeCached, TTL } from './edgecache';
import { parseM3UPlaylist } from './m3u';
import { XtreamClient } from './xtream';
import { Genre, MediaKind, ProviderItem, UserConfig } from './types';

// Update this if your Vercel domain ever changes.
const CATALOG_BUILDER_URL = 'https://iptv-bridge-five.vercel.app/api/catalog';

function xtKind(kind: MediaKind): 'live' | 'movie' | 'series' {
  return kind === 'channel' ? 'live' : kind;
}

/** Precompute each item's search words once, so title-matching later never
 * has to run regex/normalization again per request. */
function attachTokens(items: ProviderItem[]): ProviderItem[] {
  for (const item of items) {
    item.identityTokens = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 2);
  }
  return items;
}

/** All provider items for a media kind, cached per-user at the edge. */
export async function getItems(config: UserConfig, kind: MediaKind, ctx: ExecutionContext): Promise<ProviderItem[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    return edgeCached(ctx, `xt:items:${fp}:${kind}`, TTL.STREAMS, async () => {
      const url =
        `${CATALOG_BUILDER_URL}?kind=${encodeURIComponent(kind)}` +
        `&host=${encodeURIComponent(config.host!)}` +
        `&username=${encodeURIComponent(config.username!)}` +
        `&password=${encodeURIComponent(config.password!)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Catalog builder failed: ${res.status}`);
      return (await res.json()) as ProviderItem[];
    });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const parsed = await edgeCached(ctx, `m3u:parsed:${fp}`, TTL.PLAYLIST, async () => {
      const result = await parseM3UPlaylist(config.m3uUrl!);
      return { ...result, items: attachTokens(result.items) };
    });
    const selected = config.includedCategories?.length ? new Set(config.includedCategories.map(String)) : null;
    return parsed.items.filter(
      (item) =>
        item.type === kind &&
        (!selected ||
          selected.has(item.category) ||
          selected.has(item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')))
    );
  }

  return [];
}

/** Category list for a media kind (manifest genre options), cached per-user. */
export async function getGenres(config: UserConfig, kind: MediaKind, ctx: ExecutionContext): Promise<Genre[]> {
  const fp = configFingerprint(config);

  if (config.type === 'xtream' && config.host && config.username && config.password) {
    return edgeCached(ctx, `xt:genres:${fp}:${kind}`, TTL.CATEGORIES, async () => {
      const client = new XtreamClient(config.host!, config.username!, config.password!);
      const cats = await client.getCategories(xtKind(kind)).catch(() => []);
      return cats.map((c) => ({ id: c.category_id, name: c.category_name }));
    });
  }

  if (config.type === 'm3u' && config.m3uUrl) {
    const items = await getItems(config, kind, ctx);
    const map = new Map<string, string>();
    for (const it of items) {
      const id = it.category.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!map.has(id)) map.set(id, it.category);
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  return [];
}

/** Fast title matching using each item's precomputed search words — no
 * regex or index-building happens here, just plain array/Set lookups. */
export async function getTitleMatches(
  config: UserConfig,
  kind: Exclude<MediaKind, 'channel'>,
  titles: string[],
  ctx: ExecutionContext
): Promise<ProviderItem[]> {
  const items = await getItems(config, kind, ctx);

  const queryTokenSets = titles.map(
    (t) => new Set(titleIdentity(t).split(' ').filter((w) => w.length > 2))
  );

  const matches: ProviderItem[] = [];
  for (const item of items) {
    const itemTokens = item.identityTokens || [];
    if (!itemTokens.length) continue;
    const isMatch = queryTokenSets.some((qs) => itemTokens.some((tok) => qs.has(tok)));
    if (isMatch) {
      matches.push(item);
      if (matches.length >= 300) break;
    }
  }
  return matches;
}
