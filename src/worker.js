import { parseBai, summarizeBai } from './bai.js';
import { readBamHeader, checkBamEof, sampleBam, validateBamIndex } from './bam.js';
import { sampleFastq, inferFastqPair } from './fastq.js';
import { parseFai, summarizeFai } from './fai.js';
import { datasetFiles, resolveDatasets } from './dataset-resolver.js';

function post(type, payload = {}) { self.postMessage({ type, ...payload }); }
let activeController = null;

async function analyzeBam(bam, baiFile, mode, datasetLabel, { signal, onBytes, totalBytes } = {}) {
  post('progress', { stage: 'bam-header', message: `Reading ${bam.name} header…` });
  const [header, eof] = await Promise.all([readBamHeader(bam, { signal, onBytes }), checkBamEof(bam, { signal, onBytes })]);
  const result = {
    kind: 'bam', name: bam.name, size: bam.size, eof,
    datasetLabel,
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

  let bai;
  try {
    post('progress', { stage: 'bai', message: `Parsing and validating ${baiFile.name}…` });
    bai = parseBai(await baiFile.arrayBuffer());
    const validation = await validateBamIndex(bam, bai, header, { signal, onBytes });
    const summary = summarizeBai(bai, header.references.map((r) => r.name));
    result.index = {
      name: baiFile.name,
      size: baiFile.size,
      hasMetadataCounts: bai.hasMetadataCounts,
      validation,
      noCoordinate: summary.unplacedUnmapped,
      mapped: summary.mapped,
      placedUnmapped: summary.placedUnmapped,
      totalUnmapped: summary.totalUnmapped,
      perReference: summary.perReference.map((r, i) => ({ ...r, length: header.references[i]?.length ?? null })),
    };
    if (!bai.hasMetadataCounts) result.warnings.push('This BAI does not contain optional metadata pseudo-bins, so exact idxstats-style mapped counts are unavailable.');
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    result.warnings.push(`BAI rejected during compatibility/integrity validation: ${err.message}`);
    return result;
  }

  const targetRecords = mode === 'deep' ? 150_000 : 40_000;
  const samplePoints = mode === 'deep' ? 48 : 24;
  post('progress', { stage: 'bam-sample', message: `Sampling ${bam.name} across indexed seek points…`, current: 0, total: samplePoints });
  try {
    result.sample = await sampleBam(bam, bai, header, {
      targetRecords,
      samplePoints,
      progressive: mode === 'deep',
      signal,
      onProgress: (p) => post('progress', {
        stage: 'bam-sample',
        message: `Sampled ${p.records.toLocaleString()} BAM records…`,
        current: p.completed,
        total: p.total,
        bytesRead,
        stable: p.stable,
        totalBytes: filesTotalBytes,
      }),
    });
    result.sample.strategy = result.sample.sampling?.strategy || 'reference- and index-region-stratified BAI sample';
  } catch (err) {
    result.warnings.push(`BAM sampling failed: ${err.message}`);
  }
  return result;
}

async function analyzeFastqs(files, mode, datasetLabel, { signal, onBytes, totalBytes } = {}) {
  const results = [];
  const targetReads = mode === 'deep' ? 200_000 : 50_000;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    post('progress', { stage: 'fastq', message: `Sampling ${file.name}…`, current: i, total: files.length });
    try {
      const r = await sampleFastq(file, {
        targetReads,
        signal,
        onBytes,
        onProgress: (p) => post('progress', {
          stage: 'fastq', message: `${file.name}: ${p.reads.toLocaleString()} reads sampled…`, current: p.reads, total: targetReads, bytesRead, totalBytes: filesTotalBytes,
        }),
      });
      r.size = file.size;
      r.datasetLabel = datasetLabel;
      results.push(r);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
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
  if (event.data?.type === 'cancel') {
    activeController?.abort();
    return;
  }
  if (event.data?.type !== 'analyze') return;
  activeController?.abort();
  activeController = new AbortController();
  const { signal } = activeController;
  const { files, mode = 'quick' } = event.data;
  const filesTotalBytes = [...files].reduce((sum, file) => sum + (file.size || 0), 0);
  let bytesRead = 0;
  const onBytes = (n) => { bytesRead += n; };
  try {
    const all = [...files];
    const resolved = resolveDatasets(all);
    const fais = all.filter((f) => /\.fai$/i.test(f.name));
    const output = { mode, bam: [], fastq: null, fai: [], datasets: [], unassigned: resolved.unassigned.map(({ file, reason }) => ({ name: file.name, size: file.size, reason })), files: all.map((f) => ({ name: f.name, size: f.size })) };

    for (const dataset of resolved.datasets) {
      const datasetResult = { id: dataset.id, label: dataset.label, summary: dataset.summary, files: datasetFiles(dataset).map((f) => ({ name: f.name, size: f.size })), warnings: [...dataset.warnings], bam: [], fastq: null };
      if (dataset.bam) {
        const bamResult = await analyzeBam(dataset.bam, dataset.bai, mode, dataset.label, { signal, onBytes, totalBytes: filesTotalBytes });
        datasetResult.bam.push(bamResult);
        output.bam.push(bamResult);
      }
      const fastqFiles = Object.values(dataset.fastq).flat();
      if (fastqFiles.length) {
        datasetResult.fastq = await analyzeFastqs(fastqFiles, mode, dataset.label, { signal, onBytes, totalBytes: filesTotalBytes });
        output.fastq = output.fastq || { files: [], pairInference: null };
        output.fastq.files.push(...datasetResult.fastq.files);
        if (datasetResult.fastq.pairInference) output.fastq.pairInference = datasetResult.fastq.pairInference;
      }
      output.datasets.push(datasetResult);
    }
    for (const fai of fais) output.fai.push(await analyzeFai(fai));

    post('done', { result: output, bytesRead });
  } catch (err) {
    if (err?.name === 'AbortError') post('cancelled', { bytesRead });
    else post('error', { message: err?.message || String(err), stack: err?.stack || '', bytesRead });
  } finally {
    activeController = null;
  }
};
