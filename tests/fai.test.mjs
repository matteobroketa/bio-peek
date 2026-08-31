import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFai, summarizeFai } from '../src/fai.js';

test('parses FAI and calculates N50/L50', () => {
  const records = parseFai('a\t100\t0\t50\t51\nb\t80\t102\t50\t51\nc\t20\t184\t20\t21\n');
  const s = summarizeFai(records);
  assert.equal(s.contigs, 3);
  assert.equal(s.totalLength, 200);
  assert.equal(s.n50, 100);
  assert.equal(s.l50, 1);
});
