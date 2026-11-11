import { describe, expect, it } from 'vitest';
import {
  emptyPermissions, filesystemSafeEscape, installDirName, isIgnoredPluginDirectory, localPluginKey, newInstallState, parseInstallState,
  serializeInstallState,
} from './installState';
import { CapabilityConfigDocument, effectiveConfig, presetOverrideScope } from './config';
import { mergePermissions, networkAllowed, normalizeNetworkUrl, outstandingRequest } from './permissions';
import { memoryFs } from './storage';

describe('install folder and plugin key (PluginDescriptor.hpp)', () => {
  it('escapes like filesystem_safe_escape', () => {
    expect(filesystemSafeEscape('orca gcode stamp (1).py')).toBe('orca_gcode_stamp_1_.py');
    expect(filesystemSafeEscape('ünï')).toBe('_n_');
    expect(filesystemSafeEscape('')).toBe('path');
    expect(localPluginKey('orca_gcode_stamp_plugin_any.py')).toBe('orca_gcode_stamp_plugin_any');
    expect(installDirName('orca_gcode_stamp_plugin_any.py')).toBe('orca_gcode_stamp_plugin_any.py');
  });
  it('ignores hidden, dunder, _subscribed and plugin_data folders', () => {
    for (const n of ['.git', '__pycache__', '_subscribed', 'plugin_data']) expect(isIgnoredPluginDirectory(n)).toBe(true);
    expect(isIgnoredPluginDirectory('my.py')).toBe(false);
  });
});

describe('.install_state.json', () => {
  it('writes Orca\'s shape: sorted keys, capabilities as single-key objects, 2-space indent', () => {
    const s = { ...newInstallState('G-code Stamp', '0.01', undefined), capabilities: [['G-code Stamp', true], ['Other', false]] as [string, boolean][] };
    s.permissions.network_http = ['https://example.com'];
    const text = serializeInstallState(s);
    expect(JSON.parse(text)).toEqual({
      capabilities: [{ 'G-code Stamp': true }, { Other: false }], enabled: true, installed_from: 'local', installed_version: '0.01',
      permissions: { events: [], fs_read: [], fs_readwrite: [], full_access: false, network_http: ['https://example.com'], network_socket: [], process: [], threading: false },
      plugin_name: 'G-code Stamp',
    });
    expect(text.split('\n')[1]).toBe('  "capabilities": [');
    expect(Object.keys(JSON.parse(text))).toEqual(['capabilities', 'enabled', 'installed_from', 'installed_version', 'permissions', 'plugin_name']);
  });

  it('round-trips and keeps the cubby block', () => {
    const s = newInstallState('X', '1', { source: 'url', url: 'https://a/b.py', sha256: 'ab', installedAt: 5 });
    const r = parseInstallState(serializeInstallState(s));
    expect(r).toEqual({ status: 'readable', state: { ...s, cloud_uuid: '' } });
  });

  it('reads leniently like Orca (old threading forms, only boolean full_access, missing keys)', () => {
    const r = parseInstallState(JSON.stringify({ permissions: { threading: ['yes'], full_access: 'true', fs_read: ['/a', 3] }, capabilities: [{ A: true, B: 'no' }, 'junk'] }));
    expect(r.status).toBe('readable');
    if (r.status !== 'readable') return;
    expect(r.state.permissions.threading).toBe(true);
    expect(r.state.permissions.full_access).toBe(false);
    expect(r.state.permissions.fs_read).toEqual(['/a']);
    expect(r.state.capabilities).toEqual([['A', true]]);
    expect(r.state.enabled).toBe(true);
    expect(parseInstallState(JSON.stringify({ permissions: { threading: '' } })).status).toBe('readable');
  });

  it('reports unreadable / missing sidecars', () => {
    expect(parseInstallState('{nope').status).toBe('unreadable');
    expect(parseInstallState('[]').status).toBe('unreadable');
    expect(parseInstallState(null).status).toBe('missing');
  });
});

describe('capability config (PluginConfig.cpp)', () => {
  const id = { pluginKey: 'orca_gcode_stamp_plugin_any', type: 'slicing-pipeline' as const, name: 'G-code Stamp' };

  it('writes config.json as {"config":[…]} with tab indent, a trailing newline and sorted entries', () => {
    const d = new CapabilityConfigDocument();
    d.upsert({ id: { ...id, pluginKey: 'z' }, pluginVersion: '1', config: { a: 1 } });
    d.upsert({ id, pluginVersion: '0.01', config: { stamp_text: 'hi' } });
    const text = d.toFile();
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n\t"config": [');
    const j = JSON.parse(text);
    expect(j.config[0]).toEqual({ cap_config: { stamp_text: 'hi' }, capability: 'G-code Stamp', capability_type: 'slicing-pipeline', plugin_key: 'orca_gcode_stamp_plugin_any', plugin_version: '0.01' });
    expect(j.config[1].plugin_key).toBe('z');
  });

  it('keeps unrecognised entries and unknown keys; legacy untyped entries stay addressable', () => {
    const d = CapabilityConfigDocument.parseFile(JSON.stringify({ config: [
      { plugin_key: 'orca_gcode_stamp_plugin_any', capability: 'G-code Stamp', plugin_version: '0', cap_config: { x: 1 }, extra: true },
      { something: 'else' },
    ] }));
    expect(d.find(id)).toEqual({ id, pluginVersion: '0', config: { x: 1 } });
    d.upsert({ id, pluginVersion: '1', config: { x: 2 } });
    const out = d.serializeEntries();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ capability_type: 'slicing-pipeline', cap_config: { x: 2 } });
    expect(out[1]).toEqual({ something: 'else' });
    expect(out[0]).not.toHaveProperty('extra');
  });

  it('parses preset overrides with Orca\'s errors and serializes compactly ("" when empty)', () => {
    expect(() => CapabilityConfigDocument.parseOverrides('{')).toThrow('The preset stores invalid plugin capability configuration JSON.');
    expect(() => CapabilityConfigDocument.parseOverrides('{}')).toThrow('not an array');
    const d = CapabilityConfigDocument.parseOverrides('');
    expect(d.toOverrides()).toBe('');
    d.upsert({ id, pluginVersion: '1', config: { a: 1 } });
    expect(d.toOverrides()).toBe('[{"cap_config":{"a":1},"capability":"G-code Stamp","capability_type":"slicing-pipeline","plugin_key":"orca_gcode_stamp_plugin_any","plugin_version":"1"}]');
    expect(d.pruneUnreferenced([['slicing-pipeline', 'Other']])).toBe(true);
    expect(d.empty).toBe(true);
  });

  it('resolves the effective config: preset override, else global, else {}', () => {
    const g = new CapabilityConfigDocument();
    expect(effectiveConfig(g, null, id)).toEqual({ config: {}, hasPresetOverride: false, hasBaseConfig: false, storedPluginVersion: '' });
    g.upsert({ id, pluginVersion: '1', config: { g: 1 } });
    const o = new CapabilityConfigDocument();
    expect(effectiveConfig(g, o, id).config).toEqual({ g: 1 });
    o.upsert({ id, pluginVersion: '2', config: { p: 1 } });
    expect(effectiveConfig(g, o, id)).toEqual({ config: { p: 1 }, hasPresetOverride: true, hasBaseConfig: true, storedPluginVersion: '2' });
    expect(presetOverrideScope('script')).toBeNull();
    expect(presetOverrideScope('slicing-pipeline')).toEqual({ kind: 'process', key: 'print_plugin_config_overrides' });
  });
});

describe('permissions', () => {
  it('normalizes network URLs to scheme://host', () => {
    expect(normalizeNetworkUrl('HTTPS://User@Example.com:8443/a?b#c')).toBe('https://example.com');
    expect(normalizeNetworkUrl('ftp://x')).toBe('');
    expect(normalizeNetworkUrl('https://')).toBe('');
    expect(normalizeNetworkUrl('http://[::1]:80/')).toBe('http://[::1]');
  });
  it('matches host-wide grants and exact legacy URLs', () => {
    expect(networkAllowed(['https://example.com'], 'https://example.com:444/x')).toBe(true);
    expect(networkAllowed(['https://example.com'], 'http://example.com/x')).toBe(false);
    expect(networkAllowed(['https://a.com/exact?q'], 'https://a.com/exact?q')).toBe(true);
    expect(networkAllowed(['https://a.com/exact?q'], 'https://a.com/other')).toBe(false);
  });
  it('asks only for what is not granted yet', () => {
    const g = { ...emptyPermissions(), network_http: ['https://a.com'] };
    expect(outstandingRequest(g, { ...emptyPermissions(), network_http: ['https://a.com'] })).toBeNull();
    expect(outstandingRequest(g, { ...emptyPermissions(), network_http: ['https://a.com', 'https://b.com'], threading: true }))
      .toMatchObject({ network_http: ['https://b.com'], threading: true });
    expect(mergePermissions(g, { network_http: ['https://b.com'] }).network_http).toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('memory plugin storage', () => {
  it('lists, renames and removes trees', async () => {
    const fs = memoryFs();
    await fs.write('orca_plugins/a.py/a.py', 'x');
    await fs.write('orca_plugins/a.py/.install_state.json', '{}');
    await fs.write('orca_plugins/config.json', '{}');
    expect((await fs.list('orca_plugins')).sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'a.py', kind: 'directory' }, { name: 'config.json', kind: 'file' }]);
    await fs.rename('orca_plugins/a.py', 'orca_plugins/b.py');
    expect(await fs.readText('orca_plugins/b.py/a.py')).toBe('x');
    await fs.remove('orca_plugins/b.py');
    expect(await fs.list('orca_plugins/b.py')).toEqual([]);
  });
});
