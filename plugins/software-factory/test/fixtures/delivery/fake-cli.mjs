#!/usr/bin/env node
// Fake factory CLI for checks.spawnDetached: writes its argv to <home>/spawned.json.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1];
fs.writeFileSync(path.join(home, 'spawned.json'), JSON.stringify({ args, cwd: process.cwd() }));
