export function parseFai(text) {
  const records = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const fields = raw.split('\t');
    if (fields.length < 5) throw new Error(`Invalid .fai line ${i + 1}: expected 5 columns`);
    const length = Number(fields[1]);
    const offset = Number(fields[2]);
    const lineBases = Number(fields[3]);
    const lineBytes = Number(fields[4]);
    if (![length, offset, lineBases, lineBytes].every(Number.isFinite)) {
      throw new Error(`Invalid numeric value in .fai line ${i + 1}`);
    }
    records.push({ name: fields[0], length, offset, lineBases, lineBytes });
  }
  return records;
}

export function summarizeFai(records) {
  const lengths = records.map((r) => r.length).sort((a, b) => b - a);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  let cumulative = 0;
  let n50 = 0;
  let l50 = 0;
  for (let i = 0; i < lengths.length; i++) {
    cumulative += lengths[i];
    if (cumulative >= totalLength / 2) {
      n50 = lengths[i];
      l50 = i + 1;
      break;
    }
  }
  return {
    contigs: records.length,
    totalLength,
    n50,
    l50,
    longest: lengths[0] ?? 0,
    shortest: lengths[lengths.length - 1] ?? 0,
  };
}
