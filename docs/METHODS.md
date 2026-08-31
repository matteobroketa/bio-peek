# Methods and accuracy model

bio-peek is intentionally a **preflight inspector**, not a replacement for full sequencing QC. Its central rule is to separate complete metadata-derived facts from bounded record samples and from interpretation.

## BAM header

BAM is BGZF-compressed. bio-peek reads complete BGZF members from byte zero until enough uncompressed bytes exist to decode:

1. `BAM\\1` magic;
2. `l_text` and the SAM header text;
3. `n_ref`; and
4. every binary reference name and reference length.

The parser does not assume that the full BAM header fits in a single BGZF member.

Header lines are parsed for `@HD`, `@SQ`, `@RG`, `@PG` and `@CO`. The binary BAM reference list is used as the authoritative reference ordering for BAI joins.

## BGZF

For every BGZF member, bio-peek reads the gzip extra-field area and finds the `BC` subfield. `BSIZE + 1` gives the complete compressed member size. Only complete members are passed to `DecompressionStream('gzip')`.

A BAM virtual offset is interpreted as:

- high bits: compressed BGZF member byte offset;
- low 16 bits: uncompressed byte offset inside that member.

This is used for BAI-guided seeks.

## BAI exact counts

The BAI parser follows SAM/BAM v1. For each reference it parses normal bins, chunks, the linear index, and optional pseudo-bin `37450`.

Pseudo-bin `37450` is interpreted as two chunk-shaped pairs:

- `ref_beg`, `ref_end`;
- `n_mapped`, `n_unmapped`.

Here `n_unmapped` means **placed unmapped** records on that reference. If present, the optional trailing `n_no_coor` is added to obtain total unplaced + placed unmapped counts.

If the pseudo-bin or trailing field is absent, bio-peek reports the affected exact metric as unavailable rather than substituting an estimate.

## Distributed BAM sampling

The BAI is not treated as coverage data. Normal BAI chunk starts (with linear offsets as a fallback) are collected, deduplicated and ordered by compressed file position. A bounded set of seek points is chosen across that range.

At each seek point, bio-peek reads a bounded BGZF window and parses complete BAM records beginning at the indexed virtual offset. Duplicate sampled records caused by overlapping index chunks are removed using reference, position, read name and flag.

This gives broad file coverage for coordinate-sorted BAMs without claiming an exactly uniform random sample. Consequently, all metrics from these records are labeled **SAMPLED**.

## BAM record fields

The sampler decodes:

- reference ID and position;
- MAPQ;
- FLAG;
- sequence length;
- CIGAR operations (including `N` for splicing);
- selected auxiliary tags.

Selected auxiliary tags include `CB`, `CR`, `UB`, `UR`, `GX`, `GN`, `RE`, `RG`, `MM`, `mm`, `NH` and `xf`.

10x Cell Ranger documentation defines, among others:

- `CB`: corrected cell barcode;
- `UB`: corrected UMI;
- `GX`: compatible gene IDs;
- `GN`: compatible gene names;
- `RE`: region type (`E`, `N`, `I`).

Source: https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-bam

## Barcode knee

The barcode-rank curve is built only from sampled `CB` observations. Counts are sorted descending. The current exploratory knee heuristic searches for the maximum perpendicular distance from the endpoint chord in log-rank/log-count space after trimming unstable extremes.

This result is always **INFERRED**, never exact. It should be treated as an early visual estimate of dataset shape, not a Cell Ranger cell call.

## FASTQ

FASTQ has no equivalent of BAI summary metadata. bio-peek therefore streams a bounded number of conventional four-line FASTQ records.

For `.gz`, the browser stream is piped through `DecompressionStream('gzip')`. The reader is cancelled when the requested sample count has been reached.

Calculated sample metrics include:

- read-length histogram;
- Q20/Q30 base fractions (Phred+33);
- per-cycle mean quality;
- per-cycle A/C/G/T/N fractions;
- GC histogram;
- terminal poly-A/poly-G occurrence;
- Illumina adapter motif occurrence;
- observed sample duplication;
- cycle entropy.

The paired-read layout inference is intentionally conservative. Read lengths alone are insufficient to identify a specific 10x chemistry with certainty.

## FAI

A standard five-column FAI provides sequence name and length directly. Total sequence length, contig count, N50 and L50 are therefore exact arithmetic on the index itself.

## Integrity semantics

The BAM EOF check compares the final 28 bytes with the canonical empty BGZF member used as the BAM EOF marker. As with `samtools quickcheck`, this does not prove that the interior of a large BAM is uncorrupted.

## Primary specifications

- GA4GH / SAMtools HTS format specifications: https://samtools.github.io/hts-specs/
- SAM/BAM v1 / BAI specification: https://samtools.github.io/hts-specs/SAMv1.pdf
- 10x Cell Ranger BAM tags: https://www.10xgenomics.com/support/software/cell-ranger/latest/analysis/outputs/cr-outputs-bam
