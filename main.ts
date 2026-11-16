// main.ts — the program the harness runs (Node 22, standard library only).
// It reads every case from /input/cases.json (a JSON array of
// {id, markdown}), renders each one alone with parse() from parse.js, and
// writes /output/html.json: a JSON array of the HTML strings, one per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const docs = JSON.parse(raw) as { id: string; markdown: string }[];
const rendered: string[] = [];
for (let i = 0; i < docs.length; i++) {
  rendered.push(parse(docs[i].markdown));
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
