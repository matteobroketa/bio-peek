export function isSupportedGenomicFile(name) {
  return /\.(?:bam|bai|fai)$/i.test(name) || /\.(?:fastq|fq)(?:\.gz)?$/i.test(name);
}

export function hasFileDrag(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.includes('Files') || types.includes('application/x-moz-file');
}

export function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];

  // Firefox and Chromium both expose DataTransferItem#getAsFile for ordinary
  // desktop file drags. Prefer it because DataTransfer.files can be empty in
  // some drag phases / platform combinations.
  const itemFiles = Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => {
      try { return item.getAsFile(); } catch { return null; }
    })
    .filter(Boolean);

  if (itemFiles.length) return itemFiles;
  return Array.from(dataTransfer.files || []);
}
