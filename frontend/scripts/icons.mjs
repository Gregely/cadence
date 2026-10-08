// Render public/icons/icon.svg to the PNG sizes the manifest needs.
// Run once: node scripts/icons.mjs (uses the local Chromium via playwright-core).
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { browserPath } from './browser.mjs';

const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: browserPath() });
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../public/icons/icon-${size}.png`, import.meta.url).pathname, omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written');
