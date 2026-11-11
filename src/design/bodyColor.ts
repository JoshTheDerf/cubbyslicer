/**
 * Orca's body Color: the system colour picker seeded with the body's colour (a transient
 * `<input type="color">`, so it works from the offer menu, the Bodies list and the bridge-less
 * UI alike). The choice is one edit (`set_body`, saved in the design).
 */
import { rgbaToHex, setBodyColor } from './commands';
import { design, setStatus } from './session';
import { toast } from '../ui';

export function pickBodyColor(b: number): void {
  const body = design.bodies[b];
  if (!body) { setStatus('warn', 'Select a body first'); return; }
  const input = document.createElement('input');
  input.type = 'color';
  input.value = rgbaToHex(body.color) || '#a9b4c2';
  input.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(input);
  const done = () => { input.remove(); };
  input.addEventListener('change', () => {
    setBodyColor(b, input.value).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
    done();
  }, { once: true });
  input.addEventListener('blur', () => setTimeout(done, 500), { once: true });
  input.click();
}
