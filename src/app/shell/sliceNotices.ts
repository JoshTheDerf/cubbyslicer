/**
 * Orca-style slicing notifications in the bottom-right toast area: a sticky
 * error card when a slice fails (with the engine's warning list), and a
 * warnings card after a successful slice that reported any. Both are replaced
 * in place and cleared when the next slice starts.
 */
import { watch } from 'vue';
import type { SliceWarning } from '../../engine/types';
import { dismissToast, toast } from '../../ui';
import { activeView, lastSlice } from '../state';
import type { SliceControllerLike } from './external';

const ERROR_ID = 'slice-error';
const WARN_ID = 'slice-warnings';
const MAX_LINES = 8;

export function formatWarnings(ws: SliceWarning[], max = MAX_LINES): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const w of ws) {
    const t = w.message.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    lines.push(`• ${t}`);
  }
  const more = lines.length - max;
  return lines.slice(0, max).join('\n') + (more > 0 ? `\n+${more} more` : '');
}

export function installSliceNotices(slicer: SliceControllerLike): () => void {
  return watch(() => slicer.status.value, (s, prev) => {
    if (s === 'slicing') { dismissToast(ERROR_ID); dismissToast(WARN_ID); return; }
    if (prev !== 'slicing') return;
    if (s === 'error') {
      const ws = slicer.errorReport.value?.warnings ?? [];
      const msg = slicer.error.value ?? 'The engine stopped without a reason.';
      toast.error('Slicing failed', {
        id: ERROR_ID, timeout: 0,
        detail: ws.length ? `${msg}\n\n${formatWarnings(ws)}` : msg,
        action: activeView.value === 'preview' ? { label: 'Back to Prepare', run: () => { activeView.value = 'prepare'; } } : undefined,
      });
    } else if (s === 'done') {
      const ws = lastSlice.value?.report.warnings ?? [];
      if (ws.length) {
        toast.warn(`Sliced with ${ws.length === 1 ? 'a warning' : `${ws.length} warnings`}`, {
          id: WARN_ID, timeout: 0, detail: formatWarnings(ws),
        });
      }
    }
  });
}
