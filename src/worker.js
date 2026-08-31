import { parseBai, summarizeBai } from './bai.js';
import { readBamHeader, checkBamEof, sampleBam } from './bam.js';
import { sampleFastq, inferFastqPair } from './fastq.js';
import { parseFai, summarizeFai } from './fai.js';

function post(type, payload = {}) { self.postMessage({ type, ...payload }); }
function isFastq(name) { return /\.(?:fastq|fq)(?:\.gz)?$/i.test(name); }
function baseBam(name) { return name.replace(/\.bam$/i, ''); }
function findBai(bam, files) {
  const candidates = [`${bam.name}.bai`, `${baseBam(bam.name)}.bai`].map((x) => x.toLowerCase());
  return files.find((f) => candidates.includes(f.name.toLowerCase())) || null;
}

async function analyzeBam(bam, baiFile, mode) {
  post('progress', { stage: 'bam-header', message: `Reading ${bam.name} header…` });
  const [header, eof] = await Promise.all([readBamHeader(bam), checkBamEof(bam)]);
  const result = {
    kind: 'bam', name: bam.name, size: bam.size, eof,
    header: {
      text: header.headerText,
      fields: header.fields,
      references: header.references,
      referenceBuild: header.referenceBuild,
      compressedHeaderBytes: header.compressedHeaderBytes,
      bgzfBlocksRead: header.bgzfBlocksRead,
    },
    index: null,
    sample: null,
    warnings: [],
  };

  if (!baiFile) {
    result.warnings.push('No matching BAI index was supplied; exact count metrics and distributed sampling are unavailable.');
    return result;
  }

  post('progress', { stage: 'bai', message: `Parsing ${baiFile.name}…` });
  const bai = parseBai(await baiFile.arrayBuffer());
  const summary = summarizeBai(bai, header.references.map((r) => r.name));
  result.index = {
    name: baiFile.name,
    size: baiFile.size,
    hasMetadataCounts: bai.hasMetadataCounts,
    noCoordinate: summary.unplacedUnmapped,
    mapped: summary.mapped,
    placedUnmapped: summary.placedUnmapped,
    totalUnmapped: summary.totalUnmapped,
    perReference: summary.perReference.map((r, i) => ({ ...r, length: header.references[i]?.length ?? null })),
  };
  if (!bai.hasMetadataCounts) result.warnings.push('This BAI does not contain optional metadata pseudo-bins, so exact idxstats-style mapped counts are unavailable.');

  const targetRecords = mode === 'deep' ? 150_000 : 40_000;
  const samplePoints = mode === 'deep' ? 48 : 24;
  post('progress', { stage: 'bam-sample', message: `Sampling ${bam.name} across indexed seek points…`, current: 0, total: samplePoints });
  try {
    result.sample = await sampleBam(bam, bai, header, {
      targetRecords,
      samplePoints,
      onProgress: (p) => post('progress', {
        stage: 'bam-sample',
        message: `Sampled ${p.records.toLocaleString()} BAM records…`,
        current: p.completed,
        total: p.total,
      }),
    });
    result.sample.strategy = 'distributed BAI seek-point sample';
  } catch (err) {
    result.warnings.push(`BAM sampling failed: ${err.message}`);
  }
  return result;
}

async function analyzeFastqs(files, mode) {
  const results = [];
  const targetReads = mode === 'deep' ? 200_000 : 50_000;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    post('progress', { stage: 'fastq', message: `Sampling ${file.name}…`, current: i, total: files.length });
    try {
      const r = await sampleFastq(file, {
        targetReads,
        onProgress: (p) => post('progress', {
          stage: 'fastq', message: `${file.name}: ${p.reads.toLocaleString()} reads sampled…`, current: p.reads, total: targetReads,
        }),
      });
      r.size = file.size;
      results.push(r);
    } catch (err) {
      results.push({ fileName: file.name, size: file.size, error: err.message });
    }
  }
  const usable = results.filter((r) => !r.error);
  return { files: results, pairInference: inferFastqPair(usable) };
}

async function analyzeFai(file) {
  const text = await file.text();
  const records = parseFai(text);
  return { kind: 'fai', name: file.name, size: file.size, summary: summarizeFai(records), records };
}

self.onmessage = async (event) => {
  if (event.data?.type !== 'analyze') return;
  const { files, mode = 'quick' } = event.data;
  try {
    const all = [...files];
    const bams = all.filter((f) => /\.bam$/i.test(f.name));
    const fastqs = all.filter((f) => isFastq(f.name));
    const fais = all.filter((f) => /\.fai$/i.test(f.name));
    const output = { mode, bam: [], fastq: null, fai: [], files: all.map((f) => ({ name: f.name, size: f.size })) };

    for (const bam of bams) output.bam.push(await analyzeBam(bam, findBai(bam, all), mode));
    if (fastqs.length) output.fastq = await analyzeFastqs(fastqs, mode);
    for (const fai of fais) output.fai.push(await analyzeFai(fai));

    post('done', { result: output });
  } catch (err) {
    post('error', { message: err?.message || String(err), stack: err?.stack || '' });
  }
};
