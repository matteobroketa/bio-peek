const FASTQ_SUFFIX = /\.(?:fastq|fq)(?:\.gz)?$/i;

function withoutFastqSuffix(name) {
  return String(name).replace(FASTQ_SUFFIX, '');
}

function withoutBamSuffix(name) {
  return String(name).replace(/\.bam$/i, '');
}

function cleanKey(value) {
  return String(value)
    .replace(/[\\/]/g, '/')
    .replace(/\s+/g, '_')
    .replace(/_S\d+$/i, '')
    .replace(/_+$/, '')
    .toLowerCase();
}

/**
 * Classify an Illumina-style FASTQ name without assuming that a directory
 * contains only one sample. This covers the common S/L/R/I/001 convention as
 * well as compact names such as sample_R1.fastq.gz.
 */
export function classifyFastq(name) {
  const stem = withoutFastqSuffix(name);
  const match = stem.match(/(?:^|[_-])([RI])([12])(?:[_-]\d+)?$/i);
  if (!match) {
    return { role: 'unknown', lane: null, groupKey: cleanKey(stem), stem };
  }

  const prefix = stem.slice(0, match.index).replace(/[_-]L\d{3}$/i, '');
  return {
    role: `${match[1].toLowerCase()}${match[2]}`,
    lane: (stem.match(/[_-]L(\d{3})[_-]/i) || [])[1] || null,
    groupKey: cleanKey(prefix),
    stem,
  };
}

export function datasetKeyFromBam(name) {
  return cleanKey(withoutBamSuffix(name));
}

function newDataset(key, label = key) {
  return {
    id: key || `dataset-${Math.random().toString(36).slice(2)}`,
    label: label || 'Unnamed dataset',
    bam: null,
    bai: null,
    fastq: { r1: [], r2: [], i1: [], i2: [], unknown: [] },
    files: [],
    warnings: [],
  };
}

function displayName(key) {
  return key.split(/[\\/]/).at(-1) || key || 'Unnamed dataset';
}

function addFile(dataset, file) {
  if (!dataset.files.includes(file)) dataset.files.push(file);
}

function isFastq(name) { return FASTQ_SUFFIX.test(name); }

function matchingBai(bam, bais) {
  const name = bam.name.toLowerCase();
  const base = withoutBamSuffix(bam.name).toLowerCase();
  const exact = bais.filter((f) => {
    const candidate = f.name.toLowerCase();
    return candidate === `${name}.bai` || candidate === `${base}.bai`;
  });
  return exact;
}

function summary(dataset) {
  const parts = [];
  if (dataset.bam) parts.push('BAM');
  if (dataset.bai) parts.push('BAI');
  const laneCount = new Set([...dataset.fastq.r1, ...dataset.fastq.r2, ...dataset.fastq.i1, ...dataset.fastq.i2]
    .map((f) => classifyFastq(f.name).lane).filter(Boolean)).size;
  const reads = [];
  for (const role of ['r1', 'r2', 'i1', 'i2']) if (dataset.fastq[role].length) reads.push(`${role.toUpperCase()}${dataset.fastq[role].length > 1 ? ` ×${dataset.fastq[role].length}` : ''}`);
  if (reads.length) parts.push(`${reads.join('/')} ${laneCount > 1 ? `across ${laneCount} lanes` : ''}`.trim());
  return parts.join(' + ') || 'No recognized genomic files';
}

/**
 * Resolve selected files into independent datasets. Files are joined only
 * when their normalized sample keys agree; unrelated files remain separate so
 * analysis never silently combines samples.
 */
export function resolveDatasets(files) {
  const datasets = new Map();
  const unassigned = [];
  const get = (key, label = displayName(key)) => {
    if (!datasets.has(key)) datasets.set(key, newDataset(key, label));
    return datasets.get(key);
  };

  const bams = files.filter((f) => /\.bam$/i.test(f.name));
  const bais = files.filter((f) => /\.bai$/i.test(f.name));
  const usedBais = new Set();

  for (const bam of bams) {
    const key = datasetKeyFromBam(bam.name);
    const dataset = get(key, withoutBamSuffix(bam.name));
    dataset.bam = bam;
    addFile(dataset, bam);
    const candidates = matchingBai(bam, bais);
    if (candidates.length) {
      dataset.bai = candidates[0];
      usedBais.add(candidates[0]);
      addFile(dataset, candidates[0]);
      if (candidates.length > 1) dataset.warnings.push(`Multiple BAI candidates matched; using ${candidates[0].name}.`);
    }
  }

  for (const bai of bais) {
    if (!usedBais.has(bai)) unassigned.push({ file: bai, reason: 'No uniquely matching BAM' });
  }

  const fastqGroups = new Map();
  for (const file of files.filter((f) => isFastq(f.name))) {
    const info = classifyFastq(file.name);
    if (!fastqGroups.has(info.groupKey)) fastqGroups.set(info.groupKey, []);
    fastqGroups.get(info.groupKey).push({ file, info });
  }

  for (const [key, group] of fastqGroups) {
    const dataset = get(key, displayName(key));
    for (const { file, info } of group) {
      const role = dataset.fastq[info.role] ? info.role : 'unknown';
      dataset.fastq[role].push(file);
      addFile(dataset, file);
    }
    for (const role of ['r1', 'r2']) {
      if (dataset.fastq[role].length > 1) dataset.fastq[role].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    if (dataset.fastq.unknown.length) dataset.warnings.push('Some FASTQ files have no recognizable R1/R2/I1/I2 suffix.');
  }

  const output = [...datasets.values()];
  for (const dataset of output) dataset.summary = summary(dataset);
  return { datasets: output, unassigned };
}

export function datasetFiles(dataset) {
  return [dataset.bam, dataset.bai, ...Object.values(dataset.fastq).flat()].filter(Boolean);
}
