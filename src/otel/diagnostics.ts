import { diag } from '@opentelemetry/api';

const MAX_WARNINGS_PER_CONTEXT = 10;
// Keys MUST be static literals: a dynamic/interpolated context string would
// grow this map unbounded. All call sites pass fixed literals.
const warnCounts = new Map<string, number>();

/**
 * Instrumentation-internal failures: warn through OTel diagnostics, capped
 * per context string so one noisy failure class cannot silence the others.
 */
export function warnLimited(context: string, error?: unknown): void {
  const count = warnCounts.get(context) ?? 0;
  if (count >= MAX_WARNINGS_PER_CONTEXT) return;
  warnCounts.set(context, count + 1);
  try {
    if (error === undefined) diag.warn(`kysely-opentelemetry: ${context}`);
    else diag.warn(`kysely-opentelemetry: ${context}`, error);
  } catch {
    // The diag logger is user-supplied; it runs inside telemetry catch
    // blocks, so a throw here would escape into the database call.
  }
}
