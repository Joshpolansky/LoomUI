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

export const MODULE_STATES: Record<number, string> = {
  0: 'Unloaded',
  1: 'Loaded',
  2: 'Initialized',
  3: 'Running',
  4: 'Stopping',
  5: 'Error',
};
