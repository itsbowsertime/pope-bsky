// @Pontifex backfill, final format (2026-10-02). Source: the Internet Archive
// captures each @Pontifex post the moment it goes out (twitter.com/Pontifex/
// status/<id>, saved as X's own JSON, full long-post text included). Each
// tweet becomes a native Bluesky post, dated at the tweet's time:
//
//   [Posted MM/DD/YY] <his words>
//
// - "Posted" links to the original tweet on X; the date is Rome time.
// - Hashtags are Bluesky hashtags; links show short and open the real page.
// - Photos (up to 4) are attached, with the Vatican's own alt text when it
//   wrote one. Videos/GIFs: their preview frame, plus "[Original post has a video.]".
// - With no media, a link to a page gets a link card (title, picture).
// - Over 300 characters: a thread; the first post carries the date tag and
//   the card/media go on the last.
//
//   node tweets-full.mjs fetch [--limit N]   # archive JSON → tweets-full.json, oldest first
//   node tweets-full.mjs post [--limit N]    # post the oldest not yet on the account

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PDS = "https://bsky.social";
const PONTIFEX = "1922567634907791360";
const CAPS = new URL("./wayback-caps.json", import.meta.url);
const OUT = new URL("./tweets-full.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const [cmd, ...args] = process.argv.slice(2);
const limitArg = () => (args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity);
const tweetTime = (id) => Number((BigInt(id) >> 22n) + 1288834974657n);

// ---------------------------------------------------------------- fetch

/** Fallback: X's embed service. Returns null for a long post (its text would be cut off) or a miss. */
export async function embedLookup(id) {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j?.text || j.user?.screen_name?.toLowerCase() !== "pontifex") return null;
  if (j.note_tweet) return { id, skip: "long, no full text" };
  return {
    id,
    at: new Date(j.created_at).toISOString(),
    text: j.text,
    urls: (j.entities?.urls ?? []).map((u) => ({ url: u.url, expanded_url: u.expanded_url, display_url: u.display_url })).concat((j.mediaDetails ?? []).map((m) => ({ url: m.url, expanded_url: m.expanded_url, media_key: m.media_key ?? "m" }))),
    media: (j.mediaDetails ?? []).map((m) => ({ type: m.type, url: m.media_url_https, alt: m.ext_alt_text ?? null, width: m.original_info?.width, height: m.original_info?.height })),
    quoted: j.quoted_tweet?.id_str ?? null,
    source: "embed",
  };
}

async function fetchAll() {
  const caps = JSON.parse(readFileSync(CAPS, "utf8"));
  const have = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const done = new Set(have.map((t) => t.id));
  const skipped = new Set(have.filter((t) => t.skip).map((t) => t.id));
  const todo = Object.keys(caps).filter((id) => !done.has(id) && !skipped.has(id)).sort((a, b) => tweetTime(a) - tweetTime(b)).slice(0, limitArg());
  console.log(`${Object.keys(caps).length} archived; ${have.length} fetched; fetching ${todo.length}.`);
  let n = 0;
  for (const id of todo) {
    // Every archived copy of this tweet that is X's data, by its exact address
    // (copies with tracking codes in the address are separate captures; asking
    // for the plain address at a copy's time could land on X's empty page shell).
    let j = null;
    const copies = Array.isArray(caps[id]) ? caps[id] : [{ ts: caps[id], original: `https://twitter.com/Pontifex/status/${id}` }];
    for (const c of copies) {
      for (let attempt = 0; attempt < 4 && !j; attempt++) {
        try {
          const r = await fetch(`https://web.archive.org/web/${c.ts}id_/${c.original}`, { signal: AbortSignal.timeout(60_000) });
          if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
            const body = await r.json();
            if (body?.data?.id === id) j = body;
          }
          if (r.ok || r.status === 404) break;
        } catch {}
        await sleep(30_000 * (attempt + 1)); // the archive refuses connections when hurried; back off
      }
      if (j) break;
    }
    const d = j?.data;
    if (!d) {
      // Not in the archive as X's data: X's embed service has the text — complete for a
      // short post. A long post it would cut off is skipped, never posted half.
      const e = await embedLookup(id);
      have.push(e ?? { id, skip: "no data" });
    } else if (d.author_id !== PONTIFEX) {
      have.push({ id, skip: "not his" });
    } else if ((d.referenced_tweets ?? []).some((r) => r.type === "retweeted")) {
      have.push({ id, skip: "retweet" });
    } else {
      const long = d.note_tweet?.text ? d.note_tweet : null; // a long post's full text; short posts carry an empty one
      const media = (j.includes?.media ?? []).filter((m) => (d.attachments?.media_keys ?? []).includes(m.media_key));
      have.push({
        id,
        at: d.created_at,
        text: long ? long.text : d.text,
        urls: ((long ? long.entities : d.entities) ?? {}).urls ?? [],
        media: media.map((m) => ({ type: m.type, url: m.url ?? m.preview_image_url, alt: m.alt_text ?? null, width: m.width, height: m.height })),
        quoted: (d.referenced_tweets ?? []).find((r) => r.type === "quoted")?.id ?? null,
      });
    }
    if (++n % 50 === 0) {
      writeFileSync(OUT, JSON.stringify(have, null, 1));
      console.log(`${n}/${todo.length}`);
    }
    await sleep(2000);
  }
  writeFileSync(OUT, JSON.stringify(have, null, 1));
  const kinds = have.reduce((a, t) => ((a[t.skip ?? "ok"] = (a[t.skip ?? "ok"] ?? 0) + 1), a), {});
  console.log("done:", JSON.stringify(kinds));
}

// ---------------------------------------------------------------- shape

const graphemes = (s) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;
const shortUrl = (u) => {
  const x = u.replace(/^https?:\/\/(www\.)?/, "");
  return x.length > 40 ? x.slice(0, 37) + "…" : x;
};
const stamp = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", month: "2-digit", day: "2-digit", year: "2-digit" }).format(new Date(iso));

/** The tweet → its full display text and the links in it. */
export function shape(t) {
  let text = t.text;
  const links = [];
  for (const u of t.urls) {
    if (u.media_key || /\/(photo|video)\/\d+$/.test(u.expanded_url ?? "")) text = text.replace(u.url, ""); // the attached media itself
    else if (/^https?:\/\/(x|twitter)\.com\/\w+\/status\/\d+/.test(u.expanded_url ?? "") && t.quoted) text = text.replace(u.url, `x.com/…/${t.quoted}`) && links.push({ display: `x.com/…/${t.quoted}`, href: u.expanded_url });
    else {
      text = text.replace(u.url, shortUrl(u.expanded_url ?? u.url));
      links.push({ display: shortUrl(u.expanded_url ?? u.url), href: u.expanded_url ?? u.url });
    }
  }
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const video = t.media.find((m) => m.type !== "photo");
  if (video) text += "\n\n[Original post has a video.]"; // The owner, 2026-10-02: a plain note, not a link
  return { text: `[Posted ${stamp(t.at)}] ${text}`, links, video: Boolean(video) };
}

/** Split into ≤ 300-grapheme posts at sentence ends, else word breaks. */
export function split(text, max = 300) {
  const out = [];
  let rest = text;
  while (graphemes(rest) > max) {
    const head = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(rest)].slice(0, max).map((s) => s.segment).join("");
    let cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
    if (cut < max * 0.4) cut = head.lastIndexOf(" ");
    if (cut <= 0) cut = head.length;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function facets(text, links, tweetUrl, first) {
  const byte = (i) => enc.encode(text.slice(0, i)).length;
  const f = [];
  if (first && text.startsWith("[Posted ")) f.push({ index: { byteStart: byte(1), byteEnd: byte(7) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: tweetUrl }] });
  for (const m of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) f.push({ index: { byteStart: byte(m.index), byteEnd: byte(m.index + m[0].length) }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[1] }] });
  for (const l of links) {
    let from = 0, i;
    while ((i = text.indexOf(l.display, from)) !== -1) {
      f.push({ index: { byteStart: byte(i), byteEnd: byte(i + l.display.length) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: l.href }] });
      from = i + l.display.length;
    }
  }
  return f.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// ---------------------------------------------------------------- post

async function session() {
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD }) });
  if (!r.ok) throw new Error(`login → ${r.status}`);
  const s = await r.json();
  return { did: s.did, pds: s.didDoc?.service?.find((x) => x.id === "#atproto_pds")?.serviceEndpoint ?? PDS, auth: { Authorization: `Bearer ${s.accessJwt}` } };
}

async function upload(auth, url, mime) {
  for (const size of ["large", "medium", "small"]) {
    const r = await fetch(url.includes("pbs.twimg.com") ? `${url}?name=${size}` : url);
    if (!r.ok) continue;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > 950_000) continue;
    const up = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, { method: "POST", headers: { ...auth, "Content-Type": mime ?? r.headers.get("content-type") ?? "image/jpeg" }, body: bytes });
    if (up.ok) return (await up.json()).blob;
  }
  return null;
}

async function linkCard(auth, href) {
  try {
    const r = await fetch(href, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    const html = r.ok ? await r.text() : "";
    const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)="${p}"[^>]+content="([^"]*)"`, "i"))?.[1];
    const dec = (s) => (s ?? "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
    const title = dec(meta("og:title") ?? html.match(/<title>([^<]*)/i)?.[1]) || shortUrl(href);
    const img = meta("og:image");
    const thumb = img ? await upload(auth, new URL(img, href).href) : null;
    return { $type: "app.bsky.embed.external", external: { uri: href, title: title.slice(0, 300), description: dec(meta("og:description")).slice(0, 300), ...(thumb ? { thumb } : {}) } };
  } catch {
    return { $type: "app.bsky.embed.external", external: { uri: href, title: shortUrl(href), description: "" } };
  }
}

/** Tweet IDs already on the account: the "Posted" link on each thread's first post. */
async function postedIds(did, pds, auth) {
  const ids = new Set();
  let cursor;
  do {
    const r = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=100${cursor ? `&cursor=${cursor}` : ""}`, { headers: auth });
    const j = await r.json();
    for (const rec of j.records ?? []) {
      const uri = rec.value.facets?.[0]?.features?.[0]?.uri ?? "";
      const m = uri.match(/x\.com\/Pontifex\/status\/(\d+)/);
      if (m && rec.value.text?.startsWith("[Posted ")) ids.add(m[1]);
    }
    cursor = j.cursor;
  } while (cursor);
  return ids;
}

async function create(auth, did, record) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }) });
    if (r.ok) return r.json();
    if (r.status === 429 && attempt < 5) {
      await sleep(300e3);
      continue;
    }
    if (r.status >= 500 && attempt < 6) {
      await sleep(15_000 * (attempt + 1)); // Bluesky's passing 502s: wait and retry, so a thread is never left half-posted
      continue;
    }
    throw new Error(`post → ${r.status} ${await r.text()}`);
  }
}

async function post() {
  const tweets = JSON.parse(readFileSync(OUT, "utf8")).filter((t) => !t.skip).sort((a, b) => a.at.localeCompare(b.at));
  let { did, pds, auth } = await session();
  const posted = await postedIds(did, pds, auth);
  const todo = tweets.filter((t) => !posted.has(t.id)).slice(0, limitArg());
  console.log(`${tweets.length} tweets fetched; ${posted.size} on the account; posting ${todo.length}.`);
  let n = 0, started = Date.now();
  for (const t of todo) {
    if (Date.now() - started > 90 * 60e3) ({ did, pds, auth } = await session()), (started = Date.now());
    const tweetUrl = `https://x.com/Pontifex/status/${t.id}`;
    const { text, links } = shape(t);
    const parts = split(text);
    // The embed (photos, or a link card) goes on the last post of the thread.
    let embed;
    const photos = t.media.slice(0, 4);
    if (photos.length) {
      const images = [];
      for (const m of photos) {
        const blob = await upload(auth, m.url);
        if (blob) images.push({ image: blob, alt: m.alt || (m.type === "photo" ? "Photo from Pope Leo XIV's post on X" : "Preview of the video in Pope Leo XIV's post on X"), aspectRatio: { width: m.width || 1600, height: m.height || 900 } });
      }
      if (images.length) embed = { $type: "app.bsky.embed.images", images };
    } else if (links.length) {
      const pageLink = links.find((l) => !/(x|twitter)\.com\//.test(l.href));
      if (pageLink) embed = await linkCard(auth, pageLink.href);
    }
    const t0 = Date.parse(t.at);
    let root, parent;
    for (const [k, part] of parts.entries()) {
      const record = {
        $type: "app.bsky.feed.post",
        text: part,
        facets: facets(part, links, tweetUrl, k === 0),
        createdAt: new Date(t0 + k * 1000).toISOString(),
        langs: [t.lang ?? "en"],
        ...(k === parts.length - 1 && embed ? { embed } : {}),
        ...(parent ? { reply: { root, parent } } : {}),
      };
      const res = await create(auth, did, record);
      parent = { uri: res.uri, cid: res.cid };
      root ??= parent;
      await sleep(1500);
    }
    if (++n % 10 === 0 || n === todo.length) console.log(`${n}/${todo.length}  ${t.at.slice(0, 10)}  ${t.text.slice(0, 60).replace(/\n/g, " ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = { fetch: fetchAll, post }[cmd];
  if (!run) {
    console.error("usage: node tweets-full.mjs fetch [--limit N] | post [--limit N]");
    process.exit(1);
  }
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
