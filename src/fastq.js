import { medianFromHistogram, topEntries } from './stats.js';
import { classifyFastq } from './dataset-resolver.js';

function bump(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n); }

async function isGzip(file) {
  if (/\.gz$/i.test(file.name)) return true;
  if (file.size < 2) return false;
  const b = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return b[0] === 0x1f && b[1] === 0x8b;
}

function parseIlluminaHeader(header) {
  const h = header.startsWith('@') ? header.slice(1) : header;
  const m = h.match(/^([^: ]+):(\d+):([^: ]+):(\d+):(\d+):(\d+):(\d+)\s+([12]):([YN]):(\d+):([^\s]+)/);
  if (!m) return null;
  return {
    instrument: m[1], run: m[2], flowcell: m[3], lane: Number(m[4]), tile: Number(m[5]),
    read: Number(m[8]), filtered: m[9] === 'Y', control: Number(m[10]), index: m[11],
  };
}

function sequenceEntropyFromCycles(baseCounts, cycleCounts) {
  let sum = 0;
  let used = 0;
  for (let i = 0; i < cycleCounts.length; i++) {
    const total = cycleCounts[i] || 0;
    if (!total) continue;
    let h = 0;
    for (const base of ['A', 'C', 'G', 'T']) {
      const p = (baseCounts[base]?.[i] || 0) / total;
      if (p > 0) h -= p * Math.log2(p);
    }
    sum += h;
    used++;
  }
  return used ? sum / used : null;
}

export async function sampleFastq(file, {
  targetReads = 50_000,
  signal,
  onBytes = () => {},
  onProgress = () => {},
} = {}) {
  const abort = () => { if (signal?.aborted) throw new DOMException('FASTQ sampling cancelled', 'AbortError'); };
  const gzip = await isGzip(file);
  let reads = 0;
  let firstHeader = null;
  const lengthHist = new Map();
  const gcHist = Array(21).fill(0);
  const qualitySum = [];
  const cycleCounts = [];
  const baseCounts = { A: [], C: [], G: [], T: [], N: [] };
  let q20Bases = 0, q30Bases = 0, totalBases = 0, nBases = 0;
  const sequences = new Map();
  let adapterReads = 0, polyAReads = 0, polyGReads = 0;
  let malformedRecords = 0, invalidBases = 0, invalidQuality = 0;
  let qualityMin = Infinity, qualityMax = -Infinity;
  const readNumbers = new Map();
  const adapter = 'AGATCGGAAGAGC';

  function consumeRecord(rec) {
    const [header, seqRaw, plus, qual] = rec;
    if (!header?.startsWith('@') || !plus?.startsWith('+') || seqRaw == null || qual == null) { malformedRecords++; return false; }
    const seq = seqRaw.trim().toUpperCase();
    const quality = qual.trim();
    if (seq.length !== quality.length || !seq.length) { malformedRecords++; return false; }
    const readNumber = header.match(/(?:\s|\/)([12])(?:[:\s]|$)/)?.[1];
    if (readNumber) bump(readNumbers, readNumber);
    for (const base of seq) if (!/[ACGTNRYKMSWBDHV.-]/.test(base)) invalidBases++;
    for (const char of quality) {
      const code = char.charCodeAt(0);
      qualityMin = Math.min(qualityMin, code); qualityMax = Math.max(qualityMax, code);
      if (code < 33 || code > 126) invalidQuality++;
    }
    if (!firstHeader) firstHeader = header;
    reads++;
    bump(lengthHist, seq.length);
    totalBases += seq.length;
    let gc = 0;
    for (let i = 0; i < seq.length; i++) {
      const b = baseCounts[seq[i]] ? seq[i] : 'N';
      baseCounts[b][i] = (baseCounts[b][i] || 0) + 1;
      cycleCounts[i] = (cycleCounts[i] || 0) + 1;
      if (b === 'G' || b === 'C') gc++;
      if (b === 'N') nBases++;
      const q = Math.max(0, quality.charCodeAt(i) - 33);
      qualitySum[i] = (qualitySum[i] || 0) + q;
      if (q >= 20) q20Bases++;
      if (q >= 30) q30Bases++;
    }
    gcHist[Math.min(20, Math.floor((gc / Math.max(1, seq.length)) * 20))]++;
    if (sequences.size < 200_000 || sequences.has(seq)) bump(sequences, seq);
    if (seq.includes(adapter)) adapterReads++;
    if (/A{12,}$/.test(seq)) polyAReads++;
    if (/G{12,}$/.test(seq)) polyGReads++;
    return true;
  }

  function consumeText(text, startOffset, readLimit) {
    let lines = text.replace(/\r/g, '').split('\n');
    let start = 0;
    // A byte-range can begin halfway through a FASTQ record. Discard lines
    // until a plausible complete four-line record is found.
    if (startOffset > 0) {
      start = lines.findIndex((line, i) => line.startsWith('@') && i + 3 < lines.length && lines[i + 2].startsWith('+'));
      if (start < 0) return;
    }
    for (let i = start; i + 3 < lines.length && reads < readLimit; i += 4) {
      consumeRecord(lines.slice(i, i + 4));
      if (reads && reads % 5000 === 0) onProgress({ reads, target: targetReads });
    }
  }

  let strategy;
  if (gzip) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser lacks gzip DecompressionStream support');
    let stream = file.stream().pipeThrough(new TransformStream({
      transform(chunk, controller) { onBytes(chunk.byteLength); controller.enqueue(chunk); },
    })).pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let lines = [];
    try {
      while (reads < targetReads) {
        abort();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0 && reads < targetReads) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          lines.push(line);
          if (lines.length === 4) { consumeRecord(lines); lines = []; }
        }
      }
      if (lines.length) malformedRecords++;
    } finally {
      try { await reader.cancel(); } catch {}
    }
    strategy = 'gzip prefix stream';
  } else {
    const windowBytes = 4 * 1024 * 1024;
    const windows = Math.min(16, Math.max(1, Math.ceil(file.size / windowBytes)));
    const perWindow = Math.ceil(targetReads / windows);
    for (let i = 0; i < windows && reads < targetReads; i++) {
      abort();
      const start = Math.floor(i * Math.max(0, file.size - windowBytes) / Math.max(1, windows - 1));
      const end = Math.min(file.size, start + windowBytes);
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      onBytes(bytes.byteLength);
      consumeText(new TextDecoder().decode(bytes), start, Math.min(targetReads, reads + perWindow));
      onProgress({ reads, target: targetReads, window: i + 1, windows });
    }
    strategy = windows > 1 ? 'distributed uncompressed byte ranges' : 'uncompressed full file';
  }

  if (!reads) throw new Error('No valid four-line FASTQ records were found');
  const medianLength = medianFromHistogram(lengthHist);
  const uniqueSequences = sequences.size;
  const duplicatedObserved = [...sequences.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
  const perCycle = cycleCounts.map((count, i) => ({
    cycle: i + 1,
    meanQ: count ? qualitySum[i] / count : null,
    A: (baseCounts.A[i] || 0) / count,
    C: (baseCounts.C[i] || 0) / count,
    G: (baseCounts.G[i] || 0) / count,
    T: (baseCounts.T[i] || 0) / count,
    N: (baseCounts.N[i] || 0) / count,
  }));

  return {
    fileName: file.name,
    gzip,
    reads,
    totalBases,
    medianLength,
    lengthHistogram: [...lengthHist.entries()].sort((a, b) => a[0] - b[0]),
    q20: q20Bases / Math.max(1, totalBases),
    q30: q30Bases / Math.max(1, totalBases),
    nFraction: nBases / Math.max(1, totalBases),
    duplicationObserved: duplicatedObserved / Math.max(1, reads),
    uniqueSequences,
    gcHistogram: gcHist,
    perCycle,
    meanCycleEntropy: sequenceEntropyFromCycles(baseCounts, cycleCounts),
    adapterFraction: adapterReads / reads,
    polyAFraction: polyAReads / reads,
    polyGFraction: polyGReads / reads,
    topSequences: topEntries(sequences, 8).map(([sequence, count]) => ({ sequence, count })),
    illumina: firstHeader ? parseIlluminaHeader(firstHeader) : null,
    firstHeader,
    sampling: {
      strategy,
      readsRequested: targetReads,
      readsObserved: reads,
      windows: gzip ? 1 : Math.min(16, Math.max(1, Math.ceil(file.size / (4 * 1024 * 1024)))),
      limitation: gzip ? 'Ordinary gzip has no random-access index; this is a bounded prefix stream sample.' : 'Each byte range is aligned to the next complete four-line record; range boundaries may omit records.',
    },
    integrity: {
      malformedRecords,
      incompleteTail: false,
      invalidBases,
      invalidQuality,
      qualityMin: Number.isFinite(qualityMin) ? qualityMin : null,
      qualityMax: Number.isFinite(qualityMax) ? qualityMax : null,
      qualityEncoding: invalidQuality ? 'invalid quality bytes' : 'Phred+33 printable range (encoding remains ambiguous for high-quality-only reads)',
      readNumbers: Object.fromEntries(readNumbers),
      readNumberConsistent: readNumbers.size <= 1,
    },
  };
}

export function inferFastqPair(results) {
  if (results.length < 2) return null;
  const classified = results.map((result) => ({ result, info: classifyFastq(result.fileName) }));
  const r1s = classified.filter(({ info }) => info.role === 'r1').map(({ result }) => result);
  const r2s = classified.filter(({ info }) => info.role === 'r2').map(({ result }) => result);
  const fallback = [...results].sort((a, b) => {
    const ar = a.illumina?.read ?? (/[_\.-]R?1(?:[_\.-]|$)/i.test(a.fileName) ? 1 : 9);
    const br = b.illumina?.read ?? (/[_\.-]R?1(?:[_\.-]|$)/i.test(b.fileName) ? 1 : 9);
    return ar - br;
  });
  const r1 = r1s[0] || fallback[0], r2 = r2s[0] || fallback.find((x) => x !== r1);
  if (!r1 || !r2) return null;
  if (r1.medianLength >= 24 && r1.medianLength <= 32 && r2.medianLength >= 50) {
    return {
      label: '10x-like barcode/UMI + cDNA layout',
      confidence: r1.medianLength === 28 ? 'medium' : 'low',
      r1: r1s.length > 1 ? `${r1.fileName} (+${r1s.length - 1} lane${r1s.length > 2 ? 's' : ''})` : r1.fileName,
      r2: r2s.length > 1 ? `${r2.fileName} (+${r2s.length - 1} lane${r2s.length > 2 ? 's' : ''})` : r2.fileName,
      note: 'Read 1 length is consistent with a compact barcode/UMI read and Read 2 is cDNA-like; chemistry is not asserted from length alone.',
    };
  }
  return {
    label: 'Paired sequencing reads', confidence: 'low',
    r1: r1s.length > 1 ? `${r1.fileName} (+${r1s.length - 1} lanes)` : r1.fileName,
    r2: r2s.length > 1 ? `${r2.fileName} (+${r2s.length - 1} lanes)` : r2.fileName,
  };
}
