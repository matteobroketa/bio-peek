import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFastqBam } from '../src/consistency.js';

test('compares inferred 10x read layout and reports bounded limitations', () => {
  const bam = { sample: { assay: { label: 'Single-cell RNA sequencing', barcodeLength: 16, umiLength: 12 }, readLengthMedian: 91 } };
  const files = [
    { fileName: 'sample_R1.fastq', medianLength: 28, illumina: { read: 1, lane: 1 } },
    { fileName: 'sample_R2.fastq', medianLength: 91, illumina: { read: 2, lane: 1 } },
  ];
  const result = compareFastqBam(bam, files);
  assert.equal(result.status, 'pass');
  assert.ok(result.checks.every((check) => check.pass === true));
  assert.match(result.limitation, /independently sampled/);
});
