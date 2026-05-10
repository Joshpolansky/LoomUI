import * as vscode from 'vscode';
import type { LoomClient } from '../api/client';
import type { ServiceInfo } from '../api/types';

type Node = CategoryNode | TopicNode | ServiceNode;

class CategoryNode {
  readonly kind = 'category';
  constructor(public readonly category: 'services' | 'topics', public readonly count: number) {}
}
class TopicNode {
  readonly kind = 'topic';
  constructor(public readonly name: string) {}
}
class ServiceNode {
  readonly kind = 'service';
  constructor(public readonly info: ServiceInfo) {}
}

export class BusProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private topics: string[] = [];
  private services: ServiceInfo[] = [];
  private pollTimer: NodeJS.Timeout | null = null;

  private readonly _onChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private readonly client: LoomClient) {
    void this.poll();
    const intervalMs = vscode.workspace.getConfiguration('loom').get<number>('pollIntervalMs', 5000);
    this.pollTimer = setInterval(() => void this.poll(), Math.max(intervalMs * 2, 5000));
  }

  refresh(): void { void this.poll(); }

  private async poll(): Promise<void> {
    try {
      const [topics, services] = await Promise.all([
        this.client.getBusTopics(),
        this.client.getBusServices(),
      ]);
      this.topics = topics;
      this.services = services;
    } catch {
      this.topics = [];
      this.services = [];
    }
    this._onChange.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'category') {
      const label = node.category === 'services' ? 'Services' : 'Topics';
      const item = new vscode.TreeItem(
        `${label} (${node.count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(node.category === 'services' ? 'symbol-method' : 'broadcast');
      item.contextValue = `busCategory.${node.category}`;
      return item;
    }
    if (node.kind === 'service') {
      const s = node.info;
      const item = new vscode.TreeItem(s.name);
      item.iconPath = new vscode.ThemeIcon('zap');
      item.description = s.schema ? 'typed' : 'raw';
      item.tooltip = s.schema
        ? `${s.name}\n${JSON.stringify(s.schema, null, 2)}`
        : s.name;
      item.contextValue = 'busService';
      item.command = {
        command: 'loom.bus.callService',
        title: 'Call Service',
        arguments: [s.name],
      };
      return item;
    }
    // topic
    const item = new vscode.TreeItem(node.name);
    item.iconPath = new vscode.ThemeIcon('radio-tower');
    item.tooltip = node.name;
    item.contextValue = 'busTopic';
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [
        new CategoryNode('services', this.services.length),
        new CategoryNode('topics', this.topics.length),
      ];
    }
    if (node.kind === 'category') {
      if (node.category === 'services') {
        return this.services
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => new ServiceNode(s));
      }
      return this.topics.slice().sort().map((t) => new TopicNode(t));
    }
    return [];
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._onChange.dispose();
  }
}
