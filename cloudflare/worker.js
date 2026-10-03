// A reliable 30-minute clock for the live job (2026-10-03). GitHub's own
// schedule drops most runs when it's busy (2 of ~20 on the first day), so
// this Cloudflare Worker's cron trigger asks GitHub to run live.yml instead.
// GH_TOKEN: a fine-grained token for this one repo, Actions read & write only.
export default {
  async scheduled(event, env, ctx) {
    const r = await fetch("https://api.github.com/repos/itsbowsertime/pope-bsky/actions/workflows/live.yml/dispatches", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "pope-bsky-clock", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "master" }),
    });
    if (!r.ok) throw new Error(`GitHub → ${r.status} ${await r.text()}`); // shows in the Worker's logs
  },
};
