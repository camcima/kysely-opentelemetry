export const MAX_SUMMARY_LENGTH = 255;

export function summarize(operation: string, tables: string[]): string {
  const target = tables.length > 0 ? tables.join(' ') : 'unknown';
  return `${operation} ${target}`.slice(0, MAX_SUMMARY_LENGTH);
}
