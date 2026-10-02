// Screenshots of @Pontifex posts → reposts (2026-10-02). People post
// screenshots of the Pope's X posts to Bluesky; this finds them, confirms the
// tweet as best it can, and REPOSTS one clean copy from the bot account.
//
// A post is a candidate only if:
//   - it has an image whose alt text transcribes a @Pontifex tweet, and
//   - the poster added no commentary of their own (empty text, or text that
//     is just the tweet / attribution / hashtags), and
//   - it isn't a reply, a quote, or from a parody account.
// A tweet counts as confirmed when its wording closely matches a Vatican News
// story about the Pope from the days around it (most @Pontifex posts are lines
// condensed from his speeches). Unconfirmed tweets are skipped and logged.
// Each tweet is reposted once: the bot's recent reposts are checked first.
//
//   node screenshots.mjs --dry-run     # show candidates, scores and the pick
//   node screenshots.mjs               # repost (needs BSKY_HANDLE, BSKY_APP_PASSWORD)

const PDS = "https://bsky.social";
const APPVIEW = { "atproto-proxy": "did:web:api.bsky.app#bsky_appview" };
const DRY = process.argv.includes("--dry-run");
const LOOKBACK_HOURS = 72;

export const words = (s) => (s.toLowerCase().normalize("NFKD").match(/[a-z]+/g) ?? []);
const STOP = new Set("the and for that this with from have will are was were been being their there them they into than then what when where which while who whom whose your yours our ours his her hers its it's about also because more most such only very just can could would should shall may might must not nor but all any each other some own same too out over under again once here why how both few many much".split(" "));
const content = (s) => words(s).filter((w) => w.length > 3 && !STOP.has(w));

/** The tweet's own words out of an alt text: after "@Pontifex", inside quotes, else the whole alt. */
export function tweetFromAlt(alt) {
  let t = alt.replace(/\s+/g, " ").trim();
  const quoted = t.match(/[“"]([^”"]{40,})[”"]/);
  if (quoted) t = quoted[1];
  else {
    const at = t.search(/@\s?pontifex/i);
    if (at !== -1) t = t.slice(at).replace(/^@\s?pontifex\s*[:\-–—]?\s*/i, "");
  }
  return t.replace(/\s*(\d+(\.\d+)?[KkMm]? (views|likes|reposts|retweets)|\d{1,2}:\d{2} ?[AP]M.*)$/i, "").trim();
}

/** Share of a's content words that appear in b. */
export function overlap(a, b) {
  const A = content(a), B = new Set(content(b));
  if (A.length === 0) return 0;
  return A.filter((w) => B.has(w)).length / A.length;
}

const ATTRIBUTION = /\b(pope|leo|xiv|pontifex|tweet(ed)?|posted|post|on|x|twitter|via|the|from|says?|said|today|amen|holy|father)\b|#\S+|@\S+|[\p{Emoji_Presentation}\p{Extended_Pictographic}]|[^\p{L}\s]/giu;

/** True when the post's own text adds nothing but the tweet itself, attribution or tags. */
export function noCommentary(postText, tweet) {
  const left = postText.replace(/\(\d+\/\d+\)/g, " ");
  if (!left.trim()) return true;
  // The text is a transcription: nearly all its words are the tweet's.
  if (overlap(left, tweet) >= 0.9 && content(left).length >= 5) return true;
  const rest = left.replace(ATTRIBUTION, " ").replace(/\s+/g, " ").trim();
  return words(rest).length === 0;
}

async function bsky(path, auth, extra = {}) {
  const r = await fetch(`${PDS}/xrpc/${path}`, { headers: { ...auth, ...extra } });
  if (!r.ok) throw new Error(`${path.split("?")[0]} → ${r.status} ${await r.text()}`);
  return r.json();
}

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

/** Vatican News Pope stories from the feed, with their full text (JSON-LD articleBody). */
async function vaticanTexts() {
  const xml = await (await fetch("https://www.vaticannews.va/en/pope.rss.xml")).text();
  const items = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<pubDate>([^<]+)<\/pubDate>/g)]
    .map(([, link, date]) => ({ link: link.trim(), published: new Date(date) }))
    .filter((i) => Date.now() - i.published < (LOOKBACK_HOURS + 72) * 3600e3);
  const out = [];
  for (const i of items) {
    const html = await (await fetch(i.link)).text();
    const body = (html.match(/"articleBody":\s*"((?:[^"\\]|\\.)*)"/) || [])[1] ?? "";
    const sub = (html.match(/<div class="article__subTitle">([\s\S]*?)<\/div>/) || [])[1] ?? "";
    out.push({ ...i, text: `${sub} ${JSON.parse(`"${body}"`)}` });
  }
  return out;
}

async function main() {
  const { did, auth } = await login();

  // 1. Find screenshot posts.
  const seen = new Map();
  for (const q of ["Pontifex", "@Pontifex"]) {
    const j = await bsky(`app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=100&sort=latest`, auth, APPVIEW);
    for (const p of j.posts) seen.set(p.uri, p);
  }
  const candidates = [];
  for (const p of seen.values()) {
    if (Date.now() - new Date(p.indexedAt) > LOOKBACK_HOURS * 3600e3) continue;
    if (p.record.reply || p.embed?.$type?.includes("record")) continue; // replies, quotes
    if (/parody|satire|fake|not the (real )?pope/i.test(`${p.author.displayName ?? ""} ${p.author.handle}`)) continue;
    const images = p.embed?.images ?? [];
    if (images.length !== 1) continue; // one clean screenshot
    const alt = images[0].alt ?? "";
    if (!/pontifex|pope leo/i.test(alt) || alt.length < 60) continue;
    if (/screenshot of (my|a) (bluesky|feed|timeline|thread)/i.test(alt)) continue;
    const tweet = tweetFromAlt(alt);
    if (content(tweet).length < 6) continue;
    candidates.push({ uri: p.uri, cid: p.cid, author: p.author.handle, text: p.record.text ?? "", tweet, likes: p.likeCount ?? 0, at: p.indexedAt, clean: noCommentary(p.record.text ?? "", tweet) });
  }

  // 2. Group by tweet (same wording = same tweet).
  const groups = [];
  for (const c of candidates) {
    const g = groups.find((g) => overlap(c.tweet, g.tweet) >= 0.8 && overlap(g.tweet, c.tweet) >= 0.8);
    if (g) g.posts.push(c);
    else groups.push({ tweet: c.tweet, posts: [c] });
  }

  // 3. Already reposted? (the bot's last 100 reposts' subjects)
  const reposts = await bsky(`com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.repost&limit=100`, auth).catch(() => ({ records: [] }));
  const subjects = reposts.records.map((r) => r.value.subject.uri);
  const reposted = subjects.length
    ? (await bsky(`app.bsky.feed.getPosts?${subjects.slice(0, 25).map((u) => `uris=${encodeURIComponent(u)}`).join("&")}`, auth, APPVIEW)).posts.map((p) => tweetFromAlt(p.embed?.images?.[0]?.alt ?? ""))
    : [];

  // 4. Confirm against Vatican News, pick, repost.
  const vatican = groups.length ? await vaticanTexts() : [];
  for (const g of groups.sort((a, b) => b.posts.length - a.posts.length)) {
    const done = reposted.some((t) => overlap(g.tweet, t) >= 0.8);
    const best = vatican.map((v) => ({ v, score: overlap(g.tweet, v.text) })).sort((a, b) => b.score - a.score)[0];
    const confirmed = best && best.score >= 0.7;
    const clean = g.posts.filter((p) => p.clean).sort((a, b) => b.likes - a.likes || a.at.localeCompare(b.at));
    const pick = clean[0];
    console.log(`\n“${g.tweet.slice(0, 110)}…”\n  ${g.posts.length} screenshot posts, ${clean.length} without commentary; Vatican match ${best ? best.score.toFixed(2) : "-"} ${best ? best.v.link : ""}`);
    console.log(`  ${done ? "already reposted" : !confirmed ? "NOT confirmed — skipped" : !pick ? "no clean post — skipped" : `repost @${pick.author} (${pick.likes} likes): ${pick.text.slice(0, 80) || "(no text)"}`}`);
    if (DRY || done || !confirmed || !pick) continue;
    const r = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: did, collection: "app.bsky.feed.repost", record: { $type: "app.bsky.feed.repost", subject: { uri: pick.uri, cid: pick.cid }, createdAt: new Date().toISOString() } }),
    });
    if (!r.ok) throw new Error(`repost → ${r.status} ${await r.text()}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
