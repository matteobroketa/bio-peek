import { medianFromHistogram, topEntries } from './stats.js';

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
  onProgress = () => {},
} = {}) {
  let stream = file.stream();
  const gzip = await isGzip(file);
  if (gzip) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser lacks gzip DecompressionStream support');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let lines = [];
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
  const adapter = 'AGATCGGAAGAGC';

  function consumeRecord(rec) {
    const [header, seqRaw, plus, qual] = rec;
    if (!header?.startsWith('@') || !plus?.startsWith('+') || seqRaw == null || qual == null) return false;
    const seq = seqRaw.trim().toUpperCase();
    if (seq.length !== qual.length) return false;
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
      const q = Math.max(0, qual.charCodeAt(i) - 33);
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

  try {
    while (reads < targetReads) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0 && reads < targetReads) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lines.push(line);
        if (lines.length === 4) {
          consumeRecord(lines);
          lines = [];
          if (reads % 5000 === 0) onProgress({ reads, target: targetReads });
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
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
  };
}

export function inferFastqPair(results) {
  if (results.length < 2) return null;
  const sorted = [...results].sort((a, b) => {
    const ar = a.illumina?.read ?? (/[_\.-]R?1[_\.-]/i.test(a.fileName) ? 1 : 9);
    const br = b.illumina?.read ?? (/[_\.-]R?1[_\.-]/i.test(b.fileName) ? 1 : 9);
    return ar - br;
  });
  const r1 = sorted[0], r2 = sorted[1];
  if (r1.medianLength >= 24 && r1.medianLength <= 32 && r2.medianLength >= 50) {
    return {
      label: '10x-like barcode/UMI + cDNA layout',
      confidence: r1.medianLength === 28 ? 'medium' : 'low',
      r1: r1.fileName,
      r2: r2.fileName,
      note: 'Read 1 length is consistent with a compact barcode/UMI read and Read 2 is cDNA-like; chemistry is not asserted from length alone.',
    };
  }
  return { label: 'Paired sequencing reads', confidence: 'low', r1: r1.fileName, r2: r2.fileName };
}
