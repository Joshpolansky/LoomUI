import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type RuntimeProfile = 'debug' | 'release';

export interface LoomPaths {
  repoPath: string;
  runtimeProfile: RuntimeProfile;
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

function pushExistingDir(target: string[], dir: string): void {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  if (!target.includes(resolved)) target.push(resolved);
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

function profileKeySuffix(profile: RuntimeProfile): 'Debug' | 'Release' {
  return profile === 'debug' ? 'Debug' : 'Release';
}

export function activeRuntimeProfile(): RuntimeProfile {
  const raw = vscode.workspace.getConfiguration('loom').get<string>('runtimeProfile', 'debug');
  return raw === 'release' ? 'release' : 'debug';
}

function resolveConfiguredPath(cfg: vscode.WorkspaceConfiguration, key: string): string {
  return (expandWs(cfg.get<string>(key) ?? '') ?? '');
}

function firstExistingFile(candidates: string[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const resolved = path.resolve(c);
    if (fs.existsSync(resolved)) return resolved;
  }
  // Return first candidate (resolved) even if missing so error messages remain specific.
  const first = candidates.find(Boolean);
  return first ? path.resolve(first) : '';
}

/** Resolve the configured paths. Each is an absolute path, or empty
 *  string if not configured / unresolvable. Callers must check for
 *  empty before using. */
export function resolvePaths(): LoomPaths {
  const cfg = vscode.workspace.getConfiguration('loom');
  const isWindows = process.platform === 'win32';
  const runtimeProfile = activeRuntimeProfile();
  const profileSuffix = profileKeySuffix(runtimeProfile);
  const repoPathRaw = cfg.get<string>('repoPath') ?? '';
  const repoPath = repoPathRaw
    ? path.resolve(expandWs(repoPathRaw) ?? '')
    : '';
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // On Windows, Debug and Release runtimes use separate executables (CRT ABI
  // incompatibility). On other platforms a single binary serves all configs.
  const runtimeExecutable = firstExistingFile(isWindows ? [
    resolveConfiguredPath(cfg, `runtimeExecutable${profileSuffix}`),
    resolveConfiguredPath(cfg, 'runtimeExecutable'),
    repoPath ? path.join(repoPath, 'output', profileSuffix, 'loom.exe') : '',
    repoPath ? path.join(repoPath, 'output', 'loom.exe') : '',
  ] : [
    resolveConfiguredPath(cfg, 'runtimeExecutable'),
    repoPath ? path.join(repoPath, 'output', 'loom') : '',
  ]);

  // On Windows, module directories are split by profile to match the runtime.
  // On other platforms a flat output/modules directory is used.
  const userModuleCandidates = isWindows ? [
    resolveConfiguredPath(cfg, `userModuleDir${profileSuffix}`),
    resolveConfiguredPath(cfg, 'userModuleDir'),
    // Back-compat: treat the legacy loom.moduleDir as user-scoped.
    resolveConfiguredPath(cfg, 'moduleDir'),
    ws ? path.join(ws, 'output', 'modules', profileSuffix) : '',
    repoPath ? path.join(repoPath, 'output', profileSuffix, 'modules') : '',
    repoPath ? path.join(repoPath, 'output', 'modules') : '',
  ] : [
    resolveConfiguredPath(cfg, 'userModuleDir'),
    // Back-compat: treat the legacy loom.moduleDir as user-scoped.
    resolveConfiguredPath(cfg, 'moduleDir'),
    ws ? path.join(ws, 'output', 'modules') : '',
    repoPath ? path.join(repoPath, 'output', 'modules') : '',
  ];

  const systemModuleCandidates = isWindows ? [
    resolveConfiguredPath(cfg, `systemModuleDir${profileSuffix}`),
    resolveConfiguredPath(cfg, 'systemModuleDir'),
  ] : [
    resolveConfiguredPath(cfg, 'systemModuleDir'),
  ];

  const userModuleDir = userModuleCandidates.find(Boolean) ?? '';
  const systemModuleDir = systemModuleCandidates.find(Boolean) ?? '';

  // The list passed to the runtime, user-first, filtered to existing dirs.
  const moduleDirs: string[] = [];
  for (const c of userModuleCandidates) pushExistingDir(moduleDirs, c);
  for (const c of systemModuleCandidates) pushExistingDir(moduleDirs, c);

  // Data dir: explicit setting -> repo data -> ${workspaceFolder}/data ->
  // ~/.loom/data. The ${workspaceFolder} step lets the templated project's
  // .vscode/settings.json take effect without anything special here.
  const explicitDataDir = expandWs(cfg.get<string>('dataDir') ?? '') ?? '';
  const dataDir =
    explicitDataDir
    || (repoPath ? path.join(repoPath, 'data') : '')
    || (ws ? path.join(ws, 'data') : '')
    || path.join(os.homedir(), '.loom', 'data');

  return { repoPath, runtimeProfile, runtimeExecutable, userModuleDir, systemModuleDir, moduleDirs, dataDir };
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
  const { runtimeExecutable, runtimeProfile } = resolvePaths();
  const isWindows = process.platform === 'win32';
  const profileSuffix = profileKeySuffix(runtimeProfile);
  const profileLabel = runtimeProfile === 'debug' ? 'Debug' : 'Release';
  // On Windows the user needs to pick the right per-profile binary; on other
  // platforms there is only one generic binary setting.
  const settingsKey = isWindows ? `loom.runtimeExecutable${profileSuffix}` : 'loom.runtimeExecutable';
  const notConfiguredMsg = isWindows
    ? `No Loom ${profileLabel} runtime binary configured.`
    : 'No Loom runtime binary configured.';
  const notFoundMsg = isWindows
    ? `Loom ${profileLabel} binary not found at ${runtimeExecutable}.`
    : `Loom binary not found at ${runtimeExecutable}.`;
  if (!runtimeExecutable) {
    const action = await vscode.window.showErrorMessage(
      notConfiguredMsg,
      { modal: false },
      'Install Loom Runtime…',
      'Open Settings',
    );
    if (action === 'Install Loom Runtime…') {
      await vscode.commands.executeCommand('loom.runtime.install');
    } else if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', settingsKey);
    }
    return undefined;
  }
  if (!fs.existsSync(runtimeExecutable)) {
    const action = await vscode.window.showErrorMessage(
      notFoundMsg,
      'Install Loom Runtime…',
      'Open Settings',
    );
    if (action === 'Install Loom Runtime…') {
      await vscode.commands.executeCommand('loom.runtime.install');
    } else if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', settingsKey);
    }
    return undefined;
  }
  return runtimeExecutable;
}
