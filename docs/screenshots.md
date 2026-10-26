# Filling a long post from a screenshot

X's free services show only the first ~280 characters of a long post. When
the bot meets one, it opens a GitHub issue here, labeled **`needs-screenshot`**,
locked (only collaborators can comment), titled with the tweet's link, its body
holding what X shows. This is the walk-through for Claude on the owner's Mac.

**Find them:** `gh issue list --repo itsbowsertime/pope-bsky --label needs-screenshot --state open`

## The walk-through

For each open issue, oldest first:

1. **Open the post** in the owner's default browser: `open <the tweet link in the title>`.
   Don't fetch it with an automated browser (x.com answers those with 403).
2. **She screenshots it:** ⌘⇧4, then drag from his name down to and including
   the time line ("7:40 PM · Sep 28, 2026"). It saves to the Desktop (or
   wherever her screenshots go). Ask for the file if it isn't the newest.
3. **Read it:** `node screenshot-handoff.mjs <issue> <image>`, in this repo.
   It reads the picture with tesseract and checks it the way the bot does:
   - the start must match X's visible text (from the issue body) at ≥ 95%;
   - a picture down to the time line counts with any hidden part; without
     it, the picture must show at least 10 characters more than X does;
   - nothing beyond X's text, down to the time line → X's text is the whole post.

   It prints the **hidden part** and the full text, and sends nothing.
4. **Show her the hidden part.** If it reads wrong, take another screenshot.
   - "The hidden part has a link": a link can't be read off a picture. She
     copies it on X (right-click → Copy Link Address); run again with `--link <url>`.
5. **Send it** once she's OK'd it: the same command plus `--send`. It comments
   the full text on the issue in a fixed format (below) as the repo owner.
6. The bot's next run (within 30 minutes) checks the text against X again,
   posts it, comments the post's link and closes the issue. If it refuses,
   it says why in a comment; nothing posts.

**To skip a post:** close its issue. Closed = never asked about again.

## What the bot trusts

The repo is public, so a handoff counts only if all of these hold:

- the comment is by the repo owner's account (`author_association` OWNER),
  on an issue the bot opened (`github-actions[bot]`);
- it starts with `<!-- pope-bot full-text v1 -->`, names the same tweet link
  as the issue, and holds the text in a `~~~text` block;
- its start matches what X shows *now* at ≥ 95% — X's exact words are posted
  for that part; only the rest comes from the comment;
- any link in the hidden part is whole (`https://…`).

The latest such comment wins. Anyone else's comments are ignored.

## Afterwards

- A post made from a screenshot gets the **`unchecked`** label. When the
  Internet Archive releases the tweet (2–4 days), the bot compares, comments
  "matches ✓" or "DIFFERS", and removes the label. A mismatch opens a
  **`post-differs`** issue: compare, then delete and re-post if ours is wrong.
- If the Archive's copy comes before a screenshot, the bot uses it and closes
  the issue itself.
