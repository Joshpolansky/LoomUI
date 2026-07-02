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
import { WatchPanel } from './webview/watchPanel';
import { SystemPanel } from './webview/systemPanel';
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
  const faultsProvider    = new FaultsProvider();

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
  registerFaultCommands(context, faultsProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('loom.watch.open', () => {
      WatchPanel.show(context, client, opc);
    }),
    vscode.commands.registerCommand('loom.system.open', () => {
      SystemPanel.show(client);
    }),
  );

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

  // Latest /api/system sample from WHATEVER runtime serverUrl points at --
  // reachability-driven, so an externally-launched runtime gets a readout too,
  // not just processes this extension spawned.
  let lastSystem: { rssBytes: number; peakRssBytes: number; cpuPercent: number; uptimeSec: number } | undefined;

  function renderStatus() {
    const profile = activeRuntimeProfile() === 'debug' ? 'Debug' : 'Release';
    const base = runtime.running
      ? `$(circle-large-filled) Loom ${profile} :${cfgPort()}`
      : `$(circle-large-outline) Loom ${profile}`;
    if (lastSystem) {
      const mb = (lastSystem.rssBytes / (1024 * 1024)).toFixed(1);
      status.text = `${base} · ${mb} MB · ${lastSystem.cpuPercent.toFixed(1)}%`;
      const tip = new vscode.MarkdownString(
        `**Loom runtime** — ${serverUrl()}\n\n` +
        `Memory: **${mb} MB** (peak ${(lastSystem.peakRssBytes / (1024 * 1024)).toFixed(1)} MB)\n\n` +
        `CPU: **${lastSystem.cpuPercent.toFixed(1)}%** of machine · up ${fmtUptime(lastSystem.uptimeSec)}\n\n` +
        `[Open System Metrics](command:loom.system.open)\n\n` +
        (runtime.running ? 'Click to stop the runtime.' : 'Externally-launched runtime. Click to start a local one.'),
      );
      tip.isTrusted = { enabledCommands: ['loom.system.open'] };
      status.tooltip = tip;
    } else {
      status.text = base;
      status.tooltip = runtime.running
        ? 'Loom runtime is running. Click to stop.'
        : 'Loom runtime is stopped. Click to start.';
    }
    status.show();
  }
  renderStatus();

  // Poll /api/system on the shared cadence; presence/absence of a response is
  // also what flips the readout on and off.
  async function pollSystem(): Promise<void> {
    let next: typeof lastSystem;
    try {
      const s = await client.getSystem();
      next = { rssBytes: s.rssBytes, peakRssBytes: s.peakRssBytes, cpuPercent: s.cpuPercent, uptimeSec: s.uptimeSec };
    } catch { next = undefined; }
    const changed = JSON.stringify(next) !== JSON.stringify(lastSystem);
    lastSystem = next;
    if (changed) renderStatus();
  }
  const sysIntervalMs = vscode.workspace.getConfiguration('loom').get<number>('pollIntervalMs', 5000);
  void pollSystem();
  const sysTimer = setInterval(() => void pollSystem(), sysIntervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(sysTimer) });

  context.subscriptions.push(
    runtime.onStateChange((running) => {
      renderStatus();
      // After a fresh start give the server a moment to bind, then refresh.
      if (running) {
        setTimeout(() => {
          modulesProvider.refresh();
          schedulerProvider.refresh();
          busProvider.refresh();
          mappingsProvider.refresh();
          faultsProvider.refresh();
          opc.reconnect();
          void pollSystem();
        }, 800);
      } else {
        modulesProvider.refresh();
        lastSystem = undefined;
        renderStatus();
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
        renderStatus();
      }
    }),
  );

  void vscode.commands.executeCommand('setContext', 'loom.runtimeRunning', false);
  getExtensionOutput().appendLine('Loom extension activated.');
}

export function deactivate(): void {
  disposeOutputs();
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
