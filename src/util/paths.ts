import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface LoomPaths {
  repoPath: string;
  runtimeExecutable: string;
  moduleDir: string;
  dataDir: string;
}

function workspaceFolder(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function expand(value: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, workspaceFolder());
}

/** Resolve the configured paths. Each is an absolute path, or empty string
 *  if not configured. Callers must check for empty before using.
 *
 *  Resolution order, per field:
 *    1. The explicit setting (loom.runtimeExecutable etc.)
 *    2. Derived from loom.repoPath when that's set (dev workflow with the
 *       Loom source repo cloned somewhere)
 *    3. Empty — caller should prompt the user to install or configure.
 */
export function resolvePaths(): LoomPaths {
  const cfg = vscode.workspace.getConfiguration('loom');
  const repoPathRaw = cfg.get<string>('repoPath') ?? '';
  const repoPath = repoPathRaw ? path.resolve(expand(repoPathRaw)) : '';

  const runtimeExecutable =
    expand(cfg.get<string>('runtimeExecutable') ?? '')
    || (repoPath ? path.join(repoPath, 'output/loom') : '');

  const moduleDir =
    expand(cfg.get<string>('moduleDir') ?? '')
    || (repoPath ? path.join(repoPath, 'output/modules') : '');

  const dataDir =
    expand(cfg.get<string>('dataDir') ?? '')
    || (repoPath ? path.join(repoPath, 'data') : '');

  return { repoPath, runtimeExecutable, moduleDir, dataDir };
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
