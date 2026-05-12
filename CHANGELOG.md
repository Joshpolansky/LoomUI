# Changelog

All notable changes to the Loom VSCode extension.

## 0.1.0 — Initial preview release

- Activity-bar side panel with Modules, Scheduler, Bus, and I/O Mappings views, refreshed live over WebSocket.
- `Loom: Manage Modules…` webview for instance lifecycle (spawn, reload, save/load config, remove, upload).
- `Loom: Inspect Modules` debug session that surfaces every module in the Variables view with editable `config`/`recipe`/`runtime` and read-only `summary` trees.
- Runtime lifecycle commands: start, stop, restart, attach, native debug under CodeLLDB or Microsoft C/C++.
- `Loom: Install Loom Runtime…` downloads a release binary and configures `loom.runtimeExecutable` / `loom.systemModuleDir` automatically.
- `Loom: New Module Project…` scaffolds a CMake module template and registers Loom with CMake's user package registry.
- Bus service calls, scheduler class editing (period / priority / CPU affinity / spin), and I/O mapping add/toggle/resolve.
