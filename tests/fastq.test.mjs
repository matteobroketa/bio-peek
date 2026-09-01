import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleFastq } from '../src/fastq.js';

test('samples uncompressed FASTQ from byte ranges and reports integrity', async () => {
  const records = Array.from({ length: 12 }, (_, i) => `@instrument:1:flow:1:1101:1:${i} ${i % 2 ? 2 : 1}:N:0:ACGT\nACGTACGT\n+\nIIIIIIII\n`).join('');
  const result = await sampleFastq(new File([records], 'reads.fastq'), { targetReads: 8 });
  assert.equal(result.reads, 8);
  assert.equal(result.sampling.strategy, 'uncompressed full file');
  assert.equal(result.integrity.invalidQuality, 0);
  assert.equal(result.integrity.qualityEncoding.startsWith('Phred+33'), true);
  assert.equal(result.integrity.readNumberConsistent, false);
});

test('counts malformed FASTQ records instead of silently treating them as valid', async () => {
  const text = '@ok\nACGT\n+\nIIII\n@bad\nACGT\n+\nIII\n';
  const result = await sampleFastq(new File([text], 'malformed.fastq'), { targetReads: 10 });
  assert.equal(result.reads, 1);
  assert.equal(result.integrity.malformedRecords, 1);
});
