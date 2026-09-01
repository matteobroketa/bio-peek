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

function assertCount(value, max, label) {
  if (value > max) throw new Error(`Invalid BAI ${label}: ${value}`);
}

function validateVirtualOffset(value, label) {
  const v = BigInt(value);
  if (v < 0n) throw new Error(`Invalid BAI virtual offset in ${label}`);
  if ((v & 0xffffn) >= 0x10000n) throw new Error(`Invalid BAI virtual offset in ${label}`);
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
  assertCount(nRef, 1_000_000, 'reference count');
  const references = [];

  for (let r = 0; r < nRef; r++) {
    const nBin = readU32(view, offset);
    offset += 4;
    assertCount(nBin, 1_000_000, 'bin count');
    const bins = [];
    let metadata = null;

    for (let b = 0; b < nBin; b++) {
      const bin = readU32(view, offset);
      offset += 4;
      const nChunk = readU32(view, offset);
      offset += 4;
      if (bin > META_BIN) throw new Error(`Invalid BAI bin number ${bin}`);
      assertCount(nChunk, 1_000_000, 'chunk count');
      const chunks = [];
      for (let c = 0; c < nChunk; c++) {
        const beg = readU64(view, offset);
        const end = readU64(view, offset + 8);
        offset += 16;
        // The metadata pseudo-bin's second chunk stores two counts rather
        // than a virtual-offset pair, so only ordinary bins get chunk-range
        // validation here.
        if (bin !== META_BIN) {
          validateVirtualOffset(beg, `reference ${r}, bin ${bin}`);
          validateVirtualOffset(end, `reference ${r}, bin ${bin}`);
          if (end < beg) throw new Error(`BAI chunk end precedes start in reference ${r}, bin ${bin}`);
        }
        chunks.push({ beg, end });
      }
      if (bin === META_BIN) {
        if (nChunk !== 2) throw new Error(`BAI metadata pseudo-bin must contain exactly two chunks (reference ${r})`);
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
    assertCount(nIntv, 100_000_000, 'linear-index interval count');
    const linear = [];
    for (let i = 0; i < nIntv; i++) {
      const value = readU64(view, offset);
      validateVirtualOffset(value, `reference ${r} linear index`);
      linear.push(value);
      offset += 8;
    }
    references.push({ bins, linear, metadata });
  }

  let noCoordinate = null;
  if (offset < view.byteLength && view.byteLength - offset !== 8) {
    throw new Error(`Malformed BAI trailing data: expected optional 8-byte no-coordinate count, found ${view.byteLength - offset} bytes`);
  }
  if (offset + 8 === view.byteLength) {
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

/** Validate the parts of a BAI that can be checked against a BAM header/file. */
export function validateBaiAgainstBam(bai, header, bamSize) {
  const errors = [];
  if (bai.references.length !== header.references.length) {
    errors.push(`reference count mismatch (BAM has ${header.references.length}, BAI has ${bai.references.length})`);
  }

  const checkOffset = (value, label) => {
    const { compressed, uncompressed } = virtualOffsetParts(value);
    if (compressed >= bamSize) errors.push(`${label} points beyond the BAM (${compressed} >= ${bamSize})`);
    if (uncompressed >= 0x10000) errors.push(`${label} has an invalid in-block offset ${uncompressed}`);
    return { compressed, uncompressed };
  };

  for (let refId = 0; refId < bai.references.length; refId++) {
    const ref = bai.references[refId];
    let previousLinear = 0n;
    for (let i = 0; i < ref.linear.length; i++) {
      const value = ref.linear[i];
      checkOffset(value, `BAI reference ${refId} linear interval ${i}`);
      if (value !== 0n && previousLinear !== 0n && value < previousLinear) {
        errors.push(`BAI reference ${refId} linear index is not monotonic`);
      }
      if (value !== 0n) previousLinear = value;
    }
    for (const bin of ref.bins) {
      let previous = null;
      for (const chunk of bin.chunks) {
        const beg = checkOffset(chunk.beg, `BAI reference ${refId} bin ${bin.bin} chunk start`);
        const end = checkOffset(chunk.end, `BAI reference ${refId} bin ${bin.bin} chunk end`);
        if (chunk.end <= chunk.beg) errors.push(`BAI reference ${refId} bin ${bin.bin} contains an empty or reversed chunk`);
        if (previous && beg.compressed < previous) errors.push(`BAI reference ${refId} bin ${bin.bin} chunks are not ordered`);
        previous = beg.compressed;
        if (end.compressed < beg.compressed) errors.push(`BAI reference ${refId} bin ${bin.bin} chunk crosses backwards in the BAM`);
      }
    }
    if (ref.metadata) {
      checkOffset(ref.metadata.refBeg, `BAI reference ${refId} metadata start`);
      checkOffset(ref.metadata.refEnd, `BAI reference ${refId} metadata end`);
      if (ref.metadata.refEnd < ref.metadata.refBeg) errors.push(`BAI reference ${refId} metadata range is reversed`);
    }
  }
  if (bai.noCoordinate != null && bai.noCoordinate < 0n) errors.push('BAI no-coordinate count is negative');
  if (errors.length) throw new Error(`BAI validation failed: ${errors.slice(0, 5).join('; ')}`);
  return { valid: true, references: bai.references.length };
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

/**
 * Pick one bounded, approximately equal allocation of indexed regions per
 * reference. BAI chunk counts are not a probability measure, so this avoids
 * letting a reference with many dense bins consume the entire sample. The
 * returned region id is retained in the result for coverage accounting.
 */
export function collectStratifiedSamplingOffsets(bai, maxOffsets = 32) {
  const byReference = bai.references.map((ref, refId) => {
    const candidates = [];
    for (const bin of ref.bins) {
      for (let chunkIndex = 0; chunkIndex < bin.chunks.length; chunkIndex++) {
        const chunk = bin.chunks[chunkIndex];
        if (chunk.beg === 0n) continue;
        const p = virtualOffsetParts(chunk.beg);
        candidates.push({ refId, bin: bin.bin, chunkIndex, virtualOffset: chunk.beg, ...p, region: `${refId}:${bin.bin}:${chunkIndex}` });
      }
    }
    if (candidates.length < 2) {
      for (let interval = 0; interval < ref.linear.length; interval++) {
        const vo = ref.linear[interval];
        if (vo === 0n) continue;
        const p = virtualOffsetParts(vo);
        candidates.push({ refId, bin: null, chunkIndex: interval, virtualOffset: vo, ...p, region: `${refId}:linear:${interval}` });
      }
    }
    const unique = new Map(candidates.map((candidate) => [`${candidate.compressed}:${candidate.uncompressed}`, candidate]));
    return [...unique.values()].sort((a, b) => a.compressed - b.compressed || a.uncompressed - b.uncompressed);
  }).filter((candidates) => candidates.length);

  if (!byReference.length || maxOffsets < 1) return [];
  const quota = Math.max(1, Math.floor(maxOffsets / byReference.length));
  const picked = [];
  const used = new Set();
  for (let round = 0; picked.length < maxOffsets; round++) {
    let added = false;
    for (const candidates of byReference) {
      if (picked.length >= maxOffsets) break;
      if (round >= Math.min(quota, candidates.length) && round > quota) continue;
      const index = Math.min(candidates.length - 1, round < quota
        ? Math.round(round * (candidates.length - 1) / Math.max(1, quota - 1))
        : round - quota);
      const candidate = candidates[index];
      if (candidate && !used.has(candidate.region)) {
        used.add(candidate.region);
        picked.push(candidate);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}

export { META_BIN };
