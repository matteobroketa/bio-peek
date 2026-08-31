const BAI_MAGIC = [66, 65, 73, 1];
const META_BIN = 37450;

function assertRemaining(view, offset, n, label) {
  if (offset + n > view.byteLength) throw new Error(`Truncated BAI while reading ${label}`);
}

function readU32(view, offset) {
  assertRemaining(view, offset, 4, 'uint32');
  return view.getUint32(offset, true);
}

function readU64(view, offset) {
  assertRemaining(view, offset, 8, 'uint64');
  const lo = BigInt(view.getUint32(offset, true));
  const hi = BigInt(view.getUint32(offset + 4, true));
  return (hi << 32n) | lo;
}

export function virtualOffsetParts(value) {
  const v = BigInt(value);
  return {
    compressed: Number(v >> 16n),
    uncompressed: Number(v & 0xffffn),
  };
}

export function parseBai(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 8) throw new Error('BAI is too small');
  for (let i = 0; i < 4; i++) {
    if (view.getUint8(i) !== BAI_MAGIC[i]) throw new Error('Not a BAI file (missing BAI\\1 magic)');
  }

  let offset = 4;
  const nRef = readU32(view, offset);
  offset += 4;
  const references = [];

  for (let r = 0; r < nRef; r++) {
    const nBin = readU32(view, offset);
    offset += 4;
    const bins = [];
    let metadata = null;

    for (let b = 0; b < nBin; b++) {
      const bin = readU32(view, offset);
      offset += 4;
      const nChunk = readU32(view, offset);
      offset += 4;
      const chunks = [];
      for (let c = 0; c < nChunk; c++) {
        const beg = readU64(view, offset);
        const end = readU64(view, offset + 8);
        offset += 16;
        chunks.push({ beg, end });
      }
      if (bin === META_BIN && nChunk >= 2) {
        metadata = {
          refBeg: chunks[0].beg,
          refEnd: chunks[0].end,
          mapped: chunks[1].beg,
          unmapped: chunks[1].end,
        };
      } else {
        bins.push({ bin, chunks });
      }
    }

    const nIntv = readU32(view, offset);
    offset += 4;
    const linear = [];
    for (let i = 0; i < nIntv; i++) {
      linear.push(readU64(view, offset));
      offset += 8;
    }
    references.push({ bins, linear, metadata });
  }

  let noCoordinate = null;
  if (offset + 8 <= view.byteLength) {
    noCoordinate = readU64(view, offset);
    offset += 8;
  }

  return {
    references,
    noCoordinate,
    bytesParsed: offset,
    hasMetadataCounts: references.some((r) => r.metadata),
  };
}

export function summarizeBai(bai, referenceNames = []) {
  let mapped = 0n;
  let placedUnmapped = 0n;
  const perReference = bai.references.map((ref, i) => {
    const m = ref.metadata?.mapped ?? null;
    const u = ref.metadata?.unmapped ?? null;
    if (m != null) mapped += m;
    if (u != null) placedUnmapped += u;
    return {
      name: referenceNames[i] ?? `ref_${i}`,
      mapped: m,
      placedUnmapped: u,
    };
  });
  const unplacedUnmapped = bai.noCoordinate ?? null;
  const totalUnmapped = unplacedUnmapped == null ? null : placedUnmapped + unplacedUnmapped;
  return { mapped, placedUnmapped, unplacedUnmapped, totalUnmapped, perReference };
}

export function collectSamplingOffsets(bai, maxOffsets = 32) {
  const candidates = new Map();

  for (let refId = 0; refId < bai.references.length; refId++) {
    const ref = bai.references[refId];
    for (const bin of ref.bins) {
      for (const chunk of bin.chunks) {
        if (chunk.beg === 0n) continue;
        const p = virtualOffsetParts(chunk.beg);
        const key = `${p.compressed}:${p.uncompressed}`;
        if (!candidates.has(key)) candidates.set(key, { refId, virtualOffset: chunk.beg, ...p });
      }
    }
  }

  // Fall back to the linear index for unusually sparse/atypical BAIs.
  if (candidates.size < Math.min(8, maxOffsets)) {
    for (let refId = 0; refId < bai.references.length; refId++) {
      for (const vo of bai.references[refId].linear) {
        if (vo === 0n) continue;
        const p = virtualOffsetParts(vo);
        const key = `${p.compressed}:${p.uncompressed}`;
        if (!candidates.has(key)) candidates.set(key, { refId, virtualOffset: vo, ...p });
      }
    }
  }

  const sorted = [...candidates.values()].sort((a, b) =>
    a.compressed === b.compressed ? a.uncompressed - b.uncompressed : a.compressed - b.compressed,
  );
  if (sorted.length <= maxOffsets) return sorted;

  const picked = [];
  const used = new Set();
  for (let i = 0; i < maxOffsets; i++) {
    const idx = Math.round((i * (sorted.length - 1)) / (maxOffsets - 1));
    if (!used.has(idx)) {
      used.add(idx);
      picked.push(sorted[idx]);
    }
  }
  return picked;
}

export { META_BIN };
