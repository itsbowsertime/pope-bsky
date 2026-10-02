# pope-bsky

An unofficial, automated Bluesky account that posts every story from
[Vatican News' "Pope" feed](https://www.vaticannews.va/en/pope.rss.xml) — the
Vatican's own news service — as it's published. Built 2026-10-02 for the owner
because the Pope's @Pontifex posts on X can no longer be read for free.

- `mirror.mjs` — the whole thing, no dependencies. `node mirror.mjs --dry-run`
  shows what it would post.
- `screenshots.mjs` — finds Bluesky posts that are screenshots of @Pontifex
  posts and REPOSTS one clean copy per tweet: the image's alt text must carry
  the tweet, the poster must add no commentary, and the tweet must match a
  Vatican News story about the Pope at ≥ 75% of its content words (real
  matches score ~0.8+, unrelated stories ≤ ~0.4), and at least two accounts
  must have posted it. The owner's rule: better to miss a real one than repost a
  fake. Unconfirmed tweets are skipped. `--dry-run` shows the candidates and the pick.
- `backfill.mjs` — the one-time backfill of every story since 2025-05-08.
- `.github/workflows/mirror.yml` — runs both every 30 minutes on GitHub Actions.
- Secrets (repo Settings → Secrets → Actions): `BSKY_HANDLE`,
  `BSKY_APP_PASSWORD` (a Bluesky *app password*, never the real one).

No state is kept: each run reads the account's last 100 posts and skips any
story already linked, and posts only stories newer than the newest one it has
posted. The first run posts only the newest story. At most 5
posts a run, oldest first; stories older than 48 hours are never posted.

Not affiliated with the Holy See or Vatican News. If the Vatican starts its own
Bluesky account, turn this off (Actions → mirror → Disable workflow).
