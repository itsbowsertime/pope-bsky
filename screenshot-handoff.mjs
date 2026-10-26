// The Mac side of a long post (docs/screenshots.md): a screenshot of the post
// on X → its full text, as a comment on its needs-screenshot issue, which the
// bot posts on its next run (after checking it against X itself).
//
//   node screenshot-handoff.mjs <issue> <image>                # read it; shows the hidden part, sends nothing
//   node screenshot-handoff.mjs <issue> <image> --send         # then comment it on the issue
//   node screenshot-handoff.mjs <issue> <image> --link <url>   # when the hidden part has a link
//
// Needs only gh (logged in as the repo owner) and tesseract (brew install tesseract).
// X's visible text comes from the issue body; nothing is asked of X.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readScreenshot, HANDOFF, LINK, idIn } from "./live.mjs";

const [n, image, ...args] = process.argv.slice(2);
const send = args.includes("--send");
const link = args.includes("--link") ? args[args.indexOf("--link") + 1] : null;
const stop = (msg) => (console.error(msg), process.exit(1));
if (!/^\d+$/.test(n ?? "") || !image) stop("usage: node screenshot-handoff.mjs <issue number> <image> [--link <url>] [--send]");
if (link && !/^https?:\/\/\S+$/.test(link)) stop("--link takes the whole link, starting https://");

const gh = (...a) => execFileSync("gh", a, { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" });
const issue = JSON.parse(gh("issue", "view", n, "--json", "title,body,state,labels"));
const id = idIn(issue.title);
if (!id || !issue.labels.some((l) => l.name === "needs-screenshot")) stop(`#${n} isn't a needs-screenshot issue.`);
if (issue.state !== "OPEN") stop(`#${n} is closed (posted, or skipped).`);
const shown = issue.body.match(/\n~~~text\n([\s\S]*?)\n~~~/)?.[1];
if (!shown) stop(`#${n} has no X text in its body.`);
const partial = { id, text: shown, urls: [] };

let ocr;
try {
  ocr = execFileSync("tesseract", [image, "-", "--psm", "4"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch {
  stop(`tesseract couldn't read ${image} — is it a picture (PNG/JPG)? (brew install tesseract if it's missing)`);
}
let read = readScreenshot(ocr, partial);
if (read.problem === "link") {
  if (!link) stop("The hidden part has a link, which can't be read off a picture. On X, right-click the link → Copy Link Address, then run this again with --link <url>.");
  read = readScreenshot(ocr.replace(LINK, "LINKHERE"), partial);
  if (read.text) read.text = read.text.replace("LINKHERE", link);
}
if (read.problem) stop(`Not usable: ${read.problem}. Take another screenshot — the whole post, from his name down to the time line.`);

const hidden = read.text.slice(shown.trimEnd().length).trim();
console.log(`Tweet: https://x.com/Pontifex/status/${id}`);
console.log(hidden ? `Hidden part, from the picture:\n  ${hidden}` : "The picture shows nothing beyond X's text: X's text is the whole post.");
console.log(`\nFull text:\n${read.text}\n`);

if (!send) {
  console.log("Nothing sent. If that's right, run again with --send.");
  process.exit(0);
}
const body = `${HANDOFF}
Full text of https://x.com/Pontifex/status/${id}, read from a screenshot and checked on the Mac. The bot checks it against X again and posts it on its next run (within 30 minutes).

~~~text
${read.text}
~~~`;
execFileSync("gh", ["issue", "comment", n, "--body-file", "-"], { cwd: dirname(fileURLToPath(import.meta.url)), input: body, stdio: ["pipe", "inherit", "inherit"] });
console.log(`Sent to #${n}.`);
