import * as vscode from 'vscode';
import { LoomClient } from './api/client';
import { LiveStream } from './api/liveStream';
import { ModulesProvider } from './views/modulesView';
import { SchedulerProvider } from './views/schedulerView';
import { BusProvider } from './views/busView';
import { RuntimeProcess } from './runtime/runtimeProcess';
import { registerRuntimeCommands } from './commands/runtimeCommands';
import { registerModuleCommands } from './commands/moduleCommands';
import { registerDebugCommands } from './commands/debugCommands';
import {
  LoomDebugAdapterFactory,
  LoomDebugConfigurationProvider,
  LOOM_DEBUG_TYPE,
} from './debugAdapter/factory';
import { decodeEvalName, parseValue } from './util/jsonValue';
import { serverUrl, port as cfgPort } from './util/paths';
import { disposeOutputs, getExtensionOutput } from './util/output';

export function activate(context: vscode.ExtensionContext): void {
  const client = new LoomClient(serverUrl);
  const live = new LiveStream();
  const runtime = new RuntimeProcess();

  const modulesProvider   = new ModulesProvider(client, live);
  const schedulerProvider = new SchedulerProvider(client, live);
  const busProvider       = new BusProvider(client);

  context.subscriptions.push(runtime, live, modulesProvider, schedulerProvider, busProvider);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('loom.modules',   modulesProvider),
    vscode.window.registerTreeDataProvider('loom.scheduler', schedulerProvider),
    vscode.window.registerTreeDataProvider('loom.bus',       busProvider),
  );

  registerRuntimeCommands(context, runtime, modulesProvider);
  registerModuleCommands(context, client, modulesProvider);
  registerDebugCommands(context);

  // --- DAP-based module inspector ---
  const inspectorFactory = new LoomDebugAdapterFactory(client, live);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(LOOM_DEBUG_TYPE, inspectorFactory),
    vscode.debug.registerDebugConfigurationProvider(
      LOOM_DEBUG_TYPE,
      new LoomDebugConfigurationProvider(),
    ),
    vscode.commands.registerCommand('loom.modules.inspect', async () => {
      const existing = vscode.debug.activeDebugSession;
      if (existing && existing.type === LOOM_DEBUG_TYPE) {
        await vscode.commands.executeCommand('workbench.view.debug');
        return;
      }
      await vscode.debug.startDebugging(
        vscode.workspace.workspaceFolders?.[0],
        {
          type: LOOM_DEBUG_TYPE,
          request: 'attach',
          name: 'Loom: Inspect Modules',
        },
      );
      await vscode.commands.executeCommand('workbench.view.debug');
    }),
    vscode.commands.registerCommand('loom.modules.inspect.refresh', () => {
      inspectorFactory.refreshAll();
    }),
    vscode.commands.registerCommand('loom.modules.setValue', async (arg: unknown) => {
      // VSCode passes context-menu args from `debug/variables/context` as
      // `{ variable: DebugProtocol.Variable, container?, sessionId }`.
      const variable = (arg as { variable?: { name?: string; value?: string; evaluateName?: string } } | undefined)?.variable;
      const desc = decodeEvalName(variable?.evaluateName);
      if (!desc) {
        vscode.window.showInformationMessage('This variable is not editable from the Loom inspector.');
        return;
      }
      const fieldName = [desc.section, ...desc.path].join('.');
      const next = await vscode.window.showInputBox({
        prompt: `Set ${desc.moduleId}.${fieldName}`,
        value: variable?.value ?? '',
        placeHolder: 'number, "string", true, false, null, or JSON literal',
        validateInput: (v) => {
          if (v === '') return null;
          const r = parseValue(v);
          return r.ok ? null : r.error;
        },
      });
      if (next === undefined || next === '') return;
      const parsed = parseValue(next);
      if (!parsed.ok) return; // already validated, but keep TS happy
      try {
        await inspectorFactory.applyEdit(desc.moduleId, desc.section, desc.path, parsed.value);
      } catch (e) {
        vscode.window.showErrorMessage(`Set failed: ${(e as Error).message}`);
      }
    }),
  );

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
      // After a fresh start give the server a moment to bind, then refresh.
      if (running) {
        setTimeout(() => {
          modulesProvider.refresh();
          schedulerProvider.refresh();
          busProvider.refresh();
          live.reconnect();
        }, 800);
      } else {
        modulesProvider.refresh();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('loom.serverUrl')) {
        live.reconnect();
        modulesProvider.refresh();
        schedulerProvider.refresh();
        busProvider.refresh();
      }
      if (e.affectsConfiguration('loom.port')) updateStatus(runtime.running);
    }),
  );

  void vscode.commands.executeCommand('setContext', 'loom.runtimeRunning', false);
  getExtensionOutput().appendLine('Loom extension activated.');
}

export function deactivate(): void {
  disposeOutputs();
}
