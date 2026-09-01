# Roadmap

## v0.2 scientific hardening

- Reference/index-region stratified BAM sampling with represented-strata accounting.
- Progressive Deep-mode convergence history and sampled-proportion uncertainty margins.
- Distributed uncompressed FASTQ byte-range sampling plus explicit gzip-prefix semantics and format integrity checks.
- Bounded per-barcode reads/UMI/gene/mitochondrial sketches.
- Worker-stack cancellation, byte-read progress and bounded parser state.
- Reproducible PBMC v3 golden-fixture generator under `scripts/golden-pbmc-v3.mjs`.
- Reference fingerprints, heuristic library-health flags and FASTQ↔BAM layout consistency checks.
- Human-readable analysis receipt export and multi-BAM comparison table.

## High-value next steps

1. **CSI support** for references that exceed BAI coordinate limits.
2. **Remote HTTP Range mode** for public/object-store BAM + BAI URLs when CORS permits range requests.
3. **CRAM metadata mode** with explicit semantics that do not pretend CRAI offers BAI-style idxstats counts.
4. **Worker pool sampling** for parallel BGZF windows on machines with spare cores.
5. **Sampling calibration** on additional public datasets and externally validated probability models.
6. **10x chemistry hints** using a curated, versioned table and multiple signals rather than read length alone.
7. **FASTQ aggregate validation** for multi-lane/multi-sample summaries; current file-level sampling is distributed for uncompressed FASTQ and explicitly labeled for gzip.
8. **Optional GTF/GFF3 input** for sampled exon/intron/intergenic classification on generic BAMs lacking `RE`.
9. **Standalone HTML report** with embedded receipt metadata.
10. **Additional public-dataset validation** beyond PBMC v3.

## Deliberately excluded from the first release

- Whole-file coverage metrics disguised as index metrics.
- Exact cell counts from a partial BAM sample.
- Full FastQC/Picard replacements.
- Server-side upload or storage.
