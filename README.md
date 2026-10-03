# pope-bsky

An unofficial, automated Bluesky account — **[@popeleo-bot.bsky.social](https://bsky.app/profile/popeleo-bot.bsky.social)**,
"Pope Leo XIV on X (unofficial)" — that re-posts Pope Leo XIV's posts from
@Pontifex on X as native Bluesky posts. Not affiliated with the Holy See.

Built because the Pope's X posts can't be read on Bluesky, and X's API is paid.
Everything here uses only free, public sources.

## What a post looks like

```
[Posted 09/27/26] Deepening and strengthening the life of faith within families is …
```

- **"Posted"** links to the original tweet on X; the date is Rome time.
- Hashtags are real Bluesky hashtags; links show short and open the real page.
- Photos (up to 4) are attached with the Vatican's own alt text, or
  "Photo from Pope Leo XIV's post on X".
- Videos: the preview frame, plus the plain note `[Original post has a video.]`.
- No media but a link → a link card.
- Over 300 characters → a thread: the date tag on the first post, the
  media/card on the last.
- Retweets and replies to other people are left out.

## How it works

| Script | Job | Status |
|---|---|---|
| `live.mjs` | New tweets, every 30 minutes (GitHub Actions, `.github/workflows/live.yml`, started by the Cloudflare Worker in `cloudflare/`) | **running** |
| `tweets-full.mjs` | The backfill: every tweet from 2025-05-14 to 2026-09-30, and the shared posting code (`shape`, `split`, `postTweet`) | done |
| `manual-15.json` | The 15 long posts no free source had in full, transcribed from screenshots of X | done |
| `mirror.mjs`, `screenshots.mjs`, `backfill.mjs`, `tweets-backfill.mjs`, `screenshots-backfill.mjs` | Earlier approaches (Vatican News stories; screenshot reposts; screenshot-style backfill) | retired, kept for reference |

### Live posting (`live.mjs`)

1. **Find new tweets.** X's *embeddable timeline* — the widget websites use to
   show someone's feed — lists his 20 newest tweets with no delay. Its limit is
   30 requests per 30 minutes **shared by everyone**, and it's used up within
   minutes of each reset, so when it's busy the job waits for the reset time X
   gives (if it's ≤ 12 minutes away) and asks in the first second.
2. **Short tweets** (most of them) post at once, at the tweet's own time.
3. **Long tweets** — X's free services show only the first ~280 characters. The
   job adds a Todoist task for today whose title links to the tweet. A
   screenshot attached to the task is read with tesseract (OCR) on the next
   run. X's exact text is kept for the part X shows; only the rest comes from
   the picture, and the picture must match X's visible text at ≥ 95% or
   nothing posts (the task gets a comment saying why).
   - A link in the hidden part can't be read off a picture: the bot asks, in
     a task comment, for the link to be pasted as a comment.
   - The Internet Archive saves every tweet within seconds but releases them
     2–4 days later. If its copy arrives before a screenshot, that's used
     instead; posts made from a screenshot are compared with it later, and a
     mismatch becomes a new task.
   - Completing the task by hand = skip that tweet.
4. **No saved state.** Each run reads the account's posts (the "Posted" link
   holds the tweet ID) and the Todoist tasks, so a run can never double-post.

### The backfill (`tweets-full.mjs`)

The Internet Archive captured each @Pontifex tweet as X's own JSON at
`twitter.com/Pontifex/status/<id>` — full long-post text included.
`node tweets-full.mjs fetch` builds `tweets-full.json` from those captures
(X's embed service fills gaps for short posts); `node tweets-full.mjs post`
posts the oldest not yet on the account. Result: 928 tweets, every one checked
for duplicates and complete threads.

## Running it

- Secrets (repo Settings → Secrets → Actions): `BSKY_HANDLE`,
  `BSKY_APP_PASSWORD` (a Bluesky *app password*), `TODOIST_API_TOKEN`.
- Run once by hand: `gh workflow run live.yml`; logs: `gh run list --workflow live.yml`.
- **The clock:** GitHub's own schedule drops most runs, so a Cloudflare Worker
  (`cloudflare/`, cron `2,32 * * * *`) starts the workflow. Its `GH_TOKEN` is a
  fine-grained token for this repo only, Actions read & write. Deploy:
  `cd cloudflare && npx wrangler deploy`.
- Stop: `gh workflow disable live.yml` (the Worker's calls then just fail). Turn it off for good if the Vatican
  starts its own Bluesky account.
- No dependencies — Node 22 only (and tesseract, installed on a run that needs it).
