# PBMC v3 golden fixture

This fixture is derived from the official [1k PBMC v3 dataset](https://www.10xgenomics.com/datasets/1-k-pbm-cs-from-a-healthy-donor-v-3-chemistry-3-standard-3-0-0). The dataset is a 3′ single-cell library with 28 bp R1, 91 bp R2 and an 8 bp I7 read; the published Cell Ranger result reports 1,222 detected cells.

Download the original `pbmc_1k_v3_possorted_genome_bam.bam` and the two lane pairs (`L001` and `L002`) of R1/R2 FASTQs into `source/` (or `source/pbmc_1k_v3_fastqs/`), then run:

```bash
npm run golden:pbmc
```

The script derives an indexed mini-BAM and deterministic 10,000-read FASTQ samples using `samtools` and `seqkit`, records `samtools idxstats`, and optionally records `seqkit stats`, `fastp` and a local `web_summary.json`. The expected chemistry and explicit comparison tolerances live in `expected.json`; generated data is intentionally not committed.

After exporting a bio-peek result for the generated mini files as `bio-peek.json`, compare it with:

```bash
npm run golden:compare -- --bio-peek-json bio-peek.json
```

The comparison checks R1/R2 lengths, per-reference mapped counts against the mini-BAM’s `samtools idxstats`, and the bounded cell-associated estimate against the published Cell Ranger result using the tolerances in `expected.json`.
