import * as vscode from 'vscode';
import * as fsSync from 'fs';
import * as path from 'path';
import type { LoomClient } from '../api/client';
import type { FaultsProvider } from '../views/faultsView';
import { FaultNode } from '../views/faultsView';
import { FaultPanel } from '../webview/faultPanel';
import { resolvePaths } from '../util/paths';
import { getExtensionOutput } from '../util/output';

/**
 * Resolve a build-time source path to one that exists on this machine, then
 * jump to the given line. Strategy (mirrors loom.modules.openSource):
 *   1. The absolute path captured at build time (dev builds, same machine).
 *   2. Remap under loom.repoPath by the repo-directory name (crash from another
 *      checkout / CI of the same tree).
 * Returns the resolved path, or undefined if it can't be located.
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
  client: LoomClient,
  view: FaultsProvider,
): void {
  const out = getExtensionOutput();

  context.subscriptions.push(
    vscode.commands.registerCommand('loom.faults.refresh', () => view.refresh()),

    vscode.commands.registerCommand('loom.faults.openReport', async (idOrNode: unknown) => {
      let id: string | undefined;
      if (idOrNode instanceof FaultNode) id = idOrNode.info.id;
      else if (typeof idOrNode === 'string') id = idOrNode;
      else {
        try {
          const list = await client.getFaults();
          if (list.length === 0) { vscode.window.showInformationMessage('No faults recorded.'); return; }
          const pick = await vscode.window.showQuickPick(
            list.map((f) => ({
              label: `${f.module || '(runtime)'} · ${f.phase || '?'}`,
              description: `${f.kind}${f.reason ? ' · ' + f.reason : ''}`,
              id: f.id,
            })),
            { placeHolder: 'Open crash report' },
          );
          id = pick?.id;
        } catch (e) {
          vscode.window.showErrorMessage(`Cannot reach Loom: ${(e as Error).message}`);
          return;
        }
      }
      if (!id) return;
      FaultPanel.show(context, client, id);
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
