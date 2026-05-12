import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

export function registerProjectCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('loom.modules.newProject', () => newModuleProject()),
  );
}

async function newModuleProject(): Promise<void> {
  // Pick parent directory.
  const parentUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Create module project here',
    title: 'Select parent folder for the new Loom module',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  if (!parentUris || parentUris.length === 0) return;
  const parentDir = parentUris[0].fsPath;

  // Project name (snake_case). Used as folder name AND .so basename.
  const snakeName = await vscode.window.showInputBox({
    prompt: 'Module project name (snake_case)',
    placeHolder: 'fan_controller',
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return 'name is required';
      if (!/^[a-z][a-z0-9_]*$/.test(t)) return 'lowercase letters, digits, and underscores; must start with a letter';
      const target = path.join(parentDir, t);
      if (fsSync.existsSync(target)) return `${target} already exists`;
      return null;
    },
  });
  if (!snakeName) return;

  const projectDir = path.join(parentDir, snakeName.trim());
  const className = snakeToCamel(snakeName.trim());

  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, '.vscode'),       { recursive: true });
  await fs.mkdir(path.join(projectDir, 'data'),          { recursive: true });
  await fs.mkdir(path.join(projectDir, 'output', 'modules'), { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(projectDir, 'CMakeLists.txt'),          CMAKELISTS_TPL(snakeName, className)),
    fs.writeFile(path.join(projectDir, `${snakeName}.hpp`),        HPP_TPL(className)),
    fs.writeFile(path.join(projectDir, `${snakeName}.cpp`),        CPP_TPL(snakeName, className)),
    fs.writeFile(path.join(projectDir, '.vscode/settings.json'),   SETTINGS_TPL),
    fs.writeFile(path.join(projectDir, '.vscode/tasks.json'),      TASKS_TPL),
    fs.writeFile(path.join(projectDir, '.vscode/launch.json'),     LAUNCH_TPL),
    fs.writeFile(path.join(projectDir, '.gitignore'),              GITIGNORE_TPL),
    fs.writeFile(path.join(projectDir, 'data', '.gitkeep'),        ''),
    fs.writeFile(path.join(projectDir, 'output', 'modules', '.gitkeep'), ''),
    fs.writeFile(path.join(projectDir, 'README.md'),               README_TPL(snakeName, className)),
  ]);

  const open = await vscode.window.showInformationMessage(
    `Created '${snakeName}' module project at ${projectDir}.`,
    'Open in New Window',
    'Open in This Window',
  );
  if (open) {
    const forceNew = open === 'Open in New Window';
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectDir), forceNew);
  }
}

function snakeToCamel(s: string): string {
  return s.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// ---------- templates ----------

const CMAKELISTS_TPL = (snake: string, klass: string) => `cmake_minimum_required(VERSION 3.18)
project(${snake} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# find_package(loom) works out of the box because the LoomUI extension
# registered the install with CMake's user package registry under
# ~/.cmake/packages/loom/ when you ran "Loom: Install Loom Runtime".
# If you ever need to override, set the LOOM_ROOT env var or pass
# -DCMAKE_PREFIX_PATH=<path-to-loom-install> to the configure step.
find_package(loom CONFIG REQUIRED)

add_library(${snake} MODULE ${snake}.cpp)
target_link_libraries(${snake} PRIVATE loom::sdk)

# Loom expects plugins as <name>.so on POSIX, <name>.dll on Windows, with
# no 'lib' prefix.
if(WIN32)
    set(LOOM_MODULE_SUFFIX ".dll")
else()
    set(LOOM_MODULE_SUFFIX ".so")
endif()

# Build the .so straight into <workspace>/output/modules/. That's where
# this project's .vscode/settings.json points loom.userModuleDir, so
# 'Loom: Start Runtime' picks the module up immediately and the runtime's
# module-watcher hot-reloads on every rebuild. No separate deploy step.
set_target_properties(${snake} PROPERTIES
    PREFIX ""
    SUFFIX "\${LOOM_MODULE_SUFFIX}"
    CXX_VISIBILITY_PRESET hidden
    LIBRARY_OUTPUT_DIRECTORY "\${CMAKE_SOURCE_DIR}/output/modules"
    RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_SOURCE_DIR}/output/modules"
)

# Multi-config generators (common on Windows) can otherwise append
# /Debug, /Release, etc. Keep all configs in output/modules/ so LoomUI's
# default loom.userModuleDir works consistently.
foreach(cfg Debug Release RelWithDebInfo MinSizeRel)
  string(TOUPPER "\${cfg}" cfg_upper)
  set_target_properties(${snake} PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY_\${cfg_upper} "\${CMAKE_SOURCE_DIR}/output/modules"
    RUNTIME_OUTPUT_DIRECTORY_\${cfg_upper} "\${CMAKE_SOURCE_DIR}/output/modules"
  )
endforeach()

# Class: ${klass}
`;

const HPP_TPL = (klass: string) => `#pragma once

#include <string>

// Plain C++23 aggregates. Glaze reflects them automatically — no macros.

struct ${klass}Config {
    int rate = 10;
    std::string label = "default";
};

struct ${klass}Recipe {
    double target_speed = 1.0;
};

struct ${klass}Runtime {
    double position = 0.0;
    bool fault = false;
};
`;

const CPP_TPL = (snake: string, klass: string) => `#include "${snake}.hpp"
#include <loom/module.h>
#include <loom/export.h>

class ${klass}Module : public loom::Module<${klass}Config, ${klass}Recipe, ${klass}Runtime> {
public:
    LOOM_MODULE_HEADER("${klass}Module", "0.1.0")

    void init(const loom::InitContext& /*ctx*/) override {
        // config_ is populated from disk before init().
        // Register your services here, e.g.:
        //
        //   registerLocalService("set_speed", [this](const SpeedCmd& cmd) -> loom::CallResult {
        //       recipe_.target_speed = cmd.speed;
        //       return {true, "{}", ""};
        //   });
    }

    void cyclic() override {
        // Runs every scheduler tick. Update runtime_ here.
        runtime_.position += 0.01;
    }

    void exit() override {
        // Cleanup before unload.
    }

    void longRunning() override {
        // Background thread — required to override even if unused.
    }
};

LOOM_REGISTER_MODULE(${klass}Module)
`;

const SETTINGS_TPL = `{
    "loom.userModuleDir": "\${workspaceFolder}/output/modules",
    "loom.dataDir":       "\${workspaceFolder}/data"
}
`;

const TASKS_TPL = `{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "loom: configure",
            "type": "shell",
            "command": "cmake",
            "args": [
                "-S", ".",
                "-B", "build",
                "-DCMAKE_BUILD_TYPE=Release"
            ],
            "problemMatcher": [],
            "group": "build"
        },
        {
            "label": "loom: build",
            "type": "shell",
            "command": "cmake",
            "args": ["--build", "build", "--config", "Release"],
            "dependsOn": "loom: configure",
            "problemMatcher": ["$gcc"],
            "group": {
                "kind": "build",
                "isDefault": true
            },
            "detail": "Build the module. CMake puts the .so/.dll into output/modules/ which the running Loom watches for hot-reload."
        }
    ]
}
`;

const LAUNCH_TPL = `{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Attach Loom (lldb)",
            "type": "lldb",
            "request": "attach",
            "pid": "\${command:pickProcess}",
            "preLaunchTask": "loom: build"
        }
    ]
}
`;

const GITIGNORE_TPL = `build/
.cache/
compile_commands.json
*.swp
.DS_Store

# Keep the data/ structure but ignore stuff written by the running runtime.
# Uncomment if you don't want to commit module configs:
# data/
`;

const README_TPL = (snake: string, klass: string) => `# ${snake}

A Loom module plugin generated by the LoomUI extension.

## Layout

\`\`\`
${snake}/
  CMakeLists.txt        ← find_package(loom) + builds the .so/.dll
  ${snake}.hpp          ← Config / Recipe / Runtime POD structs
  ${snake}.cpp          ← ${klass}Module class
  output/modules/       ← build lands here; runtime loads from here
  data/                 ← runtime persistence (configs, recipes, instances.json)
  .vscode/
    settings.json       ← pins loom.userModuleDir and loom.dataDir to this workspace
    tasks.json          ← loom: configure / loom: build
    launch.json         ← attach-by-pid debug
\`\`\`

## Build & run

1. \`Cmd/Ctrl+Shift+B\` (default build task) — runs \`loom: build\`. CMake
   drops the .so/.dll directly into \`output/modules/\`.
2. In the Loom side panel, click **Start Runtime** (or run \`Loom: Start Runtime\`).
   LoomUI starts loom with \`--module-dir output/modules --module-dir <install>/modules --data-dir data\`,
   so your module and the system examples both load.
3. Edit, save, rebuild — the runtime's module-watcher hot-reloads.

## CMake package resolution

\`find_package(loom)\` resolves automatically because the LoomUI extension
wrote an entry to CMake's per-user package registry when you installed
the runtime:

- macOS / Linux: \`~/.cmake/packages/loom/loom-workbench\`
- Windows: \`HKCU\\Software\\Kitware\\CMake\\Packages\\loom\\loom-workbench\`

To override (e.g. pin a specific install), set \`LOOM_ROOT\` or pass
\`-DCMAKE_PREFIX_PATH=<install>\` to the configure step.

## Files

- \`${snake}.hpp\` — the three POD structs (Config / Recipe / Runtime).
- \`${snake}.cpp\` — \`${klass}Module\` with init / cyclic / exit / longRunning hooks.
- \`CMakeLists.txt\` — finds the loom SDK and builds a MODULE library named
  \`${snake}.so\` (or \`.dll\` on Windows) directly into \`output/modules/\`.

## Next steps

1. Edit the structs in \`${snake}.hpp\` to model your module's state.
2. Implement the lifecycle hooks in \`${snake}.cpp\`. See
   [Loom/modules/](https://github.com/Joshpolansky/Loom/tree/main/modules)
   for working examples.
3. Build, start the runtime, and use **Loom: Manage Modules…** in the side
   panel to instantiate. Subsequent rebuilds hot-reload via the runtime's
   module watcher.
`;
