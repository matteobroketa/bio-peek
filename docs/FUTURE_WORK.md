# Possible future work

1. **CSI support** for references that exceed BAI coordinate limits.
2. **Remote HTTP Range mode** for public/object-store BAM + BAI URLs when CORS permits range requests.
3. **CRAM metadata mode**; CRAI does not provide BAI-style idxstats counts.
4. **Worker pool sampling** for parallel BGZF windows on machines with spare cores.
5. **Sampling calibration** on additional public datasets and externally validated probability models.
6. **10x chemistry hints** using a curated, versioned table and multiple signals rather than read length alone.
7. **FASTQ aggregate validation** for multi-lane/multi-sample summaries; current file-level sampling is distributed for uncompressed FASTQ and explicitly labeled for gzip.
8. **Optional GTF/GFF3 input** for sampled exon/intron/intergenic classification on generic BAMs lacking `RE`.
9. **Standalone HTML report** with embedded receipt metadata.
10. **Additional public-dataset validation** beyond PBMC v3.

## Out of scope

- Whole-file coverage estimates derived only from index structure.
- Exact cell counts from a partial BAM sample.
- Full FastQC/Picard replacements.
- Server-side upload or storage.
