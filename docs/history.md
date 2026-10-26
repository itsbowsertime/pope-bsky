# History and decisions

Newest last. Each entry: what was decided, and why.

## 2026-10-02 — Day one

- **The question:** is there a Bluesky account that re-posts the Pope's X
  posts? No. X's API is pay-per-use, and the owner didn't want to pay X anything.
- **First version: Vatican News.** `mirror.mjs` posted each story from Vatican
  News' "Pope" RSS feed every 30 minutes (GitHub Actions). Account created by
  the owner with a masked email; handle later changed to
  **@popeleo-bot.bsky.social**.
- **Backfill from May 8, 2025** (the election) — `backfill.mjs`, 1,587 stories.
- **Screenshot reposts** (`screenshots.mjs`): many people post screenshots of
  @Pontifex tweets on Bluesky. The bot reposts one clean copy, with checks the owner
  set one at a time:
  - the screenshot's alt text carries the tweet;
  - no commentary from the poster — later loosened to allow a *neutral* report
    ("here's what the Pope posted"), never opinion or jokes;
  - matches a Vatican News text at ≥ 0.75 of content words;
  - at least two accounts posted it;
  - no replies calling it fake (narrowed after a joke reply — "AI generated"
    on a Minion meme — tripped it: the claim must be about *this* post).
  - Her rule, which governs everything since: **"I would rather miss some real
    ones than repost a fake one."**
- **Primary source found.** The Internet Archive (Wayback Machine) has captures
  of @Pontifex tweet addresses; X's free embed service returns each tweet.
  First built as backdated **screenshots** of X's embed, full text in alt text
  (`tweets-backfill.mjs`). The owner: no link back to X needed.
- **Vatican News posts removed** from the account (data kept — "don't delete
  them yet"); the account became "Pope Leo XIV on X (unofficial)". The
  30-minute job was **paused** until future posting was decided.
- **Problem:** X's embed cuts long posts off with "Show more". Before/after
  examples shown; then the full text turned up in the Archive's captures under
  `twitter.com/...` — X's own JSON, with `note_tweet` (long-post text).
- **Format change → native text posts** (The owner, after seeing samples):
  - recover links ("Original tweet links to…" → became real clickable links);
  - `[Posted MM/DD/YY]` at the start; then **"Posted" itself linked** to the
    tweet (Bluesky supports links on text);
  - media attached; videos: **"[Original post has a video.]"** — the owner's exact
    wording, instead of a link.
- **Troubleshoot before the full run** ("better now, when we'd only have to
  delete fewer"): 9 tweets had the wrong capture address → exact addresses +
  embed fallback for short posts.
- Bluesky 502 left a half-posted thread → deleted, retries added, thread
  completeness check after every run.

## 2026-10-03 — Backfill complete, live posting

- **Backfill done:** 913 tweets from the Archive. Skipped: 26 that were other
  people's retweets/replies filed under @Pontifex addresses (correct), and 15
  long posts no free source had in full.
- **The 15:** the owner took screenshots on X herself; transcribed, checked word for
  word against X's visible text (all 15 matched), links verified on
  vatican.va / popesprayer.va, posted → **928 / 928**. (`manual-15.json`)
- **Sept 30 duplicate:** he posted a two-part thread with "#Apostolic Journey"
  (typo), deleted it, re-posted 3 minutes later. The deleted copy was removed.
- **Live posting — sources investigated:**
  - The Archive captures within seconds but **releases 2–4 days later**.
  - xcancel/Nitter-type viewers are gone; X's own timeline needs a login.
  - **X's embeddable timeline** (the website widget) shows his 20 newest with
    no delay — but long posts cut at ~280 characters, and a rate limit of
    **30 per 30 minutes shared by everyone**, used up within ~5 minutes of
    each reset. Fix: wait for the reset (≤ 12 min) and ask first.
- **The owner's design for long posts:** a Todoist task for today; she screenshots
  the tweet live and attaches it; each 30-minute run checks for it. She asked
  that the task include the tweet's link → the task title *is* the link.
- Screenshot reading: tesseract OCR. Tested on three known long posts: two
  word for word; the third had a hidden link → the bot asks for it to be
  pasted as a comment (tested too).
- **Repo stays private for a 2-day test** (The owner) to see Actions minutes; then
  decide on making it public (planned, "not yet").
- **First live run:** posted the two Oct 1 tweets, asked for a screenshot of
  the long Oct 2 one (AI and art).

- **GitHub's schedule dropped most runs** (2 of ~20 in the first 10 hours). The
  screenshot of the Oct 2 post still went through (posted 7:52 am Chicago, a
  three-post thread). Fix (The owner: "lets do it"): a Cloudflare Worker cron at
  :02/:32 starts the workflow through GitHub's API; GitHub's own schedule removed.

## 2026-10-26 — Screenshots from the phone

- **Tested: can the Mac fetch long posts itself?** A fresh, logged-out
  automated Chrome got **403 Forbidden** from x.com on every post, before any
  page loaded (a plain request got 200, so it's the automation X refuses).
  Getting past that would mean disguising the browser — not a free public
  source, and fragile. Dropped.
- **Instead: share the screenshot to Todoist** (Photos → Share → Todoist). The
  owner tested it: it makes a new Inbox task (Todoist insists on a name) with
  the picture as an `image/png` comment — the same kind the bot already reads.
  The bot now matches such pictures to waiting posts by their text, so the
  owner never picks a task. Chosen over an iPhone Shortcut, which would need
  a copy of the Todoist token on the phone.
- **The 10-character rule was too strict:** the Oct 18 post's hidden part is
  only "22:15-21)" (9). A picture down to the time line now counts with any
  hidden part; without the time line, 10 characters are still required.
  (The owner had attached that picture on Oct 25; it posted once this shipped.)
- **X marks some short posts "long"** (`note_tweet` on a 235-character post,
  Oct 25). A screenshot down to the time line showing nothing beyond X's text
  now posts X's own text as is (the owner, OK'd).
- **Screenshots taken on the Mac** work too: Claude opens the posts in the
  default browser, the owner screenshots (⌘⇧4, saved as files), Claude
  OCR-matches each to its post with `readScreenshot`, shows the hidden parts,
  and attaches them to the tasks through Todoist's API (`/uploads`, then a comment).

## 2026-10-26 — GitHub issues instead of Todoist

- **Todoist retired from the bot** (the owner's decision). The job, in a public
  repo, held a full-access Todoist token, which by then also read her Inbox
  for shared screenshots; nothing needed Todoist. Screenshots are now done on
  the Mac with Claude.
- **A long post → a `needs-screenshot` issue** opened with the run's own
  `GITHUB_TOKEN` (no new secret), titled with the tweet link, its body holding
  X's visible text. Locked as it opens, so only collaborators can comment (the
  owner's tweak). Existing issues are found by search on the tweet ID, plus a
  direct list of the last 2 days' closed ones (search can lag), so it scales
  past any number of issues (her tweak).
- **The handoff:** `screenshot-handoff.mjs <issue> <image>` reads the picture
  on the Mac with the same `readScreenshot` checks, taking X's text from the
  issue body (her tweak: nothing asked of X), shows the hidden part, and with
  `--send` comments the full text in a fixed format. It needs only `gh`.
- **The bot trusts only the repo owner's comments** (login and `OWNER`
  association, on an issue the bot opened), and checks the text against X's
  visible part again (≥ 95%) before posting; X's own words are kept for that part.
- Posted → comment with the link, issue closed. Closed by hand = skip.
  Screenshot posts are labeled `unchecked` until compared with the Archive;
  a mismatch opens a `post-differs` issue.
- Removed: Todoist tasks, task checks, and the share-from-the-phone Inbox route.
  Every earlier Todoist screenshot task had been posted, so nothing carried over.
- `gh workflow run live.yml -f test=<id>`: a test run for one long tweet
  that opens or reads its issue and posts nothing to Bluesky.

## Ideas and open questions

- Make the repo public (unlimited Actions minutes) — the owner's call.
- If X's embeddable timeline stops working: the Archive still works, 2–4 days
  late (`fromArchive` in `live.mjs` is the fallback already).
- Turn it off if the Vatican starts an official Bluesky account.
