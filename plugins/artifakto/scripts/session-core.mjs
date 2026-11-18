// @ts-check
/**
 * The Claude Code session export (docs/phase-8-threads-spec.md section 4) as pure JavaScript: it builds an artifakto
 * transcript (v1, the format of lib/domain/transcript.ts) from a session file's text and a whitelist: user and assistant
 * text, tool calls, and the results of a few local tools. Everything else is dropped (MCP results are other people's
 * mail and messages), secrets are scrubbed, and a report says what happened. No imports and no Node: the CLI loads it
 * through claude-session.mjs, and the Claude Code mod (plugins/artifakto/hooks) imports it directly (section 9).
 * Synced to plugins/artifakto/scripts/.
 */

/** Server limits this file must stay under (lib/domain/limits.ts; tests/cli/claude-session.test.ts compares them). */
export const LIMITS = {
  transcriptMessages: 5000,
  transcriptPartsPerMessage: 100,
  transcriptPartChars: 500_000,
};

/** Tools whose results are kept: they read or change the user's own checkout. */
const KEPT_TOOL_RESULTS = new Set(["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent"]);
const TOOL_INPUT_CHARS = 2000;
const TOOL_RESULT_CHARS = 4000;
const TOOL_RESULT_CHARS_TIGHT = 1000;
const KEEP_LAST_TURNS = 10;
const ASSISTANT_NAME = "Claude";

/** Read results of these files never leave the machine (matched against the basename). */
const SECRET_PATH_RE = /^(?:\.env.*|.*\.pem|id_[^/]*|.*\.key|credentials.*|\.npmrc|\.netrc)$/i;

/**
 * Secret patterns, scrubbed from every string that is kept. Each replacement keeps what makes the text readable
 * (a header name, a key name) and names the pattern, so the report can count it.
 * @type {[string, RegExp, (m: string, ...g: string[]) => string][]}
 */
const SCRUBBERS = [
  ["pem", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => "[redacted: private key]"],
  ["authorization_header", /\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]+/gi, (_m, name, sep) => `${name}${sep}[redacted]`],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, () => "Bearer [redacted]"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => "[redacted: jwt]"],
  ["aws_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => "[redacted: aws key]"],
  ["artifakto_key", /\bafk_[A-Za-z0-9_-]{43}/g, () => "[redacted: artifakto key]"],
  ["api_key", /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})/g, () => "[redacted: api key]"],
  ["url_userinfo", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_m, scheme) => `${scheme}[redacted]@`],
  ["query_secret", /([?&](?:token|access_token|refresh_token|sig|signature|api_key|apikey|key|code|secret|password)=)[^&#\s"'<>]+/gi, (_m, key) => `${key}[redacted]`],
  ["npm_auth", /(_authToken\s*=\s*)\S+/g, (_m, key) => `${key}[redacted]`],
  ["assignment", /\b([A-Za-z0-9_.-]*(?:pass|pwd|secret|token|key|auth|dsn|database_url|redis_url|connection_?string)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(["']?)(?!\[redacted)([^\s"',;]{6,})\3/gi, (_m, key, sep, q) => `${key}${sep}${q}[redacted]${q}`],
];

/**
 * Scrubs secrets from `text`, counting each replacement under its pattern name in `counts`, and writes `home` as "~".
 * @param {string} text
 * @param {Record<string, number>} counts
 * @param {string} [home]
 */
export function scrub(text, counts, home) {
  let out = text;
  for (const [name, re, replace] of SCRUBBERS) {
    out = out.replace(re, (...args) => {
      bump(counts, name);
      return replace(.../** @type {[string, ...string[]]} */ (args));
    });
  }
  if (home !== undefined && home.length > 1) out = out.split(home).join("~");
  return out;
}

/**
 * @typedef {{ type: "text"; text: string } | { type: "code"; language?: string; text: string } | { type: "omitted"; reason: "image" | "file" | "unsupported" }} Part
 * @typedef {{ role: "user" | "assistant" | "system" | "tool"; time?: string; parts: Part[] }} Message
 * @typedef {{ v: 1; title?: string; assistantName: string; model?: string; messages: Message[] }} Transcript
 * @typedef {{
 *   messages: number; bytes: number; toolCalls: Record<string, number>; toolResultsKept: Record<string, number>;
 *   toolResultsDropped: Record<string, number>; redactions: Record<string, number>; pathsRead: string[];
 *   secretPathsSkipped: string[]; truncated: string[]; links: string[]; skipped: Record<string, number>;
 * }} Report
 */

/** Room the "[... N more characters cut]" note takes at most. */
const CUT_NOTE_CHARS = 48;

/**
 * `text` cut to at most `max` characters in all (never inside a surrogate pair), the last of them a note saying how
 * many were cut, `dropped` of them before `text` was handed over.
 * @param {string} text
 * @param {number} max
 * @param {number} [dropped]
 */
function cut(text, max, dropped = 0) {
  if (text.length <= max && dropped === 0) return text;
  let end = Math.min(max - CUT_NOTE_CHARS, text.length);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n[... ${text.length - end + dropped} more characters cut]`;
}

/** @param {Record<string, number>} counts @param {string} key */
function bump(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** @param {unknown} v */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @param {unknown} t */
function validTime(t) {
  if (typeof t !== "string") return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** @param {string} s */
function cleanLabel(s) {
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩\u{e0000}-\u{e007f}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

/**
 * Converts the lines of a Claude Code session file into a transcript, applying the whitelist and the scrubbers.
 * `linkHosts` are hostnames (an artifakto apex) whose URLs, and their subdomains', are listed in the report.
 * @param {string} jsonl
 * @param {{ home?: string; linkHosts?: string[] }} [opts]
 * @returns {{ transcript: Transcript; report: Report; compactionIndex: number }}
 */
export function convertSession(jsonl, opts = {}) {
  /** @type {Report} */
  const report = {
    messages: 0, bytes: 0, toolCalls: {}, toolResultsKept: {}, toolResultsDropped: {}, redactions: {}, pathsRead: [],
    secretPathsSkipped: [], truncated: [], links: [], skipped: {},
  };
  const links = new Set();
  const linkHosts = (opts.linkHosts ?? []).map((h) => h.toLowerCase());
  /** @param {string} t */
  const clean = (t) => {
    const s = scrub(t, report.redactions, opts.home);
    for (const m of s.matchAll(URL_RE)) {
      try {
        const u = new URL(m[0]);
        const host = u.hostname.toLowerCase();
        const claude = host === "claude.ai" && /^\/(?:artifact|public\/artifacts)\//.test(u.pathname);
        if (claude || linkHosts.some((h) => host === h || host.endsWith(`.${h}`))) links.add(u.href);
      } catch {
        // not a URL after all
      }
    }
    return s;
  };
  /**
   * Scrubbed and cut to `max`. Only a margin past `max` is scrubbed: scrubbing a whole tool result to keep 4000 of
   * its characters would be wasted, and the margin keeps a secret straddling the cut from being half kept.
   * @param {string} t
   * @param {number} max
   */
  const cleanCut = (t, max) => {
    const head = t.length > max * 2 ? t.slice(0, max * 2) : t;
    return cut(clean(head), max, t.length - head.length);
  };
  /** @param {string} t */
  const textPart = (t) => /** @type {Part} */ ({ type: "text", text: cleanCut(t, LIMITS.transcriptPartChars) });
  /** @param {string} kind */
  const skip = (kind) => bump(report.skipped, kind);

  /** @type {Map<string, { name: string; path?: string }>} */
  const toolUses = new Map();
  /** @type {Message[]} */
  const messages = [];
  /** @type {{ id: string; blocks: { index: number; order: number; part: Part }[]; time?: string } | null} */
  let assistant = null;
  let order = 0;
  let title;
  let firstPrompt;
  let model;
  let compactionIndex = -1;

  const flushAssistant = () => {
    if (assistant === null) return;
    const parts = assistant.blocks.sort((a, b) => a.index - b.index || a.order - b.order).map((b) => b.part);
    if (parts.length > 0) push({ role: "assistant", ...(assistant.time ? { time: assistant.time } : {}), parts });
    assistant = null;
  };
  /** @param {Message} m */
  const push = (m) => {
    const last = messages[messages.length - 1];
    // Consecutive tool results become one tool message.
    if (m.role === "tool" && last !== undefined && last.role === "tool") last.parts.push(...m.parts);
    else messages.push(m);
  };

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    /** @type {unknown} */
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      skip("unreadable line");
      continue;
    }
    if (!isRecord(rec)) continue;
    const r = /** @type {Record<string, any>} */ (rec);
    if (r.type === "custom-title" && typeof (r.customTitle ?? r.title) === "string") {
      title = cleanLabel(r.customTitle ?? r.title);
      continue;
    }
    if (r.isSidechain === true) {
      skip("sidechain");
      continue;
    }
    if (r.type === "system" && r.subtype === "compact_boundary") {
      flushAssistant();
      continue;
    }
    if (r.type !== "user" && r.type !== "assistant") {
      skip(typeof r.type === "string" ? r.type : "unknown");
      continue;
    }
    if (r.isMeta === true || (r.isVisibleInTranscriptOnly === true && r.isCompactSummary !== true)) {
      skip("meta");
      continue;
    }
    const msg = isRecord(r.message) ? r.message : null;
    if (msg === null) continue;
    const time = validTime(r.timestamp);
    const stamp = time ? { time } : {};

    if (r.type === "assistant") {
      if (typeof msg.model === "string" && msg.model !== "<synthetic>") model = cleanLabel(msg.model);
      const id = typeof msg.id === "string" ? msg.id : `uuid:${r.uuid ?? order}`;
      if (assistant === null || assistant.id !== id) {
        flushAssistant();
        assistant = { id, blocks: [], time };
      }
      const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
      const index = typeof r.apiBlockIndex === "number" ? r.apiBlockIndex : Number.MAX_SAFE_INTEGER;
      for (const b of blocks) {
        if (!isRecord(b)) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
          assistant.blocks.push({ index, order: order++, part: textPart(b.text) });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const name = b.name;
          bump(report.toolCalls, name);
          const filePath = isRecord(b.input) && typeof b.input.file_path === "string" ? b.input.file_path : undefined;
          if (typeof b.id === "string") toolUses.set(b.id, { name, ...(filePath === undefined ? {} : { path: filePath }) });
          const input = cleanCut(JSON.stringify({ name, input: b.input ?? {} }), TOOL_INPUT_CHARS);
          assistant.blocks.push({ index, order: order++, part: { type: "code", language: "json", text: input } });
        } else if (b.type === "thinking" || b.type === "redacted_thinking") {
          skip("thinking");
        } else if (b.type === "image") {
          assistant.blocks.push({ index, order: order++, part: { type: "omitted", reason: "image" } });
        }
      }
      continue;
    }

    // A user record: the person's prompt, a tool result, or the summary written at a compaction.
    flushAssistant();
    const content = msg.content;
    if (r.isCompactSummary === true) {
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => isRecord(c) && c.type === "text").map((c) => c.text).join("\n") : "";
      compactionIndex = messages.length;
      push({ role: "system", ...stamp, parts: [textPart(`Earlier conversation, summarized when the context was compacted:\n\n${text}`)] });
      continue;
    }
    if (typeof content === "string") {
      if (content.trim() === "") continue;
      firstPrompt ??= content;
      push({ role: "user", ...stamp, parts: [textPart(content)] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    /** @type {Part[]} */
    const userParts = [];
    for (const c of content) {
      if (!isRecord(c)) continue;
      if (c.type === "text" && typeof c.text === "string" && c.text.trim() !== "") {
        firstPrompt ??= c.text;
        userParts.push(textPart(c.text));
      } else if (c.type === "image") {
        userParts.push({ type: "omitted", reason: "image" });
      } else if (c.type === "document") {
        userParts.push({ type: "omitted", reason: "file" });
      } else if (c.type === "tool_result") {
        const use = typeof c.tool_use_id === "string" ? toolUses.get(c.tool_use_id) : undefined;
        const name = use?.name ?? "unknown";
        if (!KEPT_TOOL_RESULTS.has(name)) {
          bump(report.toolResultsDropped, name);
          continue;
        }
        if (name === "Read" && use?.path !== undefined) {
          if (SECRET_PATH_RE.test(basename(use.path))) {
            report.secretPathsSkipped.push(scrub(use.path, {}, opts.home));
            bump(report.toolResultsDropped, name);
            push({ role: "tool", ...stamp, parts: [{ type: "omitted", reason: "file" }] });
            continue;
          }
          report.pathsRead.push(scrub(use.path, {}, opts.home));
        }
        bump(report.toolResultsKept, name);
        /** @type {Part[]} */
        const parts = [];
        const items = typeof c.content === "string" ? [{ type: "text", text: c.content }] : Array.isArray(c.content) ? c.content : [];
        for (const item of items) {
          if (!isRecord(item)) continue;
          if (item.type === "image") parts.push({ type: "omitted", reason: "image" });
          else if (item.type === "text" && typeof item.text === "string") {
            if (/<persisted-output>/.test(item.text)) parts.push({ type: "omitted", reason: "unsupported" });
            else parts.push({ type: "code", text: cleanCut(item.text, TOOL_RESULT_CHARS) });
          }
        }
        if (parts.length > 0) push({ role: "tool", ...stamp, parts });
      }
    }
    if (userParts.length > 0) push({ role: "user", ...stamp, parts: userParts });
  }
  flushAssistant();

  // Messages hold at most transcriptPartsPerMessage parts: a long run of tool results is split.
  /** @type {Message[]} */
  const split = [];
  const summary = messages[compactionIndex];
  for (const m of messages) {
    if (m === summary) compactionIndex = split.length;
    for (let i = 0; i < m.parts.length; i += LIMITS.transcriptPartsPerMessage) {
      split.push({ ...m, parts: m.parts.slice(i, i + LIMITS.transcriptPartsPerMessage) });
    }
  }
  report.pathsRead = [...new Set(report.pathsRead)];
  report.links = [...links].sort();
  const titleText = title ?? (firstPrompt === undefined ? undefined : cleanLabel(scrub(firstPrompt, {}, opts.home)));
  /** @type {Transcript} */
  const transcript = { v: 1, ...(titleText ? { title: titleText } : {}), assistantName: ASSISTANT_NAME, ...(model ? { model } : {}), messages: split };
  report.messages = split.length;
  return { transcript, report, compactionIndex };
}

const encoder = new TextEncoder();

/** @param {unknown} v */
function byteSize(v) {
  return encoder.encode(JSON.stringify(v)).length;
}

/** The last segment of a POSIX or Windows path. @param {string} p */
function basename(p) {
  return p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
}

/** Room kept for the leading note that says what was dropped. */
const NOTE_ROOM = 2000;

/**
 * Fits the transcript into `maxBytes` and the message cap, in this order: cut tool results harder, drop the oldest
 * tool messages, then the oldest turns. The last compaction summary and the last KEEP_LAST_TURNS messages stay unless
 * nothing else is left to drop, and then only the summary and the last message do. A leading system message says what was dropped. Each message is measured once (and again only when it is
 * shortened), so fitting a large session costs one serialization, not one per step. Mutates `report.truncated`,
 * `report.messages`, `report.bytes`.
 * @param {Transcript} t
 * @param {Report} report
 * @param {number} compactionIndex
 * @param {number} maxBytes
 * @returns {Transcript}
 */
export function fitBudget(t, report, compactionIndex, maxBytes) {
  const summary = t.messages[compactionIndex];
  const measured = (/** @type {Message} */ m) => ({ m, size: byteSize(m) + 1 });
  let items = t.messages.map(measured);
  const envelope = byteSize({ ...t, messages: [] }) + NOTE_ROOM;
  const total = () => items.reduce((n, i) => n + i.size, envelope);
  const notes = [];

  if (total() > maxBytes) {
    let shortened = 0;
    items = items.map((item) => {
      if (item.m.role !== "tool" || !item.m.parts.some((p) => p.type === "code" && p.text.length > TOOL_RESULT_CHARS_TIGHT + 60)) return item;
      const parts = item.m.parts.map((p) => {
        if (p.type !== "code" || p.text.length <= TOOL_RESULT_CHARS_TIGHT + 60) return p;
        shortened++;
        return { ...p, text: cut(p.text, TOOL_RESULT_CHARS_TIGHT) };
      });
      return measured({ ...item.m, parts });
    });
    if (shortened > 0) notes.push(`${shortened} tool results were shortened`);
  }
  /**
   * @param {(m: Message) => boolean} droppable
   * @param {number} [keepLast]
   */
  const dropOldest = (droppable, keepLast = KEEP_LAST_TURNS) => {
    let size = total();
    const keep = new Set(items.slice(-keepLast).map((i) => i.m));
    if (summary !== undefined) keep.add(summary);
    const before = items.length;
    items = items.filter((item) => {
      if (size <= maxBytes || keep.has(item.m) || !droppable(item.m)) return true;
      size -= item.size;
      return false;
    });
    return before - items.length;
  };
  const toolsDropped = dropOldest((m) => m.role === "tool");
  if (toolsDropped > 0) notes.push(`${toolsDropped} older tool messages were left out`);
  // The last messages give way too, before an export the server would refuse; the summary and the last message stay.
  const turnsDropped = dropOldest(() => true) + dropOldest(() => true, 1);
  if (turnsDropped > 0) notes.push(`${turnsDropped} older messages were left out`);

  let messages = items.map((i) => i.m);
  if (messages.length > LIMITS.transcriptMessages - 1) {
    const over = messages.length - (LIMITS.transcriptMessages - 1);
    const tail = messages.slice(over);
    messages = summary === undefined || tail.includes(summary) ? tail : [summary, ...tail.slice(1)];
    notes.push(`${over} oldest messages were left out to stay under ${LIMITS.transcriptMessages} messages`);
  }
  if (notes.length > 0) {
    messages.unshift({ role: "system", parts: [{ type: "text", text: `This export was shortened to fit: ${notes.join("; ")}.` }] });
  }
  report.truncated = notes;
  const out = { ...t, messages };
  report.messages = messages.length;
  report.bytes = byteSize(out);
  return out;
}
