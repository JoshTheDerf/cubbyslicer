import { describe, expect, it } from 'vitest';
import { HostError } from './types';
import { octoprint, astrobox } from './hosts/octoprint';
import { moonraker } from './hosts/moonraker';
import { prusalink } from './hosts/prusalink';
import { duet } from './hosts/duet';
import { repetier } from './hosts/repetier';
import { esp3d, flashair, mks } from './hosts/simple';
import { CHUNK, elegoolink } from './hosts/elegoo';
import { crealityprint } from './hosts/creality';
import { flashforge } from './hosts/flashforge';
import { ctx, FakeWs, fakeEnv, gcode } from './testing';

const form = (b: unknown) => b as FormData;
const job = (over: Partial<{ print: boolean; folder: string; filename: string; file: Blob }> = {}) => ({ file: gcode(), filename: 'cube.gcode', folder: '', print: false, ...over });

describe('OctoPrint', () => {
  it('tests api/version with the API key', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { api: '0.1', server: '1.10.2', text: 'OctoPrint 1.10.2' } }));
    const r = await octoprint.test(ctx({ apiKey: 'KEY' }), env);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://192.168.1.5/api/version', headers: { 'X-Api-Key': 'KEY' } });
    expect(r.detail).toContain('OctoPrint 1.10.2');
  });
  it('rejects a mismatched host', async () => {
    const { env } = fakeEnv(() => ({ body: { api: '0.1', text: 'PrusaLink 0.7' } }));
    await expect(octoprint.test(ctx(), env)).rejects.toThrow(/Mismatched/);
  });
  it('uploads to api/files/local with print/path fields', async () => {
    const { env, calls } = fakeEnv(() => ({ status: 201, body: { files: { local: { path: 'sub/cube.gcode' } } } }));
    const progress: number[] = [];
    const r = await octoprint.upload(ctx({ apiKey: 'K' }), job({ print: true, folder: '/sub/' }), env, { onProgress: (l) => progress.push(l) });
    const c = calls[0];
    expect(c).toMatchObject({ method: 'POST', url: 'http://192.168.1.5/api/files/local', headers: { 'X-Api-Key': 'K' } });
    expect(form(c.body).get('print')).toBe('true');
    expect(form(c.body).get('path')).toBe('sub');
    expect((form(c.body).get('file') as File).name).toBe('cube.gcode');
    expect(r).toMatchObject({ printed: true, path: 'sub/cube.gcode' });
    expect(progress.length).toBeGreaterThan(0);
  });
  it('maps 401/403 to an auth error', async () => {
    const { env } = fakeEnv(() => ({ status: 403, body: 'Invalid API key' }));
    await expect(octoprint.upload(ctx(), job(), env)).rejects.toMatchObject({ kind: 'auth', status: 403 });
  });
  it('sends Basic auth from user:pass@ URLs', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { api: '0.1', text: 'OctoPrint 1.9' } }));
    await octoprint.test(ctx({ host: 'https://u:p@octo.example.com/' }), env);
    expect(calls[0].url).toBe('https://octo.example.com/api/version');
    expect(calls[0].headers?.Authorization).toBe(`Basic ${btoa('u:p')}`);
  });
  it('AstroBox validates its own name', async () => {
    const { env } = fakeEnv(() => ({ body: { api: '0.1', text: 'AstroBox 1.0' } }));
    await expect(astrobox.test(ctx(), env)).resolves.toBeTruthy();
  });
});

describe('Moonraker', () => {
  it('tests server/info; key optional', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { result: { klippy_state: 'ready' } } }));
    await moonraker.test(ctx(), env);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://192.168.1.5/server/info' });
    expect(calls[0].headers?.['X-Api-Key']).toBeUndefined();
  });
  it('rejects non-Moonraker replies', async () => {
    const { env } = fakeEnv(() => ({ body: { api: '0.1' } }));
    await expect(moonraker.test(ctx(), env)).rejects.toThrow(/klippy_state/);
  });
  it('uploads then starts the print with the path the server returned', async () => {
    const { env, calls } = fakeEnv((r) => {
      if (r.url.endsWith('server/files/upload')) return { status: 201, body: { result: { item: { path: 'jobs/cube-1.gcode', root: 'gcodes' } } } };
      if (r.url.endsWith('printer/print/start')) return { body: { result: 'ok' } };
      return undefined;
    });
    const r = await moonraker.upload(ctx({ apiKey: 'MK' }), job({ print: true, folder: 'jobs' }), env);
    expect(form(calls[0].body).get('root')).toBe('gcodes');
    expect(form(calls[0].body).get('path')).toBe('jobs');
    expect(calls[0].headers?.['X-Api-Key']).toBe('MK');
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'http://192.168.1.5/printer/print/start', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(calls[1].body as string)).toEqual({ filename: 'jobs/cube-1.gcode' });
    expect(r).toMatchObject({ printed: true, path: 'jobs/cube-1.gcode' });
  });
  it('upload only does not start', async () => {
    const { env, calls } = fakeEnv(() => ({ status: 201, body: { result: { item: { path: 'cube.gcode' } } } }));
    await moonraker.upload(ctx(), job(), env);
    expect(calls).toHaveLength(1);
  });
  it('passes network errors through', async () => {
    const { env } = fakeEnv(() => 'network');
    await expect(moonraker.test(ctx(), env)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('PrusaLink', () => {
  const version = { api: '2.0.0', text: 'PrusaLink 0.7.0', capabilities: { 'upload-by-put': true } };
  it('PUTs to api/v1/files/<storage>/<path> with Print-After-Upload', async () => {
    const { env, calls } = fakeEnv((r) => {
      if (r.url.endsWith('api/version')) return { body: version };
      if (r.url.endsWith('api/v1/storage')) return { body: { storage_list: [{ path: '/local', read_only: true }, { path: '/usb', available: true, read_only: false }] } };
      if (r.method === 'PUT') return { status: 201 };
      return undefined;
    });
    const r = await prusalink.upload(ctx({ apiKey: 'PK' }), job({ print: true, folder: 'My Prints', filename: 'a b.gcode' }), env);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('http://192.168.1.5/api/v1/files/usb/My%20Prints/a%20b.gcode');
    expect(put.headers).toMatchObject({ 'X-Api-Key': 'PK', 'Content-Type': 'text/x.gcode', Overwrite: '?1', 'Print-After-Upload': '?1' });
    expect(put.body).toBeInstanceOf(Blob);
    expect(r.printed).toBe(true);
  });
  it('omits Print-After-Upload for upload only; falls back to POST without upload-by-put', async () => {
    const { env, calls } = fakeEnv((r) => (r.url.endsWith('api/version') ? { body: { ...version, capabilities: {} } } : { status: 201 }));
    await prusalink.upload(ctx(), job(), env);
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'http://192.168.1.5/api/files/local' });
    expect(form(calls[1].body).get('print')).toBe('false');
  });
  it('answers a readable digest challenge and reuses it', async () => {
    let n = 0;
    const { env, calls } = fakeEnv((r) => {
      if (!r.headers?.Authorization) { n++; return { status: 401, headers: { 'WWW-Authenticate': 'Digest realm="Printer API", nonce="abc123", qop="auth"' } }; }
      if (r.url.endsWith('api/version')) return { body: version };
      if (r.url.endsWith('api/v1/storage')) return { body: { storage_list: [] } };
      return { status: 201 };
    });
    await prusalink.upload(ctx({ authType: 'user', user: 'maker', password: 'pw' }), job(), env);
    expect(n).toBe(1); // only the first request was challenged
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers?.Authorization).toMatch(/^Digest username="maker", realm="Printer API", nonce="abc123", uri="\/api\/v1\/files\/usb\/cube.gcode"/);
    expect(put.headers?.['X-Api-Key']).toBeUndefined();
  });
  it('explains when the digest challenge is not exposed cross-origin', async () => {
    const { env } = fakeEnv(() => ({ status: 401 }));
    await expect(prusalink.test(ctx({ authType: 'user', user: 'u', password: 'p' }), env)).rejects.toThrow(/can’t read its challenge/);
  });
  it('reports wrong credentials', async () => {
    const { env } = fakeEnv(() => ({ status: 401, headers: { 'WWW-Authenticate': 'Digest realm="r", nonce="n1", qop="auth"' } }));
    await expect(prusalink.test(ctx({ authType: 'user', user: 'u', password: 'p' }), env)).rejects.toThrow(/rejected the user name/);
  });
});

describe('Duet', () => {
  it('RRF: rr_connect → rr_upload → rr_gcode M32 → rr_disconnect, with session key', async () => {
    const { env, calls } = fakeEnv((r) => {
      if (r.url.includes('rr_connect')) return { body: { err: 0, sessionKey: 4242 } };
      if (r.url.includes('rr_upload')) return { body: { err: 0 } };
      return { body: {} };
    });
    await duet.upload(ctx({ apiKey: 'p&w' }), job({ print: true, folder: 'sub' }), env);
    const urls = calls.map((c) => c.url);
    expect(urls[0]).toMatch(/^http:\/\/192\.168\.1\.5\/rr_connect\?password=p%26w&time=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect(urls[1]).toMatch(/rr_upload\?name=0%3A%2Fgcodes%2Fsub%2Fcube\.gcode&time=/);
    expect(calls[1].headers?.['X-Session-Key']).toBe('4242');
    expect(urls[2]).toBe(`http://192.168.1.5/rr_gcode?gcode=${encodeURIComponent('M32 "0:/gcodes/sub/cube.gcode"')}`);
    expect(urls[3]).toBe('http://192.168.1.5/rr_disconnect');
  });
  it('RRF: default password + wrong password', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { err: 1 } }));
    await expect(duet.test(ctx(), env)).rejects.toMatchObject({ kind: 'auth' });
    expect(calls[0].url).toContain('password=reprap');
  });
  it('DSF: falls back to /machine and PUTs the file', async () => {
    const { env, calls } = fakeEnv((r) => {
      if (r.url.includes('rr_connect')) return { status: 404, body: 'nope' };
      if (r.url.includes('machine/connect')) return { body: { sessionKey: 'S1' } };
      if (r.method === 'PUT') return { status: 201 };
      if (r.url.endsWith('machine/code')) return { body: '' };
      return { body: {} };
    });
    await duet.upload(ctx(), job({ print: true, filename: 'a b.gcode' }), env);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('http://192.168.1.5/machine/file/gcodes/a%20b.gcode');
    expect(put.headers?.['X-Session-Key']).toBe('S1');
    const code = calls.find((c) => c.url.endsWith('machine/code'))!;
    expect(code.body).toBe('M32 "0:/gcodes/a b.gcode"');
  });
});

describe('Repetier', () => {
  it('uploads to printer/job/<slug> with autostart when printing', async () => {
    const { env, calls } = fakeEnv(() => ({ body: {} }));
    await repetier.upload(ctx({ apiKey: 'RK', printer: 'Prusa_MK3' }), job({ print: true, folder: 'Parts' }), env);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://192.168.1.5/printer/job/Prusa_MK3', headers: { 'X-Api-Key': 'RK' } });
    const f = form(calls[0].body);
    expect([f.get('a'), f.get('name'), f.get('autostart'), f.get('group')]).toEqual(['upload', 'cube.gcode', 'true', 'Parts']);
    expect((f.get('filename') as File).name).toBe('cube.gcode');
  });
  it('upload only uses printer/model and discovers a single printer', async () => {
    const { env, calls } = fakeEnv((r) => (r.url.endsWith('printer/list') ? { body: { data: [{ slug: 'only' }] } } : { body: {} }));
    await repetier.upload(ctx(), job(), env);
    expect(calls[1].url).toBe('http://192.168.1.5/printer/model/only');
    expect(form(calls[1].body).get('autostart')).toBeNull();
  });
  it('validates the server software', async () => {
    const { env } = fakeEnv(() => ({ body: { name: 'MyFarm', software: 'Repetier-Server' } }));
    await expect(repetier.test(ctx(), env)).resolves.toBeTruthy();
    const bad = fakeEnv(() => ({ body: { name: 'x', software: 'Other' } }));
    await expect(repetier.test(ctx(), bad.env)).rejects.toThrow(/Mismatched/);
  });
});

describe('ESP3D / FlashAir / MKS', () => {
  it('ESP3D uploads an 8.3 name and sends M23/M24', async () => {
    const { env, calls } = fakeEnv(() => ({ body: 'ok' }));
    await esp3d.upload(ctx(), job({ print: true, filename: 'longmodelname.gcode' }), env);
    expect(calls[0].url).toBe('http://192.168.1.5/upload_serial');
    expect((form(calls[0].body).get('file') as File).name).toBe('longmode.gco');
    expect(calls[1].url).toBe('http://192.168.1.5/command?plain=M23%20longmode.gco');
    expect(calls[2].url).toBe('http://192.168.1.5/command?plain=M24');
  });
  it('FlashAir checks upload is enabled, sets time + dir, uploads', async () => {
    const { env, calls } = fakeEnv((r) => (r.url.includes('op=118') ? { body: '1' } : { body: 'SUCCESS' }));
    await flashair.upload(ctx(), job({ folder: 'gcodes' }), env);
    expect(calls.map((c) => c.url.replace('http://192.168.1.5/', ''))).toEqual([
      'command.cgi?op=118', expect.stringMatching(/^upload\.cgi\?WRITEPROTECT=ON&FTIME=0x[0-9a-f]+$/), 'upload.cgi?UPDIR=%2Fgcodes', 'upload.cgi',
    ]);
    const disabled = fakeEnv(() => ({ body: '0' }));
    await expect(flashair.test(ctx(), disabled.env)).rejects.toThrow(/Upload not enabled/);
  });
  it('MKS uploads raw and refuses to start prints', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { err: 0 } }));
    await mks.upload(ctx(), job({ filename: 'a b.gcode' }), env);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://192.168.1.5/upload?X-Filename=a%20b.gcode' });
    expect(calls[0].body).toBeInstanceOf(Blob);
    await expect(mks.upload(ctx(), job({ print: true }), env)).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('Elegoo Link', () => {
  const cc = { printerModel: 'Elegoo Centauri Carbon' };
  it('CC: chunked multipart upload with MD5, then SDCP start over ws://host:3030', async () => {
    const big = new Blob([new Uint8Array(CHUNK + 10).fill(65)]);
    const { env, calls } = fakeEnv(() => ({ body: { code: '000000', messages: null } }), (url) => new FakeWs(url, (ws, m) => {
      const cmd = (m.Data as { Cmd: number }).Cmd;
      if (cmd === 0) ws.push({ Status: { CurrentStatus: [0] } });
      if (cmd === 128) ws.push({ Data: { Cmd: 128, Data: { Ack: 0 } } });
    }));
    let ws: FakeWs | undefined;
    const envWs = { ...env, ws: (u: string) => (ws = env.ws(u) as FakeWs) };
    const r = await elegoolink.upload(ctx(cc), job({ print: true, file: big }), envWs);
    expect(calls).toHaveLength(2);
    const f0 = form(calls[0].body), f1 = form(calls[1].body);
    expect(calls[0].url).toBe('http://192.168.1.5/uploadFile/upload');
    expect([f0.get('Check'), f0.get('Offset'), f0.get('TotalSize')]).toEqual(['1', '0', String(CHUNK + 10)]);
    expect(f1.get('Offset')).toBe(String(CHUNK));
    expect(f0.get('S-File-MD5')).toMatch(/^[0-9a-f]{32}$/);
    expect(f0.get('S-File-MD5')).toBe(f1.get('S-File-MD5'));
    expect((f1.get('File') as File).size).toBe(10);
    expect(ws!.url).toBe('ws://192.168.1.5:3030/websocket');
    const start = ws!.sent.find((m) => (m as { Data: { Cmd: number } }).Data.Cmd === 128) as { Data: { Data: { Filename: string } } };
    expect(start.Data.Data.Filename).toBe('/local/cube.gcode');
    expect(r.printed).toBe(true);
  });
  it('CC: honours a wss:// override for remote use and reports start failures after upload', async () => {
    const { env } = fakeEnv(() => ({ body: { code: '000000' } }), (url) => new FakeWs(url, (ws, m) => ws.push((m.Data as { Cmd: number }).Cmd === 0 ? { Status: { CurrentStatus: [0] } } : { Data: { Cmd: 128, Data: { Ack: 1 } } })));
    let seen = '';
    const envWs = { ...env, ws: (u: string) => { seen = u; return env.ws(u); } };
    await expect(elegoolink.upload(ctx({ ...cc, wsUrl: 'wss://cc.example.com/websocket' }), job({ print: true }), envWs)).rejects.toThrow(/uploaded, but .*busy/);
    expect(seen).toBe('wss://cc.example.com/websocket');
  });
  it('CC: explains a blocked WebSocket', async () => {
    const { env } = fakeEnv(() => ({ body: { code: '000000' } }), (url) => new FakeWs(url, () => {}, true));
    await expect(elegoolink.upload(ctx(cc), job({ print: true }), env)).rejects.toThrow(/uploaded, but the print couldn’t be started/);
  });
  it('CC2: PUT chunks with Content-Range + X-Token; no print', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { error_code: 0 } }));
    await elegoolink.upload(ctx({ printerModel: 'Elegoo Centauri Carbon 2' }), job(), env);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'http://192.168.1.5/upload' });
    expect(calls[0].headers).toMatchObject({ 'X-Token': '123456', 'X-File-Name': 'cube.gcode', 'Content-Range': 'bytes 0-10/11' });
    await expect(elegoolink.upload(ctx({ printerModel: 'Elegoo Centauri Carbon 2' }), job({ print: true }), env)).rejects.toMatchObject({ kind: 'unsupported' });
  });
  it('CC2 test reads system/info; other models use the OctoPrint API', async () => {
    const a = fakeEnv(() => ({ body: { error_code: 0, system_info: { sn: 'SN1' } } }));
    expect((await elegoolink.test(ctx({ printerModel: 'Elegoo Centauri Carbon 2', apiKey: '999' }), a.env)).detail).toBe('Serial SN1');
    expect(a.calls[0].url).toBe('http://192.168.1.5/system/info?X-Token=999');
    const b = fakeEnv(() => ({ body: { api: '0.1', text: 'OctoPrint 1.0' } }));
    await elegoolink.test(ctx({ printerModel: 'Elegoo Neptune 4 Pro' }), b.env);
    expect(b.calls[0].url).toBe('http://192.168.1.5/api/version');
  });
});

describe('Creality Print', () => {
  it('uploads to upload/<name> and starts over ws://host:9999 (K1 path)', async () => {
    const { env, calls } = fakeEnv((r) => (r.url.endsWith('/info') ? { body: { model: 'K1C' } } : { body: {} }), (url) => new FakeWs(url, (ws) => ws.close()));
    let ws: FakeWs | undefined;
    await crealityprint.upload(ctx({ apiKey: 'T' }), job({ print: true, filename: 'my part.gcode' }), { ...env, ws: (u) => (ws = env.ws(u) as FakeWs) });
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'http://192.168.1.5/upload/my_part.gcode', headers: { Authorization: 'Bearer T' } });
    expect(ws!.url).toBe('ws://192.168.1.5:9999/');
    expect(ws!.sent[0]).toEqual({ method: 'set', params: { opGcodeFile: 'printprt:/usr/data/printer_data/gcodes/my_part.gcode' } });
  });
  it('K2 uses /mnt/UDISK and no path field', async () => {
    const { env, calls } = fakeEnv((r) => (r.url.endsWith('/info') ? { body: { model: 'F008' } } : { body: {} }), (url) => new FakeWs(url, (ws) => ws.push({ ok: 1 })));
    let ws: FakeWs | undefined;
    await crealityprint.upload(ctx(), job({ print: true }), { ...env, ws: (u) => (ws = env.ws(u) as FakeWs) });
    expect(form(calls[1].body).get('path')).toBeNull();
    expect(ws!.sent[0]).toEqual({ method: 'set', params: { opGcodeFile: 'printprt:/mnt/UDISK/printer_data/gcodes/cube.gcode', enableSelfTest: 0 } });
  });
});

describe('Flashforge local API', () => {
  it('requires serial + check code', async () => {
    const { env } = fakeEnv(() => ({ body: { code: 0 } }));
    await expect(flashforge.test(ctx(), env)).rejects.toMatchObject({ kind: 'config' });
  });
  it('posts detail / uploadGcode on port 8898 with its headers', async () => {
    const { env, calls } = fakeEnv(() => ({ body: { code: 0, message: 'Success' } }));
    const c = ctx({ serial: 'SN9', apiKey: 'CHK' });
    await flashforge.test(c, env);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://192.168.1.5:8898/detail' });
    expect(JSON.parse(calls[0].body as string)).toEqual({ serialNumber: 'SN9', checkCode: 'CHK' });
    await flashforge.upload(c, job({ print: true }), env);
    expect(calls[1].url).toBe('http://192.168.1.5:8898/uploadGcode');
    expect(calls[1].headers).toMatchObject({ serialNumber: 'SN9', checkCode: 'CHK', printNow: 'true', fileSize: '11', materialMappings: btoa('[]') });
    expect((form(calls[1].body).get('gcodeFile') as File).name).toBe('cube.gcode');
  });
  it('surfaces printer error codes', async () => {
    const { env } = fakeEnv(() => ({ body: { code: 1, message: 'check code error' } }));
    await expect(flashforge.test(ctx({ serial: 'a', apiKey: 'b' }), env)).rejects.toThrow(/check code error/);
  });
});

describe('errors', () => {
  it('HostError carries kind/status', () => {
    const e = new HostError('http', 'x', 'body', 500);
    expect([e.kind, e.status, e.detail]).toEqual(['http', 500, 'body']);
  });
});
