import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPiHooks, createRuntime, VERSION } from '../runtime.js';

test('createPiHooks syncs debounced activity', async () => {
  const homes = new Set();
  const sync = (directory) => (homes.add(directory), Promise.resolve());
  const errors = [];

  const hooks = createPiHooks(() => '/tmp/project', { sync, install: () => Promise.resolve(), log: (e) => errors.push(e) }, 10);

  hooks.onActivity();
  assert.equal(homes.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(homes.has('/tmp/project'), true);
  assert.equal(errors.length, 0);
});

test('createPiHooks retries after failure', async () => {
  let failures = 1;
  const syncs = [];
  const sync = () => {
    syncs.push(1);
    if (failures) {
      failures -= 1;
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve();
  };

  const hooks = createPiHooks(() => '/tmp/project', { sync, install: () => Promise.resolve(), log: () => {} }, 5);

  hooks.onActivity();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(syncs.length, 1);
  assert.equal(hooks.pending, true, 'dirty after failure');

  hooks.onSettled();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(syncs.length, 2);
  assert.equal(hooks.pending, false);
});

test('dispose flushes remaining activity', async () => {
  const syncs = [];
  const hooks = createPiHooks(() => '/tmp/project', { sync: () => (syncs.push(1), Promise.resolve()), install: () => Promise.resolve(), log: () => {} }, 60000);

  hooks.onActivity();
  assert.equal(syncs.length, 0);
  await hooks.dispose();
  assert.equal(syncs.length, 1);
});

function dummyWorker() {
  return { sync: () => Promise.resolve(), install: () => Promise.resolve(), log: () => {} };
}

test('isFileTool recognizes write tools', () => {
  const hooks = createPiHooks(() => undefined, dummyWorker(), 5);
  assert.equal(hooks.isFileTool('edit'), true);
  assert.equal(hooks.isFileTool('write_file'), true);
  assert.equal(hooks.isFileTool('bash'), false);
});

test('createRuntime builds the sync-ai-activity command and serializes runs', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'pi-wakatime-'));
  const previous = process.env.WAKATIME_HOME;
  process.env.WAKATIME_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.WAKATIME_HOME;
    else process.env.WAKATIME_HOME = previous;
  });

  const fake = path.join(home, 'fake-cli');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const calls = [];
  const deps = {
    ensureWakatimeCli: async () => fake,
    getChildEnv: () => process.env,
    execFile: async (cli, args) => (calls.push({ cli, args }), { stdout: 'called', stderr: '' }),
    logException: () => {},
  };

  const runtime = createRuntime(deps, 'pi');
  await Promise.all([runtime.sync('/a'), runtime.sync('/b')]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], '--sync-ai-activity');
  assert.ok(calls[0].args.find((value) => value.startsWith('pi/')));
  assert.ok(calls[0].args.includes('--plugin'));
});
