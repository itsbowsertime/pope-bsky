// One-time backfill (2026-10-02): every Vatican News "Pope" story since Pope
// Leo XIV's election (2025-05-08), posted to the bot dated with each story's
// own publish time, oldest first. Run from the owner's Mac, not on the schedule.
//
//   node backfill.mjs collect                 # sitemap → story pages → backfill.json (~1 page/sec)
//   node backfill.mjs post [--limit N]        # post what isn't on the account yet, oldest first
//   node backfill.mjs clear-since <ISO date>  # delete the bot's posts CREATED after a moment
//
// The half-hourly mirror must be paused while this runs (gh workflow disable
// mirror.yml): its "newer than the newest posted" rule assumes it's alone.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { decode, fit } from "./mirror.mjs";

const SITEMAP = "https://www.vaticannews.va/sitemap.en.xml";
const SINCE = new Date("2025-05-08T00:00:00+02:00"); // election day, Rome
const PDS = "https://bsky.social";
const OUT = new URL("./backfill.json", import.meta.url);
const UA = { "User-Agent": "pope-bsky backfill (unofficial; one-time, 1 req/s)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, ...args] = process.argv.slice(2);

const unescape = (s) => decode(s);

export function parseStory(html, url) {
  const meta = (p) => (html.match(new RegExp(`<meta[^>]+(?:property|name)="${p}"[^>]+content="([^"]*)"`)) || [])[1];
  const title = unescape((html.match(/<h1 class="article__title"[^>]*>([\s\S]*?)<\/h1>/) || [])[1] ?? (meta("og:title") ?? "").replace(/ - Vatican News$/, ""));
  const summary = unescape((html.match(/<div class="article__subTitle"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ?? meta("og:description") ?? "");
  // Some pages (audiences, Angelus) carry the date only in their JSON-LD.
  const published = meta("article:published_time") ?? (html.match(/"datePublished":\s*"([^"]+)"/) || [])[1];
  // The 750-wide rendition: well under Bluesky's 1 MB image limit.
  const image = meta("og:image")?.replace(/cropped\.\d+\.\d+\.jpeg$/, "cropped.750.422.jpeg") ?? null;
  if (!title || !published) return null;
  return { title, summary, link: url, published, image };
}

async function collect() {
  const xml = await (await fetch(SITEMAP, { headers: UA })).text();
  const urls = [...xml.matchAll(/<loc>(https:\/\/www\.vaticannews\.va\/en\/pope\/news\/(\d{4}-\d{2})\/[^<]+\.html)<\/loc>/g)]
    .filter(([, , month]) => month >= "2025-05")
    .map(([, u]) => u);
  const have = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const done = new Set(have.map((s) => s.link));
  const todo = urls.filter((u) => !done.has(u));
  console.log(`${urls.length} story pages since May 2025; ${have.length} already collected; fetching ${todo.length}.`);
  let n = 0;
  for (const u of todo) {
    try {
      const r = await fetch(u, { headers: UA });
      const s = r.ok ? parseStory(await r.text(), u) : null;
      if (s) have.push(s);
      else console.warn(`skip ${r.status} ${u}`);
    } catch (e) {
      console.warn(`skip ${u}: ${e.message}`);
    }
    if (++n % 50 === 0) {
      writeFileSync(OUT, JSON.stringify(have, null, 1));
      console.log(`${n}/${todo.length}`);
    }
    await sleep(1000);
  }
  writeFileSync(OUT, JSON.stringify(have, null, 1));
  const kept = have.filter((s) => new Date(s.published) >= SINCE);
  console.log(`Collected ${have.length}; ${kept.length} published on or after 2025-05-08.`);
}

async function session() {
  const handle = process.env.BSKY_HANDLE, password = process.env.BSKY_APP_PASSWORD;
  if (!handle || !password) throw new Error("BSKY_HANDLE and BSKY_APP_PASSWORD must be set.");
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: handle, password }) });
  if (!r.ok) throw new Error(`login → ${r.status}`);
  const s = await r.json();
  // The account lives on its own PDS (bsky.social is only the front door); repo reads go there.
  const pds = s.didDoc?.service?.find((x) => x.id === "#atproto_pds")?.serviceEndpoint ?? PDS;
  return { did: s.did, pds, auth: { Authorization: `Bearer ${s.accessJwt}` } };
}

/** Every post record in the bot's repo: rkey, link, createdAt. */
async function allPosts(did, auth, pds) {
  const out = [];
  let cursor;
  do {
    const r = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=100${cursor ? `&cursor=${cursor}` : ""}`, { headers: auth });
    if (!r.ok) throw new Error(`listRecords → ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const rec of j.records) out.push({ rkey: rec.uri.split("/").pop(), link: rec.value?.embed?.external?.uri, createdAt: rec.value.createdAt });
    cursor = j.cursor;
  } while (cursor);
  return out;
}

async function post() {
  const i = args.indexOf("--limit");
  const limit = i === -1 ? Infinity : Number(args[i + 1]);
  const stories = JSON.parse(readFileSync(OUT, "utf8"))
    .filter((s) => new Date(s.published) >= SINCE)
    .sort((a, b) => a.published.localeCompare(b.published));
  let { did, auth, pds } = await session();
  const posted = new Set((await allPosts(did, auth, pds)).map((p) => p.link));
  const todo = stories.filter((s) => !posted.has(s.link)).slice(0, limit);
  console.log(`${stories.length} stories since the election; ${stories.length - todo.length - (limit === Infinity ? 0 : 0)} already posted or held back; posting ${todo.length}.`);
  let n = 0, started = Date.now();
  for (const s of todo) {
    if (Date.now() - started > 90 * 60e3) ({ did, auth } = await session()), (started = Date.now()); // tokens last ~2h
    let thumb;
    if (s.image) {
      try {
        const img = await fetch(s.image, { headers: UA });
        const bytes = img.ok ? Buffer.from(await img.arrayBuffer()) : null;
        if (bytes && bytes.length < 950_000) {
          const up = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, { method: "POST", headers: { ...auth, "Content-Type": img.headers.get("content-type") || "image/jpeg" }, body: bytes });
          if (up.ok) thumb = (await up.json()).blob;
        }
      } catch {}
    }
    const record = {
      $type: "app.bsky.feed.post",
      text: fit(decode(s.summary) || decode(s.title)),
      createdAt: new Date(s.published).toISOString(),
      langs: ["en"],
      embed: { $type: "app.bsky.embed.external", external: { uri: s.link, title: decode(s.title), description: fit(decode(s.summary), 280), ...(thumb ? { thumb } : {}) } },
    };
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }) });
      if (r.ok) break;
      if (r.status === 429 && attempt < 5) {
        const reset = Number(r.headers.get("ratelimit-reset")) * 1000;
        const wait = reset ? Math.max(reset - Date.now(), 60e3) : 300e3;
        console.log(`rate limited; waiting ${Math.round(wait / 60e3)} min`);
        await sleep(wait);
        continue;
      }
      throw new Error(`post "${s.title}" → ${r.status} ${await r.text()}`);
    }
    if (++n % 25 === 0 || n === todo.length) console.log(`${n}/${todo.length}  ${s.published.slice(0, 10)}  ${s.title}`);
    await sleep(2500); // ~1,400 an hour at most; Bluesky allows 1,666
  }
}

async function clearSince() {
  const since = new Date(args[0]);
  if (isNaN(since)) throw new Error("clear-since needs an ISO date");
  const { did, auth, pds } = await session();
  const victims = (await allPosts(did, auth, pds)).filter((p) => new Date(p.createdAt) > since);
  for (const p of victims) {
    const r = await fetch(`${PDS}/xrpc/com.atproto.repo.deleteRecord`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", rkey: p.rkey }) });
    console.log(`delete ${p.createdAt} ${r.status}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = { collect, post, "clear-since": clearSince }[cmd];
  if (!run) {
    console.error("usage: node backfill.mjs collect | post [--limit N] | clear-since <ISO>");
    process.exit(1);
  }
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
