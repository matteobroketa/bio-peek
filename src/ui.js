import { formatBytes, formatCount } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x, digits = 1) => x == null || !Number.isFinite(Number(x)) ? '—' : `${(Number(x) * 100).toFixed(digits)}%`;
const num = (x) => x == null ? '—' : formatCount(x);
const bigToNumber = (x) => x == null ? null : Number(x);

function badge(type) { return `<span class="metric-badge ${type}">${type.toUpperCase()}</span>`; }
function metric(label, value, type, sub = '') {
  return `<div class="metric-card"><div class="metric-top"><span class="metric-label">${esc(label)}</span>${badge(type)}</div><div class="metric-value">${esc(value)}</div>${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ''}</div>`;
}
function confidence(c) { return `<span class="confidence">${esc(String(c || 'low').toUpperCase())} CONFIDENCE · INFERRED</span>`; }

function barList(entries, total, labelMap = {}, uncertainty = {}) {
  const rows = entries.filter(([, v]) => v > 0);
  if (!rows.length) return '<div class="metric-sub">No observations in sample.</div>';
  const max = Math.max(...rows.map(([, v]) => v));
  return `<div class="bar-list">${rows.map(([k, v]) => { const u = uncertainty[k] || uncertainty[k.toLowerCase()]; const value = total ? `${pct(v / total)}${u?.margin != null ? ` ±${pct(u.margin)}` : ''}` : num(v); return `<div class="bar-row"><label title="${esc(labelMap[k] || k)}">${esc(labelMap[k] || k)}</label><div class="bar-bg"><div class="bar-fill" style="width:${Math.max(1, v / max * 100).toFixed(2)}%"></div></div><output>${esc(value)}</output></div>`; }).join('')}</div>`;
}

function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function healthMarkup(flags = []) {
  if (!flags.length) return '<div class="metric-sub">Health flags become available after a successful BAM sample.</div>';
  return `<div class="health-list">${flags.map((flag) => `<div class="health-row"><span class="status ${flag.level === 'good' ? 'good' : 'warn'}">${flag.level === 'good' ? '✓' : '!'}</span><div><strong>${esc(flag.label)}</strong><span>${esc(flag.note)}</span></div></div>`).join('')}</div>`;
}

function bamPanel(bam, index) {
  const h = bam.header;
  const idx = bam.index;
  const s = bam.sample;
  const samplingFailed = bam.samplingStatus === 'failed';
  const samplingUnavailable = bam.samplingStatus === 'unavailable';
  const mapped = bigToNumber(idx?.mapped);
  const unmapped = bigToNumber(idx?.totalUnmapped);
  const total = mapped != null && unmapped != null ? mapped + unmapped : null;
  const mappedFraction = total ? mapped / total : null;
  const perRef = idx?.perReference || [];
  const mito = perRef.find((r) => /^(?:chrM|MT|M)$/i.test(r.name));
  const mitoFraction = mapped && mito?.mapped != null ? Number(mito.mapped) / mapped : null;
  const samples = [...new Set((h.fields.RG || []).map((r) => r.SM).filter(Boolean))];
  const libs = [...new Set((h.fields.RG || []).map((r) => r.LB).filter(Boolean))];
  const programs = (h.fields.PG || []).map((p) => p.PN || p.ID).filter(Boolean);
  const assay = s?.assay || { label: 'scRNA interpretation unavailable', confidence: 'low' };
  const fingerprint = h.referenceFingerprint;
  const knee = s?.knee;
  const regionLabels = { E: 'Exonic', N: 'Intronic', I: 'Intergenic' };
  const regionEntries = s ? Object.entries(s.regions || {}) : [];
  const refRows = perRef
    .slice()
    .sort((a, b) => Number(b.mapped || 0n) - Number(a.mapped || 0n))
    .slice(0, 40)
    .map((r) => [r.name, num(r.length), r.mapped == null ? '—' : num(r.mapped), r.placedUnmapped == null ? '—' : num(r.placedUnmapped)]);

  return `<article class="panel">
    <div class="panel-head">
      <div class="panel-title"><span class="file-type">BAM</span><div>${bam.datasetLabel ? `<div class="section-kicker">${esc(bam.datasetLabel)}</div>` : ''}<h3>${esc(bam.name)}</h3><p>${formatBytes(bam.size)}${idx ? ` · ${esc(idx.name)}` : ' · no BAI supplied'}</p></div></div>
      <span class="status ${bam.eof ? 'good' : 'warn'}">${bam.eof ? 'EOF marker present' : 'EOF marker missing'}</span>
    </div>
    <div class="panel-body">
      <div class="status-strip"><span class="status good">Structural ✓</span><span class="status ${samplingFailed ? 'warn' : samplingUnavailable ? 'warn' : 'good'}">Sampling ${samplingFailed ? '✕ FAILED' : samplingUnavailable ? '— UNAVAILABLE' : '✓'}</span><span class="status ${s?.assay?.label === 'Single-cell RNA sequencing' ? 'good' : 'warn'}">${s?.assay?.label === 'Single-cell RNA sequencing' ? 'scRNA interpretation ✓' : 'scRNA interpretation unavailable'}</span></div>
      <div class="callout"><div><strong>${esc(assay.label)}${assay.platform ? ` · ${esc(assay.platform)}` : ''}</strong><span>${esc(h.referenceBuild?.label || 'Unknown reference')} · ${esc(h.fields.HD?.SO || 'sort order unknown')}${samples.length ? ` · sample ${esc(samples.join(', '))}` : ''}</span>${assay.chemistry ? `<span class="evidence-line">Chemistry: ${esc(assay.chemistry)} · evidence: ${esc((assay.evidence || []).join(', ') || 'none recorded')}</span>` : ''}</div>${s ? confidence(assay.confidence) : '<span class="status warn">UNAVAILABLE</span>'}</div>
      <div class="metric-grid">
        ${metric('Mapped records', mapped == null ? '—' : num(mapped), 'exact', idx?.hasMetadataCounts ? 'BAI metadata pseudo-bin' : 'BAI counts unavailable')}
        ${metric('Mapped fraction', mappedFraction == null ? '—' : pct(mappedFraction), 'exact', total ? `${num(total)} total indexed records` : 'requires BAI metadata counts')}
        ${metric('Mitochondrial fraction', mitoFraction == null ? '—' : pct(mitoFraction), 'exact', mito ? `${mito.name} mapped / all mapped` : 'mitochondrial contig not recognized')}
        ${metric('Reference sequences', num(h.references.length), 'exact', h.referenceBuild?.naming || '')}
        ${metric('Median MAPQ', samplingFailed ? 'FAILED' : s ? num(s.mapqMedian) : '—', 'sampled', samplingFailed ? bam.sampleError : s ? `${num(s.records)} records · ${s.sampling?.strategy || 'stratified sample'}` : 'sample unavailable')}
        ${metric('Read length', samplingFailed ? 'FAILED' : s ? `${num(s.readLengthMedian)} bp` : '—', 'sampled', samplingFailed ? 'sampling did not produce a trustworthy estimate' : 'median sampled aligned read length')}
        ${metric('Cell barcodes seen', samplingFailed ? 'FAILED' : s ? num(s.uniqueBarcodesObserved) : '—', 'sampled', samplingFailed ? 'sampling did not produce a trustworthy estimate' : s?.tagPresence?.CB ? `${pct(s.tagPresence.CB)} of records carry CB` : 'CB not detected')}
        ${metric('Cell-associated knee', samplingFailed ? 'FAILED' : knee ? `~${num(knee.estimatedCells)}` : '—', 'inferred', samplingFailed ? 'scRNA interpretation unavailable because sampling failed' : knee ? `sample barcode rank · ${knee.confidence} confidence` : 'insufficient barcode-rank signal')}
      </div>

      ${s ? `<div class="grid-2">
        <div class="viz-card"><div class="viz-head"><strong>Barcode rank</strong><span>${badge('sampled')} knee is ${badge('inferred')}</span></div><canvas class="chart barcode-chart" data-bam-index="${index}"></canvas></div>
        <div class="viz-card"><div class="viz-head"><strong>Alignment region</strong><span>${num(s.records)} sampled records · 95% Wilson margin</span></div>${barList(regionEntries, s.records, regionLabels, s.uncertainty?.regions)}</div>
        <div class="viz-card"><div class="viz-head"><strong>Read flags / structure</strong><span>${badge('sampled')}</span></div>${barList([
          ['Duplicate', s.flags.duplicate], ['Secondary', s.flags.secondary], ['Supplementary', s.flags.supplementary], ['Spliced', s.spliced], ['Paired', s.flags.paired]
        ], s.records, {}, s.uncertainty?.flags)}</div>
        <div class="viz-card"><div class="viz-head"><strong>Top assigned genes</strong><span>GN or GX tags</span></div>${barList(s.topGenes || [], null)}</div>
        <div class="viz-card"><div class="viz-head"><strong>Barcode data shape</strong><span>${badge('sampled')}</span></div><div class="metric-sub">${s.barcodeShape ? `${num(s.barcodeShape.retainedBarcodes)} barcodes retained · ${num(s.barcodeShape.readsPerBarcodeMedian)} reads/barcode · ${num(s.barcodeShape.umisPerBarcodeMedian)} UMIs/barcode · ${num(s.barcodeShape.genesPerBarcodeMedian)} genes/barcode` : 'Barcode sketches unavailable.'}</div>${s.barcodeShape ? `<div class="metric-sub">Preliminary cell-associated medians: ${num(s.barcodeShape.cellAssociatedReadsPerBarcodeMedian)} reads · ${num(s.barcodeShape.cellAssociatedUmisPerBarcodeMedian)} UMIs · ${num(s.barcodeShape.cellAssociatedGenesPerBarcodeMedian)} genes/barcode · mitochondrial ${pct(s.barcodeShape.mitochondrialFractionMedian)} (P25–P75 ${pct(s.barcodeShape.mitochondrialFractionQuartiles?.[0])}–${pct(s.barcodeShape.mitochondrialFractionQuartiles?.[2])}) · ambient tail ${pct(s.barcodeShape.ambientTailFraction)}</div>` : ''}</div>
        <div class="viz-card"><div class="viz-head"><strong>Sampling convergence</strong><span>${s.convergence?.length || 0} batches · ${s.sampling?.converged ? 'stable' : 'still moving'}</span></div><div class="metric-sub">${s.convergence?.length > 1 ? `${s.sampling?.strategy}; ${s.sampling?.converged ? 'key metrics stabilized' : 'key metrics were still moving at the sample limit'}` : 'Single bounded sample; enable Deep mode for progressive convergence.'}</div>${s.convergence?.length > 1 ? table(['Records', 'MAPQ median', 'Exonic', 'Barcode rate'], s.convergence.map((x) => [num(x.records), num(x.mapqMedian), pct(x.exonicFraction), pct(x.barcodeRate)])) : ''}</div>
        <div class="viz-card"><div class="viz-head"><strong>Library health flags</strong><span>${badge('inferred')}</span></div>${healthMarkup(s.healthFlags)}</div>
      </div>` : ''}

      ${fingerprint ? `<div class="viz-card" style="margin-top:12px"><div class="viz-head"><strong>Reference fingerprint</strong><span>${badge('exact')}</span></div><div class="metric-sub">${esc(fingerprint.label)} · ${esc(fingerprint.naming)} · ${num(fingerprint.referenceCount)} sequences · primary set ${num(fingerprint.primaryCount)}${fingerprint.expectedPrimary ? `/${num(fingerprint.expectedPrimary)}` : ''} · mitochondrial ${esc(fingerprint.mitochondrial || 'not recognized')} · ALT/decoy ${num(fingerprint.altDecoyCount)}</div>${fingerprint.smallUnusual?.length || fingerprint.altDecoy?.length ? `<div class="metric-sub">Unexpected/special contigs: ${esc([...(fingerprint.altDecoy || []), ...(fingerprint.smallUnusual || [])].join(', '))}</div>` : ''}</div>` : ''}
      ${refRows.length ? `<div class="viz-card" style="margin-top:12px"><div class="viz-head"><strong>Reference shape</strong><span>${badge('exact')} ${refRows.length < perRef.length ? `top ${refRows.length} of ${perRef.length}` : `${perRef.length} references`}</span></div>${table(['Reference', 'Length', 'Mapped', 'Placed unmapped'], refRows)}</div>` : ''}
      ${bam.consistency ? `<div class="viz-card" style="margin-top:12px"><div class="viz-head"><strong>FASTQ ↔ BAM consistency</strong><span class="status ${bam.consistency.status === 'pass' ? 'good' : 'warn'}">${esc(bam.consistency.status)}</span></div>${table(['Check', 'Result', 'Note'], bam.consistency.checks.map((check) => [check.label, check.pass === true ? 'pass' : check.pass === false ? 'review' : 'limited', check.note]))}<div class="metric-sub">${esc(bam.consistency.limitation)}</div></div>` : ''}
      ${bam.warnings?.length ? `<ul class="warning-list">${bam.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <details><summary>Header metadata and provenance</summary><div class="metric-sub" style="margin:10px 0">Read groups: ${esc(samples.join(', ') || 'none')} · libraries: ${esc(libs.join(', ') || 'none')} · programs: ${esc(programs.join(' → ') || 'none')}</div><pre>${esc(h.text)}</pre></details>
    </div>
  </article>`;
}

function fastqPanel(fq, index) {
  if (fq.error) return `<article class="panel"><div class="panel-head"><div class="panel-title"><span class="file-type">FASTQ</span><div>${fq.datasetLabel ? `<div class="section-kicker">${esc(fq.datasetLabel)}</div>` : ''}<h3>${esc(fq.fileName)}</h3><p>${formatBytes(fq.size)}</p></div></div><span class="status warn">Could not sample</span></div><div class="panel-body"><ul class="warning-list"><li>${esc(fq.error)}</li></ul></div></article>`;
  return `<article class="panel">
    <div class="panel-head"><div class="panel-title"><span class="file-type">FASTQ</span><div>${fq.datasetLabel ? `<div class="section-kicker">${esc(fq.datasetLabel)}</div>` : ''}<h3>${esc(fq.fileName)}</h3><p>${formatBytes(fq.size)} · ${fq.gzip ? 'gzip compressed' : 'uncompressed'} · ${num(fq.reads)} reads sampled</p></div></div><span class="status good">${esc(fq.sampling?.strategy || 'Local sample')}</span></div>
    <div class="panel-body">
      <div class="metric-grid">
        ${metric('Median read length', `${num(fq.medianLength)} bp`, 'sampled')}
        ${metric('Q30 bases', pct(fq.q30), 'sampled', `Q20 ${pct(fq.q20)}`)}
        ${metric('Observed duplicates', pct(fq.duplicationObserved), 'sampled', 'within sampled sequences only')}
        ${metric('N bases', pct(fq.nFraction), 'sampled')}
        ${metric('Adapter motif', pct(fq.adapterFraction), 'sampled', 'AGATCGGAAGAGC observed')}
        ${metric('Poly-G tails', pct(fq.polyGFraction), 'sampled', '≥12 terminal G bases')}
        ${metric('Cycle entropy', fq.meanCycleEntropy == null ? '—' : fq.meanCycleEntropy.toFixed(2), 'sampled', '0–2 bits across A/C/G/T')}
        ${metric('Illumina read', fq.illumina?.read ? `R${fq.illumina.read}` : '—', 'inferred', fq.illumina ? `lane ${fq.illumina.lane} · ${fq.illumina.instrument}` : 'header pattern not recognized')}
      </div>
      <div class="grid-2">
        <div class="viz-card"><div class="viz-head"><strong>Per-cycle mean quality</strong><span>${badge('sampled')}</span></div><canvas class="chart fastq-quality-chart" data-fastq-index="${index}"></canvas></div>
        <div class="viz-card"><div class="viz-head"><strong>Per-cycle base composition</strong><span>${badge('sampled')}</span></div><canvas class="chart fastq-base-chart" data-fastq-index="${index}"></canvas></div>
      </div>
      ${fq.topSequences?.length ? `<div class="viz-card" style="margin-top:12px"><div class="viz-head"><strong>Most repeated sampled sequences</strong><span>diagnostic only</span></div>${table(['Sequence', 'Count'], fq.topSequences.map((x) => [x.sequence.length > 80 ? `${x.sequence.slice(0, 77)}…` : x.sequence, num(x.count)]))}</div>` : ''}
      <details><summary>First FASTQ header</summary><pre>${esc(fq.firstHeader || '')}</pre></details>
      <div class="metric-sub">Sampling: ${esc(fq.sampling?.limitation || 'bounded sample')} · integrity: ${num(fq.integrity?.malformedRecords || 0)} malformed records, ${num(fq.integrity?.invalidQuality || 0)} invalid quality bytes${fq.integrity?.readNumberConsistent === false ? ' · inconsistent read-number headers' : ''}</div>
    </div>
  </article>`;
}

function faiPanel(fai) {
  const s = fai.summary;
  return `<article class="panel"><div class="panel-head"><div class="panel-title"><span class="file-type">FAI</span><div><h3>${esc(fai.name)}</h3><p>${formatBytes(fai.size)} · FASTA index</p></div></div><span class="status good">Index parsed</span></div><div class="panel-body"><div class="metric-grid">
    ${metric('Sequences', num(s.contigs), 'exact')}${metric('Reference length', `${num(s.totalLength)} bp`, 'exact')}${metric('N50', `${num(s.n50)} bp`, 'exact')}${metric('L50', num(s.l50), 'exact')}
  </div>${table(['Sequence', 'Length', 'Byte offset', 'Line bases', 'Line bytes'], fai.records.slice(0, 100).map((r) => [r.name, num(r.length), num(r.offset), num(r.lineBases), num(r.lineBytes)]))}</div></article>`;
}

function setupCanvas(canvas, height = 190) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(260, canvas.clientWidth || 500);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, width, height };
}

function axes(ctx, width, height, pad) {
  ctx.strokeStyle = '#e2e7e3'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, height - pad.b); ctx.lineTo(width - pad.r, height - pad.b); ctx.stroke();
}

function drawBarcode(canvas, data) {
  if (!data?.length) return;
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { l: 38, r: 10, t: 10, b: 25 };
  axes(ctx, width, height, pad);
  const maxRank = data.at(-1).rank;
  const maxCount = data[0].count;
  const minCount = Math.max(1, data.at(-1).count);
  const x = (rank) => pad.l + (Math.log10(rank) / Math.log10(Math.max(2, maxRank))) * (width - pad.l - pad.r);
  const y = (count) => pad.t + (1 - (Math.log10(count) - Math.log10(minCount)) / Math.max(.001, Math.log10(maxCount) - Math.log10(minCount))) * (height - pad.t - pad.b);
  ctx.strokeStyle = '#1d6b50'; ctx.lineWidth = 1.7; ctx.beginPath();
  data.forEach((p, i) => { const px = x(p.rank), py = y(p.count); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke();
  ctx.fillStyle = '#7a837f'; ctx.font = '10px system-ui'; ctx.fillText('rank (log)', width - 62, height - 7); ctx.save(); ctx.translate(11, 58); ctx.rotate(-Math.PI / 2); ctx.fillText('reads (log)', 0, 0); ctx.restore();
}

function drawQuality(canvas, cycles) {
  if (!cycles?.length) return;
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { l: 32, r: 10, t: 10, b: 24 };
  axes(ctx, width, height, pad);
  const maxQ = Math.max(40, ...cycles.map((x) => x.meanQ || 0));
  const X = (i) => pad.l + i / Math.max(1, cycles.length - 1) * (width - pad.l - pad.r);
  const Y = (q) => pad.t + (1 - q / maxQ) * (height - pad.t - pad.b);
  for (const q of [20, 30]) { ctx.setLineDash([3, 3]); ctx.strokeStyle = '#d6ddd8'; ctx.beginPath(); ctx.moveTo(pad.l, Y(q)); ctx.lineTo(width - pad.r, Y(q)); ctx.stroke(); ctx.fillStyle = '#89928e'; ctx.font = '9px system-ui'; ctx.fillText(`Q${q}`, 5, Y(q) + 3); }
  ctx.setLineDash([]); ctx.strokeStyle = '#1d6b50'; ctx.lineWidth = 1.7; ctx.beginPath(); cycles.forEach((c, i) => { const px = X(i), py = Y(c.meanQ || 0); if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke();
  ctx.fillStyle = '#7a837f'; ctx.font = '10px system-ui'; ctx.fillText('cycle', width - 35, height - 6);
}

function drawBases(canvas, cycles) {
  if (!cycles?.length) return;
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { l: 34, r: 10, t: 10, b: 24 };
  axes(ctx, width, height, pad);
  const X = (i) => pad.l + i / Math.max(1, cycles.length - 1) * (width - pad.l - pad.r);
  const Y = (p) => pad.t + (1 - p) * (height - pad.t - pad.b);
  const series = [['A','#396a93'],['C','#9a6729'],['G','#6f4c8d'],['T','#3f8062']];
  for (const [base, color] of series) { ctx.strokeStyle = color; ctx.lineWidth = 1.35; ctx.beginPath(); cycles.forEach((c, i) => { const px = X(i), py = Y(c[base] || 0); if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke(); }
  ctx.font = '9px system-ui'; let lx = pad.l; for (const [base, color] of series) { ctx.fillStyle = color; ctx.fillText(base, lx, height - 6); lx += 18; }
}

export function renderResults(container, result) {
  const totalFiles = result.files?.length || 0;
  const pair = result.fastq?.pairInference;
  const datasets = result.datasets || [];
  const datasetSummary = datasets.length ? `<div class="dataset-list">${datasets.map((d) => `<div class="callout"><div><strong>${esc(d.label)}</strong><span>${esc(d.summary)}${d.warnings?.length ? ` · ${esc(d.warnings.join(' '))}` : ''}</span></div><span class="metric-badge exact">BOUNDARY</span></div>`).join('')}</div>` : '';
  const unassigned = result.unassigned?.length ? `<div class="callout"><div><strong>Unassigned files</strong><span>${result.unassigned.map((f) => `${esc(f.name)}: ${esc(f.reason)}`).join(' · ')}</span></div><span class="status warn">Review</span></div>` : '';
  const comparison = result.bam?.length > 1 ? `<div class="viz-card comparison-card"><div class="viz-head"><strong>Multi-sample comparison</strong><span>${result.bam.length} BAMs · exact counts where BAI metadata is present</span></div>${table(['Sample', 'Mapped fraction', 'Sampled records', 'Knee', 'Warnings'], result.bam.map((bam) => { const mapped = bigToNumber(bam.index?.mapped); const unmapped = bigToNumber(bam.index?.totalUnmapped); const fraction = mapped != null && unmapped != null && mapped + unmapped ? mapped / (mapped + unmapped) : null; return [bam.datasetLabel || bam.name, pct(fraction), num(bam.sample?.records), bam.sample?.knee ? `~${num(bam.sample.knee.estimatedCells)}` : '—', num((bam.warnings || []).length + (bam.sample?.healthFlags || []).filter((x) => x.level === 'warn').length)]; }))}</div>` : '';
  container.innerHTML = `<div class="results-head"><div><div class="section-kicker">RESULTS</div><h2>Dataset preflight</h2></div><div class="result-actions"><button id="exportJsonBtn" class="button secondary" type="button">Export JSON</button><button id="exportReceiptBtn" class="button secondary" type="button">Export receipt</button></div></div>
  ${datasetSummary}${unassigned}
  ${pair ? `<div class="callout"><div><strong>${esc(pair.label)}</strong><span>${esc(pair.r1)} + ${esc(pair.r2)}${pair.note ? ` · ${esc(pair.note)}` : ''}</span></div>${confidence(pair.confidence)}</div>` : ''}
  ${comparison}
  ${result.bam?.map((b, i) => bamPanel(b, i)).join('') || ''}
  ${result.fastq?.files?.map((f, i) => fastqPanel(f, i)).join('') || ''}
  ${result.fai?.map((f) => faiPanel(f)).join('') || ''}
  ${!result.bam?.length && !result.fastq?.files?.length && !result.fai?.length ? `<div class="panel"><div class="panel-body">No supported genomic files were recognized among ${totalFiles} selected files.</div></div>` : ''}`;

  result.bam?.forEach((bam, i) => { const c = container.querySelector(`.barcode-chart[data-bam-index="${i}"]`); if (c) drawBarcode(c, bam.sample?.barcodeRank); });
  result.fastq?.files?.forEach((fq, i) => {
    const q = container.querySelector(`.fastq-quality-chart[data-fastq-index="${i}"]`); if (q && !fq.error) drawQuality(q, fq.perCycle);
    const b = container.querySelector(`.fastq-base-chart[data-fastq-index="${i}"]`); if (b && !fq.error) drawBases(b, fq.perCycle);
  });
}

export function fileType(name) {
  if (/\.bam$/i.test(name)) return 'BAM';
  if (/\.bai$/i.test(name)) return 'BAI';
  if (/\.(?:fastq|fq)(?:\.gz)?$/i.test(name)) return 'FASTQ';
  if (/\.fai$/i.test(name)) return 'FAI';
  return 'FILE';
}
