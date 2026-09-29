/** Recently run palette commands (per browser, best effort). */
import { ref } from 'vue';

const KEY = 'cubby-slicer:recent-actions';
const MAX = 8;

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : [];
  } catch { return []; }
}

export const recentActionIds = ref<string[]>(load());

export function recordRecent(id: string): void {
  recentActionIds.value = [id, ...recentActionIds.value.filter((x) => x !== id)].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(recentActionIds.value)); } catch { /* ignore */ }
}
