# pope-bsky — notes for Claude

An unofficial Bluesky bot, **@popeleo-bot.bsky.social**, re-posting Pope
Leo XIV's @Pontifex tweets. README.md explains how it works; `docs/history.md`
holds every decision and why. Read both before changing anything.

## The owner's rules (each one hers, don't loosen without asking)

- **"I would rather miss some real ones than repost a fake one."** Accuracy
  beats coverage. Nothing posts that wasn't checked against X's own text.
- **Post format is settled** (2026-10-02): `[Posted MM/DD/YY] <text>`, "Posted"
  linked to the tweet, Rome date, threads over 300 characters, real hashtags
  and links, photos attached, videos as `[Original post has a video.]` (her
  exact wording — not a link). Show her a sample before changing it.
- **Native text posts, not screenshots.** Tried and dropped (X's embed cut long
  posts off with "Show more").
- **Long posts she can't get free → a `needs-screenshot` GitHub issue** with
  the tweet link as its title (2026-10-26, replacing Todoist). She screenshots
  it on the Mac with Claude; `node screenshot-handoff.mjs <issue> <image>`
  hands the text over (`docs/screenshots.md`). Don't invent other ways to
  fill text, and the bot trusts only the repo owner's handoff comments.
- **Deleted by him → delete ours.** (2026-09-30: he deleted a thread with a
  typo and re-posted it; the deleted copy was removed.)
- **Don't pay X, and don't log in to X.** Free public sources only.
- Ask before anything that deletes posts in bulk, changes the profile, or
  makes the repo public.

## State of things (update this when it changes)

**Next:** Nothing pending. The first long post went through the `needs-screenshot` flow (#2, 2026-10-27); when the Archive releases it, the bot compares and drops `unchecked`.
**Waiting on Anna:** nothing.
**Updated:** 2026-10-27

- **Live job running since 2026-10-03**, every 30 min (`live.yml`), **started by a Cloudflare Worker** (`cloudflare/`, the owner's Cloudflare account) because GitHub's schedule dropped most runs. Its `GH_TOKEN` is the fine-grained token `pope-bsky-clock` (this repo only, Actions r/w, no expiry); when runs stop, check that first.
- **Public since 2026-10-11**, so Actions minutes are free. The history was
  rewritten before publishing to drop the owner's name and local paths; the
  pre-rewrite repo is the private `pope-bsky-old` (workflow disabled), and the
  token was moved from it to this repo. Nothing identifying goes into a commit
  message or file here.
- **Account:** 928 backfilled tweets (2025-05-14 → 2026-09-30) + live posts
  from 2026-10-01. Integrity check last run: 0 duplicates, 0 missing, all
  threads complete.
- **App password rotated** 2026-10-26 (the old one had been pasted in chat).
  Secrets are set in Terminal (`gh secret set NAME`), not with `!` here: `!`
  can't take typed input and sets an empty value.

## Gotchas (each learned the hard way)

- **GitHub doesn't notify the owner about the bot's issues** (checked
  2026-10-26: the owner doesn't watch this repo, so a `needs-screenshot` issue
  opened by `github-actions[bot]` sent nothing). The assistant's greeting check
  (`gh issue list --label needs-screenshot`) is the only alert.

- **Cloudflare fires the cron twice, ~6s apart** (watched with `wrangler tail`,
  2026-10-13; one Worker, one schedule). So every tick dispatches two runs;
  `live.yml`'s first step stops the later one before it asks X anything. Two
  runs per tick in the Actions list is expected, the second all-skipped.

- **x.com answers an automated browser with 403** (headless Chrome, fresh
  profile, 2026-10-26), so the bot can't fetch long posts itself. Getting
  past it means disguising the browser — don't.

- **The account's posts live on its own PDS**, not bsky.social: take the
  service endpoint from `createSession`'s `didDoc` for `listRecords`.
- **Searching Bluesky needs a login** (`atproto-proxy` header), not the public API.
- **Backdating works for posts** (`createdAt`), not for reposts. A backdated
  post sinks in followers' feeds — live posts use the tweet's time only if
  it's within 2 hours, else now.
- **Bluesky returns passing 502s**; `create()` retries so threads are never
  left half-posted. After any big run, check every thread is complete.
- **X's timeline rate limit is shared by the whole world** (30 / 30 min). Don't
  poll it from the Mac while testing — it burns the job's window.
- **The Wayback Machine refuses connections when hit fast**: pace ~1/sec and back off.
- **Archive captures under `twitter.com/Pontifex/status/*` include other
  people's retweets and replies** — keep only `author_id` 1922567634907791360.
- **`note_tweet` exists but is empty on short posts** — use it only when it
  has `.text`.
- **HTML entities** (`&amp;`, `&#34;`) appear in X and RSS text — decode them.

## Commands

```
gh workflow run live.yml                 # run now
gh run list --workflow live.yml          # recent runs
gh run view <id> --log | grep -v '##'    # a run's output
node tweets-full.mjs post                # post any backfill tweet not yet on the account
gh issue list --label needs-screenshot    # long posts waiting for a screenshot
node screenshot-handoff.mjs <issue> <image> [--link <url>] [--send]   # docs/screenshots.md
```

Local runs need `BSKY_HANDLE`, `BSKY_APP_PASSWORD`, and for `live.mjs`
`GITHUB_TOKEN` (`gh auth token`), `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`.
Test without posting: `gh workflow run live.yml -f test=<a long tweet's ID>`
(opens or reads that tweet's issue; nothing goes to Bluesky).
