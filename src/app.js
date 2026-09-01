import { renderResults, fileType } from './ui.js';
import { formatBytes } from './stats.js';
import { filesFromDataTransfer, hasFileDrag, isSupportedGenomicFile } from './file-ingest.js';

const APP_VERSION = '0.2.0';

const $ = (s) => document.querySelector(s);
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const browseBtn = $('#browseBtn');
const selectionPanel = $('#selectionPanel');
const fileChips = $('#fileChips');
const fileSummary = $('#fileSummary');
const analyzeBtn = $('#analyzeBtn');
const clearBtn = $('#clearBtn');
const progressPanel = $('#progressPanel');
const progressMessage = $('#progressMessage');
const progressValue = $('#progressValue');
const progressBytes = $('#progressBytes');
const cancelBtn = $('#cancelBtn');
const progressBar = $('#progressBar');
const resultsEl = $('#results');
const explainer = $('#emptyExplainer');
const demoBtn = $('#demoBtn');
let selected = new Map();
let mode = 'quick';
let worker = null;
let lastResult = null;

function key(file) { return `${file.name}|${file.size}|${file.lastModified}`; }

function addFiles(files) {
  for (const file of files) if (isSupportedGenomicFile(file.name)) selected.set(key(file), file);
  renderSelection();
}

function renderSelection() {
  const files = [...selected.values()];
  selectionPanel.classList.toggle('hidden', files.length === 0);
  if (!files.length) return;
  const total = files.reduce((n, f) => n + f.size, 0);
  fileSummary.textContent = `${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
  fileChips.innerHTML = files.map((f) => `<div class="file-chip"><b>${fileType(f.name)}</b><span class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><span>${formatBytes(f.size)}</span></div>`).join('');
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function clearAll() {
  selected.clear(); renderSelection();
  resultsEl.classList.add('hidden'); resultsEl.innerHTML = '';
  explainer.classList.remove('hidden'); progressPanel.classList.add('hidden');
  lastResult = null;
  if (worker) { worker.postMessage({ type: 'cancel' }); worker.terminate(); worker = null; }
  cancelBtn.disabled = false;
}

function openFilePicker() {
  // The Browse control uses native <label for=fileInput> activation. This
  // helper is only for keyboard activation and clicking the empty drop area.
  try {
    if (typeof fileInput.showPicker === 'function') { fileInput.showPicker(); return; }
  } catch {
    // Firefox currently lacks showPicker() for file inputs; click() remains a
    // user-gesture-safe fallback because this helper only runs from UI events.
  }
  fileInput.click();
}

// The label handles pointer activation natively. For keyboard users, prevent
// the label's browser-specific default and invoke the same picker path once.
browseBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(); }
});

dropzone.addEventListener('click', (e) => {
  if (e.target.closest('#browseBtn')) return;
  openFilePicker();
});

dropzone.addEventListener('keydown', (e) => {
  if (e.target !== dropzone || !['Enter', ' '].includes(e.key)) return;
  e.preventDefault();
  openFilePicker();
});

fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files || []));
  // Allow choosing the same file again after clearing/removing it.
  fileInput.value = '';
});

// Prevent Firefox/Windows (and other browsers) from navigating to a genomic
// file when it is dropped outside the target by mistake. Only intercept real
// file drags so ordinary page drag interactions are unaffected.
for (const type of ['dragenter', 'dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (hasFileDrag(e.dataTransfer)) e.preventDefault();
  }, { capture: true });
}

let dragDepth = 0;
dropzone.addEventListener('dragenter', (e) => {
  if (!hasFileDrag(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth += 1;
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragover', (e) => {
  if (!hasFileDrag(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', (e) => {
  if (!hasFileDrag(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  dropzone.classList.remove('dragover');
  addFiles(filesFromDataTransfer(e.dataTransfer));
});

clearBtn.addEventListener('click', clearAll);

document.querySelectorAll('.segment').forEach((btn) => btn.addEventListener('click', () => {
  mode = btn.dataset.mode;
  document.querySelectorAll('.segment').forEach((b) => b.classList.toggle('active', b === btn));
}));

function updateProgress(data) {
  progressPanel.classList.remove('hidden');
  progressMessage.textContent = data.message || 'Inspecting…';
  if (data.bytesRead != null) progressBytes.textContent = data.totalBytes ? `${formatBytes(data.bytesRead)} / ${formatBytes(data.totalBytes)}` : `${formatBytes(data.bytesRead)} read`;
  if (data.total && data.current != null) {
    const p = Math.max(0, Math.min(100, data.current / data.total * 100));
    progressBar.style.width = `${Math.max(4, p)}%`;
    progressValue.textContent = `${Math.round(p)}%`;
  } else {
    progressBar.style.width = '12%'; progressValue.textContent = '';
  }
}

cancelBtn.addEventListener('click', () => {
  if (!worker) return;
  cancelBtn.disabled = true;
  progressMessage.textContent = 'Canceling inspection…';
  worker.postMessage({ type: 'cancel' });
});

analyzeBtn.addEventListener('click', () => {
  const files = [...selected.values()];
  if (!files.length) return;
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  analyzeBtn.disabled = true; analyzeBtn.textContent = 'Inspecting…';
  cancelBtn.disabled = false;
  resultsEl.classList.add('hidden'); explainer.classList.add('hidden');
  updateProgress({ message: 'Preparing local file readers…' });
  worker.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'progress') updateProgress(data);
    if (data.type === 'done') {
      lastResult = data.result;
      progressBar.style.width = '100%'; progressValue.textContent = 'Done'; progressMessage.textContent = 'Preflight complete';
      renderResults(resultsEl, lastResult); resultsEl.classList.remove('hidden');
      bindExport();
      setTimeout(() => progressPanel.classList.add('hidden'), 650);
      analyzeBtn.disabled = false; analyzeBtn.textContent = 'Inspect files';
      cancelBtn.disabled = false;
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      worker.terminate(); worker = null;
    }
    if (data.type === 'cancelled') {
      progressMessage.textContent = 'Inspection canceled';
      progressValue.textContent = '';
      cancelBtn.disabled = false;
      analyzeBtn.disabled = false; analyzeBtn.textContent = 'Inspect files';
      worker?.terminate(); worker = null;
    }
    if (data.type === 'error') {
      progressMessage.textContent = `Inspection failed: ${data.message}`; progressValue.textContent = '';
      progressBar.style.width = '100%'; progressBar.style.background = '#a33b33';
      analyzeBtn.disabled = false; analyzeBtn.textContent = 'Inspect files';
      cancelBtn.disabled = false;
      worker?.terminate(); worker = null;
    }
  };
  worker.onerror = (e) => {
    progressMessage.textContent = `Worker error: ${e.message}`;
    analyzeBtn.disabled = false; analyzeBtn.textContent = 'Inspect files';
    cancelBtn.disabled = false;
  };
  worker.postMessage({ type: 'analyze', files, mode });
});

function bindExport() {
  const download = (name, body, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const btn = $('#exportJsonBtn');
  if (btn) btn.addEventListener('click', () => {
    const json = JSON.stringify(lastResult, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
    download(`bio-peek-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json');
  });
  const receipt = $('#exportReceiptBtn');
  if (receipt) receipt.addEventListener('click', () => download(`bio-peek-${new Date().toISOString().slice(0, 10)}-receipt.txt`, formatReceipt(lastResult), 'text/plain'));
}

function formatReceipt(result) {
  const lines = [`bio-peek ${APP_VERSION} analysis receipt`, `Generated: ${new Date().toISOString()}`, `Mode: ${result?.mode || 'unknown'}`, 'Scope: local file inspection; no upload', ''];
  lines.push('Files:');
  for (const file of result?.files || []) lines.push(`- ${file.name} (${formatBytes(file.size)})`);
  for (const bam of result?.bam || []) {
    const mapped = bam.index?.mapped == null ? 'unavailable' : String(bam.index.mapped);
    const sample = bam.sample;
    lines.push('', `BAM: ${bam.name}`, `- structural: ${bam.structuralStatus || (bam.eof ? 'pass' : 'review')}; sampling: ${bam.samplingStatus || 'unknown'}`, `- reference: ${bam.header?.referenceFingerprint?.label || bam.header?.referenceBuild?.label || 'unknown'}; EOF: ${bam.eof ? 'present' : 'missing'}`, `- mapped records (BAI metadata): ${mapped}`);
    if (sample) {
      lines.push(`- sampled records: ${sample.records}; strategy: ${sample.sampling?.strategy || 'unknown'}; convergence: ${sample.sampling?.converged ? 'converged' : 'not converged'}`, `- sampled MAPQ median: ${sample.mapqMedian ?? 'unavailable'}; read length median: ${sample.readLengthMedian ?? 'unavailable'}`, `- assay: ${sample.assay?.label || 'unknown'}${sample.assay?.chemistry ? `; chemistry: ${sample.assay.chemistry}` : ''}`, `- barcode knee: ${sample.knee ? `~${sample.knee.estimatedCells} (${sample.knee.confidence})` : 'unavailable'}`);
      for (const flag of sample.healthFlags || []) lines.push(`- QC ${flag.level === 'warn' ? 'review' : flag.level}: ${flag.label} — ${flag.note}`);
    }
    for (const warning of bam.warnings || []) lines.push(`- warning: ${warning}`);
    if (bam.sampleError) lines.push(`- sampling error: ${bam.sampleError}`);
    if (bam.consistency) lines.push(`- FASTQ↔BAM consistency: ${bam.consistency.status}; ${bam.consistency.limitation}`);
  }
  for (const fq of result?.fastq?.files || []) {
    lines.push('', `FASTQ: ${fq.fileName}`, `- sampling: ${fq.sampling?.strategy || 'unknown'}; reads: ${fq.reads ?? 'unavailable'}; median length: ${fq.medianLength ?? 'unavailable'} bp`, `- Q30: ${fq.q30 == null ? 'unavailable' : `${(fq.q30 * 100).toFixed(1)}%`}; malformed records: ${fq.integrity?.malformedRecords ?? 'unavailable'}; quality: ${fq.integrity?.qualityEncoding || 'unavailable'}`);
    if (fq.error) lines.push(`- error: ${fq.error}`);
  }
  lines.push('', 'Interpretation: sampled estimates are bounded and uncertainty/limitations are retained in the JSON export. Sampled metrics are estimates, not full-file QC.');
  return `${lines.join('\n')}\n`;
}

function demoResult() {
  const refs = [
    { name:'chr1', length:248956422, mapped:65500000n, placedUnmapped:210000n },
    { name:'chr2', length:242193529, mapped:51200000n, placedUnmapped:180000n },
    { name:'chr3', length:198295559, mapped:41000000n, placedUnmapped:150000n },
    { name:'chrM', length:16569, mapped:30200000n, placedUnmapped:12000n },
  ];
  const barcodeRank = Array.from({length:2500}, (_,i) => ({ rank:i+1, barcode:`CELL${i+1}`, count:Math.max(1, Math.round(1600 / Math.pow(i+1,.42) * (i < 820 ? 1 : .18))) }));
  const cycles1 = Array.from({length:28},(_,i)=>({cycle:i+1,meanQ:36-i*.08,A:.24+(i%5)*.005,C:.25,G:.26-(i%4)*.004,T:.25,N:.001}));
  const cycles2 = Array.from({length:91},(_,i)=>({cycle:i+1,meanQ:36-i*.055,A:.27,C:.23,G:.24,T:.26,N:.001}));
  return {
    mode:'quick', files:[{name:'possorted_genome_bam.bam',size:49_600_000_000},{name:'possorted_genome_bam.bam.bai',size:9_100_000},{name:'sample_R1.fastq.gz',size:3_100_000_000},{name:'sample_R2.fastq.gz',size:8_600_000_000}],
    bam:[{kind:'bam',name:'possorted_genome_bam.bam',size:49_600_000_000,eof:true,warnings:[],header:{text:'@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:248956422\n@RG\tID:sample\tSM:PBMC_01\tPL:ILLUMINA\n@PG\tID:cellranger\tPN:cellranger\tVN:10.1',fields:{HD:{VN:'1.6',SO:'coordinate'},RG:[{ID:'sample',SM:'PBMC_01',PL:'ILLUMINA',LB:'Gene Expression'}],PG:[{ID:'cellranger',PN:'cellranger',VN:'10.1'}]},references:refs.map(({name,length})=>({name,length})),referenceBuild:{label:'GRCh38 / hg38',confidence:'high',naming:'chr-prefixed'}},index:{name:'possorted_genome_bam.bam.bai',hasMetadataCounts:true,mapped:412700000n,totalUnmapped:25400000n,placedUnmapped:1800000n,noCoordinate:23600000n,perReference:refs},sample:{records:40000,mapqMedian:255,readLengthMedian:91,flags:{mapped:38900,unmapped:1100,paired:39800,properPair:35500,duplicate:16200,secondary:290,supplementary:530},spliced:23100,tagPresence:{CB:.963,UB:.917,GX:.881,GN:.879,RE:.954},regions:{E:24800,N:12400,I:2000},uniqueBarcodesObserved:12840,uniqueMoleculesObserved:28400,uniqueGenesObserved:17820,topGenes:[['MALAT1',2100],['RPLP0',1300],['B2M',980],['IL32',840],['LTB',790],['RPS18',760]],barcodeRank,knee:{estimatedCells:8120,thresholdReads:7,confidence:'medium'},multimappedTag:1280,assay:{label:'Single-cell RNA sequencing',confidence:'high'}}}],
    fastq:{pairInference:{label:'10x-like barcode/UMI + cDNA layout',confidence:'medium',r1:'sample_R1.fastq.gz',r2:'sample_R2.fastq.gz',note:'Read 1 is 28 bp and Read 2 is cDNA-like; chemistry is not asserted from length alone.'},files:[
      {fileName:'sample_R1.fastq.gz',size:3_100_000_000,gzip:true,reads:50000,totalBases:1400000,medianLength:28,q20:.992,q30:.968,nFraction:.0004,duplicationObserved:.081,uniqueSequences:45950,adapterFraction:.0002,polyAFraction:.001,polyGFraction:.0008,meanCycleEntropy:1.82,topSequences:[],illumina:{instrument:'A01234',lane:1,read:1},firstHeader:'@A01234:123:H7V5MDSX2:1:1101:1000:1000 1:N:0:ACGT',perCycle:cycles1},
      {fileName:'sample_R2.fastq.gz',size:8_600_000_000,gzip:true,reads:50000,totalBases:4550000,medianLength:91,q20:.986,q30:.944,nFraction:.0007,duplicationObserved:.057,uniqueSequences:47150,adapterFraction:.004,polyAFraction:.015,polyGFraction:.001,meanCycleEntropy:1.98,topSequences:[],illumina:{instrument:'A01234',lane:1,read:2},firstHeader:'@A01234:123:H7V5MDSX2:1:1101:1000:1000 2:N:0:ACGT',perCycle:cycles2}
    ]},fai:[]
  };
}

demoBtn.addEventListener('click', () => {
  lastResult = demoResult();
  renderResults(resultsEl, lastResult); resultsEl.classList.remove('hidden'); explainer.classList.add('hidden'); bindExport();
  resultsEl.scrollIntoView({ behavior:'smooth', block:'start' });
});
