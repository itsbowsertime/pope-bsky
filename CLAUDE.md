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
- **Long posts she can't get free → a Todoist task with the tweet link as its
  title**; she attaches a screenshot. Don't invent other ways to fill text.
- **Deleted by him → delete ours.** (2026-09-30: he deleted a thread with a
  typo and re-posted it; the deleted copy was removed.)
- **Don't pay X, and don't log in to X.** Free public sources only.
- Ask before anything that deletes posts in bulk, changes the profile, or
  makes the repo public.

## State of things (update this when it changes)

- **Live job running since 2026-10-03**, every 30 min (`live.yml`), **started by a Cloudflare Worker** (`cloudflare/`, the owner's Cloudflare account) because GitHub's schedule dropped most runs. Its `GH_TOKEN` (fine-grained, this repo, Actions r/w) expires — the owner chose the longest option on 2026-10-03; when runs stop, check that first. The repo is
  **private as a 2-day test**; after it, report Actions minutes used (October
  started at 51) and any missed tweets, and ask about making it public
  (unlimited minutes). Private = 2,000 min/month; the wait-for-reset costs
  ~300–600/day.
- **Account:** 928 backfilled tweets (2025-05-14 → 2026-09-30) + live posts
  from 2026-10-01. Integrity check last run: 0 duplicates, 0 missing, all
  threads complete.
- **⚠️ The app password was pasted in chat** (2026-10-02). Remind the owner to
  rotate it at bsky.app → Settings → App passwords, then update the
  `BSKY_APP_PASSWORD` secret (she runs `gh secret set` — Claude can't write
  secrets).
- **Making the repo public:** history checked 2026-10-03 — no secrets ever
  committed. Data files with tweet text are gitignored except `manual-15.json`.

## Gotchas (each learned the hard way)

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
```

Local runs need `BSKY_HANDLE`, `BSKY_APP_PASSWORD`, and for `live.mjs`
`TODOIST_API_TOKEN` (another project's `.env.local` has it).
