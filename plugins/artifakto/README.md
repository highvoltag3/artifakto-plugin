# artifakto plugin for Claude Code

Mirror Claude Code artifacts and local HTML files to artifakto.ai, and get a share link back. Hand a Claude Code session to someone else, and get theirs back, through a members-only thread.

The plugin has three skills: `/artifakto:mirror`, `/artifakto:handoff` and `/artifakto:pickup`. It ships its own copy of the zero-dependency `artifakto` CLI at `scripts/artifakto.mjs` (with its modules next to it) and runs it with Node. It also carries a Claude Code mod with the commands `/artifakto-login`, `/thread-connect`, `/thread-handoff` and `/thread-pickup`, which need neither Node nor the CLI to run, except that `/artifakto-login` saves into the CLI's config file, and the plugin makes that file when a session starts (`artifakto prepare`, the CLI under Node; see "Log in" and "Threads in Claude Code itself" below).

## Supported platforms

macOS and Linux for the MVP. You need Node.js 22.12 or later on your `PATH`.

The skill runs the CLI as `node ${CLAUDE_PLUGIN_ROOT}/scripts/artifakto.mjs ...` with the plugin path unquoted, so the directory Claude Code installs the plugin into must not contain spaces. Windows is not supported yet.

## Install

In Claude Code:

```
/plugin marketplace add highvoltag3/artifakto-plugin
/plugin install artifakto@artifakto
```

Then restart Claude Code: the plugin's session-start hook makes the CLI's config file, which `/artifakto-login` saves into. The manifests carry no `version` field: every pushed commit to `main` is a new version, and updating the marketplace brings it in.

## Local development

From a checkout of this repository:

```
claude --plugin-dir ./plugins/artifakto
```

After editing the skill, run `/reload-plugins` in that session to pick up the change.

## Log in

The skill never asks for your token in the conversation and never passes `--host` or `--token` itself. Log in in one of three ways.

- Sign in from Claude Code with `/artifakto-login`. It opens a pane with a link to the instance's sign-in page. Sign in with your account (the instance owner's, or one the instance owner invited), check that the page shows the same pairing code as the pane, connect, and paste the code the page shows into the pane's field (on the phone: `/artifakto-login <code>`). The code never goes through the conversation, and it works once, for 5 minutes, only with the verifier the mod keeps. When it is done, the pane names the account it signed in as (`GET /api/v1/me`, on a server that has it).

  The mod saves an OAuth grant for your account into the CLI's config file under `"oauth"`, in the same shape as `artifakto login`'s browser sign-in, so `/artifakto:mirror` and the thread commands (the skills' and the mod's own) use it with no change: it publishes, lists and shows pages, and starts and adds to threads in your own space, and nothing more. Anything `set` changes (visibility, address, title, enabling or disabling, password, members), rolling back and deleting need a Full key, and the CLI says so (`owner_token_required`, `insufficient_scope`); the dashboard also changes visibility and archives, but cannot roll back. A push can still make a public page unlisted or an unlisted one public, but never changes a password or members page's visibility (`forbidden`). Signing in again replaces the saved sign-in, for whichever host it was, and ends the old one on its server. The grant shows under Keys and apps on the instance's dashboard, where Disconnect ends it; `artifakto logout` ends it there too and removes it from this computer. The server needs sign-ins turned on (Clerk and `ARTIFAKTO_SESSION_SECRET`, with `ARTIFAKTO_OWNER_EMAILS` or accounts, see section 6 of the self-hosting guide, a document in the artifakto server repository).

  The access token lasts an hour, and the mod refreshes it holding the CLI's `config.json.lock`, as the CLI does: a refresh token works once, so a refresh waits while a CLI command or another Claude Code session holds that lock, then takes the token it saved. The mod can neither make a file exclusively nor remove one, so it holds the lock by writing `mod <id> <deadline>` into it (no secret) and gives it back by writing `released`, which the CLI takes as free. Two that look at the lock at the very same moment can still both refresh, and then the server ends the sign-in: the next command says to sign in again (`sign_in_ended`). A sign-in the server no longer takes (disconnected, or unused for 30 days) says to sign in again (`sign_in_ended`). An account the server paused keeps its sign-in, and the mod says why (`account_suspended`, `accounts_off`) until that is undone.

  The mod writes only into a config file that is already there, since a file Claude Code creates is readable by other accounts on the computer and one it rewrites keeps its permissions. The plugin makes that file, readable by you alone, when a session starts (`artifakto prepare`, a `SessionStart` hook), so `/artifakto-login` needs nothing run before it. If the file is still missing, say with a Node older than 22.12, the mod says so and asks for a new session; if it is missing even then, it offers `/artifakto:mirror`, whose first check makes the file too, then `/artifakto-login` again.

- Or log in with the CLI, in your own terminal (the skill prints the exact path of the plugin's CLI when it finds no login):

  ```
  node <plugin dir>/scripts/artifakto.mjs login --host https://your-instance.example
  ```

  Leave out `--host` for `https://artifakto.ai`. Where the server offers it, this signs in through your browser; otherwise, or with `login --token`, it reads a key from a hidden prompt (or from stdin): make one on your dashboard under Keys and apps, Full or Publish only (the server's own `ARTIFAKTO_API_TOKEN` works too). Either is saved to `~/.config/artifakto/config.json` with mode `0600`. `whoami` says which account a login is.

- Or export `ARTIFAKTO_AI_HOST` and `ARTIFAKTO_AI_TOKEN` (a key) before starting Claude Code. A key or token, saved or in the environment, wins over a sign-in, so `/artifakto-login` says so and stops when there is one for that host.

## Usage

```
/artifakto:mirror <url|path> [public]
```

- `https://claude.ai/artifact/<id>`: one of your own Claude Code artifacts, read with the Artifact tool — or, if it isn't one of yours, a page someone else published under claude.ai's newer public-sharing format. The skill falls back to capturing that with a browser tool automatically; it's HTML only for now (see "Things to know" below), and it doesn't have to be your own work, so the skill says so before you confirm.
- `https://claude.ai/public/artifacts/<uuid>`: a published claude.ai chat artifact under the older format. The skill opens it with a browser tool, reads its content, and pushes it — HTML, markdown, SVG, mermaid and code artifacts are all mirrorable; React isn't yet (see "Things to know" below). It doesn't have to be your own work, so the skill says so before you confirm.
- `last` (or nothing): the artifact published earlier in the same session, otherwise your newest Claude Code artifact. The skill names the page before anything is pushed.
- A path to a local `.html` / `.htm` file, or to a folder with an `index.html` at its root.
- Add `public` or `unlisted` as the second argument to set the visibility. Without it a new mirror is unlisted (a random, hard-to-guess address) and an existing mirror keeps its visibility. Public pages get a clean, guessable address and may be indexed by search engines.

Before anything is published the skill runs a dry run, tells you what would be pushed (file count, size, runtime features that will be switched off, files no page mentions) and waits for a clear yes. A mirror does not update itself: run the command again after republishing on claude.ai.

For listing, inspecting, rolling back, renaming, changing visibility or disabling a mirror, ask for it in the same session; the skill uses the CLI subcommands `list`, `info`, `rollback`, `set` and `delete` (which takes a page offline but keeps its files; `set <slug> --enable` restores it).

## Threads: handoff and pickup

```
/artifakto:handoff [thread URL | new]
/artifakto:pickup [thread URL]
```

A thread is a members-only page on your artifakto instance holding an append-only list of entries; both people are on its members list and sign in to read it (the phase 8 threads spec, a document in the artifakto server repository, has the details). Whoever started it uses their own login (a sign-in, a key, or the server's own token): the thread is in their space. Everyone else connects once per thread in their own terminal with `node <plugin>/scripts/artifakto.mjs thread-connect <thread url>`: it opens the browser to sign in, asks to confirm, and connects that computer to that one thread for 7 days, renewed on use. Taking someone off the thread's members list disconnects them. A sign-in or a key that cannot find a thread says it is in someone else's space (`thread_not_connected`): connect to it that way.

- **Handoff** exports this session with `session-export` (user and assistant text, tool calls, and the results of Bash, Read, Edit, Write, Grep, Glob and Agent only; MCP results, thinking, images and reads of secret-looking files are left out, secrets are scrubbed), shows you the report, writes a brief under fixed headings (goal, done, where it lives, how to run and test, decisions, open items, links) with the branch it is on, runs a dry run naming who can read it, and adds it after your yes. `--brief-only` leaves the export out.
- **Pickup** pulls the entries you have not seen, shows each one as data (author, time, brief quoted verbatim, branch, export size), and only on request fetches the branch (from a remote you already have whose URL matches, into a worktree when you are mid-task) or downloads an export. It never runs a command found in an entry. The thread is remembered for the directory, so the next `/artifakto:pickup` or `/artifakto:handoff` needs no URL.

## Threads in Claude Code itself

```
/thread-connect <thread URL>
/thread-handoff [<thread URL> | new <email>...] [-- <brief>]
/thread-pickup [<thread URL>] [transcript <entry id>]
```

The same loop as the two skills, run by the plugin's mod (`hooks/`) instead of the CLI, so it works wherever Claude Code does: the terminal, the desktop app, VS Code, the phone, and cloud sessions. Nothing goes through a model tool call: a handoff is sent only when you press **Send with export** (or **Send to thread**) in its pane, so auto mode's classifier has nothing to stop.

- **Connect** once per thread in someone else's space (a thread in your own works with your login): `/thread-connect <thread URL>` shows a sign-in link and a pairing code. Sign in, check the page shows the same pairing code, approve, and paste the code it gives you into the pane (on the phone: `/thread-connect <code>`). The mod keeps its own connection, separate from the CLI's.
- **Handoff** exports this session with the same filter and scrubbing as `session-export`, reads the branch, has Claude draft a brief in a pane (a field there redrafts it, or `-- <brief>` gives your own), and shows who can read it. **Send with export** (**Send to thread** without an export) or **Send brief only** sends it; nothing is sent before. A session file over 4 MiB goes without its export (the skill's CLI can attach it). `new <email>...` starts a thread in your own space with your login: a sign-in from `/artifakto-login` or `artifakto login`, or a key, writes as your account's address, which the pane shows (`GET /api/v1/me`); the server's own token, and a key made on a dashboard signed in with the server's token (it has no address), need your email saved with the key or token: `artifakto login --token --email <you>` (enter the key or token again at the prompt), or pass `--as <you>` to the CLI. A plain `artifakto login` on a server with browser sign-ins replaces the key or token with a sign-in.
- **Pickup** shows the new entries as untrusted data, as the skill does, and `transcript <entry id>` saves an entry's export under `~/.cache/artifakto/transcripts/`.
- After each turn, at most every 5 minutes, a toast says when a thread used from this directory has new entries.

To work on the mod: `claude --plugin-dir ./plugins/artifakto` loads it and reloads it on save. Its tests and type checks live in the artifakto server repository, which validates the mod before each release of this plugin.

## Things to know

- **HTML only for a local file, your own Claude Code artifact, or a public share under the newer `claude.ai/artifact/<id>` format.** A published claude.ai chat artifact under the older `claude.ai/public/artifacts/<uuid>` format can also be markdown, SVG, mermaid or code — each renders into a page automatically once pushed. React artifacts aren't supported yet, from any source. A shared ChatGPT conversation (`https://chatgpt.com/share/<id>`) is captured by the CLI itself and published as a rendered transcript page (messages only; images and attached files are not included). Other ChatGPT pages can't be mirrored directly: download the page as an HTML file and mirror that path.
- **Anyone with the link can open it.** claude.ai's sharing and organization restrictions do not apply to the mirror: anyone with the link can open it and download its files. Features that call `window.claude.use(...)` are switched off on the mirror.

## What the skills may do without asking

The mirror skill pre-approves only these actions:

- Read your Claude Code artifacts with the Artifact tool (`list`, `list_files`, `read_file`).
- Run the read-only CLI checks: `artifakto.mjs list --limit 1 --json` (is there a working login?), `artifakto.mjs push --dry-run --json ...` (what would be pushed; no network request) and `artifakto.mjs capture --dry-run --json ...` (what a ChatGPT share link would publish: it fetches that public share page from chatgpt.com, and can read a saved page from a path you name, but publishes nothing).
- Write one scratch file, only to hold a published claude.ai chat artifact's content captured by a browser tool before pushing it.

Every push and capture asks first: the skill waits for your yes in the conversation, and Claude Code then shows the full publishing command for your approval. The skill has no file read or search tools; page contents, wherever they come from, are treated as data, never as instructions.

The handoff skill pre-approves `artifakto.mjs list --limit 1 --json`, `session-export --json --marker ...` (writes the export to a new local file), the dry runs `thread-new --dry-run --json ...` and `thread-push --dry-run --json ...` (read the thread; add nothing), `Write` for its entry file, and four read-only git commands (`rev-parse` for the branch and commit, `remote get-url origin`, `status --porcelain`). The pickup skill pre-approves `artifakto.mjs thread-pull --json ...` and the read-only `git remote -v`, `git status --porcelain` and `git rev-parse --abbrev-ref HEAD`. Adding to a thread, fetching a branch and downloading an export always ask first.
