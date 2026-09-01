import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true);
}

const sourceDir = path.resolve(String(args.get('source-dir') || process.env.PBMC_V3_DIR || 'tests/golden/pbmc-v3/source'));
const outputDir = path.resolve(String(args.get('output-dir') || 'tests/golden/pbmc-v3/mini'));
const fastqDir = existsSync(path.join(sourceDir, 'pbmc_1k_v3_fastqs')) ? path.join(sourceDir, 'pbmc_1k_v3_fastqs') : sourceDir;
const bam = path.join(sourceDir, 'pbmc_1k_v3_possorted_genome_bam.bam');
const sourceNames = existsSync(fastqDir) ? await readdir(fastqDir) : [];
const r1Files = sourceNames.filter((name) => /(?:^|[_-])R1(?:[_-]|\.|$)/i.test(name) && /\.fastq\.gz$/i.test(name)).sort().map((name) => path.join(fastqDir, name));
const r2Files = sourceNames.filter((name) => /(?:^|[_-])R2(?:[_-]|\.|$)/i.test(name) && /\.fastq\.gz$/i.test(name)).sort().map((name) => path.join(fastqDir, name));
const expectedPath = path.resolve('tests/golden/pbmc-v3/expected.json');

function command(name, commandArgs, { optional = false } = {}) {
  const result = spawnSync(name, commandArgs, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error(`${name} ${commandArgs.join(' ')} failed: ${result.error?.message || result.stderr}`);
  }
  return result.stdout;
}

if (!existsSync(bam) || !r1Files.length || !r2Files.length) {
  console.error(`Place the official PBMC v3 BAM and both lanes of FASTQs in ${sourceDir} (or pbmc_1k_v3_fastqs/), then rerun.`);
  console.error('See tests/golden/pbmc-v3/README.md for the source manifest and expected chemistry.');
  process.exitCode = 2;
} else {
  await mkdir(outputDir, { recursive: true });
  // Derive a small, indexed BAM fixture. Keep this command in the repository
  // so the fixture can be recreated from the original data after changes.
  command('samtools', ['view', '-bh', '-o', path.join(outputDir, 'pbmc_v3.mini.bam'), bam, 'chr1:1-5000000']);
  command('samtools', ['index', path.join(outputDir, 'pbmc_v3.mini.bam')]);
  command('seqkit', ['sample', '-s', '20260201', '-n', '10000', '-o', path.join(outputDir, 'pbmc_v3.mini_R1.fastq.gz'), ...r1Files]);
  command('seqkit', ['sample', '-s', '20260201', '-n', '10000', '-o', path.join(outputDir, 'pbmc_v3.mini_R2.fastq.gz'), ...r2Files]);

  const miniBam = path.join(outputDir, 'pbmc_v3.mini.bam');
  const idxstats = command('samtools', ['idxstats', miniBam]).trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, length, mapped, unmapped] = line.split('\t');
    return { name, length: Number(length), mapped: Number(mapped), unmapped: Number(unmapped) };
  });
  const miniR1 = path.join(outputDir, 'pbmc_v3.mini_R1.fastq.gz');
  const miniR2 = path.join(outputDir, 'pbmc_v3.mini_R2.fastq.gz');
  const seqkit = command('seqkit', ['stats', '-T', miniR1, miniR2], { optional: true });
  const fastp = command('fastp', ['--in1', miniR1, '--in2', miniR2, '--json', path.join(outputDir, 'fastp.json'), '--html', path.join(outputDir, 'fastp.html')], { optional: true });
  const fastpJson = existsSync(path.join(outputDir, 'fastp.json')) ? JSON.parse(await readFile(path.join(outputDir, 'fastp.json'), 'utf8')) : null;
  const cellRanger = existsSync(path.join(sourceDir, 'web_summary.json')) ? JSON.parse(await readFile(path.join(sourceDir, 'web_summary.json'), 'utf8')) : null;
  const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
  await writeFile(path.join(outputDir, 'reference-observations.json'), JSON.stringify({ expected, idxstats, seqkit, fastp: fastpJson, fastpAvailable: Boolean(fastp), cellRanger }, null, 2));
  await writeFile(path.join(outputDir, 'MANIFEST.json'), JSON.stringify({ source: expected.source, sourceDir, fastqDir, r1Files, r2Files, commands: expected.commands, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`Generated ${outputDir}. Run the browser golden comparison with the mini files and keep reference-observations.json with the fixture.`);
}
