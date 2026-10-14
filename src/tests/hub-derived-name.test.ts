import test from 'node:test';
import assert from 'node:assert/strict';

import { looksDerived } from '../commands/hub/index.js';

test('derived: the shapes the registration hook actually generates', () => {
  // Real names off the roster, every one of which told a reader nothing about its agent.
  for (const n of ['otherorg-8ad9', 'myrepo-e26d', 'otherorg-2d13', 'myrepo-ddb5', 'otherorg-a575']) {
    assert.equal(looksDerived(n), true, n);
  }
});

test('chosen: names a person picked are left alone', () => {
  // These are the names in use after the 2026-09-27 relaunch. A false positive here would nag every
  // correctly-named session on every registration, which is how a useful warning becomes noise.
  for (const n of ['main-control', 'office-cluster', 'plate-reader', 'freight-sync',
                   'projects', 'asana-tasks', 'channels-research', 'manager', 'myrepo-af']) {
    assert.equal(looksDerived(n), false, n);
  }
});

test('derived: the suffix must be exactly four hex characters at the end', () => {
  assert.equal(looksDerived('agent-abc'), false, 'three is not the shape');
  assert.equal(looksDerived('agent-abcde'), false, 'five is not the shape');
  assert.equal(looksDerived('agent-abcg'), false, 'g is not hex');
  assert.equal(looksDerived('agent-abcd-tail'), false, 'the suffix has to be at the end');
  assert.equal(looksDerived('agent-ABCD'), false, 'the hook lowercases, so uppercase was chosen');
});
