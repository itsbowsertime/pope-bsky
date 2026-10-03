// One-time screenshot backfill (2026-10-02). For @Pontifex posts since the
// election that people screenshotted onto Bluesky, QUOTE-post one clean
// screenshot post with no added text, dated at the tweet's time, so it sits in
// the account's history between that day's Vatican News stories. (A real
// repost can't be backdated — Bluesky shows it at the moment it's made — so
// the live job, screenshots.mjs, uses real reposts and this uses quotes.)
//
// Same rules as the live job (toCandidate / confirmAndPick): alt text carries
// the tweet, no commentary, ≥ 0.75 match to a Vatican News story from the
// three days before to one day after, at least two accounts, and no reply
// calling it fake (disputed()). It stops 72 hours
// back, where the live job takes over.
//
//   node screenshots-backfill.mjs search     # Bluesky search, week by week → screenshots.json
//   node screenshots-backfill.mjs confirm    # match against Vatican News stories (fetches their text) → picks
//   node screenshots-backfill.mjs post [--limit N]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { confirmAndPick, disputed, groupCandidates, overlap, toCandidate } from "./screenshots.mjs";

const PDS = "https://bsky.social";
const APPVIEW = { "atproto-proxy": "did:web:api.bsky.app#bsky_appview" };
const START = new Date("2025-05-08T00:00:00+02:00");
const END = new Date(Date.now() - 72 * 3600e3);
const HITS = new URL("./screenshots.json", import.meta.url);
const BODIES = new URL("./vatican-bodies.json", import.meta.url);
const PICKS = new URL("./screenshot-picks.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd, ...args] = process.argv.slice(2);

async function login() {
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login → ${r.status}`);
  const s = await r.json();
  return { did: s.did, auth: { Authorization: `Bearer ${s.accessJwt}` } };
}

async function search() {
  const { auth } = await login();
  const hits = new Map();
  for (let from = new Date(START); from < END; from = new Date(from.getTime() + 7 * 864e5)) {
    const to = new Date(Math.min(from.getTime() + 7 * 864e5, END.getTime()));
    for (const q of ["Pontifex", "@Pontifex", "pope leo tweet"]) {
      let cursor;
      for (let page = 0; page < 10; page++) {
        const url = `${PDS}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=100&sort=latest&since=${from.toISOString()}&until=${to.toISOString()}${cursor ? `&cursor=${cursor}` : ""}`;
        let r;
        for (let attempt = 0; ; attempt++) {
          r = await fetch(url, { headers: { ...auth, ...APPVIEW } });
          if (r.ok) break;
          // Bluesky's search has passing 502s and rate limits: wait and retry.
          if ((r.status >= 500 || r.status === 429) && attempt < 6) {
            await sleep(5000 * 2 ** attempt);
            continue;
          }
          throw new Error(`search → ${r.status} ${await r.text()}`);
        }
        const j = await r.json();
        for (const p of j.posts) {
          const c = toCandidate(p);
          if (c) hits.set(c.uri, c);
        }
        cursor = j.cursor;
        if (!cursor || !j.posts.length) break;
        await sleep(300);
      }
    }
    console.log(`${from.toISOString().slice(0, 10)}: ${hits.size} screenshot candidates so far`);
    writeFileSync(HITS, JSON.stringify([...hits.values()], null, 1)); // progress, in case it stops
  }
  writeFileSync(HITS, JSON.stringify([...hits.values()], null, 1));
}

async function articleText(link, cache) {
  if (cache[link]) return cache[link];
  const html = await (await fetch(link, { headers: { "User-Agent": "pope-bsky backfill (unofficial)" } })).text();
  const body = (html.match(/"articleBody":\s*"((?:[^"\\]|\\.)*)"/) || [])[1] ?? "";
  const sub = (html.match(/<div class="article__subTitle"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ?? "";
  let text = sub;
  try {
    text += " " + JSON.parse(`"${body}"`);
  } catch {}
  cache[link] = text;
  await sleep(800);
  return text;
}

async function confirm() {
  const hits = JSON.parse(readFileSync(HITS, "utf8"));
  const stories = JSON.parse(readFileSync(new URL("./backfill.json", import.meta.url), "utf8"));
  const cache = existsSync(BODIES) ? JSON.parse(readFileSync(BODIES, "utf8")) : {};
  const groups = groupCandidates(hits.sort((a, b) => a.at.localeCompare(b.at)));
  // Tweets the archive already gave us for real (tweets-backfill.mjs) need no screenshot.
  const real = existsSync(new URL("./tweets.json", import.meta.url)) ? JSON.parse(readFileSync(new URL("./tweets.json", import.meta.url), "utf8")) : [];
  const picks = [];
  const { auth } = await login();
  let n = 0;
  for (const g of groups) {
    const first = Math.min(...g.posts.map((p) => Date.parse(p.at)));
    const known = real.find((r) => overlap(g.tweet, r.text) >= 0.8);
    if (known) {
      console.log(`${new Date(first).toISOString().slice(0, 10)}  =  posted as the real tweet ${known.url.split("/").pop()}  ${g.tweet.slice(0, 60)}`);
      continue;
    }
    // A tweet echoes a speech from the days just before it (or the same day).
    const near = stories.filter((s) => {
      const t = Date.parse(s.published);
      return t >= first - 3 * 864e5 && t <= first + 864e5;
    });
    const texts = [];
    for (const s of near) texts.push({ link: s.link, text: await articleText(s.link, cache) });
    const { best, authors, confirmed, pick: candidate } = confirmAndPick(g, texts);
    const flag = candidate ? await disputed([candidate, ...g.posts.filter((p) => p !== candidate)], auth) : { disputed: false };
    const pick = flag.disputed ? null : candidate;
    if (flag.disputed) console.log(`   skipped, called fake: ${flag.why}`);
    if (pick) picks.push({ uri: pick.uri, cid: pick.cid, author: pick.author, at: new Date(first).toISOString(), tweet: g.tweet, source: best.v.link, score: Number(best.score.toFixed(2)), accounts: authors });
    console.log(`${new Date(first).toISOString().slice(0, 10)}  ${pick ? "✓" : "·"}  ${best ? best.score.toFixed(2) : "-  "}  ${authors} acct  ${g.tweet.slice(0, 80)}${confirmed && !pick ? "  (no clean post)" : ""}`);
    if (++n % 20 === 0) writeFileSync(BODIES, JSON.stringify(cache));
  }
  writeFileSync(BODIES, JSON.stringify(cache));
  writeFileSync(PICKS, JSON.stringify(picks, null, 1));
  console.log(`\n${groups.length} distinct tweets screenshotted; ${picks.length} confirmed with a clean post.`);
}

async function post() {
  const i = args.indexOf("--limit");
  const limit = i === -1 ? Infinity : Number(args[i + 1]);
  const picks = JSON.parse(readFileSync(PICKS, "utf8")).sort((a, b) => a.at.localeCompare(b.at));
  const { did, auth } = await login();
  // Skip any screenshot post already quoted (a rerun is safe).
  const quoted = new Set();
  let cursor;
  do {
    const s = await (await fetch(`${PDS}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=100${cursor ? `&cursor=${cursor}` : ""}`, { headers: { ...auth, ...APPVIEW } }).catch(() => null))?.json?.();
    if (!s?.records) break;
    for (const r of s.records) if (r.value.embed?.$type === "app.bsky.embed.record") quoted.add(r.value.embed.record.uri);
    cursor = s.cursor;
  } while (cursor);
  const todo = picks.filter((p) => !quoted.has(p.uri)).slice(0, limit);
  console.log(`${picks.length} picks; ${quoted.size} already quoted; posting ${todo.length}.`);
  for (const p of todo) {
    const record = { $type: "app.bsky.feed.post", text: "", createdAt: p.at, langs: ["en"], embed: { $type: "app.bsky.embed.record", record: { uri: p.uri, cid: p.cid } } };
    const r = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }) });
    if (!r.ok) throw new Error(`quote ${p.uri} → ${r.status} ${await r.text()}`);
    console.log(`${p.at.slice(0, 10)}  @${p.author}  ${p.tweet.slice(0, 70)}`);
    await sleep(2500);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = { search, confirm, post }[cmd];
  if (!run) {
    console.error("usage: node screenshots-backfill.mjs search | confirm | post [--limit N]");
    process.exit(1);
  }
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
