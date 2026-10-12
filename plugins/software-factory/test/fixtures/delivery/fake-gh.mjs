#!/usr/bin/env node
// Fake gh for tests. Logs argv to FAKE_GH_LOG (one JSON line per call) and answers a few commands.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
const mode = process.env.FAKE_GH_MODE || 'ok';
const cmd = args.slice(0, 2).join(' ');

if (cmd === 'auth status') {
  if (mode === 'noauth') {
    process.stderr.write('You are not logged into any GitHub hosts. To log in, run: gh auth login\n');
    process.exit(1);
  }
  process.stderr.write('github.com\n  ✓ Logged in to github.com account factory-bot (keyring)\n');
  process.exit(0);
}
if (cmd === 'pr create') {
  if (mode === 'exists') {
    process.stderr.write('a pull request for branch "factory/E-0001-x" into branch "main" already exists:\nhttps://github.com/o/r/pull/7\n');
    process.exit(1);
  }
  if (mode === 'fail') {
    process.stderr.write('GraphQL: something broke\n');
    process.exit(1);
  }
  const bodyFile = args[args.indexOf('--body-file') + 1];
  if (!fs.existsSync(bodyFile)) {
    process.stderr.write('body file missing\n');
    process.exit(1);
  }
  process.stdout.write('https://github.com/o/r/pull/42\r\n');
  process.exit(0);
}
if (cmd === 'pr view') {
  process.stdout.write(JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-12T10:00:00Z', reviewDecision: 'APPROVED', mergeable: 'UNKNOWN', headRefOid: 'abc123' }) + '\r\n');
  process.exit(0);
}
process.stderr.write(`fake gh: unknown command ${args.join(' ')}\n`);
process.exit(2);
