import * as vscode from 'vscode';
import type { RuntimeProcess } from '../runtime/runtimeProcess';
import type { ModulesProvider } from '../views/modulesView';

export function registerRuntimeCommands(
  context: vscode.ExtensionContext,
  runtime: RuntimeProcess,
  modules: ModulesProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('loom.runtime.start',   () => runtime.start()),
    vscode.commands.registerCommand('loom.runtime.stop',    () => runtime.stop()),
    vscode.commands.registerCommand('loom.runtime.restart', () => runtime.restart()),
    vscode.commands.registerCommand('loom.runtime.toggle',  () =>
      runtime.running ? runtime.stop() : runtime.start(),
    ),
    vscode.commands.registerCommand('loom.runtime.connect', async () => {
      const cur = vscode.workspace.getConfiguration('loom').get<string>('serverUrl', 'http://localhost:8080');
      const next = await vscode.window.showInputBox({
        prompt: 'Loom server URL',
        value: cur,
        validateInput: (v) => /^https?:\/\/.+/.test(v) ? null : 'Must start with http:// or https://',
      });
      if (!next) return;
      await vscode.workspace.getConfiguration('loom').update('serverUrl', next, vscode.ConfigurationTarget.Workspace);
      modules.refresh();
    }),
    vscode.commands.registerCommand('loom.modules.refresh', () => modules.refresh()),
  );
}
