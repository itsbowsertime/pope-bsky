// Screenshots of @Pontifex posts → reposts (2026-10-02). People post
// screenshots of the Pope's X posts to Bluesky; this finds them, confirms the
// tweet as best it can, and REPOSTS one clean copy from the bot account.
//
// A post is a candidate only if:
//   - it has an image whose alt text transcribes a @Pontifex tweet, and
//   - the poster added no commentary of their own (empty text, or text that
//     is just the tweet / attribution / hashtags), and
//   - it isn't a reply, a quote, or from a parody account.
// A tweet counts as confirmed only when (The owner: "I'd rather miss some real ones
// than repost a fake one"): its wording matches a Vatican News story about the
// Pope from the days around it at ≥ 0.75 (most @Pontifex posts are lines
// condensed from his speeches), at least two different accounts posted it, and
// the reposted post's own alt text matches too, and no reply under any of its
// screenshot posts calls it fake (nor a moderation label). Anything less is skipped.
// Each tweet is reposted once: the bot's recent reposts are checked first.
//
//   node screenshots.mjs --dry-run     # show candidates, scores and the pick
//   node screenshots.mjs               # repost (needs BSKY_HANDLE, BSKY_APP_PASSWORD)

const PDS = "https://bsky.social";
const APPVIEW = { "atproto-proxy": "did:web:api.bsky.app#bsky_appview" };
const DRY = process.argv.includes("--dry-run");
const LOOKBACK_HOURS = 72;
const MIN_MATCH = 0.75;

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

/**
 * Neutral framing is allowed (The owner, 2026-10-02): "here's what the Pope
 * posted" is fine; opinion, jokes or reactions are not. Passes only a short
 * report — "The Pope / Pope Leo + a reporting verb + what he said" — after
 * quoted words and the tweet's own words are set aside. No I/we/you, no
 * reaction words, no profanity, no emoji but ⚠️. Narrow on purpose: when in
 * doubt it says no.
 */
const SUBJECT = /^(?:⚠️\s*)?(?:the\s+)?(?:pope(?:\s+leo(?:\s+xiv)?)?|leo\s+xiv|holy\s+father|pontiff)\b/i;
const REPORTING = /\b(says?|said|calls?(?:\s+for)?|called(?:\s+for)?|urges?|urged|appeals?|appealed|makes?\s+an?\s+appeal|thanks|thanked|expresses|expressed|prays?|prayed|posts?|posted|writes?|wrote|tweets?|tweeted|asks?|asked|warns?|warned|reminds?|reminded|condemns?|condemned|renews?|renewed|invites?|invited|encourages?|encouraged|reflects?|reflected|marks?|marked|offers?|offered)\b/i;
const PERSONAL = /\b(i|i'm|i’m|i'll|i’ll|me|my|we|we're|our|us|you|you're|your|y'all|ya|imo|lol|lmao|omg|wow|finally|boss|roast\w*|slay\w*|based|king|legend|damn|hell|shit|fuck\w*|wtf|goat|banger)\b/i;

export function neutralFrame(postText, tweet, source = "") {
  const ref = `${tweet} ${source}`; // his words: the tweet and the Vatican text it came from
  if (noCommentary(postText, tweet)) return true;
  // Quoted words must be HIS words — "Pope Leo said “touch grass”" is a joke.
  for (const [, q] of postText.matchAll(/[“"]([^”"]{3,})[”"]/g)) if (overlap(q, ref) < 0.8) return false;
  let s = postText.replace(/[“"][^”"]*[”"]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 220) return false;
  if (/[\p{Extended_Pictographic}]/u.test(s.replace(/⚠️?/g, ""))) return false;
  if (PERSONAL.test(s) || /!{1,}|\?/.test(s)) return false;
  const sentences = s.split(/(?<=[.:;])\s+/).filter((x) => x.trim().length > 1);
  if (sentences.length > 2) return false;
  const first = sentences[0].trim();
  // The owner's own example of fine: "here's what the Pope posted".
  if (/^here(?:'s|’s| is) what (?:the )?(?:pope|pontiff|holy father)(?: leo(?: xiv)?)? (?:just |has |had )?(?:posted|said|tweeted|wrote|shared)(?: (?:today|this morning|tonight|on x|on twitter))?[:.]?$/i.test(first)) return sentences.length === 1;
  if (!SUBJECT.test(first) || !REPORTING.test(first)) return false;
  // What follows the verb must be the tweet's own substance ("calls for a
  // ceasefire"), not a riff on it ("said stop getting Botox"), unless it just
  // introduces the screenshot with a colon.
  const after = first.slice(first.search(REPORTING)).replace(REPORTING, "").trim();
  if (!after || after.replace(/[:\s]+$/, "") === "") return true;
  return overlap(after, ref) >= 0.6;
}

/** A search hit → a screenshot candidate, or null. Shared with screenshots-backfill.mjs. */
export function toCandidate(p) {
  if (p.record.reply || p.embed?.$type?.includes("record")) return null; // replies, quotes
  if (/parody|satire|fake|not the (real )?pope/i.test(`${p.author.displayName ?? ""} ${p.author.handle}`)) return null;
  const images = p.embed?.images ?? [];
  if (images.length !== 1) return null; // one clean screenshot
  const alt = images[0].alt ?? "";
  if (!/pontifex|pope leo/i.test(alt) || alt.length < 60) return null;
  if (/screenshot of (my|a) (bluesky|feed|timeline|thread)/i.test(alt)) return null;
  const tweet = tweetFromAlt(alt);
  if (content(tweet).length < 6) return null;
  return { uri: p.uri, cid: p.cid, author: p.author.handle, text: p.record.text ?? "", tweet, likes: p.likeCount ?? 0, at: p.indexedAt, clean: noCommentary(p.record.text ?? "", tweet) };
}

/** Same wording (≥ 0.8 both ways) = same tweet. */
export function groupCandidates(candidates) {
  const groups = [];
  for (const c of candidates) {
    const g = groups.find((g) => overlap(c.tweet, g.tweet) >= 0.8 && overlap(g.tweet, c.tweet) >= 0.8);
    if (g) g.posts.push(c);
    else groups.push({ tweet: c.tweet, posts: [c] });
  }
  return groups;
}

/**
 * the owner's rule (2026-10-02): better to miss a real one than repost a fake. All
 * three: the wording matches a Vatican text at ≥ MIN_MATCH (real ones score
 * ~0.8+, unrelated stories ≤ ~0.4); at least two different accounts posted
 * it; and the chosen post's OWN alt text matches too. Returns the pick or null.
 */
export function confirmAndPick(group, vaticanTexts) {
  const best = vaticanTexts.map((v) => ({ v, score: overlap(group.tweet, v.text) })).sort((a, b) => b.score - a.score)[0];
  const authors = new Set(group.posts.map((p) => p.author)).size;
  const confirmed = Boolean(best && best.score >= MIN_MATCH && authors >= 2);
  // No commentary first; then a neutral report ("The Pope calls for…:").
  const clean = group.posts
    .filter((p) => best && overlap(p.tweet, best.v.text) >= MIN_MATCH)
    .map((p) => ({ ...p, neutral: !p.clean && neutralFrame(p.text, p.tweet, best.v.text) }))
    .filter((p) => p.clean || p.neutral)
    .sort((a, b) => Number(a.neutral) - Number(b.neutral) || b.likes - a.likes || a.at.localeCompare(b.at));
  return { best, authors, confirmed, clean, pick: confirmed ? clean[0] ?? null : null };
}

/**
 * Replies calling it fake (The owner, 2026-10-02): before a tweet is used, the
 * replies under its screenshot posts are read; any reply that says it's fake,
 * doctored, parody, etc. — or a moderation label on a post — and the whole
 * tweet is skipped. Errs toward skipping: "fake news" about something else
 * also counts, and that's accepted.
 */
const DISPUTE = /\b(fake|faked|not real|isn'?t real|hoax|parody|satire|satirical|doctored|photoshopp?ed|edited|altered|ai[- ]generated|fabricat\w*|made[- ]up|never said|didn'?t say|did not say|not his account|not the real|impostor|imposter|bogus|false)\b/i;

export async function disputed(posts, auth, max = 10) {
  for (const p of posts.slice(0, max)) {
    const r = await fetch(`https://bsky.social/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(p.uri)}&depth=2&parentHeight=0`, {
      headers: { ...auth, "atproto-proxy": "did:web:api.bsky.app#bsky_appview" },
    });
    if (!r.ok) return { disputed: true, why: `couldn't read replies (${r.status}) — skipping to be safe` };
    const j = await r.json();
    const labels = (j.thread?.post?.labels ?? []).filter((l) => l.src !== j.thread?.post?.author?.did);
    if (labels.length) return { disputed: true, why: `label "${labels[0].val}" on @${p.author}` };
    const stack = [...(j.thread?.replies ?? [])];
    while (stack.length) {
      const reply = stack.pop();
      const text = reply?.post?.record?.text ?? "";
      const m = text.match(DISPUTE);
      if (m) return { disputed: true, why: `reply under @${p.author}: “${text.slice(0, 80)}”` };
      stack.push(...(reply?.replies ?? []));
    }
  }
  return { disputed: false };
}

async function main() {
  const { did, auth } = await login();

  // 1. Find screenshot posts.
  const seen = new Map();
  for (const q of ["Pontifex", "@Pontifex"]) {
    const j = await bsky(`app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=100&sort=latest`, auth, APPVIEW);
    for (const p of j.posts) seen.set(p.uri, p);
  }
  const candidates = [...seen.values()]
    .filter((p) => Date.now() - new Date(p.indexedAt) <= LOOKBACK_HOURS * 3600e3)
    .map(toCandidate)
    .filter(Boolean);

  // 2. Group by tweet (same wording = same tweet).
  const groups = groupCandidates(candidates);

  // 3. Already reposted? (the bot's last 100 reposts' subjects)
  const reposts = await bsky(`com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.repost&limit=100`, auth).catch(() => ({ records: [] }));
  const subjects = reposts.records.map((r) => r.value.subject.uri);
  const reposted = subjects.length
    ? (await bsky(`app.bsky.feed.getPosts?${subjects.slice(0, 25).map((u) => `uris=${encodeURIComponent(u)}`).join("&")}`, auth, APPVIEW)).posts.map((p) => tweetFromAlt(p.embed?.images?.[0]?.alt ?? ""))
    : [];
  // …and tweets the backfill already quote-posted (screenshots-backfill.mjs).
  const feed = await bsky(`app.bsky.feed.getAuthorFeed?actor=${did}&limit=100&filter=posts_no_replies`, auth, APPVIEW);
  for (const f of feed.feed) {
    const quoted = f.post.embed?.$type === "app.bsky.embed.record#view" ? f.post.embed.record : null;
    const alt = quoted?.embeds?.[0]?.images?.[0]?.alt;
    if (alt) reposted.push(tweetFromAlt(alt));
  }

  // 4. Confirm against Vatican News, pick, repost.
  const vatican = groups.length ? await vaticanTexts() : [];
  for (const g of groups.sort((a, b) => b.posts.length - a.posts.length)) {
    const done = reposted.some((t) => overlap(g.tweet, t) >= 0.8);
    const { best, authors, confirmed, clean, pick } = confirmAndPick(g, vatican);
    console.log(`\n“${g.tweet.slice(0, 110)}…”\n  ${g.posts.length} screenshot posts from ${authors} accounts, ${clean.length} clean and matching; Vatican match ${best ? best.score.toFixed(2) : "-"} ${best ? best.v.link : ""}`);
    console.log(`  ${done ? "already reposted" : !confirmed ? "NOT confirmed — skipped" : !pick ? "no clean post — skipped" : `repost @${pick.author} (${pick.likes} likes): ${pick.text.slice(0, 80) || "(no text)"}`}`);
    const flag = !done && confirmed && pick ? await disputed([pick, ...g.posts.filter((p) => p !== pick)], auth) : { disputed: false };
    if (flag.disputed) console.log(`  SKIPPED — someone says it's fake: ${flag.why}`);
    if (DRY || done || !confirmed || !pick || flag.disputed) continue;
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
