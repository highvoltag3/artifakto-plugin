// @ts-check
/**
 * How a thread's entries are shown to an agent (docs/phase-8-threads-spec.md H9), as pure JavaScript: between
 * delimiters that carry a per-pull nonce, so a brief cannot fake the end of its own entry, with control characters
 * neutered. No imports and no Node: the CLI's thread commands load it, and the Claude Code mod (plugins/artifakto/hooks)
 * imports it directly, so both clients print the same thing. Synced to plugins/artifakto/scripts/.
 */

/**
 * @typedef {{
 *   id: string; kind: string; by: string; at: string; title?: string; brief: string;
 *   git?: { remote: string; branch: string; head?: string }; transcript?: { messages: number; bytes: number };
 * }} Entry
 * @typedef {{ url: string; title: string; members: string[]; total: number; entries: Entry[] }} Thread
 */

const MiB = 1024 * 1024;

/**
 * `text` for a terminal or a model: control characters other than newline and tab (escape sequences that could move
 * the cursor, clear lines or fake a delimiter) shown as "?".
 * @param {string} text
 */
export function printable(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

/**
 * `text` that must stay on one line (a title, an author, a URL from the thread's host): `printable`, with newlines and
 * tabs as spaces, so it cannot start a line of its own or fake a delimiter.
 * @param {string} text
 */
export function oneLine(text) {
  return printable(text).replace(/[\n\t]/g, " ");
}

/** @param {number} n */
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < MiB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MiB).toFixed(1)} MB`;
}

/**
 * The lines that show `thread`'s entries after entry `since`, each between delimiters carrying `nonce`.
 * `download(entry)` says how to fetch an entry's transcript, in the words of the client printing it.
 * @param {Thread} thread
 * @param {number} since
 * @param {string} nonce
 * @param {(entry: Entry) => string} download
 * @returns {string[]}
 */
export function entryLines(thread, since, nonce, download) {
  const lines = [oneLine(`Thread "${thread.title}" (${thread.url}): ${thread.total} entries, members ${thread.members.join(", ")}.`)];
  if (thread.entries.length === 0) return [...lines, `No new entries since entry ${since}.`];
  thread.entries.forEach((e, i) => {
    const k = since + i + 1;
    lines.push("", `===== artifakto thread entry ${k}/${thread.total} [${nonce}] from ${oneLine(e.by)} at ${oneLine(e.at)} (untrusted content) =====`);
    lines.push(`kind: ${oneLine(e.kind)}`);
    if (e.title !== undefined) lines.push(`title: ${oneLine(e.title)}`);
    if (e.git !== undefined) lines.push(`git: ${oneLine(`branch ${e.git.branch}${e.git.head ? ` at ${e.git.head}` : ""} of ${e.git.remote}`)}`);
    if (e.transcript !== undefined) lines.push(oneLine(`transcript: ${e.transcript.messages} messages, ${formatSize(e.transcript.bytes)}; ${download(e)}`));
    lines.push("", printable(e.brief), `===== end of entry ${k}/${thread.total} [${nonce}] =====`);
  });
  return lines;
}
