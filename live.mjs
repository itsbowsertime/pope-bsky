// Live @Pontifex → Bluesky, every 30 minutes (GitHub Actions; the owner, 2026-10-03).
//
// 1. X's embeddable timeline (the widget websites use) shows his 20 newest
//    tweets at once. Each new one is checked with X's embed service:
// 2. Fits in a tweet → posted right away, same format as the backfill.
// 3. A long post (X shows only its first ~280 characters) → a Todoist task
//    for today, titled with a link to the tweet. The owner screenshots it and
//    attaches the picture to the task. Each run checks open tasks:
//    - a screenshot → read it (tesseract OCR); the start must match what X
//      shows, word for word, or nothing posts. Posted, task closed.
//    - the Internet Archive releases each tweet's full text 2–4 days later;
//      if it's there first, that's used instead. Posts made from a screenshot
//      are checked against it then, and a mismatch becomes a task.
//    - a link in the hidden part can't be read off a picture: the bot asks
//      (a task comment) for the link to be pasted as a comment.
//    - or the screenshot is shared to Todoist from the phone (Photos → Share →
//      Todoist): a new Inbox task, named anything. Its picture counts for the
//      long post whose visible text it matches; that task is closed with it.
//    Completing or deleting the task by hand = skip that tweet.

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { embedLookup, session, postedIds, postTweet } from "./tweets-full.mjs";

const START = Date.parse("2026-10-01T00:00:00Z"); // the backfill covers everything before
const PONTIFEX = "1922567634907791360";
const TD = "https://api.todoist.com/api/v1";
const BOT = "🤖 Pope bot:";
const tweetTime = (id) => Number((BigInt(id) >> 22n) + 1288834974657n);
const tweetUrl = (id) => `https://x.com/Pontifex/status/${id}`;
const idIn = (s) => s?.match(/x\.com\/Pontifex\/status\/(\d+)/)?.[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function td(path, body, method = body ? "POST" : "GET") {
  const r = await fetch(TD + path, { method, headers: { Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`todoist ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

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
    console.log(`X's timeline didn't load (${r.status}); checking screenshots only, trying again next run.`);
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

// ---------------------------------------------------------------- reading a screenshot

const norm = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "").replace(/\s+/g, " ").trim().toLowerCase();

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
function visible(partial) {
  let s = partial.text;
  for (const u of partial.urls) s = s.replace(u.url, u.media_key ? "" : (u.display_url ?? ""));
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/…\s*$/, "").trim();
}

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
  const nShown = norm(shown);
  let cut = { score: 0, len: 0 };
  for (let len = Math.floor(shown.length * 0.9); len <= Math.min(fromStart.length, Math.ceil(shown.length * 1.1)); len++) {
    const score = similarity(norm(fromStart.slice(0, len)), nShown);
    if (score > cut.score) cut = { score, len };
  }
  if (cut.score < 0.95) return { problem: `the picture's text doesn't match what X shows (${Math.round(cut.score * 100)}%)` };
  const rest = fromStart.slice(cut.len).trim();
  // A picture down to the time line holds the whole post, so a short hidden part ("22:15-21)") is real.
  const toTime = lines.some((l) => /^\d{1,2}:\d{2}\s*[AP]M\b/i.test(l));
  if (rest.length < (toTime ? 1 : 10)) return { problem: "the picture shows no more than X does — is it the whole post?" };
  if (/\b[a-z0-9-]+\.(va|com|org|net|it|ly|co|be|gl)\/\S*/i.test(rest)) return { problem: "link" };
  // Join: X's exact text (keeping its line breaks), then the rest from the picture.
  return { text: `${shown.replace(/\s+$/, "")}${/^[,.;:!?]/.test(rest) ? "" : " "}${rest}`.replace(/\s*(#\w+)\s*$/, " $1") };
}

function ocr(png) {
  try {
    execSync("tesseract --version", { stdio: "ignore" });
  } catch {
    execSync("sudo apt-get install -y -qq tesseract-ocr", { stdio: "ignore" }); // only on a run that has a screenshot
  }
  writeFileSync("/tmp/shot.png", png);
  return execSync("tesseract /tmp/shot.png - --psm 4 2>/dev/null").toString();
}

const picture = (comments) => comments.filter((c) => c.file_attachment?.file_type?.startsWith("image/")).at(-1);
const download = async (c) => Buffer.from(await (await fetch(c.file_attachment.file_url, { headers: { Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}` } })).arrayBuffer());
// The picture is of this post: X's visible text matched (≥ 95%), whatever else is wrong with it.
const isOf = (read) => !read.problem || read.problem === "link" || read.problem.startsWith("the picture shows no more");

// ---------------------------------------------------------------- the run

const taskTitle = (id) => `[📸 Screenshot the Pope's long post on X](${tweetUrl(id)})`;

async function run() {
  const sess = await session();
  const posted = await postedIds(sess.did, sess.pds, sess.auth);
  const all = [];
  for (let cursor; ; ) {
    const j = await td(`/tasks?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    all.push(...j.results);
    if (!(cursor = j.next_cursor)) break;
  }
  const open = all.filter((t) => t.content.includes("Screenshot the Pope") && idIn(t.content));
  // Screenshots shared from the phone: Inbox tasks from the last week with a picture,
  // looked up only when a long post is still waiting. Never logged (they're the owner's Inbox).
  let shared;
  const sharedShots = async () => {
    if (shared) return shared;
    const inbox = (await td("/projects")).results.find((p) => p.inbox_project)?.id;
    shared = [];
    for (const t of all.filter((t) => t.project_id === inbox && !idIn(t.content) && !t.description && Date.parse(t.added_at) > Date.now() - 7 * 864e5)) {
      const pic = picture((await td(`/comments?task_id=${t.id}`)).results);
      if (pic) shared.push({ task: t, pic });
    }
    return shared;
  };
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19);
  const done = (await td(`/tasks/completed/by_completion_date?since=${since}&until=${new Date().toISOString().slice(0, 19)}&limit=200`)).items.filter((t) => t.content.includes("Screenshot the Pope") && idIn(t.content));
  const openFor = new Map(open.map((t) => [idIn(t.content), t]));
  const doneFor = new Set(done.map((t) => idIn(t.content)));

  const ids = new Set(await timeline());
  for (const t of open) ids.add(idIn(t.content)); // a pending one may have dropped off the timeline
  let report = [];
  for (const id of [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
    if (posted.has(id)) continue;
    const task = openFor.get(id);
    if (!task && doneFor.has(id)) continue; // The owner closed it by hand: skip it
    const tw = await embedLookup(id);
    if (!tw) continue; // deleted, or not his
    // Within two hours, the tweet's own time (the account stays in order); later, now — so followers see it.
    const when = Date.now() - Date.parse(tw.at) < 2 * 3600e3 ? tw.at : new Date().toISOString();
    if (!tw.partial) {
      report.push(`posted ${id}: ${await postTweet(sess, tw, when)}`);
      if (task) await td(`/tasks/${task.id}/close`, {});
      continue;
    }
    // A long post.
    if (!task) {
      await td("/tasks", {
        content: taskTitle(id),
        description: `Tap the title to open it on X, screenshot the whole post, and attach the picture here (comments → 📎) — or share the screenshot to Todoist (any name). The bot checks every 30 minutes.\n\nIt starts: “${visible(tw).slice(0, 120)}…”\n${tweetUrl(id)}`,
        due_string: "today",
      });
      report.push(`asked for a screenshot of ${id}`);
      continue;
    }
    const comments = (await td(`/comments?task_id=${task.id}`)).results;
    const said = (s) => comments.some((c) => c.content.startsWith(BOT) && c.content.includes(s));
    let full = await fromArchive(tw);
    let from = null; // the shared-from-the-phone task the picture came from
    if (!full) {
      const shot = picture(comments);
      let text, read;
      if (shot) read = readScreenshot((text = ocr(await download(shot))), tw);
      else {
        for (const s of await sharedShots()) {
          if (s.used) continue;
          s.text ??= ocr(await download(s.pic));
          const r = readScreenshot(s.text, tw);
          if (isOf(r)) {
            [from, text, read, s.used] = [s.task, s.text, r, true];
            break;
          }
        }
        if (!from) continue;
      }
      if (read.problem === "link") {
        const pasted = comments.filter((c) => !c.content.startsWith(BOT)).map((c) => c.content.match(/https?:\/\/\S+/)?.[0]).filter(Boolean).at(-1);
        if (!pasted) {
          if (!said("link")) await td("/comments", { task_id: task.id, content: `${BOT} the hidden part of this post has a link I can't read off a picture. Paste the link (tap it on X → copy) as a comment here and I'll post it.` });
          continue;
        }
        const r2 = readScreenshot(text.replace(/\b[a-z0-9-]+\.(va|com|org|net|it|ly|co|be|gl)\/\S*/i, "LINKHERE"), tw);
        if (r2.problem && r2.problem !== "link") read.problem = r2.problem;
        else {
          full = { ...tw, text: r2.text.replace("LINKHERE", "https://t.co/pasted"), urls: [...tw.urls, { url: "https://t.co/pasted", expanded_url: pasted }], source: "screenshot" };
        }
      } else if (read.problem) {
        if (!said(read.problem)) await td("/comments", { task_id: task.id, content: `${BOT} ${read.problem}. Nothing was posted — try another screenshot (the whole post, from the name down to the time).` });
        continue;
      } else full = { ...tw, text: read.text, source: "screenshot" };
      if (!full) continue;
    }
    const link = await postTweet(sess, full, when);
    await td("/comments", { task_id: task.id, content: `${BOT} posted from the ${full.source === "archive" ? "Internet Archive's copy" : "screenshot"}: ${link}${full.source === "screenshot" ? "\n[unchecked]" : ""}` });
    await td(`/tasks/${task.id}/close`, {});
    if (from) await td(`/tasks/${from.id}/close`, {});
    report.push(`posted long ${id} (${full.source}${from ? ", shared" : ""}): ${link}`);
  }

  // Posts made from a screenshot: check them against the Archive's copy once it's out.
  for (const t of done) {
    const comments = (await td(`/comments?task_id=${t.id}`)).results;
    const mine = comments.find((c) => c.content.startsWith(BOT) && c.content.includes("[unchecked]"));
    if (!mine || comments.some((c) => c.content.startsWith(BOT) && c.content.includes("checked against"))) continue;
    const id = idIn(t.content);
    const tw = await embedLookup(id);
    const arch = tw && (await fromArchive(tw));
    if (!arch) continue;
    const ours = readFromPost(mine.content);
    const same = ours === null ? null : (await postText(ours)) === norm(arch.text.replace(/https:\/\/t\.co\/\w+/g, "").replace(/&amp;/g, "&"));
    await td("/comments", { task_id: t.id, content: `${BOT} checked against the Internet Archive's copy: ${same ? "matches ✓" : "DIFFERS"}` });
    if (!same)
      await td("/tasks", {
        content: `[Pope bot: a post read from a screenshot differs from the original](${ours ?? tweetUrl(id)})`,
        description: `Compare with ${tweetUrl(id)} — delete and re-post if it's wrong (ask Claude).`,
        due_string: "today",
      });
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
