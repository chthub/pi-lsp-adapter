# pi-lsp-adapter

Language-server intelligence for [Pi](https://github.com/earendil-works/pi) agents: diagnostics, hover/type info, definitions, references, and symbol search on demand.

`pi-lsp-adapter` gives Pi a small set of read-only LSP tools without turning startup into an IDE boot. Language servers are lazy at session startup, installed servers can be warmed in the background when Pi reads source files, managed installs are isolated under Pi's runtime directory, and large LSP responses are paginated through a short-lived cache so they do not flood the context window.

## Why this exists

Agents make better edits when they can ask semantic questions instead of guessing from text search alone:

- _What type is this symbol?_
- _Where is this function defined?_
- _What references will this change affect?_
- _Did the language server report a type or lint error?_

LSP already answers those questions. This extension makes those answers available to Pi as compact, read-only tools. It starts servers only when needed, keeps missing-server installs explicit by default, and returns the first useful page instead of dumping thousands of references into the model.

## Compatibility

This fork is tested with **Pi 1.1.0** and uses its structured `before_agent_start.systemPromptOptions.sections` API. Older Pi versions without that API are not supported; there is deliberately no whole-prompt replacement fallback. Development dependencies pin the Pi SDK to 1.1.0 so typechecks and offline regression tests use the target API.

The four imported host libraries (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) are wildcard peers, not runtime dependencies. Pi supplies them when loading the extension; development copies are not bundled in the package.

## Install

This is [chthub's fork](https://github.com/chthub/pi-lsp-adapter) of [Nikmmd's original adapter](https://github.com/nikmmd/pi-lsp-adapter). It is not published to the upstream npm package. Install the fork from git:

```bash
pi install git:github.com/chthub/pi-lsp-adapter
```

For reproducibility, append `@<commit-or-tag>` to the git source. The upstream `npm:pi-lsp-adapter` source does not include this fork's fixes.

Before switching, back up your Pi settings and replace the old adapter package entry rather than loading both copies. Keep the old package source for rollback; do not delete LSP configuration, server installs, or session history. If several launch profiles share the same settings file, switching that file changes all of them.

Restart Pi after installation, then check the extension:

```text
/lsp status
```

For local development from a checkout:

```bash
git clone https://github.com/chthub/pi-lsp-adapter.git
cd pi-lsp-adapter
npm ci
# Isolate this trial from installed extensions, including the upstream adapter.
pi --no-extensions -e "$PWD"
```

The default install mode is `prompt`: agent tool calls will not silently install missing language servers. Install servers explicitly with `/lsp install <serverId>`, or set `installMode` to `auto` if you want first-use installation.

## What happens on first use

| You do this                                            | What happens                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Run `/lsp` in an interactive Pi session                | Pi opens a compact LSP panel showing configured servers, install state, tracked processes, and config warnings.                                 |
| Run `/lsp status`                                      | Pi prints the same status as text.                                                                                                              |
| Run `/lsp install pyright`                             | The server is installed under `~/.pi/agent/lsp/`, and the resolved command is recorded in Pi's LSP lockfile.                                    |
| Read a supported source file with Pi's `read` tool     | If `warmup` is enabled, the matching installed server is started in the background. Missing servers are ignored.                                |
| Ask for diagnostics/hover/definitions on a source file | The extension detects the filetype and project root, reuses a warmed server or starts the matching server if needed, then runs the LSP request. |
| Query many references or symbols                       | The first ranked page is returned immediately. If more pages exist, the result includes a `resultId` for `lsp_more`.                            |
| Configure a Mason/Nix/system binary                    | Pi uses that command but does not own, update, or uninstall it. Use global config for executable overrides.                                     |

## Quick start

```text
/lsp status
/lsp install vtsls
```

Then ask Pi something that benefits from semantic context:

```text
Check diagnostics for src/index.ts, then use hover on the exported function before editing it.
```

Useful first commands:

```text
/lsp doctor vtsls
/lsp install pyright
/lsp start
```

## Tools

The extension registers these read-only tools:

| Tool                    | Use it for                                            | Required input                                                  |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `lsp_diagnostics`       | Compiler/type/lint diagnostics for one file           | `filePath`                                                      |
| `lsp_hover`             | Type, signature, and documentation at a position      | `filePath`, 1-based `line`, exactly one of `column` or `symbol` |
| `lsp_definition`        | Definition locations for a symbol                     | `filePath`, 1-based `line`, exactly one of `column` or `symbol` |
| `lsp_references`        | Reference locations for a symbol                      | `filePath`, 1-based `line`, exactly one of `column` or `symbol` |
| `lsp_document_symbols`  | Classes, functions, variables, and other file symbols | `filePath`                                                      |
| `lsp_workspace_symbols` | Symbol search across active or selected workspaces    | `query`; optional `serverId`                                    |
| `lsp_more`              | Next page from a cached multi-page LSP result         | Exact `resultId` returned by a previous paginated call          |

Examples:

```text
lsp_diagnostics({ filePath: "src/index.ts" })
```

```text
lsp_hover({ filePath: "src/index.ts", line: 42, column: 13 })
```

```text
lsp_workspace_symbols({ query: "RuntimeManager", serverId: "vtsls" })
```

Line and column inputs are 1-based integers; columns count UTF-16 code units, not display width. Put an explicit column on the identifier token itself rather than on whitespace or an import path string. Alternatively, let the tool compute the column:

```text
lsp_definition({ filePath: "src/model.ts", line: 120, symbol: "fit" })
lsp_references({ filePath: "src/model.ts", line: 120, symbol: "fit", includeDeclaration: true })
```

Provide **exactly one** of `column` or `symbol`. A symbol must be a single identifier (at most 256 Unicode characters), not `object.fit`, an expression, or a regex. Lookup is limited to that line in the same source snapshot used for validation and synchronization. Boundaries include Unicode, `_`, and `$`; tabs and non-BMP characters retain their UTF-16 offsets. Successful results include `resolvedPosition` and, for symbol input, `selector` in details.

Multiple lexical matches produce `ambiguous-symbol` with at most 32 candidate coordinates; none produces `symbol-not-found`. Retry with an explicit candidate column rather than expecting the tool to pick the first match. Comments and strings are not parsed out: matching text there can cause ambiguity. This does not repair wrong line numbers or prove a lexical match is the intended semantic symbol. The client advertises UTF-16 only and rejects a server that selects another encoding.

Pi 1.1.0 truncates fractional inputs for TypeBox `Integer` schemas. Position schemas therefore use `number` with `multipleOf: 1` and `minimum: 1`, preserving the integer-only contract without silently moving fractional coordinates. The adapter itself never clamps or truncates positions.

### Failures and recovery

Execution/input failures return `isError: true` and `details.ok: false`. Details include `category`, `retryable`, and `recovery`; category and recovery advice also appear in model-facing text. `retryable` means an **unchanged** query might work later, not that future queries are forbidden. Timeouts and exited servers can be retried; invalid coordinates need corrected arguments, and missing servers need explicit installation. Categories come from typed errors at their source (including filesystem errno), not guesses from text. Unclassified exceptions use `unknown`; output omits stacks and bounds exception summaries.

Empty definitions/references and exhausted pagination are successful results. Invalid/expired `lsp_more` IDs are failures: rerun the original query for a new ID. No automatic installation, retry, position correction, or edit is added.

Local coordinate validation runs before starting a server. Column overflow shows the target line and up to two actual lines on either side. Beyond EOF, output explicitly labels the final five available lines as the file end. LF, CRLF, and CR have identical counting; an empty document has one empty line, and a final newline creates a final empty line. Negative/fractional positions are rejected, not clamped. Source excerpts are at most 2 KiB UTF-8, with a 320-byte source-text limit per line and explicit truncation markers, without splitting Unicode characters. Workspace/permission failures do not supply source context; symlinks resolving outside the workspace are refused.

Synthetic example (all five lines are real contents from the synthetic snapshot):

```text
lsp_definition failed [invalid-position]: column 40 was requested on line 12, but the maximum column is 27
Current source context (1-based lines 10-14):
10 | def predict(data):
11 |     prepared = normalize(data)
12 |     result = fit(prepared)
13 |     validate(result)
14 |     return result
Unchanged retry may help: no. Locate the intended symbol in this source before retrying with valid 1-based coordinates.
```

These tools have no output schema: Pi's codemode receives text on success and **rejects** with the complete feedback text on failure. `Promise.allSettled()` can capture it. Catching a failure can let the enclosing script complete successfully, but the nested LSP call remains recorded as an error; script completion alone does not mean the query succeeded.

### Diagnostic snapshot status

`lsp_diagnostics` still accepts only `filePath`. Text and details identify status, queried `targetVersion`, synchronized `currentVersion`, optional `publicationVersion`, and return-time `diskCheck`. Details also retain `received`, accepted publication `sequence`/`arrivedAt`, and `knownPublicationVersion` when available.

| Status       | Meaning                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`    | No usable publication arrived within the budget: not ready, not clean.                                                                |
| `fresh`      | Publication version matches the immutable queried version, with no known sibling-version drift and a matching return-time disk check. |
| `stale`      | Publication version differs, or the target changed during the query; displayed results are not current.                               |
| `unverified` | Publication has no version, or disk consistency could not be checked; current-source attribution is not confirmed.                    |

A received empty snapshot differs from never receiving a publication. Even fresh empty results only mean **that document version's publication was empty**, not that every dependency/project check finished or passed. A disk check observes return-time content; it does not lock against future edits. These incomplete states are successful executions with `details.ok: true`; startup/communication failures remain errors.

Internal `diagnosticsWaitMs` is a bounded budget (still 350 ms by default), not an unconditional sleep. Matching cached results and no-version publications can return immediately. Cancellation, shutdown/session replacement, and server exit settle waits and clean timers/listeners. Calls share servers and capture versions independently. Positional synchronization/request sequences are serialized per file against sibling read warmup; diagnostic waits do not block newer versions.

Older out-of-order versioned publications cannot replace newer evidence. The latest accepted no-version publication is displayed as `unverified`, retaining versioned evidence separately. Arrival after `didChange` alone never implies freshness. Restarted clients have separate caches.

Diagnostic pagination retains the **original query snapshot's** status/evidence on every page. `lsp_more` does not recheck disk or relabel that snapshot as current. Schemas/descriptions remain static, but upgrading their definitions can change request prefixes and affect context/cache reuse; this is not a zero-cost interface change.

## Supported servers

Built-in catalog entries currently include:

| Server          | Languages/filetypes              | Managed installer |
| --------------- | -------------------------------- | ----------------- |
| `vtsls`         | JavaScript, JSX, TypeScript, TSX | npm               |
| `pyright`       | Python                           | npm               |
| `gopls`         | Go                               | go                |
| `rust-analyzer` | Rust                             | GitHub release    |
| `yamlls`        | YAML                             | npm               |
| `jsonls`        | JSON, JSONC                      | npm               |
| `jdtls`         | Java                             | GitHub release    |

You can override these definitions or add new server definitions in config.

## Configuration

Most users only need one file:

```text
~/.pi/agent/lsp.json
```

If that file does not exist, the extension behaves as if this config were present:

```json
{
  "installMode": "prompt",
  "warmup": true,
  "servers": {}
}
```

`servers: {}` means "use the built-in server catalog unchanged". Add entries only when you want to override a built-in server or define a new one.

### Config files and merge order

| Priority | Path                   | Purpose                                                                                                          |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1        | built-in catalog       | Default server definitions for `vtsls`, `pyright`, `gopls`, `rust-analyzer`, `yamlls`, etc.                      |
| 2        | `~/.pi/agent/lsp.json` | User-global config. Best place for executable, install, PATH, `installMode`, and `warmup`.                       |
| 3        | `.pi/lsp.json`         | Project-local config. Safe server fields are honored before trust; process-starting fields require `/lsp trust`. |

> Path gotcha: config is the file `~/.pi/agent/lsp.json`. Runtime state lives under the directory `~/.pi/agent/lsp/`.

### Runtime paths

Do not edit these by hand unless you are debugging or cleaning up state:

| Path                            | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `~/.pi/agent/lsp/packages/`     | Pi-managed language-server installs                        |
| `~/.pi/agent/lsp/bin/`          | Pi-managed executable links                                |
| `~/.pi/agent/lsp/lsp.lock.json` | Resolved managed install metadata                          |
| `~/.pi/agent/lsp/logs/`         | Language-server logs                                       |
| `~/.pi/agent/lsp/pids/`         | Per-session process registries used for lifecycle cleanup  |
| `~/.pi/agent/lsp/workspaces/`   | Per-server workspaces, for example JDT LS data directories |
| `~/.pi/agent/lsp/cache/`        | Runtime caches owned by the extension                      |

Do not put extension source code under `~/.pi/agent/lsp/`; that directory is only for runtime state.

### Top-level config fields

| Field         | Default    | Behavior                                                                                       |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `installMode` | `"prompt"` | Missing servers are installed only when explicitly requested or interactively confirmed.       |
| `warmup`      | `true`     | Pi `read` calls for supported source files start matching installed servers in the background. |
| `servers`     | `{}`       | Per-server overrides merged into the built-in catalog.                                         |

`installMode` can be:

| Mode     | Behavior                                                                    |
| -------- | --------------------------------------------------------------------------- |
| `prompt` | Install only when explicitly requested or interactively confirmed.          |
| `auto`   | Install missing servers automatically when an LSP tool needs them.          |
| `off`    | Never install automatically. Use system commands or explicit installs only. |

`warmup` never prompts and never installs missing servers. It only prepares already-installed servers after Pi reads a matching source file. `lazy` still means servers do not start at session startup.

### Common config snippets

Disable read warmup:

```json
{
  "warmup": false
}
```

Auto-install missing servers on first explicit LSP tool use:

```json
{
  "installMode": "auto"
}
```

Tune Pyright analysis from project config without changing executables:

```json
{
  "servers": {
    "pyright": {
      "settings": {
        "python": {
          "analysis": {
            "diagnosticMode": "workspace"
          }
        }
      }
    }
  }
}
```

### Server override fields

A server definition can include:

| Field                   | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `displayName`           | Human-readable name shown in status output                  |
| `filetypes`             | Filetypes handled by the server                             |
| `rootMarkers`           | Files/directories used to detect the project root           |
| `install`               | Managed install spec: `npm`, `go`, `github`, or `system`    |
| `command`               | Command used to start the language server                   |
| `cwd`                   | Working directory for the server command                    |
| `env`                   | Environment overrides; supports `$env:VAR` references       |
| `settings`              | LSP settings returned through `workspace/configuration`     |
| `initializationOptions` | LSP initialization options                                  |
| `lazy`                  | Whether the server should avoid session-start eager startup |

`command` supports placeholders such as `{installBin}`, `{installDir}`, `{platform}`, and `{workspaceDir}`. Relative path-like values are resolved from the detected project root, and `~` is expanded.

Project config is intentionally conservative. In untrusted projects, executable and install overrides are ignored; put those in global config.

## Using existing LSP binaries

You do not need Pi to manage every language server. If you already have servers installed through Mason.nvim, your distro, Nix, mise/asdf, or another tool, point `pi-lsp-adapter` at those binaries with global config.

Prefer global config for executable overrides:

```text
~/.pi/agent/lsp.json
```

Example: use Mason.nvim's Pyright:

```json
{
  "servers": {
    "pyright": {
      "install": {
        "type": "system",
        "command": ["~/.local/share/nvim/mason/bin/pyright-langserver", "--stdio"]
      }
    }
  }
}
```

For `type: "system"`, `command` is inferred from `install.command` when omitted.

Example: use a binary already on `PATH`:

```json
{
  "servers": {
    "gopls": {
      "install": {
        "type": "system",
        "command": ["gopls"]
      }
    }
  }
}
```

## Managed install overrides

Use `install` without `type: "system"` when you want Pi to own the install lifecycle. In `prompt` mode, the server is still missing until you run `/lsp install <serverId>`. The resolved install metadata is then written to `~/.pi/agent/lsp/lsp.lock.json`.

Pin a managed npm server version:

```json
{
  "servers": {
    "pyright": {
      "install": {
        "type": "npm",
        "packages": {
          "pyright": "1.1.410"
        },
        "bin": "pyright-langserver"
      }
    }
  }
}
```

Pin a managed GitHub release server:

```json
{
  "servers": {
    "rust-analyzer": {
      "install": {
        "type": "github",
        "repo": "rust-lang/rust-analyzer",
        "version": "2026-05-25",
        "asset": "rust-analyzer-{platform}.gz",
        "bin": "rust-analyzer"
      }
    }
  }
}
```

Add a custom GitHub-release server:

```json
{
  "servers": {
    "example-ls": {
      "displayName": "Example Language Server",
      "filetypes": ["example"],
      "rootMarkers": [".git"],
      "install": {
        "type": "github",
        "repo": "example/example-ls",
        "version": "v1.2.3",
        "asset": "example-ls-linux-x64.tar.gz",
        "bin": "example-ls",
        "stripComponents": 1
      },
      "command": ["{installBin}/example-ls", "--stdio"],
      "settings": {},
      "initializationOptions": {},
      "lazy": true
    }
  }
}
```

Why configure this explicitly instead of symlinking Mason into Pi's managed directory?

- Ownership stays clear: Mason owns Mason installs; Pi owns `~/.pi/agent/lsp/`.
- `/lsp uninstall <serverId>` will not remove external binaries.
- `/lsp doctor <serverId>` can show the configured command directly.
- Broken or stale symlinks are avoided.

## Caching and pagination

List-like LSP tools return a first page instead of dumping every result into context. When more results exist, output includes a `resultId`:

```text
Showing 1-25 of 143.
More available: call lsp_more with resultId: lspres_...
```

Fetch the next page with:

```text
lsp_more({ resultId: "lspres_..." })
```

Cache behavior:

- Only multi-page results are cached.
- Pages are returned sequentially by `lsp_more`.
- Result IDs are session-local and in memory only.
- Cache budget defaults to 64 MB and 128 entries.
- Entries expire after 15 minutes of inactivity.
- Cache is cleared on reload, shutdown, and session replacement.
- Tool result details contain only the shown page, not the full result set.

## Commands

| Command                             | What it does                                                      |
| ----------------------------------- | ----------------------------------------------------------------- |
| `/lsp`                              | Open the interactive LSP panel, or show status in non-UI sessions |
| `/lsp status`                       | Print status as text                                              |
| `/lsp doctor`                       | Show config warnings and server details                           |
| `/lsp doctor <serverId>`            | Show resolved details for one server                              |
| `/lsp install <serverId[@version]>` | Install a managed language server                                 |
| `/lsp update <serverId[@version]>`  | Update/reinstall one managed server                               |
| `/lsp update --all`                 | Update all configured managed servers                             |
| `/lsp uninstall <serverId>`         | Remove Pi-managed install state and stop matching processes       |
| `/lsp start [serverId]`             | Start one installed server or all installed servers               |
| `/lsp restart [serverId]`           | Restart one installed server or all installed servers             |
| `/lsp stop [serverId]`              | Stop tracked LSP processes                                        |

Interactive `/lsp` panel keys:

```text
↑↓ select • enter doctor • i install • u update • x uninstall • s stop • r refresh • esc close
```

## How it works

- The extension adds read-only LSP tools and stable guidance in the named `lsp_integration` prompt section after successful session initialization.
- It neither returns a complete `systemPrompt` nor sets `forceSystemPrompt`. Pi can therefore retain native prompt/tool deltas, including dynamically enabled tools at their historical position, on transports that support them.
- Transports without dynamic tool declarations still use Pi's full-tool compatibility fallback. Other extensions that force a complete system prompt can still collapse request history; this fix is not a guarantee of prompt-cache hits.
- File requests are resolved by filetype and nearest project root marker.
- Server definitions come from the built-in catalog plus global/project config.
- Missing-server behavior follows `installMode`; read warmup never installs missing servers.
- Servers start lazily over stdio and are tracked in a process registry.
- When `warmup` is enabled, source-file reads can prepare installed servers in the background before an LSP tool call.
- LSP responses are normalized into compact text plus structured details.
- Diagnostics, locations, and symbols are sorted/paged before reaching the model.
- Extra pages are stored in the in-memory result cache and fetched with `lsp_more`.
- The Pi status line shows active LSP servers, total configured servers, and warning count.

## Development

Use Node.js 22.19.0 or newer and install the locked development dependencies with `npm ci`.

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
```

Tests are offline: they initialize the adapter in temporary directories, load it through Pi's real extension loader/runner, and exercise Pi's actual prompt projection and transcript tool resolution with synthetic history. They cover additive transports, the independent unsupported-additions fallback, and the old forced-prompt behavior as a positive control. No model requests or real language-server installs are needed.

For persistent local development, replace the old adapter entry in the `packages` array of your Pi settings with the checkout's absolute path (or a path relative to the settings file). Install dependencies in that checkout first. Do not also register it through an extensions symlink or retain the npm copy.

Run `/reload` after source edits. Updating Pi itself requires restarting with the new executable; `/reload` only reloads extensions. Restore the old source entry to roll back.

## Release policy

This fork is distributed through git or a local checkout. Its manifest is `private: true` to block accidental npm publication under the upstream name. The retained upstream publish workflow is guarded to run only in `nikmmd/pi-lsp-adapter`, including manual dispatch, and is disabled in forks. Do not configure publishing credentials for this fork. Any future npm release requires a separate package name and an explicitly reviewed release process.

## Troubleshooting

### `server is not installed`

Install it explicitly:

```text
/lsp install <serverId>
```

Or set global config to auto-install:

```json
{
  "installMode": "auto"
}
```

### Check the resolved command

```text
/lsp doctor <serverId>
```

This is the quickest way to see the final command, root markers, install state, and config warnings for one server.

### Reuse Mason.nvim servers

Configure the server as `type: "system"` in `~/.pi/agent/lsp.json` and point `command` at the Mason binary. Pi will use it but will not manage or uninstall it.

### Start fresh for one server

```text
/lsp stop <serverId>
/lsp uninstall <serverId>
/lsp install <serverId>
```

This only removes Pi-managed install state. It does not remove external system/Mason binaries configured with `type: "system"`.

## Limitations

- Tools are read-only. Rename, code action, and formatting support are intentionally not exposed yet.
- A language server must support the requested LSP capability for the matching tool to return data.
- First explicit LSP use can still be slower while a server starts, initializes, or installs, especially when warmup is disabled or the server was not installed when the file was read.
- `lsp_workspace_symbols` searches active clients by default; pass `serverId` to start/query a specific configured server.
- Pagination result IDs are not persistent and can expire. Re-run the original LSP query if `lsp_more` says the cached result is gone.

## License

[MIT](LICENSE) © 2026 pi-lsp-adapter developers. Original author: Nikmmd. Fork changes retain the original attribution and license.
