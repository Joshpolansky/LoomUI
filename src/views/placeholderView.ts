import * as vscode from 'vscode';

export class PlaceholderProvider implements vscode.TreeDataProvider<string> {
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly message: string) {}

  getTreeItem(item: string): vscode.TreeItem {
    const t = new vscode.TreeItem(item);
    t.iconPath = new vscode.ThemeIcon('info');
    return t;
  }

  getChildren(): string[] {
    return [this.message];
  }
}
