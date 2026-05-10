import * as vscode from 'vscode';
import { LoomClient } from './api/client';
import { ModulesProvider } from './views/modulesView';
import { PlaceholderProvider } from './views/placeholderView';
import { RuntimeProcess } from './runtime/runtimeProcess';
import { registerRuntimeCommands } from './commands/runtimeCommands';
import { registerModuleCommands } from './commands/moduleCommands';
import { registerDebugCommands } from './commands/debugCommands';
import { serverUrl, port as cfgPort } from './util/paths';
import { disposeOutputs, getExtensionOutput } from './util/output';

export function activate(context: vscode.ExtensionContext): void {
  const client = new LoomClient(serverUrl);
  const runtime = new RuntimeProcess();
  const modulesProvider = new ModulesProvider(client);

  context.subscriptions.push(runtime, modulesProvider);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('loom.modules', modulesProvider),
    vscode.window.registerTreeDataProvider(
      'loom.scheduler',
      new PlaceholderProvider('Scheduler view — coming in Phase 2'),
    ),
    vscode.window.registerTreeDataProvider(
      'loom.bus',
      new PlaceholderProvider('Bus view — coming in Phase 2'),
    ),
  );

  registerRuntimeCommands(context, runtime, modulesProvider);
  registerModuleCommands(context, client, modulesProvider);
  registerDebugCommands(context);

  // --- status bar ---
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'loom.runtime.toggle';
  context.subscriptions.push(status);

  function updateStatus(running: boolean) {
    if (running) {
      status.text = `$(circle-large-filled) Loom :${cfgPort()}`;
      status.tooltip = 'Loom runtime is running. Click to stop.';
    } else {
      status.text = `$(circle-large-outline) Loom`;
      status.tooltip = 'Loom runtime is stopped. Click to start.';
    }
    status.show();
  }
  updateStatus(false);
  context.subscriptions.push(
    runtime.onStateChange((running) => {
      updateStatus(running);
      // Give the runtime a moment to bind, then refresh the tree.
      if (running) setTimeout(() => modulesProvider.refresh(), 800);
      else modulesProvider.refresh();
    }),
  );

  // Refresh the tree when serverUrl changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('loom.serverUrl')) modulesProvider.refresh();
      if (e.affectsConfiguration('loom.port')) updateStatus(runtime.running);
    }),
  );

  void vscode.commands.executeCommand('setContext', 'loom.runtimeRunning', false);
  getExtensionOutput().appendLine('Loom extension activated.');
}

export function deactivate(): void {
  disposeOutputs();
}
