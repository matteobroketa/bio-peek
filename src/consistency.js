import { classifyFastq } from './dataset-resolver.js';

function role(result) {
  const info = classifyFastq(result.fileName || '');
  if (result.illumina?.read === 1 || info.role === 'r1') return 'r1';
  if (result.illumina?.read === 2 || info.role === 'r2') return 'r2';
  return null;
}

/** Compare independently sampled FASTQ layout with the BAM's inferred 10x layout. */
export function compareFastqBam(bam, fastqFiles = []) {
  if (!bam?.sample || bam.sample.assay?.label !== 'Single-cell RNA sequencing') return null;
  const r1 = fastqFiles.find((file) => role(file) === 'r1');
  const r2 = fastqFiles.find((file) => role(file) === 'r2');
  if (!r1 && !r2) return null;
  const checks = [];
  const add = (id, label, pass, note) => checks.push({ id, label, pass, note });
  const expectedR1 = bam.sample.assay.barcodeLength && bam.sample.assay.umiLength
    ? bam.sample.assay.barcodeLength + bam.sample.assay.umiLength : null;
  if (r1 && expectedR1) add('r1-layout', 'R1 barcode + UMI length', r1.medianLength === expectedR1, `FASTQ median ${r1.medianLength} bp; BAM CB+UB evidence implies ${expectedR1} bp.`);
  else add('r1-layout', 'R1 barcode + UMI length', null, 'BAM tag lengths or an R1 FASTQ were not available.');
  if (r2 && bam.sample.readLengthMedian) {
    const delta = Math.abs(r2.medianLength - bam.sample.readLengthMedian);
    add('r2-length', 'R2 aligned read length', delta <= 5, `FASTQ median ${r2.medianLength} bp; BAM aligned median ${bam.sample.readLengthMedian} bp.`);
  } else add('r2-length', 'R2 aligned read length', null, 'R2 FASTQ or BAM read length was not available.');
  const lanes = [r1, r2].filter(Boolean).map((file) => file.illumina?.lane).filter(Boolean);
  add('lane', 'Illumina lane agreement', lanes.length < 2 || new Set(lanes).size === 1, lanes.length < 2 ? 'Lane metadata was not available for both reads.' : `Observed lanes: ${[...new Set(lanes)].join(', ')}.`);
  return {
    status: checks.some((check) => check.pass === false) ? 'warn' : checks.some((check) => check.pass === true) ? 'pass' : 'limited',
    checks,
    limitation: 'FASTQ and BAM are independently sampled; this is a layout sanity check, not read-name pairing or a molecule-level concordance test.',
  };
}
