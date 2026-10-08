import { beforeEach, describe, expect, it, vi } from 'vitest';

async function freshSettings() {
  vi.resetModules();
  return import('../src/settings');
}

describe('theme setting', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('defaults to paper, as before', async () => {
    expect((await freshSettings()).settings().theme).toBe('paper');
  });

  it.each(['analogue', 'analogue-dark', 'paper', 'dark', 'eink'] as const)('remembers %s on this device', async (theme) => {
    (await freshSettings()).updateSettings({ theme });
    expect(JSON.parse(localStorage.getItem('cadence.settings')!).theme).toBe(theme);
    expect((await freshSettings()).settings().theme).toBe(theme);
  });

  it('takes a theme from the address for one visit without saving it', async () => {
    window.history.replaceState(null, '', '/?theme=analogue-dark');
    expect((await freshSettings()).settings().theme).toBe('analogue-dark');
    expect(localStorage.getItem('cadence.settings')).toBeNull();
    window.history.replaceState(null, '', '/?theme=luna');
    expect((await freshSettings()).settings().theme).toBe('paper');
  });

  it('puts the theme on the page', async () => {
    const s = await freshSettings();
    s.applyTheme('analogue');
    expect(document.documentElement.dataset.theme).toBe('analogue');
  });

  it('has grain on by default and remembers turning it off', async () => {
    const s = await freshSettings();
    expect(s.settings().grain).toBe(true);
    s.applyTheme('analogue');
    expect(document.documentElement.dataset.grain).toBe('on');
    s.updateSettings({ grain: false });
    const again = await freshSettings();
    expect(again.settings().grain).toBe(false);
    again.applyTheme('analogue-dark', again.settings().grain);
    expect(document.documentElement.dataset.grain).toBe('off');
  });
});
