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
  await fs.mkdir(path.join(projectDir, '.vscode'), { recursive: true });

  await Promise.all([
    fs.writeFile(path.join(projectDir, 'CMakeLists.txt'),     CMAKELISTS_TPL(snakeName, className)),
    fs.writeFile(path.join(projectDir, `${snakeName}.hpp`),   HPP_TPL(className)),
    fs.writeFile(path.join(projectDir, `${snakeName}.cpp`),   CPP_TPL(snakeName, className)),
    fs.writeFile(path.join(projectDir, '.vscode/tasks.json'),  TASKS_TPL),
    fs.writeFile(path.join(projectDir, '.vscode/launch.json'), LAUNCH_TPL),
    fs.writeFile(path.join(projectDir, '.gitignore'),          GITIGNORE_TPL),
    fs.writeFile(path.join(projectDir, 'README.md'),           README_TPL(snakeName, className)),
  ]);

  // Ask whether to open in a new window or this one.
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

# Loom expects plugins as <name>.so on POSIX, <name>.dll on Windows, with no
# 'lib' prefix. Strip the prefix and force the right suffix.
if(WIN32)
    set(LOOM_MODULE_SUFFIX ".dll")
else()
    set(LOOM_MODULE_SUFFIX ".so")
endif()

set_target_properties(${snake} PROPERTIES
    PREFIX ""
    SUFFIX "\${LOOM_MODULE_SUFFIX}"
    CXX_VISIBILITY_PRESET hidden
)

# Used by the 'loom: deploy' task to copy the built plugin into the runtime's
# module directory. \`cmake --install build --prefix <loom-module-dir>\` will
# install the .so/.dll directly there.
install(TARGETS ${snake} LIBRARY DESTINATION ".")

# Suppress the trailing comment line warning.
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
            }
        },
        {
            "label": "loom: deploy",
            "type": "shell",
            "command": "cmake",
            "args": [
                "--install", "build",
                "--prefix", "\${config:loom.moduleDir}"
            ],
            "dependsOn": "loom: build",
            "problemMatcher": [],
            "detail": "Build the module then install it into loom.moduleDir, where the runtime's module-watcher will hot-reload it."
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
            "preLaunchTask": "loom: deploy"
        }
    ]
}
`;

const GITIGNORE_TPL = `build/
.cache/
compile_commands.json
*.swp
.DS_Store
`;

const README_TPL = (snake: string, klass: string) => `# ${snake}

A Loom module plugin generated by the LoomUI extension.

## Build

Two ways:

- \`Cmd/Ctrl+Shift+B\` (default build task) — runs \`loom: build\`.
- Tasks: Run Task… → \`loom: deploy\` — builds, then installs the .so/.dylib
  into \`loom.moduleDir\` so the runtime hot-reloads it.

\`find_package(loom)\` resolves automatically because the LoomUI extension
wrote an entry to CMake's per-user package registry when you installed
the runtime:

- macOS / Linux: \`~/.cmake/packages/loom/loomui\`
- Windows: \`HKCU\\Software\\Kitware\\CMake\\Packages\\loom\\loomui\`

To remove the registration (e.g. after uninstalling Loom), delete that
file or registry value. CMake also accepts \`LOOM_ROOT\` or
\`-DCMAKE_PREFIX_PATH=<install>\` if you'd rather pin a specific install.

## Files

- \`${snake}.hpp\` — the three POD structs (Config / Recipe / Runtime).
- \`${snake}.cpp\` — the \`${klass}Module\` class with init/cyclic/exit hooks.
- \`CMakeLists.txt\` — finds the loom SDK, builds a MODULE library named
  \`${snake}.so\` (or \`.dll\` on Windows), and supplies an install rule that
  copies the artifact when \`cmake --install\` is invoked.

## Next steps

1. Edit the structs in \`${snake}.hpp\` to model your module's state.
2. Implement the lifecycle hooks in \`${snake}.cpp\`. See
   [Loom/modules/](https://github.com/Joshpolansky/Loom/tree/main/modules)
   for working examples.
3. Build and deploy. In the Loom side panel, **Loom: Instantiate Module…**
   creates a new instance from your freshly built \`.so\`. Subsequent
   rebuilds will hot-reload via the runtime's module watcher.
`;
