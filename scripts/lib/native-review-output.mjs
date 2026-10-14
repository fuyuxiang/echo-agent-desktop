import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Acceptance reports are local artifacts. A fresh checkout needs no historical
// evidence directory; callers can explicitly retain output via their env key.
export function nativeReviewOutput(name, environmentVariable) {
  const configured = environmentVariable && process.env[environmentVariable];
  const output = configured
    ? resolve(configured)
    : mkdtempSync(join(tmpdir(), `echo-${name}-evidence-`));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  return realpathSync(output);
}
