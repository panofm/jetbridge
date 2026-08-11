#!/usr/bin/env node
/**
 * jetbridge was extracted from a private codebase. Its identifiers — an Apple
 * team id, a production API host, bucket variable names — must never reappear
 * in a package that gets published, including in comments, tests, fixtures and
 * HTML templates.
 *
 * This runs in CI. It is cheap, and the failure it prevents is not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.json',
  '.html',
  '.md',
  '.yml',
  '.yaml',
  '.plist',
]);

/** Each pattern is a private identifier, with why it must not appear. */
const FORBIDDEN = [
  { pattern: /\bpano\b/i, why: 'the originating project name' },
  { pattern: /\b87U6RBMJ4D\b/, why: 'a real Apple developer team id' },
  { pattern: /\bapi\.pano\.fm\b/i, why: 'a real production API host' },
  { pattern: /\binstall\.pano\.fm\b/i, why: 'a real deployment host' },
  { pattern: /\bfm\.pano\.app\b/i, why: 'a real bundle id' },
  { pattern: /\bOTA_DIST_[A-Z_]*\b/, why: 'private infrastructure variable names' },
  { pattern: /\bPANO_[A-Z_]+\b/, why: 'private build-setting names' },
];

/** This file necessarily contains the patterns it looks for. */
const ALLOWED_FILES = new Set(['scripts/check-no-private-identifiers.mjs']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const findings = [];
for (const path of walk(ROOT)) {
  const relativePath = relative(ROOT, path);
  if (ALLOWED_FILES.has(relativePath)) continue;
  if (!SCANNED_EXTENSIONS.has(extname(path))) continue;

  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(line)) {
        findings.push({
          file: relativePath,
          line: index + 1,
          text: line.trim().slice(0, 120),
          why,
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`Found ${findings.length} private identifier(s) that must not ship:\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  (${finding.why})`);
    console.error(`    ${finding.text}\n`);
  }
  console.error('Replace them with neutral examples (acme, io.acme.app.dev, builds.example.com).');
  process.exit(1);
}

console.log('No private identifiers found.');
