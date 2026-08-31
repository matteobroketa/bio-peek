import { readOneBgzfBlock, readBgzfWindow, concatUint8 } from './bgzf.js';
import { collectSamplingOffsets, virtualOffsetParts } from './bai.js';
import { estimateBarcodeKnee, inferReferenceBuild, medianFromHistogram, topEntries } from './stats.js';

const td = new TextDecoder();
const BAM_MAGIC = [66, 65, 77, 1];
const BAM_EOF = new Uint8Array([
  0x1f, 0x8b, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x06, 0x00, 0x42, 0x43,
  0x02, 0x00, 0x1b, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

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
    const name = td.decode(bytes.subarray(p, p + lName - 1));
    p += lName;
    const length = i32(view, p);
    p += 4;
    references.push({ name, length });
  }
  const fields = parseHeaderLines(headerText);
  return { headerText, fields, references, uncompressedHeaderBytes: p };
}

export async function readBamHeader(file) {
  const parts = [];
  let compressedOffset = 0;
  let total = 0;
  for (let i = 0; i < 256 && compressedOffset < file.size; i++) {
    const block = await readOneBgzfBlock(file, compressedOffset);
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
      };
    }
    compressedOffset += block.blockSize;
    if (total > 64 * 1024 * 1024) throw new Error('BAM header exceeds safety limit');
  }
  throw new Error('Could not read a complete BAM header');
}

export async function checkBamEof(file) {
  if (file.size < BAM_EOF.length) return false;
  const tail = new Uint8Array(await file.slice(file.size - BAM_EOF.length).arrayBuffer());
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

function createAccumulator() {
  return {
    records: 0,
    uniqueKeys: new Set(),
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
  };
}

function bump(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n); }

function consumeRecord(acc, rec) {
  const key = `${rec.refId}:${rec.pos}:${rec.readName}:${rec.flag}`;
  if (acc.uniqueKeys.has(key)) return false;
  acc.uniqueKeys.add(key);
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

  for (const tag of Object.keys(rec.aux)) bump(acc.tags, tag);
  if (rec.aux.RE != null) bump(acc.regions, String(rec.aux.RE));
  if (rec.aux.CB) bump(acc.barcodes, String(rec.aux.CB));
  if (rec.aux.RG) bump(acc.readGroups, String(rec.aux.RG));
  if (rec.aux.MM === 1 || rec.aux.mm === 1 || Number(rec.aux.NH) > 1) acc.multimappedTag++;

  const geneToken = rec.aux.GN || rec.aux.GX;
  if (geneToken) {
    for (const gene of String(geneToken).split(';').filter(Boolean).slice(0, 8)) {
      bump(acc.genes, gene);
      acc.geneIds.add(gene);
    }
  }
  if (rec.aux.CB && rec.aux.UB) {
    const gene = rec.aux.GX || rec.aux.GN || '';
    if (acc.uniqueUmis.size < 500_000) acc.uniqueUmis.add(`${rec.aux.CB}|${rec.aux.UB}|${gene}`);
  }
  return true;
}

function parseRecords(bytes, start, maxRecords, acc) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start;
  let parsed = 0;
  while (p + 4 <= bytes.length && parsed < maxRecords) {
    const blockSize = i32(view, p);
    if (blockSize < 32 || blockSize > 16 * 1024 * 1024 || p + 4 + blockSize > bytes.length) break;
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
    if (lReadName < 1 || lSeq < 0) break;

    const readNameStart = core + 32;
    const cigarStart = readNameStart + lReadName;
    const seqStart = cigarStart + nCigar * 4;
    const qualStart = seqStart + Math.ceil(lSeq / 2);
    const auxStart = qualStart + lSeq;
    if (auxStart > end) break;

    const readName = td.decode(bytes.subarray(readNameStart, readNameStart + Math.max(0, lReadName - 1)));
    let spliced = false;
    for (let c = 0; c < nCigar; c++) {
      const op = u32(view, cigarStart + c * 4) & 0xf;
      if (op === 3) { spliced = true; break; }
    }
    const aux = parseWantedAux(view, bytes, auxStart, end);
    consumeRecord(acc, { refId, pos, readName, mapq, flag, lSeq, spliced, aux });
    parsed++;
    p = end;
  }
  return parsed;
}

function finalizeAccumulator(acc, header) {
  const knee = estimateBarcodeKnee(acc.barcodes);
  const tagPresence = Object.fromEntries([...acc.tags].map(([k, v]) => [k, v / Math.max(1, acc.records)]));
  const region = Object.fromEntries([...acc.regions]);
  const hasCell = (tagPresence.CB || 0) > 0.1;
  const hasUmi = (tagPresence.UB || 0) > 0.1;
  const hasGene = (tagPresence.GX || 0) > 0.1 || (tagPresence.GN || 0) > 0.1;
  const hasRegion = (tagPresence.RE || 0) > 0.05;
  const pgText = header.fields.PG.map((p) => `${p.ID || ''} ${p.PN || ''} ${p.CL || ''}`).join(' ').toLowerCase();
  let assay = { label: 'Generic alignment', confidence: 'low' };
  if ((hasCell && hasUmi && hasGene) || pgText.includes('cellranger')) {
    assay = { label: 'Single-cell RNA sequencing', confidence: hasCell && hasUmi && hasGene && hasRegion ? 'high' : 'medium' };
  } else if (hasCell && !hasUmi) {
    assay = { label: 'Barcoded sequencing', confidence: 'medium' };
  }

  const barcodeRank = [...acc.barcodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5000).map(([barcode, count], i) => ({ rank: i + 1, barcode, count }));
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
    uniqueBarcodesObserved: acc.barcodes.size,
    uniqueMoleculesObserved: acc.uniqueUmis.size,
    uniqueGenesObserved: acc.geneIds.size,
    topGenes: topEntries(acc.genes, 15),
    barcodeRank,
    knee,
    multimappedTag: acc.multimappedTag,
    assay,
    readGroups: topEntries(acc.readGroups, 20),
    sampledReferences: [...acc.sampleByReference.entries()].map(([refId, count]) => ({ refId, name: header.references[refId]?.name || String(refId), count })),
  };
}

export async function sampleBam(file, bai, header, {
  targetRecords = 40_000,
  samplePoints = 24,
  onProgress = () => {},
} = {}) {
  const offsets = collectSamplingOffsets(bai, samplePoints);
  if (!offsets.length) throw new Error('BAI contains no usable seek offsets for sampling');
  const acc = createAccumulator();
  const perPoint = Math.ceil(targetRecords / offsets.length);

  for (let i = 0; i < offsets.length && acc.records < targetRecords; i++) {
    const { virtualOffset } = offsets[i];
    const p = virtualOffsetParts(virtualOffset);
    try {
      const window = await readBgzfWindow(file, p.compressed, {
        maxCompressedBytes: 1.5 * 1024 * 1024,
        maxBlocks: 48,
        maxUncompressedBytes: 3 * 1024 * 1024,
      });
      parseRecords(window.data, p.uncompressed, Math.min(perPoint * 2, targetRecords - acc.records + perPoint), acc);
    } catch (err) {
      // A bad/overlapping index seek should not abort all other distributed samples.
      console.warn('BAM sample point failed', p, err);
    }
    onProgress({ completed: i + 1, total: offsets.length, records: acc.records });
  }
  if (!acc.records) throw new Error('Could not decode BAM records from BAI seek points');
  return finalizeAccumulator(acc, header);
}
