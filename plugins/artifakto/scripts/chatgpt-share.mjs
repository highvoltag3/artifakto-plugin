// @ts-check
/**
 * Decodes a ChatGPT share page into the transcript format artifakto.ai stores (docs/phase-6-sources-spec.md).
 *
 * Pure JavaScript with no imports, so the CLI and the browser extension run the same file (the extension keeps a
 * byte-identical copy; after editing this file run `pnpm sync:plugin-cli`).
 *
 * A share page carries its conversation as React Router turbo-stream chunks: `GET /share/<id>.data`, or inline
 * `window.__reactRouterContext.streamController.enqueue("...")` scripts in the HTML. This file decodes that stream and
 * copies out ONLY the conversation: the payload also holds session values (an access token among them) that must never
 * reach a published page, so nothing is passed through except the whitelisted fields read below.
 */

/** Why a share could not be turned into a transcript. */
export class ShareError extends Error {
  /**
   * @param {"unreadable" | "deleted" | "unsupported"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ShareError";
    this.code = code;
  }
}

/**
 * Copies of lib/domain/limits.ts (transcript*, titleChars), pinned by a parity test, plus `totalChars`: the text kept
 * across the whole conversation, so that a payload which repeats one huge string cannot balloon into a transcript
 * past the server's index limit (the stream stores each distinct string once). A longer conversation is cut, and
 * `stats.truncated` says so.
 */
export const SHARE_LIMITS = { messages: 5000, partsPerMessage: 100, partChars: 500_000, titleChars: 200, totalChars: 4_000_000 };
const MAX_DEPTH = 300;

const SHARE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width, bidirectional-control and Unicode tag characters: invisible in a title, yet able to spoof or carry hidden text. */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
/** ChatGPT wraps citation and entity markers in private-use characters: U+E200 opens, U+E201 closes, U+E202 separates. */
const CITATION_RE = /\uE200[^\uE200\uE201]*\uE201/g;
const MARKER_CHARS_RE = /[\uE200-\uE2FF]/g;

/**
 * The share id of a ChatGPT share URL, or null for anything else (other hosts, other paths such as /s/ posts or
 * /share/e/, an id that is not a UUID). A link without a scheme is read as https.
 * @param {string} input
 * @returns {string | null}
 */
export function parseShareUrl(input) {
  const trimmed = input.trim();
  /** @type {URL} */
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !SHARE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const m = /^\/share\/([^/]+?)(?:\.data)?\/?$/.exec(url.pathname);
  return m !== null && SHARE_ID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------------------------------------------
// turbo-stream (the format of the `turbo-stream` package: a flat pool of values that later chunks append to)

const SENTINELS = new Map([
  [-1, undefined], // hole
  [-2, Number.NaN],
  [-3, Number.NEGATIVE_INFINITY],
  [-4, -0],
  [-5, null],
  [-6, Number.POSITIVE_INFINITY],
  [-7, undefined],
]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The strings of the `enqueue("...")` calls in a share page, in order. Scanned by hand: a regular expression over a
 * literal of several megabytes overflows V8's backtracking stack.
 * @param {string} html
 * @returns {string[]}
 */
function enqueuedChunks(html) {
  /** @type {string[]} */
  const chunks = [];
  const marker = "streamController.enqueue(";
  let from = 0;
  for (;;) {
    const at = html.indexOf(marker, from);
    if (at < 0) break;
    let start = at + marker.length;
    while (start < html.length && /\s/.test(html[start])) start++;
    from = start;
    if (html[start] !== '"') continue;
    let end = start + 1;
    while (end < html.length && html[end] !== '"') end += html[end] === "\\" ? 2 : 1;
    if (end >= html.length) break;
    try {
      const chunk = JSON.parse(html.slice(start, end + 1));
      if (typeof chunk === "string") chunks.push(chunk);
    } catch {
      // not a JSON string literal, so not a chunk
    }
    from = end + 1;
  }
  return chunks;
}

/**
 * The lines of a chunk stream: the main pool first, then `P<id>:<pool>` (a resolved promise) and `E<id>:<pool>` lines.
 * @param {string} text the `.data` body, or share HTML
 * @returns {string[]}
 */
function chunkLines(text) {
  const chunks = enqueuedChunks(text);
  const source = chunks.length > 0 ? chunks.join("") : text;
  return source.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
}

/**
 * @param {string} json
 * @returns {unknown[]}
 */
function parsePool(json) {
  /** @type {unknown} */
  let pool;
  try {
    pool = JSON.parse(json);
  } catch {
    throw new ShareError("unreadable", "The share page's data could not be read.");
  }
  if (!Array.isArray(pool) || pool.length === 0) throw new ShareError("unreadable", "The share page's data could not be read.");
  return pool;
}

/**
 * Decodes a turbo-stream to the value at the root of its main pool. Every chunk appends its values to ONE shared pool
 * (its indices already count the ones before it), and the root of a promise chunk is the chunk's first value.
 * @param {string[]} lines
 * @returns {unknown}
 */
function decodeTurboStream(lines) {
  const first = lines.findIndex((l) => l.startsWith("["));
  if (first < 0) throw new ShareError("unreadable", "This does not look like a ChatGPT share page.");
  const items = parsePool(lines[first]);
  /** @type {Map<string, number>} chunk id ("P12") to the pool index of its root */
  const roots = new Map();
  for (const line of lines.slice(first + 1)) {
    const m = /^([PE])(\d+):/.exec(line);
    if (m === null) continue;
    roots.set(m[1] + m[2], items.length);
    for (const v of parsePool(line.slice(m[0].length))) items.push(v);
  }
  /** @type {Map<number, unknown>} */
  const memo = new Map();

  /**
   * @param {unknown} index
   * @param {number} level how deep the decoding has recursed, promises included
   * @returns {unknown}
   */
  function value(index, level) {
    if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
    if (index < 0) return SENTINELS.get(index);
    if (index >= items.length) return undefined;
    if (memo.has(index)) return memo.get(index);
    if (level > MAX_DEPTH) throw new ShareError("unreadable", "The share page's data is nested too deeply.");
    const raw = items[index];
    if (raw === null || typeof raw !== "object") {
      memo.set(index, raw);
      return raw;
    }
    // Register a placeholder first: a value that refers back to itself reads undefined there instead of recursing.
    memo.set(index, undefined);
    if (Array.isArray(raw)) {
      if (typeof raw[0] === "string") {
        const typed = typedValue(raw, level);
        memo.set(index, typed);
        return typed;
      }
      /** @type {unknown[]} */
      const list = [];
      memo.set(index, list);
      for (const item of raw) list.push(value(item, level + 1));
      return list;
    }
    const object = objectValue(raw, level);
    memo.set(index, object);
    return object;
  }

  /**
   * @param {object} raw an object entry: {"_K": V}, the key string at pool index K and the value at V
   * @param {number} level
   * @returns {Record<string, unknown>}
   */
  function objectValue(raw, level) {
    /** @type {Record<string, unknown>} */
    const object = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = k.startsWith("_") ? items[Number(k.slice(1))] : undefined;
      if (typeof key !== "string" || UNSAFE_KEYS.has(key)) continue;
      object[key] = value(v, level + 1);
    }
    return object;
  }

  /**
   * @param {unknown[]} raw a typed marker. ["P", id] a resolved promise, ["Z", i] a repeat of pool value i and ["N", {...}]
   *   an object without a prototype are read; the others (dates, sets, maps, errors, URLs, bigints) read as undefined,
   *   since nothing a conversation needs is stored that way.
   * @param {number} level
   * @returns {unknown}
   */
  function typedValue(raw, level) {
    switch (raw[0]) {
      case "P": {
        const root = roots.get("P" + String(raw[1]));
        return root === undefined ? undefined : value(root, level + 1);
      }
      case "Z":
        return value(raw[1], level + 1);
      case "N":
        return typeof raw[1] === "object" && raw[1] !== null && !Array.isArray(raw[1]) ? objectValue(raw[1], level) : undefined;
      default:
        return undefined;
    }
  }

  return value(0, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// locating the conversation

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The first object under `root` (depth first) that has `key`, without walking cycles.
 * @param {unknown} root
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
function findWithKey(root, key) {
  /** @type {Set<unknown>} */
  const seen = new Set();
  /** @type {unknown[]} */
  const stack = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (isObject(v) && Object.prototype.hasOwnProperty.call(v, key)) return v;
    const children = Array.isArray(v) ? v : Object.values(v);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// transcript

/**
 * @typedef {{ type: "text"; text: string } | { type: "code"; language?: string; text: string } | { type: "omitted"; reason: "image" | "file" | "unsupported" }} Part
 * @typedef {{ role: "user" | "assistant" | "system" | "tool"; time?: string; parts: Part[] }} Message
 * @typedef {{ v: 1; title?: string; assistantName: string; model?: string; messages: Message[] }} Transcript
 * @typedef {{ skipped: number; images: number; files: number; unsupported: number; chars: number; truncated: boolean }} Stats
 */

/** Content types that are the model's own reasoning or ChatGPT's private context, not part of the conversation. */
const DROPPED_CONTENT_TYPES = new Set(["thoughts", "reasoning_recap", "model_editable_context", "user_editable_context"]);

/**
 * A short single-line label: invisible and control characters removed, whitespace collapsed, cut to `max` characters.
 * @param {unknown} s
 * @param {number} max
 * @returns {string | undefined}
 */
function cleanLabel(s, max) {
  if (typeof s !== "string") return undefined;
  // Bounded first: a hostile field of megabytes costs no more than a normal one.
  const bounded = s.slice(0, max * 8);
  const cleaned = Array.from(bounded.replace(INVISIBLE_RE, "").replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("");
  return cleaned === "" ? undefined : cleaned;
}

/**
 * Text for a part, within the per-part and whole-conversation limits, with citation markers removed. Marks the
 * conversation truncated when it cuts.
 * @param {string} raw
 * @param {Stats} stats
 * @returns {string}
 */
function takeText(raw, stats) {
  const limit = Math.min(SHARE_LIMITS.partChars, SHARE_LIMITS.totalChars - stats.chars);
  if (limit <= 0) {
    stats.truncated = true;
    return "";
  }
  // Cut before cleaning, generously (markers shrink the text), so a hostile string costs at most about `limit`.
  const bounded = raw.length > limit * 2 ? raw.slice(0, limit * 2) : raw;
  let text = bounded.replace(CITATION_RE, "").replace(MARKER_CHARS_RE, "").replace(/\u0000/g, "");
  if (bounded.length < raw.length || text.length > limit) {
    stats.truncated = true;
    text = text.slice(0, limit);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1); // not half a surrogate pair
  }
  stats.chars += text.length;
  return text;
}

/**
 * @param {unknown} seconds epoch seconds, as ChatGPT writes them (a float)
 * @returns {string | undefined}
 */
function isoTime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999 ? undefined : d.toISOString();
}

/**
 * @param {Record<string, unknown>} message
 * @param {Stats} stats
 * @returns {(Message & { modelSlug?: unknown }) | null} the message, and the model slug an assistant message carries
 */
function convertMessage(message, stats) {
  const author = isObject(message.author) ? message.author : {};
  const meta = isObject(message.metadata) ? message.metadata : {};
  if (meta.is_visually_hidden_from_conversation === true) {
    stats.skipped++;
    return null;
  }
  const authorRole = author.role;
  if (authorRole !== "user" && authorRole !== "assistant" && authorRole !== "system" && authorRole !== "tool") return null;
  // An assistant turn addressed to a tool (a code-interpreter call, a search query) is plumbing, not speech.
  const toTool = authorRole === "assistant" && typeof message.recipient === "string" && message.recipient !== "all";
  const role = toTool ? "tool" : authorRole;

  const content = isObject(message.content) ? message.content : {};
  const type = content.content_type;
  if (typeof type === "string" && DROPPED_CONTENT_TYPES.has(type)) {
    stats.skipped++;
    return null;
  }
  /** @type {Part[]} */
  const parts = [];
  /** @param {Part} part */
  const add = (part) => {
    if (parts.length >= SHARE_LIMITS.partsPerMessage) stats.truncated = true;
    else parts.push(part);
  };
  if (type === "text" || type === "multimodal_text") {
    for (const p of Array.isArray(content.parts) ? content.parts : []) {
      if (typeof p === "string") {
        const text = takeText(p, stats);
        if (text.trim() !== "") add({ type: "text", text });
      } else if (isObject(p) && p.content_type === "image_asset_pointer") {
        stats.images++;
        add({ type: "omitted", reason: "image" });
      } else if (p !== null && p !== undefined) {
        stats.unsupported++;
        add({ type: "omitted", reason: "unsupported" });
      }
    }
  } else if (type === "code" || type === "execution_output" || type === "system_error") {
    const text = typeof content.text === "string" ? takeText(content.text, stats) : "";
    if (text.trim() !== "") {
      const language = typeof content.language === "string" && /^[A-Za-z0-9][A-Za-z0-9+#._-]{0,31}$/.test(content.language) && content.language !== "unknown"
        ? content.language
        : undefined;
      add({ type: "code", language, text });
    }
  } else if (typeof type === "string") {
    stats.unsupported++;
    add({ type: "omitted", reason: "unsupported" });
  }
  for (const a of Array.isArray(meta.attachments) ? meta.attachments : []) {
    if (isObject(a)) {
      stats.files++;
      add({ type: "omitted", reason: "file" });
    }
  }
  if (parts.length === 0) return null;
  return { role, time: isoTime(message.create_time), parts, modelSlug: role === "assistant" ? meta.model_slug : undefined };
}

/**
 * Turns the decoded conversation object (`serverResponse.data`) into a transcript.
 * @param {Record<string, unknown>} conversation
 * @returns {{ transcript: Transcript; stats: Stats }}
 */
function buildTranscript(conversation) {
  /** @type {Stats} */
  const stats = { skipped: 0, images: 0, files: 0, unsupported: 0, chars: 0, truncated: false };
  /** @type {Message[]} */
  const messages = [];
  /** @type {string | undefined} */
  let model = cleanLabel(conversation.default_model_slug, 100) ?? cleanLabel(conversation.model, 100);
  for (const node of /** @type {unknown[]} */ (conversation.linear_conversation)) {
    if (!isObject(node) || !isObject(node.message)) continue;
    if (messages.length >= SHARE_LIMITS.messages || stats.chars >= SHARE_LIMITS.totalChars) {
      stats.truncated = true;
      break;
    }
    const converted = convertMessage(node.message, stats);
    if (converted === null) continue;
    const { modelSlug, ...message } = converted;
    model ??= cleanLabel(modelSlug, 100);
    messages.push(message);
  }
  if (messages.length === 0) throw new ShareError("unsupported", "This share has no visible messages to capture.");
  // Absent values stay undefined and JSON.stringify leaves them out.
  return { transcript: { v: 1, title: cleanLabel(conversation.title, SHARE_LIMITS.titleChars), assistantName: "ChatGPT", model, messages }, stats };
}

/**
 * Decodes a ChatGPT share (the `.data` body or the share page's HTML) into a transcript. `shareId` is the id the page
 * says it belongs to, when it says.
 * @param {string} text
 * @returns {{ transcript: Transcript; stats: Stats; shareId?: string }}
 * @throws {ShareError} unreadable (not a share page, or its format changed), deleted, or unsupported (a post share, no messages)
 */
export function decodeShare(text) {
  const root = decodeTurboStream(chunkLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  const holder = findWithKey(root, "serverResponse");
  if (holder !== null) {
    const response = holder.serverResponse;
    if (isObject(response) && response.type === "error") {
      throw new ShareError("deleted", "This share is gone: ChatGPT reports the conversation as deleted or unavailable.");
    }
  }
  const conversation = findWithKey(root, "linear_conversation");
  if (conversation === null || !Array.isArray(conversation.linear_conversation)) {
    if (findWithKey(root, "postWithProfile") !== null) {
      throw new ShareError("unsupported", "This is a single-response post share (chatgpt.com/s/...), which cannot be captured yet. Share the whole conversation instead.");
    }
    throw new ShareError("unreadable", "No conversation was found in this page. ChatGPT may have changed its share format.");
  }
  const id = holder !== null && typeof holder.sharedConversationId === "string" ? holder.sharedConversationId.toLowerCase() : undefined;
  return { ...buildTranscript(conversation), shareId: id };
}

/**
 * What a capture left out, one plain sentence each, for the CLI's report and the extension's preview.
 * @param {Stats} stats
 * @returns {string[]}
 */
export function captureNotes(stats) {
  const notes = [];
  if (stats.images > 0) notes.push(`${stats.images} images not included (their links expire within minutes)`);
  if (stats.files > 0) notes.push(`${stats.files} attached files not included`);
  if (stats.unsupported > 0) notes.push(`${stats.unsupported} unsupported items not included`);
  if (stats.skipped > 0) notes.push(`${stats.skipped} hidden or reasoning messages skipped`);
  if (stats.truncated) notes.push("conversation cut at the size limits");
  return notes;
}
