import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { IOMapping } from '../api/types';

export class MappingNode {
  readonly kind = 'mapping';
  constructor(public readonly index: number, public readonly mapping: IOMapping) {}
}

export type Node = MappingNode;

export class MappingsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private mappings: IOMapping[] = [];
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;

  private readonly _onChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private readonly client: LoomClient) {
    void this.poll();
    const intervalMs = vscode.workspace.getConfiguration('loom').get<number>('pollIntervalMs', 5000);
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
  }

  refresh(): void { void this.poll(); }

  private async poll(): Promise<void> {
    try {
      this.mappings = await this.client.getMappings();
      this.connected = true;
    } catch {
      this.mappings = [];
      this.connected = false;
    }
    this._onChange.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const m = node.mapping;
    const item = new vscode.TreeItem(`${m.source}  →  ${m.target}`);
    item.iconPath = new vscode.ThemeIcon(
      m.error ? 'error' :
      !m.enabled ? 'circle-slash' :
      m.status === 'resolved' ? 'pass-filled' :
      'circle-outline',
    );
    const tag = !m.enabled ? 'disabled' : (m.status ?? '');
    item.description = tag;
    item.tooltip = [
      `source: ${m.source}`,
      `target: ${m.target}`,
      `enabled: ${m.enabled}`,
      `status: ${m.status ?? 'unknown'}`,
      m.error ? `error: ${m.error}` : '',
    ].filter(Boolean).join('\n');
    item.contextValue = m.enabled ? 'mappingEnabled' : 'mappingDisabled';
    return item;
  }

  getChildren(): Node[] {
    if (!this.connected) return [];
    return this.mappings.map((m, i) => new MappingNode(m.index ?? i, m));
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._onChange.dispose();
  }
}
