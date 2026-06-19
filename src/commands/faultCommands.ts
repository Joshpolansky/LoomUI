import * as vscode from 'vscode';
import * as fsSync from 'fs';
import * as path from 'path';
import type { FaultsProvider } from '../views/faultsView';
import { FaultNode } from '../views/faultsView';
import { DiskFaultSource } from '../api/faultSource';
import { FaultPanel } from '../webview/faultPanel';
import { resolvePaths, serverUrl } from '../util/paths';
import { getExtensionOutput } from '../util/output';

/**
 * Resolve a build-time source path to one that exists on this machine, then jump
 * to the given line (mirrors loom.modules.openSource):
 *   1. The absolute path captured at build time (dev builds, same machine).
 *   2. Remap under loom.repoPath by the repo-directory name (another checkout).
 */
function resolveSourcePath(file: string): string | undefined {
  if (!file) return undefined;
  if (fsSync.existsSync(file)) return file;

  const { repoPath } = resolvePaths();
  if (repoPath) {
    const repoName = path.basename(repoPath).toLowerCase();
    const norm = file.replace(/\\/g, '/');
    const idx = norm.toLowerCase().lastIndexOf('/' + repoName + '/');
    if (idx >= 0) {
      const candidate = path.join(repoPath, norm.slice(idx + repoName.length + 2));
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function registerFaultCommands(
  context: vscode.ExtensionContext,
  view: FaultsProvider,
): void {
  const out = getExtensionOutput();

  context.subscriptions.push(
    vscode.commands.registerCommand('loom.faults.refresh', () => view.refresh()),

    // Open a report. From the tree it gets a FaultNode (carries its source);
    // from the palette it has no arg, so prompt for a file to open directly.
    vscode.commands.registerCommand('loom.faults.openReport', async (node: unknown) => {
      if (node instanceof FaultNode) {
        FaultPanel.show(context, node.source, node.info.id);
        return;
      }
      await vscode.commands.executeCommand('loom.faults.openFile');
    }),

    // Pick a crash file (.json / .txt) and open it directly — no runtime, no
    // source management. The file's folder becomes an ad-hoc disk source.
    vscode.commands.registerCommand('loom.faults.openFile', async () => {
      const { dataDir } = resolvePaths();
      const defaultDir = path.join(dataDir, 'crash');
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open Crash Report',
        defaultUri: fsSync.existsSync(defaultDir) ? vscode.Uri.file(defaultDir) : undefined,
        filters: { 'Crash reports': ['json', 'txt'], 'All files': ['*'] },
      });
      if (!picked || picked.length === 0) return;
      const file = picked[0].fsPath;
      const dir = path.dirname(file);
      const id = path.basename(file, path.extname(file));
      const source = new DiskFaultSource(dir, path.basename(dir) || dir, true);
      FaultPanel.show(context, source, id);
      out.appendLine(`Opened crash report ${file}.`);
    }),

    // Add a folder of crash files as a persistent (session) source.
    vscode.commands.registerCommand('loom.faults.addFolder', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Add Crash Folder',
      });
      if (!picked || picked.length === 0) return;
      view.addFolder(picked[0].fsPath);
      out.appendLine(`Added crash folder ${picked[0].fsPath}.`);
    }),

    // Attach a running runtime as a source (its data dir may be remote, e.g. a Pi).
    vscode.commands.registerCommand('loom.faults.addRuntime', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'Loom runtime URL to read faults from',
        value: serverUrl(),
        placeHolder: 'http://host:8080',
      });
      if (!url) return;
      view.addRuntime(url.replace(/\/+$/, ''));
      out.appendLine(`Added runtime crash source ${url}.`);
    }),

    vscode.commands.registerCommand('loom.faults.removeSource', (node: unknown) => {
      const n = node as { source?: { id?: string } } | undefined;
      if (n?.source?.id) view.removeSource(n.source.id);
    }),

    vscode.commands.registerCommand('loom.faults.openFrame', async (arg: unknown) => {
      const { file, line } = (arg ?? {}) as { file?: string; line?: number };
      if (!file) return;
      const resolved = resolveSourcePath(file);
      if (!resolved) {
        vscode.window.showWarningMessage(
          `Source not found on this machine: ${file}. ` +
          `Open the matching checkout or set 'loom.repoPath'.`,
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(resolved);
      const ln = Math.max(0, (line ?? 1) - 1); // report lines are 1-based
      const pos = new vscode.Position(ln, 0);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        viewColumn: vscode.ViewColumn.One,
      });
      const editor = vscode.window.activeTextEditor;
      if (editor) editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      out.appendLine(`Opened ${resolved}:${line} from crash frame.`);
    }),
  );
}
