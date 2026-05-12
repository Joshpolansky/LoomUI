import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LoomPaths {
  repoPath: string;
  runtimeExecutable: string;
  /** User's module directory (workspace-scoped). Empty if unresolved. */
  userModuleDir: string;
  /** System / install-managed module directory. Empty if unset. */
  systemModuleDir: string;
  /** The list of module dirs to pass to the runtime, user first, in
   *  preference order. Filtered to only directories that resolve and
   *  exist. */
  moduleDirs: string[];
  dataDir: string;
}

/** Expand `${workspaceFolder}` against the active workspace.
 *  Returns undefined when the value referenced ${workspaceFolder} but no
 *  workspace is open — caller treats that as "unresolved" and falls
 *  through to other defaults. */
function expandWs(value: string): string | undefined {
  if (!value.includes('${workspaceFolder}')) return value;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return undefined;
  return value.replace(/\$\{workspaceFolder\}/g, ws);
}

/** Resolve the configured paths. Each is an absolute path, or empty
 *  string if not configured / unresolvable. Callers must check for
 *  empty before using. */
export function resolvePaths(): LoomPaths {
  const cfg = vscode.workspace.getConfiguration('loom');
  const repoPathRaw = cfg.get<string>('repoPath') ?? '';
  const repoPath = repoPathRaw
    ? path.resolve(expandWs(repoPathRaw) ?? '')
    : '';

  const runtimeExecutable =
    (expandWs(cfg.get<string>('runtimeExecutable') ?? '') ?? '')
    || (repoPath ? path.join(repoPath, 'output/loom') : '');

  // User module dir: defaults to ${workspaceFolder}/output/modules. Falls
  // back to ${repoPath}/output/modules when only repoPath is set.
  const userModuleDir =
    (expandWs(cfg.get<string>('userModuleDir') ?? '') ?? '')
    // Back-compat: treat the legacy loom.moduleDir as user-scoped.
    || (expandWs(cfg.get<string>('moduleDir') ?? '') ?? '')
    || (repoPath ? path.join(repoPath, 'output/modules') : '');

  // System module dir: install command writes this; empty otherwise.
  const systemModuleDir = expandWs(cfg.get<string>('systemModuleDir') ?? '') ?? '';

  // The list passed to the runtime, user-first, filtered to existing dirs.
  const moduleDirs: string[] = [];
  if (userModuleDir   && fs.existsSync(userModuleDir))   moduleDirs.push(userModuleDir);
  if (systemModuleDir && fs.existsSync(systemModuleDir)) moduleDirs.push(systemModuleDir);

  // Data dir: explicit setting -> repo data -> ${workspaceFolder}/data ->
  // ~/.loom/data. The ${workspaceFolder} step lets the templated project's
  // .vscode/settings.json take effect without anything special here.
  const explicitDataDir = expandWs(cfg.get<string>('dataDir') ?? '') ?? '';
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const dataDir =
    explicitDataDir
    || (repoPath ? path.join(repoPath, 'data') : '')
    || (ws ? path.join(ws, 'data') : '')
    || path.join(os.homedir(), '.loom', 'data');

  return { repoPath, runtimeExecutable, userModuleDir, systemModuleDir, moduleDirs, dataDir };
}

export function serverUrl(): string {
  return vscode.workspace.getConfiguration('loom').get<string>('serverUrl')
    || 'http://localhost:8080';
}

export function port(): number {
  return vscode.workspace.getConfiguration('loom').get<number>('port', 8080);
}

export function bindAddress(): string {
  return vscode.workspace.getConfiguration('loom').get<string>('bindAddress', '0.0.0.0');
}

/** Returns the resolved runtime executable, or undefined after surfacing a
 *  helpful prompt that lets the user install the binary or jump to settings. */
export async function requireRuntimeExecutable(): Promise<string | undefined> {
  const { runtimeExecutable } = resolvePaths();
  if (!runtimeExecutable) {
    const action = await vscode.window.showErrorMessage(
      'No Loom runtime binary configured.',
      { modal: false },
      'Install Loom Runtime…',
      'Open Settings',
    );
    if (action === 'Install Loom Runtime…') {
      await vscode.commands.executeCommand('loom.runtime.install');
    } else if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'loom.runtimeExecutable');
    }
    return undefined;
  }
  if (!fs.existsSync(runtimeExecutable)) {
    const action = await vscode.window.showErrorMessage(
      `Loom binary not found at ${runtimeExecutable}.`,
      'Install Loom Runtime…',
      'Open Settings',
    );
    if (action === 'Install Loom Runtime…') {
      await vscode.commands.executeCommand('loom.runtime.install');
    } else if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'loom.runtimeExecutable');
    }
    return undefined;
  }
  return runtimeExecutable;
}
