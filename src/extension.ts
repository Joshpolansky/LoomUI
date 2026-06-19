import * as vscode from 'vscode';
import { LoomClient } from './api/client';
import { OpcuaClient } from './api/opcuaClient';
import { ModulesProvider } from './views/modulesView';
import { SchedulerProvider } from './views/schedulerView';
import { BusProvider } from './views/busView';
import { MappingsProvider } from './views/mappingsView';
import { FaultsProvider } from './views/faultsView';
import { RuntimeProcess } from './runtime/runtimeProcess';
import { registerRuntimeCommands } from './commands/runtimeCommands';
import { registerModuleCommands } from './commands/moduleCommands';
import { registerDebugCommands } from './commands/debugCommands';
import { registerSchedulerCommands } from './commands/schedulerCommands';
import { registerMappingCommands } from './commands/mappingCommands';
import { registerProjectCommands } from './commands/projectCommands';
import { registerFaultCommands } from './commands/faultCommands';
import {
  LoomDebugAdapterFactory,
  LoomDebugConfigurationProvider,
  LOOM_DEBUG_TYPE,
} from './debugAdapter/factory';
import { decodeEvalName, parseValue } from './util/jsonValue';
import { activeRuntimeProfile, serverUrl, port as cfgPort } from './util/paths';
import { disposeOutputs, getExtensionOutput } from './util/output';

export function activate(context: vscode.ExtensionContext): void {
  const client = new LoomClient(serverUrl);
  const opc = new OpcuaClient(serverUrl);
  client.attachOpcua(opc);
  const runtime = new RuntimeProcess();

  const modulesProvider   = new ModulesProvider(client, opc);
  const schedulerProvider = new SchedulerProvider(client, opc);
  const busProvider       = new BusProvider(client);
  const mappingsProvider  = new MappingsProvider(client);
  const faultsProvider    = new FaultsProvider(client, opc);

  context.subscriptions.push(
    runtime, opc, modulesProvider, schedulerProvider, busProvider, mappingsProvider, faultsProvider,
  );

  // If the runtime answers REST but lacks the OPC-UA live-data facade, it's too
  // old for this extension's live updates — prompt the user to update it. Warn
  // once per connection attempt cycle; re-arm after a successful connection so a
  // later regression warns again.
  let warnedUnsupported = false;
  function onRuntimeTooOld(): void {
    const out = getExtensionOutput();
    out.appendLine(
      'Loom runtime is reachable but has no OPC-UA live-data facade — the runtime binary is too old. Update it for live updates.',
    );
    if (warnedUnsupported) return;
    warnedUnsupported = true;
    out.appendLine('Showing "runtime too old" warning notification.');
    void vscode.window.showWarningMessage(
      'This Loom runtime does not support the live-data (OPC-UA) interface required by ' +
      'Loom Workbench. Live updates and field editing are disabled until the runtime is updated.',
      'Update Runtime…',
    ).then((choice) => {
      if (choice === 'Update Runtime…') void vscode.commands.executeCommand('loom.runtime.install');
    });
  }
  context.subscriptions.push(
    opc.onConnectionChange((connected) => { if (connected) warnedUnsupported = false; }),
    opc.onUnsupported(() => onRuntimeTooOld()),
  );
  // In case detection already happened before this listener attached.
  if (opc.unsupported) onRuntimeTooOld();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('loom.modules',  modulesProvider),
    vscode.window.registerTreeDataProvider('loom.bus',      busProvider),
    vscode.window.registerTreeDataProvider('loom.mappings', mappingsProvider),
    vscode.window.registerTreeDataProvider('loom.faults',   faultsProvider),
    // Scheduler view uses createTreeView so we can attach the
    // TreeDragAndDropController for reassigning modules between classes.
    vscode.window.createTreeView('loom.scheduler', {
      treeDataProvider: schedulerProvider,
      dragAndDropController: schedulerProvider,
      canSelectMany: true,
    }),
  );

  registerRuntimeCommands(context, runtime, modulesProvider);
  registerModuleCommands(context, client, opc, modulesProvider);
  registerSchedulerCommands(context, client, schedulerProvider);
  registerMappingCommands(context, client, mappingsProvider);
  registerProjectCommands(context);
  registerDebugCommands(context, runtime);
  registerFaultCommands(context, client, faultsProvider);

  // --- DAP-based module inspector ---
  const inspectorFactory = new LoomDebugAdapterFactory(client, opc);
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
    const profile = activeRuntimeProfile() === 'debug' ? 'Debug' : 'Release';
    if (running) {
      status.text = `$(circle-large-filled) Loom ${profile} :${cfgPort()}`;
      status.tooltip = 'Loom runtime is running. Click to stop.';
    } else {
      status.text = `$(circle-large-outline) Loom ${profile}`;
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
          mappingsProvider.refresh();
          faultsProvider.refresh();
          opc.reconnect();
        }, 800);
      } else {
        modulesProvider.refresh();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('loom.serverUrl')) {
        opc.reconnect();
        modulesProvider.refresh();
        schedulerProvider.refresh();
        busProvider.refresh();
        mappingsProvider.refresh();
        faultsProvider.refresh();
      }
      if (e.affectsConfiguration('loom.port') || e.affectsConfiguration('loom.runtimeProfile')) {
        updateStatus(runtime.running);
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'loom.runtimeRunning', false);
  getExtensionOutput().appendLine('Loom extension activated.');
}

export function deactivate(): void {
  disposeOutputs();
}
