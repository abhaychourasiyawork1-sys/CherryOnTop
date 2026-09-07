/** Number and time formatting, in one place. Three panels had grown their own
 *  `since()` and they had already drifted — one rounded minutes, one floored
 *  them, so the same run read as 5m in one panel and 4m in another. */

export function money(usd: number, places = 2): string {
  return `$${usd.toFixed(places)}`;
}

/** Elapsed time, at the coarsest unit that is still honest. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** How long ago, for a timestamp a person is reading rather than measuring. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/** A timestamp as a person writes one. */
export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** The last segment of a path — a repository's name, a file's name. */
export function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

/** Long single-line text, cut where it stops being useful rather than at a
 *  fixed width that can land mid-word. */
export function clip(text: string, max = 90): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
