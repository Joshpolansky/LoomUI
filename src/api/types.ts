// Mirrors Loom/frontend/src/types.ts. Keep in sync with the runtime's REST schema.

export interface ModuleStats {
  cycleCount: number;
  overrunCount: number;
  lastCycleTimeUs: number;
  maxCycleTimeUs: number;
  lastJitterUs: number;
}

export interface ModuleInfo {
  id: string;
  name: string;
  className: string;
  version: string;
  state: number;
  path: string;
  /** Absolute path of the .cpp the LOOM_MODULE_HEADER macro was invoked from,
   *  as captured by __FILE__ at module build time. Absent for modules built
   *  before this field was added, or when the build mapped paths (e.g.
   *  -ffile-prefix-map). */
  sourceFile?: string;
  cyclicClass?: string;
  stats?: ModuleStats;
}

export interface ModuleDetail extends ModuleInfo {
  data: {
    config: Record<string, unknown>;
    recipe: Record<string, unknown>;
    runtime: Record<string, unknown>;
    summary: Record<string, unknown>;
  };
}

export interface AvailableModule {
  filename: string;
  className: string;
  version: string;
}

export interface ClassLiveStats {
  lastJitterUs: number;
  lastCycleTimeUs: number;
  maxCycleTimeUs: number;
  tickCount: number;
  memberCount: number;
  lastTickStartMs: number;
}

export interface ClassInfo {
  name: string;
  period_us: number;
  cpu_affinity: number;
  priority: number;
  spin_us: number;
  stats?: ClassLiveStats;
  modules?: string[];
}

export interface ServiceInfo {
  name: string;
  schema: Record<string, unknown> | null;
}

export interface ServiceCallResult {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export type DataSection = 'config' | 'recipe' | 'runtime' | 'summary';

export interface IOMapping {
  index?: number;
  source: string;          // "moduleId.section.path/to/field"
  target: string;
  enabled: boolean;
  status?: string;         // 'resolved' | 'error' | etc.
  error?: string;
}

// --- faults (crash diagnostics) ---
// Mirrors the runtime's loom::diag fault report JSON (see fault_report.cpp).

/** One row in GET /api/faults. */
export interface FaultSummary {
  id: string;
  ts: number;            // system_clock ms (0 for raw signal-path text reports)
  kind: string;          // 'exception' | 'signal' | 'raw'
  module: string;        // '' → runtime code (no module on the faulting thread)
  class: string;
  phase: string;
  reason: string;
}

export interface FaultFrame {
  idx: number;
  address: string;       // "0x...."
  function: string;      // '' if unresolved
  file: string;          // absolute source path ('' if unavailable)
  line: number;          // 0 if unknown
}

export interface FaultSections {
  config: unknown;
  recipe: unknown;
  runtime: unknown;
  summary: unknown;
}

/** GET /api/faults/<id>. `raw` is set instead of the structured fields for
 *  POSIX signal-path text reports that haven't been symbolized. */
export interface FaultDetail {
  id: string;
  ts?: number;
  kind: string;
  signalOrCode?: number;
  reason?: string;
  build?: { sdkVersion: string; gitSha: string; buildType: string };
  breadcrumb?: { module: string; class: string; phase: string; cycle: number };
  frames?: FaultFrame[];
  sections?: FaultSections;
  raw?: string;
}

export const MODULE_STATES: Record<number, string> = {
  0: 'Unloaded',
  1: 'Loaded',
  2: 'Initialized',
  3: 'Running',
  4: 'Stopping',
  5: 'Error',
};

/** One process resource sample from GET /api/system (history points carry only
 *  the chartable series — peak is monotonic and uptime derivable from ts).
 *  heapUsedBytes = live allocations per the allocator's own bookkeeping;
 *  absent/0 on runtimes without the reader (older runtimes, Windows). */
export interface SystemSample {
  ts: number;
  rssBytes: number;
  cpuPercent: number;
  heapUsedBytes?: number;
}

/** GET /api/system — current process memory/CPU + ~10min of 1s history. */
export interface SystemMetrics extends SystemSample {
  peakRssBytes: number;
  uptimeSec: number;
  history: SystemSample[];
}
