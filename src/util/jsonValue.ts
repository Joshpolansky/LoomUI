export type ParsedValue =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parse a free-form text input into a JSON-shaped value.
 *  Recognises numbers, booleans, null, JSON literals, and falls back to
 *  treating the input as a bare string. Rejects empty input. */
export function parseValue(raw: string): ParsedValue {
  const t = raw.trim();
  if (t === '') return { ok: false, error: 'empty value' };
  if (t === 'true')  return { ok: true, value: true };
  if (t === 'false') return { ok: true, value: false };
  if (t === 'null')  return { ok: true, value: null };
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return { ok: true, value: n };
  }
  // JSON literal (quoted strings, arrays, objects).
  try { return { ok: true, value: JSON.parse(t) }; } catch { /* fall through */ }
  // Bare string.
  return { ok: true, value: raw };
}

/** Encode a path segment for a JSON Pointer (RFC 6901). */
export function jsonPointerEscape(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Encode (moduleId, section, path) into a Variable.evaluateName string we
 *  can decode in a context-menu command. JSON keeps it unambiguous when
 *  path segments contain `/`, `:`, or other special characters. */
export function encodeEvalName(moduleId: string, section: string, path: string[]): string {
  return JSON.stringify({ m: moduleId, s: section, p: path });
}

export interface EvalDescriptor {
  moduleId: string;
  section: 'config' | 'recipe' | 'runtime' | 'summary';
  path: string[];
}

export function decodeEvalName(s: string | undefined): EvalDescriptor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(s) as { m?: unknown; s?: unknown; p?: unknown };
    if (typeof obj.m !== 'string' || typeof obj.s !== 'string' || !Array.isArray(obj.p)) return null;
    if (!['config', 'recipe', 'runtime', 'summary'].includes(obj.s)) return null;
    if (!obj.p.every((seg) => typeof seg === 'string')) return null;
    return { moduleId: obj.m, section: obj.s as EvalDescriptor['section'], path: obj.p as string[] };
  } catch {
    return null;
  }
}

export function deepSet(target: unknown, path: string[], value: unknown): void {
  if (path.length === 0) return;
  let cur: unknown = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur && typeof cur === 'object') {
    (cur as Record<string, unknown>)[path[path.length - 1]] = value;
  }
}
