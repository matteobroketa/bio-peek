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
const seqkitRows = (text) => {
  if (!text) return [];
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => Object.fromEntries(line.split('\t').map((value, i) => [headers[i], value])));
};
const findNumber = (value, wanted) => {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.includes(normalized) && Number.isFinite(Number(child))) return Number(child);
    const nested = findNumber(child, wanted);
    if (nested != null) return nested;
  }
  return null;
};

const fastqs = result.fastq?.files?.filter((file) => !file.error) || [];
const r1 = fastqs.find((file) => /(?:^|[_-])R1(?:[_-]|\.|$)/i.test(file.fileName));
const r2 = fastqs.find((file) => /(?:^|[_-])R2(?:[_-]|\.|$)/i.test(file.fileName));
if (r1) close(r1.medianLength, expected.published.r1Length, expected.tolerances.fastqMedianLengthBp, 'R1 median length');
if (r2) close(r2.medianLength, expected.published.r2Length, expected.tolerances.fastqMedianLengthBp, 'R2 median length');
if (!r1 || !r2) failures.push('Missing R1/R2 FASTQ results');

for (const row of seqkitRows(reference.seqkit)) {
  const candidate = fastqs.find((file) => path.basename(file.fileName) === path.basename(row.file || ''));
  if (candidate && row.avg_len) close(candidate.medianLength, Number(row.avg_len), expected.tolerances.fastqMedianLengthBp, `${candidate.fileName} seqkit median/average length`);
}

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
const cellRangerCells = findNumber(reference.cellRanger, ['estimatednumberofcells', 'estimatedcells']);
if (cellRangerCells && knee) close(knee, cellRangerCells, cellRangerCells * expected.tolerances.estimatedCellsRelative, 'estimated cells versus Cell Ranger');
if (bam?.sample?.sampling?.strata) {
  const represented = new Set(bam.sample.sampledRegions || bam.sample.sampling.sampledStrata || []).size;
  const coverage = represented / bam.sample.sampling.strata;
  if (coverage < 1 - expected.tolerances.sampledRegionFraction) failures.push(`BAM sampled region coverage: ${coverage} is below ${1 - expected.tolerances.sampledRegionFraction}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('PBMC v3 golden comparison passed.');
}
