import * as vscode from 'vscode';
import type { RuntimeProcess } from '../runtime/runtimeProcess';
import type { ModulesProvider } from '../views/modulesView';
import { installLoomRuntime, uninstallLoomRuntime } from '../runtime/installRuntime';

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
    vscode.commands.registerCommand('loom.runtime.selectProfile', async () => {
      if (process.platform !== 'win32') {
        vscode.window.showInformationMessage(
          'Runtime profile selection is only needed on Windows (Debug vs Release CRT isolation). ' +
          'On macOS/Linux a single binary works with all build configs.',
        );
        return;
      }
      const cfg = vscode.workspace.getConfiguration('loom');
      const current = cfg.get<string>('runtimeProfile', 'debug') === 'release' ? 'release' : 'debug';
      const picked = await vscode.window.showQuickPick([
        { label: 'Debug', value: 'debug' as const, description: 'Developer profile (debug runtime + debug module dirs)' },
        { label: 'Release', value: 'release' as const, description: 'Production profile (release runtime + release module dirs)' },
      ], {
        title: 'Select Loom Runtime Profile',
        placeHolder: current === 'debug' ? 'Current: Debug' : 'Current: Release',
      });
      if (!picked || picked.value === current) return;
      await cfg.update('runtimeProfile', picked.value, vscode.ConfigurationTarget.Workspace);
      if (runtime.running) {
        const action = await vscode.window.showInformationMessage(
          `Switched to ${picked.label} profile. Restart runtime now?`,
          'Restart Runtime',
          'Later',
        );
        if (action === 'Restart Runtime') {
          await runtime.restart();
        }
      }
      modules.refresh();
    }),
    vscode.commands.registerCommand('loom.runtime.install', () => installLoomRuntime(context)),
    vscode.commands.registerCommand('loom.runtime.uninstall', () => uninstallLoomRuntime(context)),
  );
}
