#!/usr/bin/env node
// Entry point for `npx smallcloud` / a global install. Prefers the compiled build,
// falls back to running the TypeScript sources through tsx during development.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'dist', 'cli.js');

let main;
if (existsSync(compiled)) {
  ({ main } = await import(pathToFileURL(compiled).href));
} else {
  await import('tsx/esm');
  ({ main } = await import(pathToFileURL(join(root, 'src', 'cli.ts')).href));
}

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
