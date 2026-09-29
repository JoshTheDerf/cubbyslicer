import { describe, expect, it } from 'vitest';
import { configFromPreset, emptyConfig, normalizeConfig, sanitizeUploadName, storageKey } from './config';
import { digestAuthorization, parseChallenge } from './digest';
import { Md5, md5Blob, md5Hex } from './md5';
import { HOSTS, hostMeta, isSupported } from './registry';
import { escapePath, isLocalHostname, joinRemote, parseHost, webUiUrl, withPort } from './url';
import { shortName, fatTime } from './hosts/simple';
import { elegooKind } from './hosts/elegoo';
import { flashforgeFilename } from './hosts/flashforge';

describe('md5', () => {
  it('matches RFC 1321 vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
  it('is incremental and hashes blobs in chunks', async () => {
    const data = new Uint8Array(200_003).map((_, i) => (i * 31) & 0xff);
    const whole = md5Hex(data);
    const h = new Md5();
    for (let o = 0; o < data.length; o += 777) h.update(data.subarray(o, o + 777));
    expect(h.hex()).toBe(whole);
    expect(await md5Blob(new Blob([data]), 4096)).toBe(whole);
  });
});

describe('digest auth', () => {
  it('computes the RFC 2617 example response', () => {
    const ch = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    expect(ch.realm).toBe('testrealm@host.com');
    const h = digestAuthorization(ch, 'Mufasa', 'Circle Of Life', 'GET', 'http://host.com/dir/index.html', 1, '0a4f113b');
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('nc=00000001');
    expect(h).toContain('qop=auth');
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(h).toContain('uri="/dir/index.html"');
  });
  it('returns null for unreadable / non-digest challenges', () => {
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge('Basic realm="x"')).toBeNull();
  });
});

describe('url', () => {
  it('defaults to http:// and normalises the base', () => {
    expect(parseHost('192.168.1.5').base).toBe('http://192.168.1.5/');
    expect(parseHost('octopi.local:5000').base).toBe('http://octopi.local:5000/');
    expect(parseHost('https://print.example.com/octo').base).toBe('https://print.example.com/octo/');
    expect(parseHost('http://h/x/?q=1#f').base).toBe('http://h/x/');
  });
  it('turns user:pass@ into a Basic header', () => {
    const p = parseHost('https://bob:s%40cret@proxy.example.com');
    expect(p.base).toBe('https://proxy.example.com/');
    expect(p.basicAuth).toBe(`Basic ${btoa('bob:s@cret')}`);
  });
  it('rejects empty and non-http addresses', () => {
    expect(() => parseHost('')).toThrow(/hostname/);
    expect(() => parseHost('ftp://x')).toThrow(/http/);
  });
  it('builds sibling ports and paths', () => {
    expect(withPort('192.168.1.9', 3030, 'ws:')).toBe('ws://192.168.1.9:3030/');
    expect(withPort('https://p.example.com:8443/x', 3030, 'ws:')).toBe('wss://p.example.com:3030/');
    expect(withPort('http://10.0.0.2:80', 8898)).toBe('http://10.0.0.2:8898/');
    expect(escapePath('/usb/My Prints/a#1.gcode')).toBe('usb/My%20Prints/a%231.gcode');
    expect(joinRemote('/sub/dir/', 'a.gcode')).toBe('sub/dir/a.gcode');
    expect(joinRemote('', 'a.gcode')).toBe('a.gcode');
  });
  it('recognises local-network addresses (Chrome LNA)', () => {
    for (const h of ['192.168.0.3', '10.1.2.3', '172.20.1.1', 'octopi.local', 'localhost', '[fd00::1]']) expect(isLocalHostname(h)).toBe(true);
    for (const h of ['8.8.8.8', 'printer.example.com', '172.32.0.1']) expect(isLocalHostname(h)).toBe(false);
  });
  it('picks the web UI like Orca', () => {
    expect(webUiUrl('192.168.1.5', '')).toBe('http://192.168.1.5');
    expect(webUiUrl('192.168.1.5', 'https://mainsail.lan')).toBe('https://mainsail.lan');
    expect(webUiUrl('', '')).toBe('');
  });
});

describe('config', () => {
  it('reads Orca printer preset keys', () => {
    const v: Record<string, string> = {
      print_host: ' 192.168.1.30 ', host_type: 'moonraker', printhost_apikey: 'k', printhost_port: 'p1',
      printhost_authorization_type: 'user', printhost_user: 'u', printhost_password: 'pw', print_host_webui: 'http://ui',
    };
    expect(configFromPreset((k) => v[k])).toEqual({
      type: 'moonraker', host: '192.168.1.30', apiKey: 'k', user: 'u', password: 'pw', authType: 'user', printer: 'p1', webUi: 'http://ui', serial: '', variant: '', wsUrl: '',
    });
    expect(configFromPreset(() => undefined)).toBeNull();
  });
  it('normalises junk and unknown host types', () => {
    expect(normalizeConfig({ type: 'nope', host: 5 })).toEqual({ ...emptyConfig(), host: '5' });
    expect(normalizeConfig(null)).toEqual(emptyConfig());
  });
  it('keys storage per engine + preset', () => {
    expect(storageKey('orca', 'sys:Voron/0.4')).toBe('cubby.printhost.orca:sys:Voron/0.4');
  });
  it('sanitises upload names', () => {
    expect(sanitizeUploadName('cube_plus1.gcode')).toBe('cube_plus1.gcode');
    expect(sanitizeUploadName('a/b:c')).toBe('a_b_c.gcode');
    expect(sanitizeUploadName('  ')).toBe('plate.gcode');
  });
});

describe('registry', () => {
  it('covers every Orca host_type exactly once', () => {
    const types = HOSTS.map((h) => h.type).sort();
    expect(types).toEqual(['3dprinteros', 'astrobox', 'crealityprint', 'duet', 'elegoolink', 'esp3d', 'flashair', 'flashforge', 'mks', 'moonraker',
      'obico', 'octoprint', 'prusaconnect', 'prusalink', 'repetier', 'simplyprint']);
  });
  it('marks browser-impossible hosts unsupported with a reason', () => {
    for (const t of ['prusaconnect', 'obico', 'simplyprint', '3dprinteros']) {
      expect(isSupported(t)).toBe(false);
      expect(hostMeta(t)!.note).toBeTruthy();
    }
    for (const t of ['octoprint', 'moonraker', 'prusalink', 'duet', 'repetier', 'esp3d', 'flashair', 'astrobox', 'mks', 'elegoolink', 'crealityprint', 'flashforge']) {
      expect(isSupported(t)).toBe(true);
    }
  });
  it('knows which hosts can start a print', () => {
    expect(hostMeta('flashair')!.canPrint({})).toBe(false);
    expect(hostMeta('mks')!.canPrint({})).toBe(false);
    expect(hostMeta('elegoolink')!.canPrint({ printerModel: 'Elegoo Centauri Carbon 2' })).toBe(false);
    expect(hostMeta('elegoolink')!.canPrint({ printerModel: 'Elegoo Centauri Carbon' })).toBe(true);
    expect(hostMeta('elegoolink')!.canPrint({ printerModel: 'Elegoo Centauri Carbon', variant: 'cc2' })).toBe(false);
  });
  it('puts the exact origin in the CORS hints', () => {
    const o = 'https://cubbycad.com';
    expect(hostMeta('moonraker')!.hints(o)[0].code).toBe('[authorization]\ncors_domains:\n    https://cubbycad.com');
    expect(hostMeta('duet')!.hints(o)[0].code).toBe('M586 C"https://cubbycad.com"');
    expect(hostMeta('octoprint')!.hints(o)[0].code).toContain('allowCrossOrigin: true');
  });
});

describe('host-specific names', () => {
  it('ESP3D 8.3 names', () => {
    expect(shortName('my_long_model_plus2.gcode')).toBe('my_long_.gco');
    expect(shortName('a.gcode')).toBe('a.gco');
  });
  it('FlashAir FAT time', () => {
    expect(fatTime(new Date(2024, 0, 2, 3, 4, 10))).toBe(`0x${((((2024 - 1980) << 25) | (1 << 21) | (2 << 16) | (3 << 11) | (4 << 5) | 5) >>> 0).toString(16)}`);
  });
  it('Elegoo model detection', () => {
    expect(elegooKind('Elegoo Centauri Carbon')).toBe('cc');
    expect(elegooKind('Elegoo Centauri Carbon 2')).toBe('cc2');
    expect(elegooKind('Elegoo Neptune 4')).toBe('other');
    expect(elegooKind('Elegoo Neptune 4', 'cc')).toBe('cc');
  });
  it('Flashforge file names', () => {
    expect(flashforgeFilename('dir/My Part (1).gcode')).toBe('My_Part__1_.gcode');
  });
});
