// One-time @Pontifex backfill (2026-10-02). Real tweets, not screenshots:
// the Internet Archive's Wayback Machine lists @Pontifex tweet addresses, and
// X's own embed service (the one websites use to show a tweet) returns each
// one's exact text and time — free, no API key. Each becomes a post on the bot
// dated at the tweet's time, worded as tweeted, with a card linking to it on X.
//
// Gaps (the archive thins out after May 2026) are covered by the screenshot
// quotes; screenshots-backfill.mjs skips any tweet already posted from here.
//
//   node tweets-backfill.mjs fetch            # Wayback list → embed lookups → tweets.json (~1.5 s each)
//   node tweets-backfill.mjs post [--limit N] # post what isn't on the account yet, oldest first

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fit } from "./mirror.mjs";

const PDS = "https://bsky.social";
const SINCE = Date.parse("2025-05-08T00:00:00+02:00");
const OUT = new URL("./tweets.json", import.meta.url);
const UA = { "User-Agent": "Mozilla/5.0 (pope-bsky backfill; unofficial)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, ...args] = process.argv.slice(2);

/** A tweet's time from its ID (X's IDs carry a millisecond timestamp). */
export const tweetTime = (id) => Number((BigInt(id) >> 22n) + 1288834974657n);

/** Tweet text with t.co links put back as the real address, and trailing media links dropped. */
export function cleanText(j) {
  let t = j.text ?? "";
  const [from, to] = j.display_text_range ?? [0, t.length];
  t = [...t].slice(from, to).join("");
  for (const u of j.entities?.urls ?? []) t = t.replaceAll(u.url, u.expanded_url ?? u.url);
  return t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

async function fetchAll() {
  const r = await fetch("https://web.archive.org/cdx/search/cdx?url=x.com/Pontifex/status/*&from=20250508&output=json&fl=original&collapse=urlkey&limit=10000");
  const rows = (await r.json()).slice(1);
  const ids = [...new Set(rows.map(([o]) => (o.match(/\/status\/(\d{15,20})/) || [])[1]).filter(Boolean))].filter((id) => tweetTime(id) >= SINCE);
  const have = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const done = new Set(have.map((t) => t.id));
  const todo = ids.filter((id) => !done.has(id));
  console.log(`${ids.length} @Pontifex tweet IDs in the Wayback Machine since the election; fetching ${todo.length}.`);
  let n = 0, gone = 0;
  for (const id of todo) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`, { headers: UA });
      if (res.status === 429 && attempt < 4) {
        await sleep(60_000 * (attempt + 1));
        continue;
      }
      const j = res.ok ? await res.json().catch(() => null) : null;
      // Only @Pontifex's own posts (not retweets or someone else's reply in the archive).
      if (j?.text && j.user?.screen_name?.toLowerCase() === "pontifex" && !j.retweeted_status) {
        const photo = (j.mediaDetails ?? []).find((m) => m.type === "photo")?.media_url_https ?? null;
        have.push({ id, at: new Date(j.created_at).toISOString(), text: cleanText(j), photo, url: `https://x.com/Pontifex/status/${id}` });
      } else gone++;
      break;
    }
    if (++n % 50 === 0) {
      writeFileSync(OUT, JSON.stringify(have, null, 1));
      console.log(`${n}/${todo.length}`);
    }
    await sleep(1500);
  }
  writeFileSync(OUT, JSON.stringify(have, null, 1));
  console.log(`Saved ${have.length} tweets (${gone} deleted, not found, or not @Pontifex's own).`);
}

async function session() {
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD }) });
  if (!r.ok) throw new Error(`login → ${r.status}`);
  const s = await r.json();
  const pds = s.didDoc?.service?.find((x) => x.id === "#atproto_pds")?.serviceEndpoint ?? PDS;
  return { did: s.did, pds, auth: { Authorization: `Bearer ${s.accessJwt}` } };
}

async function post() {
  const i = args.indexOf("--limit");
  const limit = i === -1 ? Infinity : Number(args[i + 1]);
  const tweets = JSON.parse(readFileSync(OUT, "utf8")).sort((a, b) => a.at.localeCompare(b.at));
  let { did, pds, auth } = await session();
  const posted = new Set();
  let cursor;
  do {
    const r = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=100${cursor ? `&cursor=${cursor}` : ""}`, { headers: auth });
    const j = await r.json();
    for (const rec of j.records ?? []) posted.add(rec.value?.embed?.external?.uri);
    cursor = j.cursor;
  } while (cursor);
  const todo = tweets.filter((t) => !posted.has(t.url)).slice(0, limit);
  console.log(`${tweets.length} tweets; posting ${todo.length}.`);
  let n = 0, started = Date.now();
  for (const t of todo) {
    if (Date.now() - started > 90 * 60e3) ({ did, pds, auth } = await session()), (started = Date.now());
    let thumb;
    if (t.photo) {
      try {
        const img = await fetch(`${t.photo}?name=small`, { headers: UA });
        const bytes = img.ok ? Buffer.from(await img.arrayBuffer()) : null;
        if (bytes && bytes.length < 950_000) {
          const up = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, { method: "POST", headers: { ...auth, "Content-Type": img.headers.get("content-type") || "image/jpeg" }, body: bytes });
          if (up.ok) thumb = (await up.json()).blob;
        }
      } catch {}
    }
    const when = new Date(t.at).toLocaleDateString("en-US", { timeZone: "Europe/Rome", month: "long", day: "numeric", year: "numeric" });
    const record = {
      $type: "app.bsky.feed.post",
      text: fit(t.text),
      createdAt: t.at,
      langs: ["en"],
      embed: { $type: "app.bsky.embed.external", external: { uri: t.url, title: `Pope Leo XIV (@Pontifex) on X · ${when}`, description: fit(t.text, 280), ...(thumb ? { thumb } : {}) } },
    };
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }) });
      if (r.ok) break;
      if (r.status === 429 && attempt < 5) {
        await sleep(300e3);
        continue;
      }
      throw new Error(`post ${t.id} → ${r.status} ${await r.text()}`);
    }
    if (++n % 25 === 0 || n === todo.length) console.log(`${n}/${todo.length}  ${t.at.slice(0, 10)}  ${t.text.slice(0, 60)}`);
    await sleep(2500);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = { fetch: fetchAll, post }[cmd];
  if (!run) {
    console.error("usage: node tweets-backfill.mjs fetch | post [--limit N]");
    process.exit(1);
  }
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
