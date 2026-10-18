import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { maskSecrets, configPath, parseConfig, resolveUrls, normalizeUrl, parsePrecheckArgs, workspaceProbePath } from './device-precheck.mjs';

describe('secret-safe precheck output', () => {
  it('masks known secrets, six-digit pairing codes, keys, JWTs and bearer tokens', () => {
    const secrets = ['short-secret', 'sk-abcdefghi', 'gsk_abcdefghi', 'ghp_abcdefghi', '123456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.signature', 'abcdef0123456789abcdef0123456789abcdef'];
    const output = maskSecrets(`short-secret Bearer opaque-value token=opaque-value api_key="key-value" ${secrets.join(' ')}`, ['short-secret']);
    for (const secret of [...secrets, 'opaque-value', 'key-value']) expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });
  it('masks URL credentials and every query value, including innocently named parameters', () => {
    const output = maskSecrets('https://user:pass@example.test/v1?token=private&other=encoded%20secret');
    for (const secret of ['user', 'pass', 'private', 'encoded']) expect(output).not.toContain(secret);
    expect(output).toContain('example.test/v1');
  });
  it('keeps useful PASS/FAIL messages, ports and lastUpdateTime', () => {
    const text = 'PASS Tablet app: dev.lc.whiteboard lastUpdateTime=2026-10-15 10:15:00 http://127.0.0.1:7878';
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('app config URL resolution', () => {
  it('matches Config defaults and the independent Practice review provider', () => {
    expect(resolveUrls({ 'llm.default_provider': 'openai' })).toEqual({ hub: 'http://127.0.0.1:7878', hubToken: '',
      provider: 'local', coach: 'http://localhost:11434/v1', voice: 'http://localhost:8000/v1' });
  });
  it('reads scalar TOML, comments, dotted keys, literal strings and configured base paths', () => {
    const cfg = parseConfig(`serve.port = 8_123 # a port
[serve]
token = '654321'
[llm.modes]
review = "groq"
[llm.groq]
base_url = "https://llm.example/openai/v1/" # comment
api_key = "sk-test#not-a-comment"
[voice]
local_base_url = 'voice.lan:8001/v1/'
vocabulary = """
[serve]
port = 9999
"""
`);
    expect(resolveUrls(cfg)).toEqual({ hub: 'http://127.0.0.1:8123', hubToken: '654321', provider: 'groq',
      coach: 'https://llm.example/openai/v1', voice: 'http://voice.lan:8001/v1' });
    expect(cfg['llm.groq.api_key']).toBe('sk-test#not-a-comment');
  });
  it('uses saved hub only with both trimmed URL and token, then loopback fallback', () => {
    const cfg = { 'serve.port': 9000, 'serve.token': 'host-secret' };
    expect(resolveUrls(cfg, { url: ' tablet-host:9001/ ', token: ' saved-secret ' })).toMatchObject({ hub: 'http://tablet-host:9001', hubToken: 'saved-secret' });
    expect(resolveUrls(cfg, { url: 'ignored:9001', token: '' })).toMatchObject({ hub: 'http://127.0.0.1:9000', hubToken: 'host-secret' });
    expect(resolveUrls(cfg, null, 'hub.lan:9100')).toMatchObject({ hub: 'http://hub.lan:9100', hubToken: 'host-secret' });
  });
  it('resolves OS config paths as ProjectDirs lc/config.toml does', () => {
    expect(configPath('win32', { APPDATA: 'roaming' }, 'home')).toBe(join('roaming', 'lc', 'config', 'config.toml'));
    expect(configPath('darwin', {}, 'home')).toBe(join('home', 'Library', 'Application Support', 'lc', 'config.toml'));
    expect(configPath('linux', { XDG_CONFIG_HOME: 'xdg' }, 'home')).toBe(join('xdg', 'lc', 'config.toml'));
  });
  it('normalizes hub addresses like padHub.ts and preserves API path prefixes', () => {
    expect(normalizeUrl('  192.168.1.10:7878/// ')).toBe('http://192.168.1.10:7878');
    expect(normalizeUrl('https://example.test/proxy/v1/')).toBe('https://example.test/proxy/v1');
    expect(() => normalizeUrl('file:///private')).toThrow('HTTP');
  });
  it('fails unsupported relevant syntax rather than probing silently wrong defaults', () => {
    for (const text of ['[serve]\nport = 7878\nport = 9000', 'serve = { port = 9000 }', '[voice]\nlocal_base_url = "unclosed']) expect(() => parseConfig(text)).toThrow();
    expect(() => resolveUrls({ 'serve.port': 0 })).toThrow('serve.port');
    expect(() => resolveUrls({ 'llm.modes.review': 'invalid' })).toThrow('provider');
  });
  it('validates CLI options without device, network or app access', () => {
    expect(parsePrecheckArgs(['--help'])).toEqual({ help: true });
    expect(parsePrecheckArgs(['--config', 'config.toml', '--hub', 'hub:7878'])).toMatchObject({ config: 'config.toml', hub: 'hub:7878' });
    expect(() => parsePrecheckArgs(['--cdp-port', '0'])).toThrow();
    expect(() => parsePrecheckArgs(['--hub'])).toThrow();
  });
  it('resolves dataset-qualified and legacy Practice session keys', () => {
    expect(workspaceProbePath('leetcode/two-sum')).toBe('/workspace/two-sum/meta?dataset=leetcode');
    expect(workspaceProbePath('kodcode/a problem')).toBe('/workspace/a%20problem/meta?dataset=kodcode');
    expect(workspaceProbePath('two-sum')).toBe('/workspace/two-sum/meta');
  });
});
