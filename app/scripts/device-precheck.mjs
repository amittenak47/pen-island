import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adb, tablet, PACKAGE, openPage } from './device-perf.mjs';

/** Output is allowlisted; also redact known values and common credential forms. */
export function maskSecrets(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/([?&])[^=&#\s]+=[^&#\s]*/g, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(/((?:[\w.-]*(?:token|secret|password|api[_-]?key|authorization)[\w.-]*)["']?\s*[:=]\s*)["']?[^\s,;"'}]+["']?/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|gsk_|ghp_|github_pat_|AIza|xox[baprs]-)[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[a-zA-Z0-9_+/=-]{32,}\b/g, '[REDACTED]')
    .replace(/\b\d{6}\b/g, '[REDACTED]');
}

export function configPath(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'lc', 'config', 'config.toml');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'lc', 'config.toml');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'lc', 'config.toml');
}

/** Read the scalar settings emitted by Config::save; never silently default an unsupported relevant setting. */
export function parseConfig(text) {
  const result = Object.create(null);
  let section = '';
  const wanted = key => /^(?:serve\.(?:port|token)|llm\.(?:default_provider|modes\.[\w]+|(?:local|ollama|openai|groq)\.(?:base_url|api_key))|voice\.local_base_url)$/.test(key);
  // Tokenize strings too, so multiline vocabulary cannot masquerade as config.
  const statements = [];
  let start = 0, quote = '', triple = false, escape = false, comment = false, nesting = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (comment) { if (c !== '\n' && i < text.length) continue; comment = false; }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (quote === '"' && c === '\\') { escape = true; continue; }
      if (c === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) {
        if (triple) i += 2;
        quote = ''; triple = false;
      }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; triple = text.slice(i, i + 3) === c.repeat(3); if (triple) i += 2; continue; }
    if (c === '#') { statements.push(text.slice(start, i).trim()); comment = true; start = text.indexOf('\n', i); if (start < 0) start = text.length; continue; }
    if (c === '[' || c === '{') nesting++;
    if (c === ']' || c === '}') nesting--;
    if ((c === '\n' && nesting === 0) || i === text.length) { statements.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || nesting) throw Error('Invalid or unsupported config TOML (unclosed string/table).');
  for (const statement of statements.filter(Boolean)) {
    const header = /^\[([\w.-]+)\]$/.exec(statement);
    if (header) { section = header[1]; continue; }
    const m = /^([\w.-]+)\s*=\s*([\s\S]+)$/.exec(statement);
    if (!m) throw Error('Unsupported config TOML syntax; use the scalar/table format written by the app.');
    const key = section ? `${section}.${m[1]}` : m[1], raw = m[2].trim();
    if (!wanted(key)) {
      if (/^(?:serve|llm|voice)(?:\.|$)/.test(key) && raw.startsWith('{')) throw Error('Inline config tables are unsupported; use the table format written by the app.');
      continue;
    }
    if (Object.hasOwn(result, key)) throw Error(`Duplicate config setting: ${key}`);
    let v;
    if (/^"(?:[^"\\]|\\.)*"$/s.test(raw)) {
      // TOML adds \UXXXXXXXX to JSON-style string escapes.
      try { v = JSON.parse(raw.replace(/\\U([\da-f]{8})/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))); }
      catch { throw Error(`Invalid config string: ${key}`); }
    } else if (/^'[^']*'$/s.test(raw)) v = raw.slice(1, -1);
    else if (/^\d[\d_]*$/.test(raw)) v = Number(raw.replaceAll('_', ''));
    else throw Error(`Unsupported config value: ${key}`);
    if (typeof v !== (key === 'serve.port' ? 'number' : 'string')) throw Error(`Invalid config value type: ${key}`);
    result[key] = v;
  }
  return result;
}

export function normalizeUrl(raw) {
  const text = String(raw).trim().replace(/\/+$/, '');
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  if (!['http:', 'https:'].includes(u.protocol)) throw Error('Endpoint must use HTTP or HTTPS.');
  return u.href.replace(/\/+$/, '');
}

/** Saved padHub wins over the host loopback, as in padHub.ts. */
export function resolveUrls(config = {}, savedPadHub = null, hubOverride = null) {
  const port = config['serve.port'] ?? 7878;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid serve.port in config.');
  const saved = savedPadHub && typeof savedPadHub.url === 'string' && savedPadHub.url.trim()
    && typeof savedPadHub.token === 'string' && savedPadHub.token.trim() ? savedPadHub : null;
  const hub = normalizeUrl(hubOverride || saved?.url || `http://127.0.0.1:${port}`);
  // Practice Ask/Review uses the review mode, which defaults to local independently of default_provider.
  const provider = config['llm.modes.review'] || 'local';
  const defaults = { local: 'http://localhost:11434/v1', ollama: 'http://localhost:11434/v1',
    openai: 'https://api.openai.com/v1', groq: 'https://api.groq.com/openai/v1' };
  if (!Object.hasOwn(defaults, provider)) throw Error('Invalid llm.modes.review provider.');
  return { hub, hubToken: saved && !hubOverride ? saved.token.trim() : config['serve.token'] || '',
    provider, coach: normalizeUrl(config[`llm.${provider}.base_url`] ?? defaults[provider]),
    voice: normalizeUrl(config['voice.local_base_url'] ?? 'http://localhost:8000/v1') };
}

export function workspaceProbePath(sessionKey) {
  // Mirrors dataset::key / split_key; legacy unqualified IDs use the default corpus.
  const split = sessionKey.indexOf('/');
  const dataset = split >= 0 ? sessionKey.slice(0, split) : null;
  const task = split >= 0 ? sessionKey.slice(split + 1) : sessionKey;
  if (!task) throw Error('Invalid Practice session key.');
  return `/workspace/${encodeURIComponent(task)}/meta${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ''}`;
}

const CHECKLIST = `Phase 6 live checklist (Practice first; Whisper last):
Practice agent end to end:
  1. Open a problem in Practice.
  2. Edit the solution.
  3. Run tests and inspect the results.
  4. Ask the agent for help and check its response.
  5. Check the saved result (reopen and verify it persisted).
Whisper / voice, last:
  1. Record, then stop.
  2. Record, then cancel.
  3. Exercise permission denied.
  4. Check transcription.
  5. Verify microphone, recorder, streams and other resources are released.

Usage: npm run device:precheck -- [--config path] [--hub URL] [--cdp-port 9222]
Read-only probes; no adb connect, app launch, edits, test runs or model starts.
Reads the OS lc/config.toml (same defaults as src/config.rs).
If desktop CDP is available, reads whiteboard.padHub.v1 without changing it.
Otherwise uses serve.port on loopback. --hub selects a known tablet hub URL.
Practice PASS verifies existing workspace metadata and test cases only;
the live checklist verifies execution. Node 22+ required.`;

async function request(url, headers = {}, json = false) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw Error(`HTTP ${response.status}`); }
  if (!json) { await response.body?.cancel(); return null; }
  // Do not print server bodies: /config can contain a hub pairing token.
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw Error('Probe response too large.');
  return JSON.parse(body);
}

export function parsePrecheckArgs(args) {
  const opts = { cdpPort: 9222 };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--help' || args[i] === '-h') return { help: true };
    const name = { '--config': 'config', '--hub': 'hub', '--cdp-port': 'cdpPort' }[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Unknown or missing option. See --help.');
    opts[name] = name === 'cdpPort' ? Number(args[i + 1]) : args[i + 1];
  }
  if (!Number.isInteger(opts.cdpPort) || opts.cdpPort < 1 || opts.cdpPort > 65535) throw Error('Invalid CDP port.');
  return opts;
}

async function main() {
  const opts = parsePrecheckArgs(process.argv.slice(2));
  if (opts.help) { console.log(CHECKLIST); return; }
  const secrets = Object.entries(process.env).filter(([k]) => /token|secret|password|api.?key/i.test(k)).map(([, v]) => v);
  let failures = 0, cdp;
  const line = (ok, label, message) => {
    if (!ok) failures++;
    console.log(maskSecrets(`${ok ? 'PASS' : 'FAIL'} ${label}: ${message}`, secrets));
  };
  const timer = setTimeout(() => { cdp?.close(); console.error('FAIL precheck: hard timeout.'); process.exit(1); }, 90000);
  const check = async (label, fn) => { try { line(true, label, await fn()); } catch (e) { line(false, label, e.message); } };
  try {
    let serial;
    await check('Tablet adb', async () => { serial = await tablet(false); return `connected (${serial})`; });
    await check('Tablet app', async () => {
      if (!serial) throw Error('No tablet available.');
      const packages = await adb(['-s', serial, 'shell', 'pm', 'path', PACKAGE]);
      if (!/^package:/m.test(packages)) throw Error(`${PACKAGE} is not installed.`);
      const info = await adb(['-s', serial, 'shell', 'dumpsys', 'package', PACKAGE]);
      const updated = /lastUpdateTime=([^\r\n]+)/.exec(info)?.[1]?.trim();
      if (!updated) throw Error('Installed, but lastUpdateTime could not be read.');
      return `${PACKAGE}, lastUpdateTime=${updated}`;
    });
    const path = opts.config ? resolve(opts.config) : configPath();
    let config = {}, saved = null;
    try {
      let text = '';
      try { text = await readFile(path, 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT' || opts.config) throw Error('Cannot read app config.'); }
      config = parseConfig(text);
      for (const [k, v] of Object.entries(config)) if (/token|secret|key|password/i.test(k)) secrets.push(String(v));
      line(true, 'Config', `${path}${text ? '' : ' (absent; app defaults)'}`);
    } catch (e) {
      line(false, 'Config', e.message);
      for (const label of ['Hub', 'Coach LLM', 'Whisper / voice', 'Practice workspace']) line(false, label, 'Cannot resolve configuration.');
      return;
    }
    if (!opts.hub) {
      try {
        cdp = await openPage(opts.cdpPort);
        saved = await cdp.evaluate(`JSON.parse(localStorage.getItem('whiteboard.padHub.v1') || 'null')`);
        if (saved?.token) secrets.push(String(saved.token));
      } catch { /* No debug WebView: desktop host loopback is the app fallback. */ }
      finally { cdp?.close(); cdp = null; }
    }
    let urls;
    try { urls = resolveUrls(config, saved, opts.hub); }
    catch {
      for (const label of ['Hub', 'Coach LLM', 'Whisper / voice', 'Practice workspace']) line(false, label, 'Invalid endpoint configuration.');
      return;
    }
    const headers = urls.hubToken ? { 'x-lc-token': urls.hubToken } : {};
    await check('Hub', async () => {
      const h = await request(`${urls.hub}/health`, {}, true);
      if (h.ok !== true || h.service !== 'whiteboard') throw Error('Health response is not a healthy Pen Island hub.');
      return `${urls.hub}/health (${opts.hub ? 'URL override' : saved?.token ? 'saved padHub' : 'serve.port loopback'})`;
    });
    await check('Coach LLM', async () => {
      const key = (process.env[`${urls.provider.toUpperCase()}_API_KEY`] || config[`llm.${urls.provider}.api_key`] || '').trim();
      if (key) secrets.push(key);
      await request(`${urls.coach}/models`, key ? { Authorization: `Bearer ${key}` } : {});
      return `${urls.provider} ${urls.coach}/models (Practice review provider)`;
    });
    await check('Whisper / voice', async () => {
      try {
        await request(`${urls.voice}/models`);
        return `${urls.voice}/models (voice.local_base_url)`;
      } catch (e) {
        if (e.message !== 'HTTP 404') throw e;
        const health = `${urls.voice.replace(/\/v1$/, '')}/health`;
        await request(health);
        return `${health} (voice.local_base_url health fallback)`;
      }
    });
    await check('Practice workspace', async () => {
      const session = await request(`${urls.hub}/session`, headers, true);
      const recent = Object.entries(session.problems || {}).sort((a, b) => (b[1].updated_at || 0) - (a[1].updated_at || 0)).slice(0, 3);
      if (!recent.length) throw Error('No previously opened Practice workspace; open a problem before the session.');
      for (const [id] of recent) {
        try {
          const meta = await request(`${urls.hub}${workspaceProbePath(id)}`, headers, true);
          if (!meta.cases?.length && !meta.test?.trim()) continue;
          return `${meta.cases?.length || 0} test cases${meta.test?.trim() ? ' plus embedded tests' : ''} in existing workspace; read-only readiness probe (execution requires live checklist)`;
        } catch { /* A previous attempt's workspace may have been removed. */ }
      }
      throw Error('No runnable metadata among the three most recent Practice workspaces; open a problem before the session.');
    });
  } finally { cdp?.close(); clearTimeout(timer); if (failures) process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('FAIL precheck: unable to resolve configuration or complete checks (details suppressed to protect secrets).'); process.exitCode = 1; });
}
