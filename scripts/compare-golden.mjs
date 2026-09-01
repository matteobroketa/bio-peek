import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const resultPath = path.resolve(args.get('bio-peek-json') || 'bio-peek.json');
const referencePath = path.resolve(args.get('reference') || 'tests/golden/pbmc-v3/mini/reference-observations.json');
const [result, reference] = await Promise.all([
  readFile(resultPath, 'utf8').then(JSON.parse),
  readFile(referencePath, 'utf8').then(JSON.parse),
]);
const failures = [];
const expected = reference.expected;
const close = (actual, target, tolerance, label) => {
  if (!Number.isFinite(actual) || Math.abs(actual - target) > tolerance) failures.push(`${label}: ${actual} is outside ${target} ± ${tolerance}`);
};

const fastqs = result.fastq?.files?.filter((file) => !file.error) || [];
const r1 = fastqs.find((file) => /(?:^|[_-])R1(?:[_-]|\.|$)/i.test(file.fileName));
const r2 = fastqs.find((file) => /(?:^|[_-])R2(?:[_-]|\.|$)/i.test(file.fileName));
if (r1) close(r1.medianLength, expected.published.r1Length, expected.tolerances.fastqMedianLengthBp, 'R1 median length');
if (r2) close(r2.medianLength, expected.published.r2Length, expected.tolerances.fastqMedianLengthBp, 'R2 median length');
if (!r1 || !r2) failures.push('Missing R1/R2 FASTQ results');

const bam = result.bam?.[0];
const referenceCounts = reference.idxstats?.filter((row) => row.name !== '*') || [];
if (bam?.index?.perReference && referenceCounts.length) {
  for (const row of referenceCounts) {
    const observed = bam.index.perReference.find((candidate) => candidate.name === row.name);
    if (observed && observed.mapped != null) close(Number(observed.mapped), row.mapped, Math.max(1, row.mapped * expected.tolerances.bamMappedFraction), `${row.name} mapped count`);
  }
}
const knee = bam?.sample?.knee?.estimatedCells;
if (knee) close(knee, expected.published.cellsDetected, expected.published.cellsDetected * expected.tolerances.estimatedCellsRelative, 'estimated cell-associated knee');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('PBMC v3 golden comparison passed.');
}
