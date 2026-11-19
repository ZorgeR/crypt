import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { assertNoBlockingCsp, createTextSecret } from './helpers';

/**
 * The streamed path, driven the way a user drives it.
 *
 * This is the only test that exercises the browser machinery end to end: the
 * File is sliced and encrypted frame by frame, uploaded in parts, and the
 * download is written to disk through the service worker sink. Unit tests can
 * cover the container and the transport, but not registration, scope,
 * transferable streams, or whether a native download actually fires.
 */

// Comfortably past the 128 KiB inline threshold, small enough to stay quick.
const FILE_BYTES = 300 * 1024;

const payload = () => {
  const bytes = Buffer.alloc(FILE_BYTES);
  for (let i = 0; i < FILE_BYTES; i++) bytes[i] = (i * 73 + 19) & 0xff;
  return bytes;
};

/** Uploads a streamed file through the create page and returns its combined link. */
const createStreamedFile = async (page: Page, content: Buffer): Promise<string> => {
  await page.goto('/new');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'quarterly-report.bin',
    mimeType: 'application/octet-stream',
    buffer: content,
  });
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Secret Created!' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Show secret URL' }).first().click();
  return page.locator('#combined-url').inputValue();
};

/** Clicks download and checks the saved file byte for byte. */
const downloadAndVerify = async (page: Page, content: Buffer) => {
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: /download file/i }).click(),
  ]).then(([event]) => event);

  expect(download.suggestedFilename()).toBe('quarterly-report.bin');
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();
  const saved = await import('node:fs/promises').then((fs) => fs.readFile(savedPath!));
  expect(saved.equals(content)).toBe(true);

  // Only shown once the worker confirms the browser pulled every byte.
  await expect(page.getByText(/download complete/i)).toBeVisible();
};

test.describe('streamed file', () => {
  test('uploads a large file and downloads it back under production CSP', async ({
    page,
    cspViolations,
  }, testInfo) => {
    const content = payload();

    await page.goto('/new');

    // The server advertises a storage-backed ceiling, so the UI must offer more
    // than the inline threshold before a file this size can be selected.
    await expect(page.getByText(/drag-n-drop/)).not.toContainText('128 KB');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'quarterly-report.bin',
      mimeType: 'application/octet-stream',
      buffer: content,
    });

    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('heading', { name: 'Secret Created!' })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Show secret URL' }).first().click();
    const shareUrl = await page.locator('#combined-url').inputValue();

    // Streamed secrets are marked so the viewer knows before it fetches.
    expect(shareUrl).toContain('s=true');

    await page.goto(shareUrl);

    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: /download file/i }).click(),
    ]).then(([event]) => event);

    // The name lives in the encrypted metadata frame; recovering it proves the
    // sink was armed after the header authenticated, not with a placeholder.
    expect(download.suggestedFilename()).toBe('quarterly-report.bin');

    const savedPath = await download.path();
    expect(savedPath).toBeTruthy();
    const saved = await import('node:fs/promises').then((fs) => fs.readFile(savedPath!));
    expect(saved.length).toBe(FILE_BYTES);
    expect(saved.equals(content)).toBe(true);

    await expect(page.getByText(/download complete/i)).toBeVisible();

    await assertNoBlockingCsp(cspViolations, testInfo);
  });
});

/**
 * The `s=true` flag in a link is only a hint. When it is missing or wrong, the
 * server refuses the read with 406 before burning anything, and the viewer
 * switches to the other view. Both directions are covered with burn-after-read
 * secrets, so a wrong guess that consumed the secret would fail the test.
 */
test.describe('streamed file / link without the right marker', () => {
  test('a streamed secret opened without s=true still downloads', async ({ page }) => {
    const content = payload();
    const shareUrl = new URL(await createStreamedFile(page, content));
    shareUrl.searchParams.delete('s');

    await page.goto(shareUrl.toString());
    // The inline view tries first; the server refuses it without burning.
    await page.getByRole('button', { name: 'View Secret' }).click();

    await downloadAndVerify(page, content);
  });

  test('an inline secret opened with s=true still reveals', async ({ page }) => {
    const secret = `wrong-marker-${Date.now()}`;
    const shareUrl = new URL(await createTextSecret(page, secret));
    shareUrl.searchParams.set('s', 'true');

    await page.goto(shareUrl.toString());
    // The streamed view tries first; the server refuses it without burning.
    await page.getByRole('button', { name: /download file/i }).click();
    await page.getByRole('button', { name: 'View Secret' }).click();

    await expect(page.getByLabel('Secret content')).toHaveText(secret);
  });
});
