/** Every top-level router this window needs from the daemon.
 *
 *  The window and the daemon are built separately and started separately, so
 *  they can trivially be different versions — `org gui` reuses whatever daemon
 *  is already running, and a daemon from an older build satisfies "running".
 *  When that happens the calls 404 one at a time and the window reports the
 *  daemon as unreachable, which is a spectacularly misleading way to say
 *  "restart your daemon".
 *
 *  Listing the routers rather than comparing a version number keeps this
 *  self-maintaining: adding a router to the daemon and using it here is the only
 *  thing anyone has to remember. */
export const REQUIRED_ROUTERS = [
  'node', 'events', 'daemon', 'commitment', 'decision', 'artifact',
  'approval', 'memory', 'mandate', 'case', 'org',
] as const;

export function missingRouters(daemonRouters: string[] | undefined, required: readonly string[] = REQUIRED_ROUTERS): string[] {
  // A daemon too old to report its routers at all is, by definition, too old.
  if (!daemonRouters) return [...required];
  return required.filter((name) => !daemonRouters.includes(name));
}

export function outOfDateMessage(missing: string[]): string {
  return `This window is newer than the daemon it is talking to, so ${missing.length === 1 ? 'one part' : 'parts'} of it cannot work (${missing.join(', ')}). Rebuild and restart: \`npm run build\` then \`org daemon stop\`.`;
}
