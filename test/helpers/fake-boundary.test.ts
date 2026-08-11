/**
 * The fake boundary is test infrastructure that every other suite trusts, so
 * its own contract is asserted here: how a stub matches, what an unmatched call
 * returns, and what `calls` / `requests` actually record. Its filesystem is
 * covered by the shared contract in `test/boundary.test.ts`, which runs the
 * same assertions against the real implementation.
 */
import { describe, expect, it } from 'vitest';
import { fakeBoundary } from './fake-boundary.js';

describe('command stubs', () => {
  it('matches on an in-order subsequence of the argv, not the whole array', () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcrun', 'install'], stdout: 'matched' }],
    });
    const result = boundary.exec.runSync('xcrun', ['devicectl', 'device', 'install', 'app']);
    expect(result.stdout).toBe('matched');
  });

  it('requires the tokens in order', () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['install', 'xcrun'], stdout: 'matched' }],
    });
    expect(boundary.exec.runSync('xcrun', ['install']).stdout).not.toBe('matched');
  });

  it('matches whole tokens, so a prefix is not enough', () => {
    const boundary = fakeBoundary({ commands: [{ match: ['build'], stdout: 'matched' }] });
    expect(boundary.exec.runSync('xcodebuild', ['-quiet']).ok).toBe(false);
  });

  it('takes the first stub that matches, so a narrow one must come first', () => {
    const boundary = fakeBoundary({
      commands: [
        { match: ['install', '--device', 'DEV-A'], stdout: 'specific' },
        { match: ['install'], stdout: 'generic' },
      ],
    });
    expect(boundary.exec.runSync('xcrun', ['install', '--device', 'DEV-A']).stdout).toBe(
      'specific',
    );
    expect(boundary.exec.runSync('xcrun', ['install', '--device', 'DEV-B']).stdout).toBe('generic');
  });

  it('reports the stubbed exit code, stdout and stderr', () => {
    const boundary = fakeBoundary({
      commands: [{ match: ['xcodebuild'], code: 65, stdout: 'out', stderr: 'err' }],
    });
    const result = boundary.exec.runSync('xcodebuild', ['build']);
    expect(result).toEqual({ ok: false, code: 65, stdout: 'out', stderr: 'err' });
  });

  it('defaults a matched stub to a clean success', () => {
    const boundary = fakeBoundary({ commands: [{ match: ['echo'] }] });
    expect(boundary.exec.runSync('echo', ['hi'])).toEqual({
      ok: true,
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('fails an unmatched command loudly, naming the whole argv', () => {
    // A silent zero here would let a test assert against a command that was
    // never actually stubbed.
    const boundary = fakeBoundary();
    const result = boundary.exec.runSync('xcodebuild', ['build', '-quiet']);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(127);
    expect(result.stderr).toBe('no stub for: xcodebuild build -quiet');
  });

  it('lets defaultCommandResult replace the unmatched-command answer', () => {
    const boundary = fakeBoundary({ defaultCommandResult: { stdout: 'quiet zero' } });
    expect(boundary.exec.runSync('anything', [])).toEqual({
      ok: true,
      code: 0,
      stdout: 'quiet zero',
      stderr: '',
    });
  });

  it('lets defaultCommandResult carry a non-zero code', () => {
    const boundary = fakeBoundary({ defaultCommandResult: { code: 1, stderr: 'nope' } });
    const result = boundary.exec.runSync('anything', []);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('nope');
  });

  it('answers run and runSync identically', async () => {
    const boundary = fakeBoundary({ commands: [{ match: ['echo'], stdout: 'same' }] });
    expect(await boundary.exec.run('echo', ['hi'])).toEqual(boundary.exec.runSync('echo', ['hi']));
  });
});

describe('recorded calls', () => {
  it('records every call in order, with its command, args and options', async () => {
    const boundary = fakeBoundary({ defaultCommandResult: {} });
    await boundary.exec.run('first', ['a'], { cwd: '/w' });
    boundary.exec.runSync('second', ['b'], { allowFail: true });
    expect(boundary.calls).toEqual([
      { command: 'first', args: ['a'], options: { cwd: '/w' } },
      { command: 'second', args: ['b'], options: { allowFail: true } },
    ]);
  });

  it('records an unmatched call too, so a missing stub is still visible', () => {
    const boundary = fakeBoundary();
    boundary.exec.runSync('unstubbed', ['x']);
    expect(boundary.calls).toHaveLength(1);
  });

  it('joins each argv into one line for commandLines()', async () => {
    const boundary = fakeBoundary({ defaultCommandResult: {} });
    await boundary.exec.run('security', ['find-identity', '-v', '-p', 'codesigning']);
    expect(boundary.commandLines()).toEqual(['security find-identity -v -p codesigning']);
  });

  it('finds a call by the same subsequence rule the stubs use', async () => {
    const boundary = fakeBoundary({ defaultCommandResult: {} });
    await boundary.exec.run('xcrun', ['devicectl', 'device', 'install', 'app']);
    expect(boundary.findCall('xcrun', 'install')).toBeDefined();
    expect(boundary.findCall('install', 'xcrun')).toBeUndefined();
    expect(boundary.findCall('xcodebuild')).toBeUndefined();
  });

  it('returns the FIRST matching call', async () => {
    const boundary = fakeBoundary({ defaultCommandResult: {} });
    await boundary.exec.run('xcrun', ['install', 'first']);
    await boundary.exec.run('xcrun', ['install', 'second']);
    expect(boundary.findCall('xcrun', 'install')!.args).toEqual(['install', 'first']);
  });
});

describe('the in-memory filesystem', () => {
  it('resolves a relative path against the configured cwd', () => {
    const boundary = fakeBoundary({ cwd: '/w', files: { 'ios/Acme.xcodeproj': 'x' } });
    expect(boundary.fs.exists('/w/ios/Acme.xcodeproj')).toBe(true);
    expect(boundary.fs.read('ios/Acme.xcodeproj')).toBe('x');
    expect(boundary.fs.exists('ios/Acme.xcodeproj')).toBe(true);
  });

  it('seeds parent directories of every seeded file', () => {
    const boundary = fakeBoundary({ cwd: '/w', files: { '/w/ios/Acme.xcodeproj/x.pbxproj': 'x' } });
    expect(boundary.fs.isDirectory('/w/ios/Acme.xcodeproj')).toBe(true);
    expect(boundary.fs.isDirectory('/w/ios')).toBe(true);
  });

  it('records the absolute path of every write', () => {
    const boundary = fakeBoundary({ cwd: '/w' });
    boundary.fs.write('out/app.txt', 'x');
    boundary.fs.write('/elsewhere/other.txt', 'y');
    expect(boundary.writes).toEqual(['/w/out/app.txt', '/elsewhere/other.txt']);
  });

  it('exposes the written contents on `files`, keyed absolutely', () => {
    const boundary = fakeBoundary({ cwd: '/w' });
    boundary.fs.write('out/app.txt', 'contents');
    expect(boundary.files.get('/w/out/app.txt')).toBe('contents');
  });

  it('reads bytes written as text, and text written as bytes', () => {
    const boundary = fakeBoundary({ cwd: '/w' });
    boundary.fs.write('/w/text.txt', 'hello');
    boundary.fs.write('/w/bytes.bin', new TextEncoder().encode('hello'));
    expect([...boundary.fs.readBytes('/w/text.txt')]).toEqual([
      ...boundary.fs.readBytes('/w/bytes.bin'),
    ]);
    expect(boundary.fs.read('/w/bytes.bin')).toBe('hello');
  });

  it('lists a directory one level deep, sorted and deduplicated', () => {
    const boundary = fakeBoundary({ cwd: '/w' });
    boundary.fs.write('/w/d/b.txt', 'b');
    boundary.fs.write('/w/d/a.txt', 'a');
    boundary.fs.write('/w/d/sub/one.txt', '1');
    boundary.fs.write('/w/d/sub/two.txt', '2');
    expect(boundary.fs.readdir('/w/d')).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('does not list a sibling whose name merely starts the same way', () => {
    const boundary = fakeBoundary({ cwd: '/w' });
    boundary.fs.write('/w/d/one.txt', '1');
    boundary.fs.write('/w/dd/two.txt', '2');
    expect(boundary.fs.readdir('/w/d')).toEqual(['one.txt']);
  });
});

describe('http stubs', () => {
  it('matches on a URL substring', async () => {
    const boundary = fakeBoundary({ requests: [{ url: '/v1/devices', body: { data: [] } }] });
    const response = await boundary.http({
      method: 'GET',
      url: 'https://api.example.com/v1/devices?limit=200',
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ data: [] });
  });

  it('narrows by method when the stub names one', async () => {
    const boundary = fakeBoundary({
      requests: [{ method: 'POST', url: '/v1/profiles', status: 201, body: { created: true } }],
    });
    const created = await boundary.http({ method: 'post', url: '/v1/profiles', headers: {} });
    expect(created.status).toBe(201);
    const listed = await boundary.http({ method: 'GET', url: '/v1/profiles', headers: {} });
    expect(listed.status).toBe(404);
  });

  it('answers 404 for a request nothing stubs', async () => {
    const boundary = fakeBoundary();
    const response = await boundary.http({ method: 'GET', url: '/v1/anything', headers: {} });
    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
    expect(await response.text()).toBe('{}');
  });

  it('honours a stubbed status and its ok flag', async () => {
    const boundary = fakeBoundary({
      requests: [{ url: '/v1/bundleIds', status: 409, body: { errors: [{ title: 'exists' }] } }],
    });
    const response = await boundary.http({ method: 'POST', url: '/v1/bundleIds', headers: {} });
    expect(response.status).toBe(409);
    expect(response.ok).toBe(false);
  });

  it('serves a string body verbatim from text() and parsed from json()', async () => {
    const boundary = fakeBoundary({ requests: [{ url: '/raw', body: '{"a":1}' }] });
    const response = await boundary.http({ method: 'GET', url: '/raw', headers: {} });
    expect(await response.text()).toBe('{"a":1}');
    expect(await response.json()).toEqual({ a: 1 });
  });

  it('returns stubbed headers, and none by default', async () => {
    const boundary = fakeBoundary({ requests: [{ url: '/h', headers: { location: '/there' } }] });
    expect((await boundary.http({ method: 'GET', url: '/h', headers: {} })).headers).toEqual({
      location: '/there',
    });
    expect((await boundary.http({ method: 'GET', url: '/none', headers: {} })).headers).toEqual({});
  });

  it('records the method, url, headers and body of every request, in order', async () => {
    const boundary = fakeBoundary();
    await boundary.http({ method: 'GET', url: '/first', headers: { Authorization: 'Bearer T' } });
    await boundary.http({ method: 'POST', url: '/second', headers: {}, body: '{"a":1}' });
    expect(boundary.requests).toEqual([
      { method: 'GET', url: '/first', headers: { Authorization: 'Bearer T' } },
      { method: 'POST', url: '/second', headers: {}, body: '{"a":1}' },
    ]);
  });
});

describe('the injected scalars', () => {
  it('reads env only from the options, never from the real process', () => {
    const boundary = fakeBoundary({ env: { ASC_API_KEY_ID: 'KEY1' } });
    expect(boundary.env('ASC_API_KEY_ID')).toBe('KEY1');
    expect(boundary.env('PATH')).toBeUndefined();
  });

  it('holds the clock still, in unix seconds', () => {
    const boundary = fakeBoundary({ now: 1_712_345_678 });
    expect(boundary.now()).toBe(1_712_345_678);
    expect(boundary.now()).toBe(boundary.now());
  });

  it('defaults the clock, homedir, cwd and interactive flag', () => {
    const boundary = fakeBoundary();
    expect(boundary.now()).toBe(1_700_000_000);
    expect(boundary.homedir()).toBe('/home/dev');
    expect(boundary.cwd()).toBe('/project');
    // Never interactive by default: a test must not wait on a prompt.
    expect(boundary.interactive).toBe(false);
  });

  it('takes overrides for the homedir, cwd and interactive flag', () => {
    const boundary = fakeBoundary({ homedir: '/Users/dev', cwd: '/w', interactive: true });
    expect(boundary.homedir()).toBe('/Users/dev');
    expect(boundary.cwd()).toBe('/w');
    expect(boundary.interactive).toBe(true);
  });

  it('swallows log output rather than printing it', () => {
    const boundary = fakeBoundary();
    expect(() => {
      boundary.log.info('i');
      boundary.log.warn('w');
      boundary.log.error('e');
      boundary.log.step('s');
    }).not.toThrow();
  });
});
