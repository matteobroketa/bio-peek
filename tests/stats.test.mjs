import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintReferences, inferReferenceBuild, medianFromHistogram, estimateBarcodeKnee } from '../src/stats.js';

test('identifies GRCh38 by chr1 length', () => {
  const r = inferReferenceBuild([{ name: 'chr1', length: 248956422 }, { name: 'chrM', length: 16569 }]);
  assert.equal(r.label, 'GRCh38 / hg38');
  assert.equal(r.confidence, 'high');
});

test('computes histogram median', () => {
  const h = new Map([[90, 1], [91, 5], [100, 2]]);
  assert.equal(medianFromHistogram(h), 91);
});

test('barcode knee returns a bounded preliminary estimate', () => {
  const counts = new Map();
  for (let i = 1; i <= 1200; i++) counts.set(`bc${i}`, i < 420 ? Math.round(900 / Math.pow(i, .25)) : Math.max(1, Math.round(80 / Math.pow(i - 400, .7))));
  const knee = estimateBarcodeKnee(counts);
  assert.ok(knee);
  assert.ok(knee.estimatedCells > 20 && knee.estimatedCells < 1100);
});

test('fingerprints primary, mitochondrial and ALT/decoy reference shape', () => {
  const refs = [
    ...Array.from({ length: 22 }, (_, i) => ({ name: `chr${i + 1}`, length: i === 0 ? 248956422 : 10000000 })),
    { name: 'chrX', length: 156040895 }, { name: 'chrY', length: 57227415 }, { name: 'chrM', length: 16569 },
    { name: 'chr1_KI270706v1_random', length: 175055 }, { name: 'chrUn_random', length: 161802 },
  ];
  const fp = fingerprintReferences(refs);
  assert.equal(fp.label, 'GRCh38 / hg38');
  assert.equal(fp.primaryCount, 24);
  assert.equal(fp.mitochondrial, 'chrM');
  assert.equal(fp.altDecoyCount, 1);
  assert.equal(fp.smallUnusual.length, 1);
});
