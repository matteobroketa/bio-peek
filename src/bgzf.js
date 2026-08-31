const textDecoder = new TextDecoder();

export function parseBgzfBlockSize(header) {
  const bytes = header instanceof Uint8Array ? header : new Uint8Array(header);
  if (bytes.length < 18) throw new Error('Truncated BGZF header');
  if (bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8 || (bytes[3] & 4) === 0) {
    throw new Error('Not a BGZF/gzip block');
  }
  const xlen = bytes[10] | (bytes[11] << 8);
  if (bytes.length < 12 + xlen) throw new Error('Need more BGZF header bytes');
  let p = 12;
  const end = 12 + xlen;
  while (p + 4 <= end) {
    const si1 = bytes[p];
    const si2 = bytes[p + 1];
    const slen = bytes[p + 2] | (bytes[p + 3] << 8);
    p += 4;
    if (p + slen > end) throw new Error('Malformed BGZF extra field');
    if (si1 === 66 && si2 === 67 && slen === 2) {
      const bsize = bytes[p] | (bytes[p + 1] << 8);
      return bsize + 1;
    }
    p += slen;
  }
  throw new Error('Gzip member is not BGZF (BC field missing)');
}

export async function gunzipMember(arrayBuffer) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser does not provide DecompressionStream; BGZF/FASTQ.gz cannot be read locally.');
  }
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readOneBgzfBlock(file, compressedOffset) {
  if (compressedOffset >= file.size) return null;
  const headerBuf = await file.slice(compressedOffset, Math.min(file.size, compressedOffset + 256)).arrayBuffer();
  const header = new Uint8Array(headerBuf);
  const blockSize = parseBgzfBlockSize(header);
  if (compressedOffset + blockSize > file.size) throw new Error('Truncated BGZF block at end of file');
  const blockBuf = await file.slice(compressedOffset, compressedOffset + blockSize).arrayBuffer();
  const data = await gunzipMember(blockBuf);
  return { compressedOffset, blockSize, data };
}

export async function readBgzfWindow(file, compressedOffset, {
  maxCompressedBytes = 2 * 1024 * 1024,
  maxBlocks = 64,
  maxUncompressedBytes = 4 * 1024 * 1024,
} = {}) {
  const blocks = [];
  let pos = compressedOffset;
  let compressedRead = 0;
  let uncompressedRead = 0;

  while (
    pos < file.size &&
    blocks.length < maxBlocks &&
    compressedRead < maxCompressedBytes &&
    uncompressedRead < maxUncompressedBytes
  ) {
    const block = await readOneBgzfBlock(file, pos);
    if (!block) break;
    blocks.push(block);
    pos += block.blockSize;
    compressedRead += block.blockSize;
    uncompressedRead += block.data.length;
    if (block.data.length === 0) break;
  }

  const combined = new Uint8Array(uncompressedRead);
  let offset = 0;
  for (const block of blocks) {
    combined.set(block.data, offset);
    offset += block.data.length;
  }
  return { blocks, data: combined, nextCompressedOffset: pos };
}

export function concatUint8(parts) {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export function decodeAscii(bytes) {
  return textDecoder.decode(bytes);
}
