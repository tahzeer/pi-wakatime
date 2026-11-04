// Adapted from wakatime/opencode-wakatime (BSD-3-Clause; see LICENSE). The
// runtime serializes wakatime-cli runs, debounces them, and retries failed
// syncs on the next event. Logs go to ~/.wakatime/pi.log.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import { homedir, arch as osArch, platform, EOL } from 'node:os';
import path from 'node:path';
import util from 'node:util';
import zlib from 'node:zlib';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const execFileAsync = util.promisify(execFile);

const IS_WINDOWS = platform() === 'win32';
const MIN_CLI_VERSION = '2.28.0';

function isWindows() {
  return IS_WINDOWS;
}

function homeDirectory() {
  const fromEnv = process.env.WAKATIME_HOME;
  if (fromEnv && fromEnv.trim() && fs.existsSync(fromEnv.trim())) return path.resolve(fromEnv.trim());
  return process.env[isWindows() ? 'USERPROFILE' : 'HOME'] || homedir() || process.cwd();
}

function wakatimeDir() {
  return path.join(homeDirectory(), '.wakatime');
}

function cliLocation() {
  const ext = isWindows() ? '.exe' : '';
  return path.join(wakatimeDir(), `wakatime-cli-${osName()}-${architecture()}${ext}`);
}

function architecture() {
  const value = osArch();
  if (value === 'ia32' || value.includes('32')) return '386';
  if (value === 'x64') return 'amd64';
  return value;
}

function osName() {
  return isWindows() ? 'windows' : platform();
}

function getConfigFile() {
  return path.join(homeDirectory(), '.wakatime.cfg');
}

function getSetting(section, key) {
  try {
    const content = fs.readFileSync(getConfigFile(), 'utf8');
    let current = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        current = trimmed.slice(1, -1).toLowerCase();
        continue;
      }
      if (current !== section) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      if (line.slice(0, index).trim() === key) return line.slice(index + 1).trim().replace(/\0/g, '');
    }
  } catch (_) {}
  return undefined;
}

function childEnv() {
  if (isWindows() || process.env.HOME || process.env.WAKATIME_HOME) return process.env;
  return { ...process.env, WAKATIME_HOME: homeDirectory() };
}

function log(level, message) {
  if (level === 'DEBUG' && getSetting('settings', 'debug') !== 'true') return;
  try {
    fs.mkdirSync(wakatimeDir(), { recursive: true });
    fs.appendFileSync(path.join(wakatimeDir(), 'pi.log'), `[${new Date().toISOString()}][${level}] ${message}${EOL}`);
  } catch (_) {}
}

function logException(level, error) {
  log(level, error && error.message ? error.message : String(error));
}

function extractSemver(text) {
  if (!text) return undefined;
  const trimmed = String(text).trim();
  if (trimmed === '<local-build>') return '<local-build>';
  const match = trimmed.match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
  return match ? match[1] : undefined;
}

function compareVersions(left, right) {
  const leftParts = String(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i++) {
    if ((leftParts[i] || 0) < (rightParts[i] || 0)) return -1;
    if ((leftParts[i] || 0) > (rightParts[i] || 0)) return 1;
  }
  return 0;
}

function extractZip(zipFile, outputDir) {
  const buffer = fs.readFileSync(zipFile);
  const end = indexOfEndOfCentralDirectory(buffer);
  if (end === -1) throw new Error('not a zip archive');

  const count = buffer.readUInt16LE(end + 10);
  const central = buffer.readUInt32LE(end + 16);
  let offset = central;

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const header = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (!name.endsWith('/')) {
      const localNameLength = buffer.readUInt16LE(header + 26);
      const localExtraLength = buffer.readUInt16LE(header + 28);
      const dataStart = header + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + size);
      const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : undefined;
      if (!data) throw new Error(`unsupported compression ${method}`);
      const out = path.join(outputDir, name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function indexOfEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65557; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

async function getJson(url) {
  const result = await getWithRedirects(url);
  const body = Buffer.concat(await readBody(result)).toString('utf8');
  return { statusCode: result.statusCode || 0, body: body ? JSON.parse(body) : {} };
}

async function readBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return chunks;
}

async function getWithRedirects(url, redirectsLeft = 5) {
  const response = await getOnce(url);
  const status = response.statusCode || 0;
  if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
    response.resume();
    return getWithRedirects(new URL(response.headers.location, url).toString(), redirectsLeft - 1);
  }
  return response;
}

function getOnce(url) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const requestModule = isHttps ? https : http;
  const options = {
    host: target.hostname,
    port: target.port ? Number.parseInt(target.port, 10) : isHttps ? 443 : 80,
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers: { 'User-Agent': 'github.com/wakatime/pi-wakatime' },
  };
  if (isHttps) options.rejectUnauthorized = getSetting('settings', 'no_ssl_verify') !== 'true';

  return new Promise((resolve, reject) => {
    const request = requestModule.request(options, resolve);
    request.setTimeout(30000, () => request.destroy(new Error('download timed out')));
    request.once('error', reject);
    request.end();
  });
}

async function installCli() {
  const cli = cliLocation();
  const platform = `${osName()}-${architecture()}`;
  const url = `https://github.com/wakatime/wakatime-cli/releases/latest/download/wakatime-cli-${platform}.zip`;
  const staging = fs.mkdtempSync(path.join(wakatimeDir(), 'pi-install-'));
  try {
    const zip = await getWithRedirects(url);
    if ((zip.statusCode || 0) < 200 || (zip.statusCode || 0) >= 300) {
      zip.resume();
      throw new Error(`download failed with status ${zip.statusCode}`);
    }
    const dest = path.join(staging, 'download.zip');
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(dest);
      zip.pipe(stream);
      stream.once('error', reject);
      stream.once('finish', resolve);
    });

    fs.mkdirSync(wakatimeDir(), { recursive: true });
    extractZip(dest, wakatimeDir());
    if (!isWindows()) fs.chmodSync(cli, 0o755);

    // Validate before declaring success; a broken download must not replace
    // a working wakatime-cli.
    await execFileAsync(cli, ['--version'], { windowsHide: true, timeout: 10000 });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

let installing;
function ensureWakatimeCli(options = {}) {
  if (!installing) installing = ensureCli(options).finally(() => { installing = undefined; });
  return installing;
}

async function ensureCli(options) {
  const cli = cliLocation();
  fs.mkdirSync(wakatimeDir(), { recursive: true });

  let currentVersion;
  if (fs.existsSync(cli)) {
    try {
      const result = await execFileAsync(cli, ['--version'], { windowsHide: true, timeout: 10000 });
      currentVersion = `${result.stdout || ''}${result.stderr || ''}`.trim();
      log('DEBUG', `Current wakatime-cli version is ${currentVersion}`);
    } catch (_) {
      currentVersion = undefined;
    }
  }

  const semver = extractSemver(currentVersion);
  const supported = semver && (semver === '<local-build>' || compareVersions(semver, MIN_CLI_VERSION) >= 0);
  if (!fs.existsSync(cli) || !supported || (options.checkLatest && !(await isLatest(cli, semver)))) {
    await installCli();
  }

  return cli;
}

async function isLatest(cli, currentVersion) {
  try {
    if (currentVersion === '<local-build>') {
      log('DEBUG', 'Skip checking for wakatime-cli updates because current version is <local-build>.');
      return true;
    }
    const cache = path.join(wakatimeDir(), 'pi-cli-version.json');
    let latest;
    try {
      const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (Date.now() - saved.checked < 4 * 3600 * 1000) latest = saved.version;
    } catch (_) {}
    if (!latest) {
      const response = await getJson('https://api.github.com/repos/wakatime/wakatime-cli/releases/latest');
      if (response.statusCode !== 200) return true;
      latest = response.body.tag_name || '';
      fs.mkdirSync(wakatimeDir(), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify({ checked: Date.now(), version: latest }), { mode: 0o600 });
    }
    if (extractSemver(currentVersion) === extractSemver(latest)) {
      log('DEBUG', 'wakatime-cli is up to date');
      return true;
    }
    log('DEBUG', `Found an updated wakatime-cli ${latest}`);
    return false;
  } catch (_) {
    return true; // an unreachable API must not force a reinstall
  }
}

async function getPiVersion() {
  try {
    const result = await execFileAsync('pi', ['--version'], { windowsHide: true, timeout: 3000 });
    const match = `${result.stdout || ''}${result.stderr || ''}`.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
    return match ? match[1] : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

export function dependencies() {
  return {
    ensureWakatimeCli,
    getCliLocation: cliLocation,
    getChildEnv: childEnv,
    logException,
    execFile: execFileAsync,
  };
}

const DEBOUNCE_MS = 3000;

/**
 * Pi event handling. `worker` is injectable so tests can observe syncs
 * without spawning wakatime-cli.
 */
export function createPiHooks(getDirectory, worker = runtime, debounceMs = DEBOUNCE_MS) {
  let dirty = false;
  let timer;
  let running;
  let disposed = false;
  let lastError;

  function schedule(delay) {
    dirty = true;
    if (disposed || running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay ?? debounceMs);
    timer.unref?.();
  }

  async function flush() {
    if (running) return running;
    if (!dirty || disposed) return;
    dirty = false;
    running = worker.sync(getDirectory?.()).catch((error) => {
      dirty = true; // retry on the next pi event
      lastError = error;
      worker.log(error);
    }).finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    setup() {
      void worker.install().catch((error) => worker.log(error));
    },
    onSessionStart() {
      void worker.install({ checkLatest: true }).catch((error) => worker.log(error));
    },
    onActivity() {
      schedule();
    },
    onTurnEnd() {
      schedule();
    },
    onSettled() {
      schedule(0);
    },
    isFileTool(name) {
      return ['edit', 'edit_file', 'write', 'write_file', 'apply_patch', 'multi_edit', 'patch'].some((needle) => String(name || '').toLowerCase().includes(needle));
    },
    async dispose() {
      if (timer) clearTimeout(timer);
      await running;
      await flush(); // final flush before going quiet
      disposed = true;
    },
    get lastError() {
      return lastError;
    },
    get pending() {
      return dirty;
    },
  };
}

export const runtime = createRuntime();

export function createRuntime(deps = dependencies(), hostProduct = 'pi') {
  let version;
  let queue = Promise.resolve();

  function sync(directory) {
    const run = queue.then(async () => {
      const cli = await deps.ensureWakatimeCli();
      if (!version) version = await getPiVersion();
      const plugin = `${hostProduct}/${version || 'unknown'} pi-wakatime/${VERSION}`;

      const args = ['--sync-ai-activity', '--plugin', plugin];
      if (directory) args.push('--project-folder', directory);

      log('DEBUG', `Syncing AI activity: ${[cli, ...args].join(' ')}`);
      const result = await deps.execFile(cli, args, { env: deps.getChildEnv(), timeout: 120000, windowsHide: true });
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      if (output) log('WARN', output);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    install: (options) => deps.ensureWakatimeCli(options),
    sync,
    log: (error) => logException('WARN', error),
  };
}
