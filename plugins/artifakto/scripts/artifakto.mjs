#!/usr/bin/env node
// @ts-check
/**
 * artifakto: mirror AI-made HTML pages to artifakto.ai or a self-hosted instance.
 *
 * Zero dependencies, Node >= 22.12. Only `capture`, `session-export` and the thread commands need more files
 * (chatgpt-share.mjs, claude-session.mjs with session-core.mjs, thread-core.mjs), loaded when they run, so every other
 * command works from this file alone. Contract:
 * docs/mvp-spec.md section 10, and docs/phase-8-threads-spec.md for the thread commands.
 * The plugin ships byte-identical copies (plugins/artifakto/scripts/); after editing either file run `pnpm sync:plugin-cli`.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { promises as fsp } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const VERSION = "0.1.0";

const DEFAULT_HOST = "https://artifakto.ai";
const MiB = 1024 * 1024;
const LIMITS = {
  indexBytes: 16 * MiB,
  textFileBytes: 16 * MiB,
  binaryFileBytes: 15 * MiB,
  versionBytes: 64 * MiB,
  maxFiles: 255,
};
const JSON_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const UPLOAD_CONCURRENCY = 4;
const READ_CONCURRENCY = 8;
const LISTED_PATHS = 20;
const UNREFERENCED_SHOWN = 10;
const RANDOM_SLUG_LENGTH = 10;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

const PROVIDERS = ["claude-code", "claude-chat", "chatgpt", "file", "other"];
/** Same set as lib/domain/types.ts SOURCE_TYPES. application/vnd.ant.react is deliberately absent (not supported yet). */
const TRANSCRIPT_SOURCE_TYPE = "application/vnd.artifakto.transcript+json";
const CLAUDE_DOCS_SOURCE_TYPE = "application/vnd.artifakto.claude-docs+json";
const SOURCE_TYPES = ["text/html", "text/markdown", "image/svg+xml", "application/vnd.ant.mermaid", "application/vnd.ant.code",
  TRANSCRIPT_SOURCE_TYPE, CLAUDE_DOCS_SOURCE_TYPE];
/** Source types whose index is our own JSON, rendered by the server: their text is content, never the page's title or runtime use. */
const JSON_SOURCE_TYPES = [TRANSCRIPT_SOURCE_TYPE, CLAUDE_DOCS_SOURCE_TYPE];
const VISIBILITIES = ["public", "unlisted", "password", "members"];
/** push only ever creates public/unlisted artifacts (P2: a password/members artifact needs `set` after creation, to actually configure the protection); `set` validates against the wider VISIBILITIES above. */
const PUSH_VISIBILITIES = ["public", "unlisted"];
const MODES = ["mirror", "redirect"];
const OVERRIDE_KEYS = [
  "provider",
  "sourceId",
  "sourceUrl",
  "sourceVersion",
  "sourceType",
  "title",
  "description",
  "favicon",
  "slug",
  "mode",
  "visibility",
];
/** Override keys whose value may be null (clear the stored value). */
const NULLABLE_OVERRIDE_KEYS = ["sourceId", "sourceUrl", "sourceVersion", "description", "favicon"];

/** Same table as lib/domain/content-types.ts EXTENSION_TYPES. */
const EXTENSION_TYPES = /** @type {Readonly<Record<string, string>>} */ ({
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", xhtml: "application/xhtml+xml; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8", md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  xml: "application/xml; charset=utf-8", yaml: "text/yaml; charset=utf-8", yml: "text/yaml; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  wasm: "application/wasm", pdf: "application/pdf", glb: "model/gltf-binary", gltf: "model/gltf+json",
});
const TEXT_LIKE = new Set(["application/json", "application/manifest+json", "application/xml",
  "application/xhtml+xml", "image/svg+xml", "text/javascript", "application/javascript", "model/gltf+json"]);
/** Extensions whose contents count as mentioning another file (10.7 step 4). */
const REFERENCING_EXTENSIONS = new Set(["html", "htm", "css", "js", "mjs", "json", "svg", "webmanifest"]);
const SECRET_NAME_RE = /^(?:.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|id_rsa.*|id_dsa.*|id_ecdsa.*|id_ed25519.*)$/i;
const RUNTIME_RE = /\bclaude\s*\.\s*use\s*\(|\bwindow\.claude\b/;
const NAMESPACE_RE = /\bclaude\s*\.\s*use\s*\(\s*["'`]([a-z][a-z0-9_-]*)["'`]/g;
const TITLE_MAX = 200;
/** The shape of lib/domain/manifest.ts EMAIL_RE. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---------------------------------------------------------------------------------------------------------------
// API shapes (duplicating lib/api/types.ts)

/** @typedef {"claude-code" | "claude-chat" | "chatgpt" | "file" | "other"} Provider */
/** @typedef {{ code: string; message: string; details?: unknown }} WarningJson */
/** @typedef {{ error: { code: string; message: string; details?: unknown } }} ErrorJson */
/**
 * @typedef {{
 *   id: string; slug: string; url: string; title: string; description: string | null; favicon: string | null;
 *   provider: Provider; sourceId: string | null; sourceUrl: string | null; sourceType: string;
 *   mode: "mirror" | "redirect"; visibility: "public" | "unlisted" | "password" | "members";
 *   currentVersion: number; disabled: boolean; disabledAt: string | null; createdAt: string; updatedAt: string;
 *   hasPassword: boolean; memberCount: number;
 * }} ArtifactJson
 */
/** @typedef {{ emails: string[] }} MembersJson */
/**
 * @typedef {{
 *   n: number; current: boolean; createdAt: string; indexKind: "fragment" | "document"; usesRuntime: boolean;
 *   usesMermaid: boolean; sourceVersion: string | null; indexSha256: string; contentHash: string;
 *   totalBytes: number; fileCount: number;
 * }} VersionJson
 */
/** @typedef {{ path: string; contentType: string; size: number; sha256: string }} FileJson */
/**
 * @typedef {{
 *   status: "created" | "updated" | "unchanged"; url: string; slug: string; version: number; unchanged: boolean;
 *   metadataUpdated: boolean; artifact: ArtifactJson; warnings: WarningJson[];
 * }} PublishResultJson
 */
/** @typedef {{ sha256: string; method: "PUT"; url: string; headers: Record<string, string>; auth: "bearer" | "none" }} UploadTarget */
/**
 * @typedef {{
 *   status: "upload_required"; uploadId: string; expiresAt: string; uploads: UploadTarget[]; commitUrl: string;
 *   warnings: WarningJson[];
 * }} UploadRequiredJson
 */
/** @typedef {{ artifact: ArtifactJson; versions: VersionJson[]; files: FileJson[] }} ArtifactDetailJson */
/** @typedef {{ items: ArtifactJson[]; nextCursor: string | null }} ListJson */
/** @typedef {{ artifact: ArtifactJson; warnings: WarningJson[] }} MutationJson */
/**
 * @typedef {{
 *   url: string; slug: string; version: number; previousVersion: number; unchanged: boolean;
 *   artifact: ArtifactJson; warnings: WarningJson[];
 * }} RollbackJson
 */
/**
 * @typedef {{
 *   id: string; kind: "handoff" | "request"; by: string; at: string; title?: string; brief: string;
 *   git?: { remote: string; branch: string; head?: string }; transcript?: { path: string; messages: number; bytes: number };
 * }} ThreadEntryJson
 */
/** @typedef {{ url: string; slug: string; version: number; total: number; entry: ThreadEntryJson }} ThreadWriteJson */
/**
 * @typedef {{
 *   url: string; slug: string; title: string; members: string[]; version: number; total: number;
 *   entries: ThreadEntryJson[]; files: FileJson[];
 * }} ThreadJson
 */
/**
 * @typedef {{
 *   ok: boolean; service: "artifakto.ai"; version: string; store: "local" | "vercel" | null;
 *   checks: { db: string; blob: string; auth: "configured" | "unconfigured" };
 * }} HealthJson
 */

// ---------------------------------------------------------------------------------------------------------------
// Errors and output

class CliError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} code
   * @param {string} message
   * @param {{ details?: unknown; lines?: string[]; usage?: string }} [extra]
   */
  constructor(exitCode, code, message, extra = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = extra.details;
    this.lines = extra.lines;
    this.usage = extra.usage;
  }
}

/**
 * @param {string} message
 * @param {string | null} command
 */
function usageError(message, command) {
  return new CliError(2, "usage_error", message, { usage: usageHint(command) });
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 */
function validationError(code, message, details) {
  return new CliError(4, code, message, details === undefined ? {} : { details });
}

let jsonMode = false;

/** @param {string} line */
function out(line) {
  process.stdout.write(`${line}\n`);
}

/** @param {string} line */
function errLine(line) {
  process.stderr.write(`${line}\n`);
}

/** @param {string} message */
function warn(message) {
  errLine(`warning: ${message}`);
}

/** @param {unknown} doc */
function printJson(doc) {
  out(JSON.stringify(doc));
}

/** @param {WarningJson[] | undefined} warnings */
function printWarnings(warnings) {
  for (const w of warnings ?? []) warn(w.message);
}

// ---------------------------------------------------------------------------------------------------------------
// Argument parsing

/** @typedef {{ [name: string]: string | boolean | (string | boolean)[] | undefined }} Values */

/** @type {NonNullable<import("node:util").ParseArgsConfig["options"]>} */
const OPTIONS = {
  host: { type: "string" },
  token: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean" },
  version: { type: "boolean" },
  file: { type: "string", multiple: true },
  "from-file": { type: "string" },
  slug: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  "no-description": { type: "boolean" },
  favicon: { type: "string" },
  "no-favicon": { type: "boolean" },
  provider: { type: "string" },
  "source-id": { type: "string" },
  "source-url": { type: "string" },
  "no-source-url": { type: "boolean" },
  "source-version": { type: "string" },
  "source-type": { type: "string" },
  visibility: { type: "string" },
  mode: { type: "string" },
  manifest: { type: "string" },
  "include-secrets": { type: "boolean" },
  yes: { type: "boolean" },
  "dry-run": { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
  "random-slug": { type: "boolean" },
  enable: { type: "boolean" },
  disable: { type: "boolean" },
  to: { type: "string" },
  "token-stdin": { type: "boolean" },
  password: { type: "string" },
  "no-password": { type: "boolean" },
  "add-member": { type: "string", multiple: true },
  "remove-member": { type: "string", multiple: true },
  email: { type: "string" },
  member: { type: "string", multiple: true },
  as: { type: "string" },
  entry: { type: "string" },
  transcript: { type: "string" },
  request: { type: "string" },
  since: { type: "string" },
  out: { type: "string" },
  marker: { type: "string" },
  "brief-only": { type: "boolean" },
  "max-bytes": { type: "string" },
  local: { type: "boolean" },
};

const GLOBAL_OPTIONS = ["host", "token", "json", "help"];

/**
 * @typedef {{
 *   usage: string; summary: string; positionals: [number, number]; arg?: string; options: string[];
 *   flags: [string, string][]; run: (values: Values, args: string[]) => Promise<void>;
 * }} CommandSpec
 */

/** @type {Record<string, CommandSpec>} */
const COMMANDS = {
  push: {
    usage: "artifakto push [<file-or-dir>] [flags]",
    summary: "Publish an HTML file, a folder, or explicit --file pairs.",
    positionals: [0, 1],
    options: ["file", "slug", "title", "description", "favicon", "provider", "source-id", "source-url",
      "source-version", "source-type", "visibility", "mode", "manifest", "include-secrets", "yes", "dry-run"],
    flags: [
      ["--file <path>=<local file>", "Push exactly these files (repeatable; instead of a file or folder)"],
      ["--slug <slug>", "Address to publish at"],
      ["--title <text>", "Title (default: the page's <title> or <h1>, else the file or folder name)"],
      ["--description <text>", "Description"],
      ["--favicon <emoji>", "One or two emoji"],
      ["--provider <name>", "claude-code, claude-chat, chatgpt, file or other"],
      ["--source-id <id>", "Source identifier (needs a provider)"],
      ["--source-url <url>", "Where the page came from"],
      ["--source-version <v>", "Source version string"],
      ["--source-type <type>", "text/html (default), text/markdown, image/svg+xml, application/vnd.ant.mermaid, application/vnd.ant.code or application/vnd.artifakto.transcript+json"],
      ["--visibility <v>", "public or unlisted (new artifacts default to unlisted)"],
      ["--mode <mode>", "mirror or redirect"],
      ["--manifest <path.json>", "Override file (same keys as .artifakto.json)"],
      ["--include-secrets", "Also push files that look like keys or credentials"],
      ["--yes", "Push files that no page, stylesheet or script mentions"],
      ["--dry-run", "Show what would be pushed; no token, no network"],
    ],
    run: cmdPush,
  },
  capture: {
    usage: "artifakto capture <share-url> [flags]",
    summary: "Capture a shared ChatGPT conversation and publish it as a transcript page.",
    positionals: [1, 1],
    arg: "a ChatGPT share link",
    options: ["from-file", "slug", "title", "description", "favicon", "visibility", "dry-run"],
    flags: [
      ["--from-file <path>", "Read a saved share page (or its .data) instead of fetching it"],
      ["--slug <slug>", "Address to publish at"],
      ["--title <text>", "Title (default: the conversation's title)"],
      ["--description <text>", "Description"],
      ["--favicon <emoji>", "One or two emoji"],
      ["--visibility <v>", "public or unlisted (new artifacts default to unlisted)"],
      ["--dry-run", "Show what would be pushed; no token, no network to artifakto.ai"],
    ],
    run: cmdCapture,
  },
  list: {
    usage: "artifakto list [--limit <n>] [--cursor <c>]",
    summary: "List your artifacts.",
    positionals: [0, 0],
    options: ["limit", "cursor"],
    flags: [
      ["--limit <1..200>", "Page size"],
      ["--cursor <c>", "Continue a previous listing"],
    ],
    run: cmdList,
  },
  info: {
    usage: "artifakto info <slug>",
    summary: "Show an artifact, its versions and files.",
    positionals: [1, 1],
    options: [],
    flags: [],
    run: cmdInfo,
  },
  set: {
    usage: "artifakto set <slug> [flags]",
    summary: "Change metadata, address, visibility, mode, protection, or enable/disable. Needs a Full key or the server's own token, not a sign-in or a Publish only key.",
    positionals: [1, 1],
    options: ["title", "description", "no-description", "favicon", "no-favicon", "slug", "random-slug",
      "visibility", "mode", "source-url", "no-source-url", "enable", "disable",
      "password", "no-password", "add-member", "remove-member"],
    flags: [
      ["--title <text>", "New title"],
      ["--description <text>", "New description"],
      ["--no-description", "Clear the description"],
      ["--favicon <emoji>", "New favicon"],
      ["--no-favicon", "Clear the favicon"],
      ["--slug <new>", "Rename the address"],
      ["--random-slug", "Move to a random, hard-to-guess 10-character address"],
      ["--visibility <v>", "public, unlisted, password or members"],
      ["--mode <mode>", "mirror or redirect"],
      ["--source-url <url>", "New source URL"],
      ["--no-source-url", "Clear the source URL"],
      ["--enable", "Bring a disabled artifact back online"],
      ["--disable", "Take the artifact offline"],
      ["--password <value|->", "Set the password (\"-\" reads it from stdin; avoids shell history)"],
      ["--no-password", "Clear the password (only once visibility is no longer password)"],
      ["--add-member <email>", "Add an email to the members allowlist (repeatable)"],
      ["--remove-member <email>", "Remove an email from the members allowlist (repeatable)"],
    ],
    run: cmdSet,
  },
  members: {
    usage: "artifakto members <slug>",
    summary: "List the members allowlist of a members-visibility artifact (yours only).",
    positionals: [1, 1],
    options: [],
    flags: [],
    run: cmdMembers,
  },
  rollback: {
    usage: "artifakto rollback <slug> [--to <n>]",
    summary: "Point an artifact at an earlier version (default: the previous one). Needs a Full key or the server's own token, not a sign-in or a Publish only key.",
    positionals: [1, 1],
    options: ["to"],
    flags: [["--to <n>", "Version number to serve"]],
    run: cmdRollback,
  },
  delete: {
    usage: "artifakto delete <slug> --yes",
    summary: "Disable the artifact (take it offline for everyone). Stored files are kept; `set <slug> --enable` restores it. Needs a Full key or the server's own token, not a sign-in or a Publish only key.",
    positionals: [1, 1],
    options: ["yes"],
    flags: [["--yes", "Do not ask for confirmation (required when stdin is not a terminal)"]],
    run: cmdDelete,
  },
  "session-export": {
    usage: "artifakto session-export (--marker <nonce> | <session.jsonl>) [--out <file>] [--brief-only] [--max-bytes <n>]",
    summary: "Export a Claude Code session as a transcript file, filtered and scrubbed, with a report.",
    positionals: [0, 1],
    arg: "a session file or --marker",
    options: ["marker", "out", "brief-only", "max-bytes"],
    flags: [
      ["--marker <nonce>", "Find this directory's session whose file contains the nonce"],
      ["--out <file>", "Where to write the transcript (default: a new file in the temp directory)"],
      ["--brief-only", "Report only; write no transcript"],
      ["--max-bytes <n>", "Size budget for the transcript (default and most: 3670016, 3.5 MiB)"],
    ],
    run: cmdSessionExport,
  },
  "thread-new": {
    usage: "artifakto thread-new <title> --member <email>... (--entry <file> | --request <note>) [flags]",
    summary: "Start a members-only thread with its first entry.",
    positionals: [1, 1],
    arg: "a title",
    options: ["member", "as", "entry", "transcript", "request", "slug", "dry-run"],
    flags: [
      ["--member <email>", "Who else can read and add to it (repeatable)"],
      ["--as <email>", "Your own email, the entry's author, with the server's own token or a key that has no address (default: the one saved by login --email); a sign-in, or a key with an address, writes as its account"],
      ["--entry <file>", "The entry: a .json entry, or any other file as its Markdown brief"],
      ["--transcript <file>", "Attach a transcript from session-export"],
      ["--request <note>", "A short request instead of an entry file"],
      ["--slug <slug>", "Address (default: random)"],
      ["--dry-run", "Show what would be sent; no network"],
    ],
    run: cmdThreadNew,
  },
  "thread-push": {
    usage: "artifakto thread-push [<thread-url>] (--entry <file> | --request <note>) [flags]",
    summary: "Add an entry to a thread (default: the one last used from this directory).",
    positionals: [0, 1],
    arg: "a thread URL",
    options: ["entry", "transcript", "request", "as", "title", "dry-run"],
    flags: [
      ["--entry <file>", "The entry: a .json entry, or any other file as its Markdown brief"],
      ["--title <text>", "The entry's title, for a Markdown brief"],
      ["--transcript <file>", "Attach a transcript from session-export"],
      ["--request <note>", "A short request for the latest, instead of an entry"],
      ["--as <email>", "Author, with the server's own token or a key that has no address (default: the one saved by login --email); a sign-in, or a key with an address, writes as its account"],
      ["--dry-run", "Show the thread and what would be added (the entry is optional here); nothing is added"],
    ],
    run: cmdThreadPush,
  },
  "thread-pull": {
    usage: "artifakto thread-pull [<thread-url>] [--since <n>] [--transcript <id> --out <file>]",
    summary: "Print a thread's new entries, or download one entry's transcript (default: the thread last used from this directory).",
    positionals: [0, 1],
    arg: "a thread URL",
    options: ["since", "transcript", "out"],
    flags: [
      ["--since <n>", "Print entries from index n on (default: those after your last pull)"],
      ["--transcript <id>", "Download this entry's transcript instead"],
      ["--out <file>", "Where to write the transcript (with --transcript)"],
    ],
    run: cmdThreadPull,
  },
  "thread-connect": {
    usage: "artifakto thread-connect <thread-url>",
    summary: "Sign in through the browser and connect this computer to a thread you are a member of (7 days, renewed on use).",
    positionals: [1, 1],
    arg: "a thread URL",
    options: [],
    flags: [],
    run: cmdThreadConnect,
  },
  "thread-disconnect": {
    usage: "artifakto thread-disconnect <thread-url>",
    summary: "Forget this computer's connection to a thread.",
    positionals: [1, 1],
    arg: "a thread URL",
    options: [],
    flags: [],
    run: cmdThreadDisconnect,
  },
  health: {
    usage: "artifakto health",
    summary: "Check the server (no token needed).",
    positionals: [0, 0],
    options: [],
    flags: [],
    run: cmdHealth,
  },
  prepare: {
    usage: "artifakto prepare",
    summary: "Make the config file a sign-in is saved in, readable by you alone, when there is none (no network).",
    positionals: [0, 0],
    options: [],
    flags: [],
    run: cmdPrepare,
  },
  login: {
    usage: "artifakto login [--host <url>] [--token [<key>] | --token-stdin] [--email <email>]",
    summary: "Sign in through the browser, or save a key from the dashboard, for the host.",
    positionals: [0, 0],
    options: ["token-stdin", "email"],
    flags: [
      ["--token [<key>]", "Save a key (or the server's own token) instead of signing in through the browser; without a value, asks for it without echoing it"],
      ["--token-stdin", "Read the key or token from stdin"],
      ["--email <email>", "Your email, the author of thread entries made with the server's own token or a key with no address of its own (a sign-in, or a key with an address, saves its account's)"],
    ],
    run: cmdLogin,
  },
  whoami: {
    usage: "artifakto whoami",
    summary: "Show the account and the sign-in, key or token used for the host, and where it comes from.",
    positionals: [0, 0],
    options: [],
    flags: [],
    run: cmdWhoami,
  },
  logout: {
    usage: "artifakto logout [--host <url>] [--local]",
    summary: "End the saved sign-in or key on the server and remove it here (the server's own token is only removed here).",
    positionals: [0, 0],
    options: ["local"],
    flags: [["--local", "Only remove it here; it keeps working until it is revoked under Keys and apps on the dashboard"]],
    run: cmdLogout,
  },
};

const GLOBAL_FLAGS = /** @type {[string, string][]} */ ([
  ["--host <url>", `API origin (default: $ARTIFAKTO_AI_HOST, the saved host, or ${DEFAULT_HOST})`],
  ["--token <token>", "Key or token for this invocation"],
  ["--json", "Print exactly one JSON document on stdout"],
  ["--help", "Show help"],
]);

/** @param {[string, string][]} rows */
function flagTable(rows) {
  const width = Math.max(0, ...rows.map(([f]) => f.length));
  return rows.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`).join("\n");
}

function globalHelp() {
  const names = Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => n.length));
  return [
    `artifakto ${VERSION}: mirror AI-made HTML pages to artifakto.ai or a self-hosted instance.`,
    "",
    "Usage: artifakto <command> [flags]",
    "",
    "Commands:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${COMMANDS[n].summary}`),
    "",
    "Global flags:",
    flagTable(GLOBAL_FLAGS),
    "  --version        Print the version",
    "",
    "Environment: ARTIFAKTO_AI_HOST, ARTIFAKTO_AI_TOKEN, ARTIFAKTO_AI_PROTECTION_BYPASS, ARTIFAKTO_NO_BROWSER, XDG_CONFIG_HOME.",
    'Run "artifakto <command> --help" for the flags of a command.',
  ].join("\n");
}

/** @param {string} name */
function commandHelp(name) {
  const spec = COMMANDS[name];
  const lines = [`Usage: ${spec.usage}`, "", spec.summary, ""];
  if (spec.flags.length > 0) lines.push("Flags:", flagTable(spec.flags), "");
  lines.push("Global flags:", flagTable(GLOBAL_FLAGS));
  return lines.join("\n");
}

/** @param {string | null} command */
function usageHint(command) {
  if (command !== null && COMMANDS[command]) {
    return `usage: ${COMMANDS[command].usage} (run "artifakto ${command} --help")`;
  }
  return 'usage: artifakto <command> [flags] (run "artifakto --help")';
}

/**
 * @param {Values} values
 * @param {string} name
 * @returns {string | undefined}
 */
function str(values, name) {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * @param {Values} values
 * @param {string} name
 */
function bool(values, name) {
  return values[name] === true;
}

/**
 * @param {Values} values
 * @param {string} name
 * @returns {string[]}
 */
function strs(values, name) {
  const v = values[name];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/** @param {unknown} e */
function parseErrorMessage(e) {
  const message = e instanceof Error ? e.message : String(e);
  return message.split("\n")[0].replace(/\. To specify a positional argument.*$/, "");
}

/**
 * @param {string[]} args
 * @returns {{ values: Values; positionals: string[] }}
 */
function parseArgv(args) {
  return parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: true });
}

/**
 * `argv` with each `--token` that has no value (the last argument, or one followed by another flag) written as an empty
 * `--token=`, or null when there is none.
 * @param {string[]} argv
 */
function withBareToken(argv) {
  const end = argv.indexOf("--");
  let found = false;
  const args = argv.map((a, i) => {
    const bare = a === "--token" && (end === -1 || i < end) && (i + 1 === argv.length || (argv[i + 1].startsWith("-") && argv[i + 1] !== "-"));
    found ||= bare;
    return bare ? "--token=" : a;
  });
  return found ? args : null;
}

/** @param {string[]} argv */
async function run(argv) {
  jsonMode = argv.includes("--json");
  /** @type {{ values: Values; positionals: string[] }} */
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    // `login --token` without a value asks for it at a hidden prompt: the dashboard's new key says to run exactly that.
    const bare = withBareToken(argv);
    /** @type {{ values: Values; positionals: string[] } | null} */
    let retried = null;
    try {
      retried = bare === null ? null : parseArgv(bare);
    } catch {
      // the first error is the one to report
    }
    if (retried === null || retried.positionals[0] !== "login") {
      const first = argv.find((a) => !a.startsWith("-"));
      throw usageError(parseErrorMessage(e), first !== undefined && COMMANDS[first] ? first : null);
    }
    parsed = retried;
  }
  const { values, positionals } = parsed;
  jsonMode = bool(values, "json");
  const command = positionals[0];

  if (command === undefined) {
    const extra = Object.keys(values).filter((k) => !["version", "help", "json", "host", "token"].includes(k));
    if (extra.length > 0) throw usageError(`unknown option --${extra[0]}`, null);
    if (bool(values, "version")) {
      out(jsonMode ? JSON.stringify({ version: VERSION }) : VERSION);
      return;
    }
    if (bool(values, "help")) {
      out(globalHelp());
      return;
    }
    throw usageError("missing command", null);
  }

  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (spec === undefined) throw usageError(`unknown command "${command}"`, null);
  for (const name of Object.keys(values)) {
    if (!GLOBAL_OPTIONS.includes(name) && !spec.options.includes(name)) {
      throw usageError(`unknown option --${name} for ${command}`, command);
    }
  }
  if (bool(values, "help")) {
    out(commandHelp(command));
    return;
  }
  const args = positionals.slice(1);
  const [min, max] = spec.positionals;
  if (args.length < min) throw usageError(`${command} needs ${spec.arg ?? "a slug"}`, command);
  if (args.length > max) throw usageError(`unexpected argument "${args[max]}"`, command);
  await spec.run(values, args);
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration, host and token (10.3)

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "artifakto", "config.json");
}

/**
 * A browser sign-in, made by `artifakto login` or by /artifakto-login in Claude Code (docs/phase-9-chatgpt-spec.md section
 * 13, docs/phase-10-accounts-spec.md 6.1): an OAuth grant on /api/v1 for one account, that publishes, lists and shows
 * pages and nothing else. The refresh token is single use: each refresh saves the next.
 * @typedef {{ clientId: string; resource: string; refreshToken: string; accessToken?: string; accessExpiresAt?: number; scope?: string }} SignIn
 */

/** @typedef {{ host?: string; token?: string; email?: string; oauth?: SignIn }} Config */

/** @returns {Promise<Config>} */
async function loadConfig() {
  const file = configPath();
  /** @type {string} */
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT")) return {};
    warn(`cannot read ${file}; ignoring it`);
    return {};
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    warn(`${file} is not valid JSON; ignoring it`);
    return {};
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    warn(`${file} is not a JSON object; ignoring it`);
    return {};
  }
  const record = /** @type {Record<string, unknown>} */ (data);
  /** @type {Config} */
  const config = {};
  if (typeof record.host === "string" && record.host !== "") {
    const host = tryNormalizeHost(record.host);
    if (host === null) warn(`${file} has an invalid host; ignoring it`);
    else config.host = host;
  }
  if (typeof record.token === "string" && record.token !== "") config.token = record.token;
  if (typeof record.email === "string" && EMAIL_RE.test(record.email)) config.email = record.email;
  if (record.oauth !== undefined) {
    const signIn = signInOf(record.oauth);
    if (signIn === null) warn(`${file} has an invalid sign-in; ignoring it`);
    else config.oauth = signIn;
  }
  return config;
}

/**
 * @param {unknown} value
 * @returns {SignIn | null}
 */
function signInOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = /** @type {Record<string, unknown>} */ (value);
  const safe = (/** @type {unknown} */ v) => typeof v === "string" && HEADER_SAFE.test(v);
  if (!safe(o.clientId) || !safe(o.refreshToken) || typeof o.resource !== "string" || tryNormalizeHost(o.resource) === null) return null;
  /** @type {SignIn} */
  const signIn = { clientId: /** @type {string} */ (o.clientId), resource: o.resource, refreshToken: /** @type {string} */ (o.refreshToken) };
  if (safe(o.accessToken) && typeof o.accessExpiresAt === "number") {
    signIn.accessToken = /** @type {string} */ (o.accessToken);
    signIn.accessExpiresAt = o.accessExpiresAt;
  }
  if (typeof o.scope === "string") signIn.scope = o.scope;
  return signIn;
}

/** @param {Config} config */
async function saveConfig(config) {
  await writePrivateJson(configPath(), config);
}

/**
 * Pretty JSON readable by its owner only, in a directory only its owner can list: the config holds the token, and
 * threads.json names private threads.
 * @param {string} file
 * @param {unknown} data
 */
async function writePrivateJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (await fsp.lstat(file).then((s) => s.isSymbolicLink(), () => false)) {
    // A linked file (kept in a dotfiles repository, say) is written through the link, as it always was.
    await fsp.writeFile(file, text, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
    return;
  }
  // A new file renamed over the old one: a command reading meanwhile sees one or the other, never half of one.
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600, flag: "wx" });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/**
 * @param {unknown} e
 * @param {string} code
 */
function isErrno(e, code) {
  return typeof e === "object" && e !== null && /** @type {{ code?: unknown }} */ (e).code === code;
}

/** @param {string} value */
function tryNormalizeHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 * @param {string} source
 * @param {string | null} command
 */
function normalizeHost(value, source, command) {
  const host = tryNormalizeHost(value);
  if (host === null) throw usageError(`${source} must be an http or https URL`, command);
  return host;
}

/** @param {string} host */
function isLoopbackHost(host) {
  const hostname = new URL(host).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * `agentFor` is the thread whose agent session is the token, `signedIn` says the token is the saved sign-in's, and
 * `threadFor` is the thread a key or a sign-in is used for (its not_found means another account's thread).
 * @typedef {{
 *   host: string; envHost: string; config: Config; token: string | null; bypass: string | null;
 *   warnedHttp: boolean; agentFor?: string; signedIn?: boolean; threadFor?: string;
 * }} Ctx
 */

/**
 * Resolves host, env host and the bypass header; the token is resolved separately (resolveToken).
 * @param {Values} values
 * @param {string} command
 * @returns {Promise<Ctx>}
 */
async function resolveContext(values, command) {
  const config = await loadConfig();
  const envHostRaw = process.env.ARTIFAKTO_AI_HOST;
  const envHost = envHostRaw
    ? normalizeHost(envHostRaw, "ARTIFAKTO_AI_HOST", command)
    : (config.host ?? DEFAULT_HOST);
  const flagHost = str(values, "host");
  const host = flagHost !== undefined ? normalizeHost(flagHost, "--host", command) : envHost;
  const bypassRaw = process.env.ARTIFAKTO_AI_PROTECTION_BYPASS;
  const bypass = bypassRaw && host === envHost ? bypassRaw : null;
  return { host, envHost, config, token: null, bypass, warnedHttp: false };
}

/** A key from the dashboard (docs/phase-10-accounts-spec.md 4.1), unlike the server's own ARTIFAKTO_API_TOKEN. */
const KEY_PREFIX = "afk_";

/** The dashboard's Keys and apps page, where keys are made and revoked and sign-ins disconnected. @param {string} host */
const keysPage = (host) => `${host}/dashboard/settings/keys`;

/**
 * The token a command sends to this host and where it comes from, in the order of 10.3 (normative): --token, then
 * ARTIFAKTO_AI_TOKEN for the env host, then the token saved for the saved host. null when none applies (the saved
 * sign-in may still).
 * @param {Ctx} ctx
 * @param {Values} values
 * @returns {{ token: string; from: "flag" | "env" | "config" } | null}
 */
function tokenSource(ctx, values) {
  const flag = str(values, "token");
  if (flag !== undefined && flag !== "") return { token: flag, from: "flag" };
  const envToken = process.env.ARTIFAKTO_AI_TOKEN;
  if (envToken && ctx.host === ctx.envHost) return { token: envToken, from: "env" };
  if (ctx.config.token !== undefined && ctx.config.host === ctx.host) return { token: ctx.config.token, from: "config" };
  return null;
}

/**
 * Host-bound token resolution (10.3, normative).
 * @param {Ctx} ctx
 * @param {Values} values
 * @param {boolean} required
 */
function resolveToken(ctx, values, required) {
  const found = tokenSource(ctx, values);
  if (found !== null) return found.token;
  if (!required) return null;
  if (process.env.ARTIFAKTO_AI_TOKEN) {
    throw new CliError(3, "no_token",
      `ARTIFAKTO_AI_TOKEN belongs to ${ctx.envHost}, not ${ctx.host}; pass --token for that host`);
  }
  if (signInFor(ctx) !== undefined) {
    // The code is #51's, which the skills know; the server's own token, or a Full key, can do this.
    throw new CliError(3, "owner_token_required",
      `this needs the dashboard or a Full key (Keys and apps, ${keysPage(ctx.host)}): the sign-in for ${ctx.host} can only publish, list and show pages. Do it there, or save a Full key with "artifakto login --token"`);
  }
  throw new CliError(3, "no_token", `no token for ${ctx.host}; run "artifakto login" or set ARTIFAKTO_AI_TOKEN`);
}

/**
 * The saved sign-in, when it belongs to this host (10.3: a credential goes to its own host only).
 * @param {Ctx} ctx
 */
function signInFor(ctx) {
  return ctx.config.host === ctx.host ? ctx.config.oauth : undefined;
}

/**
 * The kind of credential a command would send to this host, found without sending it: a key, the saved sign-in, any other
 * token (the server's own), or none. A key or a sign-in acts as its account's address; only the server's own token names
 * a thread entry's author (docs/phase-10-accounts-spec.md D4).
 * @param {Ctx} ctx
 * @param {Values} values
 * @returns {"key" | "sign-in" | "token" | null}
 */
function credentialKind(ctx, values) {
  const found = tokenSource(ctx, values);
  if (found !== null) return found.token.startsWith(KEY_PREFIX) ? "key" : "token";
  return signInFor(ctx) !== undefined ? "sign-in" : null;
}

/**
 * Whether ARTIFAKTO_AI_TOKEN goes to `host`, the host a login is saved for, and so wins over that login (10.3).
 * @param {string} host
 */
function envTokenShadows(host) {
  if (!process.env.ARTIFAKTO_AI_TOKEN) return false;
  const envHost = process.env.ARTIFAKTO_AI_HOST;
  return (envHost ? tryNormalizeHost(envHost) : host) === host;
}

/** @param {string} host */
function warnShadowed(host) {
  warn(`ARTIFAKTO_AI_TOKEN is set for ${host}, so commands use it instead of the login saved in ${configPath()}; unset it to use that login`);
}

/**
 * A credential for a command that publishes, lists or shows pages: a token (a key, or the server's own) when there is
 * one, else an access token of the saved sign-in, refreshed when it is about to expire. With neither, an owner-only
 * empty config file is left in place, so that /artifakto-login in Claude Code can save a sign-in into it (the mod cannot
 * make a file only its owner can read).
 * @param {Ctx} ctx
 * @param {Values} values
 */
async function resolveCredential(ctx, values) {
  const token = resolveToken(ctx, values, false);
  if (token !== null) return token;
  if (signInFor(ctx) !== undefined) {
    ctx.signedIn = true;
    // The mod writes the file in place, so a file that was readable by others (copied, restored) stays so until here.
    await fsp.chmod(configPath(), 0o600).catch(() => {});
    return signInAccessToken(ctx);
  }
  await ensurePrivateConfig();
  return /** @type {string} */ (resolveToken(ctx, values, true));
}

/**
 * @param {Values} values
 * @param {string} command
 * @param {boolean} [signInOk] whether a sign-in is enough (publish, list, show), not a token only (a Full key or the
 *   server's own token: change, roll back, archive)
 */
async function authedContext(values, command, signInOk = false) {
  const ctx = await resolveContext(values, command);
  ctx.token = signInOk ? await resolveCredential(ctx, values) : resolveToken(ctx, values, true);
  return ctx;
}

/** An empty config file, made only when there is none, readable by its owner only; an existing one is made owner-only. */
async function ensurePrivateConfig() {
  const file = configPath();
  if (await fsp.chmod(file, 0o600).then(() => true, () => false)) return;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await fsp.open(file, "wx", 0o600);
    try {
      await handle.writeFile("{}\n");
    } finally {
      await handle.close();
    }
  } catch (e) {
    // There already is one, or it cannot be made (warned below). Either way the caller goes on: a command that needs a
    // credential then stops with no_token, which says what to do, and prepare exits 0 so a session start never blocks.
    if (!isErrno(e, "EEXIST")) warn(`cannot create ${file}`);
  }
}

/** Refresh an access token this long before it expires, so a long push does not outlive it. */
const SIGN_IN_REFRESH_MARGIN_MS = 5 * 60_000;
const CONFIG_LOCK_WAIT_MS = 15_000;
const CONFIG_LOCK_STALE_MS = 60_000;

/**
 * @param {SignIn | undefined} signIn
 * @returns {signIn is SignIn & { accessToken: string; accessExpiresAt: number }}
 */
function isFresh(signIn) {
  return signIn?.accessToken !== undefined && signIn.accessExpiresAt !== undefined && signIn.accessExpiresAt - SIGN_IN_REFRESH_MARGIN_MS > Date.now();
}

/**
 * An access token of the sign-in, refreshed under the config lock when it is about to expire. A refresh token works
 * once and the server ends the grant when one comes back, so two commands must never spend the same one: the second
 * one in reads the config again and takes the token the first one saved. The Claude Code mod takes part in the lock
 * (withConfigLock).
 * @param {Ctx} ctx
 * @returns {Promise<string>}
 */
async function signInAccessToken(ctx) {
  const saved = signInFor(ctx);
  if (isFresh(saved)) return saved.accessToken;
  return withConfigLock(async () => {
    ctx.config = await loadConfig();
    const current = signInFor(ctx);
    if (current === undefined) throw new CliError(3, "no_token", `no token for ${ctx.host}; run "artifakto login", or /artifakto-login in Claude Code`);
    if (isFresh(current)) return current.accessToken;
    const tokens = await refreshSignIn(ctx, current);
    const next = tokens === null ? null : savedSignIn(current, tokens);
    // Saved before anything else (the old refresh token was spent the moment the server answered), but only over the
    // sign-in it spent, read again: /artifakto-login in Claude Code saves a new one without the lock once it has waited
    // its few seconds for it, and that one is kept, and used.
    const latest = await loadConfig();
    if (latest.host === ctx.host && latest.oauth?.refreshToken === current.refreshToken) {
      const rest = { ...latest };
      delete rest.oauth;
      ctx.config = next === null ? rest : { ...rest, oauth: next };
      await saveConfig(ctx.config);
    } else {
      ctx.config = latest;
      const newer = signInFor(ctx);
      if (isFresh(newer)) return newer.accessToken;
    }
    if (tokens === null) throw signInEnded(ctx);
    return tokens.accessToken;
  });
}

/** @typedef {{ accessToken: string; refreshToken: string; expiresIn: number; scope?: string }} Tokens */

/**
 * The sign-in to save once the token endpoint answered with `tokens`, in the shape /artifakto-login saves it.
 * @param {Pick<SignIn, "clientId" | "resource">} grant
 * @param {Tokens} tokens
 * @returns {SignIn}
 */
function savedSignIn(grant, tokens) {
  return {
    clientId: grant.clientId,
    resource: grant.resource,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessExpiresAt: Date.now() + tokens.expiresIn * 1000,
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  };
}

const FORM_TYPE = "application/x-www-form-urlencoded";

/**
 * A POST to one of the host's OAuth endpoints (/oauth/register, /oauth/token), whose errors are RFC 6749's
 * `{error, error_description}`, not the API's. Any answer comes back (a 404, a server without them, with an empty body);
 * a network failure, a redirect or a body that is not JSON throws.
 * @param {Ctx} ctx
 * @param {string} target
 * @param {string} body
 * @param {string} contentType
 * @returns {Promise<{ status: number; doc: Record<string, unknown> }>}
 */
async function oauthPost(ctx, target, body, contentType) {
  const headers = apiHeaders(ctx, false);
  headers.set("content-type", contentType);
  const res = await send(new URL(target, ctx.host), { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(JSON_TIMEOUT_MS) }, ctx.host);
  await rejectRedirect(res);
  if (res.status === 404) {
    await discard(res);
    return { status: 404, doc: {} };
  }
  const { status, json } = await readJson(res, ctx.host);
  return { status, doc: json !== null && typeof json === "object" && !Array.isArray(json) ? /** @type {Record<string, unknown>} */ (json) : {} };
}

/**
 * The token endpoint's answer: the tokens it granted, or its refusal.
 * @param {{ status: number; doc: Record<string, unknown> }} reply
 * @returns {{ tokens: Tokens } | { status: number; error: unknown; description: unknown }}
 */
function tokensOf({ status, doc }) {
  if (status === 200 && typeof doc.access_token === "string" && HEADER_SAFE.test(doc.access_token) && typeof doc.refresh_token === "string" && HEADER_SAFE.test(doc.refresh_token) && typeof doc.expires_in === "number") {
    return { tokens: { accessToken: doc.access_token, refreshToken: doc.refresh_token, expiresIn: doc.expires_in, ...(typeof doc.scope === "string" ? { scope: doc.scope } : {}) } };
  }
  return { status, error: doc.error, description: doc.error_description };
}

/**
 * Spends the sign-in's refresh token (docs/phase-9-chatgpt-spec.md section 4.4). Touches no config: the caller saves the
 * next pair, or drops the sign-in.
 * @param {Ctx} ctx
 * @param {SignIn} signIn
 */
async function refreshTokens(ctx, signIn) {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: signIn.refreshToken, client_id: signIn.clientId, resource: signIn.resource });
  return tokensOf(await oauthPost(ctx, "/oauth/token", form.toString(), FORM_TYPE));
}

/**
 * The token endpoint's refresh for this host's saved sign-in: the next pair, or null when it is refused (invalid_grant),
 * which ends the sign-in on the server, so the caller removes it here too. An account the server paused (suspended, or
 * accounts turned off) answers 503 with its fixed description instead: the sign-in is kept, and works again once that is
 * undone (docs/phase-10-accounts-spec.md section 5).
 * @param {Ctx} ctx
 * @param {SignIn} signIn
 * @returns {Promise<Tokens | null>}
 */
async function refreshSignIn(ctx, signIn) {
  const reply = await refreshTokens(ctx, signIn);
  if ("tokens" in reply) return reply.tokens;
  if (reply.error === "invalid_grant") return null;
  const paused = reply.status === 503 && reply.error === "temporarily_unavailable" ? accountRefusal(ctx.host, reply.description) : null;
  if (paused !== null) throw paused;
  if (reply.status === 404) throw signInUnavailable(ctx);
  throw new CliError(1, "invalid_response", `unexpected response (HTTP ${reply.status}) from ${ctx.host}/oauth/token`);
}

/** @param {Ctx} ctx */
function signInUnavailable(ctx) {
  return new CliError(3, "sign_in_unavailable",
    `${ctx.host} does not take sign-ins; run "artifakto login --token" with a key from its dashboard (Keys and apps)`);
}

/** @param {Ctx} ctx */
function signInEnded(ctx) {
  return new CliError(3, "sign_in_ended",
    `the sign-in for ${ctx.host} expired or was disconnected; run "artifakto login" again (or /artifakto-login in Claude Code)`);
}

/**
 * lib/domain/accounts.ts ACCOUNT_REFUSAL_DESCRIPTIONS, the server's fixed sentences for an account it gives no space to
 * (with access_denied from the consent page, invalid_grant for a code, a 503 for a refresh), and the CLI's code for
 * each. Copied, since this file cannot import TypeScript; tests/cli/login.test.ts sends the server's own.
 * @type {[string, string][]}
 */
const ACCOUNT_REFUSALS = [
  ["This account has not been invited to this server.", "account_not_invited"],
  ["This account is suspended on this server.", "account_suspended"],
  ["Accounts are not available on this server, and this account is not an owner of it.", "accounts_off"],
];

/**
 * What the CLI says, in place of the server's words, for the refusals of an account (docs/phase-10-accounts-spec.md 6.1):
 * what to do about them from a terminal. Any other refusal keeps the server's words, which say what to do on every
 * version of it (an `insufficient_scope` names the dashboard and a Full key, or, before keys, the owner token).
 * @type {Readonly<Record<string, (host: string) => string>>}
 */
const REFUSAL_TEXTS = {
  account_not_invited: (host) => `the account you signed in with has not been invited to ${host}; ask whoever runs it to invite your address, then run "artifakto login" again`,
  account_suspended: (host) => `this account is suspended on ${host}; ask whoever runs it`,
  accounts_off: (host) => `accounts are not available on ${host} now, and this account is not its owner's; ask whoever runs it`,
};

/**
 * The error for an account refusal the server described with one of its fixed sentences, or null for any other text.
 * @param {string} host
 * @param {unknown} description
 */
function accountRefusal(host, description) {
  const code = ACCOUNT_REFUSALS.find(([d]) => d === description)?.[1];
  return code === undefined ? null : new CliError(3, code, REFUSAL_TEXTS[code](host));
}

/**
 * Runs `fn` holding `<config>.lock`, made with O_EXCL; a lock older than CONFIG_LOCK_STALE_MS is from a run that died,
 * and one the Claude Code mod gave back (modGaveBack) is free. The config's directory is made first (0700), as saving
 * it would.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withConfigLock(fn) {
  const lock = `${configPath()}.lock`;
  await fsp.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const id = randomBytes(12).toString("hex");
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fsp.open(lock, "wx", 0o600);
      try {
        await handle.writeFile(id);
      } finally {
        await handle.close();
      }
      break;
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw e;
      const held = await fsp.stat(lock).then(async (s) => ({ age: Date.now() - s.mtimeMs, holder: await fsp.readFile(lock, "utf8") }), () => null);
      if (held !== null && (held.age > CONFIG_LOCK_STALE_MS || modGaveBack(held.holder))) await releaseLock(lock, held.holder);
      else if (Date.now() > deadline) throw new CliError(1, "config_locked", `another artifakto command holds ${lock}; try again, or remove that file if none is running`);
      else await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lock, id);
  }
}

/**
 * Whether the lock is one the Claude Code mod is done with (plugins/artifakto/hooks/client.ts `withConfigLock`). The mod
 * can neither make a file exclusively nor remove one, so it holds the lock by writing `mod <id> <deadline>` into it and
 * gives it back by writing `released`; a lease past its deadline is from a hook that was stopped.
 * @param {string} holder
 */
function modGaveBack(holder) {
  const lease = /^mod [A-Za-z0-9_-]+ (\d+)$/.exec(holder);
  return holder === "released" || (lease !== null && Number(lease[1]) < Date.now());
}

/**
 * Removes the lock only while it still names `holder`, so a command never removes a lock another one took after it:
 * two commands that both found the same stale lock, or one whose own lock was taken over as stale.
 * @param {string} lock
 * @param {string} holder
 */
async function releaseLock(lock, holder) {
  if ((await fsp.readFile(lock, "utf8").catch(() => null)) === holder) await fsp.rm(lock, { force: true });
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP (10.4)

/** Printable ASCII without spaces: the only credential values the CLI puts into a header. */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

/**
 * Headers for a request to the API origin.
 * @param {Ctx} ctx
 * @param {boolean} withToken
 */
function apiHeaders(ctx, withToken) {
  // Checked before any header is built: an invalid header value makes undici throw an error quoting the value.
  if (withToken && ctx.token !== null && !HEADER_SAFE.test(ctx.token)) {
    throw new CliError(3, "no_token", "the token contains characters that cannot be sent in an HTTP header");
  }
  if (ctx.bypass !== null && !HEADER_SAFE.test(ctx.bypass)) {
    throw new CliError(3, "config_invalid",
      "ARTIFAKTO_AI_PROTECTION_BYPASS contains characters that cannot be sent in an HTTP header");
  }
  const headers = new Headers({
    accept: "application/json",
    "user-agent": `artifakto-cli/${VERSION} node/${process.version}`,
  });
  if (withToken && ctx.token !== null) {
    if (!ctx.warnedHttp && ctx.host.startsWith("http:") && !isLoopbackHost(ctx.host)) {
      warn("the token is sent over plain http");
      ctx.warnedHttp = true;
    }
    headers.set("authorization", `Bearer ${ctx.token}`);
  }
  if (ctx.bypass !== null) headers.set("x-vercel-protection-bypass", ctx.bypass);
  return headers;
}

/**
 * @param {unknown} e
 * @param {string} origin
 */
function networkError(e, origin) {
  if (e instanceof CliError) return e;
  const name = typeof e === "object" && e !== null ? /** @type {{ name?: unknown }} */ (e).name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return new CliError(1, "network_error", `request to ${origin} timed out`);
  }
  const cause = typeof e === "object" && e !== null ? /** @type {{ cause?: unknown }} */ (e).cause : undefined;
  let reason = "network error";
  if (typeof cause === "object" && cause !== null) {
    const c = /** @type {{ code?: unknown; message?: unknown }} */ (cause);
    if (typeof c.code === "string") reason = c.code;
    else if (typeof c.message === "string" && c.message !== "") reason = c.message;
  }
  return new CliError(1, "network_error", `cannot reach ${origin} (${reason})`);
}

/**
 * @param {URL} url
 * @param {RequestInit} init
 * @param {string} origin
 * @returns {Promise<Response>}
 */
async function send(url, init, origin) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw networkError(e, origin);
  }
}

/** @param {Response} res */
async function discard(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // ignore
  }
}

/** @param {Response} res */
async function rejectRedirect(res) {
  if (res.status >= 300 && res.status < 400) {
    await discard(res);
    const location = res.headers.get("location") ?? "(no location)";
    throw new CliError(1, "invalid_response", `unexpected redirect (HTTP ${res.status}) to ${location}`);
  }
}

/**
 * @param {number} status
 * @param {string} code
 */
function exitForStatus(status, code) {
  if (code === "auth_unconfigured" || status === 401 || status === 403) return 3;
  if (status === 400 || status === 413 || status === 415 || status === 422) return 4;
  if (status === 404 || status === 410) return 5;
  if (status === 409) return 6;
  return 1;
}

/** @param {unknown} json */
function errorBodyOf(json) {
  if (json === null || typeof json !== "object") return null;
  const error = /** @type {{ error?: unknown }} */ (json).error;
  if (error === null || typeof error !== "object") return null;
  const e = /** @type {{ code?: unknown; message?: unknown; details?: unknown }} */ (error);
  if (typeof e.code !== "string" || typeof e.message !== "string") return null;
  return { code: e.code, message: e.message, details: e.details };
}

/**
 * Reads a JSON response from the API origin (redirects already rejected).
 * @param {Response} res
 * @param {string} origin
 * @returns {Promise<{ status: number; json: unknown }>}
 */
async function readJson(res, origin) {
  /** @type {string} */
  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw networkError(e, origin);
  }
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    if (res.status === 401 || res.status === 403) throw authFailure(res.status, origin, true);
    throw new CliError(1, "invalid_response", `unexpected response (HTTP ${res.status}) from ${origin}`);
  }
}

/**
 * A 401 or 403 without an API error body (for example Vercel Deployment Protection): exit 3 (10.5).
 * @param {number} status
 * @param {string} origin
 * @param {boolean} notJson
 */
function authFailure(status, origin, notJson) {
  const hint = notJson ? "; if the deployment is protected, set ARTIFAKTO_AI_PROTECTION_BYPASS" : "";
  return new CliError(3, status === 401 ? "unauthorized" : "forbidden",
    `authentication failed (HTTP ${status}) at ${origin}${hint}`);
}

/**
 * @param {number} status
 * @param {unknown} json
 * @param {string} origin
 */
function serverError(status, json, origin) {
  const body = errorBodyOf(json);
  if (body === null && (status === 401 || status === 403)) return authFailure(status, origin, false);
  if (body === null) return new CliError(1, "invalid_response", `unexpected response (HTTP ${status}) from ${origin}`);
  const message = Object.hasOwn(REFUSAL_TEXTS, body.code) ? REFUSAL_TEXTS[body.code](origin) : body.message;
  return new CliError(exitForStatus(status, body.code), body.code, message,
    body.details === undefined ? {} : { details: body.details });
}

/**
 * A JSON call to the API origin. Returns any JSON response; the caller decides what is success.
 * @param {Ctx} ctx
 * @param {string} method
 * @param {string} target path (and query) on the API origin
 * @param {{ body?: unknown; token?: boolean }} [opts]
 */
async function rawApiCall(ctx, method, target, opts = {}) {
  return readJson(await apiRequest(ctx, method, target, opts), ctx.host);
}

/**
 * A request to the API origin and its response, redirects refused; the body is the caller's to read.
 * @param {Ctx} ctx
 * @param {string} method
 * @param {string} target path (and query) on the API origin
 * @param {{ body?: unknown; token?: boolean; timeoutMs?: number }} [opts]
 */
async function apiRequest(ctx, method, target, opts = {}) {
  const url = new URL(target, ctx.host);
  if (url.origin !== ctx.host) {
    throw new CliError(1, "invalid_response", `refusing to send a request to ${url.origin}`);
  }
  const headers = apiHeaders(ctx, opts.token !== false);
  /** @type {RequestInit} */
  const init = { method, headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? JSON_TIMEOUT_MS) };
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(opts.body);
  }
  const res = await send(url, init, ctx.host);
  await rejectRedirect(res);
  const renewed = res.headers.get(AGENT_SESSION_HEADER);
  if (renewed !== null && ctx.agentFor !== undefined && HEADER_SAFE.test(renewed)) {
    // Stored at once, whatever the command does next (a dry run, a failure), and used for the rest of it.
    ctx.token = renewed;
    await saveRenewedAgent(ctx, ctx.agentFor, renewed);
  }
  return res;
}

/** A renewed agent session the server sends back (docs/phase-8-threads-spec.md H4); stored in place of the old one. */
const AGENT_SESSION_HEADER = "x-artifakto-agent-session";

/**
 * Like rawApiCall, but a non-2xx response throws the mapped server error.
 * @param {Ctx} ctx
 * @param {string} method
 * @param {string} target
 * @param {{ body?: unknown; token?: boolean }} [opts]
 */
async function apiCall(ctx, method, target, opts = {}) {
  const { status, json } = await rawApiCall(ctx, method, target, opts);
  if (status < 200 || status > 299) throw agentAware(ctx, serverError(status, json, ctx.host));
  return { status, json };
}

/**
 * An agent session refused (expired, or its email taken off the thread), or a sign-in refused (its grant disconnected),
 * says how to get a new one. A thread a key or a sign-in cannot find is in another account's space, which a member
 * reaches with an agent session (docs/phase-10-accounts-spec.md 6.1).
 * @param {Ctx} ctx
 * @param {CliError} error
 */
function agentAware(ctx, error) {
  if (ctx.signedIn === true && error.code === "unauthorized") return signInEnded(ctx);
  if (ctx.threadFor !== undefined && error.code === "not_found") {
    return new CliError(3, "thread_not_connected",
      "this thread is in someone else's space: run \"artifakto thread-connect <thread url>\" in your own terminal to connect this computer to it as a member");
  }
  if (ctx.agentFor === undefined || error.code !== "unauthorized") return error;
  return new CliError(3, "thread_not_connected",
    "this computer's connection to the thread has expired or was revoked; run \"artifakto thread-connect <thread url>\" in your own terminal");
}

/**
 * @param {unknown} json
 * @param {string} origin
 * @returns {Record<string, unknown>}
 */
function objectBody(json, origin) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new CliError(1, "invalid_response", `unexpected response from ${origin}`);
  }
  return /** @type {Record<string, unknown>} */ (json);
}

// ---------------------------------------------------------------------------------------------------------------
// Local files: paths, limits, analysis (10.7)

/**
 * Same rules, in the same order, as lib/domain/paths.ts validatePath.
 * @param {string} p
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
function validatePath(p) {
  if (typeof p !== "string" || p.length === 0) return { ok: false, reason: "empty path" };
  if (p.normalize("NFC") !== p) return { ok: false, reason: "path must be Unicode NFC" };
  if (Buffer.byteLength(p, "utf8") > 512) return { ok: false, reason: "path longer than 512 bytes" };
  if (/[\x00-\x1f\x7f\\?#%]/.test(p)) return { ok: false, reason: "path contains a control character, backslash, ?, # or %" };
  if (p.startsWith("/")) return { ok: false, reason: "path must be relative" };
  if (p.endsWith("/")) return { ok: false, reason: "path must name a file" };
  const segments = p.split("/");
  if (segments.length > 32) return { ok: false, reason: "path deeper than 32 segments" };
  for (const seg of segments) {
    if (seg === "") return { ok: false, reason: "empty path segment" };
    if (seg === "." || seg === "..") return { ok: false, reason: "dot segments are not allowed" };
    if (Buffer.byteLength(seg, "utf8") > 255) return { ok: false, reason: "path segment longer than 255 bytes" };
  }
  return { ok: true };
}

/** @param {string} p */
function extensionOf(p) {
  const last = p.slice(p.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot >= 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** @param {string} p */
function limitFor(p) {
  if (p === "index.html") return LIMITS.indexBytes;
  const ext = extensionOf(p);
  const type = Object.prototype.hasOwnProperty.call(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : "application/octet-stream";
  const essence = type.split(";")[0].trim();
  return essence.startsWith("text/") || TEXT_LIKE.has(essence) ? LIMITS.textFileBytes : LIMITS.binaryFileBytes;
}

/**
 * @param {string} a
 * @param {string} b
 */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {Uint8Array} bytes */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const NAMED_ENTITIES = /** @type {Record<string, string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " });

/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|nbsp));/gi,
    /**
     * @param {string} whole
     * @param {string | undefined} dec
     * @param {string | undefined} hex
     * @param {string | undefined} name
     */
    (whole, dec, hex, name) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(String(hex), 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
      return String.fromCodePoint(cp);
    });
}

/** @param {string} raw */
function cleanTitle(raw) {
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  const cut = chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join("") : text;
  return cut === "" ? null : cut;
}

/**
 * First <title> text, else first <h1> text with tags stripped (same as lib/html/analyze.ts extractTitle).
 * @param {string} html
 */
function extractTitle(html) {
  const t = /<title(?:[\t\n\f\r /][^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (t) {
    const title = cleanTitle(t[1]);
    if (title !== null) return title;
  }
  const h = /<h1(?:[\t\n\f\r /][^>]*)?>([\s\S]*?)<\/h1\s*>/i.exec(html);
  if (h) return cleanTitle(h[1].replace(/<[^>]*>/g, ""));
  return null;
}

/** @param {Uint8Array} bytes */
function decodeIndex(bytes) {
  const utf16 = bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (!utf16) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // fall through
    }
  }
  throw validationError("index_invalid", "index.html must be UTF-8 encoded");
}

/** @param {string} html */
function analyzeRuntime(html) {
  const usesRuntime = RUNTIME_RE.test(html);
  const names = new Set();
  for (const m of html.matchAll(NAMESPACE_RE)) names.add(m[1]);
  return { usesRuntime, runtimeNamespaces: /** @type {string[]} */ ([...names]).sort(byCodeUnits) };
}

/** @typedef {{ path: string; local?: string; size: number; bytes?: Uint8Array }} Entry */
/** @typedef {{ path: string; reason: "dotfile" | "ignored_name" | "not_regular" | "secret_pattern" }} Skipped */

/**
 * @param {string} root
 * @param {boolean} includeSecrets
 */
async function walkDirectory(root, includeSecrets) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const seen = new Set();

  /**
   * @param {string} absDir
   * @param {string} relDir
   */
  async function visit(absDir, relDir) {
    const names = (await fsp.readdir(absDir)).sort(byCodeUnits);
    for (const name of names) {
      const abs = path.join(absDir, name);
      const rel = `${relDir}${name}`.normalize("NFC");
      if (name.startsWith(".")) {
        skipped.push({ path: rel, reason: "dotfile" });
        continue;
      }
      const st = await fsp.lstat(abs);
      if (st.isDirectory()) {
        if (name === "node_modules" || name === "__MACOSX") {
          skipped.push({ path: rel, reason: "ignored_name" });
          continue;
        }
        await visit(abs, `${rel}/`);
        continue;
      }
      if (!st.isFile()) {
        warn(`skipping ${rel} (not a regular file)`);
        skipped.push({ path: rel, reason: "not_regular" });
        continue;
      }
      if (name === "Thumbs.db" || name === "desktop.ini") {
        skipped.push({ path: rel, reason: "ignored_name" });
        continue;
      }
      if (!includeSecrets && SECRET_NAME_RE.test(name)) {
        warn(`skipping ${rel} (looks like a key or credential file; pass --include-secrets to push it)`);
        skipped.push({ path: rel, reason: "secret_pattern" });
        continue;
      }
      const check = validatePath(rel);
      if (!check.ok) throw validationError("path_invalid", `invalid file name ${rel}: ${check.reason}`, { path: rel, reason: check.reason });
      if (seen.has(rel)) {
        throw validationError("path_invalid", `invalid file name ${rel}: duplicate path`, { path: rel, reason: "duplicate path" });
      }
      seen.add(rel);
      entries.push({ path: rel, local: abs, size: st.size });
      if (entries.length > LIMITS.maxFiles) {
        throw validationError("limit_exceeded", `${root} contains more than ${LIMITS.maxFiles} files`, { limit: LIMITS.maxFiles });
      }
    }
  }

  await visit(root, "");
  return { entries, skipped };
}

/**
 * Reads and validates an override file (.artifakto.json or --manifest).
 * @param {string} file
 * @param {boolean} optional
 * @returns {Promise<Record<string, unknown>>}
 */
async function readOverrideFile(file, optional) {
  const invalid = () => usageError(`${file} is not a valid override file`, "push");
  /** @type {string} */
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if (optional && isErrno(e, "ENOENT")) return {};
    throw invalid();
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const record = /** @type {Record<string, unknown>} */ (data);
  for (const [key, value] of Object.entries(record)) {
    if (!OVERRIDE_KEYS.includes(key)) throw invalid();
    if (value === null && NULLABLE_OVERRIDE_KEYS.includes(key)) continue;
    if (typeof value !== "string") throw invalid();
    if (key === "provider" && !PROVIDERS.includes(value)) throw invalid();
    if (key === "sourceType" && !SOURCE_TYPES.includes(value)) throw invalid();
    if (key === "mode" && !MODES.includes(value)) throw invalid();
    if (key === "visibility" && !PUSH_VISIBILITIES.includes(value)) throw invalid();
  }
  return record;
}

/**
 * @param {Values} values
 * @param {string} name
 * @param {string[]} allowed
 * @param {string} [command] the command named in the usage hint
 */
function enumFlag(values, name, allowed, command = "push") {
  const v = str(values, name);
  if (v !== undefined && !allowed.includes(v)) {
    throw usageError(`--${name} must be one of ${allowed.join(", ")}`, command);
  }
  return v;
}

/**
 * @typedef {{ path: string; size: number; sha256: string; bytes: Uint8Array }} BundleFile
 * @typedef {{
 *   kind: "file" | "dir" | "files"; root: string; files: BundleFile[]; skipped: Skipped[];
 *   unreferenced: string[]; manifest: Record<string, unknown>; usesRuntime: boolean; runtimeNamespaces: string[];
 *   totalBytes: number;
 * }} Bundle
 */

/**
 * Builds the push bundle from local files only (10.7 steps 1-10), plus `inline` files already in memory (`capture`).
 * @param {Values} values
 * @param {string | undefined} positional
 * @param {{ path: string; bytes: Uint8Array }[]} [inline]
 * @returns {Promise<Bundle>}
 */
async function buildBundle(values, positional, inline = []) {
  const filePairs = strs(values, "file");
  if (positional !== undefined && (filePairs.length > 0 || inline.length > 0)) {
    throw usageError("push takes either a file or folder, or --file pairs, not both", "push");
  }
  if (positional === undefined && filePairs.length === 0 && inline.length === 0) {
    throw usageError("push needs a file, a folder or --file <path>=<local file>", "push");
  }
  /** @type {Record<string, string>} */
  const flagOverrides = {};
  const provider = enumFlag(values, "provider", PROVIDERS);
  const sourceType = enumFlag(values, "source-type", SOURCE_TYPES);
  const visibility = enumFlag(values, "visibility", PUSH_VISIBILITIES);
  const mode = enumFlag(values, "mode", MODES);
  if (provider !== undefined) flagOverrides.provider = provider;
  if (sourceType !== undefined) flagOverrides.sourceType = sourceType;
  for (const [flag, key] of [["source-id", "sourceId"], ["source-url", "sourceUrl"], ["source-version", "sourceVersion"],
    ["title", "title"], ["description", "description"], ["favicon", "favicon"], ["slug", "slug"]]) {
    const v = str(values, flag);
    if (v !== undefined) flagOverrides[key] = v;
  }
  if (mode !== undefined) flagOverrides.mode = mode;
  if (visibility !== undefined) flagOverrides.visibility = visibility;

  /** @type {"file" | "dir" | "files"} */
  let kind;
  /** @type {Entry[]} */
  let entries = [];
  /** @type {Skipped[]} */
  let skipped = [];
  let root = "";

  if (positional === undefined) {
    kind = "files";
    /** @type {{ path: string; local: string }[]} */
    const pairs = [];
    const seen = new Set();
    for (const value of filePairs) {
      const eq = value.indexOf("=");
      if (eq < 0) throw usageError(`--file ${value}: expected <path>=<local file>`, "push");
      const p = value.slice(0, eq).normalize("NFC");
      if (seen.has(p)) throw usageError(`--file: duplicate path ${p}`, "push");
      seen.add(p);
      pairs.push({ path: p, local: value.slice(eq + 1) });
    }
    if (pairs.length > LIMITS.maxFiles) {
      throw validationError("limit_exceeded", `more than ${LIMITS.maxFiles} files`, { limit: LIMITS.maxFiles });
    }
    for (const pair of pairs) {
      const check = validatePath(pair.path);
      if (!check.ok) {
        throw validationError("path_invalid", `invalid file name ${pair.path}: ${check.reason}`, { path: pair.path, reason: check.reason });
      }
    }
    for (const pair of pairs) {
      /** @type {import("node:fs").Stats | null} */
      let st = null;
      try {
        st = await fsp.lstat(pair.local);
      } catch {
        st = null;
      }
      if (st === null || !st.isFile()) {
        throw validationError("path_invalid", `--file ${pair.path}: ${pair.local} is not a regular file`, { path: pair.path });
      }
      entries.push({ path: pair.path, local: pair.local, size: st.size });
    }
    for (const f of inline) entries.push({ path: f.path, bytes: f.bytes, size: f.bytes.byteLength });
    if (!entries.some((e) => e.path === "index.html")) {
      throw validationError("index_missing", "no --file for index.html; the push needs an index.html path");
    }
  } else {
    root = positional;
    /** @type {import("node:fs").Stats} */
    let st;
    try {
      st = await fsp.stat(positional);
    } catch {
      throw validationError("path_invalid", `cannot read ${positional}`, { path: positional });
    }
    if (st.isFile()) {
      kind = "file";
      const name = path.basename(positional);
      const ext = extensionOf(name);
      if (ext !== "html" && ext !== "htm") {
        throw validationError("unsupported_artifact_type",
          `HTML only: ${name} is not an HTML file. Markdown, SVG, Mermaid, code and React artifacts are not supported yet.`);
      }
      entries = [{ path: "index.html", local: positional, size: st.size }];
    } else if (st.isDirectory()) {
      kind = "dir";
      const walked = await walkDirectory(positional, bool(values, "include-secrets"));
      entries = walked.entries;
      skipped = walked.skipped;
      if (!entries.some((e) => e.path === "index.html")) {
        throw validationError("index_missing", `no index.html at the root of ${positional}`);
      }
    } else {
      throw validationError("path_invalid", `${positional} is not a regular file or directory`, { path: positional });
    }
  }

  // Overrides, lowest to highest precedence (step 5).
  const dotfile = kind === "dir" ? await readOverrideFile(path.join(root, ".artifakto.json"), true) : {};
  const manifestFlag = str(values, "manifest");
  const manifestFile = manifestFlag !== undefined ? await readOverrideFile(manifestFlag, false) : {};
  /** @type {Record<string, unknown>} */
  const overrides = { ...dotfile, ...manifestFile, ...flagOverrides };
  if (typeof overrides.sourceId === "string" && overrides.provider === undefined) {
    throw usageError("a source id needs --provider", "push");
  }

  // Limits before reading anything (step 6).
  entries.sort((a, b) => byCodeUnits(a.path, b.path));
  let totalBytes = 0;
  for (const e of entries) {
    const limit = limitFor(e.path);
    if (e.size > limit) {
      throw validationError("limit_exceeded", `${e.path} is ${e.size} bytes; the limit is ${limit} bytes`, { path: e.path, size: e.size, limit });
    }
    totalBytes += e.size;
  }
  if (totalBytes > LIMITS.versionBytes) {
    throw validationError("limit_exceeded", `the files total ${totalBytes} bytes; the limit is ${LIMITS.versionBytes} bytes`,
      { total: totalBytes, limit: LIMITS.versionBytes });
  }

  /** @type {BundleFile[]} */
  const files = new Array(entries.length);
  await runPool(entries.map((e, i) => ({ e, i })), READ_CONCURRENCY, async ({ e, i }) => {
    /** @type {Uint8Array} */
    let bytes;
    try {
      bytes = e.bytes ?? new Uint8Array(await fsp.readFile(/** @type {string} */ (e.local)));
    } catch {
      throw validationError("path_invalid", `cannot read ${e.local}`, { path: e.path });
    }
    const limit = limitFor(e.path);
    if (bytes.byteLength > limit) {
      throw validationError("limit_exceeded", `${e.path} is ${bytes.byteLength} bytes; the limit is ${limit} bytes`,
        { path: e.path, size: bytes.byteLength, limit });
    }
    files[i] = { path: e.path, size: bytes.byteLength, sha256: sha256Hex(bytes), bytes };
  });
  totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > LIMITS.versionBytes) {
    throw validationError("limit_exceeded", `the files total ${totalBytes} bytes; the limit is ${LIMITS.versionBytes} bytes`,
      { total: totalBytes, limit: LIMITS.versionBytes });
  }

  const index = /** @type {BundleFile} */ (files.find((f) => f.path === "index.html"));
  const html = decodeIndex(index.bytes);

  // Title (step 8).
  /** @type {string | undefined} */
  let title = typeof overrides.title === "string" ? overrides.title : undefined;
  // A transcript's or Claude Docs doc's index is JSON whose text may hold any markup, so a <title> or <h1> found in it
  // is content, not the page's title; without --title the server takes the JSON's own title field.
  const jsonSource = JSON_SOURCE_TYPES.includes(String(overrides.sourceType));
  if (title === undefined && !jsonSource) {
    const fromPage = extractTitle(html);
    if (fromPage !== null) title = fromPage;
    else if (kind === "file") title = path.basename(root).replace(/\.[^.]*$/, "");
    else if (kind === "dir") title = path.basename(path.resolve(root));
  }

  // That JSON holds conversation or doc text, which may mention window.claude without ever running it.
  const { usesRuntime, runtimeNamespaces } = jsonSource ? { usesRuntime: false, runtimeNamespaces: [] } : analyzeRuntime(html);

  // Unreferenced-files gate data (step 4).
  /** @type {string[]} */
  const unreferenced = [];
  if (kind === "dir") {
    const decoder = new TextDecoder();
    const sources = files
      .filter((f) => f.path === "index.html" || REFERENCING_EXTENSIONS.has(extensionOf(f.path)))
      .map((f) => ({ path: f.path, text: f.path === "index.html" ? html : decoder.decode(f.bytes) }));
    for (const f of files) {
      if (f.path === "index.html") continue;
      const segment = f.path.slice(f.path.lastIndexOf("/") + 1);
      if (!sources.some((s) => s.path !== f.path && s.text.includes(segment))) unreferenced.push(f.path);
    }
  }

  /** @type {Record<string, unknown>} */
  const manifest = { schema: 1 };
  for (const key of OVERRIDE_KEYS) {
    if (key === "title") continue;
    if (overrides[key] !== undefined) manifest[key] = overrides[key];
  }
  if (title !== undefined) manifest.title = title;
  manifest.files = files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));

  return { kind, root, files, skipped, unreferenced, manifest, usesRuntime, runtimeNamespaces, totalBytes };
}

// ---------------------------------------------------------------------------------------------------------------
// push

/**
 * @param {Values} values
 * @param {string[]} args
 * @param {{ path: string; bytes: Uint8Array }[]} [inline] files already in memory, pushed as if given with --file
 */
async function cmdPush(values, args, inline = []) {
  const ctx = await resolveContext(values, "push");
  const bundle = await buildBundle(values, args[0], inline);

  if (bool(values, "dry-run")) {
    const doc = {
      dryRun: true,
      host: ctx.host,
      fileCount: bundle.files.length,
      totalBytes: bundle.totalBytes,
      usesRuntime: bundle.usesRuntime,
      runtimeNamespaces: bundle.runtimeNamespaces,
      unreferencedFiles: bundle.unreferenced,
      skipped: bundle.skipped,
      manifest: bundle.manifest,
    };
    out(jsonMode ? JSON.stringify(doc) : JSON.stringify(doc, null, 2));
    return;
  }

  if (bundle.unreferenced.length > 0 && !bool(values, "yes")) {
    const shown = bundle.unreferenced.slice(0, UNREFERENCED_SHOWN).join(", ");
    throw new CliError(2, "confirmation_required",
      `${bundle.root} contains ${bundle.unreferenced.length} files that no page, stylesheet or script mentions: ${shown}. ` +
      "Move them out of the folder, or push anyway with --yes.",
      { details: { paths: bundle.unreferenced } });
  }

  ctx.token = await resolveCredential(ctx, values);

  if (!jsonMode) {
    errLine(`Pushing ${bundle.files.length} files (${bundle.totalBytes} bytes) to ${ctx.host}:`);
    for (const f of bundle.files.slice(0, LISTED_PATHS)) errLine(`  ${f.path}`);
    if (bundle.files.length > LISTED_PATHS) errLine(`  ... and ${bundle.files.length - LISTED_PATHS} more`);
  }

  /** @type {PublishResultJson} */
  let result;
  try {
    result = await publishOnce(ctx, bundle);
  } catch (e) {
    if (!(e instanceof CliError) || e.code !== "conflict_retry") throw e;
    result = await publishOnce(ctx, bundle);
  }

  if (jsonMode) {
    printJson(result);
    return;
  }
  const suffix = result.metadataUpdated ? " - metadata updated" : "";
  if (result.status === "created") out(`Published ${result.url} (version ${result.version}, ${result.artifact.visibility})${suffix}`);
  else if (result.status === "updated") out(`Updated ${result.url} (version ${result.version})${suffix}`);
  else out(`Unchanged ${result.url} (version ${result.version})${suffix}`);
  if (result.artifact.visibility === "unlisted") out("Anyone with the link can open it.");
  printWarnings(result.warnings);
}

// ---------------------------------------------------------------------------------------------------------------
// capture

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CAPTURE_MAX_BYTES = 8 * MiB;
const CAPTURE_TIMEOUT_MS = 30_000;

/** @typedef {typeof import("./chatgpt-share.mjs")} ShareModule */

/** The origin share pages are fetched from. The override exists for tests and must be a loopback address. */
function chatgptOrigin() {
  const override = process.env.ARTIFAKTO_CHATGPT_ORIGIN;
  if (override === undefined || override === "") return CHATGPT_ORIGIN;
  const origin = tryNormalizeHost(override);
  if (origin === null || !isLoopbackHost(origin)) throw usageError("ARTIFAKTO_CHATGPT_ORIGIN must be a loopback address; it exists for tests", "capture");
  return origin;
}

/**
 * @param {Response} res
 * @param {number} max
 * @returns {Promise<string>}
 */
async function readCapped(res, max) {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new CliError(4, "capture_too_large", `the share page is larger than ${max} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * @param {string} url
 * @param {unknown} e what fetch or the body read threw
 */
function captureNetworkError(url, e) {
  const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return new CliError(1, "capture_network", timedOut ? `${new URL(url).host} did not answer within ${CAPTURE_TIMEOUT_MS / 1000} seconds` : `cannot reach ${new URL(url).host}`);
}

/**
 * One GET of a share URL. Never bypasses a challenge: a Cloudflare challenge is reported, not worked around.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchShare(url) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      headers: { "user-agent": `artifakto-cli/${VERSION} (+https://artifakto.ai)`, accept: "*/*" },
    });
  } catch (e) {
    throw captureNetworkError(url, e);
  }
  if (res.status === 200) {
    try {
      return await readCapped(res, CAPTURE_MAX_BYTES);
    } catch (e) {
      throw e instanceof CliError ? e : captureNetworkError(url, e);
    }
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 403 || res.headers.get("cf-mitigated") !== null) {
    throw new CliError(1, "capture_blocked",
      "ChatGPT asked for a browser check instead of serving the page. Open the share in your browser, save the page (or the page's .data), " +
      "and run this command again with --from-file <path>.");
  }
  if (res.status === 404) throw new CliError(5, "share_gone", "that share does not exist");
  if (res.status === 429) {
    const wait = res.headers.get("retry-after")?.trim() ?? "";
    throw new CliError(1, "capture_rate_limited", `ChatGPT is rate limiting this machine${/^[0-9]{1,6}$/.test(wait) ? `; try again in ${wait} seconds` : ""}`);
  }
  throw new CliError(1, "capture_failed", `ChatGPT answered ${res.status}`);
}

/** @type {Record<"deleted" | "unsupported" | "unreadable", [number, string]>} exit code and error code for each way a share can fail to decode */
const SHARE_ERRORS = {
  deleted: [5, "share_gone"],
  unsupported: [4, "capture_unsupported"],
  unreadable: [4, "capture_unreadable"],
};

/**
 * @param {string} fromFile
 * @returns {Promise<string>}
 */
async function readShareFile(fromFile) {
  /** @type {import("node:fs").Stats} */
  let st;
  try {
    st = await fsp.stat(fromFile);
  } catch {
    throw validationError("path_invalid", `cannot read ${fromFile}`, { path: fromFile });
  }
  if (!st.isFile() || st.size > CAPTURE_MAX_BYTES) {
    throw validationError("path_invalid", `${fromFile} is not a regular file of at most ${CAPTURE_MAX_BYTES} bytes`, { path: fromFile });
  }
  try {
    return await fsp.readFile(fromFile, "utf8");
  } catch {
    throw validationError("path_invalid", `cannot read ${fromFile}`, { path: fromFile });
  }
}

/**
 * @param {ShareModule} share
 * @param {string | undefined} fromFile
 * @param {string} shareId
 * @returns {Promise<ReturnType<ShareModule["decodeShare"]>>}
 */
async function loadShare(share, fromFile, shareId) {
  try {
    const decoded = await (async () => {
      if (fromFile !== undefined) return share.decodeShare(await readShareFile(fromFile));
      const origin = chatgptOrigin();
      // The .data endpoint is a tenth the size of the page; the page is the fallback if it is missing or its format is not understood.
      try {
        return share.decodeShare(await fetchShare(`${origin}/share/${shareId}.data`));
      } catch (e) {
        const fallBack = (e instanceof share.ShareError && e.code === "unreadable") || (e instanceof CliError && e.code === "share_gone");
        if (!fallBack) throw e;
      }
      return share.decodeShare(await fetchShare(`${origin}/share/${shareId}`));
    })();
    if (decoded.shareId !== undefined && decoded.shareId !== shareId) {
      throw new share.ShareError("unreadable", `That page belongs to another share (${decoded.shareId}), not ${shareId}.`);
    }
    return decoded;
  } catch (e) {
    if (!(e instanceof share.ShareError)) throw e;
    const [exit, code] = SHARE_ERRORS[e.code];
    throw new CliError(exit, code, e.message);
  }
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdCapture(values, args) {
  /** @type {ShareModule | null} */
  let share;
  try {
    share = await import("./chatgpt-share.mjs");
  } catch {
    share = null;
  }
  if (share === null || typeof share.decodeShare !== "function" || typeof share.captureNotes !== "function") {
    throw new CliError(1, "capture_unavailable", "capture needs chatgpt-share.mjs, from the same version, next to artifakto.mjs; copy both files, or install the package");
  }
  const shareId = share.parseShareUrl(args[0]);
  if (shareId === null) {
    const shown = args[0].replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);
    throw usageError(`"${shown}" is not a ChatGPT share link (expected https://chatgpt.com/share/<id>)`, "capture");
  }
  // Everything that can fail on our side is checked before the share is fetched.
  enumFlag(values, "visibility", PUSH_VISIBILITIES, "capture");
  const ctx = await resolveContext(values, "capture");
  if (!bool(values, "dry-run")) await resolveCredential(ctx, values);

  const { transcript, stats } = await loadShare(share, str(values, "from-file"), shareId);

  errLine(`Captured ${[`${transcript.messages.length} messages`, ...share.captureNotes(stats)].join("; ")}.`);

  /** @type {Values} */
  const pushValues = {
    ...values,
    provider: "chatgpt",
    "source-id": shareId,
    "source-url": `${CHATGPT_ORIGIN}/share/${shareId}`,
    "source-type": TRANSCRIPT_SOURCE_TYPE,
  };
  if (str(values, "title") === undefined) pushValues.title = transcript.title ?? "ChatGPT conversation";
  await cmdPush(pushValues, [], [{ path: "index.html", bytes: new TextEncoder().encode(JSON.stringify(transcript)) }]);
}

/**
 * @param {unknown} json
 * @param {string} origin
 * @returns {PublishResultJson}
 */
function publishResultOf(json, origin) {
  const body = objectBody(json, origin);
  if ((body.status !== "created" && body.status !== "updated" && body.status !== "unchanged") ||
    typeof body.url !== "string" || body.artifact === null || typeof body.artifact !== "object") {
    throw new CliError(1, "invalid_response", `unexpected response from ${origin}`);
  }
  return /** @type {PublishResultJson} */ (/** @type {unknown} */ (body));
}

/**
 * @typedef {{ file: BundleFile; url: URL; headers: Record<string, string>; auth: "bearer" | "none" }} UploadJob
 * @typedef {{ sha256: string; path: string; status: number | null }} UploadFailure
 */

/**
 * One begin, uploads and commit cycle.
 * @param {Ctx} ctx
 * @param {Bundle} bundle
 * @returns {Promise<PublishResultJson>}
 */
async function publishOnce(ctx, bundle) {
  const begin = await apiCall(ctx, "POST", "/api/v1/artifacts", { body: bundle.manifest });
  if (begin.status !== 202) return publishResultOf(begin.json, ctx.host);

  const body = objectBody(begin.json, ctx.host);
  if (body.status !== "upload_required" || !Array.isArray(body.uploads) || typeof body.commitUrl !== "string") {
    throw new CliError(1, "invalid_response", `unexpected response from ${ctx.host}`);
  }
  const jobs = uploadJobs(ctx, bundle, /** @type {unknown[]} */ (body.uploads));

  if (process.stderr.isTTY && !jsonMode && jobs.length > 0) errLine(`Uploading ${jobs.length} files...`);
  /** @type {UploadFailure[]} */
  const failures = [];
  await runPool(jobs, UPLOAD_CONCURRENCY, async (job) => {
    const failure = await uploadOne(ctx, job);
    if (failure !== null) failures.push(failure);
  });

  try {
    const commit = await apiCall(ctx, "POST", body.commitUrl);
    return publishResultOf(commit.json, ctx.host);
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    if (e.code === "upload_incomplete") throw uploadFailedError(e, failures);
    if (e.code === "upload_committed") {
      const d = /** @type {{ slug?: unknown } | undefined} */ (e.details);
      const slug = d !== null && typeof d === "object" && typeof d.slug === "string" ? d.slug : null;
      throw new CliError(6, e.code, slug !== null ? `${e.message} (slug ${slug})` : e.message,
        e.details === undefined ? {} : { details: e.details });
    }
    throw e;
  }
}

/**
 * @param {CliError} e
 * @param {UploadFailure[]} failures
 */
function uploadFailedError(e, failures) {
  const d = e.details !== null && typeof e.details === "object" ? /** @type {Record<string, unknown>} */ (e.details) : {};
  const missing = Array.isArray(d.missing) ? d.missing.filter((x) => typeof x === "string") : [];
  const mismatched = Array.isArray(d.mismatched) ? d.mismatched.filter((x) => typeof x === "string") : [];
  const listed = new Set([...missing, ...mismatched]);
  const matched = failures.filter((f) => listed.has(f.sha256)).sort((a, b) => byCodeUnits(a.path, b.path));
  const describe = /** @param {UploadFailure} f */ (f) =>
    `upload of ${f.path} failed (${f.status === null ? "network error" : `HTTP ${f.status}`})`;
  const details = { failures: matched, missing, mismatched };
  if (matched.length === 0) {
    return new CliError(1, "upload_failed", e.message, { details });
  }
  return new CliError(1, "upload_failed", matched.map(describe).join("; "), {
    details,
    lines: matched.map((f) => `error: ${describe(f)}`),
  });
}

/**
 * Validates every upload target before anything is sent.
 * @param {Ctx} ctx
 * @param {Bundle} bundle
 * @param {unknown[]} uploads
 * @returns {UploadJob[]}
 */
function uploadJobs(ctx, bundle, uploads) {
  const bySha = new Map();
  for (const f of bundle.files) if (!bySha.has(f.sha256)) bySha.set(f.sha256, f);
  const invalid = () => new CliError(1, "invalid_response", `unexpected upload target from ${ctx.host}`);
  return uploads.map((raw) => {
    if (raw === null || typeof raw !== "object") throw invalid();
    const t = /** @type {Record<string, unknown>} */ (raw);
    const file = typeof t.sha256 === "string" ? bySha.get(t.sha256) : undefined;
    if (file === undefined || t.method !== "PUT" || typeof t.url !== "string" || (t.auth !== "bearer" && t.auth !== "none")) {
      throw invalid();
    }
    /** @type {URL} */
    let url;
    try {
      url = new URL(t.url, ctx.host);
    } catch {
      throw invalid();
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid();
    /** @type {Record<string, string>} */
    const headers = {};
    if (t.headers !== undefined && t.headers !== null) {
      if (typeof t.headers !== "object") throw invalid();
      for (const [k, v] of Object.entries(t.headers)) {
        if (typeof v !== "string") throw invalid();
        headers[k] = v;
      }
    }
    if (t.auth === "bearer" && url.origin !== ctx.host) {
      throw new CliError(1, "invalid_response", `refusing to send the token to ${url.origin}`);
    }
    return { file, url, headers, auth: t.auth };
  });
}

/**
 * App-route uploads are fatal on failure; direct uploads record the failure (10.4).
 * @param {Ctx} ctx
 * @param {UploadJob} job
 * @returns {Promise<UploadFailure | null>}
 */
async function uploadOne(ctx, job) {
  const body = /** @type {Uint8Array<ArrayBuffer>} */ (job.file.bytes);
  if (job.auth === "bearer") {
    const headers = new Headers(job.headers);
    apiHeaders(ctx, true).forEach((value, key) => headers.set(key, value));
    const res = await send(job.url, {
      method: "PUT",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    }, ctx.host);
    await rejectRedirect(res);
    if (res.status >= 200 && res.status < 300) {
      await discard(res);
      return null;
    }
    const { status, json } = await readJson(res, ctx.host);
    throw serverError(status, json, ctx.host);
  }
  const failure = { sha256: job.file.sha256, path: job.file.path };
  try {
    const res = await fetch(job.url, {
      method: "PUT",
      headers: new Headers(job.headers),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    await discard(res);
    if (res.status >= 200 && res.status < 300) return null;
    return { ...failure, status: res.status };
  } catch {
    return { ...failure, status: null };
  }
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; the first thrown error is rethrown after in-flight work ends.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function runPool(items, limit, fn) {
  let next = 0;
  /** @type {{ error: unknown } | null} */
  let fatal = null;
  const worker = async () => {
    while (fatal === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        if (fatal === null) fatal = { error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  const f = /** @type {{ error: unknown } | null} */ (fatal);
  if (f !== null) throw f.error;
}

// ---------------------------------------------------------------------------------------------------------------
// list, info

/** @param {string} iso */
function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * @param {Values} values
 */
async function cmdList(values) {
  const params = new URLSearchParams();
  const limit = str(values, "limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
      throw usageError("--limit must be a whole number from 1 to 200", "list");
    }
    params.set("limit", String(Number(limit)));
  }
  const cursor = str(values, "cursor");
  if (cursor !== undefined) params.set("cursor", cursor);
  const ctx = await authedContext(values, "list", true);
  const query = params.toString();
  const { json } = await apiCall(ctx, "GET", `/api/v1/artifacts${query ? `?${query}` : ""}`);
  const body = objectBody(json, ctx.host);
  if (!Array.isArray(body.items)) throw new CliError(1, "invalid_response", `unexpected response from ${ctx.host}`);
  const list = /** @type {ListJson} */ (/** @type {unknown} */ (body));
  if (jsonMode) {
    printJson(list);
    return;
  }
  const rows = [["SLUG", "VERSION", "VISIBILITY", "MODE", "UPDATED", "TITLE"]];
  for (const a of list.items) {
    rows.push([a.slug, String(a.currentVersion), a.visibility, a.mode, formatDate(a.updatedAt),
      a.disabled ? `${a.title} (disabled)` : a.title]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) out(r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ").trimEnd());
  if (list.nextCursor) out(`more: artifakto list --cursor ${list.nextCursor}`);
}

/**
 * Guards the URL path built for `info`/`set`/`rollback`/`delete <slug>` against a slug argument shaped like a dot
 * segment. `encodeURIComponent` leaves "." unescaped, so a slug of "." or ".." (or a path containing one, since "/"
 * IS escaped but a lone ".."-as-a-whole-segment is not) would otherwise survive into `new URL(target, ctx.host)`,
 * which normalizes dot segments per RFC 3986 before any request is sent — "info .." would silently request
 * "/api/v1/" instead of erroring, and "info ." would request "/api/v1/artifacts/" (the list endpoint, one redirect
 * away). Real slugs (`isValidSlug` in lib/hosts.ts) never contain "/", ".", ".." or control characters, so this
 * rejects nothing legitimate.
 * @param {string} slug
 */
function artifactPath(slug) {
  if (typeof slug !== "string" || slug.length === 0 || slug === "." || slug === ".." || /[\\/\x00-\x1f]/.test(slug)) {
    throw new CliError(4, "path_invalid", `invalid slug ${JSON.stringify(slug ?? "")}`);
  }
  return `/api/v1/artifacts/${encodeURIComponent(slug)}`;
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdInfo(values, args) {
  const ctx = await authedContext(values, "info", true);
  const { json } = await apiCall(ctx, "GET", artifactPath(args[0]));
  const body = objectBody(json, ctx.host);
  if (body.artifact === null || typeof body.artifact !== "object") {
    throw new CliError(1, "invalid_response", `unexpected response from ${ctx.host}`);
  }
  const detail = /** @type {ArtifactDetailJson} */ (/** @type {unknown} */ (body));
  if (jsonMode) {
    printJson(detail);
    return;
  }
  const a = detail.artifact;
  out(`url: ${a.url}`);
  out(`title: ${a.title}`);
  out(`slug: ${a.slug}`);
  out(`provider: ${a.provider}`);
  out(`source: ${a.sourceUrl ?? a.sourceId ?? "-"}`);
  out(`mode: ${a.mode}`);
  out(`visibility: ${a.visibility}`);
  if (a.visibility === "password") out(`password: ${a.hasPassword ? "set" : "not set"}`);
  if (a.visibility === "members") out(`members: ${a.memberCount} (see "artifakto members ${a.slug}")`);
  out(`version: ${a.currentVersion}`);
  out(`disabled: ${a.disabled ? "yes" : "no"}`);
  out(`updated: ${formatDate(a.updatedAt)}`);
  out("versions:");
  for (const v of detail.versions ?? []) {
    out(`  v${v.n}  ${formatDate(v.createdAt)}  ${v.fileCount} files  ${v.totalBytes} bytes${v.current ? "  [current]" : ""}`);
  }
  out("files:");
  for (const f of detail.files ?? []) out(`  ${f.path}  ${f.size}  ${f.contentType}`);
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdMembers(values, args) {
  // A sign-in reads the list too (artifacts:read); only changing it needs more.
  const ctx = await authedContext(values, "members", true);
  const { json } = await apiCall(ctx, "GET", `${artifactPath(args[0])}/members`);
  const body = objectBody(json, ctx.host);
  if (!Array.isArray(body.emails)) throw new CliError(1, "invalid_response", `unexpected response from ${ctx.host}`);
  const members = /** @type {MembersJson} */ (/** @type {unknown} */ (body));
  if (jsonMode) {
    printJson(members);
    return;
  }
  if (members.emails.length === 0) {
    out("no members");
    return;
  }
  for (const email of members.emails) out(email);
}

// ---------------------------------------------------------------------------------------------------------------
// Threads and session export (docs/phase-8-threads-spec.md)

const THREAD_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const THREAD_BRIEF_CHARS = 16_000;
const THREAD_BODY_BYTES = 4 * MiB;
/** The server's cap on an attached transcript, and session-export's default and largest --max-bytes. */
const THREAD_TRANSCRIPT_BYTES = 3.5 * MiB;
const ENTRY_FILE_BYTES = 256 * 1024;
const TRANSCRIPT_ID_RE = /^[a-z0-9]{8,32}$/;
/** A `since` past every entry (the server's entry cap): the answer carries the thread's facts and no entries. */
const PAST_LAST_ENTRY = 200;

/**
 * The slug of a thread on this host, from its share URL (`https://<slug>.<apex>/` or `<host>/s/<slug>`) or the slug
 * itself. A URL on any other host is refused before a request is made: the token belongs to this host.
 * @param {Ctx} ctx
 * @param {string} arg
 * @param {string} command
 */
function threadSlugOf(ctx, arg, command) {
  if (THREAD_SLUG_RE.test(arg)) return arg;
  const shown = arg.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 200);
  /** @type {URL} */
  let url;
  try {
    url = new URL(arg);
  } catch {
    throw usageError(`"${shown}" is not a thread URL`, command);
  }
  const api = new URL(ctx.host);
  const pathForm = /^\/s\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (url.origin === api.origin && pathForm !== null && THREAD_SLUG_RE.test(pathForm[1])) return pathForm[1];
  const label = url.hostname.endsWith(`.${api.hostname}`) ? url.hostname.slice(0, -api.hostname.length - 1) : "";
  if (url.protocol === api.protocol && url.port === api.port && (url.pathname === "/" || url.pathname === "") && THREAD_SLUG_RE.test(label)) {
    return label;
  }
  throw new CliError(2, "thread_url_invalid",
    `${shown} is not a thread on ${ctx.host}; pass --host with that thread's instance (its own token is needed there)`);
}

/**
 * The thread named by `arg`, or without one the thread on this host most recently used from this working directory.
 * @param {Ctx} ctx
 * @param {string | undefined} arg
 * @param {string} command
 */
async function threadSlugFor(ctx, arg, command) {
  if (arg !== undefined) return threadSlugOf(ctx, arg, command);
  const here = (await loadThreads())
    .filter((t) => t.host === ctx.host && t.cwds.includes(process.cwd()))
    .sort((a, b) => (b.usedAt ?? "").localeCompare(a.usedAt ?? ""));
  if (here.length === 0) throw usageError(`${command} needs a thread URL: no thread on ${ctx.host} was used from this directory yet`, command);
  return here[0].slug;
}

/**
 * Replaces the stored agent session of `slug` with the renewed one the server sent.
 * @param {Ctx} ctx
 * @param {string} slug
 * @param {string} token
 */
async function saveRenewedAgent(ctx, slug, token) {
  const threads = await loadThreads();
  const record = findThread(threads, ctx, slug);
  if (record?.agent === undefined) return;
  record.agent = { ...record.agent, token, exp: tokenExp(token) ?? record.agent.exp };
  await writePrivateJson(threadsPath(), { threads });
}

/**
 * @param {ThreadRecord[]} threads
 * @param {Ctx} ctx
 * @param {string} slug
 */
function findThread(threads, ctx, slug) {
  return threads.find((t) => t.host === ctx.host && t.slug === slug);
}

/** @param {unknown} a @returns {a is AgentRecord} */
function isAgentRecord(a) {
  if (a === null || typeof a !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (a);
  return typeof r.email === "string" && typeof r.token === "string" && HEADER_SAFE.test(r.token) && typeof r.exp === "number";
}

/**
 * The `exp` claim of a signed token (`base64url(json).signature`), read without checking the signature: the server does
 * that. Only used to know when to stop offering a stored session.
 * @param {string} token
 */
function tokenExp(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

/**
 * Picks a thread's credential: the agent session `thread-connect` stored for it, unless --token is given, else a token
 * (a key, or the server's own), else the saved sign-in. Returns the agent's email (null for the others) and the kind of
 * the others (credentialKind; null for an agent session).
 * @param {Ctx} ctx
 * @param {Values} values
 * @param {string} slug
 * @returns {Promise<{ agentEmail: string | null; kind: "key" | "sign-in" | "token" | null }>}
 */
async function pickThreadCredential(ctx, values, slug) {
  const agent = str(values, "token") === undefined ? findThread(await loadThreads(), ctx, slug)?.agent : undefined;
  if (agent !== undefined && agent.exp > Date.now()) {
    ctx.token = agent.token;
    ctx.agentFor = slug;
    return { agentEmail: agent.email, kind: null };
  }
  const kind = credentialKind(ctx, values);
  if (kind === null) {
    throw new CliError(3, "thread_not_connected",
      `no credential for this thread on ${ctx.host}: run "artifakto thread-connect <thread url>" in your own terminal (or "artifakto login" for a thread in your own space)`);
  }
  ctx.token = await resolveCredential(ctx, values);
  if (kind !== "token") ctx.threadFor = slug;
  return { agentEmail: null, kind };
}

function threadsPath() {
  return path.join(path.dirname(configPath()), "threads.json");
}

/** @typedef {{ email: string; token: string; exp: number }} AgentRecord */
/** @typedef {{ host: string; slug: string; lastSeen: number; cwds: string[]; usedAt?: string; agent?: AgentRecord }} ThreadRecord */

/** @returns {Promise<ThreadRecord[]>} */
async function loadThreads() {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(await fsp.readFile(threadsPath(), "utf8"));
  } catch (e) {
    if (!isErrno(e, "ENOENT")) warn(`cannot read ${threadsPath()}; starting a new one`);
    return [];
  }
  const list = data !== null && typeof data === "object" ? /** @type {{ threads?: unknown }} */ (data).threads : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t !== null && typeof t === "object" && typeof t.host === "string" && typeof t.slug === "string")
    .map((t) => ({
      host: t.host,
      slug: t.slug,
      lastSeen: Number.isSafeInteger(t.lastSeen) && t.lastSeen >= 0 ? t.lastSeen : 0,
      cwds: Array.isArray(t.cwds) ? t.cwds.filter((/** @type {unknown} */ c) => typeof c === "string") : [],
      ...(typeof t.usedAt === "string" ? { usedAt: t.usedAt } : {}),
      ...(isAgentRecord(t.agent) ? { agent: t.agent } : {}),
    }));
}

/**
 * Records what this machine knows about a thread (host, slug, how far it has read, where and when it was used, and its
 * agent session, `null` to forget it), the only
 * memory a pickup leaves. Written 0600 like the config, since the file names private threads.
 * @param {Ctx} ctx
 * @param {string} slug
 * @param {{ lastSeen?: number; agent?: AgentRecord | null }} patch
 */
async function rememberThread(ctx, slug, patch) {
  const threads = await loadThreads();
  let record = findThread(threads, ctx, slug);
  if (record === undefined) {
    record = { host: ctx.host, slug, lastSeen: 0, cwds: [] };
    threads.push(record);
  }
  const { agent, ...rest } = patch;
  Object.assign(record, rest, { usedAt: new Date().toISOString() });
  if (agent === null) delete record.agent;
  else if (agent !== undefined) record.agent = agent;
  if (!record.cwds.includes(process.cwd())) record.cwds.push(process.cwd());
  await writePrivateJson(threadsPath(), { threads });
}

/**
 * Reads a local file of at most `max` bytes; a missing or oversized file is a validation error naming `code`.
 * @param {string} file
 * @param {number} max
 * @param {string} code
 */
async function readLocal(file, max, code) {
  /** @type {import("node:fs").Stats} */
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    throw validationError(code, `cannot read ${file}`);
  }
  if (!st.isFile()) throw validationError(code, `${file} is not a regular file`);
  if (st.size > max) throw validationError(code, `${file} is ${st.size} bytes; the limit is ${max}`);
  return fsp.readFile(file, "utf8");
}

/**
 * The entry to send: `--request <note>`, a `.json` entry file, or any other file as the Markdown brief (titled by --title).
 * @param {Values} values
 * @param {string} command
 * @returns {Promise<Record<string, unknown>>}
 */
async function readEntry(values, command) {
  const request = str(values, "request");
  const file = str(values, "entry");
  if ((request === undefined) === (file === undefined)) throw usageError(`${command} needs exactly one of --entry <file> and --request <note>`, command);
  /** @type {Record<string, unknown>} */
  let entry;
  if (file === undefined) {
    entry = { kind: "request", brief: request };
  } else {
    const text = await readLocal(file, ENTRY_FILE_BYTES, "thread_entry_invalid");
    if (!/\.json$/i.test(file)) {
      entry = { brief: text };
    } else {
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw validationError("thread_entry_invalid", `${file} is not valid JSON`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw validationError("thread_entry_invalid", `${file} must hold a JSON object`);
      entry = /** @type {Record<string, unknown>} */ (parsed);
    }
  }
  const title = str(values, "title");
  if (title !== undefined) entry.title = title;
  if (typeof entry.brief !== "string" || entry.brief.trim() === "" || entry.brief.length > THREAD_BRIEF_CHARS) {
    throw validationError("thread_entry_invalid", `the brief must be 1 to ${THREAD_BRIEF_CHARS} characters`);
  }
  return entry;
}

/**
 * The transcript to attach, parsed (the server validates it), or undefined.
 * @param {Values} values
 * @returns {Promise<{ value: unknown; messages: number; bytes: number } | undefined>}
 */
async function readTranscriptFile(values) {
  const file = str(values, "transcript");
  if (file === undefined) return undefined;
  const text = await readLocal(file, THREAD_TRANSCRIPT_BYTES, "thread_transcript_invalid");
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw validationError("thread_transcript_invalid", `${file} is not valid JSON`);
  }
  const messages = value !== null && typeof value === "object" && Array.isArray(/** @type {{ messages?: unknown }} */ (value).messages)
    ? /** @type {{ messages: unknown[] }} */ (value).messages.length
    : 0;
  if (messages === 0) throw validationError("thread_transcript_invalid", `${file} is not a transcript (run session-export to make one)`);
  return { value, messages, bytes: Buffer.byteLength(text, "utf8") };
}

const BY_REQUIRED_HOW = 'pass --as <your email>, or save it once with "artifakto login --token --email <your email>" (it asks for the key or token again)';

/**
 * The author an entry names (`as`): --as, else the email saved by `login`, which the server's own token must name. A key
 * sends it too: the server writes a key's entries as its account's address whatever `as` says, except for a key minted on
 * the dashboard's token form, which has none and needs one (docs/phase-10-accounts-spec.md D4). A sign-in always has an
 * address, so it names an author only when --as is given. null when nothing is named.
 * @param {Ctx} ctx
 * @param {Values} values
 * @param {"key" | "sign-in" | "token" | null} kind the credential (credentialKind)
 * @param {boolean} [required] false for a dry run that only names the thread
 * @returns {string | null}
 */
function authorOf(ctx, values, kind, required = true) {
  const as = str(values, "as") ?? (kind === "sign-in" ? undefined : ctx.config.email);
  if (as === undefined) {
    if (kind === "key" || kind === "sign-in" || !required) return null;
    throw new CliError(2, "thread_by_required", `name the author: ${BY_REQUIRED_HOW}`);
  }
  if (!EMAIL_RE.test(as)) throw usageError("--as must be an email address", null);
  return as.toLowerCase();
}

/**
 * Whom the server will write the entry as, for a dry run to show (docs/phase-10-accounts-spec.md D4): the `as` of the
 * server's own token; for a key or a sign-in, its account's address (GET /api/v1/me), whatever `as` says, or the `as` a
 * key minted with no address sends, which it must. null when the server cannot say (an older one, offline).
 * @param {Ctx} ctx with the credential in ctx.token
 * @param {"key" | "sign-in" | "token" | null} kind
 * @param {string | null} as what the entry sends (authorOf)
 * @param {boolean} required whether an entry is about to be written, which needs an author
 * @returns {Promise<string | null>}
 */
async function plannedAuthor(ctx, kind, as, required) {
  if (kind !== "key" && kind !== "sign-in") return as;
  /** @type {MeJson} */
  let me;
  try {
    const res = await apiRequest(ctx, "GET", "/api/v1/me");
    if (!res.ok) {
      await discard(res);
      return null;
    }
    me = meOf((await readJson(res, ctx.host)).json, ctx.host);
  } catch {
    return null;
  }
  const account = accountEmail(me);
  if (account !== undefined || me.account.email !== null) return account ?? null;
  if (kind === "key" && as === null && required) {
    throw new CliError(2, "thread_by_required", `this key has no address of its own (it was made on a dashboard signed in with the server's token), so name the author: ${BY_REQUIRED_HOW}`);
  }
  return as;
}

/** @param {Record<string, unknown>} body */
function checkBodySize(body) {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > THREAD_BODY_BYTES) {
    throw validationError("thread_too_large", `the entry and its transcript are ${bytes} bytes; the limit is ${THREAD_BODY_BYTES}. Export the transcript with a smaller --max-bytes, or leave it out`);
  }
}

/**
 * @param {unknown} json
 * @param {string} origin
 * @returns {ThreadWriteJson}
 */
function threadWriteOf(json, origin) {
  const body = objectBody(json, origin);
  if (typeof body.url !== "string" || typeof body.version !== "number" || body.entry === null || typeof body.entry !== "object") {
    throw new CliError(1, "invalid_response", `unexpected response from ${origin}`);
  }
  return /** @type {ThreadWriteJson} */ (/** @type {unknown} */ (body));
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdThreadNew(values, args) {
  const core = await loadThreadCore("thread-new");
  const ctx = await resolveContext(values, "thread-new");
  const members = strs(values, "member");
  if (members.length === 0) throw usageError("thread-new needs at least one --member <email>", "thread-new");
  for (const m of members) if (!EMAIL_RE.test(m)) throw usageError(`--member ${JSON.stringify(m)} is not an email address`, "thread-new");
  const slug = str(values, "slug");
  if (slug !== undefined && !THREAD_SLUG_RE.test(slug)) throw usageError("--slug must be 3-63 lowercase letters, digits or hyphens", "thread-new");
  // A key or a sign-in starts a thread as its account, which the server adds to the members.
  const kind = credentialKind(ctx, values);
  const as = authorOf(ctx, values, kind);
  const entry = await readEntry(values, "thread-new");
  const transcript = await readTranscriptFile(values);
  const body = { title: args[0], members, ...(as === null ? {} : { as }), entry, ...(slug === undefined ? {} : { slug }), ...(transcript ? { transcript: transcript.value } : {}) };
  checkBodySize(body);
  if (bool(values, "dry-run")) {
    if (kind === "key" || kind === "sign-in") ctx.token = await resolveCredential(ctx, values);
    const author = await plannedAuthor(ctx, kind, as, true);
    const plan = { title: args[0], members: [...new Set([...members.map((m) => m.toLowerCase()), ...(author === null ? [] : [author])])].sort(), as: author, entry, transcript: transcript ? { messages: transcript.messages, bytes: transcript.bytes } : null };
    if (jsonMode) printJson({ dryRun: true, ...plan });
    else {
      out(`Would start "${args[0]}" on ${ctx.host}, readable by ${plan.members.join(", ")}${author === null ? " and your account" : ""}.`);
      out(`First entry by ${author ?? "your account"}: ${typeof entry.title === "string" ? entry.title : "(untitled)"}, ${String(entry.brief).length} characters${transcript ? `, with a transcript of ${transcript.messages} messages (${core.formatSize(transcript.bytes)})` : ""}.`);
    }
    return;
  }
  ctx.token = await resolveCredential(ctx, values);
  const { json } = await apiCall(ctx, "POST", "/api/v1/threads", { body });
  const result = threadWriteOf(json, ctx.host);
  await rememberThread(ctx, result.slug, { lastSeen: 1 });
  if (jsonMode) printJson(result);
  else {
    out(result.url);
    errLine(`Started "${args[0]}". The other person picks it up with: artifakto thread-pull ${result.url}`);
  }
}

/**
 * @param {Ctx} ctx
 * @param {string} slug
 * @param {number} since
 * @returns {Promise<ThreadJson>}
 */
async function fetchThread(ctx, slug, since) {
  const { json } = await apiCall(ctx, "GET", `${artifactPath(slug)}/thread?since=${since}`);
  const body = objectBody(json, ctx.host);
  if (typeof body.total !== "number" || !Array.isArray(body.entries) || !Array.isArray(body.files) || typeof body.url !== "string") {
    throw new CliError(1, "invalid_response", `unexpected response from ${ctx.host}`);
  }
  return /** @type {ThreadJson} */ (/** @type {unknown} */ (body));
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdThreadPush(values, args) {
  const core = await loadThreadCore("thread-push");
  const ctx = await resolveContext(values, "thread-push");
  const slug = await threadSlugFor(ctx, args[0], "thread-push");
  const dryRun = bool(values, "dry-run");
  // A dry run without an entry only shows the thread: the skills use it to find the thread of this directory.
  const probe = dryRun && str(values, "entry") === undefined && str(values, "request") === undefined;
  const { agentEmail, kind } = await pickThreadCredential(ctx, values, slug);
  // An agent session is its own author, and so is a key's or a sign-in's account; the server's own token names one.
  const as = agentEmail ?? authorOf(ctx, values, kind, !probe);
  const entry = probe ? null : await readEntry(values, "thread-push");
  const transcript = await readTranscriptFile(values);
  const body = { ...(agentEmail === null && as !== null ? { as } : {}), entry, ...(transcript ? { transcript: transcript.value } : {}) };
  checkBodySize(body);
  if (dryRun) {
    const thread = await fetchThread(ctx, slug, PAST_LAST_ENTRY);
    const author = agentEmail ?? (await plannedAuthor(ctx, kind, as, !probe));
    const plan = { url: thread.url, title: thread.title, members: thread.members, entries: thread.total, as: author, entry, transcript: transcript ? { messages: transcript.messages, bytes: transcript.bytes } : null };
    if (jsonMode) printJson({ dryRun: true, ...plan });
    else {
      out(`${entry === null ? "Thread" : `Would add entry ${thread.total + 1} to`} "${thread.title}" (${thread.url})${author !== null ? ` as ${author}` : entry === null ? "" : " as your account"}.`);
      out(`Readable by: ${thread.members.join(", ")}.`);
      if (entry !== null) out(`${entry.kind === "request" ? "Request" : "Brief"}: ${String(entry.brief).length} characters${transcript ? `; transcript: ${transcript.messages} messages (${core.formatSize(transcript.bytes)})` : ""}.`);
    }
    return;
  }
  const post = async () => threadWriteOf((await apiCall(ctx, "POST", `${artifactPath(slug)}/thread/entries`, { body })).json, ctx.host);
  /** @type {ThreadWriteJson} */
  let result;
  try {
    result = await post();
  } catch (e) {
    // Another entry landed between the server's read and its commit; the server rebuilds from the new version.
    if (!(e instanceof CliError && e.code === "conflict")) throw e;
    result = await post();
  }
  // Your own entry is not news to you: when you had read everything before it, it counts as read.
  const record = findThread(await loadThreads(), ctx, slug);
  await rememberThread(ctx, slug, record?.lastSeen === result.total - 1 ? { lastSeen: result.total } : {});
  if (jsonMode) printJson(result);
  else {
    out(result.url);
    errLine(`Added ${result.entry.kind === "request" ? "a request" : "an entry"} as ${result.entry.by}. Pick it up with: artifakto thread-pull ${result.url}`);
  }
}

/**
 * Prints entries between delimiters that carry a per-pull nonce (thread-core.mjs, shared with the Claude Code mod).
 * @param {ThreadCoreModule} core
 * @param {ThreadJson} thread
 * @param {number} since
 */
function printEntries(core, thread, since) {
  const download = (/** @type {{ id: string }} */ e) => `download with: artifakto thread-pull ${thread.url} --transcript ${e.id} --out <file>`;
  for (const line of core.entryLines(thread, since, randomSlug(), download)) out(line);
}

/**
 * Writes a new file readable by its owner only. An existing file is never replaced: the path may come from an agent.
 * @param {string} file
 * @param {string | Uint8Array} data
 */
async function writeNewFile(file, data) {
  try {
    await fsp.writeFile(file, data, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (isErrno(e, "EEXIST")) throw validationError("path_invalid", `${file} already exists; choose a new file`);
    throw validationError("path_invalid", `cannot write ${file}`);
  }
  await fsp.chmod(file, 0o600);
}

/**
 * Downloads one entry's transcript to `out` (0600), checked against the size and digest the thread lists.
 * @param {Ctx} ctx
 * @param {string} slug
 * @param {ThreadJson} thread
 * @param {string} id
 * @param {string} outFile
 */
async function downloadTranscript(ctx, slug, thread, id, outFile) {
  const file = thread.files.find((f) => f.path === `transcripts/${id}.json`);
  if (file === undefined) throw new CliError(5, "not_found", `the thread has no transcript ${id}`);
  const res = await apiRequest(ctx, "GET", `${artifactPath(slug)}/files/${file.path}`, { timeoutMs: UPLOAD_TIMEOUT_MS });
  if (!res.ok) {
    const { json } = await readJson(res, ctx.host);
    throw agentAware(ctx, serverError(res.status, json, ctx.host));
  }
  /** @type {Uint8Array} */
  let bytes;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw networkError(e, ctx.host);
  }
  if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
    throw new CliError(1, "thread_download_mismatch", `the downloaded transcript does not match its size and sha256 (${file.sha256}); nothing was written`);
  }
  await writeNewFile(outFile, bytes);
  return { path: outFile, bytes: bytes.byteLength, sha256: file.sha256 };
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdThreadPull(values, args) {
  const core = await loadThreadCore("thread-pull");
  const ctx = await resolveContext(values, "thread-pull");
  const slug = await threadSlugFor(ctx, args[0], "thread-pull");
  await pickThreadCredential(ctx, values, slug);
  const id = str(values, "transcript");
  const outFile = str(values, "out");
  if (id !== undefined) {
    if (!TRANSCRIPT_ID_RE.test(id)) throw usageError("--transcript takes an entry id", "thread-pull");
    if (outFile === undefined) throw usageError("--transcript needs --out <file>", "thread-pull");
    const thread = await fetchThread(ctx, slug, PAST_LAST_ENTRY);
    const saved = await downloadTranscript(ctx, slug, thread, id, outFile);
    await rememberThread(ctx, slug, {});
    if (jsonMode) printJson(saved);
    else out(`Wrote ${saved.path} (${core.formatSize(saved.bytes)})`);
    return;
  }
  if (outFile !== undefined) throw usageError("--out goes with --transcript", "thread-pull");
  const sinceFlag = str(values, "since");
  if (sinceFlag !== undefined && !/^(0|[1-9][0-9]{0,2})$/.test(sinceFlag)) throw usageError("--since must be a whole number", "thread-pull");
  const record = findThread(await loadThreads(), ctx, slug);
  let since = sinceFlag !== undefined ? Number(sinceFlag) : (record?.lastSeen ?? 0);
  let thread = await fetchThread(ctx, slug, Math.min(since, PAST_LAST_ENTRY));
  if (since > thread.total) {
    // The thread was rolled back past what this machine had read: show it from its start.
    warn(`the thread has ${thread.total} entries, fewer than the ${since} read here before; showing all of them`);
    since = 0;
    thread = await fetchThread(ctx, slug, 0);
  }
  await rememberThread(ctx, slug, { lastSeen: thread.total });
  if (jsonMode) printJson({ ...thread, since });
  else printEntries(core, thread, since);
}

/** How long a browser sign-in (thread-connect, login) waits for the browser before giving up. */
const CONNECT_WAIT_MS = 5 * 60 * 1000;

const CALLBACK_PAGE = (/** @type {string} */ text) => `<!doctype html><meta charset=utf-8><title>artifakto</title><p style="font:16px system-ui;margin:3rem">${text} You can close this tab and go back to your terminal.</p>`;

/**
 * Waits for the one browser redirect to `http://127.0.0.1:<port>/callback` that carries `state`, and resolves with its
 * query (a code, or an error) once the page answering it is sent. Any other request is answered 404 and ignored. There is
 * no way to type a code in instead: no page shows one, and asking a person to copy a code out of their browser is
 * exactly what someone phishing for their session would ask.
 * @param {http.Server} server
 * @param {string} state
 * @param {CliError} timeout thrown when no answer comes within CONNECT_WAIT_MS
 * @returns {Promise<URLSearchParams>}
 */
function awaitCallback(server, state, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout), CONNECT_WAIT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      clearTimeout(timer);
      const page = CALLBACK_PAGE(url.searchParams.has("code") ? "Done." : "Nothing was connected.");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" })
        .end(page, () => resolve(url.searchParams));
    });
  });
}

/**
 * Opens `url` in the default browser; a failure only means the person opens it themselves. ARTIFAKTO_NO_BROWSER skips
 * it (tests, and machines without one).
 * @param {string} url
 */
function openBrowser(url) {
  if (process.env.ARTIFAKTO_NO_BROWSER) return;
  // Not `cmd /c start`: cmd.exe would read each "&" in the query as a command separator.
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // printed above; nothing else to do
  }
}

/**
 * A browser sign-in (thread-connect, login): listens on 127.0.0.1 on a port the system picks, prints and opens the page
 * `pageFor(port)` names, and waits for its redirect to `http://127.0.0.1:<port>/callback` with `state` (awaitCallback).
 * The listener is closed before this returns.
 * @param {(port: number) => URL} pageFor
 * @param {string} state
 * @param {CliError} timeout
 * @returns {Promise<{ port: number; answer: URLSearchParams }>}
 */
async function browserSignIn(pageFor, state, timeout) {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve(undefined)));
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const page = pageFor(port);
    errLine(`Opening ${page} to sign in. If no browser opens, open that address yourself.`);
    openBrowser(page.toString());
    return { port, answer: await awaitCallback(server, state, timeout) };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** A PKCE verifier, its S256 challenge, and a state, all fresh. */
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(24).toString("base64url") };
}

/**
 * Signs in through the browser for one thread (docs/phase-8-threads-spec.md H4): a PKCE verifier and a state stay
 * here, the consent page sends a 60-second code to this computer's loopback, and the code plus the verifier buy a
 * 7-day agent session, stored in threads.json and never printed.
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdThreadConnect(values, args) {
  const core = await loadThreadCore("thread-connect");
  const ctx = await resolveContext(values, "thread-connect");
  const slug = threadSlugOf(ctx, args[0], "thread-connect");
  const { verifier, challenge, state } = pkce();
  const { answer } = await browserSignIn((port) => {
    const signIn = new URL("/sign-in", ctx.host);
    for (const [k, v] of Object.entries({ artifact: slug, agent: String(port), state, challenge })) signIn.searchParams.set(k, v);
    return signIn;
  }, state, new CliError(1, "thread_connect_timeout", "no answer from the browser within 5 minutes; run thread-connect again"));
  const code = answer.get("code");
  if (code === null) {
    if (answer.get("error") === "not_listed") throw new CliError(3, "thread_not_listed", "the account you signed in with is not on this thread's members list; ask its owner to add it");
    throw new CliError(1, "thread_connect_cancelled", "the sign-in was cancelled in the browser");
  }
  const { json } = await apiCall(ctx, "POST", "/api/v1/agent/sessions", { body: { code, verifier }, token: false });
  const body = objectBody(json, ctx.host);
  const { slug: granted, url, title: rawTitle } = body;
  if (!isAgentRecord(body) || granted !== slug) {
    throw new CliError(1, "invalid_response", `unexpected response from ${ctx.host}`);
  }
  await rememberThread(ctx, slug, { agent: { email: body.email, token: body.token, exp: body.exp } });
  const title = String(rawTitle);
  const summary = { connected: true, slug, url, title, email: body.email, exp: new Date(body.exp).toISOString() };
  if (jsonMode) printJson(summary);
  else out(core.printable(`Connected to "${title}" as ${body.email} until ${formatDate(summary.exp)}.`));
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdThreadDisconnect(values, args) {
  const ctx = await resolveContext(values, "thread-disconnect");
  const slug = threadSlugOf(ctx, args[0], "thread-disconnect");
  const had = findThread(await loadThreads(), ctx, slug)?.agent !== undefined;
  if (had) await rememberThread(ctx, slug, { agent: null });
  if (jsonMode) printJson({ disconnected: had, slug });
  else out(had ? `Disconnected from ${slug}.` : `This computer was not connected to ${slug}.`);
}

/** @typedef {typeof import("./thread-core.mjs")} ThreadCoreModule */

/**
 * thread-core.mjs, the printing the thread commands and session-export share with the Claude Code mod.
 * @param {string} command
 * @returns {Promise<ThreadCoreModule>}
 */
async function loadThreadCore(command) {
  try {
    return await import("./thread-core.mjs");
  } catch {
    throw new CliError(1, "thread_core_unavailable", `${command} needs thread-core.mjs, from the same version, next to artifakto.mjs; copy it too, or install the package`);
  }
}

/** @typedef {typeof import("./claude-session.mjs")} SessionModule */

/** @param {string} file */
async function readSessionFile(file) {
  try {
    return { file, text: await fsp.readFile(file, "utf8") };
  } catch {
    throw validationError("session_unreadable", `cannot read ${file}`);
  }
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdSessionExport(values, args) {
  const core = await loadThreadCore("session-export");
  /** @type {SessionModule | null} */
  let session;
  try {
    session = await import("./claude-session.mjs");
  } catch {
    session = null;
  }
  if (session === null || typeof session.convertSession !== "function") {
    throw new CliError(1, "session_unavailable", "session-export needs claude-session.mjs, session-core.mjs and thread-core.mjs, from the same version, next to artifakto.mjs; copy all four files, or install the package");
  }
  const marker = str(values, "marker");
  if ((marker === undefined) === (args[0] === undefined)) throw usageError("session-export needs exactly one of --marker <nonce> and a session file", "session-export");
  if (marker !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(marker)) throw usageError("--marker must be 8-64 letters, digits, - or _", "session-export");
  const maxFlag = str(values, "max-bytes");
  const maxBytes = maxFlag === undefined ? THREAD_TRANSCRIPT_BYTES : Number(maxFlag);
  if (maxFlag !== undefined && (!/^[1-9][0-9]*$/.test(maxFlag) || maxBytes < 100_000 || maxBytes > THREAD_TRANSCRIPT_BYTES)) {
    throw usageError(`--max-bytes must be from 100000 to ${THREAD_TRANSCRIPT_BYTES}`, "session-export");
  }
  const home = os.homedir();
  const found = marker === undefined ? await readSessionFile(args[0]) : await session.findSessionFile(session.projectDirFor(process.cwd(), home), marker);
  if (found === null) {
    throw new CliError(5, "session_not_found", `no session under ${session.projectDirFor(process.cwd(), home)} contains the marker; run this from the session's own working directory`);
  }
  const { file, text } = found;
  const ctx = await resolveContext(values, "session-export");
  const apex = new URL(ctx.host).hostname;
  const converted = session.convertSession(text, { home, linkHosts: [apex] });
  if (converted.transcript.messages.length === 0) throw validationError("session_unreadable", `${file} holds no conversation this export can read`);
  const transcript = session.fitBudget(converted.transcript, converted.report, converted.compactionIndex, maxBytes);
  const report = converted.report;
  /** @type {string | null} */
  let outFile = null;
  if (!bool(values, "brief-only")) {
    outFile = str(values, "out") ?? path.join(os.tmpdir(), `artifakto-session-${randomSlug()}.json`);
    await writeNewFile(outFile, JSON.stringify(transcript));
  }
  if (jsonMode) {
    printJson({ session: file, out: outFile, title: transcript.title ?? null, report });
    return;
  }
  /** @param {Record<string, number>} counts */
  const list = (counts) => Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  out(`Session: ${file}`);
  if (outFile !== null) out(`Transcript: ${outFile} (${report.messages} messages, ${core.formatSize(report.bytes)})`);
  out(`Tool calls: ${list(report.toolCalls)}`);
  out(`Tool results kept: ${list(report.toolResultsKept)}; left out: ${list(report.toolResultsDropped)}`);
  out(`Redactions: ${list(report.redactions)}`);
  if (report.secretPathsSkipped.length > 0) out(`Left out reads of: ${report.secretPathsSkipped.join(", ")}`);
  if (report.truncated.length > 0) out(`Shortened: ${report.truncated.join("; ")}`);
  if (report.links.length > 0) out(`Links seen: ${report.links.join(" ")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// set, rollback, delete

/** @param {() => number} [pick] */
function randomSlug(pick = () => randomInt(BASE36.length)) {
  let s = "";
  for (let i = 0; i < RANDOM_SLUG_LENGTH; i++) s += BASE36[pick()];
  return s;
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdSet(values, args) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  /**
   * @param {string} flag
   * @param {string} negated
   * @param {string} key
   * @param {(v: string) => string | Promise<string>} [transform]
   */
  const pairFlag = async (flag, negated, key, transform) => {
    const v = str(values, flag);
    if (v !== undefined && bool(values, negated)) throw usageError(`--${flag} and --${negated} cannot be combined`, "set");
    if (v !== undefined) patch[key] = transform ? await transform(v) : v;
    if (bool(values, negated)) patch[key] = null;
  };
  const title = str(values, "title");
  if (title !== undefined) patch.title = title;
  await pairFlag("description", "no-description", "description");
  await pairFlag("favicon", "no-favicon", "favicon");
  await pairFlag("source-url", "no-source-url", "sourceUrl");
  const slug = str(values, "slug");
  if (slug !== undefined && bool(values, "random-slug")) throw usageError("--slug and --random-slug cannot be combined", "set");
  if (slug !== undefined) patch.slug = slug;
  if (bool(values, "random-slug")) patch.slug = randomSlug();
  const visibility = str(values, "visibility");
  if (visibility !== undefined) {
    if (!VISIBILITIES.includes(visibility)) throw usageError(`--visibility must be one of ${VISIBILITIES.join(", ")}`, "set");
    patch.visibility = visibility;
  }
  const mode = str(values, "mode");
  if (mode !== undefined) {
    if (!MODES.includes(mode)) throw usageError(`--mode must be one of ${MODES.join(", ")}`, "set");
    patch.mode = mode;
  }
  if (bool(values, "enable") && bool(values, "disable")) throw usageError("--enable and --disable cannot be combined", "set");
  if (bool(values, "enable")) patch.disabled = false;
  if (bool(values, "disable")) patch.disabled = true;

  // Resolved here, before --password's transform: --password - blocks on readStdin(), potentially
  // indefinitely on an interactive terminal with nothing piped in, and there's no reason to sit blocked on
  // that read before finding out the request was doomed anyway (no saved token, not logged in). Every other
  // flag above is synchronous validation with no I/O, so checking auth after them (not before) doesn't change
  // when those usage errors get reported.
  const ctx = await authedContext(values, "set");

  await pairFlag("password", "no-password", "password", async (v) => {
    if (v === "") throw usageError("--password cannot be empty", "set");
    return v === "-" ? await readStdin() : v;
  });
  const addMembers = strs(values, "add-member");
  if (addMembers.length > 0) patch.addMembers = addMembers;
  const removeMembers = strs(values, "remove-member");
  if (removeMembers.length > 0) patch.removeMembers = removeMembers;

  if (Object.keys(patch).length === 0) throw usageError("set needs at least one change", "set");
  const { json } = await apiCall(ctx, "PATCH", artifactPath(args[0]), { body: patch });
  const result = mutationOf(json, ctx.host);
  if (jsonMode) {
    printJson(result);
    return;
  }
  out(`Updated ${result.artifact.url}`);
  printWarnings(result.warnings);
}

/**
 * @param {unknown} json
 * @param {string} origin
 * @returns {MutationJson}
 */
function mutationOf(json, origin) {
  const body = objectBody(json, origin);
  if (body.artifact === null || typeof body.artifact !== "object") {
    throw new CliError(1, "invalid_response", `unexpected response from ${origin}`);
  }
  return /** @type {MutationJson} */ (/** @type {unknown} */ (body));
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdRollback(values, args) {
  const to = str(values, "to");
  /** @type {{ to: number } | undefined} */
  let body;
  if (to !== undefined) {
    if (!/^\d+$/.test(to) || Number(to) < 1 || !Number.isSafeInteger(Number(to))) {
      throw usageError("--to must be a version number (1 or more)", "rollback");
    }
    body = { to: Number(to) };
  }
  const ctx = await authedContext(values, "rollback");
  const { json } = await apiCall(ctx, "POST", `${artifactPath(args[0])}/rollback`, body === undefined ? {} : { body });
  const result = /** @type {RollbackJson} */ (/** @type {unknown} */ (objectBody(json, ctx.host)));
  if (jsonMode) {
    printJson(result);
    return;
  }
  if (result.unchanged) out(`${result.slug} is already at version ${result.version}`);
  else out(`Rolled back ${result.slug} to version ${result.version} (was ${result.previousVersion})`);
  printWarnings(result.warnings);
}

/** @param {string} question */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * @param {Values} values
 * @param {string[]} args
 */
async function cmdDelete(values, args) {
  const slug = args[0];
  if (!bool(values, "yes") && !process.stdin.isTTY) {
    throw usageError("delete needs --yes when stdin is not a terminal", "delete");
  }
  const ctx = await authedContext(values, "delete");
  if (!bool(values, "yes")) {
    const ok = await confirm(`Disable ${slug} on ${ctx.host} (offline for everyone; stored files are kept)? [y/N] `);
    if (!ok) throw new CliError(2, "confirmation_required", "not confirmed; nothing was changed");
  }
  const { json } = await apiCall(ctx, "DELETE", artifactPath(slug));
  const result = mutationOf(json, ctx.host);
  const purgeFailed = (result.warnings ?? []).some((w) => w.code === "cache_purge_failed");
  const retry = `the artifact is disabled, but the CDN cache could not be purged; run "artifakto delete ${result.artifact.slug} --yes" again to retry`;
  if (jsonMode) {
    if (purgeFailed) {
      throw new CliError(1, "cache_purge_failed", retry, {
        details: { slug: result.artifact.slug, url: result.artifact.url, warnings: result.warnings },
      });
    }
    printJson(result);
    return;
  }
  out(`Disabled ${result.artifact.url}`);
  printWarnings(result.warnings);
  if (purgeFailed) throw new CliError(1, "cache_purge_failed", retry);
}

// ---------------------------------------------------------------------------------------------------------------
// health, login, logout

/** Only the owner-only config file, with no request; ensurePrivateConfig warns on stderr when it cannot make it. */
async function cmdPrepare() {
  await ensurePrivateConfig();
}

/**
 * @param {Values} values
 */
async function cmdHealth(values) {
  const ctx = await resolveContext(values, "health");
  const { status, json } = await rawApiCall(ctx, "GET", "/api/v1/health", { token: false });
  const body = json !== null && typeof json === "object" ? /** @type {Record<string, unknown>} */ (json) : null;
  if (body === null || typeof body.ok !== "boolean" || body.checks === null || typeof body.checks !== "object") {
    if (status < 200 || status > 299) throw serverError(status, json, ctx.host);
    throw new CliError(1, "invalid_response", `unexpected response (HTTP ${status}) from ${ctx.host}`);
  }
  const health = /** @type {HealthJson} */ (/** @type {unknown} */ (body));
  if (jsonMode) printJson(health);
  else {
    const c = health.checks;
    out(`${health.ok ? "ok" : "not ok"} store=${health.store ?? "none"} db=${c.db} blob=${c.blob} auth=${c.auth}`);
  }
  if (!health.ok) process.exitCode = 1;
}

async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Prompts on stderr and reads a line from the terminal with echo disabled.
 * @param {string} question
 * @returns {Promise<string>}
 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let buffer = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "") {
          finish();
          resolve(buffer.trim());
          return;
        }
        if (ch === "") {
          finish();
          reject(new CliError(2, "usage_error", "cancelled"));
          return;
        }
        if (ch === "" || ch === "\b") buffer = buffer.slice(0, -1);
        else buffer += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** How the dashboard's Keys and apps and the consent page name a sign-in from this CLI. */
const LOGIN_CLIENT_NAME = "artifakto CLI";
/** What a sign-in may do: publish, list and show pages (an OAuth grant never holds artifacts:manage). */
const LOGIN_SCOPE = "artifacts:read artifacts:write";
/** The redirect URI the CLI registers: an http redirect to a loopback IP matches it on any port (RFC 8252 section 7.3). */
const LOGIN_REDIRECT = "http://127.0.0.1/callback";

/**
 * @typedef {{
 *   account: { id: string; email: string | null; instanceOwner: boolean };
 *   credential: { kind: "instance" | "key" | "oauth" | "agent"; label: string; scopes: string[]; hint: string | null };
 * }} MeJson
 */

/**
 * GET /api/v1/me's answer (docs/phase-10-accounts-spec.md 4.4), checked.
 * @param {unknown} json
 * @param {string} origin
 * @returns {MeJson}
 */
function meOf(json, origin) {
  const body = objectBody(json, origin);
  const a = /** @type {Record<string, unknown> | null} */ (typeof body.account === "object" ? body.account : null);
  const c = /** @type {Record<string, unknown> | null} */ (typeof body.credential === "object" ? body.credential : null);
  if (a === null || c === null || (a.email !== null && typeof a.email !== "string") || typeof a.instanceOwner !== "boolean" ||
    typeof c.kind !== "string" || typeof c.label !== "string" || !Array.isArray(c.scopes) || (c.hint !== null && typeof c.hint !== "string")) {
    throw new CliError(1, "invalid_response", `unexpected response from ${origin}`);
  }
  return /** @type {MeJson} */ (/** @type {unknown} */ (body));
}

/**
 * The address /me names, as the config keeps it, or undefined.
 * @param {MeJson | null} me
 */
function accountEmail(me) {
  const email = me?.account.email;
  return typeof email === "string" && EMAIL_RE.test(email) ? email.toLowerCase() : undefined;
}

/**
 * Checks the credential in ctx.token with GET /api/v1/me and returns its answer. An older server has no /me (a 404), and
 * is asked for one artifact instead: null then.
 * @param {Ctx} ctx
 * @returns {Promise<MeJson | null>}
 */
async function verifiedAccount(ctx) {
  const res = await apiRequest(ctx, "GET", "/api/v1/me");
  if (res.status === 404) {
    await discard(res);
    await apiCall(ctx, "GET", "/api/v1/artifacts?limit=1");
    return null;
  }
  const { status, json } = await readJson(res, ctx.host);
  if (status < 200 || status > 299) throw serverError(status, json, ctx.host);
  return meOf(json, ctx.host);
}

/**
 * Whether the host offers a browser sign-in, as the details of its 401 to GET /api/v1/me without a credential say
 * (docs/phase-10-accounts-spec.md 4.4). An older server answers 404, and any other answer means no as well.
 * @param {Ctx} ctx
 */
async function offersSignIn(ctx) {
  const res = await apiRequest(ctx, "GET", "/api/v1/me", { token: false });
  if (res.status !== 401) {
    await discard(res);
    return false;
  }
  const { json } = await readJson(res, ctx.host).catch(() => ({ json: null }));
  const details = errorBodyOf(json)?.details;
  return details !== null && typeof details === "object" && /** @type {{ signIn?: unknown }} */ (details).signIn === "oauth";
}

/**
 * DELETE /api/v1/credential with `token`, a key or a sign-in's access token: ends it on the server
 * (docs/phase-10-accounts-spec.md 4.4). Best effort: null once it no longer works there (ended now, or before, which a 401
 * says), else why that is not known (offline, an older server, a refusal).
 * @param {Ctx} ctx
 * @param {string} token
 * @returns {Promise<string | null>}
 */
async function revokeOnServer(ctx, token) {
  /** @type {Ctx} */
  const call = { host: ctx.host, envHost: ctx.envHost, config: ctx.config, token, bypass: ctx.bypass, warnedHttp: ctx.warnedHttp };
  try {
    const res = await apiRequest(call, "DELETE", "/api/v1/credential");
    if (res.ok || res.status === 401 || res.status === 404) {
      await discard(res);
      return res.status === 404 ? `${ctx.host} is older than this CLI` : null;
    }
    const { json } = await readJson(res, ctx.host).catch(() => ({ json: null }));
    return `${ctx.host} refused it (${errorBodyOf(json)?.code ?? `HTTP ${res.status}`})`;
  } catch (e) {
    return e instanceof CliError ? e.message : "unexpected failure";
  } finally {
    ctx.warnedHttp ||= call.warnedHttp;
  }
}

/**
 * Ends a sign-in on the server (revokeOnServer) with its access token, refreshed first when it is about to expire. A
 * refresh refused with invalid_grant means it had ended already.
 * @param {Ctx} ctx
 * @param {SignIn} signIn
 * @returns {Promise<string | null>}
 */
async function revokeSignIn(ctx, signIn) {
  if (isFresh(signIn)) return revokeOnServer(ctx, signIn.accessToken);
  /** @type {Awaited<ReturnType<typeof refreshTokens>>} */
  let reply;
  try {
    reply = await refreshTokens(ctx, signIn);
  } catch (e) {
    return e instanceof CliError ? e.message : "unexpected failure";
  }
  if ("tokens" in reply) return revokeOnServer(ctx, reply.tokens.accessToken);
  return reply.error === "invalid_grant" ? null : `${ctx.host}/oauth/token answered HTTP ${reply.status}`;
}

/**
 * Saves a login for ctx.host in place of whatever the config held (one host at a time, as always), under the config
 * lock, and ends the sign-in it replaces, for whichever host that was: nothing holds that one any more. The email is the
 * account's, from /me, else --email, else the one saved for the host before.
 * @param {Ctx} ctx
 * @param {{ token: string } | { oauth: SignIn }} login
 * @param {MeJson | null} me
 * @param {string | undefined} flagEmail
 */
async function saveLogin(ctx, login, me, flagEmail) {
  const { replaced, email } = await withConfigLock(async () => {
    const config = await loadConfig();
    const same = config.host === ctx.host;
    const email = accountEmail(me) ?? flagEmail ?? (same ? config.email : undefined);
    await saveConfig({ host: ctx.host, ...("token" in login ? { token: login.token } : {}), ...(email === undefined ? {} : { email }), ...("oauth" in login ? { oauth: login.oauth } : {}) });
    return { replaced: config.host === undefined || config.oauth === undefined ? undefined : { host: config.host, signIn: config.oauth }, email };
  });
  if (replaced !== undefined) {
    // Ended on its own host, with the bypass only when that is the env host (resolveContext).
    /** @type {Ctx} */
    const old = replaced.host === ctx.host ? ctx
      : { ...ctx, host: replaced.host, token: null, bypass: replaced.host === ctx.envHost ? (process.env.ARTIFAKTO_AI_PROTECTION_BYPASS || null) : null };
    const unknown = await revokeSignIn(old, replaced.signIn);
    ctx.warnedHttp ||= old.warnedHttp;
    if (unknown !== null) warn(`the earlier sign-in for ${old.host} could not be ended there (${unknown}); disconnect it under Keys and apps (${keysPage(old.host)})`);
  }
  if (jsonMode) printJson({ loggedIn: true, host: ctx.host, email: email ?? null, signIn: "oauth" in login ? "browser" : "token" });
  else out(`Logged in to ${ctx.host}${email === undefined ? "" : ` as ${email}`}`);
  if (envTokenShadows(ctx.host)) warnShadowed(ctx.host);
}

/**
 * The browser sign-in (docs/phase-10-accounts-spec.md 6.1): registers this CLI as an OAuth public client of /api/v1,
 * opens the consent page with PKCE, takes the code at its loopback, redeems it, checks it with /me, and saves the grant
 * under `oauth` as /artifakto-login does, so that refreshing it works the same.
 * @param {Ctx} ctx
 * @param {string | undefined} flagEmail
 */
async function browserLogin(ctx, flagEmail) {
  const registered = await oauthPost(ctx, "/oauth/register", JSON.stringify({ client_name: LOGIN_CLIENT_NAME, redirect_uris: [LOGIN_REDIRECT] }), "application/json");
  if (registered.status === 404) throw signInUnavailable(ctx);
  const clientId = registered.doc.client_id;
  if (registered.status < 200 || registered.status > 299 || typeof clientId !== "string" || !HEADER_SAFE.test(clientId)) {
    throw new CliError(1, "invalid_response", `unexpected response (HTTP ${registered.status}) from ${ctx.host}/oauth/register`);
  }
  const resource = `${ctx.host}/api/v1`;
  const redirectFor = (/** @type {number} */ port) => `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge, state } = pkce();
  // The consent page answers at this computer's loopback, which a browser on another one cannot reach.
  const unreachable = "the browser cannot reach this computer's 127.0.0.1 (over SSH, in a container)";
  const withKey = `run "artifakto login --token" with a key from ${keysPage(ctx.host)}`;
  const elsewhere = `where ${unreachable}, ${withKey}`;
  errLine(`If ${unreachable}, press Ctrl-C and ${withKey} instead.`);
  const { port, answer } = await browserSignIn((p) => {
    const page = new URL("/oauth/authorize", ctx.host);
    const query = { response_type: "code", client_id: clientId, redirect_uri: redirectFor(p), code_challenge: challenge, code_challenge_method: "S256", scope: LOGIN_SCOPE, resource, state };
    for (const [k, v] of Object.entries(query)) page.searchParams.set(k, v);
    return page;
  }, state, new CliError(3, "login_timeout", `no answer from the browser within 5 minutes; run "artifakto login" again, or, ${elsewhere}`));
  const code = answer.get("code");
  if (code === null) {
    const refused = answer.get("error") === "access_denied" ? accountRefusal(ctx.host, answer.get("error_description")) : null;
    throw refused ?? new CliError(3, "login_cancelled", `the sign-in was cancelled in the browser, or took too long; run "artifakto login" again, or, ${elsewhere}`);
  }
  const form = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectFor(port), resource });
  const reply = tokensOf(await oauthPost(ctx, "/oauth/token", form.toString(), FORM_TYPE));
  if (!("tokens" in reply)) {
    // An account suspended since it approved gets no grant, and says so.
    throw accountRefusal(ctx.host, reply.description) ?? (reply.status === 404 ? signInUnavailable(ctx)
      : new CliError(1, "invalid_response", `unexpected response (HTTP ${reply.status}) from ${ctx.host}/oauth/token`));
  }
  ctx.token = reply.tokens.accessToken;
  /** @type {MeJson | null} */
  let me;
  try {
    me = await verifiedAccount(ctx);
  } catch (e) {
    // Not saved, so not held by anything: ended at once, as well as it can be.
    await revokeOnServer(ctx, reply.tokens.accessToken);
    throw e;
  }
  await saveLogin(ctx, { oauth: savedSignIn({ clientId, resource }, reply.tokens) }, me, flagEmail);
}

/**
 * `login`: on a terminal, with no --token or --token-stdin, the browser sign-in when the server offers one; otherwise a
 * key from the dashboard (or the server's own token), from --token, stdin or a hidden prompt, checked before it is saved
 * (docs/phase-10-accounts-spec.md 6.1).
 * @param {Values} values
 */
async function cmdLogin(values) {
  const ctx = await resolveContext(values, "login");
  const email = str(values, "email");
  if (email !== undefined && !EMAIL_RE.test(email)) throw usageError("--email must be an email address", "login");
  const flagEmail = email?.toLowerCase();
  const flag = str(values, "token");
  const fromStdin = bool(values, "token-stdin") || !process.stdin.isTTY;
  if (flag === undefined && !fromStdin && (await offersSignIn(ctx))) {
    await browserLogin(ctx, flagEmail);
    return;
  }
  const token = flag !== undefined && flag !== "" ? flag : fromStdin ? await readStdin() : await promptHidden(`Key or token for ${ctx.host}: `);
  if (token === "") throw new CliError(3, "no_token", "no token given");
  ctx.token = token;
  await saveLogin(ctx, { token }, await verifiedAccount(ctx), flagEmail);
}

/** @type {Readonly<Record<string, string>>} */
const CREDENTIAL_KINDS = { instance: "the server's own token", key: "key", oauth: "sign-in", agent: "agent session" };

/** @param {string} text a value from the server, shown on one line without control characters */
const plain = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

/**
 * `whoami`: what GET /api/v1/me says of the credential this host gets (docs/phase-10-accounts-spec.md 6.1), and where
 * that comes from.
 * @param {Values} values
 */
async function cmdWhoami(values) {
  const ctx = await resolveContext(values, "whoami");
  const source = tokenSource(ctx, values);
  ctx.token = await resolveCredential(ctx, values);
  const from = source === null ? "config-sign-in" : source.from === "config" ? "config-token" : source.from;
  if (from === "env" && ctx.config.host === ctx.host && (ctx.config.token !== undefined || ctx.config.oauth !== undefined)) warnShadowed(ctx.host);
  const res = await apiRequest(ctx, "GET", "/api/v1/me");
  if (res.status === 404) {
    await discard(res);
    throw new CliError(5, "not_found", `${ctx.host} is older than this CLI and cannot say whose login this is (no /api/v1/me)`);
  }
  const { status, json } = await readJson(res, ctx.host);
  if (status < 200 || status > 299) throw agentAware(ctx, serverError(status, json, ctx.host));
  const me = meOf(json, ctx.host);
  if (jsonMode) {
    printJson({ host: ctx.host, ...me, from });
    return;
  }
  const { account, credential } = me;
  const where = { flag: "--token", env: "ARTIFAKTO_AI_TOKEN", "config-token": `the token saved in ${configPath()}`, "config-sign-in": `the sign-in saved in ${configPath()}` };
  out(`host: ${ctx.host}`);
  out(`account: ${account.email === null ? "no address" : plain(account.email)} (${account.instanceOwner ? "the instance owner" : "an account"})`);
  out(`credential: ${CREDENTIAL_KINDS[credential.kind] ?? plain(credential.kind)} "${plain(credential.label)}"${credential.hint === null ? "" : ` (${KEY_PREFIX}…${plain(credential.hint)})`}`);
  out(`scopes: ${credential.scopes.map((s) => plain(String(s))).join(" ")}`);
  out(`from: ${where[from]}`);
}

/**
 * `logout`: ends the config's own credential for the host on the server (the saved key, the saved sign-in), never a
 * --token or ARTIFAKTO_AI_TOKEN, then removes it here; --local only removes it. The server's own token is only removed.
 * An offline or older server is a warning (docs/phase-10-accounts-spec.md 6.1).
 * @param {Values} values
 */
async function cmdLogout(values) {
  const ctx = await resolveContext(values, "logout");
  const local = bool(values, "local");
  const saved = ctx.config.host === ctx.host && (ctx.config.token !== undefined || ctx.config.oauth !== undefined);
  // Under the lock: a sign-in may be refreshed here, and the config is read again for the latest one.
  const result = !saved ? null : await withConfigLock(async () => {
    const config = await loadConfig();
    if (config.host !== ctx.host || (config.token === undefined && config.oauth === undefined)) return null;
    const key = config.token?.startsWith(KEY_PREFIX) === true ? config.token : undefined;
    const what = [...(key === undefined ? [] : ["key"]), ...(config.oauth === undefined ? [] : ["sign-in"])].join(" and ");
    /** @type {(string | null)[]} */
    const outcomes = [];
    if (!local && key !== undefined) outcomes.push(await revokeOnServer(ctx, key));
    if (!local && config.oauth !== undefined) outcomes.push(await revokeSignIn(ctx, config.oauth));
    await saveConfig({ host: ctx.host, ...(config.email === undefined ? {} : { email: config.email }) });
    const unknown = outcomes.filter((o) => o !== null);
    return { what, ended: outcomes.length > 0 && unknown.length === 0, unknown };
  });
  if (jsonMode) printJson({ loggedOut: result !== null, host: ctx.host, revoked: result?.ended ?? false });
  else if (result === null) out(`No saved token for ${ctx.host}`);
  else if (result.ended) out(`Logged out of ${ctx.host}, and ended the saved ${result.what} there`);
  else {
    out(`Logged out of ${ctx.host}`);
    if (result.what !== "" && local) errLine(`The saved ${result.what} still works on ${ctx.host} until it is revoked under Keys and apps (${keysPage(ctx.host)}).`);
  }
  if (result !== null && result.unknown.length > 0) {
    warn(`the saved ${result.what} could not be ended on ${ctx.host} (${result.unknown.join("; ")}); revoke it under Keys and apps (${keysPage(ctx.host)})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// main

/** @param {string[]} argv */
async function main(argv) {
  try {
    await run(argv);
  } catch (e) {
    const error = e instanceof CliError
      ? e
      // Never the message: it can quote values such as header contents.
      : new CliError(1, "internal", `unexpected failure (${e instanceof Error ? e.name : typeof e})`);
    if (jsonMode) {
      /** @type {{ code: string; message: string; details?: unknown }} */
      const doc = { code: error.code, message: error.message };
      if (error.details !== undefined) doc.details = error.details;
      printJson({ error: doc });
    }
    if (error.lines !== undefined) for (const line of error.lines) errLine(line);
    else if (error.code === "usage_error") errLine(`error: ${error.message}`);
    else errLine(`error: ${error.message} (${error.code})`);
    if (error.usage !== undefined) errLine(error.usage);
    process.exitCode = error.exitCode;
  }
}

await main(process.argv.slice(2));
