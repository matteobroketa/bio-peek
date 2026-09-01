import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFastq, resolveDatasets } from '../src/dataset-resolver.js';

const file = (name) => ({ name, size: 1 });

test('classifies 10x lane and index naming conventions', () => {
  assert.deepEqual(classifyFastq('PBMC_1_S1_L002_R1_001.fastq.gz'), {
    role: 'r1', lane: '002', groupKey: 'pbmc_1', stem: 'PBMC_1_S1_L002_R1_001',
  });
  assert.equal(classifyFastq('PBMC_1_S1_L001_I2_001.fastq').role, 'i2');
  assert.equal(classifyFastq('notes.fastq').role, 'unknown');
});

test('resolves BAM/BAI, paired reads and multiple lanes independently', () => {
  const files = [
    file('PBMC_1.bam'), file('PBMC_1.bai'),
    file('PBMC_1_S1_L001_R1_001.fastq.gz'), file('PBMC_1_S1_L001_R2_001.fastq.gz'),
    file('PBMC_1_S1_L002_R1_001.fastq.gz'), file('PBMC_1_S1_L002_R2_001.fastq.gz'),
    file('PBMC_1_S1_L001_I1_001.fastq.gz'), file('unrelated.bam'), file('unrelated.bai'),
    file('other_S2_L001_R1_001.fastq.gz'),
  ];
  const result = resolveDatasets(files);
  assert.equal(result.datasets.length, 3);
  const pbmc = result.datasets.find((d) => d.label === 'PBMC_1');
  assert.ok(pbmc);
  assert.equal(pbmc.bam.name, 'PBMC_1.bam');
  assert.equal(pbmc.bai.name, 'PBMC_1.bai');
  assert.equal(pbmc.fastq.r1.length, 2);
  assert.equal(pbmc.fastq.r2.length, 2);
  assert.equal(pbmc.fastq.i1.length, 1);
  assert.match(pbmc.summary, /across 2 lanes/);
});

test('does not attach an unmatched index to an arbitrary BAM', () => {
  const result = resolveDatasets([file('a.bam'), file('b.bai')]);
  assert.equal(result.datasets[0].bai, null);
  assert.equal(result.unassigned[0].reason, 'No uniquely matching BAM');
});
