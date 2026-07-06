import { createHash } from 'node:crypto';

export function hashFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}
