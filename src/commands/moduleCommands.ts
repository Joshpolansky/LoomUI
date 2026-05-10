import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type { LoomClient } from '../api/client';
import type { LiveStream } from '../api/liveStream';
import type { ModulesProvider } from '../views/modulesView';
import { ModuleNode } from '../views/modulesView';
import { getExtensionOutput } from '../util/output';
import { ManagementPanel } from '../webview/managementPanel';
import { resolvePaths } from '../util/paths';

export function registerModuleCommands(
  context: vscode.ExtensionContext,
  client: LoomClient,
  live: LiveStream,
  view: ModulesProvider,
): void {
  const out = getExtensionOutput();

  async function withModuleId(arg: unknown, prompt: string): Promise<string | undefined> {
    if (arg instanceof ModuleNode) return arg.info.id;
    if (typeof arg === 'string') return arg;
    try {
      const list = await client.getModules();
      if (list.length === 0) {
        vscode.window.showInformationMessage('No modules loaded.');
        return undefined;
      }
      const pick = await vscode.window.showQuickPick(
        list.map((m) => ({ label: m.id, description: `${m.className} v${m.version}`, id: m.id })),
        { placeHolder: prompt },
      );
      return pick?.id;
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
      return undefined;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('loom.modules.openDetail', async (idOrNode: unknown) => {
      const id = await withModuleId(idOrNode, 'Inspect module');
      if (!id) return;
      // Hand off to the DAP-based inspector which exposes all modules in
      // VSCode's standard Variables view.
      await vscode.commands.executeCommand('loom.modules.inspect', id);
    }),

    vscode.commands.registerCommand('loom.modules.openSource', async (idOrNode: unknown) => {
      const id = await withModuleId(idOrNode, 'Open module source');
      if (!id) return;

      let detail;
      try {
        detail = await client.getModule(id);
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot fetch module: ${(e as Error).message}`);
        return;
      }

      const soName = path.basename(detail.path).replace(/\.(so|dylib|dll)$/i, '');
      const { repoPath } = resolvePaths();
      const moduleDir = path.join(repoPath, 'modules', soName);
      if (!fsSync.existsSync(moduleDir)) {
        vscode.window.showWarningMessage(
          `Source directory not found at ${moduleDir}. Set 'loom.repoPath' or open the file manually.`,
        );
        return;
      }

      let cppFiles: string[];
      try {
        const entries = await fs.readdir(moduleDir);
        cppFiles = entries.filter((f) => f.endsWith('.cpp')).map((f) => path.join(moduleDir, f));
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot read ${moduleDir}: ${(e as Error).message}`);
        return;
      }

      if (cppFiles.length === 0) {
        vscode.window.showWarningMessage(`No .cpp files in ${moduleDir}.`);
        return;
      }

      let target: string;
      if (cppFiles.length === 1) {
        target = cppFiles[0];
      } else {
        // Prefer one whose basename matches the .so name; otherwise let the user pick.
        const exact = cppFiles.find((p) => path.basename(p, '.cpp') === soName);
        if (exact) {
          target = exact;
        } else {
          const pick = await vscode.window.showQuickPick(
            cppFiles.map((p) => ({
              label: path.basename(p),
              description: path.relative(repoPath, p),
              file: p,
            })),
            { placeHolder: `Pick source file for ${id}` },
          );
          if (!pick) return;
          target = pick.file;
        }
      }

      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc);
      out.appendLine(`Opened ${path.relative(repoPath, target)} for module ${id}.`);
    }),

    vscode.commands.registerCommand('loom.modules.reload', async (node: unknown) => {
      const id = await withModuleId(node, 'Reload module');
      if (!id) return;
      try {
        const res = await client.reloadModule(id);
        if (res.ok) {
          vscode.window.showInformationMessage(`Reloaded ${id}.`);
          view.refresh();
        } else {
          vscode.window.showErrorMessage(`Reload failed: ${res.message ?? 'unknown'}`);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Reload failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.modules.remove', async (node: unknown) => {
      const id = await withModuleId(node, 'Remove module');
      if (!id) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove module instance '${id}'?`, { modal: true }, 'Remove',
      );
      if (confirm !== 'Remove') return;
      try {
        await client.removeModule(id);
        vscode.window.showInformationMessage(`Removed ${id}.`);
        view.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Remove failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.modules.saveConfig', async (node: unknown) => {
      const id = await withModuleId(node, 'Save config of module');
      if (!id) return;
      try {
        await client.saveModuleConfig(id);
        vscode.window.showInformationMessage(`Saved config for ${id}.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Save failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.modules.loadConfig', async (node: unknown) => {
      const id = await withModuleId(node, 'Load config of module');
      if (!id) return;
      try {
        await client.loadModuleConfig(id);
        vscode.window.showInformationMessage(`Loaded config for ${id} from disk.`);
        view.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Load failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.modules.instantiate', async () => {
      let available;
      try {
        available = await client.getAvailableModules();
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
        return;
      }
      if (available.length === 0) {
        vscode.window.showInformationMessage('No available .so files in the module dir.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        available.map((a) => ({
          label: a.className,
          description: `v${a.version}`,
          detail: a.filename,
          so: a.filename,
        })),
        { placeHolder: 'Select a module class to instantiate' },
      );
      if (!pick) return;
      const id = await vscode.window.showInputBox({
        prompt: 'Instance ID',
        value: pick.label.toLowerCase(),
        validateInput: (v) => v.trim().length > 0 ? null : 'ID is required',
      });
      if (!id) return;
      try {
        await client.instantiateModule(pick.so, id);
        vscode.window.showInformationMessage(`Instantiated ${id}.`);
        view.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Instantiate failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.modules.manage', () => {
      ManagementPanel.show(context, client, live);
    }),

    vscode.commands.registerCommand('loom.modules.upload', async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Module': ['so', 'dylib', 'dll'] },
        title: 'Select module to upload',
      });
      if (!uri || uri.length === 0) return;
      try {
        const filename = path.basename(uri[0].fsPath);
        const content = await fs.readFile(uri[0].fsPath);
        const r = await client.uploadModule(filename, content);
        if (r.ok) {
          vscode.window.showInformationMessage(`Uploaded ${filename}.`);
          view.refresh();
        } else {
          vscode.window.showErrorMessage(`Upload failed: ${r.error ?? 'unknown'}`);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Upload failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('loom.bus.callService', async (preselect?: string) => {
      let services;
      try {
        services = await client.getBusServices();
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
        return;
      }
      if (services.length === 0) {
        vscode.window.showInformationMessage('No bus services registered.');
        return;
      }

      let svc = preselect ? services.find((s) => s.name === preselect) : undefined;
      if (!svc) {
        const pick = await vscode.window.showQuickPick(
          services.map((s) => ({ label: s.name, description: s.schema ? 'typed' : 'raw', svc: s })),
          { placeHolder: 'Select a service to call' },
        );
        if (!pick) return;
        svc = pick.svc;
      }

      const initial = svc.schema ? schemaPlaceholder(svc.schema) : '{}';
      const body = await vscode.window.showInputBox({
        prompt: `Request JSON for ${svc.name}`,
        value: initial,
        validateInput: (v) => {
          try { JSON.parse(v); return null; } catch { return 'Must be valid JSON'; }
        },
      });
      if (!body) return;
      try {
        const res = await client.callBusService(svc.name, body);
        out.show(true);
        out.appendLine(`→ ${svc.name} ${body}`);
        out.appendLine(`← ${JSON.stringify(res)}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Call failed: ${(e as Error).message}`);
      }
    }),
  );
}

function schemaPlaceholder(schema: Record<string, unknown>): string {
  // Best-effort skeleton from a JSON schema. Falls back to '{}' if shape is unfamiliar.
  const props = (schema as { properties?: Record<string, { type?: string }> }).properties;
  if (!props) return '{}';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    switch (v.type) {
      case 'number':
      case 'integer': out[k] = 0; break;
      case 'boolean': out[k] = false; break;
      case 'string':  out[k] = ''; break;
      case 'array':   out[k] = []; break;
      case 'object':  out[k] = {}; break;
      default:        out[k] = null;
    }
  }
  return JSON.stringify(out);
}
