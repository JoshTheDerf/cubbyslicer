/** Enable / show rules ported from Orca's ConfigManipulation and Tab*::toggle_options. */
import type { ConfigValue } from '../../engine/types';

/** A reason or label: text, or a C++ ternary over a condition. */
export type RuleText = string | { if: string; then: RuleText; else: RuleText };

export interface RuleToggle {
  /** `enable`: toggle_field / toggle_option (greyed out); `show`: toggle_line (row hidden); `label`: set_option_label. */
  kind: 'enable' | 'show' | 'label';
  key: string;
  /** C++ condition (enable / show). `$key` is the key of the loop the call sits in. */
  when?: string;
  /** Enclosing `if` conditions; the call only runs when all hold. */
  guards?: string[];
  reason?: RuleText;
  /** label: the new label. */
  text?: RuleText;
  /** The call reads the selected nozzle variant (Orca's `variant_index`). */
  perVariant?: boolean;
}

/** Rules of one Orca tab: its toggle calls in source order and the C++ initialisers of the locals they read. */
export interface RuleFamilySource { toggles: RuleToggle[]; locals: Record<string, string> }

export type RuleFamily = 'print' | 'printer' | 'filament';
export type RulesSource = Record<RuleFamily, RuleFamilySource> & { enums: Record<string, string> };

/** Which config a C++ receiver reads: the tab's own (`config->` / `m_config->`), the printer, or the project. */
export type ConfigScopeRef = 'self' | 'printer' | 'project';

/** What the rules can see. Configs are read lazily, so a computed only depends on the keys a rule reads. */
export interface RuleContext {
  /** Raw value of `key` in a config (`undefined` when the config has no such key). */
  read(scope: ConfigScopeRef, key: string): ConfigValue | undefined;
  /** Element index for per-variant reads (Orca `variant_index`): the extruder / variant being edited. */
  variantIndex: number;
  /** Printer vendor is Bambu Lab (Orca `is_bbl_vendor()`). */
  isBBL: boolean;
  /** Settings mode: 0 simple, 1 advanced, 2 expert (Orca `m_mode`, comDevelop = 3 never applies). */
  mode: number;
  /** Physical extruder count of the printer. */
  extruderCount: number;
  /** Global process settings (false: per-object overrides). */
  isGlobal: boolean;
}

/** State of one setting row after the rules ran. */
export interface RowState {
  hidden?: boolean;
  disabled?: boolean;
  /** Why it is hidden / disabled (Orca's "Hidden: …" / "Disabled: …"). */
  reason?: string;
  /** Label override (Orca set_option_label). */
  label?: string;
}
