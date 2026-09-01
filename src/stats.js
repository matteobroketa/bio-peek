export function medianFromHistogram(hist) {
  const entries = Array.isArray(hist)
    ? hist.map((v, i) => [i, v]).filter(([, v]) => v > 0)
    : [...hist.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const total = entries.reduce((n, [, c]) => n + c, 0);
  if (!total) return null;
  const target = (total - 1) / 2;
  let cumulative = 0;
  for (const [value, count] of entries) {
    cumulative += count;
    if (cumulative > target) return Number(value);
  }
  return Number(entries.at(-1)?.[0] ?? 0);
}

export function percentileFromHistogram(hist, p) {
  const entries = [...hist.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const total = entries.reduce((n, [, c]) => n + c, 0);
  if (!total) return null;
  const target = Math.max(0, Math.min(total - 1, Math.floor(p * (total - 1))));
  let cumulative = 0;
  for (const [value, count] of entries) {
    cumulative += count;
    if (cumulative > target) return Number(value);
  }
  return Number(entries.at(-1)?.[0] ?? 0);
}

export function estimateBarcodeKnee(barcodeCounts) {
  const counts = [...barcodeCounts.values()].filter((x) => x > 0).sort((a, b) => b - a);
  if (counts.length < 50) return null;

  // Ignore the extreme ends, where log-log knee estimates are unstable.
  const start = Math.max(1, Math.floor(counts.length * 0.002));
  const end = Math.max(start + 10, Math.floor(counts.length * 0.92));
  const x1 = Math.log10(start + 1);
  const y1 = Math.log10(counts[start]);
  const x2 = Math.log10(end + 1);
  const y2 = Math.log10(Math.max(1, counts[end]));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const denom = Math.hypot(dx, dy) || 1;

  let bestIdx = null;
  let bestDistance = -Infinity;
  for (let i = start + 1; i < end; i++) {
    const x = Math.log10(i + 1);
    const y = Math.log10(counts[i]);
    // Perpendicular distance to endpoint chord in log-log space.
    const distance = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / denom;
    if (distance > bestDistance) {
      bestDistance = distance;
      bestIdx = i;
    }
  }
  if (bestIdx == null) return null;
  return {
    estimatedCells: bestIdx + 1,
    thresholdReads: counts[bestIdx],
    confidence: counts.length >= 500 && bestDistance > 0.08 ? 'medium' : 'low',
    curvature: bestDistance,
  };
}

export function inferReferenceBuild(references) {
  const byName = new Map(references.map((r) => [r.name, r.length]));
  const cases = [
    { name: 'GRCh38 / hg38', keys: ['chr1', '1'], length: 248956422 },
    { name: 'GRCh37 / hg19', keys: ['chr1', '1'], length: 249250621 },
    { name: 'GRCm38 / mm10', keys: ['chr1', '1'], length: 195471971 },
    { name: 'GRCm39 / mm39', keys: ['chr1', '1'], length: 195154279 },
  ];
  for (const c of cases) {
    for (const key of c.keys) {
      if (byName.get(key) === c.length) {
        return {
          label: c.name,
          confidence: 'high',
          naming: key.startsWith('chr') ? 'chr-prefixed' : 'non-prefixed',
        };
      }
    }
  }
  const chrLike = references.filter((r) => /^chr(?:\d+|X|Y|M)$/i.test(r.name)).length;
  const bareLike = references.filter((r) => /^(?:\d+|X|Y|MT)$/i.test(r.name)).length;
  return {
    label: 'Unknown reference',
    confidence: 'low',
    naming: chrLike > bareLike ? 'chr-prefixed' : bareLike > 0 ? 'non-prefixed' : 'custom',
  };
}

const HUMAN_PRIMARY = new Set([...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX', 'chrY']);
const HUMAN_PRIMARY_BARE = new Set([...Array.from({ length: 22 }, (_, i) => String(i + 1)), 'X', 'Y']);

export function fingerprintReferences(references = []) {
  const names = references.map((r) => r.name);
  const naming = names.filter((name) => /^chr/i.test(name)).length >= names.filter((name) => !/^chr/i.test(name)).length
    ? 'chr-prefixed' : 'non-prefixed';
  const primarySet = naming === 'chr-prefixed' ? HUMAN_PRIMARY : HUMAN_PRIMARY_BARE;
  const primaryCount = names.filter((name) => primarySet.has(name)).length;
  const mitochondrial = names.find((name) => /^(?:chrM|MT|M)$/i.test(name)) || null;
  const sexChromosomes = names.filter((name) => /^(?:chr)?[XY]$/i.test(name));
  const altDecoy = names.filter((name) => /(?:_alt$|_decoy$|(?:^|_)HLA-|(?:^|_)KI\d|(?:^|_)GL\d)/i.test(name));
  const smallUnusual = references.filter((r) => r.length < 1_000_000 && !/^(?:chrM|MT|M)$/i.test(r.name) && !altDecoy.includes(r.name)).map((r) => r.name);
  const build = inferReferenceBuild(references);
  const expectedPrimary = primaryCount >= 20 ? 24 : null;
  return {
    ...build,
    naming,
    primaryCount,
    expectedPrimary,
    primaryComplete: expectedPrimary != null && primaryCount >= expectedPrimary,
    altDecoyCount: altDecoy.length,
    altDecoy: altDecoy.slice(0, 20),
    smallUnusual: smallUnusual.slice(0, 20),
    mitochondrial,
    sexChromosomes,
    referenceCount: names.length,
  };
}

export function fraction(n, d) {
  return d ? n / d : 0;
}

export function topEntries(map, n = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function safeNumber(big) {
  if (big == null) return null;
  const n = Number(big);
  return Number.isSafeInteger(n) ? n : n;
}

export function formatCount(value) {
  if (value == null) return '—';
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: n >= 1e6 ? 'compact' : 'standard' }).format(n);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}
