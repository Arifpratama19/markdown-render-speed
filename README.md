# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Arifpratama19/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Arifpratama19/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that returns exactly the HTML marked 18.1.3 returns with default options (GFM on, breaks off, pedantic off, async off) — for every string. Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty, $250 in USDC.

`parse.js` is a from-scratch parser (no copied marked source): block lexing and inline rendering in one pass, straight to strings with no intermediate token objects, sticky-regex dispatch on the first character, and a single shared inline state. It covers CommonMark blocks (ATX/setext headings, paragraphs, fenced/indented code, block quotes, lists including task lists, tables, thematic breaks, HTML blocks, link reference definitions) and inlines (emphasis/strong, strikethrough, code spans, links including reference/image/autolink/extended autolink, entities, backslash escapes, inline HTML, hard breaks) — including the places where marked departs from the spec.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

This reads `cases.json` from the input directory, renders each case with `parse()`, and writes `html.json` (a JSON array of the HTML strings, in case order) to the output directory.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dr6zbad5&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
