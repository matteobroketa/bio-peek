import { readOneBgzfBlock, readBgzfWindow, concatUint8 } from './bgzf.js';
import { collectStratifiedSamplingOffsets, collectSamplingOffsets, validateBaiAgainstBam, virtualOffsetParts } from './bai.js';
import { estimateBarcodeKnee, fingerprintReferences, inferReferenceBuild, medianFromHistogram, topEntries } from './stats.js';

const td = new TextDecoder();
const BAM_MAGIC = [66, 65, 77, 1];
const BAM_EOF = new Uint8Array([
  0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43,
  0x02, 0x00, 0x1b, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const MAX_UNIQUE_KEYS = 250_000;
const MAX_BARCODES = 50_000;
const MAX_BARCODE_SET_SIZE = 512;
const MAX_GENE_KEYS = 100_000;

function i32(view, o) { return view.getInt32(o, true); }
function u32(view, o) { return view.getUint32(o, true); }

function parseHeaderLines(text) {
  const parsed = { HD: {}, SQ: [], RG: [], PG: [], CO: [] };
  for (const line of text.split(/\n/)) {
    if (!line.startsWith('@')) continue;
    const fields = line.replace(/\r$/, '').split('\t');
    const type = fields[0].slice(1);
    const obj = {};
    for (const f of fields.slice(1)) {
      const j = f.indexOf(':');
      if (j > 0) obj[f.slice(0, j)] = f.slice(j + 1);
    }
    if (type === 'HD') parsed.HD = obj;
    else if (type === 'SQ') parsed.SQ.push(obj);
    else if (type === 'RG') parsed.RG.push(obj);
    else if (type === 'PG') parsed.PG.push(obj);
    else if (type === 'CO') parsed.CO.push(fields.slice(1).join('\t'));
  }
  return parsed;
}

function tryParseBamHeader(bytes) {
  if (bytes.length < 12) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== BAM_MAGIC[i]) throw new Error('Not a BAM file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lText = i32(view, 4);
  if (lText < 0 || lText > 64 * 1024 * 1024) throw new Error('Invalid BAM header length');
  if (bytes.length < 8 + lText + 4) return null;
  const headerText = td.decode(bytes.subarray(8, 8 + lText));
  let p = 8 + lText;
  const nRef = i32(view, p);
  p += 4;
  if (nRef < 0 || nRef > 1_000_000) throw new Error('Invalid BAM reference count');
  const references = [];
  for (let r = 0; r < nRef; r++) {
    if (p + 4 > bytes.length) return null;
    const lName = i32(view, p);
    p += 4;
    if (lName <= 0 || lName > 1_000_000) throw new Error('Invalid BAM reference name length');
    if (p + lName + 4 > bytes.length) return null;
    if (bytes[p + lName - 1] !== 0) throw new Error(`BAM reference name ${r} is not NUL terminated`);
    const name = td.decode(bytes.subarray(p, p + lName - 1));
    p += lName;
    const length = i32(view, p);
    p += 4;
    if (!name || length <= 0) throw new Error(`Invalid BAM reference ${r}`);
    if (references.some((ref) => ref.name === name)) throw new Error(`Duplicate BAM reference name ${name}`);
    references.push({ name, length });
  }
  const fields = parseHeaderLines(headerText);
  return { headerText, fields, references, uncompressedHeaderBytes: p };
}

export async function readBamHeader(file, { signal, onBytes = () => {} } = {}) {
  const parts = [];
  let compressedOffset = 0;
  let total = 0;
  for (let i = 0; i < 256 && compressedOffset < file.size; i++) {
    const block = await readOneBgzfBlock(file, compressedOffset, { signal, onBytes });
    if (!block) break;
    parts.push(block.data);
    total += block.data.length;
    const combined = concatUint8(parts);
    const parsed = tryParseBamHeader(combined);
    if (parsed) {
      return {
        ...parsed,
        compressedHeaderBytes: compressedOffset + block.blockSize,
        bgzfBlocksRead: i + 1,
        referenceBuild: inferReferenceBuild(parsed.references),
        referenceFingerprint: fingerprintReferences(parsed.references),
      };
    }
    compressedOffset += block.blockSize;
    if (total > 64 * 1024 * 1024) throw new Error('BAM header exceeds safety limit');
  }
  throw new Error('Could not read a complete BAM header');
}

export async function checkBamEof(file, { signal, onBytes = () => {} } = {}) {
  if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  if (file.size < BAM_EOF.length) return false;
  const tail = new Uint8Array(await file.slice(file.size - BAM_EOF.length).arrayBuffer());
  onBytes(BAM_EOF.length);
  return BAM_EOF.every((v, i) => tail[i] === v);
}

function skipAuxValue(view, bytes, p, end, type) {
  const fixed = { A: 1, c: 1, C: 1, s: 2, S: 2, i: 4, I: 4, f: 4, d: 8 }[type];
  if (fixed) return p + fixed;
  if (type === 'Z' || type === 'H') {
    while (p < end && bytes[p] !== 0) p++;
    return p + 1;
  }
  if (type === 'B') {
    if (p + 5 > end) return end + 1;
    const subtype = String.fromCharCode(bytes[p]);
    const count = view.getInt32(p + 1, true);
    const size = { c: 1, C: 1, s: 2, S: 2, i: 4, I: 4, f: 4 }[subtype];
    if (!size || count < 0) return end + 1;
    return p + 5 + count * size;
  }
  return end + 1;
}

function readAuxValue(view, bytes, p, end, type) {
  if (type === 'A') return { value: String.fromCharCode(bytes[p]), next: p + 1 };
  if (type === 'c') return { value: view.getInt8(p), next: p + 1 };
  if (type === 'C') return { value: view.getUint8(p), next: p + 1 };
  if (type === 's') return { value: view.getInt16(p, true), next: p + 2 };
  if (type === 'S') return { value: view.getUint16(p, true), next: p + 2 };
  if (type === 'i') return { value: view.getInt32(p, true), next: p + 4 };
  if (type === 'I') return { value: view.getUint32(p, true), next: p + 4 };
  if (type === 'f') return { value: view.getFloat32(p, true), next: p + 4 };
  if (type === 'd') return { value: view.getFloat64(p, true), next: p + 8 };
  if (type === 'Z' || type === 'H') {
    let q = p;
    while (q < end && bytes[q] !== 0) q++;
    return { value: td.decode(bytes.subarray(p, q)), next: q + 1 };
  }
  return { value: null, next: skipAuxValue(view, bytes, p, end, type) };
}

function parseWantedAux(view, bytes, p, end) {
  const wanted = new Set(['CB', 'CR', 'UB', 'UR', 'GX', 'GN', 'RE', 'RG', 'MM', 'mm', 'NH', 'xf']);
  const out = {};
  while (p + 3 <= end) {
    const tag = String.fromCharCode(bytes[p], bytes[p + 1]);
    const type = String.fromCharCode(bytes[p + 2]);
    p += 3;
    if (wanted.has(tag)) {
      const read = readAuxValue(view, bytes, p, end, type);
      if (read.next > end) break;
      out[tag] = read.value;
      p = read.next;
    } else {
      p = skipAuxValue(view, bytes, p, end, type);
      if (p > end) break;
    }
  }
  return out;
}

function validateAuxFields(view, bytes, p, end) {
  const validTypes = new Set(['A', 'c', 'C', 's', 'S', 'i', 'I', 'f', 'd', 'Z', 'H', 'B']);
  while (p < end) {
    if (p + 3 > end) throw new Error('truncated auxiliary tag header');
    const tag1 = bytes[p], tag2 = bytes[p + 1];
    const type = String.fromCharCode(bytes[p + 2]);
    if (tag1 < 33 || tag2 < 33 || !validTypes.has(type)) throw new Error('invalid auxiliary tag');
    p += 3;
    const next = skipAuxValue(view, bytes, p, end, type);
    if (next > end) throw new Error(`truncated auxiliary value for ${String.fromCharCode(tag1, tag2)}`);
    if (type === 'B') {
      const subtype = String.fromCharCode(bytes[p]);
      if (!'cCsSiIf'.includes(subtype)) throw new Error(`invalid B-array subtype ${subtype}`);
    }
    p = next;
  }
}

function createAccumulator() {
  return {
    records: 0,
    uniqueKeys: new Set(),
    deduplicationCapped: false,
    mapq: Array(256).fill(0),
    readLengths: new Map(),
    flags: { mapped: 0, unmapped: 0, paired: 0, properPair: 0, duplicate: 0, secondary: 0, supplementary: 0 },
    spliced: 0,
    tags: new Map(),
    regions: new Map(),
    barcodes: new Map(),
    uniqueUmis: new Set(),
    genes: new Map(),
    geneIds: new Set(),
    readGroups: new Map(),
    multimappedTag: 0,
    sampleByReference: new Map(),
    sampledRegions: new Set(),
    alignmentClasses: { primary: 0, secondary: 0, supplementary: 0, unmapped: 0 },
    barcodeSketches: new Map(),
    barcodeMapCapped: false,
    geneMapCapped: false,
  };
}

function bump(map, key, n = 1, maxKeys = Infinity) {
  if (!map.has(key) && map.size >= maxKeys) return false;
  map.set(key, (map.get(key) || 0) + n);
  return true;
}

function consumeRecord(acc, rec) {
  const key = `${rec.refId}:${rec.pos}:${rec.readName}:${rec.flag}`;
  if (!acc.deduplicationCapped) {
    if (acc.uniqueKeys.has(key)) return false;
    if (acc.uniqueKeys.size < MAX_UNIQUE_KEYS) acc.uniqueKeys.add(key);
    else acc.deduplicationCapped = true;
  }
  acc.records++;
  acc.mapq[rec.mapq]++;
  bump(acc.readLengths, rec.lSeq);
  if (rec.flag & 0x4) acc.flags.unmapped++; else acc.flags.mapped++;
  if (rec.flag & 0x1) acc.flags.paired++;
  if (rec.flag & 0x2) acc.flags.properPair++;
  if (rec.flag & 0x400) acc.flags.duplicate++;
  if (rec.flag & 0x100) acc.flags.secondary++;
  if (rec.flag & 0x800) acc.flags.supplementary++;
  if (rec.spliced) acc.spliced++;
  if (rec.refId >= 0) bump(acc.sampleByReference, rec.refId);
  if (rec.region) acc.sampledRegions.add(rec.region);
  if (rec.flag & 0x4) acc.alignmentClasses.unmapped++;
  else if (rec.flag & 0x100) acc.alignmentClasses.secondary++;
  else if (rec.flag & 0x800) acc.alignmentClasses.supplementary++;
  else acc.alignmentClasses.primary++;

  for (const tag of Object.keys(rec.aux)) bump(acc.tags, tag);
  if (rec.aux.RE != null) bump(acc.regions, String(rec.aux.RE));
  if (rec.aux.CB) {
    const barcode = String(rec.aux.CB);
    if (!bump(acc.barcodes, barcode, 1, MAX_BARCODES)) acc.barcodeMapCapped = true;
    let sketch = acc.barcodeSketches.get(barcode);
    if (!sketch && acc.barcodeSketches.size < MAX_BARCODES) {
      sketch = { reads: 0, umis: new Set(), genes: new Set(), mitochondrial: 0 };
      acc.barcodeSketches.set(barcode, sketch);
    }
    if (sketch) {
      sketch.reads++;
      if (rec.aux.UB && sketch.umis.size < MAX_BARCODE_SET_SIZE) sketch.umis.add(String(rec.aux.UB));
      const gene = rec.aux.GX || rec.aux.GN;
      if (gene && sketch.genes.size < MAX_BARCODE_SET_SIZE) sketch.genes.add(String(gene).split(';')[0]);
      if (rec.refName && /^(?:chrM|MT|M)$/i.test(rec.refName)) sketch.mitochondrial++;
    }
  }
  if (rec.aux.RG) bump(acc.readGroups, String(rec.aux.RG));
  if (rec.aux.MM === 1 || rec.aux.mm === 1 || Number(rec.aux.NH) > 1) acc.multimappedTag++;

  const geneToken = rec.aux.GN || rec.aux.GX;
  if (geneToken) {
    for (const gene of String(geneToken).split(';').filter(Boolean).slice(0, 8)) {
      if (!bump(acc.genes, gene, 1, MAX_GENE_KEYS)) acc.geneMapCapped = true;
      if (acc.geneIds.size < MAX_GENE_KEYS) acc.geneIds.add(gene);
    }
  }
  if (rec.aux.CB && rec.aux.UB) {
    const gene = rec.aux.GX || rec.aux.GN || '';
    if (acc.uniqueUmis.size < 500_000) acc.uniqueUmis.add(`${rec.aux.CB}|${rec.aux.UB}|${gene}`);
  }
  return true;
}

function parseRecords(bytes, start, maxRecords, acc, { strict = false, referenceCount = null, referenceNames = null, region = null } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start;
  let parsed = 0;
  while (p + 4 <= bytes.length && parsed < maxRecords) {
    const blockSize = i32(view, p);
    if (blockSize < 32 || blockSize > 16 * 1024 * 1024 || p + 4 + blockSize > bytes.length) {
      if (strict) throw new Error(`invalid or truncated BAM record block at byte ${p}`);
      break;
    }
    const core = p + 4;
    const end = core + blockSize;
    const refId = i32(view, core);
    const pos = i32(view, core + 4);
    const binMqNl = u32(view, core + 8);
    const flagNc = u32(view, core + 12);
    const lSeq = i32(view, core + 16);
    const lReadName = binMqNl & 0xff;
    const mapq = (binMqNl >>> 8) & 0xff;
    const nCigar = flagNc & 0xffff;
    const flag = flagNc >>> 16;
    if (lReadName < 1 || lSeq < 0 || lReadName > blockSize || lSeq > 1_000_000) {
      if (strict) throw new Error(`invalid BAM record lengths at byte ${p}`);
      break;
    }

    const readNameStart = core + 32;
    const cigarStart = readNameStart + lReadName;
    const seqStart = cigarStart + nCigar * 4;
    const qualStart = seqStart + Math.ceil(lSeq / 2);
    const auxStart = qualStart + lSeq;
    if (auxStart > end) {
      if (strict) throw new Error(`BAM record payload exceeds block at byte ${p}`);
      break;
    }

    if (strict) {
      if (bytes[readNameStart + lReadName - 1] !== 0) throw new Error(`BAM read name is not NUL terminated at byte ${p}`);
      let queryLength = 0;
      let referenceLength = 0;
      for (let c = 0; c < nCigar; c++) {
        const cigar = u32(view, cigarStart + c * 4);
        const length = cigar >>> 4;
        const op = cigar & 0xf;
        if (!length || op > 8) throw new Error(`invalid BAM CIGAR operation at byte ${p}`);
        if ([0, 1, 4, 7, 8].includes(op)) queryLength += length;
        if ([0, 2, 3, 7, 8].includes(op)) referenceLength += length;
      }
      if (nCigar && queryLength !== lSeq) throw new Error(`BAM CIGAR query length ${queryLength} does not match sequence length ${lSeq}`);
      if (refId < -1 || refId >= 1_000_000 || (referenceCount != null && refId >= referenceCount) || pos < -1) throw new Error(`invalid BAM reference/position at byte ${p}`);
      validateAuxFields(view, bytes, auxStart, end);
    }

    const readName = td.decode(bytes.subarray(readNameStart, readNameStart + Math.max(0, lReadName - 1)));
    let spliced = false;
    for (let c = 0; c < nCigar; c++) {
      const op = u32(view, cigarStart + c * 4) & 0xf;
      if (op === 3) { spliced = true; break; }
    }
    const aux = parseWantedAux(view, bytes, auxStart, end);
    consumeRecord(acc, { refId, refName: referenceNames?.[refId]?.name, pos, readName, mapq, flag, lSeq, spliced, aux, region });
    parsed++;
    p = end;
  }
  return parsed;
}

function medianArray(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = (sorted.length - 1) / 2;
  return sorted[Math.floor(middle)] * (1 - (middle % 1)) + sorted[Math.ceil(middle)] * (middle % 1);
}

function percentileArray(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, p * (sorted.length - 1)));
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function proportionEstimate(count, total) {
  const n = Number(total);
  const p = n ? Number(count) / n : null;
  if (p == null) return { estimate: null, margin: null, n: 0 };
  // Wilson score interval half-width; it behaves better than a normal
  // approximation for sparse and near-boundary proportions.
  const z = 1.96;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const margin = z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n))) / denominator;
  return { estimate: p, margin, n };
}

function snapshotAccumulator(acc) {
  const total = acc.records;
  return {
    records: total,
    mapqMedian: medianFromHistogram(acc.mapq),
    readLengthMedian: medianFromHistogram(acc.readLengths),
    exonicFraction: total ? (acc.regions.get('E') || 0) / total : null,
    barcodeRate: total ? acc.barcodes.size / total : null,
  };
}

function finalizeAccumulator(acc, header, { convergence = [], strata = [], converged = false } = {}) {
  const total = acc.records;
  const knee = estimateBarcodeKnee(acc.barcodes);
  const tagPresence = Object.fromEntries([...acc.tags].map(([k, v]) => [k, v / Math.max(1, acc.records)]));
  const region = Object.fromEntries([...acc.regions]);
  const hasCell = (tagPresence.CB || 0) > 0.1;
  const hasUmi = (tagPresence.UB || 0) > 0.1;
  const hasGene = (tagPresence.GX || 0) > 0.1 || (tagPresence.GN || 0) > 0.1;
  const hasRegion = (tagPresence.RE || 0) > 0.05;
  const pgText = header.fields.PG.map((p) => `${p.ID || ''} ${p.PN || ''} ${p.CL || ''}`).join(' ').toLowerCase();
  const barcodeLength = [...acc.barcodeSketches.keys()][0]?.split('-')[0]?.length || null;
  const umiLength = [...acc.uniqueUmis][0]?.split('|')[1]?.length || null;
  const evidence = [];
  if (barcodeLength) evidence.push(`CB ${barcodeLength} nt`);
  if (umiLength) evidence.push(`UB ${umiLength} nt`);
  if (hasGene) evidence.push('GX/GN present');
  if (hasRegion) evidence.push('RE present');
  if (pgText.includes('cellranger')) evidence.push('Cell Ranger @PG');
  let assay = { label: 'Generic alignment', confidence: 'low' };
  if ((hasCell && hasUmi && hasGene) || pgText.includes('cellranger')) {
    const chemistry = barcodeLength === 16 && umiLength === 12 ? 'Compatible with 3′ v3/v3.1' : '10x-like chemistry; read structure not fully resolved';
    assay = { label: 'Single-cell RNA sequencing', platform: '10x Chromium', confidence: hasCell && hasUmi && hasGene && hasRegion ? 'high' : 'medium', chemistry, barcodeLength, umiLength, evidence };
  } else if (hasCell && !hasUmi) {
    assay = { label: 'Barcoded sequencing', confidence: 'medium' };
  }

  const barcodeRank = [...acc.barcodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5000).map(([barcode, count], i) => ({ rank: i + 1, barcode, count }));
  const barcodeEntries = [...acc.barcodeSketches.entries()].sort((a, b) => b[1].reads - a[1].reads);
  const barcodeMetrics = barcodeEntries.map(([barcode, sketch], i) => ({
    rank: i + 1, barcode, reads: sketch.reads, umis: sketch.umis.size, genes: sketch.genes.size,
    mitochondrialFraction: sketch.reads ? sketch.mitochondrial / sketch.reads : null,
  }));
  const cellCount = knee?.estimatedCells || 0;
  const cellBarcodes = barcodeMetrics.slice(0, cellCount);
  const tailBarcodes = barcodeMetrics.slice(cellCount);
  const tailReads = tailBarcodes.reduce((sum, item) => sum + item.reads, 0);
  const barcodeShape = {
    retainedBarcodes: barcodeMetrics.length,
    mapCapped: acc.barcodeMapCapped || acc.barcodeSketches.size >= MAX_BARCODES,
    readsPerBarcodeMedian: medianArray(barcodeMetrics.map((x) => x.reads)),
    umisPerBarcodeMedian: medianArray(barcodeMetrics.map((x) => x.umis)),
    genesPerBarcodeMedian: medianArray(barcodeMetrics.map((x) => x.genes)),
    cellAssociatedReadsPerBarcodeMedian: medianArray(cellBarcodes.map((x) => x.reads)),
    cellAssociatedUmisPerBarcodeMedian: medianArray(cellBarcodes.map((x) => x.umis)),
    cellAssociatedGenesPerBarcodeMedian: medianArray(cellBarcodes.map((x) => x.genes)),
    mitochondrialFractionMedian: medianArray(barcodeMetrics.map((x) => x.mitochondrialFraction)),
    mitochondrialFractionQuartiles: [0.25, 0.5, 0.75].map((p) => percentileArray(barcodeMetrics.map((x) => x.mitochondrialFraction), p)),
    ambientTailFraction: totalBarcodedReads(acc.barcodes) ? tailReads / totalBarcodedReads(acc.barcodes) : null,
    sketches: barcodeMetrics.slice(0, 5000),
  };
  const sampleMappedFraction = total ? acc.flags.mapped / total : null;
  const duplicateFraction = total ? acc.flags.duplicate / total : null;
  const geneAssignment = Math.max(tagPresence.GX || 0, tagPresence.GN || 0);
  const mitochondrialSignal = barcodeShape.mitochondrialFractionMedian;
  const healthFlags = [];
  const addHealth = (id, level, label, value, note) => healthFlags.push({ id, level, label, value, note });
  addHealth('alignment', sampleMappedFraction != null && sampleMappedFraction >= 0.9 ? 'good' : 'warn', 'Alignment fraction', sampleMappedFraction, sampleMappedFraction == null ? 'No sampled records.' : `${(sampleMappedFraction * 100).toFixed(1)}% of sampled records are mapped.`);
  addHealth('duplication', duplicateFraction != null && duplicateFraction <= 0.5 ? 'good' : 'warn', 'Duplicate reads', duplicateFraction, duplicateFraction == null ? 'No sampled records.' : `${(duplicateFraction * 100).toFixed(1)}% of sampled records carry the duplicate flag.`);
  addHealth('gene-assignment', geneAssignment >= 0.5 ? 'good' : 'warn', 'Gene assignment tags', geneAssignment, geneAssignment >= 0.5 ? 'GX/GN is present on most sampled records.' : 'GX/GN is sparse; gene-level interpretation is limited.');
  addHealth('mitochondrial', mitochondrialSignal == null || mitochondrialSignal <= 0.2 ? 'good' : 'warn', 'Mitochondrial signal', mitochondrialSignal, mitochondrialSignal == null ? 'Per-barcode mitochondrial signal unavailable.' : `${(mitochondrialSignal * 100).toFixed(1)}% median mitochondrial fraction among retained barcodes.`);
  addHealth('barcode-knee', knee?.confidence === 'medium' ? 'good' : 'warn', 'Barcode knee', knee?.confidence || null, knee ? `Preliminary knee near ${knee.estimatedCells.toLocaleString()} barcodes.` : 'No reliable barcode knee was detected.');
  const fp = header.referenceFingerprint;
  const unusualContigs = (fp?.smallUnusual?.length || 0) + (fp?.altDecoyCount || 0);
  addHealth('reference-contigs', unusualContigs ? 'warn' : 'good', 'Reference contigs', unusualContigs, unusualContigs ? `${fp.altDecoyCount || 0} ALT/decoy and ${fp.smallUnusual?.length || 0} other small contigs detected.` : 'No ALT/decoy or unusual small contigs detected.');
  const uncertainty = {
    regions: Object.fromEntries([...acc.regions].map(([key, count]) => [key, proportionEstimate(count, total)])),
    alignmentClasses: Object.fromEntries(Object.entries(acc.alignmentClasses).map(([key, count]) => [key, proportionEstimate(count, total)])),
    flags: Object.fromEntries(Object.entries(acc.flags).map(([key, count]) => [key, proportionEstimate(count, total)])),
  };
  return {
    records: acc.records,
    mapqMedian: medianFromHistogram(acc.mapq),
    mapqHistogram: acc.mapq,
    readLengthMedian: medianFromHistogram(acc.readLengths),
    readLengthHistogram: [...acc.readLengths.entries()].sort((a, b) => a[0] - b[0]),
    flags: acc.flags,
    spliced: acc.spliced,
    tagPresence,
    regions: region,
    uncertainty,
    sampledRegions: [...acc.sampledRegions],
    sampledRegionCount: acc.sampledRegions.size,
    alignmentClasses: acc.alignmentClasses,
    uniqueBarcodesObserved: acc.barcodes.size,
    uniqueMoleculesObserved: acc.uniqueUmis.size,
    uniqueGenesObserved: acc.geneIds.size,
    topGenes: topEntries(acc.genes, 15),
    barcodeRank,
    knee,
    barcodeShape,
    healthFlags,
    convergence,
    sampling: {
      strategy: 'reference- and index-region-stratified BAI sample',
      strata: strata.length,
      sampledStrata: [...acc.sampledRegions],
      referencesRepresented: new Set([...acc.sampleByReference.keys()]).size,
      referenceCount: header.references.length,
      deduplicationCapped: acc.deduplicationCapped,
      converged,
    },
    multimappedTag: acc.multimappedTag,
    assay,
    readGroups: topEntries(acc.readGroups, 20),
    sampledReferences: [...acc.sampleByReference.entries()].map(([refId, count]) => ({ refId, name: header.references[refId]?.name || String(refId), count })),
  };
}

export async function sampleBam(file, bai, header, {
  targetRecords = 40_000,
  samplePoints = 24,
  progressive = false,
  batchSize = 25_000,
  minBatches = 2,
  stabilityBatches = 2,
  signal,
  onProgress = () => {},
} = {}) {
  const offsets = collectStratifiedSamplingOffsets(bai, samplePoints);
  if (!offsets.length) throw new Error('BAI contains no usable seek offsets for sampling');
  const acc = createAccumulator();
  const perPoint = Math.ceil(targetRecords / offsets.length);
  const convergence = [];
  let converged = false;
  let nextBatch = Math.max(1, batchSize);
  let bytesRead = 0;

  const isStable = (a, b) => {
    if (!a || !b) return false;
    const fractionStable = (x, y) => x == null || y == null || Math.abs(x - y) <= 0.01;
    const medianStable = (x, y, tolerance) => x == null || y == null || Math.abs(x - y) <= tolerance;
    return fractionStable(a.exonicFraction, b.exonicFraction) &&
      fractionStable(a.barcodeRate, b.barcodeRate) &&
      medianStable(a.mapqMedian, b.mapqMedian, 2) &&
      medianStable(a.readLengthMedian, b.readLengthMedian, 2);
  };

  const maybeRecordBatch = () => {
    while (acc.records >= nextBatch || (!convergence.length && acc.records > 0 && !progressive)) {
      convergence.push(snapshotAccumulator(acc));
      nextBatch += Math.max(1, batchSize);
      if (!progressive) break;
    }
  };

  for (let i = 0; i < offsets.length && acc.records < targetRecords; i++) {
    if (signal?.aborted) throw new DOMException('Sampling cancelled', 'AbortError');
    const { virtualOffset } = offsets[i];
    const p = virtualOffsetParts(virtualOffset);
    try {
      const window = await readBgzfWindow(file, p.compressed, {
        maxCompressedBytes: 1.5 * 1024 * 1024,
        maxBlocks: 48,
        maxUncompressedBytes: 3 * 1024 * 1024,
        signal,
        onBytes: (n) => { bytesRead += n; },
      });
      parseRecords(window.data, p.uncompressed, Math.min(perPoint * 2, targetRecords - acc.records + perPoint), acc, { region: offsets[i].region });
    } catch (err) {
      // A bad/overlapping index seek should not abort all other distributed samples.
      if (err?.name === 'AbortError') throw err;
      console.warn('BAM sample point failed', p, err);
    }
    maybeRecordBatch();
    const stable = progressive && convergence.length >= minBatches + stabilityBatches && convergence.slice(-stabilityBatches).every((x, j, arr) => j === 0 || isStable(arr[j - 1], x));
    onProgress({ completed: i + 1, total: offsets.length, records: acc.records, bytesRead, convergence: convergence.at(-1), stable });
    if (stable) { converged = true; break; }
  }
  if (!acc.records) throw new Error('Could not decode BAM records from BAI seek points');
  if (!convergence.length || convergence.at(-1).records !== acc.records) convergence.push(snapshotAccumulator(acc));
  return finalizeAccumulator(acc, header, { convergence, strata: offsets, converged });
}

function totalBarcodedReads(barcodes) {
  let total = 0;
  for (const count of barcodes.values()) total += count;
  return total;
}

/**
 * Validate index/header compatibility and probe indexed BGZF/record boundaries.
 * The complete BAI structure is checked synchronously; probes then exercise
 * actual BAM bytes at representative seek points, catching wrong indexes,
 * truncated BGZF members and corrupt record payloads before sampling.
 */
export async function validateBamIndex(file, bai, header, { probePoints = 64, signal, onBytes = () => {} } = {}) {
  if (signal?.aborted) throw new DOMException('Validation cancelled', 'AbortError');
  validateBaiAgainstBam(bai, header, file.size);
  const offsets = collectSamplingOffsets(bai, probePoints);
  const probeAccumulator = createAccumulator();
  for (const { virtualOffset } of offsets) {
    const p = virtualOffsetParts(virtualOffset);
    const window = await readBgzfWindow(file, p.compressed, {
      maxCompressedBytes: 512 * 1024,
      maxBlocks: 16,
      maxUncompressedBytes: 1 * 1024 * 1024,
      signal,
      onBytes,
    });
    const block = window.blocks[0];
    if (!block || p.uncompressed >= block.data.length) {
      throw new Error(`BAI seek offset ${p.compressed}:${p.uncompressed} is outside its BGZF block`);
    }
    const parsed = parseRecords(window.data, p.uncompressed, 1, probeAccumulator, { strict: true, referenceCount: header.references.length, referenceNames: header.references });
    if (!parsed) throw new Error(`BAI seek offset ${p.compressed}:${p.uncompressed} does not point to a BAM record`);
  }
  return { valid: true, probes: offsets.length };
}
