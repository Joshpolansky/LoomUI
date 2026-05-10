import * as vscode from 'vscode';
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

export function resolvePaths(): LoomPaths {
  const cfg = vscode.workspace.getConfiguration('loom');
  const repoPath = path.resolve(
    expand(cfg.get<string>('repoPath') || '${workspaceFolder}/../Loom'),
  );
  const runtimeExecutable = expand(cfg.get<string>('runtimeExecutable') || '')
    || path.join(repoPath, 'output/loom');
  const moduleDir = expand(cfg.get<string>('moduleDir') || '')
    || path.join(repoPath, 'output/modules');
  const dataDir = expand(cfg.get<string>('dataDir') || '')
    || path.join(repoPath, 'data');
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
