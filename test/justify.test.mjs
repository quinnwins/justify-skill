// Builds a throwaway git repo from test/fixture, runs the scanner on it, and
// checks which lines it finds. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(SKILL, "scripts", "justify.mjs");

function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "justify-repo-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "justify-data-"));
  fs.cpSync(path.join(SKILL, "test", "fixture"), repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  const run = (...args) =>
    execFileSync("node", [SCRIPT, ...args], {
      cwd: repo,
      env: { ...process.env, JUSTIFY_DIR: data },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  return { repo, data, run };
}

const { data, run } = setup();
run("build");
const lines = JSON.parse(fs.readFileSync(path.join(data, "out", "inventory.json"), "utf8")).lines;
const found = (file) => lines.filter((l) => l.file === file).map((l) => l.text);

test("finds words on React screens and skips code", () => {
  const words = found("web/Settings.tsx");
  for (const w of ["Settings", "You have {count} photos in your library.", "Search your photos", "Close settings", "Save changes", "Changes saved"]) {
    assert.ok(words.includes(w), `missing "${w}" in ${JSON.stringify(words)}`);
  }
  assert.ok(!words.some((w) => w.includes("flex-col")), "class names are not words");
  assert.ok(!words.includes("Settings screen opened by the user"), "log lines are not words");
});

test("reads page templates, their tags and inline scripts", () => {
  const words = found("templates/page.html");
  for (const w of ["Your roof report", "Hi {first_name}, welcome back", "Saved your changes", "Nothing changed yet", "{Save|Update}", "Billing and plans", "Send it", "Close the panel", "Admins can edit every page."]) {
    assert.ok(words.includes(w), `missing "${w}" in ${JSON.stringify(words)}`);
  }
  assert.ok(!words.some((w) => /Hello there friend|Structured data/.test(w)), "comments and data blocks are not words");
});

test("reads Python messages and skips logs, prompts, help text and comparisons", () => {
  const words = found("app/routes.py");
  for (const w of ["That file is too large", "Saved {n} photos for {name}.", "That address is not in your area.", "Pick a day first."]) {
    assert.ok(words.includes(w), `missing "${w}" in ${JSON.stringify(words)}`);
  }
  for (const w of ["Module docstring that reads like a sentence here.", "Started the import for everyone", "You are a helpful assistant. Answer briefly.", "Needs review now", "Write like a person would talk.", "Run the whole thing again please."]) {
    assert.ok(!words.includes(w), `"${w}" is not shown to people`);
  }
});

test("record saves concrete reasons and rejects vague ones", () => {
  const key = (text) => lines.find((l) => l.text === text).key;
  const batch = path.join(data, "batch.json");
  fs.writeFileSync(
    batch,
    JSON.stringify([
      { key: key("Save changes"), verdict: "keep", reason: "Without it the button has no name." },
      { key: key("Settings"), verdict: "keep", reason: "Adds clarity to the page." },
      { key: key("Changes saved"), verdict: "rewrite", reason: "Says the same as the button.", rewrite: "Saved" },
    ]),
  );
  // record exits with 1 when it rejects anything, so the session notices.
  let output;
  try {
    output = run("record", batch);
    assert.fail("record should exit with an error when it rejects a line");
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    output = err.stdout;
  }
  const result = JSON.parse(output);
  assert.equal(result.saved, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].key, key("Settings"));
  const saved = fs.readFileSync(path.join(data, "verdicts.jsonl"), "utf8").trim().split("\n");
  assert.equal(saved.length, 2);
});

test("build writes one page with the data inside", () => {
  const page = fs.readFileSync(path.join(data, "out", "copy-check.html"), "utf8");
  assert.ok(!page.includes("/*__JUSTIFY_DATA__*/null"), "data was not inlined");
  assert.ok(!page.includes("__PRODUCT__"), "product name was not filled in");
  // Opened straight from disk, a page without this shows quote marks as garbage.
  assert.match(page, /<meta charset="utf-8">/i);
});
