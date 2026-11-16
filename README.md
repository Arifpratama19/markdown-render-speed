# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Arifpratama19/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Arifpratama19/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that produces exactly the HTML marked 18.1.3 produces, but faster. `parse.js` is a from-scratch CommonMark + GFM parser (block and inline tokenisers, link reference definitions, tables, task lists, strikethrough, autolinks) whose `parse(markdown)` matches `marked.parse(markdown)` with marked's default options on all 720 practice cases, and runs about 10% faster than marked on the same set. `main.ts` is the entry point the grader runs: it reads every case, renders each with `parse`, and writes the HTML in order.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

In the grading container it runs as `node /bot/main.ts`, reading `/input/cases.json` and writing `/output/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dr6zbad5&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
