import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBai, summarizeBai, collectSamplingOffsets, collectStratifiedSamplingOffsets, validateBaiAgainstBam } from '../src/bai.js';

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function ab(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

test('parses BAI metadata pseudo-bin and trailing no-coordinate count', () => {
  const parts = [Buffer.from([66,65,73,1]), u32(1), u32(2)];
  // ordinary bin 0 with one chunk
  parts.push(u32(0), u32(1), u64((1000n << 16n) | 10n), u64((1100n << 16n) | 20n));
  // metadata pseudo-bin
  parts.push(u32(37450), u32(2), u64(1000n << 16n), u64(2000n << 16n), u64(123456n), u64(789n));
  // linear index
  parts.push(u32(1), u64((1000n << 16n) | 10n));
  // unplaced unmapped
  parts.push(u64(42n));
  const buf = Buffer.concat(parts);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const bai = parseBai(ab);
  assert.equal(bai.references.length, 1);
  assert.equal(bai.references[0].metadata.mapped, 123456n);
  assert.equal(bai.references[0].metadata.unmapped, 789n);
  assert.equal(bai.noCoordinate, 42n);
  const summary = summarizeBai(bai, ['chr1']);
  assert.equal(summary.mapped, 123456n);
  assert.equal(summary.totalUnmapped, 831n);
  assert.equal(summary.perReference[0].name, 'chr1');
  const offsets = collectSamplingOffsets(bai, 8);
  assert.equal(offsets.length, 1);
  assert.equal(offsets[0].compressed, 1000);
  assert.equal(offsets[0].uncompressed, 10);
});

test('rejects malformed trailing bytes and incompatible BAM reference counts', () => {
  const base = Buffer.concat([Buffer.from([66, 65, 73, 1]), u32(1), u32(0), u32(0)]);
  assert.throws(() => parseBai(ab(Buffer.concat([base, Buffer.from([1])]))), /trailing data/);
  const bai = parseBai(ab(base));
  assert.throws(() => validateBaiAgainstBam(bai, { references: [] }, 100), /reference count mismatch/);
});

test('rejects BAI chunks that point beyond the BAM', () => {
  const parts = [Buffer.from([66, 65, 73, 1]), u32(1), u32(1), u32(0), u32(1), u64(500n << 16n), u64(501n << 16n), u32(0)];
  const bai = parseBai(ab(Buffer.concat(parts)));
  assert.throws(() => validateBaiAgainstBam(bai, { references: [{ name: 'chr1', length: 10 }] }, 100), /beyond the BAM/);
});

test('allocates stratified seek points across references', () => {
  const bai = {
    references: [
      { bins: [{ bin: 0, chunks: [{ beg: 1n << 16n, end: 2n << 16n }, { beg: 3n << 16n, end: 4n << 16n }, { beg: 5n << 16n, end: 6n << 16n }] }], linear: [], metadata: null },
      { bins: [{ bin: 0, chunks: [{ beg: 7n << 16n, end: 8n << 16n }] }], linear: [], metadata: null },
    ],
  };
  const points = collectStratifiedSamplingOffsets(bai, 4);
  assert.ok(points.some((p) => p.refId === 0));
  assert.ok(points.some((p) => p.refId === 1));
  assert.ok(points.every((p) => p.region));
});
