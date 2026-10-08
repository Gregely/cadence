const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parse(iso: string): Date {
  return new Date(iso);
}

export function monthName(m: number): string {
  return MONTHS[m] ?? '';
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today", "Yesterday", "Mon 5 Oct", or "Mon 5 Oct 2025" for other years. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = parse(iso);
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  const base = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]!.slice(0, 3)}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function timeLabel(iso: string): string {
  const d = parse(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dateTimeLabel(iso: string, now = new Date()): string {
  return `${dayLabel(iso, now)}, ${timeLabel(iso)}`;
}

/** Diary entry heading: "Thursday 8 October 2026". */
export function longDate(iso: string): string {
  const d = parse(iso);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  return `${day} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
