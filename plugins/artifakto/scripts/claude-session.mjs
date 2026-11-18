// @ts-check
/**
 * Claude Code session export for `artifakto session-export` (docs/phase-8-threads-spec.md section 4): finds a session's
 * JSONL file on this machine and hands its text to session-core.mjs, which builds the transcript. Node built-ins only;
 * loaded by artifakto.mjs when session-export runs. Synced to plugins/artifakto/scripts/ with session-core.mjs.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

export { convertSession, fitBudget, LIMITS, scrub } from "./session-core.mjs";

/**
 * The directory Claude Code keeps a working directory's sessions in: every character that is not a letter or a digit
 * becomes "-" (/Users/a/my.repo -> -Users-a-my-repo).
 * @param {string} cwd
 * @param {string} home
 */
export function projectDirFor(cwd, home) {
  return path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** How much of a file's end is searched for the marker: the record carrying it is among the last written. */
const MARKER_TAIL_BYTES = 1024 * 1024;

/**
 * The newest .jsonl file in `dir` whose last MARKER_TAIL_BYTES contain `marker`, and its text, retried until `waitMs`
 * has passed: the record of the command that carries the marker is written about when the command starts.
 * @param {string} dir
 * @param {string} marker
 * @param {{ waitMs?: number; intervalMs?: number }} [opts]
 * @returns {Promise<{ file: string; text: string } | null>}
 */
export async function findSessionFile(dir, marker, opts = {}) {
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  for (;;) {
    /** @type {{ file: string; mtime: number; size: number }[]} */
    let files = [];
    try {
      const names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
      files = await Promise.all(names.map(async (n) => {
        const st = await fsp.stat(path.join(dir, n));
        return { file: path.join(dir, n), mtime: st.mtimeMs, size: st.size };
      }));
    } catch {
      // no such directory yet
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { file, size } of files) {
      if (await tailIncludes(file, size, marker)) return { file, text: await fsp.readFile(file, "utf8") };
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 250));
  }
}

/**
 * @param {string} file
 * @param {number} size
 * @param {string} marker
 */
async function tailIncludes(file, size, marker) {
  const length = Math.min(size, MARKER_TAIL_BYTES);
  try {
    const fh = await fsp.open(file, "r");
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(length), 0, length, size - length);
      return buffer.subarray(0, bytesRead).toString("utf8").includes(marker);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}
