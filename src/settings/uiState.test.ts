import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { activeKind, openSettingsTab, settingsUi, toggleGroup } from './uiState';

describe('settings UI state', () => {
  it('opens process in the sidebar and printer / filament in their dialog', async () => {
    settingsUi.region = 'objects';
    settingsUi.collapsedSections = ['process'];
    openSettingsTab('process');
    expect(settingsUi).toMatchObject({ editor: null, region: 'global', tab: 'process', collapsedSections: [] });
    openSettingsTab('filament', 2);
    expect(settingsUi).toMatchObject({ editor: 'filament', filamentSlot: 2 });
    expect(activeKind()).toBe('filament');
    openSettingsTab('printer');
    await nextTick();
    expect(activeKind()).toBe('printer');
    // closing the dialog hands the save / revert actions back to the process preset
    settingsUi.editor = null;
    await nextTick();
    expect(activeKind()).toBe('process');
  });

  it('toggles option groups (collapsed list)', () => {
    settingsUi.collapsedGroups = [];
    toggleGroup('g1');
    expect(settingsUi.collapsedGroups).toEqual(['g1']);
    toggleGroup('g1', false);
    expect(settingsUi.collapsedGroups).toEqual(['g1']);
    toggleGroup('g1', true);
    expect(settingsUi.collapsedGroups).toEqual([]);
    toggleGroup('g1');
    toggleGroup('g1');
    expect(settingsUi.collapsedGroups).toEqual([]);
  });
});
