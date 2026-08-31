# Roadmap

## High-value next steps

1. **CSI support** for references that exceed BAI coordinate limits.
2. **Remote HTTP Range mode** for public/object-store BAM + BAI URLs when CORS permits range requests.
3. **CRAM metadata mode** with explicit semantics that do not pretend CRAI offers BAI-style idxstats counts.
4. **Worker pool sampling** for parallel BGZF windows on machines with spare cores.
5. **Stratified sampling** using reference-level BAI metadata to allocate sample points by mapped-record mass.
6. **10x chemistry hints** using a curated, versioned table and multiple signals rather than read length alone.
7. **FASTQ pair grouping** for multi-lane/multi-sample folders and aggregate lane summaries.
8. **Optional GTF/GFF3 input** for sampled exon/intron/intergenic classification on generic BAMs lacking `RE`.
9. **QC comparison mode** for multiple BAMs or multiple FASTQ pairs.
10. **Exportable preflight report** in JSON plus a compact standalone HTML report.

## Deliberately excluded from the first release

- Whole-file coverage metrics disguised as index metrics.
- Exact cell counts from a partial BAM sample.
- Full FastQC/Picard replacements.
- Server-side upload or storage.
