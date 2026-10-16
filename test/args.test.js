import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestOption } from '../src/args.js';

test('suggests the closest option for a typo', () => {
  const names = ['database', 'events-database', 'dry-run', 'json', 'help'];
  assert.equal(suggestOption('--event-database', names), '--events-database');
  assert.equal(suggestOption('--dryrun', names), '--dry-run');
  assert.equal(suggestOption('--jsn', names), '--json');
  assert.equal(suggestOption('--databse=x', names), '--database');
  assert.equal(suggestOption('--xyz', names), null);
});
