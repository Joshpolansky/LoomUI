# LoomUI

A VSCode extension for working with the [Loom](../Loom) runtime: a side-panel module browser, lifecycle commands, and a native debug launcher — all wired to Loom's REST/WebSocket API.

## Features

- **Modules side panel** — tree of loaded modules grouped by state (Running / Initialized / Loaded / Error / …) with per-module cycle time and overrun count, refreshed live over WebSocket. Click a module to open it in the inspector.
- **Module Management webview** — `Loom: Manage Modules…` opens a tabbed UI for instance lifecycle: spawn from any available `.so`/`.dylib`, hot-reload, save/load config to disk, remove, or upload a freshly built module. Live cycle stats per row.
- **Inspect Modules debug session** — `Loom: Inspect Modules` starts a custom debug session that surfaces every module in VSCode's standard **Variables** panel. A single auto-expanded `Modules` scope shows every instance; expanding a module reveals `config`, `recipe`, `runtime`, and `summary` trees. Right-click any editable leaf → `Loom: Set Value…` for a modal edit (avoids the inline-edit / live-tick race). All module details are prefetched on attach so expansion is instant. `summary` is read-only.
- **Scheduler side panel** — scheduler classes with period, priority, last cycle time, and tick count; expand a class to see its assigned modules.
- **Bus side panel** — registered RPC services and active pub/sub topics. Click a service to call it with a JSON request body.
- **Runtime lifecycle** — start, stop, restart, or attach to the `loom` binary directly from the activity bar; output streams to a `Loom Runtime` channel. Status bar shows connection state and toggles on click.
- **Native debug** — `Loom: Debug Runtime (Native)` launches the binary under CodeLLDB or the Microsoft C/C++ debugger so you can hit breakpoints in module code.
- **Live module debugging** — context-menu actions to reload modules, save/load config, instantiate from `.so` files, and call bus services.

> Oscilloscope probes and IO mappings are planned for subsequent phases (see [Roadmap](#roadmap)).

## Requirements

- VSCode ≥ 1.90
- Node 18+ (for development)
- A built Loom runtime (`Loom/output/loom`) — see [`../Loom/README.md`](../Loom/README.md)
- One of (only required if you use `Loom: Debug Runtime (Native)`):
  - [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) (default; recommended on macOS)
  - [Microsoft C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)

## Development

```bash
npm install        # one-time
npm run build      # bundle to out/extension.js
npm run watch      # bundle in watch mode
npm run typecheck  # tsc --noEmit
```

To try the extension, open `LoomUI/` in VSCode and press **F5** — a new Extension Development Host window opens with the Loom icon in the activity bar.

## Default paths

With `LoomUI/` opened as the workspace, paths resolve relative to a sibling `Loom/`:

| Setting | Default | Resolves to |
| --- | --- | --- |
| `loom.repoPath` | `${workspaceFolder}/../Loom` | `…/loom/Loom` |
| `loom.runtimeExecutable` | *(empty)* → `${repoPath}/output/loom` | `…/Loom/output/loom` |
| `loom.moduleDir` | *(empty)* → `${repoPath}/output/modules` | `…/Loom/output/modules` |
| `loom.dataDir` | *(empty)* → `${repoPath}/data` | `…/Loom/data` |

Override any setting in your User or Workspace settings to point elsewhere — explicit paths win.

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `loom.serverUrl` | `http://localhost:8080` | REST/WebSocket endpoint of the running runtime. |
| `loom.repoPath` | `${workspaceFolder}/../Loom` | Used to derive the three paths below when they're empty. |
| `loom.runtimeExecutable` | *(empty)* | Absolute path to the `loom` binary. |
| `loom.moduleDir` | *(empty)* | `.so`/`.dylib` plugin directory. |
| `loom.dataDir` | *(empty)* | Config/recipe persistence directory. |
| `loom.port` | `8080` | Port the runtime binds to when started by the extension. |
| `loom.bindAddress` | `0.0.0.0` | Address the runtime binds to. |
| `loom.debugAdapter` | `lldb` | `lldb` (CodeLLDB) or `cppdbg` (Microsoft C/C++). |
| `loom.pollIntervalMs` | `5000` | REST poll cadence for the module list (also throttles scheduler/bus polls to 2× this). Live cycle stats arrive over WebSocket between polls. |

## Commands

All commands are available from the palette under the `Loom:` prefix.

**Runtime**
- `Loom: Start Runtime`
- `Loom: Stop Runtime`
- `Loom: Restart Runtime`
- `Loom: Debug Runtime (Native)` — launch under lldb/cppdbg
- `Loom: Connect to Runtime…` — change `serverUrl`

**Modules**
- `Loom: Manage Modules…` — opens the management webview (instances, available `.so`s, upload)
- `Loom: Inspect Modules (Debug Session)` — opens the Variables view with every module's data as editable nested variables
- `Loom: Refresh Modules`
- `Loom: Instantiate Module…`
- `Loom: Upload Module…`
- `Loom: Reload Module` (right-click)
- `Loom: Remove Module` (right-click)
- `Loom: Save Module Config` / `Loom: Load Module Config from Disk` (right-click)

**Bus**
- `Loom: Call Bus Service…` — pick service, send JSON, response logs to the `Loom` output channel

## Roadmap

- **Phase 1** — REST-driven Modules tree, runtime lifecycle, native debug, live debug commands. ✓
- **Phase 2** — WebSocket live updates, Scheduler & Bus tree views. ✓
- **Phase 3 (current)** — DAP-based module inspector exposing `config`/`recipe`/`runtime`/`summary` as editable variables in VSCode's standard Variables view.
- **Phase 4** — Oscilloscope probes, IO mappings, recipe browser.

## License

Same as the Loom project.
