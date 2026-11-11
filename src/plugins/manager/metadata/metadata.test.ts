import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractPep723Block, parsePep723Toml, readPythonPluginMetadata } from './pep723';
import { normalizePackageName, parseCoreMetadata, readWheelMetadata, wheelFileCompatible } from './wheel';

const STAMP_HEADER = `# /// script
# requires-python = ">=3.12"
#
# [tool.orcaslicer.plugin]
# name = "G-code Stamp"
# description = "Stamps a comment line into the exported G-code at the post-process step (demo)."
# author = "OrcaSlicer"
# version = "0.01"
# type = "slicing-pipeline"
# ///
"""docstring"""
import orca
`;

describe('PEP 723 metadata (parse_pep723_toml port)', () => {
  it('reads the Orca sample header', () => {
    const m = readPythonPluginMetadata(STAMP_HEADER);
    expect(m).toEqual({
      dependencies: [], requiresPython: '>=3.12', name: 'G-code Stamp',
      description: 'Stamps a comment line into the exported G-code at the post-process step (demo).', author: 'OrcaSlicer', version: '0.01',
    });
  });

  it('keeps commas inside quoted requirements and reads multi-line arrays', () => {
    const toml = parsePep723Toml('dependencies = [\n  "numpy>=1.20,<2",  # pinned\n  \'shapely\',\n  bare-req\n]\n');
    expect(toml.dependencies).toEqual(['numpy>=1.20,<2', 'shapely', 'bare-req']);
    expect(parsePep723Toml('dependencies = ["numpy"]').dependencies).toEqual(['numpy']);
  });

  it('ignores the legacy settings table and unknown sections', () => {
    const m = parsePep723Toml('[tool.orcaslicer.plugin.settings]\ndependencies = ["evil"]\nname = "x"\n[tool.other]\nname = "y"\n[tool.orcaslicer.plugin]\nname = "Real"');
    expect(m.dependencies).toEqual([]);
    expect(m.name).toBe('Real');
  });

  it('fails on an unclosed array with Orca\'s message', () => {
    expect(() => readPythonPluginMetadata('# /// script\n# dependencies = [\n#   "numpy",\n# ///\n'))
      .toThrow('Failed to parse PEP 723 metadata: PEP 723 metadata: unclosed dependencies array');
  });

  it('takes only "# " / "#\\t" / bare "#" lines inside the block, CRLF tolerated', () => {
    expect(extractPep723Block('x\r\n# /// script\r\n#\tname = 1\r\n#\r\n#bad\r\n# ///\r\n')).toBe('name = 1\n\n');
  });

  it('replaces ";" in names (they go into ";"-delimited preset strings)', () => {
    expect(readPythonPluginMetadata('# /// script\n# [tool.orcaslicer.plugin]\n# name = "a;b"\n# ///\n').name).toBe('a_b');
  });

  it('has no metadata (all optional) without a block', () => {
    expect(readPythonPluginMetadata('import orca\n').name).toBe('');
  });
});

function wheel(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

describe('wheel metadata (read_wheel_plugin_metadata port)', () => {
  const base = {
    'my_plugin/__init__.py': 'import orca\n',
    'my_plugin-1.2.dist-info/METADATA': 'Metadata-Version: 2.1\nName: My-Plugin\nVersion: 1.2\nSummary: Does things\nAuthor: Me\nRequires-Dist: numpy>=1.20\nRequires-Dist: shapely\n\nLong description\nName: ignored\n',
    'my_plugin-1.2.dist-info/WHEEL': 'Wheel-Version: 1.0\nTag: py3-none-any\n',
    'my_plugin-1.2.dist-info/RECORD': 'my_plugin/__init__.py,,\n',
  };

  it('reads Name, Version, Summary, Author, Requires-Dist and the entry package', () => {
    const m = readWheelMetadata(wheel(base));
    expect(m).toMatchObject({ name: 'My-Plugin', version: '1.2', description: 'Does things', author: 'Me', dependencies: ['numpy>=1.20', 'shapely'], entryPackage: 'my_plugin' });
  });

  it('prefers Import-Name, then a single top_level.txt entry, then the normalized Name', () => {
    expect(readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/METADATA': 'Name: A\nVersion: 1\nImport-Name: pkg_a\n' })).entryPackage).toBe('pkg_a');
    expect(readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/top_level.txt': 'toplev\n' })).entryPackage).toBe('toplev');
    expect(readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/top_level.txt': 'a\nb\n' })).entryPackage).toBe('my_plugin');
    expect(normalizePackageName('Orca.Some-Plugin')).toBe('orca_some_plugin');
  });

  it('rejects what Orca rejects', () => {
    expect(() => readWheelMetadata(wheel({ 'x.py': '' }))).toThrow('Wheel does not contain a .dist-info directory');
    expect(() => readWheelMetadata(wheel({ ...base, 'other-1.dist-info/METADATA': 'Name: B' }))).toThrow(/multiple \.dist-info/);
    expect(() => readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/METADATA': 'Version: 1\n' }))).toThrow('Wheel METADATA missing required Name field');
    expect(() => readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/WHEEL': 'Tag: py3-none-any\n' }))).toThrow('Wheel WHEEL file missing Wheel-Version header');
    expect(() => readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/WHEEL': 'Wheel-Version: 1.0\nTag: cp312-cp312-win_amd64\n' }))).toThrow(/incompatible with this platform/);
    const { ['my_plugin-1.2.dist-info/RECORD']: _, ...noRecord } = base;
    expect(() => readWheelMetadata(wheel(noRecord))).toThrow('Wheel does not contain my_plugin-1.2.dist-info/RECORD');
  });

  it('accepts Pyodide builds of this interpreter', () => {
    expect(() => readWheelMetadata(wheel({ ...base, 'my_plugin-1.2.dist-info/WHEEL': 'Wheel-Version: 1.0\nTag: cp312-cp312-pyodide_2024_0_wasm32\n' }))).not.toThrow();
    expect(wheelFileCompatible('numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl')).toBe(true);
    expect(wheelFileCompatible('foo-1-py3-none-any.whl')).toBe(true);
    expect(wheelFileCompatible('foo-1-cp312-cp312-manylinux_2_17_x86_64.whl')).toBe(false);
  });

  it('parses RFC 822 continuation lines', () => {
    expect(parseCoreMetadata('Summary: one\n  two\nName: x\n')).toEqual({ summary: ['one\ntwo'], name: ['x'] });
  });
});
