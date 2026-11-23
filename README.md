# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ibad-diary/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ibad-diary/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. AI models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend applies any of them to a tree of text files, finding the lines each edit names even when the model drifted their whitespace or indentation, and changing every file or none. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; no install step. The working directory is the root of the tree. `PATCH` is the patch file (or `-`, or absent, to read it from standard input). `--format` is `auto` (the default, which detects the format), `unified`, `search-replace`, `v4a` or `json`. `--check` does everything but write. `--strict` matches lines exactly.

Exit 0 prints one line per changed file (`A`, `D`, `M`, or `R <old> -> <new>`) and `ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n> edits`, and nothing is written. Exit 2 is a usage, missing-patch, format or parse error, one line.

Matching runs at the first of three tiers at which the old lines occur: exact, trailing whitespace ignored, surrounding whitespace ignored (`--strict` tries the first tier only). Unified hunks take the occurrence nearest the hunk's line number; SEARCH/REPLACE blocks need exactly one occurrence; V4A chunks follow an anchor and a cursor, and can anchor a chunk to the end of the file. Line breaks (LF or CRLF) and the file's final line break are preserved; created files use LF.

The full contract is `SPEC.md`. `check.ts` runs `main.ts` against the kit's public practice set (`node check.ts <practice.json>`); `runner.ts` is the kit's trial runner, kept as shipped.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s67gjd7a&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
