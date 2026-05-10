import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { resolvePaths, port as cfgPort, bindAddress as cfgBind } from '../util/paths';
import { getRuntimeOutput } from '../util/output';

export class RuntimeProcess implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private readonly _onStateChange = new vscode.EventEmitter<boolean>();
  readonly onStateChange = this._onStateChange.event;

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.running) {
      vscode.window.showInformationMessage('Loom runtime is already running.');
      return;
    }
    const { runtimeExecutable, moduleDir, dataDir, repoPath } = resolvePaths();

    if (!fs.existsSync(runtimeExecutable)) {
      const msg = `Loom runtime not found at ${runtimeExecutable}. Build it (just build) or set 'loom.runtimeExecutable'.`;
      vscode.window.showErrorMessage(msg);
      return;
    }

    const args = [
      '--module-dir', moduleDir,
      '--data-dir',   dataDir,
      '--port',       String(cfgPort()),
      '--bind',       cfgBind(),
    ];

    const out = getRuntimeOutput();
    out.appendLine(`▶ ${runtimeExecutable} ${args.join(' ')}`);
    out.appendLine(`  cwd: ${repoPath}`);
    out.show(true);

    const child = spawn(runtimeExecutable, args, {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => out.append(d.toString()));
    child.stderr?.on('data', (d: Buffer) => out.append(d.toString()));
    child.on('exit', (code, signal) => {
      out.appendLine(`✖ runtime exited (code=${code}, signal=${signal ?? 'none'})`);
      const wasRunning = this.child === child;
      this.child = null;
      if (wasRunning) {
        void vscode.commands.executeCommand('setContext', 'loom.runtimeRunning', false);
        this._onStateChange.fire(false);
      }
    });
    child.on('error', (err) => {
      out.appendLine(`✖ spawn error: ${err.message}`);
    });

    void vscode.commands.executeCommand('setContext', 'loom.runtimeRunning', true);
    this._onStateChange.fire(true);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 2000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  async restart(): Promise<void> {
    if (this.running) await this.stop();
    await this.start();
  }

  dispose(): void {
    if (this.running) {
      try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this._onStateChange.dispose();
  }
}
