import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findAgentTools, isTtsAvailable, ttsUnavailableReason, MAX_TTS_CHARACTERS, synthesize } from '../services/tts.js';

/** A stand-in binary that exists on disk, so path resolution can be exercised. */
function withFakeBinary(run: (binPath: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
    const bin = path.join(dir, 'agent-tools');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      await run(bin);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('an explicit path is used when it exists', withFakeBinary((bin) => {
  assert.equal(findAgentTools(bin), bin);
}));

test('a missing explicit path does not resolve to itself', () => {
  // Reporting a tool that is not there would produce a button that fails on
  // press, which is worse than no button.
  const missing = path.join(os.tmpdir(), 'definitely-not-here-12345', 'agent-tools');
  assert.notEqual(findAgentTools(missing), missing);
});

test('AGENT_TOOLS_BIN is honoured', withFakeBinary((bin) => {
  const previous = process.env.AGENT_TOOLS_BIN;
  process.env.AGENT_TOOLS_BIN = bin;
  try {
    assert.equal(findAgentTools(), bin);
  } finally {
    if (previous === undefined) delete process.env.AGENT_TOOLS_BIN;
    else process.env.AGENT_TOOLS_BIN = previous;
  }
}));

test('a host without the CLI reports unavailable, with a reason', () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-here-12345', 'agent-tools');
  const previousHome = process.env.HOME;
  const previousBin = process.env.AGENT_TOOLS_BIN;
  // Point HOME away from the real checkout, which would otherwise be found.
  process.env.HOME = path.join(os.tmpdir(), 'no-such-home-12345');
  delete process.env.AGENT_TOOLS_BIN;

  try {
    assert.equal(isTtsAvailable(missing), false);
    assert.match(String(ttsUnavailableReason(missing)), /agent-tools is not installed/);
  } finally {
    if (previousHome !== undefined) process.env.HOME = previousHome;
    if (previousBin !== undefined) process.env.AGENT_TOOLS_BIN = previousBin;
  }
});

test('empty text is refused before anything is launched', async () => {
  await assert.rejects(() => synthesize('   '), /Nothing to speak/);
});

test('over-long text is refused with its length', async () => {
  await assert.rejects(() => synthesize('x'.repeat(MAX_TTS_CHARACTERS + 1)), /characters; the limit/);
});
