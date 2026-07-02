# Changelog

All notable changes to the Loom VSCode extension.

## 0.2.0 — System metrics readout + watch window

- **System metrics** (needs a runtime with `GET /api/system`): the status bar's
  Loom item shows a live memory/CPU readout (`… · 65.0 MB · 2.0%`) for whatever
  runtime `loom.serverUrl` points at — externally-launched runtimes included.
  Tooltip carries peak RSS, uptime, and the server URL. `Loom: Open System
  Metrics` (also on the Modules view toolbar and the status bar tooltip) opens
  a panel charting memory and CPU over the runtime's ~10-minute sample history.
  Against older runtimes the readout simply doesn't appear.
- **`Loom: Open Watch Window`**: a table-style watch panel — add individual
  scalar fields or whole structures from any module section, watch them update
  live over OPC-UA, and edit values inline with a double-click.

# 0.1.5 - Allow users to select loom runtime build version
        - Move to subscription based reading for debugging

## 0.1.0 — Initial preview release

- Activity-bar side panel with Modules, Scheduler, Bus, and I/O Mappings views, refreshed live over WebSocket.
- `Loom: Manage Modules…` webview for instance lifecycle (spawn, reload, save/load config, remove, upload).
- `Loom: Inspect Modules` debug session that surfaces every module in the Variables view with editable `config`/`recipe`/`runtime` and read-only `summary` trees.
- Runtime lifecycle commands: start, stop, restart, attach, native debug under CodeLLDB or Microsoft C/C++.
- `Loom: Install Loom Runtime…` downloads a release binary and configures `loom.runtimeExecutable` / `loom.systemModuleDir` automatically.
- `Loom: New Module Project…` scaffolds a CMake module template and registers Loom with CMake's user package registry.
- Bus service calls, scheduler class editing (period / priority / CPU affinity / spin), and I/O mapping add/toggle/resolve.
