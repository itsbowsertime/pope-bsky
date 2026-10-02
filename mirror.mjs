// Vatican News → Bluesky (2026-10-02). Posts each new story from Vatican News'
// "Pope" feed to an unofficial, automated Bluesky account. Runs on GitHub
// Actions every 30 minutes (.github/workflows/mirror.yml). No dependencies.
//
// No state is stored: before posting, it reads the account's own recent posts
// and skips any story whose link is already there. On the account's very first
// run it posts only the newest story, and after that only stories newer than
// the newest one it has posted, so it never floods or posts out of order.
//
//   BSKY_HANDLE=… BSKY_APP_PASSWORD=… node mirror.mjs        # post
//   node mirror.mjs --dry-run                                 # show what it would post

const FEED = "https://www.vaticannews.va/en/pope.rss.xml";
const PDS = "https://bsky.social";
const PUBLIC = "https://public.api.bsky.app";
const MAX_PER_RUN = 5;
const MAX_AGE_HOURS = 48; // never post stories older than this
const DRY = process.argv.includes("--dry-run");

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** The feed's stories, newest first. */
export function parseFeed(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, it]) => {
      const tag = (name) => (it.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] ?? "";
      const summary = decode(tag("description")).replace(/\s*Read all\s*$/, "");
      return {
        title: decode(tag("title")),
        summary,
        link: decode(tag("link")),
        published: new Date(decode(tag("pubDate"))),
        image: (it.match(/<media:content[^>]*url="([^"]+)"/) || [])[1] ?? null,
      };
    })
    .filter((s) => s.title && s.link.startsWith("https://www.vaticannews.va/"))
    .sort((a, b) => b.published - a.published);
}

/** Bluesky counts graphemes; 300 max. Cut on a word and add "…". */
export function fit(text, max = 300) {
  const g = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].map((x) => x.segment);
  if (g.length <= max) return text;
  const cut = g.slice(0, max - 1).join("");
  return cut.slice(0, cut.lastIndexOf(" ") > max * 0.6 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:.—–-]+$/, "") + "…";
}

async function json(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${url.split("?")[0]} → ${r.status} ${await r.text()}`);
  return r.json();
}

/** Links this account has already posted (its last 100 posts). */
async function alreadyPosted(actor) {
  const j = await json(`${PUBLIC}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=100&filter=posts_no_replies`);
  return { links: new Set(j.feed.map((f) => f.post.record?.embed?.external?.uri).filter(Boolean)), count: j.feed.length };
}

async function main() {
  const r = await fetch(FEED, { headers: { "User-Agent": "pope-bsky mirror (unofficial; github.com/itsbowsertime)" } });
  if (!r.ok) throw new Error(`feed → ${r.status}`);
  const stories = parseFeed(await r.text()).filter((s) => Date.now() - s.published < MAX_AGE_HOURS * 3600e3);

  if (DRY) {
    for (const s of stories.slice(0, MAX_PER_RUN)) console.log(`${s.published.toISOString()}  ${s.title}\n  ${fit(s.summary)}\n  ${s.link}\n`);
    return;
  }

  const handle = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!handle || !password) throw new Error("BSKY_HANDLE and BSKY_APP_PASSWORD must be set.");

  const posted = await alreadyPosted(handle);
  // Only what's newer than the newest story already posted (the feed is
  // newest first), so an old story never lands after newer ones. First run:
  // just the newest.
  const lastPosted = stories.findIndex((s) => posted.links.has(s.link));
  let fresh = posted.count === 0 ? stories.slice(0, 1) : stories.slice(0, lastPosted === -1 ? stories.length : lastPosted);
  fresh = fresh.filter((s) => !posted.links.has(s.link));
  fresh = fresh.slice(0, MAX_PER_RUN).reverse(); // oldest first, so the timeline reads in order
  if (!fresh.length) return console.log("Nothing new.");

  const session = await json(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  const auth = { Authorization: `Bearer ${session.accessJwt}` };

  for (const s of fresh) {
    let thumb;
    if (s.image) {
      try {
        const img = await fetch(s.image);
        if (img.ok) {
          const bytes = Buffer.from(await img.arrayBuffer());
          if (bytes.length < 950_000) {
            thumb = (await json(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, { method: "POST", headers: { ...auth, "Content-Type": img.headers.get("content-type") || "image/jpeg" }, body: bytes })).blob;
          }
        }
      } catch (e) {
        console.warn(`No picture for "${s.title}": ${e.message}`);
      }
    }
    const record = {
      $type: "app.bsky.feed.post",
      text: fit(s.summary || s.title),
      createdAt: new Date().toISOString(),
      langs: ["en"],
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: s.link, title: s.title, description: fit(s.summary, 280), ...(thumb ? { thumb } : {}) },
      },
    };
    await json(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
    });
    console.log(`Posted: ${s.title}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
