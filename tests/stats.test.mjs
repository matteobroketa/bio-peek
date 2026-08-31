import test from 'node:test';
import assert from 'node:assert/strict';
import { inferReferenceBuild, medianFromHistogram, estimateBarcodeKnee } from '../src/stats.js';

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
