/** Shared UI convention: 15 Sep 2026, 17:30 IST, independent of browser locale. */
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function formatDate(value: Date | number | string): string {
  return format(value, false);
}
export function formatDateTime(value: Date | number | string): string {
  return format(value, true);
}
function format(value: Date | number | string, withTime: boolean): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  const day = `${parts.day} ${months[Number(parts.month) - 1]} ${parts.year}`;
  return withTime ? `${day}, ${parts.hour}:${parts.minute} IST` : day;
}
/** Convert a human date to the API's calendar-date wire format. */
export function parseDateInput(value: string): string | null {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const display = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(text);
  const month = display ? months.findIndex(m => m.toLowerCase() === display[2].toLowerCase()) + 1 : 0;
  const normalized = iso ? text : display && month ? `${display[3]}-${String(month).padStart(2,'0')}-${display[1].padStart(2,'0')}` : null;
  if (!normalized) return null;
  const date = new Date(normalized + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === normalized ? normalized : null;
}
