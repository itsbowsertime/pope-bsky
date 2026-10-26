// Live @Pontifex → Bluesky, every 30 minutes (GitHub Actions; the owner, 2026-10-03).
//
// 1. X's embeddable timeline (the widget websites use) shows his 20 newest
//    tweets at once. Each new one is checked with X's embed service:
// 2. Fits in a tweet → posted right away, same format as the backfill.
// 3. A long post (X shows only its first ~280 characters) → a GitHub issue in
//    this repo, labeled needs-screenshot, titled with a link to the tweet, its
//    body holding what X shows. Locked, so only collaborators can comment. The
//    owner screenshots the post on the Mac and screenshot-handoff.mjs posts its
//    full text as a comment (docs/screenshots.md). Each run checks open issues:
//    - a handoff comment from the repo owner (no one else) → checked again here
//      against what X shows, at ≥ 95%, or nothing posts. Posted, issue closed.
//    - the Internet Archive releases each tweet's full text 2–4 days later;
//      if it's there first, that's used instead. Posts made from a screenshot
//      are labeled unchecked and checked against it then; a mismatch becomes
//      a post-differs issue.
//    Closing the issue by hand = skip that tweet.
//
//   TEST_ID=<a long tweet's id> node live.mjs   # test: that tweet only, nothing posted to Bluesky

import { embedLookup, session, postedIds, postTweet } from "./tweets-full.mjs";

const START = Date.parse("2026-10-01T00:00:00Z"); // the backfill covers everything before
const PONTIFEX = "1922567634907791360";
const REPO = process.env.GITHUB_REPOSITORY; // set by Actions ("owner/name")
const OWNER = process.env.GITHUB_REPOSITORY_OWNER; // the only account whose handoff counts
const BOT_LOGIN = "github-actions[bot]"; // the account the job's GITHUB_TOKEN writes as
const BOT = "🤖 Pope bot:";
export const HANDOFF = "<!-- pope-bot full-text v1 -->";
const TEST = process.env.TEST_ID;
const tweetTime = (id) => Number((BigInt(id) >> 22n) + 1288834974657n);
const tweetUrl = (id) => `https://x.com/Pontifex/status/${id}`;
export const idIn = (s) => s?.match(/x\.com\/Pontifex\/status\/(\d+)/)?.[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(path, body, method = body ? "POST" : "GET") {
  const r = await fetch(`https://api.github.com${path}`, { method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`github ${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

/** Every page of a GitHub list. */
async function ghAll(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const j = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    all.push(...j);
    if (j.length < 100) return all;
  }
}

// The bot's own issues only (anyone can open an issue on a public repo).
const ours = (list) => list.filter((i) => !i.pull_request && i.user.login === BOT_LOGIN && idIn(i.title));
const issues = async (query) => ours(await ghAll(`/repos/${REPO}/issues?${query}`));

/** The bot's needs-screenshot issue for a tweet, open or closed, found by search (it scales past any number of issues). */
async function issueFor(id) {
  const q = `repo:${REPO} is:issue label:needs-screenshot in:title ${id}`;
  return ours((await gh(`/search/issues?q=${encodeURIComponent(q)}&per_page=10`)).items).find((i) => idIn(i.title) === id);
}

async function openIssue(title, body, labels) {
  const i = await gh(`/repos/${REPO}/issues`, { title, body, labels });
  await gh(`/repos/${REPO}/issues/${i.number}/lock`, {}, "PUT"); // only collaborators can comment now
  return i;
}
const comment = (i, body) => gh(`/repos/${REPO}/issues/${i.number}/comments`, { body });
const close = (i) => gh(`/repos/${REPO}/issues/${i.number}`, { state: "closed", state_reason: "completed" }, "PATCH");

/** His newest tweets (his own, not retweets), oldest first. */
async function timeline() {
  // X allows 30 timeline requests per 30 minutes, shared by everyone viewing his
  // timeline; they're used up within minutes of each reset (~:10 and :40). So
  // if it's busy, wait for the reset (if it's ≤ 12 minutes off) and ask first.
  const get = () => fetch("https://syndication.twitter.com/srv/timeline-profile/screen-name/Pontifex", { headers: { "User-Agent": "Mozilla/5.0" } });
  let r = await get();
  if (r.status === 429) {
    const wait = Number(r.headers.get("x-rate-limit-reset")) * 1000 - Date.now() + 1500;
    if (wait > 0 && wait <= 12 * 60e3) {
      console.log(`X's timeline is busy; waiting ${Math.round(wait / 1000)}s for its reset.`);
      await sleep(wait);
      r = await get();
    }
  }
  const m = (await r.text()).match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) {
    console.log(`X's timeline didn't load (${r.status}); checking open issues only, trying again next run.`);
    return [];
  }
  return JSON.parse(m[1]).props.pageProps.timeline.entries
    .map((e) => e.content?.tweet)
    .filter((t) => t && t.user?.id_str === PONTIFEX && !t.retweeted_status && !/^RT @/.test(t.full_text ?? t.text ?? ""))
    .map((t) => t.id_str)
    .filter((id) => tweetTime(id) >= START)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/** The full tweet from the Internet Archive, once it has released it (X's own JSON). */
async function fromArchive(partial) {
  try {
    const cdx = await (await fetch(`https://web.archive.org/cdx/search/cdx?url=twitter.com/Pontifex/status/${partial.id}&output=json&fl=timestamp,original,mimetype&filter=mimetype:application/json&limit=5`, { signal: AbortSignal.timeout(60e3) })).json();
    for (const [ts, original] of cdx.slice(1)) {
      const j = await (await fetch(`https://web.archive.org/web/${ts}id_/${original}`, { signal: AbortSignal.timeout(60e3) })).json().catch(() => null);
      const d = j?.data;
      if (!d || d.id !== partial.id) continue;
      const long = d.note_tweet?.text;
      return { ...partial, text: long ?? d.text, urls: (long ? d.note_tweet.entities?.urls : d.entities?.urls)?.map((u) => ({ url: u.url, expanded_url: u.expanded_url, ...(u.media_key ? { media_key: u.media_key } : {}) })) ?? partial.urls, source: "archive" };
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------- reading a screenshot, checking a handoff

const norm = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export const LINK = /\b[a-z0-9-]+\.(va|com|org|net|it|ly|co|be|gl)\/\S*/i;

function similarity(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length, 1);
}

/** What X shows of the tweet, without its t.co links, as the screenshot shows it. */
export function visible(partial) {
  let s = partial.text;
  for (const u of partial.urls) s = s.replace(u.url, u.media_key ? "" : (u.display_url ?? ""));
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/…\s*$/, "").trim();
}

/** The longest-matching stretch at the start of `flat` against X's visible text: { score, len }. */
function cutAt(flat, shown) {
  const nShown = norm(shown);
  let cut = { score: 0, len: 0 };
  for (let len = Math.floor(shown.length * 0.9); len <= Math.min(flat.length, Math.ceil(shown.length * 1.1)); len++) {
    const score = similarity(norm(flat.slice(0, len)), nShown);
    if (score > cut.score) cut = { score, len };
  }
  return cut;
}

// X's exact text (keeping its line breaks), then the rest.
const join = (shown, rest) => `${shown.replace(/\s+$/, "")}${/^[,.;:!?]/.test(rest) ? "" : " "}${rest}`.replace(/\s*(#\w+)\s*$/, " $1");

/**
 * The screenshot → the full tweet text, or { problem }. X's exact text is kept
 * for the part it shows; only the rest comes from the picture.
 */
export function readScreenshot(ocr, partial) {
  const lines = ocr.split("\n").map((l) => l.trim());
  // The tweet ends at the time line ("6:30 AM · Sep 27, 2026"), a link card's lone domain, or "Show translation".
  const end = lines.findIndex((l) => /^\d{1,2}:\d{2}\s*[AP]M\b/i.test(l) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l) || /^show translation/i.test(l));
  const body = lines.slice(0, end === -1 ? lines.length : end).join("\n");
  const shown = visible(partial);
  const flat = body.replace(/\s+/g, " ");
  // Where X's visible text starts and ends in the picture.
  const startKey = norm(shown).slice(0, 40);
  let best = { score: 0, at: -1 };
  for (let i = 0; i < flat.length - startKey.length; i++) {
    const score = similarity(norm(flat.slice(i, i + startKey.length + 4)).slice(0, startKey.length), startKey);
    if (score > best.score) best = { score, at: i };
  }
  if (best.score < 0.85) return { problem: "couldn't find the tweet in the picture" };
  const fromStart = flat.slice(best.at);
  // Match all of X's visible text against the same stretch of the picture.
  const cut = cutAt(fromStart, shown);
  if (cut.score < 0.95) return { problem: `the picture's text doesn't match what X shows (${Math.round(cut.score * 100)}%)` };
  const rest = fromStart.slice(cut.len).trim();
  // A picture down to the time line holds the whole post, so a short hidden part ("22:15-21)") is real.
  const toTime = lines.some((l) => /^\d{1,2}:\d{2}\s*[AP]M\b/i.test(l));
  // Nothing after X's text, down to the time line: X's free text is the whole post
  // (X marks some short posts "long"), so post X's own words.
  if (toTime && !rest) return { text: shown };
  if (rest.length < (toTime ? 1 : 10)) return { problem: "the picture shows no more than X does — is it the whole post?" };
  if (LINK.test(rest)) return { problem: "link" };
  return { text: join(shown, rest) };
}

/**
 * A handoff's full text → { text, urls } for posting, or { problem }. Checked
 * again here against what X shows now (≥ 95%): X's exact text is kept for that
 * part; only the rest comes from the handoff. Links in the rest must be whole
 * (https://…) — they become real links.
 */
export function readHandoff(full, partial) {
  const shown = visible(partial);
  const flat = full.replace(/\s+/g, " ").trim();
  const cut = cutAt(flat, shown);
  if (cut.score < 0.95) return { problem: `the handoff's text doesn't match what X shows (${Math.round(cut.score * 100)}%)` };
  let rest = flat.slice(cut.len).trim();
  if (!rest) return { text: shown, urls: [] };
  const urls = [];
  rest = rest.replace(/https?:\/\/\S+/g, (href) => {
    const url = `https://t.co/pasted${urls.length}x`; // a stand-in, shaped like X's t.co links
    urls.push({ url, expanded_url: href });
    return url;
  });
  if (LINK.test(rest.replace(/https:\/\/t\.co\/pasted\d+x/g, ""))) return { problem: "a link in the hidden part has no https:// — give the whole link (--link)" };
  return { text: join(shown, rest), urls };
}

/** The repo owner's latest handoff comment for this tweet, or null. */
export function handoff(comments, id) {
  // Only the owner's own comments count: the issue is locked, but the repo is public.
  const c = comments.filter((c) => c.user.login === OWNER && c.author_association === "OWNER" && c.body.startsWith(HANDOFF) && idIn(c.body) === id).at(-1);
  const text = c?.body.match(/\n~~~text\n([\s\S]*?)\n~~~/)?.[1];
  return text ? { at: comments.indexOf(c), text } : null;
}

// ---------------------------------------------------------------- the run

const issueTitle = (id) => `📸 Screenshot the Pope's long post: ${tweetUrl(id)}`;
const issueBody = (tw) => `The bot can't get this long post's full text for free. To fill it, take a screenshot on the Mac: see https://github.com/${REPO}/blob/master/docs/screenshots.md

Open it on X: ${tweetUrl(tw.id)}

X shows only this much:

~~~text
${visible(tw)}
~~~

Close this issue to skip the post. If the Internet Archive's copy (out 2–4 days later) comes first, the bot uses it and closes this.`;

async function run() {
  const sess = TEST ? null : await session();
  const posted = TEST ? new Set() : await postedIds(sess.did, sess.pds, sess.auth);
  const post = TEST ? async (_, t) => (console.log(`test, not posted:\n${t.text}`), "(test run: nothing posted)") : postTweet;
  const open = await issues("labels=needs-screenshot&state=open");
  const openFor = new Map(open.map((i) => [idIn(i.title), i]));
  // Closed in the last 2 days, listed directly: search can take a moment to see a change.
  const closedFor = new Map((await issues(`labels=needs-screenshot&state=closed&since=${new Date(Date.now() - 2 * 864e5).toISOString()}`)).map((i) => [idIn(i.title), i]));

  const ids = new Set(TEST ? [TEST] : await timeline());
  if (!TEST) for (const id of openFor.keys()) ids.add(id); // a pending one may have dropped off the timeline
  let report = [];
  for (const id of [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
    if (posted.has(id)) continue;
    const tw = await embedLookup(id);
    if (!tw) continue; // deleted, or not his
    let issue = openFor.get(id);
    // Within two hours, the tweet's own time (the account stays in order); later, now — so followers see it.
    const when = Date.now() - Date.parse(tw.at) < 2 * 3600e3 ? tw.at : new Date().toISOString();
    if (!tw.partial) {
      const link = await post(sess, tw, when);
      report.push(`posted ${id}: ${link}`);
      if (issue) await comment(issue, `${BOT} X now shows the whole post; posted it: ${link}`), await close(issue);
      continue;
    }
    // A long post.
    if (!issue) {
      const known = closedFor.get(id) ?? (await issueFor(id));
      if (known?.state === "closed") {
        report.push(`skipped ${id}: issue #${known.number} is closed`); // posted, or the owner skipped it
        continue;
      }
      if (!known) {
        issue = await openIssue(issueTitle(id), issueBody(tw), ["needs-screenshot"]);
        report.push(`asked for a screenshot of ${id}: issue #${issue.number}`);
        continue;
      }
      issue = known;
    }
    const comments = await ghAll(`/repos/${REPO}/issues/${issue.number}/comments`);
    let full = TEST ? null : await fromArchive(tw);
    if (!full) {
      const h = handoff(comments, id);
      if (!h) continue;
      const read = readHandoff(h.text, tw);
      if (read.problem) {
        // Said once per handoff.
        if (!comments.slice(h.at + 1).some((c) => c.user.login === BOT_LOGIN && c.body.includes(read.problem))) await comment(issue, `${BOT} ${read.problem}. Nothing was posted — run the handoff again with a new screenshot (the whole post, from the name down to the time).`);
        report.push(`handoff for ${id} refused: ${read.problem}`);
        continue;
      }
      full = { ...tw, text: read.text, urls: [...tw.urls, ...read.urls], source: "screenshot" };
    }
    const link = await post(sess, full, when);
    await comment(issue, `${BOT} posted from the ${full.source === "archive" ? "Internet Archive's copy" : "screenshot"}: ${link}`);
    if (full.source === "screenshot" && !TEST) await gh(`/repos/${REPO}/issues/${issue.number}/labels`, { labels: ["unchecked"] });
    await close(issue);
    report.push(`posted long ${id} (${full.source}): ${link}`);
  }

  // Posts made from a screenshot: check them against the Archive's copy once it's out (for 30 days).
  for (const i of TEST ? [] : await issues("labels=needs-screenshot,unchecked&state=closed")) {
    if (Date.parse(i.closed_at) < Date.now() - 30 * 864e5) continue;
    const id = idIn(i.title);
    const tw = await embedLookup(id);
    const arch = tw && (await fromArchive(tw));
    if (!arch) continue;
    const mine = (await ghAll(`/repos/${REPO}/issues/${i.number}/comments`)).filter((c) => c.user.login === BOT_LOGIN).map((c) => readFromPost(c.body)).find(Boolean) ?? null;
    const same = mine === null ? null : (await postText(mine)) === norm(arch.text.replace(/https:\/\/t\.co\/\w+/g, "").replace(/&amp;/g, "&"));
    await comment(i, `${BOT} checked against the Internet Archive's copy: ${same ? "matches ✓" : "DIFFERS"}`);
    await gh(`/repos/${REPO}/issues/${i.number}/labels/unchecked`, null, "DELETE");
    if (!same) {
      const d = await openIssue(`Pope bot: a post read from a screenshot differs from the original: ${tweetUrl(id)}`, `Our post: ${mine ?? "(not found)"}\nThe original: ${tweetUrl(id)}\nFrom #${i.number}. Delete and re-post if it's wrong (ask Claude).`, ["post-differs"]);
      report.push(`issue #${d.number}`);
    }
    report.push(`checked ${id}: ${same ? "matches" : "DIFFERS"}`);
  }
  console.log(report.length ? report.join("\n") : "nothing new");
}

const readFromPost = (comment) => comment.match(/https:\/\/bsky\.app\/\S+/)?.[0] ?? null;

/** A posted thread's words (minus the date tag and links), for the archive check. */
async function postText(webUrl) {
  const [, handle, rkey] = webUrl.match(/profile\/([^/]+)\/post\/(\w+)/);
  const did = (await (await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`)).json()).did;
  const j = await (await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${did}/app.bsky.feed.post/${rkey}&depth=20`)).json();
  const parts = [];
  for (let n = j.thread; n; n = n.replies?.find((r) => r.post.author.did === did)) parts.push(n.post.record.text);
  return norm(
    parts
      .join(" ")
      .replace(/^\[Posted [\d/]+\] /, "")
      .replace(/\[Original post has a video\.\]/, "")
      .replace(/\S+\.\S+\/\S*/g, ""),
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
