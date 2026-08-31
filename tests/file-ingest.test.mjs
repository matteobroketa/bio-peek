import test from 'node:test';
import assert from 'node:assert/strict';
import { filesFromDataTransfer, hasFileDrag, isSupportedGenomicFile } from '../src/file-ingest.js';

test('file support is intentionally narrow', () => {
  for (const name of ['sample.bam', 'sample.BAI', 'genome.fai', 'R1.fastq', 'R2.fq', 'R1.fastq.gz', 'R2.FQ.GZ']) {
    assert.equal(isSupportedGenomicFile(name), true, name);
  }
  for (const name of ['sample.bam.gz', 'sample.bai.gz', 'reads.gz', 'notes.txt', 'archive.zip']) {
    assert.equal(isSupportedGenomicFile(name), false, name);
  }
});

test('detects Firefox and standard file drag types', () => {
  assert.equal(hasFileDrag({ types: ['Files'] }), true);
  assert.equal(hasFileDrag({ types: ['application/x-moz-file'] }), true);
  assert.equal(hasFileDrag({ types: ['text/plain'] }), false);
  assert.equal(hasFileDrag(null), false);
});

test('prefers DataTransferItem files and falls back to DataTransfer.files', () => {
  const a = { name: 'a.bam' };
  const b = { name: 'b.bai' };
  assert.deepEqual(filesFromDataTransfer({
    items: [{ kind: 'file', getAsFile: () => a }, { kind: 'string', getAsFile: () => null }],
    files: [b],
  }), [a]);
  assert.deepEqual(filesFromDataTransfer({ items: [], files: [b] }), [b]);
});
