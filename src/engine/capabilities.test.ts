import { describe, expect, it } from 'vitest';
import {
  BRIDGE_ABI, bridgeAbiError, calibrationUnavailable, DEFAULT_ENGINE, ENGINE_CAPS, ENGINE_LABELS, ENGINES, engineCaps, isOrcaConfig, toEngineId,
} from './capabilities';

describe('engine capabilities', () => {
  it('lists the engines with one entry each', () => {
    expect(ENGINES).toEqual(['orca', 'preflight']);
    expect(Object.keys(ENGINE_CAPS)).toEqual(ENGINES);
    expect(ENGINE_LABELS).toEqual({ orca: 'OrcaSlicer', preflight: 'preFlight' });
  });

  it('answers per capability instead of per engine id', () => {
    expect(engineCaps('orca')).toMatchObject({ orcaConfig: true, orcaCompat: false, calibration: true, mixedFilaments: true, multiThreaded: true, supportKey: 'enable_support' });
    expect(engineCaps('preflight')).toMatchObject({ orcaConfig: false, orcaCompat: true, calibration: false, mixedFilaments: false, supportKey: 'support_material' });
    expect(engineCaps('orca').flush).toEqual({ matrix: 'flush_volumes_matrix', multiplier: 'flush_multiplier', custom: null });
    expect(engineCaps('preflight').flush).toEqual({ matrix: 'wiping_volumes_matrix', multiplier: null, custom: 'wiping_volumes_use_custom_matrix' });
    expect(isOrcaConfig('orca')).toBe(true);
    expect(isOrcaConfig('preflight')).toBe(false);
  });

  it('maps stored engine ids: known ones as is, retired ones to the default engine', () => {
    expect(toEngineId('orca')).toBe('orca');
    expect(toEngineId('preflight')).toBe('preflight');
    // The Full Spectrum fork was removed (Orca 2.5 mixes natively): its stored id opens Orca.
    expect(toEngineId('fullspectrum')).toBe(DEFAULT_ENGINE);
    expect(DEFAULT_ENGINE).toBe('orca');
    expect(toEngineId('')).toBeNull();
    expect(toEngineId(null)).toBeNull();
    expect(toEngineId(3)).toBeNull();
  });

  it('gates calibration with one message', () => {
    expect(calibrationUnavailable('orca')).toBeNull();
    expect(calibrationUnavailable('preflight')).toMatch(/need the OrcaSlicer engine/);
  });

  it('checks the bridge ABI', () => {
    expect(bridgeAbiError('orca', BRIDGE_ABI.min)).toBeNull();
    expect(bridgeAbiError('orca', BRIDGE_ABI.max + 1)).toMatch(/bridge ABI 2.*needs 1.*fetch-orca-wasm\.sh/);
    expect(bridgeAbiError('preflight', undefined)).toMatch(/ABI \?/);
  });
});
