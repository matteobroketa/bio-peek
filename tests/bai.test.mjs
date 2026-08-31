import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBai, summarizeBai, collectSamplingOffsets } from '../src/bai.js';

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

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
