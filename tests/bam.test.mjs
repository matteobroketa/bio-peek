import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readBamHeader, checkBamEof, sampleBam, validateBamIndex } from '../src/bam.js';

const EOF_BLOCK = Buffer.from([0x1f,0x8b,0x08,0x04,0,0,0,0,0,0xff,0x06,0,0x42,0x43,0x02,0,0x1b,0,0x03,0,0,0,0,0,0,0,0,0]);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function bgzf(data) {
  const deflated = deflateRawSync(data);
  const total = 18 + deflated.length + 8;
  assert.ok(total <= 65536);
  const h = Buffer.from([0x1f,0x8b,0x08,0x04,0,0,0,0,0,0xff,0x06,0,0x42,0x43,0x02,0,0,0]);
  h.writeUInt16LE(total - 1, 16);
  const t = Buffer.alloc(8); t.writeUInt32LE(crc32(data),0); t.writeUInt32LE(data.length >>> 0,4);
  return Buffer.concat([h, deflated, t]);
}
function i32(n) { const b=Buffer.alloc(4); b.writeInt32LE(n); return b; }
function u32(n) { const b=Buffer.alloc(4); b.writeUInt32LE(n>>>0); return b; }
function ztag(tag, value) { return Buffer.concat([Buffer.from(tag), Buffer.from('Z'), Buffer.from(value), Buffer.from([0])]); }
function atag(tag, value) { return Buffer.concat([Buffer.from(tag), Buffer.from('A'), Buffer.from(value)]); }
function bamRecord(name='read1') {
  const rn = Buffer.from(`${name}\0`);
  const lSeq = 50;
  const cigar = u32(50 << 4); // 50M
  const seq = Buffer.alloc(Math.ceil(lSeq/2), 0x11);
  const qual = Buffer.alloc(lSeq, 35);
  const aux = Buffer.concat([ztag('CB','AAACCCAAGGAGAGTA-1'),ztag('UB','ACGTACGTACGT'),ztag('GX','ENSG000001'),ztag('GN','GENE1'),atag('RE','E')]);
  const core = Buffer.concat([
    i32(0), i32(100), u32((0 << 16) | (255 << 8) | rn.length), u32((0 << 16) | 1),
    i32(lSeq), i32(-1), i32(-1), i32(0), rn, cigar, seq, qual, aux,
  ]);
  return Buffer.concat([i32(core.length), core]);
}
function makeBam() {
  const text = Buffer.from('@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:248956422\n@RG\tID:rg1\tSM:S1\n@PG\tID:cellranger\tPN:cellranger\n');
  const refName = Buffer.from('chr1\0');
  const header = Buffer.concat([Buffer.from([66,65,77,1]), i32(text.length), text, i32(1), i32(refName.length), refName, i32(248956422)]);
  const record = bamRecord();
  const block = bgzf(Buffer.concat([header, record]));
  const file = new File([block, EOF_BLOCK], 'test.bam');
  return { file, headerLength: header.length };
}

test('reads BAM header and canonical EOF marker', async () => {
  const { file } = makeBam();
  const h = await readBamHeader(file);
  assert.equal(h.references[0].name, 'chr1');
  assert.equal(h.fields.HD.SO, 'coordinate');
  assert.equal(h.fields.RG[0].SM, 'S1');
  assert.equal(h.referenceBuild.label, 'GRCh38 / hg38');
  assert.equal(await checkBamEof(file), true);
});

test('samples a BAM record from a BAI virtual seek point and parses scRNA tags', async () => {
  const { file, headerLength } = makeBam();
  const h = await readBamHeader(file);
  const vo = BigInt(headerLength); // compressed offset 0, uncompressed offset = BAM body start
  const bai = { references:[{ bins:[{bin:0,chunks:[{beg:vo,end:vo+100n}]}], linear:[vo], metadata:null }], noCoordinate:null };
  const s = await sampleBam(file, bai, h, { targetRecords:1, samplePoints:1 });
  assert.equal(s.records, 1);
  assert.equal(s.mapqMedian, 255);
  assert.equal(s.uniqueBarcodesObserved, 1);
  assert.equal(s.uniqueMoleculesObserved, 1);
  assert.equal(s.regions.E, 1);
  assert.equal(s.assay.label, 'Single-cell RNA sequencing');
  assert.equal(s.sampling.strategy, 'reference- and index-region-stratified BAI sample');
  assert.ok(s.uncertainty.regions.E.margin >= 0);
  assert.equal(s.barcodeShape.readsPerBarcodeMedian, 1);
});

test('rejects an index whose virtual offset is outside the BAM', async () => {
  const { file } = makeBam();
  const h = await readBamHeader(file);
  const bad = { references: [{ bins: [{ bin: 0, chunks: [{ beg: 999n << 16n, end: 1000n << 16n }] }], linear: [], metadata: null }], noCoordinate: null };
  await assert.rejects(() => validateBamIndex(file, bad, h), /beyond the BAM/);
});
