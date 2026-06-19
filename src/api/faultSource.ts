import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { LoomClient } from './client';
import type { FaultSummary, FaultDetail } from './types';

/**
 * A place fault reports come from. Disk is the primary model (crash files exist
 * whether or not the runtime is alive — which is exactly when you want them); a
 * running runtime is just one more source. Each source lists summaries and
 * fetches a full report by id.
 */
export interface FaultSource {
  /** Stable key (used for de-dup, removal, and panel keying). */
  readonly id: string;
  /** Short display name shown on the source row. */
  readonly label: string;
  /** Path or URL — shown in the description/tooltip. */
  readonly detailText: string;
  /** ThemeIcon id for the source row. */
  readonly icon: string;
  /** User-added sources can be removed; the auto local data dir cannot. */
  readonly removable: boolean;
  list(): Promise<FaultSummary[]>;
  detail(id: string): Promise<FaultDetail | undefined>;
  /** Directory exists / runtime reachable — drives the source row's status. */
  available(): Promise<boolean>;
}

/** Build a list summary from a parsed report JSON (mirrors the runtime's
 *  FaultStore::summarize). `stem` is the filename without extension == report id. */
function summarize(stem: string, doc: unknown): FaultSummary {
  const d = (doc ?? {}) as Record<string, unknown>;
  const bc = (d.breadcrumb ?? {}) as Record<string, unknown>;
  return {
    id: stem,
    ts: typeof d.ts === 'number' ? d.ts : 0,
    kind: typeof d.kind === 'string' ? d.kind : 'raw',
    module: typeof bc.module === 'string' ? bc.module : '',
    class: typeof bc.class === 'string' ? bc.class : '',
    phase: typeof bc.phase === 'string' ? bc.phase : '',
    reason: typeof d.reason === 'string' ? d.reason : '',
  };
}

/**
 * Reads crash reports straight from a directory of files written by the runtime:
 *   <dir>/<id>.json          structured reports (exception + Windows signal/SEH)
 *   <dir>/loom-crash-*.txt   POSIX signal-path raw reports (symbolize offline)
 */
export class DiskFaultSource implements FaultSource {
  readonly id: string;
  readonly icon = 'folder';

  constructor(
    public readonly dir: string,
    public readonly label: string,
    public readonly removable = false,
  ) {
    this.id = 'dir:' + path.resolve(dir);
  }

  get detailText(): string { return this.dir; }

  async available(): Promise<boolean> {
    try { return fsSync.existsSync(this.dir) && (await fs.stat(this.dir)).isDirectory(); }
    catch { return false; }
  }

  async list(): Promise<FaultSummary[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.dir); }
    catch { return []; }

    const out: FaultSummary[] = [];
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      const stem = name.slice(0, name.length - ext.length);
      const full = path.join(this.dir, name);
      if (ext === '.json') {
        try { out.push(summarize(stem, JSON.parse(await fs.readFile(full, 'utf8')))); }
        catch { /* skip unparseable */ }
      } else if (ext === '.txt' && stem.startsWith('loom-crash-')) {
        out.push({ id: stem, ts: 0, kind: 'raw', module: '', class: '', phase: '', reason: 'raw report — symbolize offline' });
      }
    }
    out.sort((a, b) => b.ts - a.ts); // newest first
    return out;
  }

  async detail(id: string): Promise<FaultDetail | undefined> {
    const jsonPath = path.join(this.dir, id + '.json');
    if (fsSync.existsSync(jsonPath)) {
      try { return JSON.parse(await fs.readFile(jsonPath, 'utf8')) as FaultDetail; }
      catch { return undefined; }
    }
    const txtPath = path.join(this.dir, id + '.txt');
    if (fsSync.existsSync(txtPath)) {
      try { return { id, kind: 'raw', raw: await fs.readFile(txtPath, 'utf8') }; }
      catch { return undefined; }
    }
    return undefined;
  }
}

/** Reads from a running Loom runtime over REST (/api/faults). Useful when the
 *  runtime's data dir isn't on this machine (e.g. a Pi reached over the LAN). */
export class RestFaultSource implements FaultSource {
  readonly icon = 'radio-tower';
  readonly removable = true;
  readonly id: string;
  private readonly client: LoomClient;

  constructor(public readonly url: string, public readonly label = 'Runtime') {
    this.id = 'rest:' + url;
    this.client = new LoomClient(() => url);
  }

  get detailText(): string { return this.url; }

  async available(): Promise<boolean> {
    try { await this.client.getFaults(); return true; } catch { return false; }
  }

  list(): Promise<FaultSummary[]> { return this.client.getFaults().catch(() => []); }
  detail(id: string): Promise<FaultDetail | undefined> {
    return this.client.getFault(id).catch(() => undefined);
  }
}
