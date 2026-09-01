import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = (name) => path.join(process.cwd(), 'tests', 'fixtures', name);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('opens the native multi-file picker path and clears/reselects the same files', async ({ page }) => {
  const input = page.locator('#fileInput');
  await input.setInputFiles([fixture('synthetic.bam'), fixture('synthetic.bam.bai')]);
  await expect(page.locator('#fileSummary')).toHaveText(/2 files/);
  await expect(page.locator('#analyzeBtn')).toBeEnabled();
  await page.locator('#clearBtn').click();
  await expect(page.locator('#selectionPanel')).toBeHidden();
  await input.setInputFiles(fixture('synthetic.bam'));
  await expect(page.locator('#fileSummary')).toHaveText(/1 file/);
});

test('supports keyboard activation and Quick/Deep switching', async ({ page }) => {
  await page.evaluate(() => {
    window.__pickerInvocations = 0;
    const input = document.querySelector('#fileInput');
    input.showPicker = () => { window.__pickerInvocations += 1; };
    input.click = () => { window.__pickerInvocations += 1; };
  });
  await page.locator('#dropzone').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__pickerInvocations)).toBe(1);
  await page.locator('#fileInput').setInputFiles({ name: 'keyboard.fastq', mimeType: 'text/plain', buffer: Buffer.from('@r\nACGT\n+\nIIII\n') });
  await expect(page.locator('[data-mode="quick"]')).toHaveClass(/active/);
  await page.locator('[data-mode="deep"]').click();
  await expect(page.locator('[data-mode="deep"]')).toHaveClass(/active/);
});

test('ingests a dropped FASTQ and completes worker rendering', async ({ page }) => {
  const bytes = [...await readFile(fixture('synthetic_R1.fastq.gz'))];
  await page.locator('#dropzone').evaluate((node, payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload)], 'lane_R1.fastq.gz', { type: 'application/gzip' }));
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, bytes);
  await expect(page.locator('#fileSummary')).toHaveText(/1 file/);
  await page.locator('#analyzeBtn').click();
  await expect(page.locator('#results')).toContainText('lane_R1.fastq.gz', { timeout: 15000 });
});

test('matches BAM plus BAI, validates the index and renders BAM metrics', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([fixture('synthetic.bam'), fixture('synthetic.bam.bai')]);
  await page.locator('#analyzeBtn').click();
  await expect(page.locator('#results')).toContainText('synthetic.bam', { timeout: 15000 });
  await expect(page.locator('#results')).toContainText('synthetic.bam.bai');
  await expect(page.locator('#results')).toContainText('Mapped records');
});

test('renders demo mode and exports JSON', async ({ page }) => {
  await page.locator('#demoBtn').click();
  await expect(page.locator('#results')).toContainText('Dataset preflight');
  await expect(page.locator('#results')).toContainText('Cell-associated knee');
  const download = page.waitForEvent('download');
  await page.locator('#exportJsonBtn').click();
  await expect((await download).suggestedFilename()).toMatch(/^bio-peek-\d{4}-\d{2}-\d{2}\.json$/);
});

test('shows a user-facing failure for malformed BAM input', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles({
    name: 'malformed.bam',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a BAM file'),
  });
  await page.locator('#analyzeBtn').click();
  await expect(page.locator('#progressMessage')).toContainText('Inspection failed', { timeout: 15000 });
});
