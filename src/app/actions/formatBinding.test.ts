import { describe, expect, it } from 'vitest';
import { formatBinding, formatBindingTokens } from './formatBinding';

describe('formatBinding', () => {
  it('formats modifiers in Ctrl, Alt, Shift order', () => {
    expect(formatBinding({ key: 'z', ctrlOrMeta: true, shift: true }, 'other')).toBe('Ctrl+Shift+Z');
    expect(formatBinding({ key: 'f', alt: true, shift: true }, 'other')).toBe('Alt+Shift+F');
    expect(formatBindingTokens({ key: 's', ctrlOrMeta: true }, 'other')).toEqual(['Ctrl', 'S']);
  });
  it('uses macOS glyphs', () => {
    expect(formatBindingTokens({ key: 'z', ctrlOrMeta: true, shift: true }, 'mac')).toEqual(['⌘', '⇧', 'Z']);
    expect(formatBinding({ key: 'k', ctrlOrMeta: true }, 'mac')).toBe('⌘K');
  });
  it('labels special keys and codes', () => {
    expect(formatBinding({ key: 'delete' }, 'other')).toBe('Del');
    expect(formatBinding({ key: 'escape' }, 'other')).toBe('Esc');
    expect(formatBinding({ key: ' ' }, 'other')).toBe('Space');
    expect(formatBinding({ key: '?' }, 'other')).toBe('?');
    expect(formatBinding({ key: 'f2' }, 'other')).toBe('F2');
    expect(formatBinding({ code: 'Numpad1', ctrlOrMeta: true }, 'other')).toBe('Ctrl+Numpad 1');
  });
  it('is empty for keyless bindings and honours displayTokens', () => {
    expect(formatBinding(undefined)).toBe('');
    expect(formatBinding({}, 'other')).toBe('');
    expect(formatBindingTokens({ key: 'x', displayTokens: ['Enter', 'Esc'] }, 'other')).toEqual(['Enter', 'Esc']);
  });
});
