import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { LiveStream } from '../api/liveStream';
import type { DataSection } from '../api/types';
import { LoomDebugSession } from './loomDebugSession';

export const LOOM_DEBUG_TYPE = 'loom';

export class LoomDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  /** Sessions currently in flight; used by the manual refresh command. */
  readonly sessions = new Set<LoomDebugSession>();

  constructor(
    private readonly client: LoomClient,
    private readonly live: LiveStream,
  ) {}

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const adapter = new LoomDebugSession(this.client, this.live);
    this.sessions.add(adapter);
    // Clean up when the underlying session ends. The DebugSession itself
    // doesn't expose a 'closed' event; the descriptor wrapper does.
    const sub = vscode.debug.onDidTerminateDebugSession((s) => {
      if (s.id === session.id) {
        this.sessions.delete(adapter);
        sub.dispose();
      }
    });
    return new vscode.DebugAdapterInlineImplementation(adapter);
  }

  refreshAll(): void {
    for (const s of this.sessions) s.refresh();
  }

  /** Route a value edit (from the right-click "Set Value" command) to the
   *  active session. With multiple sessions running we pick the first one
   *  that successfully applies — they all share the same backing client. */
  async applyEdit(moduleId: string, section: DataSection, path: string[], value: unknown): Promise<void> {
    if (this.sessions.size === 0) {
      throw new Error('No active Loom inspector session.');
    }
    let lastErr: unknown;
    for (const s of this.sessions) {
      try {
        await s.applyEdit(moduleId, section, path, value);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('Set value failed');
  }
}

/** Provides a default debug configuration when the user runs the Inspect command without a launch.json entry. */
export class LoomDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      // empty launch.json — fill in the default
      return {
        type: LOOM_DEBUG_TYPE,
        request: 'attach',
        name: 'Loom: Inspect Modules',
      };
    }
    return config;
  }
}
