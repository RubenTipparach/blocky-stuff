// Put a commit's bot code in place on the running machine and restart only the bot (server/launcher.mjs), leaving
// Luanti and its players alone. Run by the deploy job over Fly's SSH, as the game's user:
//   node /app/server/hotdeploy.mjs <commit sha>
// It downloads the commit from GitHub (the repository is public), refuses when the dependencies differ from this
// image's (those need a full deploy), checks that every server file parses and the app loads, then switches the
// release and signals the launcher. Exit codes: 0 done, 2 bad input, 3 needs a full deploy, 4 the code does not load.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, readlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.REPO || 'RubenTipparach/blocky-stuff';
const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || '/data';
const APP = join(DATA, 'app');
const RELEASES = join(APP, 'releases');
const KEEP = 3;
const say = (m) => console.log(`[hotdeploy] ${m}`);
const fail = (code, m) => { console.error(`[hotdeploy] ${m}`); process.exit(code); };

const sha = process.argv[2] ?? '';
if (!/^[0-9a-f]{7,40}$/.test(sha)) fail(2, 'Give the commit sha.');

mkdirSync(RELEASES, { recursive: true });
const dir = join(RELEASES, sha);
const tmp = join(RELEASES, `.${sha}.tmp`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// The commit, as GitHub serves it: one top folder holding the repository.
say(`fetching ${REPO}@${sha.slice(0, 7)}`);
const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`);
if (!res.ok) fail(2, `GitHub said ${res.status} for that commit.`);
writeFileSync(join(tmp, 'code.tgz'), Buffer.from(await res.arrayBuffer()));
execFileSync('tar', ['-xzf', join(tmp, 'code.tgz'), '-C', tmp]);
const top = readdirSync(tmp).find((f) => f !== 'code.tgz' && statSync(join(tmp, f)).isDirectory());
if (!top) fail(2, 'The download held no code.');

// The same dependencies as this image, or it needs a full deploy (npm runs at build time).
const same = (f) => readFileSync(join(tmp, top, f), 'utf8') === readFileSync(join(IMAGE_DIR, f), 'utf8');
if (!same('package.json') || !same('package-lock.json')) fail(3, 'The dependencies changed: this needs a full deploy.');

rmSync(dir, { recursive: true, force: true });
renameSync(join(tmp, top), dir);
rmSync(tmp, { recursive: true, force: true });
symlinkSync(join(IMAGE_DIR, 'node_modules'), join(dir, 'node_modules'));

// Every server file parses, and the app loads with its imports.
try {
  for (const f of readdirSync(join(dir, 'server')).filter((n) => n.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', join(dir, 'server', f)]);
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "import('./server/app.mjs').then(() => process.exit(0))"],
    { cwd: dir, timeout: 30_000 });
} catch (err) {
  rmSync(dir, { recursive: true, force: true });
  fail(4, `The new code does not load: ${String(err.stderr ?? err.message).slice(0, 400)}`);
}

// Switch: the release before becomes PREVIOUS (for a rollback), the new one CURRENT; made on top of this image.
const current = join(APP, 'current');
const previous = join(APP, 'previous');
const swap = (target, link) => { const t = `${link}.new`; rmSync(t, { force: true }); symlinkSync(target, t); renameSync(t, link); };
if (existsSync(current)) swap(readlinkSync(current), previous);
swap(dir, current);
writeFileSync(join(APP, 'current-sha'), sha);
writeFileSync(join(APP, 'base-image'), (existsSync(join(APP, 'image-sha')) ? readFileSync(join(APP, 'image-sha'), 'utf8').trim() : '') || 'unknown');

// Keep the newest few releases.
const live = new Set([readlinkSync(current), existsSync(previous) ? readlinkSync(previous) : ''].map((p) => p.split('/').pop()));
const old = readdirSync(RELEASES).filter((f) => !f.startsWith('.') && !live.has(f))
  .map((f) => ({ f, t: statSync(join(RELEASES, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP);
for (const { f } of old) rmSync(join(RELEASES, f), { recursive: true, force: true });

// Tell the launcher: it restarts the bot from the new release.
const pid = Number(readFileSync(join(DATA, 'launcher.pid'), 'utf8'));
process.kill(pid, 'SIGUSR2');
say(`live: ${sha.slice(0, 7)} (the bot restarts; the game keeps running)`);
