import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { getExtensionOutput } from '../util/output';

const exec = promisify(execCb);

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  assets: GitHubAsset[];
  html_url: string;
}

/** Fetch the latest Loom release from GitHub, download the asset matching
 *  the user's platform/arch, extract it under the extension's globalStorage
 *  directory, and update the loom.runtimeExecutable / loom.moduleDir
 *  settings to point at the extracted binary. */
export async function installLoomRuntime(context: vscode.ExtensionContext): Promise<void> {
  const out = getExtensionOutput();
  const cfg = vscode.workspace.getConfiguration('loom');
  const repo = cfg.get<string>('releaseRepo', '').trim();
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    vscode.window.showErrorMessage(
      `Set 'loom.releaseRepo' to the GitHub repo (form: owner/Loom). Current value: '${repo || '(empty)'}'`,
    );
    return;
  }

  out.show(true);
  out.appendLine(`▶ Installing Loom from github.com/${repo}`);

  // 1. Fetch latest release.
  let release: GitHubRelease;
  try {
    release = await fetchJson<GitHubRelease>(`https://api.github.com/repos/${repo}/releases/latest`);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Cannot fetch latest release from ${repo}: ${(e as Error).message}. ` +
      `Visit https://github.com/${repo}/releases to download manually.`,
    );
    return;
  }

  out.appendLine(`  found release ${release.tag_name} with ${release.assets.length} asset(s)`);

  // 2. Pick asset for our platform.
  const assetTemplate = cfg.get<string>('releaseAssetTemplate', 'loom-{platform}-{arch}.tar.gz');
  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch;          // arm64 | x64 | ...
  const assetName = assetTemplate
    .replace('{platform}', platform)
    .replace('{arch}', arch);

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const available = release.assets.map((a) => a.name).join(', ') || '(none)';
    vscode.window.showErrorMessage(
      `No asset named '${assetName}' in ${release.tag_name}. Available: ${available}. ` +
      `Adjust 'loom.releaseAssetTemplate' if your release uses a different naming scheme.`,
    );
    return;
  }
  out.appendLine(`  asset: ${asset.name} (${formatBytes(asset.size)})`);

  // 3. Prepare target directory under the extension's globalStorageUri.
  const installRoot = vscode.Uri.joinPath(context.globalStorageUri, 'runtimes').fsPath;
  const versionDir = path.join(installRoot, release.tag_name);
  await fs.mkdir(versionDir, { recursive: true });

  const archivePath = path.join(versionDir, asset.name);

  // 4. Download with progress.
  try {
    await downloadWithProgress(asset.browser_download_url, archivePath, asset.size, asset.name);
  } catch (e) {
    vscode.window.showErrorMessage(`Download failed: ${(e as Error).message}`);
    return;
  }
  out.appendLine(`  downloaded -> ${archivePath}`);

  // 5. Extract.
  try {
    await extractArchive(archivePath, versionDir);
  } catch (e) {
    vscode.window.showErrorMessage(`Extraction failed: ${(e as Error).message}`);
    return;
  }
  out.appendLine(`  extracted into ${versionDir}`);

  // Clean up the archive once extracted.
  try { await fs.unlink(archivePath); } catch { /* ignore */ }

  // 6. Locate binary + modules dir.
  const binary = await findBinary(versionDir);
  if (!binary) {
    vscode.window.showErrorMessage(
      `Could not find the loom binary inside ${versionDir} after extraction. ` +
      `The release archive may have an unexpected layout.`,
    );
    return;
  }
  const modules = await findModulesDir(versionDir);
  out.appendLine(`  binary  : ${binary}`);
  if (modules) out.appendLine(`  modules : ${modules}`);

  // 7. Make sure the binary is executable (tar usually preserves bits, but be safe on POSIX).
  if (process.platform !== 'win32') {
    try { await fs.chmod(binary, 0o755); } catch { /* ignore */ }
  }

  // 8. Verify it runs.
  try {
    const { stdout } = await exec(`"${binary}" --version`, { timeout: 5000 });
    out.appendLine(`  ${binary} --version -> ${stdout.trim()}`);
  } catch (e) {
    out.appendLine(`  warning: \`${binary} --version\` did not return cleanly: ${(e as Error).message}`);
  }

  // 9. Update settings (Global so they persist across workspaces).
  const target = vscode.ConfigurationTarget.Global;
  await cfg.update('runtimeExecutable', binary, target);
  if (modules) await cfg.update('systemModuleDir', modules, target);
  // Clear any legacy loom.moduleDir override so the new userModuleDir /
  // systemModuleDir split is the single source of truth going forward.
  // (No-op if the user never set it.)
  if (cfg.inspect<string>('moduleDir')?.globalValue) {
    await cfg.update('moduleDir', undefined, target);
  }
  // Make sure ~/.loom/data exists as a fallback for when the user starts
  // the runtime outside any workspace. We don't pin loom.dataDir to it —
  // the workspace-relative default ${workspaceFolder}/data is preferred
  // when a project is open.
  const fallbackDataDir = path.join(os.homedir(), '.loom', 'data');
  await fs.mkdir(fallbackDataDir, { recursive: true });

  // 10. Register the install with CMake's user package registry so module
  //     projects can `find_package(loom CONFIG REQUIRED)` without any
  //     CMAKE_PREFIX_PATH or env-var setup.
  //
  //     Compute the install prefix from where the binary actually lives:
  //       <install>/loom              -> prefix = dirname(binary)
  //       <install>/bin/loom          -> prefix = dirname(dirname(binary))
  const binParent = path.dirname(binary);
  const cmakePrefix = path.basename(binParent) === 'bin' ? path.dirname(binParent) : binParent;
  const configDir = path.join(cmakePrefix, 'lib', 'cmake', 'loom');
  if (fsSync.existsSync(configDir)) {
    try {
      const where = await registerCmakePackage(configDir);
      out.appendLine(`  registered with CMake at ${where}`);
    } catch (e) {
      out.appendLine(`  warning: failed to register with CMake user package registry: ${(e as Error).message}`);
    }
  } else {
    out.appendLine(`  skipped CMake user package registry: no lib/cmake/loom in this release`);
    out.appendLine(`    (cut a Loom release with the SDK bundling workflow to enable find_package(loom))`);
  }

  out.appendLine(`✓ Installed Loom ${release.tag_name}.`);
  vscode.window.showInformationMessage(
    `Installed Loom ${release.tag_name}. You can now run "Loom: Start Runtime".`,
  );
}

/** Write a CMake user package registry entry pointing at this install's
 *  loomConfig.cmake. After this, any CMake project on this user's
 *  machine that does `find_package(loom CONFIG REQUIRED)` will find the
 *  SDK shipped in the binary release — no CMAKE_PREFIX_PATH, no env vars.
 *
 *  POSIX: writes `~/.cmake/packages/loom/loomui` containing the absolute
 *  path to configDir.
 *  Windows: writes HKCU\Software\Kitware\CMake\Packages\loom\loomui via
 *  reg.exe with the same path as the value's data.
 *
 *  Returns the location of the registry entry. */
async function registerCmakePackage(configDir: string): Promise<string> {
  if (process.platform === 'win32') {
    // CMake reads HKEY_CURRENT_USER\Software\Kitware\CMake\Packages\<name>.
    // Each value's data is an absolute path to a dir containing
    // <name>Config.cmake. Value name can be anything; we use "loomui" so
    // reinstalls overwrite the same entry instead of accumulating.
    const key = 'HKCU\\Software\\Kitware\\CMake\\Packages\\loom';
    await exec(`reg add "${key}" /v "loomui" /t REG_SZ /d "${configDir}" /f`);
    return `${key}\\loomui`;
  }

  // POSIX: each file under ~/.cmake/packages/<name>/ contains a path that
  // CMake adds to its search list. Filename is arbitrary; using "loomui"
  // (instead of a random hash) means reinstalls cleanly overwrite.
  const registryDir = path.join(os.homedir(), '.cmake', 'packages', 'loom');
  await fs.mkdir(registryDir, { recursive: true });
  const entryPath = path.join(registryDir, 'loomui');
  await fs.writeFile(entryPath, configDir, 'utf8');
  return entryPath;
}

// ---------- helpers ----------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'LoomUI-vscode-extension',
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function downloadWithProgress(
  url: string,
  destination: string,
  totalBytes: number,
  filename: string,
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${filename}…`,
      cancellable: false,
    },
    async (progress) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'LoomUI-vscode-extension' } });
      if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);

      const file = fsSync.createWriteStream(destination);
      let written = 0;
      let lastReport = 0;
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(value);
          written += value.length;
          // Throttle progress reports to once per ~256kb to keep the UI calm.
          if (written - lastReport > 256 * 1024) {
            const pct = totalBytes > 0 ? (written / totalBytes) * 100 : 0;
            progress.report({
              increment: ((written - lastReport) / totalBytes) * 100,
              message: `${formatBytes(written)} / ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`,
            });
            lastReport = written;
          }
        }
      } finally {
        await new Promise<void>((resolve) => file.end(resolve));
      }
    },
  );
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  // Both `tar -xzf` and `tar -xJf` work on macOS/Linux and Windows 10 1803+.
  // For .zip we'd need a different command; .tar.gz is the convention here.
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await exec(`powershell -NoProfile -Command "Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force"`);
    } else {
      await exec(`unzip -o -q "${archive}" -d "${dest}"`);
    }
    return;
  }
  // tar handles .tar.gz, .tgz, .tar.xz transparently with -xaf on macOS;
  // be explicit for portability.
  const flag = archive.endsWith('.xz') ? '-xJf' : '-xzf';
  await exec(`tar ${flag} "${archive}" -C "${dest}"`);
}

/** Locate the loom binary at the root or one level deep inside `dir`. */
async function findBinary(dir: string): Promise<string | undefined> {
  const exeName = process.platform === 'win32' ? 'loom.exe' : 'loom';
  const direct = path.join(dir, exeName);
  if (fsSync.existsSync(direct)) return direct;

  // Common conventions: loom-<version>/loom or loom-<version>/bin/loom.
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const sub = path.join(dir, entry);
    let stat;
    try { stat = await fs.stat(sub); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const candidates = [
      path.join(sub, exeName),
      path.join(sub, 'bin', exeName),
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) return c;
    }
  }
  return undefined;
}

/** Locate a `modules/` (or `lib/modules/`) directory under `dir`. */
async function findModulesDir(dir: string): Promise<string | undefined> {
  const root = path.join(dir, 'modules');
  if (fsSync.existsSync(root)) return root;
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return undefined; }
  for (const entry of entries) {
    const sub = path.join(dir, entry);
    const candidates = [
      path.join(sub, 'modules'),
      path.join(sub, 'lib', 'modules'),
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) return c;
    }
  }
  return undefined;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
