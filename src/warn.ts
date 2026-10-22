/**
 * One warning per distinct message per process; a per-call warning would
 * flood a loop or a request handler. Its own module so any SDK module can use
 * it without importing spans.ts, which would close an import cycle.
 */
const warned = new Set<string>();
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[rius] ${message}`);
}

/** Forget every message already warned about, so each test starts fresh. */
export function resetWarnOnce(): void {
  warned.clear();
}
