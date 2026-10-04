#!/usr/bin/env node
// justify: list every line of words a project shows people, attach the saved
// verdict for each one, and build the read-only review page.
// Run from anywhere inside a git repo. Data lives in <repo>/.justify/.
//
//   node justify.mjs init                write .justify/config.json from what it finds
//   node justify.mjs build               scan, merge verdicts, write .justify/out/
//   node justify.mjs todo [options]      lines that still need a verdict (JSON)
//       --changed[=<base>]  only files changed since <base> (default origin/main)
//       --file <text>       only files whose path contains <text>
//       --platform <name>   web | app | server | admin | shared
//       --limit <n>         at most n lines
//   node justify.mjs record <batch.json> [--check]  save verdicts: [{key, verdict, reason, rewrite?}]
//       --check validates without saving
//       verdict is keep, cut, rewrite (needs the new words) or skip (people never see it)
//   node justify.mjs conflicts           same words with different verdicts in different files
//   node justify.mjs prune               drop verdicts for lines no longer in the code

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    console.error("Run this inside a git repo.");
    process.exit(2);
  }
})();
const DATA_DIR = process.env.JUSTIFY_DIR ? path.resolve(process.env.JUSTIFY_DIR) : path.join(REPO, ".justify");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const VERDICTS_FILE = path.join(DATA_DIR, "verdicts.jsonl");
const TELLS_FILE = fs.existsSync(path.join(DATA_DIR, "tells.json"))
  ? path.join(DATA_DIR, "tells.json")
  : path.join(SKILL_DIR, "lists", "tells.json");
const TEMPLATE_FILE = path.join(SKILL_DIR, "page", "template.html");
const OUT_DIR = path.join(DATA_DIR, "out");

// Per-project settings in .justify/config.json. Everything is optional:
//   product   the name people see (page title); default is the repo folder name
//   exclude   extra path regexes to skip
//   include   path regexes to scan even if a default rule would skip them
//   platforms { "<path regex>": "web" | "app" | "server" | "admin" | "shared" }, checked in order
//   pageUrl   the Copy Check page for this project, once published
const CONFIG = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
const PRODUCT = CONFIG.product || path.basename(REPO);
const toRegexes = (list) => (list || []).map((r) => new RegExp(r));
const INCLUDE = toRegexes(CONFIG.include);

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;

// Never words people see: tests, build output, tooling, generated files.
const SKIP_PATH = [
  /(^|\/)node_modules\//,
  /(^|\/)(dist|build|out|output|\.next|\.expo|\.turbo|coverage|storybook-static|ios\/Pods|android\/app\/build)\//,
  /(^|\/)(__tests__|__mocks__|mocks?|test-utils|tests?|e2e|cypress|playwright|fixtures?|seeds?|migrations|benchmarks?|docs?)\//,
  /(^|\/)(scripts|tools|tooling|\.github|\.claude|\.husky|\.justify)\//,
  /(^|\/)(prototypes?|examples?|sandbox|playground|demo-?scripts|deploy|infra|terraform|artifacts|\.agents|\.codex|\.cursor|\.venv|venv|site-packages|__pycache__)\//,
  /(^|\/)(test_[^/]*|[^/]*_test|conftest|setup|manage)\.py$/,
  /^reports?\/|(^|\/)(\.lighthouseci|lhci[^/]*|playwright-report|test-results)\/|\.report\.html$/,
  /(^|[-_.\/])(backup|bak|deprecated|unused)([-_.\/]|$)/i,
  /\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /\.min\.js$/,
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
  /(^|\/)(vite|webpack|babel|metro|jest|vitest|tailwind|postcss|eslint|prettier|drizzle|next)\.[^/]*$/,
  /fixture/i,
  ...toRegexes(CONFIG.exclude),
];

// Which kind of surface a file belongs to, from its path.
const PLATFORM_RULES = [
  ...Object.entries(CONFIG.platforms || {}).map(([re, platform]) => ({ re: new RegExp(re), platform })),
  { re: /(^|\/)admin(\/|[-_.]|$)/i, platform: "admin" },
  { re: /(^|\/)(server|api|backend|functions|lambdas?|worker|workers)(\/|$)/, platform: "server" },
  { re: /(^|\/)(shared|common)(\/|$)/, platform: "shared" },
  { re: /(^|\/)(ios|android)\//, platform: "app" },
];

// Folders whose package.json pulls in React Native or Expo hold a phone app,
// even at the repo root.
let appRootsCache;
function appRoots() {
  appRootsCache ??= trackedFiles()
    .filter((f) => /(^|\/)package\.json$/.test(f) && !/node_modules/.test(f))
    .filter((f) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, f), "utf8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return Boolean(deps["react-native"] || deps.expo);
      } catch {
        return false;
      }
    })
    .map((f) => (path.dirname(f) === "." ? "" : path.dirname(f) + "/"));
  return appRootsCache;
}

function platformFor(rel) {
  const rule = PLATFORM_RULES.find((r) => r.re.test(rel));
  if (rule) return rule.platform;
  if (rel.endsWith(".py")) return "server";
  return appRoots().some((root) => rel.startsWith(root)) ? "app" : "web";
}

// Words that mark a prop, attribute, variable or function as holding copy.
const COPY_WORDS = new Set(
  (
    "title subtitle heading headline subhead subheading label text description message body placeholder " +
    "hint caption tooltip alt cta eyebrow kicker tagline summary note helper copy blurb lede intro " +
    "explanation explainer confirm cancel button empty error warning notice success toast banner tip tips " +
    "step steps faq faqs question answer reason legend subject preheader prompt footnote bio badge sublabel subline overline suffix prefix"
  ).split(" "),
);
// Words that mark the same names as styling, ids or data instead.
const NOT_COPY_WORDS = new Set(
  (
    "style styles class classname color colors id ids key keys url uri href src path route icon size variant " +
    "type types code codes count ref props testid role mode align weight font height width lines number " +
    "length visible open shown enabled disabled loading ms timeout limit max min field fields name"
  ).split(" "),
);
const NO_COPY_CALLEES = new Set(
  (
    "console log logger debug trace info warn captureException captureMessage addBreadcrumb track capture identify " +
    "cn clsx cva twMerge classNames classnames require import fetch apiRequest apiFetch " +
    "queryKey invalidateQueries setQueryData getQueryData querySelector " +
    "getElementById addEventListener removeEventListener postMessage setItem getItem removeItem localStorage " +
    "sessionStorage sql raw execute matchMedia Error TypeError RangeError SyntaxError " +
    "startsWith endsWith includes indexOf split replace replaceAll match test exec padStart padEnd " +
    "toLocaleString toLocaleDateString toLocaleTimeString Intl NumberFormat DateTimeFormat"
  ).split(" "),
);
const FORM_RULE_METHODS = new Set(
  "min max length email url regex nonempty refine superRefine positive nonnegative int gte lte gt lt uuid datetime".split(" "),
);
const SETTER_CALLEE = /^(set\w*(Error|Message|Text|Title|Label|Notice|Hint|Status|Feedback|Copy)|alert|confirm|prompt|toast|showToast|showError|showMessage|showAlert|announce\w*|fail)$/;
const SEND_CALLEE = /^(send\w*(Notification|Email|Mail|Sms|Text|Push)\w*|notify\w*|enqueue\w*(Notification|Email|Alert)\w*)$/;
const MESSAGE_FILE = /(mail|email|notif|notifier|push|sms|outbox|reminder|digest)/i;
const INLINE_TAGS = new Set(
  "b strong em i u s small sup sub mark code span a br abbr q Text Link Trans".split(" "),
);

const KIND = {
  screen: "On screen",
  placeholder: "Text box hint",
  reader: "Screen reader",
  hover: "Hover tip",
  popup: "Pop-up note",
  alert: "Alert box",
  error: "Error",
  form: "Form error",
  server: "Server message",
  email: "Email or phone alert",
  permission: "Permission pop-up",
  share: "Tab title or link preview",
};

let ts;
let tells;


function main() {
  const [command = "build", ...args] = process.argv.slice(2);
  tells = JSON.parse(fs.readFileSync(TELLS_FILE, "utf8")).map((t) => ({
    why: t.why,
    re: new RegExp(t.pattern, "iu"),
  }));
  if (command === "build") return build();
  if (command === "todo") return todo(args);
  if (command === "record") return record(args.find((a) => !a.startsWith("--")), args.includes("--check"));
  if (command === "prune") return prune();
  if (command === "conflicts") return conflicts();
  if (command === "init") return init();
  console.error(`Unknown command "${command}". Use init, build, todo, record, conflicts or prune.`);
  process.exit(2);
}

// ---------- commands ----------

function build() {
  const lines = scan();
  const verdicts = readVerdicts();
  const byKey = new Map(verdicts.map((v) => [v.key, v]));
  const liveKeys = new Set(lines.map((l) => l.key));
  // A rewrite that was applied in code shows up as a new line with the new
  // words. Carry the approval over instead of asking for it twice.
  const appliedRewrites = new Map();
  for (const v of verdicts) {
    if (v.verdict === "rewrite" && v.rewrite && !liveKeys.has(v.key)) {
      appliedRewrites.set(`${v.file}\n${shape(v.rewrite)}`, v);
    }
  }
  const carried = [];
  for (const line of lines) {
    let v = byKey.get(line.key);
    if (!v) {
      const applied = appliedRewrites.get(`${line.file}\n${shape(line.text)}`);
      if (applied) {
        v = {
          key: line.key,
          file: line.file,
          text: line.text,
          verdict: "keep",
          reason: `Applied rewrite of "${applied.text}". ${applied.reason}`,
          date: today(),
        };
        carried.push(v);
      }
    }
    if (v) {
      line.verdict = v.verdict;
      line.reason = v.reason;
      if (v.rewrite) line.rewrite = v.rewrite;
    }
  }
  upsertVerdicts(carried);
  const safeGit = (args, fallback) => {
    try {
      return git(args);
    } catch {
      return fallback;
    }
  };
  const commit = safeGit(["rev-parse", "--short", "HEAD"], "no commits yet");
  const scanned = new Set(lines.map((l) => l.file));
  const dirty = git(["status", "--porcelain"])
    .split("\n")
    .some((row) => scanned.has(row.slice(3).trim()));
  const meta = {
    commit,
    dirty,
    branch: safeGit(["rev-parse", "--abbrev-ref", "HEAD"], ""),
    builtAt: new Date().toISOString(),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "inventory.json"), JSON.stringify({ meta, lines }, null, 1));
  const template = fs.readFileSync(TEMPLATE_FILE, "utf8");
  const data = JSON.stringify({ meta, groups: pageGroups(lines) }).replace(/</g, "\\u003c");
  const html = template
    .replace("/*__JUSTIFY_DATA__*/null", () => data)
    .replaceAll("__PRODUCT__", PRODUCT.replace(/[<>&"]/g, ""));
  const pagePath = path.join(OUT_DIR, "copy-check.html");
  fs.writeFileSync(pagePath, html);
  const orphans = verdicts.filter((v) => !liveKeys.has(v.key)).length;
  const s = summarize(lines);
  console.log(
    [
      `Built from ${commit}${dirty ? " plus uncommitted changes" : ""}.`,
      `${s.total} lines: ${s.keep} keep, ${s.cut} cut, ${s.rewrite} rewrite, ${s.skip} not shown, ${s.open} not checked (${s.flaggedOpen} of those flagged).`,
      carried.length ? `${carried.length} applied rewrites carried over as keep.` : "",
      orphans ? `${orphans} saved verdicts no longer match the code (run prune to drop them).` : "",
      `Page: ${pagePath}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// Compact shape for the page: one group per file, short field names.
function pageGroups(lines) {
  const groups = new Map();
  for (const l of lines) {
    if (!groups.has(l.file)) {
      groups.set(l.file, { platform: l.platform, area: l.area, where: l.where, file: l.file, items: [] });
    }
    groups.get(l.file).items.push({
      t: l.text,
      k: l.kind,
      l: l.lines,
      ...(l.flags.length ? { g: l.flags } : {}),
      ...(l.verdict ? { v: l.verdict, r: l.reason } : {}),
      ...(l.rewrite ? { n: l.rewrite } : {}),
    });
  }
  return [...groups.values()];
}

function todo(args) {
  const opts = parseArgs(args);
  let lines = scan();
  const judged = new Set(readVerdicts().map((v) => v.key));
  lines = lines.filter((l) => !judged.has(l.key));
  if (opts.changed !== undefined) {
    const base = opts.changed === true ? defaultBase() : opts.changed;
    try {
      git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    } catch {
      console.error(`Can't find "${base}" to compare against. Run git fetch, or pass --changed=<branch or commit>.`);
      process.exit(2);
    }
    const changed = new Set(
      [
        ...git(["diff", "--name-only", `${base}...HEAD`]).split("\n"),
        ...git(["diff", "--name-only", "HEAD"]).split("\n"),
        ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
      ].filter(Boolean),
    );
    lines = lines.filter((l) => changed.has(l.file));
  }
  if (opts.file) lines = lines.filter((l) => l.file.includes(opts.file));
  if (opts.platform) lines = lines.filter((l) => l.platform === opts.platform);
  const total = lines.length;
  if (opts.limit) lines = lines.slice(0, Number(opts.limit));
  console.log(
    JSON.stringify(
      {
        remaining: total,
        lines: lines.map(({ key, file, lines: at, kind, text, flags }) => ({
          key,
          file,
          at,
          kind,
          text,
          ...(flags.length ? { flags } : {}),
        })),
      },
      null,
      1,
    ),
  );
}

const VAGUE_KEEP_REASON =
  /\b(user experience|ux\b|enhanc\w*|clarity|clear and concise|provides? context|builds? trust|reassur\w*|engag\w*|user[- ]friendly|intuitive|seamless\w*|sets? expectations|important|necessary|best practice|common pattern|conveys?|communicat\w*|helps? (the )?users?|guides? (the )?users?|improves?|friendly|welcoming|warm(th)?|delight\w*|polish\w*|clearer|nice to have|nicer|smoother|better flow)\b/i;

function record(file, checkOnly = false) {
  if (!file) {
    console.error("Give a batch file: node justify.mjs record <batch.json>");
    process.exit(2);
  }
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  const current = new Map(scan().map((l) => [l.key, l]));
  const saved = [];
  const rejected = [];
  for (const raw of Array.isArray(batch) ? batch : [batch]) {
    const item = raw && typeof raw === "object" ? raw : {};
    const line = current.get(item.key);
    const reason = String(item.reason ?? "").trim();
    const rewrite = item.verdict === "rewrite" && item.rewrite ? String(item.rewrite).trim() : undefined;
    const ownWords = reason.replace(/"[^"]*"|“[^”]*”/g, ""); // quoted app words don't count
    let problem = null;
    if (!line) problem = "no such line in the current code";
    else if (!["keep", "cut", "rewrite", "skip"].includes(item.verdict)) problem = "verdict must be keep, cut, rewrite or skip";
    else if (reason.length < 12) problem = "reason is missing or too short";
    else if (item.verdict === "rewrite" && !rewrite) problem = "rewrite needs the new words";
    else if (item.verdict === "rewrite" && normalize(rewrite) === normalize(line.text)) problem = "rewrite is the same as the current words";
    else if (item.verdict === "keep" && VAGUE_KEEP_REASON.test(ownWords))
      problem = `keep reason is vague ("${ownWords.match(VAGUE_KEEP_REASON)[0]}"); say what the person would get wrong or not know without it`;
    if (problem) {
      rejected.push({ key: item.key, text: line?.text, problem });
      continue;
    }
    saved.push({
      key: line.key,
      file: line.file,
      text: line.text,
      verdict: item.verdict,
      reason,
      ...(rewrite ? { rewrite } : {}),
      date: today(),
    });
  }
  if (!checkOnly) upsertVerdicts(saved);
  console.log(JSON.stringify({ [checkOnly ? "wouldSave" : "saved"]: saved.length, rejected }, null, 1));
  if (rejected.length) process.exitCode = 1;
}

function prune() {
  const live = new Set(scan().map((l) => l.key));
  const verdicts = readVerdicts();
  const kept = verdicts.filter((v) => live.has(v.key));
  writeVerdicts(kept);
  console.log(`Dropped ${verdicts.length - kept.length} verdicts for lines no longer in the code.`);
}

// Writes .justify/ with a starter config and prints what the scanner found,
// so the session can correct folders before the first sweep.
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, ".gitignore"), "out/\n");
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ product: PRODUCT, exclude: [], include: [], platforms: {} }, null, 2) + "\n");
  }
  if (!fs.existsSync(VERDICTS_FILE)) fs.writeFileSync(VERDICTS_FILE, "");
  const lines = scan();
  const byArea = new Map();
  for (const l of lines) byArea.set(l.area, (byArea.get(l.area) || 0) + 1);
  console.log(`${PRODUCT}: ${lines.length} lines in ${new Set(lines.map((l) => l.file)).size} files.`);
  for (const [area, n] of [...byArea].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${area}`);
  console.log(`Config: ${CONFIG_FILE}. Fix wrong folders with exclude, include or platforms, then run build.`);
}

// Same words that end up different in different files. Compares the final
// wording people would see (kept words, the rewrite, or nothing for a cut),
// ignoring capitals and lines nobody sees. Often a web and phone app pair that
// should match; sometimes the context really differs.
function conflicts() {
  const byText = new Map();
  for (const v of readVerdicts()) {
    const k = normalize(v.text).toLowerCase();
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(v);
  }
  const outcome = (v) => (v.verdict === "cut" ? "(cut)" : normalize(v.verdict === "rewrite" ? v.rewrite : v.text).toLowerCase());
  const out = [];
  for (const list of byText.values()) {
    const shown = list.filter((v) => v.verdict !== "skip");
    if (new Set(shown.map(outcome)).size > 1) {
      out.push({
        text: list[0].text,
        verdicts: list.map(({ key, file, verdict, rewrite }) => ({ key, file, verdict, ...(rewrite ? { rewrite } : {}) })),
      });
    }
  }
  console.log(JSON.stringify(out, null, 1));
}

// ---------- verdict storage ----------

function readVerdicts() {
  if (!fs.existsSync(VERDICTS_FILE)) return [];
  return fs
    .readFileSync(VERDICTS_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function upsertVerdicts(items) {
  if (!items.length) return;
  const map = new Map(readVerdicts().map((v) => [v.key, v]));
  for (const v of items) map.set(v.key, v);
  writeVerdicts([...map.values()]);
}

// One verdict per line, sorted by file then key, so two sessions adding
// verdicts for different screens merge without conflicts.
function writeVerdicts(list) {
  list.sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VERDICTS_FILE, list.map((v) => JSON.stringify(v)).join("\n") + (list.length ? "\n" : ""));
}

// ---------- scanning ----------

function scan() {
  const found = new Map();
  for (const rel of listFiles()) {
    {
      const platform = platformFor(rel);
      for (const hit of scanFile(rel, platform)) {
        const text = hit.text;
        const key = crypto.createHash("sha1").update(`${rel}\n${text}`).digest("hex").slice(0, 12);
        const existing = found.get(key);
        if (existing) {
          if (!existing.lines.includes(hit.line)) existing.lines.push(hit.line);
          continue;
        }
        found.set(key, {
          key,
          platform,
          area: areaFor(rel, platform),
          where: whereFor(rel),
          file: rel,
          lines: [hit.line],
          kind: hit.kind,
          text,
          flags: flagsFor(text),
        });
      }
    }
  }
  const addHit = (hit, platform, area, where) => {
    const key = crypto.createHash("sha1").update(`${hit.file}\n${hit.text}`).digest("hex").slice(0, 12);
    if (found.has(key)) found.get(key).lines.push(hit.line);
    else found.set(key, { key, platform, area, where, file: hit.file, lines: [hit.line], kind: hit.kind, text: hit.text, flags: flagsFor(hit.text) });
  };
  const pythonFiles = [];
  for (const rel of trackedFiles()) {
    if (!isScannable(rel)) continue;
    if (rel.endsWith(".py")) {
      pythonFiles.push(rel);
    } else if (TEMPLATE_FILE_RE.test(rel)) {
      const platform = platformFor(rel);
      for (const hit of scanHtml(rel)) addHit(hit, platform, areaFor(rel, platform), whereFor(rel));
    } else if (/\.swift$/.test(rel) && !/Package\.swift$/.test(rel)) {
      for (const hit of scanSwift(rel)) addHit(hit, "app", areaFor(rel, "app"), whereFor(rel));
    } else if (LOCALE_FILE_RE.test(rel)) {
      const platform = platformFor(rel);
      for (const hit of scanLocaleFile(rel)) addHit(hit, platform, areaFor(rel, platform), hit.where);
    } else if (/(^|\/)app(\.config)?\.json$/.test(rel)) {
      for (const hit of scanPermissionPrompts(rel)) {
        addHit({ ...hit, kind: KIND.permission }, "app", "Phone app: permission pop-ups", "Permission pop-ups");
      }
    }
  }
  for (const hit of scanPython(pythonFiles)) {
    const platform = platformFor(hit.file);
    addHit(hit, platform, areaFor(hit.file, platform), whereFor(hit.file));
  }
  const lines = [...found.values()];
  for (const l of lines) l.lines = [...new Set(l.lines)].sort((a, b) => a - b);
  lines.sort((a, b) => a.file.localeCompare(b.file) || a.lines[0] - b.lines[0]);
  return lines;
}

// HTML pages: visible text, the tab title, share previews, and labels read
// aloud. Script and style blocks are blanked first, keeping line numbers.
function scanHtml(rel) {
  const raw = fs.readFileSync(path.join(REPO, rel), "utf8");
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const hits = [];
  // Template tags (Jinja, Django, Liquid, Handlebars). Sentences inside them
  // count on their own; {{ value }} reads as {value} in the text around it.
  const tagHits = [];
  const templated = raw
    .replace(/\{#[\s\S]*?#\}|\{\{!--[\s\S]*?--\}\}/g, blank)
    .replace(/\{%[\s\S]*?%\}/g, (m, i) => {
      tagHits.push(...templateStrings(m, i));
      return BREAK + blank(m.slice(1)); // {% if %}Save{% else %}Update stays two lines
    })
    .replace(/\{\{[\s\S]*?\}\}/g, (m, i) => {
      const inline = templateValue(m);
      if (inline === null) tagHits.push(...templateStrings(m, i));
      const out = inline ?? "{value}";
      return out + m.slice(out.length).replace(/[^\n]/g, PAD);
    });
  const src = templated.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, blank);
  const lineAt = (i) => raw.slice(0, i).split("\n").length;
  const push = (i, text, kind) => {
    let offset = 0;
    for (const part of text.split(BREAK)) {
      const clean = normalize(decodeEntities(part.replaceAll(PAD, "")));
      const at = i + offset + Math.max(0, part.search(/\S/));
      offset += part.length + 1;
      if (/\p{L}{2}/u.test(clean.replace(/\{[^{}|]*\}/g, "")) && looksLikeCopy(clean)) hits.push({ file: rel, line: lineAt(at), text: clean, kind });
    }
  };
  // Script blocks in the page: read with the code scanner, template tags
  // turned into {name} so the script still parses.
  for (const m of raw.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=|type="(application\/(ld\+)?json|text\/(template|x-template|html))"/i.test(m[1])) continue;
    const start = m.index + m[1].length;
    const body = m[2]
      .replace(/\{#[\s\S]*?#\}|\{%[\s\S]*?%\}/g, blank)
      .replace(/\{\{[\s\S]*?\}\}/g, (t) => {
        const name = t.slice(2, -2).split("|")[0].trim().match(/([A-Za-z_]\w*)\s*(\(.*\))?\s*$/);
        const out = `{${name ? name[1] : "value"}}`;
        return out + blank(t.slice(out.length));
      });
    if (!/["'`]/.test(body) || isMinified(body)) continue;
    for (const hit of scanFile(rel, platformFor(rel), blank(raw.slice(0, start)) + body)) hits.push({ ...hit, file: rel });
  }
  for (const t of tagHits) push(t.index, t.text, KIND.screen);
  for (const m of src.matchAll(/>([^<>]+)</g)) {
    const openTag = src.slice(src.lastIndexOf("<", m.index), m.index + 1);
    push(m.index + 1, m[1], /^<title\b/i.test(openTag) ? KIND.share : KIND.screen);
  }
  for (const m of src.matchAll(/<[a-z][^>]*>/gi)) {
    const tag = m[0];
    for (const a of tag.matchAll(/\s(aria-label|title|alt|placeholder)="([^"]*)"/gi)) {
      push(m.index, a[2], /^(aria-label|alt)$/i.test(a[1]) ? KIND.reader : a[1].toLowerCase() === "placeholder" ? KIND.placeholder : KIND.screen);
    }
    if (/^<input\b/i.test(tag) && /\stype="(submit|button|reset)"/i.test(tag)) {
      const value = tag.match(/\svalue="([^"]*)"/i);
      if (value) push(m.index, value[1], KIND.screen);
    }
    if (/^<meta\b/i.test(tag) && /(name|property)="(description|og:[\w:]+|twitter:[\w:]+|apple-mobile-web-app-title|application-name)"/i.test(tag)) {
      const content = tag.match(/\scontent="([^"]*)"/i);
      if (content && !/^(https?:|\/)/.test(content[1])) push(m.index, content[1], KIND.share);
    }
  }
  return hits;
}

const BREAK = "\u0001";
const PAD = "\u0002";
const TEMPLATE_FILE_RE = /\.(html?|jinja2?|j2|njk|hbs|handlebars|liquid|ejs)$/i;
const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;

// {{ value }} as it reads inline: {{ _("Save") }} is "Save",
// {{ "Save" if new else "Update" }} is {Save|Update}, anything else is
// {name}. Returns null when the tag holds more than one value to read.
function templateValue(tag) {
  const body = tag.slice(2, -2).trim();
  const strings = [...body.matchAll(QUOTED)].map((m) => m[1] ?? m[2]);
  const gettext = body.match(/^(?:_|gettext|trans|t)\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/);
  if (gettext) return gettext[1] ?? gettext[2];
  if (strings.length === 2 && /\sif\s[\s\S]*\selse\s/.test(body) && strings.every((x) => /\p{L}/u.test(x))) {
    return `{${strings[0]}|${strings[1]}}`;
  }
  if (strings.some((x) => isSentence(x))) return null;
  const name = body.split("|")[0].trim().match(/([A-Za-z_][\w]*)\s*(\(.*\))?\s*$/);
  return `{${name ? name[1] : "value"}}`;
}

// Sentences quoted inside a template tag, such as {% set title = "..." %} or
// {{ button("Save changes") }}.
function templateStrings(tag, offset) {
  const out = [];
  for (const m of tag.matchAll(QUOTED)) {
    const text = m[1] ?? m[2];
    const before = tag.slice(0, m.index);
    const named = before.match(/(?:set\s+|with\s+|\b)([A-Za-z_]\w*)\s*=\s*$/);
    if (isSentence(text) || (named && isCopyName(named[1]) && looksLikeCopy(text) && /\p{L}{2}/u.test(text))) {
      out.push({ index: offset + m.index, text });
    }
  }
  return out;
}

// Python: scan_python.py lists candidate strings; the same copy rules as the
// JavaScript scanner decide which ones count.
const ERROR_CALLEES = /^(abort|HTTPException|BadRequest|Unauthorized|Forbidden|NotFound|Conflict|ValidationError|.*Error|.*Exception)$/;
const SEND_CALLEES = /(mail|email|sms|text_message|notify|notification|push|send)/i;
function scanPython(files) {
  if (!files.length) return [];
  const input = JSON.stringify(files.map((file) => ({ file, path: path.join(REPO, file) })));
  let raw;
  try {
    raw = execFileSync(pythonBinary(), [path.join(SKILL_DIR, "scripts", "scan_python.py")], {
      input,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    });
  } catch (err) {
    console.error(`Python files skipped: ${err.message.split("\n")[0]}`);
    return [];
  }
  const hits = [];
  for (const c of JSON.parse(raw)) {
    const text = normalize(c.text);
    if (!/\p{L}{2}/u.test(text.replace(/\{[^{}|]*\}/g, "")) || !looksLikeCopy(text)) continue;
    const sentence = isSentence(text) || (/\{/.test(text) && isTemplateSentence(text));
    let kind = null;
    if (c.via === "call" && c.name === "gettext") kind = KIND.screen;
    else if (c.via === "call" && c.name === "flash") kind = KIND.popup;
    else if (c.via === "call" && ERROR_CALLEES.test(c.name)) kind = sentence || /^(abort|HTTPException)$/.test(c.name) ? KIND.error : null;
    else if (c.via === "call" && SEND_CALLEES.test(c.name)) kind = sentence ? KIND.email : null;
    else if (c.via !== "bare" && isCopyName(c.name)) {
      const words = nameWords(c.name);
      kind = words.some((w) => /^(error|errors|warning)$/.test(w))
        ? KIND.error
        : words.some((w) => /^(subject|preheader|body)$/.test(w))
          ? KIND.email
          : KIND.screen;
    }
    if (!kind && sentence) kind = KIND.server;
    if (kind) hits.push({ file: c.file, line: c.line, text, kind });
  }
  return hits;
}

// The project's own Python first, so newer syntax parses.
function pythonBinary() {
  let mainCheckout = REPO;
  try {
    mainCheckout = path.dirname(path.resolve(REPO, git(["rev-parse", "--git-common-dir"])));
  } catch {}
  const options = [REPO, mainCheckout].flatMap((base) => [".venv", "venv", "env"].map((v) => path.join(base, v, "bin", "python")));
  options.push("/opt/homebrew/bin/python3", "/usr/local/bin/python3");
  return options.find((p) => fs.existsSync(p)) || "python3";
}

// Swift (the home screen widget): string literals that read as words.
// "\(count)" becomes {count}; nested strings inside it are skipped.
function scanSwift(rel) {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  const hits = [];
  let line = 1;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\n") { line += 1; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i += 1; i -= 1; continue; }
    if (c !== '"') continue;
    const startLine = line;
    const before = src.slice(Math.max(0, i - 40), i);
    let text = "";
    let j = i + 1;
    for (; j < src.length && src[j] !== '"'; j += 1) {
      if (src[j] === "\n") line += 1;
      if (src[j] === "\\" && src[j + 1] === "(") {
        let depth = 1;
        let k = j + 2;
        for (; k < src.length && depth > 0; k += 1) {
          if (src[k] === "(") depth += 1;
          else if (src[k] === ")") depth -= 1;
          else if (src[k] === '"') { k += 1; while (k < src.length && src[k] !== '"') k += 1; }
        }
        const inner = src.slice(j + 2, k - 1).trim();
        const choices = [...inner.matchAll(/"([^"]*)"/g)].map((q) => q[1]);
        text += choices.length === 2
          ? `{${choices[0]}|${choices[1]}}` // count == 1 ? "building" : "buildings"
          : `{${inner.split(/[.\s(]/).filter(Boolean).pop() || "value"}}`;
        j = k - 1;
      } else if (src[j] === "\\") {
        j += 1;
      } else text += src[j];
    }
    i = j;
    if (/\b(print|NSLog|os_log|Logger|fatalError|assert\w*|precondition\w*)\s*\($/.test(before)) continue;
    const words = text.replace(/\{[^{}]*\}/g, " ").trim();
    const labelled = /(Text|Label|accessibilityLabel|accessibilityHint|configurationDisplayName|description|Button)\s*\(\s*$/.test(before);
    if (/\p{L}{2}/u.test(words) && looksLikeCopy(text) && (labelled || (/\s/.test(words) && isTemplateSentence(text)))) {
      hits.push({ file: rel, line: startLine, text: normalize(text), kind: KIND.screen });
    }
  }
  return hits;
}

// Translation files (i18next, react-intl and similar). Only the English file is
// read; every string in it is words people see. {{name}} reads as {name}.
const LOCALE_FILE_RE = /(^|\/)(locales?|i18n|lang|langs|translations?|messages)\/(en|en[-_]US)(\/[^/]+)?\.json$/;

function scanLocaleFile(rel) {
  const source = fs.readFileSync(path.join(REPO, rel), "utf8");
  const rows = source.split("\n");
  const base = path.basename(rel, ".json");
  const namespace = /^en([-_]US)?$/.test(base) ? "" : base;
  const where = (namespace ? namespace.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^\w/, (c) => c.toUpperCase()) : "Translations") + " (translations)";
  const hits = [];
  let from = 0;
  const kindFor = (keyPath) =>
    /a11y|accessibility/i.test(keyPath) ? KIND.reader
    : /placeholder/i.test(keyPath) ? KIND.placeholder
    : /error|failed|invalid/i.test(keyPath) ? KIND.error
    : /alert/i.test(keyPath) ? KIND.alert
    : /push|notification/i.test(keyPath) ? KIND.email
    : KIND.screen;
  const walk = (value, keyPath) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${keyPath}.${i}`));
    if (value && typeof value === "object") return Object.entries(value).forEach(([k, v]) => walk(v, keyPath ? `${keyPath}.${k}` : k));
    if (typeof value !== "string" || !/\p{L}/u.test(value)) return;
    const needle = JSON.stringify(value).slice(1, -1);
    let line = rows.findIndex((row, i) => i >= from && row.includes(needle));
    if (line < 0) line = rows.findIndex((row) => row.includes(needle));
    if (line >= 0) from = line;
    hits.push({ file: rel, line: line + 1, text: normalize(value.replace(/\{\{\s*-?\s*([\w.]+)[^{}]*\}\}/g, "{$1}")), kind: kindFor(keyPath), where });
  };
  walk(JSON.parse(source), "");
  return hits;
}

// iOS asks for camera, photos, location etc. with sentences from app.json.
function scanPermissionPrompts(rel) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [];
  const source = fs.readFileSync(abs, "utf8");
  const rows = source.split("\n");
  const hits = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && /(UsageDescription|Permission)$/.test(k) && /\s/.test(v)) {
        rows.forEach((row, i) => {
          if (row.includes(`"${k}"`) && row.includes(JSON.stringify(v).slice(1, -1))) hits.push({ file: rel, line: i + 1, text: normalize(v) });
        });
      } else walk(v);
    }
  };
  walk(JSON.parse(source));
  return hits;
}

let trackedCache;
function trackedFiles() {
  trackedCache ??= git(["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return trackedCache;
}

function isScannable(rel) {
  if (!fs.existsSync(path.join(REPO, rel))) return false;
  if (INCLUDE.some((re) => re.test(rel))) return true;
  return !SKIP_PATH.some((re) => re.test(rel));
}

function listFiles() {
  return trackedFiles().filter((f) => CODE_FILE.test(f) && isScannable(f));
}

// Bundled or minified code: words in it belong to libraries, not the product.
function isMinified(text) {
  const lines = text.split("\n");
  return lines.some((l) => l.length > 1000) && text.length / lines.length > 300;
}

// `inline` is a script block from a page, padded so line numbers match the page.
function scanFile(rel, platform, inline) {
  const source = inline ?? fs.readFileSync(path.join(REPO, rel), "utf8");
  if (!inline && /\.[cm]?js$/.test(rel) && isMinified(source)) return [];
  const isJsx = !inline && /\.[jt]sx$/.test(rel);
  ts ??= loadTypeScript();
  const sf = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    isJsx ? ts.ScriptKind.TSX : !inline && rel.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const isServer = platform === "server";
  const isMessageFile = isServer && MESSAGE_FILE.test(path.basename(rel));
  const hits = [];
  const hitsBySentence = [];
  const consumed = new Set();
  const isImportPath = (n) => ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || ts.isExternalModuleReference(n.parent) || ts.isLiteralTypeNode(n.parent);
  // A literal inside a template or concatenation was already read as part of
  // the whole string.
  const insideClaimedTemplate = (n) => ts.isTemplateSpan(n.parent) || (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken);

  const add = (node, text, kind) => {
    const clean = normalize(text);
    // Needs real words outside placeholders: "{name} · {status}" is not copy,
    // but "{Save|Unsave} {address}" is.
    if (!clean || !/\p{L}/u.test(clean.replace(/\{[^{}|]*\}/g, ""))) return;
    hits.push({ text: clean, kind, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const addValues = (expr, kind, strict = true) => {
    for (const v of copyValues(expr)) {
      if (!strict || looksLikeCopy(v.text)) add(v.node, v.text, kind);
    }
  };

  function visit(node, ctx) {
    if (ctx.noCopy) return; // inside a log call, class list, query key, etc.

    // JSX: text between tags, read as whole sentences.
    if (!isServer && (ts.isJsxElement(node) || ts.isJsxFragment(node)) && !consumed.has(node)) {
      for (const run of jsxRuns(node.children)) add(run.node, run.text, KIND.screen);
    }

    // JSX attributes like placeholder="..." or accessibilityLabel="...".
    if (!isServer && ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      if (name === "value" && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        // value={`${n} comments, ${m} saved`} on display rows. Inputs pass
        // variables here, which yield nothing.
        addValues(node.initializer.expression, KIND.screen);
      } else if (isCopyName(name)) {
        const kind = attributeKind(name);
        if (ts.isStringLiteral(node.initializer)) {
          const value = decodeEntities(node.initializer.text); // JSX decodes &apos; in attributes
          if (looksLikeCopy(value) || kind !== KIND.screen) add(node.initializer, value, kind);
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          addValues(node.initializer.expression, kind);
        }
      }
    }

    // Object properties like { title: "...", description: "..." }.
    if (ts.isPropertyAssignment(node) && propName(node.name)) {
      const name = propName(node.name);
      if (isServer) {
        if (ctx.inJsonCall && /^(message|error|title|description|detail|reason|hint)$/.test(name)) {
          addValues(node.initializer, KIND.server);
        } else if (/^(message|error)$/.test(name)) {
          // Messages built outside a .json() call, e.g. rate limiter options,
          // that still reach the app. Sentences only, to skip codes.
          for (const v of copyValues(node.initializer)) if (isSentence(v.text)) add(v.node, v.text, KIND.server);
        } else if ((isMessageFile || ctx.inSendCall) && isCopyName(name)) {
          addValues(node.initializer, KIND.email);
        }
      } else if (isCopyName(name)) {
        addValues(node.initializer, ctx.inToast ? KIND.popup : propKind(name));
      }
    }

    // Constants like const EMPTY_TITLE = "..." or const STEPS = ["...", "..."].
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isCopyName(node.name.text)) {
      const init = unwrap(node.initializer);
      if (ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) addValues(el, isServer ? KIND.email : KIND.screen);
      } else if (ts.isObjectLiteralExpression(init) && (!isServer || isMessageFile)) {
        // const SORT_LABELS = { newest: "Newest" }: the values are the labels.
        for (const prop of init.properties) {
          if (ts.isPropertyAssignment(prop) && !isFunctionLike(unwrap(prop.initializer))) {
            for (const v of copyValues(prop.initializer)) if (/^\p{Lu}/u.test(normalize(v.text)) && looksLikeCopy(v.text)) add(v.node, v.text, isServer ? KIND.email : KIND.screen);
          }
        }
      } else if (!ts.isObjectLiteralExpression(init) && !isFunctionLike(init)) {
        if (!isServer || isMessageFile) addValues(init, isServer ? KIND.email : KIND.screen);
      }
    }

    // return "..." inside functions named like statusLabel() or errorMessage().
    if (ts.isReturnStatement(node) && node.expression && ctx.fnName && isCopyName(ctx.fnName)) {
      if (!isServer || isMessageFile) addValues(node.expression, isServer ? KIND.email : KIND.screen);
    }

    if (ts.isNewExpression(node) || (ts.isCallExpression(node) && !isNoCopyCall(node))) {
      const callee = calleeName(node.expression);
      const args = node.arguments ?? [];
      if (ts.isNewExpression(node) && /Error$/.test(callee) && !["Error", "TypeError", "RangeError", "SyntaxError"].includes(callee)) {
        for (const a of args) addValues(a, KIND.error);
      } else if (ts.isNewExpression(node) && callee === "Error" && !isServer) {
        for (const a of args) addValues(a, KIND.error);
      } else if (!isServer && /^(Alert\.)?alert$/.test(dottedName(node.expression)) && dottedName(node.expression).startsWith("Alert")) {
        args.slice(0, 2).forEach((a) => addValues(a, KIND.alert, false));
      } else if (!isServer && SETTER_CALLEE.test(callee)) {
        const kind = /Error|^fail$/.test(callee) ? KIND.error : callee.startsWith("set") ? KIND.screen : KIND.popup;
        for (const a of args) addValues(a, kind);
      } else if (!isServer && FORM_RULE_METHODS.has(callee) && ts.isPropertyAccessExpression(node.expression)) {
        for (const a of args) if (ts.isStringLiteralLike(unwrap(a))) addValues(a, KIND.form);
      } else if (isServer && SEND_CALLEE.test(callee)) {
        for (const a of args) addValues(a, KIND.email);
      } else if (isServer && /^(send|end)$/.test(callee) && /\.status\(/.test(node.expression.getText(sf))) {
        for (const a of args) addValues(a, KIND.server);
      } else if (isServer && isMessageFile && ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.SuperKeyword) {
        // Email and alert files: any sentence handed to a helper.
        for (const a of args) addValues(a, KIND.email);
      }
    }

    // Catch-all outside the server: any other sentence-shaped string.
    const tagged = node.parent && ts.isTaggedTemplateExpression(node.parent); // sql`…`, css`…`
    if (!isServer && !tagged && ts.isStringLiteralLike(node) && isSentence(node.text) && !isImportPath(node)) {
      hitsBySentence.push({ node, text: node.text });
    }
    if (!isServer && !tagged && ts.isTemplateExpression(node) && !insideClaimedTemplate(node)) {
      const text = renderTemplate(node);
      if (isTemplateSentence(text)) hitsBySentence.push({ node, text });
    }

    // Email and alert files on the server: every sentence in a text array.
    if (isServer && isMessageFile && ts.isArrayLiteralExpression(node) && ctx.parentIsJoin) {
      for (const el of node.elements) addValues(el, KIND.email);
    }

    // Walk children with updated context.
    const next = { ...ctx, parentIsJoin: false };
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = calleeName(node.expression);
      if (isNoCopyCall(node)) next.noCopy = true;
      if (callee === "json" || callee === "send") next.inJsonCall = true;
      if (/^toast$|^showToast$/.test(callee)) next.inToast = true;
      if (SEND_CALLEE.test(callee)) next.inSendCall = true;
      if (callee === "join" && ts.isPropertyAccessExpression(node.expression)) {
        ts.forEachChild(node.expression, (c) => visit(c, { ...next, parentIsJoin: true }));
        for (const a of node.arguments) visit(a, next);
        return;
      }
    }
    if (ts.isPropertyAssignment(node) && propName(node.name) && /^(queryKey|className|style|testID)$/.test(propName(node.name))) {
      next.noCopy = true;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (/^(className|style|key|testID|data-testid|href|src|id|to|as|type|role|variant|size|name|d|viewBox|fill|stroke)$/.test(name)) {
        next.noCopy = true;
      }
    }
    const fn = functionName(node);
    if (fn !== undefined) next.fnName = fn;
    ts.forEachChild(node, (child) => visit(child, next));
  }

  // Splits JSX children into sentences. Inline tags (<b>, <Text> inside
  // <Text>, links) stay part of the sentence; block elements end it.
  function jsxRuns(children) {
    const runs = [];
    let parts = [];
    let hasWords = false;
    let first = null;
    const flush = () => {
      const text = parts.join("");
      if (hasWords && first) runs.push({ node: first, text });
      parts = [];
      hasWords = false;
      first = null;
    };
    // Inline tags only join a sentence when there is loose text around them.
    // <View><Text>A</Text><Text>B</Text></View> is two lines, not "AB".
    const hasLooseText = (kids) =>
      kids.some(
        (c) =>
          (ts.isJsxText(c) && /\p{L}/u.test(c.text)) ||
          (ts.isJsxExpression(c) && c.expression && ts.isStringLiteralLike(unwrap(c.expression)) && /\p{L}/u.test(unwrap(c.expression).text)),
      );
    const walk = (kids) => {
      const inlineOk = hasLooseText(kids);
      for (const child of kids) {
        if (ts.isJsxText(child)) {
          const text = jsxTextValue(child.text);
          if (!text) continue;
          parts.push(text);
          if (/\p{L}/u.test(text)) hasWords = true;
          first ??= child;
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue;
          const expr = unwrap(child.expression);
          if (ts.isStringLiteralLike(expr)) {
            parts.push(expr.text);
            if (/\p{L}/u.test(expr.text)) hasWords = true;
            first ??= child;
          } else if (ts.isTemplateExpression(expr)) {
            parts.push(renderTemplate(expr));
            hasWords = true;
            first ??= child;
          } else if (containsJsx(expr)) {
            flush();
          } else if (inlineOk && ts.isConditionalExpression(expr) && inlineChoice(expr) !== null) {
            // "result{ is|s are} available": both branches are words in the
            // middle of a sentence, so keep them in it.
            parts.push(inlineChoice(expr));
            first ??= child;
          } else {
            // A value or a conditional: placeholder in the sentence. Literal
            // branches get their own line through addValues in visit().
            const literals = copyValues(expr);
            if (literals.length && !ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) {
              for (const v of literals) if (/\p{L}/u.test(v.text)) runs.push({ node: v.node, text: v.text });
            }
            parts.push(`{${exprLabel(expr)}}`);
            first ??= child;
          }
        } else if (inlineOk && ts.isJsxElement(child) && INLINE_TAGS.has(tagName(child))) {
          consumed.add(child);
          walk(child.children);
        } else if (ts.isJsxSelfClosingElement(child) && tagName(child) === "br") {
          parts.push(" ");
        } else {
          flush();
        }
      }
    };
    walk(children);
    flush();
    return runs;
  }

  visit(sf, {});
  // Sentences the specific rules above didn't already pick up.
  const claimed = new Set(hits.map((h) => `${h.line}\n${h.text}`));
  const claimedText = new Set(hits.map((h) => h.text));
  for (const { node, text: raw } of hitsBySentence) {
    const text = normalize(raw);
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (claimedText.has(text) || claimed.has(`${line}\n${text}`)) continue;
    if (insideClaimedTemplate(node)) continue;
    hits.push({ text, kind: KIND.screen, line });
  }
  return hits;
}

// ---------- AST helpers ----------

function copyValues(expr) {
  if (!expr) return [];
  const e = unwrap(expr);
  if (ts.isStringLiteralLike(e)) return [{ node: e, text: e.text }];
  if (ts.isTemplateExpression(e)) return [{ node: e, text: renderTemplate(e) }];
  if (ts.isConditionalExpression(e)) return [...copyValues(e.whenTrue), ...copyValues(e.whenFalse)];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      const text = renderConcat(e);
      return text === null ? [] : [{ node: e, text }];
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return [...copyValues(e.left), ...copyValues(e.right)];
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return copyValues(e.right);
  }
  if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((el) => copyValues(el));
  return [];
}

// Logs, analytics, queries, class helpers: their arguments are never copy.
function isNoCopyCall(node) {
  const callee = calleeName(node.expression);
  const dotted = dottedName(node.expression);
  return (
    NO_COPY_CALLEES.has(callee) ||
    /(^|\.)(console|logger|log|Sentry|posthog|analytics)(\.\w+)?$|^(console|logger|Sentry|posthog|analytics)\b|^StyleSheet\.create$/.test(dotted) ||
    (callee === "query" && ts.isPropertyAccessExpression(node.expression))
  );
}

// "Replying to {yourself|otherName}": a choice in the middle of a sentence.
// Needs at least one branch to be words; the other may be a value.
function inlineChoice(cond) {
  const side = (e) => {
    const v = copyValues(e);
    if (v.length === 1 && !/[{}|]/.test(v[0].text)) return { text: v[0].text, words: true };
    if (v.length === 0) return { text: exprLabel(e), words: false };
    return null;
  };
  const a = side(cond.whenTrue);
  const b = side(cond.whenFalse);
  if (!a || !b || (!a.words && !b.words)) return null;
  return `{${a.text}|${b.text}}`;
}

function renderConcat(e) {
  const parts = [];
  let hasString = false;
  const walk = (n) => {
    n = unwrap(n);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      walk(n.left);
      walk(n.right);
    } else if (ts.isStringLiteralLike(n)) {
      parts.push(n.text);
      hasString = true;
    } else if (ts.isTemplateExpression(n)) {
      parts.push(renderTemplate(n));
      hasString = true;
    } else {
      parts.push(`{${exprLabel(n)}}`);
    }
  };
  walk(e);
  return hasString ? parts.join("") : null;
}

function renderTemplate(t) {
  let out = t.head.text;
  for (const span of t.templateSpans) {
    const inner = unwrap(span.expression);
    if (ts.isConditionalExpression(inner)) {
      const a = copyValues(inner.whenTrue)[0]?.text;
      const b = copyValues(inner.whenFalse)[0]?.text;
      // `${n > 0 ? `, ${n} unread` : ""}` reads best as the optional words inline.
      if (a !== undefined && b === "") out += a;
      else if (a === "" && b !== undefined) out += b;
      else if (a !== undefined && b !== undefined && !/[{}]/.test(a + b)) out += `{${a}|${b}}`;
      else out += `{${exprLabel(inner)}}`;
    } else {
      out += `{${exprLabel(inner)}}`;
    }
    out += span.literal.text;
  }
  return out;
}

function exprLabel(e) {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return exprLabel(e.expression);
  if (ts.isCallExpression(e)) return `${calleeName(e.expression) || "value"}()`;
  if (ts.isConditionalExpression(e) || ts.isBinaryExpression(e)) return "…";
  return "…";
}

function unwrap(e) {
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression?.(e) ||
      ts.isSatisfiesExpression?.(e))
  ) {
    e = e.expression;
  }
  return e;
}

function containsJsx(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function calleeName(e) {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isCallExpression(e)) return calleeName(e.expression);
  return "";
}

function dottedName(e) {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${dottedName(e.expression)}.${e.name.text}`;
  return "";
}

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return "";
}

function tagName(el) {
  const t = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  return t.getText().split(".").pop();
}

function isFunctionLike(n) {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name ? node.name.getText() : "";
  if (isFunctionLike(node)) {
    const p = node.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p)) return propName(p.name);
    return ""; // callbacks reset the name so a nested return isn't misread
  }
  return undefined;
}

function nameWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isCopyName(name) {
  const words = nameWords(name);
  if (!words.length) return false;
  const last = words[words.length - 1];
  if (NOT_COPY_WORDS.has(last)) return false;
  if (words.some((w) => w === "classname" || w === "testid")) return false;
  return words.some((w) => COPY_WORDS.has(w) || COPY_WORDS.has(w.replace(/s$/, ""))); // SORT_LABELS, titles
}

function attributeKind(name) {
  const n = name.toLowerCase();
  if (n === "placeholder") return KIND.placeholder;
  if (n.startsWith("aria-") || n.startsWith("accessibility") || n === "alt") return KIND.reader;
  if (n === "title") return KIND.screen;
  return KIND.screen;
}

function propKind(name) {
  const n = name.toLowerCase();
  if (n === "placeholder") return KIND.placeholder;
  if (n.startsWith("accessibility") || n.startsWith("aria")) return KIND.reader;
  return KIND.screen;
}

function jsxTextValue(raw) {
  const decoded = decodeEntities(raw);
  const lines = decoded.split(/\r\n|\n|\r/);
  if (lines.length === 1) return decoded;
  let out = "";
  lines.forEach((line, i) => {
    let l = line;
    if (i > 0) l = l.replace(/^[ \t]+/, "");
    if (i < lines.length - 1) l = l.replace(/[ \t]+$/, "");
    if (l) out += (out ? " " : "") + l;
  });
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&apos;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&middot;/g, "·")
    .replace(/&times;/g, "×")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// ---------- text helpers ----------

// Words with placeholder names and quote styles ironed out, so an applied
// rewrite still matches when the code names its value differently.
function shape(s) {
  return normalize(s)
    .replace(/\{[^{}]*\}/g, "{}")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .toLowerCase();
}

function normalize(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

// A string that reads like a sentence: capital letter, a space, real words.
function isSentence(raw) {
  const s = normalize(raw);
  if (!looksLikeCopy(s)) return false;
  if (!/^[\p{Lu}"“'‘(¿¡]/u.test(s) && !/^[$+]?\d[\d,.]*[%+]?[-\s]*[\p{L}$]/u.test(s)) return false;
  if (!/\s/.test(s) || s.split(" ").length < 2) return false;
  if (/[{}<>;=]|\$\{|=>|\|\|/.test(s)) return false; // code, markup
  return true;
}

// A template like `${name} saved ${count} photos.` or
// `Homes: ${n}`. Placeholders don't count as words.
function isTemplateSentence(raw) {
  const s = normalize(raw);
  const words = s.replace(/\{[^{}]*\}/g, " ").replace(/\s+/g, " ").trim();
  if (!/\p{L}{2}/u.test(words) || !looksLikeCopy(words)) return false;
  if (/[<>;=]|\/\/|^\/|\/$|--|^(Bearer|Basic)\b/.test(s)) return false;
  return /^\p{Lu}/u.test(words) || /[.?!]$/.test(s);
}

// Filters out ids, class lists, paths and codes that sit where copy could be.
function looksLikeCopy(raw) {
  const s = normalize(raw);
  if (!s || !/\p{L}/u.test(s)) return false;
  if (/^(https?:|mailto:|tel:|sms:|www\.|data:|blob:|\/|\.\/|#|@)/i.test(s)) return false;
  if (/^</.test(s) || /<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(s)) return false; // markup such as inline SVG
  if (/^[a-z][a-zA-Z0-9]*$/.test(s)) return false; // camelCase or lowercase token
  if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(s)) return false; // CONSTANT_CODE
  if (/^[\w$]+([_\-.:/][\w$]+)+$/.test(s) && !/\s/.test(s)) return false; // kebab-case, paths, ids
  if (/^[\w.+-]+\/[\w.+-]+$/.test(s)) return false; // mime types
  if (/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|SET|LOCK|TRUNCATE|GRANT|REVOKE|EXPLAIN|VACUUM|WHERE|FROM|JOIN|LEFT JOIN|INNER JOIN|ORDER BY|GROUP BY|VALUES|RETURNING|ON CONFLICT|AND|OR)\b/.test(s)) return false;
  if (/^@media|\((min|max)-(width|height)|^\(?(prefers-|hover:|pointer:)/.test(s)) return false; // media queries
  if (/^[\d\s.,:%+\-–—/×x$()]+[a-z]{0,3}$/i.test(s)) return false; // numbers and units
  // Words outside value placeholders; a choice like {Open|Mark read} counts as words.
  const bare = s
    .replace(/\{[^{}|]*\}/g, " ")
    .replace(/\{([^{}]*)\}/g, (_, inner) => inner.replace(/\|/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (bare && isClassList(bare)) return false;
  if (bare !== s && /^[a-z0-9]*[-_][a-z0-9_-]*$/.test(bare)) return false; // ids like "noir-{name}", "{prefix}-low"
  if (/^[MmLlHhVvCcSsQqTtAaZz][\s\d.,{}\-MmLlHhVvCcSsQqTtAaZz]*$/.test(s) && !/[a-z]{2}/i.test(bare)) return false; // SVG path data
  if (/^\[[\w:.-]+\]/.test(s)) return false; // "[worker-name] drain failed" log lines
  if (/^\d+(px|rem|em|%)\b|rgba?\(|^#[0-9a-f]{3,8}\b/i.test(s)) return false; // CSS values
  return true;
}

// Tailwind class strings: "border-emerald-500/30 bg-card dark:text-white".
const CLASS_WORDS = new Set(
  "flex grid block hidden inline relative absolute fixed sticky truncate italic underline uppercase lowercase capitalize rounded border shadow transition grow shrink static visible invisible contents".split(" "),
);
function isClassList(s) {
  const tokens = s.split(" ");
  // Real class lists carry hyphenated names ("bg-card"); "/mo" or "notification:" don't.
  if (!tokens.some((t) => /[a-z]-[a-z0-9[]/.test(t))) return false;
  return tokens.every((t) => (/^[a-z0-9:/[\].%#_!-]+$/.test(t) && /[-:/[]/.test(t)) || CLASS_WORDS.has(t));
}

function flagsFor(text) {
  const out = [];
  for (const t of tells) if (t.re.test(text) && !out.includes(t.why)) out.push(t.why);
  return out;
}

const PLATFORM_LABEL = { web: "Web", app: "Phone app", server: "Server", admin: "Admin (staff only)", shared: "Shared" };

// Groups files by surface and their first folder or two, e.g. "Web: client/src/pages".
// Files at the top of the repo group by the first word of their name.
function areaFor(rel, platform) {
  const parts = rel.split("/");
  const dirs = parts.slice(0, -1).filter((p) => !/^\(.*\)$/.test(p));
  const first = parts[parts.length - 1].replace(/^[_.]+/, "").split(/[-_.]/)[0] || "other";
  const where = dirs.slice(0, 3).join("/") || `top level: ${first}`;
  return `${PLATFORM_LABEL[platform] ?? platform}: ${where}`;
}

function whereFor(rel) {
  const parts = rel
    .replace(/\.([cm]?[jt]sx?|html?|swift)$/, "")
    .split("/")
    .filter((p) => !/^\(.*\)$/.test(p)) // route groups like (tabs)
    .filter((p) => !["src", "app", "pages", "components", "features", "routes", "services", "lib", "client", "server", "shared"].includes(p));
  if (parts.length > 1 && /^(index|_layout|page|layout)$/.test(parts[parts.length - 1])) parts.pop();
  const words = parts.slice(-2).map((p) =>
    p
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_.]+/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase()),
  );
  const label = words.join(" / ") || "Home";
  return label === "Index" ? "Home" : label;
}

function summarize(lines) {
  const s = { total: lines.length, keep: 0, cut: 0, rewrite: 0, skip: 0, open: 0, flaggedOpen: 0 };
  for (const l of lines) {
    if (l.verdict) s[l.verdict] += 1;
    else {
      s.open += 1;
      if (l.flags.length) s.flaggedOpen += 1;
    }
  }
  return s;
}

// ---------- misc ----------

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--changed")) {
      if (a.includes("=")) opts.changed = a.split("=")[1];
      else if (args[i + 1] && !args[i + 1].startsWith("--")) opts.changed = args[++i];
      else opts.changed = true;
    }
    else if (a.startsWith("--")) opts[a.slice(2)] = args[++i];
  }
  return opts;
}

function today() {
  return new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
}

// The remote's main branch: origin/main, origin/master, or whatever origin/HEAD names.
function defaultBase() {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  } catch {}
  for (const name of ["origin/main", "origin/master"]) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
      return name;
    } catch {}
  }
  return "origin/main";
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// The skill's own TypeScript (npm install in the skill folder) comes first so
// every project scans the same way. TypeScript 7 and later has no parser that
// scripts can call, so a project's own copy is only a fallback.
function loadTypeScript() {
  let mainCheckout = REPO;
  try {
    mainCheckout = path.dirname(path.resolve(REPO, git(["rev-parse", "--git-common-dir"])));
  } catch {}
  const candidates = [
    () => createRequire(path.join(SKILL_DIR, "package.json"))("typescript"),
    () => createRequire(path.join(REPO, "package.json"))("typescript"),
    () => createRequire(path.join(mainCheckout, "package.json"))("typescript"),
  ];
  for (const load of candidates) {
    try {
      const found = load();
      if (typeof found.createSourceFile === "function") return found;
    } catch {}
  }
  console.error(`Can't find TypeScript 5. Run "npm install" in ${SKILL_DIR}.`);
  process.exit(2);
}

main();
