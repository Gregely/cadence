import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Find a Chromium/Chrome/Edge to drive. Override with CADENCE_BROWSER. */
export function browserPath() {
  const candidates = [
    process.env.CADENCE_BROWSER,
    process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1194', 'chrome-linux', 'chrome'),
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found. Set CADENCE_BROWSER to its executable path.');
  return found;
}
