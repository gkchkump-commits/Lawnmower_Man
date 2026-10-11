// Temporary folders for tests that are removed again: after the test file that made them (each
// test file imports its own copy of this module, so the hook belongs to that file) and, as a
// backstop, when the worker process exits. Without this every run left a folder per test in the
// OS temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const made = new Set();

function removeAll() {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // still in use on Windows: the exit sweep tries again
      continue;
    }
    made.delete(dir);
  }
}

afterAll(removeAll);
process.once('exit', removeAll);

/**
 * A new empty folder under the OS temp folder (fs.mkdtempSync), removed after this test file.
 * @param {string} prefix e.g. 'lm-rec-'
 * @returns {string} its path
 */
export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}
