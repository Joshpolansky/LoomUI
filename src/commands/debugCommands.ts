import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import type { RuntimeProcess } from '../runtime/runtimeProcess';
import {
  resolvePaths,
  requireRuntimeExecutable,
  port as cfgPort,
  bindAddress as cfgBind,
} from '../util/paths';

const exec = promisify(execCb);

export function registerDebugCommands(
  context: vscode.ExtensionContext,
  runtime: RuntimeProcess,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('loom.runtime.debug', () => debugRuntime()),
    vscode.commands.registerCommand('loom.runtime.attach', () => attachRuntime(runtime)),
  );
}

async function ensureAdapter(adapter: string): Promise<boolean> {
  const wantedExt = adapter === 'lldb' ? 'vadimcn.vscode-lldb' : 'ms-vscode.cpptools';
  if (vscode.extensions.getExtension(wantedExt)) return true;
  const install = await vscode.window.showErrorMessage(
    `'${wantedExt}' is required for debugAdapter='${adapter}'. Install it now?`,
    'Open Marketplace',
  );
  if (install === 'Open Marketplace') {
    await vscode.commands.executeCommand('workbench.extensions.search', wantedExt);
  }
  return false;
}

async function debugRuntime(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('loom');
  const adapter = cfg.get<string>('debugAdapter', 'lldb');

  const runtimeExecutable = await requireRuntimeExecutable();
  if (!runtimeExecutable) return;

  const { moduleDirs, dataDir, repoPath } = resolvePaths();
  if (moduleDirs.length === 0) {
    vscode.window.showErrorMessage(
      'No module directory found. Open a project workspace, set loom.userModuleDir, or run "Loom: Install Loom Runtime".',
    );
    return;
  }

  if (!(await ensureAdapter(adapter))) return;

  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cwd = workspaceDir || repoPath || os.homedir();

  const args: string[] = [];
  for (const dir of moduleDirs) args.push('--module-dir', dir);
  args.push('--data-dir', dataDir);
  args.push('--port',     String(cfgPort()));
  args.push('--bind',     cfgBind());

  const config: vscode.DebugConfiguration = adapter === 'lldb'
    ? {
        type: 'lldb',
        request: 'launch',
        name: 'Loom Runtime',
        program: runtimeExecutable,
        args,
        cwd,
      }
    : {
        type: 'cppdbg',
        request: 'launch',
        name: 'Loom Runtime',
        program: runtimeExecutable,
        args,
        cwd,
        MIMode: process.platform === 'darwin' ? 'lldb' : 'gdb',
      };

  const ok = await vscode.debug.startDebugging(ws, config);
  if (!ok) {
    vscode.window.showErrorMessage(
      'Failed to launch Loom runtime under the debugger. See the Debug Console for details.',
    );
  }
}

async function attachRuntime(runtime: RuntimeProcess): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('loom');
  const adapter = cfg.get<string>('debugAdapter', 'lldb');
  if (!(await ensureAdapter(adapter))) return;

  // lldb can attach by pid alone. cppdbg requires `program` for symbols.
  const { runtimeExecutable } = resolvePaths();
  if (adapter === 'cppdbg' && !runtimeExecutable) {
    vscode.window.showErrorMessage(
      'cppdbg attach needs loom.runtimeExecutable set so it can load symbols. Run "Loom: Install Loom Runtime" or set the path manually.',
    );
    return;
  }

  // Prefer our own spawned PID; fall back to scanning `ps`.
  let pid: number | undefined = runtime.pid;
  if (pid === undefined) {
    const procs = await listLoomProcesses(runtimeExecutable);
    if (procs.length === 0) {
      vscode.window.showWarningMessage(
        'No running loom process found. Start one with `Loom: Start Runtime` or `just run`.',
      );
      return;
    }
    if (procs.length === 1) {
      pid = procs[0].pid;
    } else {
      const pick = await vscode.window.showQuickPick(
        procs.map((p) => ({
          label: `pid ${p.pid}`,
          description: p.command,
          pid: p.pid,
        })),
        { placeHolder: 'Pick a loom process to attach to' },
      );
      if (!pick) return;
      pid = pick.pid;
    }
  }

  const config: vscode.DebugConfiguration = adapter === 'lldb'
    ? {
        type: 'lldb',
        request: 'attach',
        name: `Loom Attach (pid ${pid})`,
        pid,
      }
    : {
        type: 'cppdbg',
        request: 'attach',
        name: `Loom Attach (pid ${pid})`,
        program: runtimeExecutable,
        processId: pid,
        MIMode: process.platform === 'darwin' ? 'lldb' : 'gdb',
      };

  const ok = await vscode.debug.startDebugging(ws, config);
  if (!ok) {
    vscode.window.showErrorMessage(
      `Failed to attach to pid ${pid}. On macOS the binary may need to be code-signed for debugging — see the Debug Console for details.`,
    );
  }
}

interface ProcInfo { pid: number; command: string; }

async function listLoomProcesses(runtimeExecutable: string): Promise<ProcInfo[]> {
  if (process.platform === 'win32') {
    // tasklist enumeration is doable but rare for our setup; skip for now.
    return [];
  }
  // When loom.runtimeExecutable isn't configured (typical for "I just want
  // to attach to a remote-ish loom" workflows), fall back to matching the
  // canonical binary name so we still find running processes.
  const wantedBase = runtimeExecutable
    ? path.basename(runtimeExecutable)
    : 'loom';
  try {
    const { stdout } = await exec('ps -A -o pid=,command=');
    return stdout.split('\n')
      .map((line): ProcInfo | null => {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) return null;
        return { pid: parseInt(m[1], 10), command: m[2] };
      })
      .filter((p): p is ProcInfo => {
        if (!p) return false;
        const argv0 = p.command.split(/\s+/)[0];
        if (runtimeExecutable && argv0 === runtimeExecutable) return true;
        if (path.basename(argv0) === wantedBase) return true;
        return false;
      });
  } catch {
    return [];
  }
}
