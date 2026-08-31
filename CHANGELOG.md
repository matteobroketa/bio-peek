# Changelog

## 0.1.1

- Reworked local file selection for Firefox/Windows compatibility.
- Replaced the `hidden` file input with an accessible visually-hidden native input.
- Browse now uses native `<label for>` activation instead of depending on a programmatic click.
- Added Firefox-safe drag/drop extraction via `DataTransferItem.getAsFile()` with `DataTransfer.files` fallback.
- Prevented accidental browser navigation when genomic files are dropped outside the target.
- Added drag-depth handling to prevent nested dropzone elements from flickering/removing the active state.
- Restricted accepted extensions to BAM, BAI, FAI, FASTQ/FQ, and FASTQ/FQ.GZ.
- Added ingestion regression tests.

## 0.1.0 — 2026-08-31

- Initial zero-upload browser release.
- BAM header and canonical EOF parsing.
- Direct BAI parser with metadata pseudo-bin counts.
- Distributed BAI-guided BAM record sampling.
- scRNA tag interpretation (`CB`, `UB`, `GX`, `GN`, `RE`, etc.).
- Barcode-rank visualization and preliminary knee inference.
- FASTQ/FASTQ.GZ bounded streaming QC.
- FAI exact summary metrics including N50/L50.
- Quick and deep sampling modes.
- JSON export, synthetic demo, automated binary-parser tests and GitHub Pages workflow.
