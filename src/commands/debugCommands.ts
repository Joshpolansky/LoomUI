import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolvePaths, port as cfgPort, bindAddress as cfgBind } from '../util/paths';

export function registerDebugCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('loom.runtime.debug', debugRuntime),
  );
}

async function debugRuntime(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('loom');
  const adapter = cfg.get<string>('debugAdapter', 'lldb');
  const { runtimeExecutable, moduleDir, dataDir, repoPath } = resolvePaths();

  if (!fs.existsSync(runtimeExecutable)) {
    vscode.window.showErrorMessage(
      `Loom runtime not found at ${runtimeExecutable}. Build it first or set 'loom.runtimeExecutable'.`,
    );
    return;
  }

  const wantedExt = adapter === 'lldb' ? 'vadimcn.vscode-lldb' : 'ms-vscode.cpptools';
  if (!vscode.extensions.getExtension(wantedExt)) {
    const install = await vscode.window.showErrorMessage(
      `'${wantedExt}' is required for debugAdapter='${adapter}'. Install it now?`,
      'Open Marketplace',
    );
    if (install === 'Open Marketplace') {
      await vscode.commands.executeCommand('workbench.extensions.search', wantedExt);
    }
    return;
  }

  const args = [
    '--module-dir', moduleDir,
    '--data-dir',   dataDir,
    '--port',       String(cfgPort()),
    '--bind',       cfgBind(),
  ];

  const config: vscode.DebugConfiguration = adapter === 'lldb'
    ? {
        type: 'lldb',
        request: 'launch',
        name: 'Loom Runtime',
        program: runtimeExecutable,
        args,
        cwd: repoPath,
      }
    : {
        type: 'cppdbg',
        request: 'launch',
        name: 'Loom Runtime',
        program: runtimeExecutable,
        args,
        cwd: repoPath,
        MIMode: process.platform === 'darwin' ? 'lldb' : 'gdb',
      };

  const ok = await vscode.debug.startDebugging(ws, config);
  if (!ok) {
    vscode.window.showErrorMessage(
      'Failed to launch Loom runtime under the debugger. See the Debug Console for details.',
    );
  }
}
