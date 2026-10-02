---
name: justify
description: Check every line of words a product shows people (web pages, phone app screens, server messages, emails, phone alerts, permission pop-ups) and keep only the lines that earn their place. Works in any git repo. Use whenever a change adds or edits words people see (button labels, headings, helper text, empty states, errors, toasts, alerts, emails) before handing the work off. Also use when asked to check copy, find AI slop, cut filler or performative words, build or update a Copy Check page, or apply cut and rewrite verdicts the owner approved.
---

# Justify

Goal: no AI slop in the product. Slop is words that perform instead of inform. They sound like a product, but nobody would miss them.

Every line of words people see gets one verdict, saved in the repo at `.justify/verdicts.jsonl`. The Copy Check page shows them all, grouped by screen.

If the repo has its own `.claude/skills/justify/`, use that one instead. It knows that repo's folders.

## The test

For each line, answer one question:

> Without this line, what would the person get wrong, or not know?

- **keep**: there is a specific answer. That answer is the reason. "Without it the button has no name." "They wouldn't know the photo is deleted after printing."
- **cut**: there is no answer, or the answer is a feeling (warmth, trust, excitement, reassurance, delight).
- **rewrite**: the line is needed but padded, vague, hyped, or names something differently from the rest of the product. Give the new words.
- **skip**: people never see it (a developer error that is only logged, a test hook, an internal check). Say where it goes instead.

Cut is the default. An AI asked to justify a line will always find a reason, and that reason is slop one level up. So a keep reason must name a concrete thing the person would do wrong or not know. `record` rejects vague keep reasons ("adds clarity", "builds trust", "improves the experience").

## What slop looks like

- Says again what the screen already shows. A heading "Your messages" above a list titled Inbox.
- Narrates the screen. "Here you can…", "Below you'll find…", "This is where…".
- Cheers or soothes with no fact. "You're all set!", "Great choice!", "Don't worry."
- Hype. "Seamless", "effortless", "unlock", "elevate", "curated", "powerful", "magical".
- Filler. "Simply", "just", "easily", "quickly", "truly", "actually".
- Writerly moves. Asides set off by long dashes, "not X, but Y", lists of three for rhythm, a colon before a reveal. A long dash that only separates two parts of a short label ("Hardcover — $39") is fine.
- Errors that don't help. "Something went wrong" without what failed or what to do next.
- Two names for one thing. "Create story" on one screen and "New book" on another. Search the inventory before you keep a label.
- Screen reader labels that don't match the visible words, or that describe looks instead of the action.

## What earns its place

- Names an action: button and link labels.
- States a fact the person needs: price, time, who can see it, what happens next, what it costs.
- Prevents a mistake: what gets deleted, what can't be undone, what the other person will see.
- Says what failed and what to do.
- Is required by law or policy: privacy, children's data, payment and refund terms, licensing, consent. Keep it, say which rule, and never rewrite it without the product owner.

## Writing rewrites

Use the product's own voice rules if the repo has them (AGENTS.md, CLAUDE.md, a style guide). Otherwise: short, everyday words, calm. Use the name people see for the product (the `product` in `.justify/config.json`), not an old internal name.

- A rewrite passes the same test. Don't fix slop with different slop.
- Shorter, or the same length plus a missing fact. Never longer for style.
- Match the wording other screens already use for the same thing.
- Placeholders stay as they are: `{username}` in the inventory is a value filled in while the app runs. `{Save|Update}` means the code picks one of the two.

## Commands

Run from anywhere inside the repo. `<skill>` is the folder this file is in.

```bash
node <skill>/scripts/justify.mjs init
node <skill>/scripts/justify.mjs build
node <skill>/scripts/justify.mjs todo --changed
node <skill>/scripts/justify.mjs todo --file "settings" --limit 200
node <skill>/scripts/justify.mjs record /path/to/batch.json
node <skill>/scripts/justify.mjs conflicts
node <skill>/scripts/justify.mjs prune
```

If the script says it can't find TypeScript, run `npm install` in `<skill>` once.

- `init` creates `.justify/` (config, empty verdicts, a `.gitignore` for `out/`) and prints how many lines it found per area.
- `build` scans the code, attaches verdicts, and writes `.justify/out/copy-check.html` and `.justify/out/inventory.json`. It prints the totals.
- `todo` lists lines with no verdict yet: key, file, line numbers, kind, words, and any flagged words. `--changed` limits it to files changed since the remote's main branch (or `--changed <base>`), including uncommitted and new files. `--platform` takes `web`, `app`, `server`, `shared` or `admin`.
- `record` saves a batch: `[{"key": "…", "verdict": "keep|cut|rewrite|skip", "reason": "…", "rewrite": "new words"}]`. It prints anything it rejected and why. Fix those and record them again. `record <file> --check` validates without saving; helpers working in parallel use it, and one session records.
- `conflicts` lists the same words that end up worded differently in different files. Often a web and phone app pair that should match. Fix it unless the context really differs.
- `prune` drops verdicts for lines that are no longer in the code.

Set `JUSTIFY_DIR=/some/scratch/folder` to keep everything out of the repo, for a look before setting a project up.

## Setting up a project (first time only)

1. `init`. Read the area list it prints.
2. Open `.justify/config.json` and fix what the scanner got wrong:
   - `product`: the name people see.
   - `exclude`: path patterns (regex) for code people never see. Old copies and backups, design mockups, test data, internal QA tools, one-off scripts, generated output.
   - `include`: path patterns to scan even though a default rule skips them.
   - `platforms`: `{ "<path regex>": "web" | "app" | "server" | "admin" | "shared" }` when a folder lands in the wrong group. Staff-only tools are `admin`.
3. `build` again until the areas look right. Spot-check a few files: are the lines really words people see, and is anything obvious missing?
4. Commit `.justify/config.json`, `.justify/verdicts.jsonl` and `.justify/.gitignore` on the branch you are working on.

The scanner finds code on its own: every tracked `.ts .tsx .js .jsx .mjs .cjs .py` file, HTML and page templates (Jinja, Django, Liquid, Handlebars, EJS), Swift, and Expo `app.json` permission prompts. It skips tests, build output, tooling, migrations and config files. A folder whose `package.json` uses React Native or Expo counts as the phone app.

## Workflow

### After changing words in a feature or fix

1. `todo --changed`.
2. For each file, read the code around every line: where it shows, when, and to whom. Judge each line with the test.
3. Write the batch to a file in your scratchpad and `record` it.
4. If you wrote the line yourself and it fails, fix the code now, not just the verdict. Then build again.
5. Commit `.justify/verdicts.jsonl` with the change.
6. Publish the page (below), if the project has one.

### A sweep (whole screen, whole platform, or everything)

Same steps with `--file` or `--platform`, one screen at a time. Then run `conflicts`. Cut and rewrite verdicts on existing words are proposals. Don't change the product's words until the product owner approves them.

Helpers can split a sweep by file. Give each one this file's rubric and an example batch, have them write batches to their own scratch folder and validate with `--check`, then record their batches yourself. Two processes writing `verdicts.jsonl` at once can lose verdicts.

### Applying approved verdicts

Only when the product owner says so, and only the verdicts they approved.

- Change the words in code. If a screen exists on both web and phone app, change both, and check shared code for the same words.
- Change only labels. Never change words that are also stored or compared values (option ids, enum values, database values, analytics names): add a label instead. Never change legal or consent text without the product owner.
- Tests must not pin wording. If a test breaks because words changed, rewrite it to find the element by test id or role, not to expect the new words. Exact words only belong in tests for legal text, prices, and words matched by code.
- `build`. An applied rewrite shows up as a new line with the new words. If those words match the proposal (placeholder names and quote style may differ), its approval carries over as keep.
- Before `prune`, run `todo --changed`. Any line still listed in a file you just changed didn't carry over: record it now. `prune` deletes the old verdict, and with it the approval.

## Sharing the page

`build` writes one self-contained file, `.justify/out/copy-check.html`. Open it in a browser, or publish it anywhere that hosts a single HTML page (in Claude, an Artifact). Save the link as `pageUrl` in `.justify/config.json` and commit the config, so the next session updates the same page instead of making a new one.

The page shows which code version it was built from. If it falls behind, the next session that runs `build` and publishes brings it up to date.

## Limits

- Lines are matched by file plus exact words. Moving a line to another file, or editing its words, makes it a new line that needs a verdict.
- The same words twice in one file share one verdict, even if one is a button and the other is read aloud.
- Not read: Kotlin, Java, Go, Ruby, PHP, Vue and Svelte files, Markdown pages, App Store text, words inside images and videos, and anything typed in a dashboard outside the code (an email template in a provider, a push sent by hand).
- The scanner reads code, not the running product. It misses words that come from data at run time (stories, AI replies, user profiles), single words with no copy-like name, words passed through helper functions, text drawn on a canvas, and text set with innerHTML. Judge those when you read the code around a screen.
- Python: raised error messages are included, because many apps flash them to people. Mark the ones that only reach logs `skip`.
- It picks up some strings people never see. Mark those `skip`, or exclude the folder in the config.
- Flagged words only point at a closer look. A flag is not a verdict, and a line without flags can still be slop. A project can add its own list at `.justify/tells.json`.
