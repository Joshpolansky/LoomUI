import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import { MODULE_STATES, type ModuleInfo, type DataSection } from '../api/types';
import { serverUrl } from '../util/paths';

type Node = StatusNode | StateGroupNode | ModuleNode | SectionNode;

class StatusNode {
  readonly kind = 'status';
  constructor(public readonly connected: boolean, public readonly url: string) {}
}
class StateGroupNode {
  readonly kind = 'group';
  constructor(public readonly state: number, public readonly modules: ModuleInfo[]) {}
}
export class ModuleNode {
  readonly kind = 'module';
  constructor(public readonly info: ModuleInfo) {}
}
class SectionNode {
  readonly kind = 'section';
  constructor(public readonly moduleId: string, public readonly section: DataSection) {}
}

export class ModulesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private modules: ModuleInfo[] = [];
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private inflight = false;

  constructor(private readonly client: LoomClient) {
    this.startPolling();
  }

  refresh(): void {
    void this.poll();
  }

  private startPolling(): void {
    void this.poll();
    const intervalMs = vscode.workspace.getConfiguration('loom').get<number>('pollIntervalMs', 5000);
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
  }

  private async poll(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const list = await this.client.getModules();
      this.modules = list;
      this.connected = true;
    } catch {
      this.modules = [];
      this.connected = false;
    } finally {
      this.inflight = false;
      this._onDidChange.fire(undefined);
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'status': {
        const item = new vscode.TreeItem(
          node.connected ? `Connected — ${node.url}` : `Disconnected — ${node.url}`,
        );
        item.iconPath = new vscode.ThemeIcon(node.connected ? 'pass-filled' : 'circle-slash');
        item.contextValue = 'status';
        item.tooltip = node.connected
          ? 'Loom runtime reachable.'
          : 'Cannot reach Loom runtime. Start it from this view or check loom.serverUrl.';
        return item;
      }
      case 'group': {
        const stateName = MODULE_STATES[node.state] ?? `State ${node.state}`;
        const item = new vscode.TreeItem(
          `${stateName} (${node.modules.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.contextValue = 'stateGroup';
        return item;
      }
      case 'module': {
        const info = node.info;
        const stateName = MODULE_STATES[info.state] ?? '?';
        const cycleUs = info.stats?.lastCycleTimeUs ?? 0;
        const overruns = info.stats?.overrunCount ?? 0;
        const item = new vscode.TreeItem(
          `${info.id}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description =
          `${info.className} v${info.version} · ${cycleUs}µs · overruns ${overruns}` +
          (info.cyclicClass ? ` · ${info.cyclicClass}` : '');
        item.tooltip = [
          `id: ${info.id}`,
          `class: ${info.className} v${info.version}`,
          `state: ${stateName}`,
          `path: ${info.path}`,
        ].join('\n');
        item.contextValue = 'module';
        item.iconPath = new vscode.ThemeIcon(
          info.state === 3 ? 'play-circle' :
          info.state === 5 ? 'error' :
          info.state === 4 ? 'debug-pause' :
          'circle-outline',
        );
        return item;
      }
      case 'section': {
        const item = new vscode.TreeItem(node.section, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'section';
        item.iconPath = new vscode.ThemeIcon(
          node.section === 'config'  ? 'settings-gear' :
          node.section === 'recipe'  ? 'beaker' :
          node.section === 'runtime' ? 'pulse' :
          'list-flat',
        );
        item.command = {
          command: 'loom.modules.openDetail',
          title: 'Open Module Detail',
          arguments: [node.moduleId, node.section],
        };
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const status = new StatusNode(this.connected, serverUrl());
      const byState = new Map<number, ModuleInfo[]>();
      for (const m of this.modules) {
        const arr = byState.get(m.state) ?? [];
        arr.push(m);
        byState.set(m.state, arr);
      }
      const groups = Array.from(byState.keys())
        .sort((a, b) => a - b)
        .map((state) => new StateGroupNode(state, byState.get(state)!));
      return [status, ...groups];
    }
    if (node.kind === 'group') {
      return node.modules
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => new ModuleNode(m));
    }
    if (node.kind === 'module') {
      return (['config', 'recipe', 'runtime', 'summary'] as const)
        .map((s) => new SectionNode(node.info.id, s));
    }
    return [];
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._onDidChange.dispose();
  }
}
