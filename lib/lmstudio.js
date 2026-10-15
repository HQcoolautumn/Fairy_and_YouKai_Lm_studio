'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const LMS_CANDIDATES = [
  path.join(os.homedir(), '.lmstudio', 'bin', 'lms.exe'),
  path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
];

function normalizeBaseUrl(raw) {
  let url = String(raw || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  if (!/\/v1$/.test(url)) url += '/v1';
  return url;
}

function headers(apiKey) {
  const result = { 'Content-Type': 'application/json' };
  if (apiKey) result.Authorization = 'Bearer ' + apiKey;
  return result;
}

function findLms() {
  for (const candidate of LMS_CANDIDATES) {
    try {
      if (require('fs').existsSync(candidate)) return candidate;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/* ------------------------------------------------------------------ 端点自动发现
   LM Studio 新版（0.4.x）不一定还在 127.0.0.1:1234/v1：端口可能换、可能只绑 IPv6
   的 ::1、路径也可能是 /api/v1。所以这里不再只赌一个地址：
     1) 先用配置的地址试；
     2) 失败则扫一遍「LM Studio / lms / llama 相关进程占用的本地监听端口」；
     3) 对每个 端口 × 主机(127.0.0.1 / localhost / [::1]) × 路径(/v1 / /api/v1 / 根)
        并发探测 /models，谁先返回可用的模型列表就用谁。 */

const DISCOVERY_TTL_MS = 60000;
let discoveryCache = { baseUrl: '', at: 0 };

const SELF_PORTS = [5177, 5178, 5179, 9880, 9881];

function lmStudioPorts() {
  return new Promise((resolve) => {
    if (os.platform() !== 'win32') { resolve([]); return; }
    const script = "$ErrorActionPreference='SilentlyContinue';"
      + "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } |"
      + " ForEach-Object { $n = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName;"
      + " if ($n) { Write-Output ($_.LocalPort.ToString() + '|' + $n) } }";
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve([]); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* noop */ } resolve([]); }, 8000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('exit', () => {
      clearTimeout(timer);
      const ports = [];
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\|(.+)$/);
        if (!m) continue;
        const port = Number(m[1]);
        const name = m[2];
        if (!/lmstudio|lm studio|lms|llama|runtime/i.test(name)) continue;
        if (SELF_PORTS.includes(port)) continue;
        if (!ports.includes(port)) ports.push(port);
      }
      resolve(ports);
    });
  });
}

function candidatePorts(settings) {
  const ports = [];
  const fromConfig = String(settings && settings.baseUrl || '').match(/:(\d+)/);
  if (fromConfig) ports.push(Number(fromConfig[1]));
  [1234, 1235, 8080, 5000].forEach((p) => { if (!ports.includes(p)) ports.push(p); });
  return ports;
}

function buildCandidates(ports) {
  const hosts = ['127.0.0.1', 'localhost', '[::1]'];
  const paths = ['/v1', '/api/v1', ''];
  const list = [];
  for (const port of ports) {
    for (const host of hosts) {
      for (const p of paths) {
        list.push('http://' + host + ':' + port + p);
      }
    }
  }
  return list;
}

function parseModels(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.models)) return json.models;
  return [];
}

/* 新版 LM Studio 的模型对象用的是 key（不是 id），而且只有 loaded_instances 非空的
   才是真正已经加载好、能直接对话的模型。这里统一取一个可用 id，并优先挑已加载的。 */
function modelIdOf(m) {
  return (m && (m.id || m.name || m.key)) || '';
}

function pickModel(models) {
  const list = (models || []).filter((m) => !m.type || m.type === 'llm');
  const loaded = list.find((m) => Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0);
  const chosen = loaded || list.find((m) => modelIdOf(m)) || null;
  return chosen ? modelIdOf(chosen) : '';
}

async function probeOnce(baseUrl, apiKey, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + '/models', { headers: headers(apiKey), signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status };
    const json = await response.json();
    return { ok: true, models: parseModels(json) };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function discover(apiKey) {
  const ports = await lmStudioPorts();
  const candidates = buildCandidates(candidatePorts({ baseUrl: 'http://127.0.0.1:' + (ports[0] || 1234) + '/v1' })
    .concat(ports));
  // 先试端口被发现的那批，再试默认端口那一批
  const ordered = [];
  for (const c of candidates) if (!ordered.includes(c)) ordered.push(c);

  const limit = 10;
  let cursor = 0;
  const workers = new Array(Math.min(limit, ordered.length)).fill(0).map(async () => {
    while (true) {
      const index = cursor++;
      if (index >= ordered.length) return null;
      const url = ordered[index];
      const result = await probeOnce(url, apiKey);
      if (result.ok) return { ok: true, baseUrl: url, models: result.models };
    }
  });
  const results = await Promise.all(workers);
  return results.find((r) => r && r.ok) || results.find((r) => r) || null;
}

/* 返回一个真正可用的 baseUrl：优先用配置里的，不行就自动发现 */
async function resolveBaseUrl(settings) {
  const configured = normalizeBaseUrl(settings && settings.baseUrl);
  const direct = await ping(configured, settings && settings.apiKey, 2500);
  if (direct.ok) {
    discoveryCache = { baseUrl: configured, at: Date.now() };
    return { ok: true, baseUrl: configured, models: direct.models, discovered: false };
  }

  const cached = discoveryCache.baseUrl && (Date.now() - discoveryCache.at < DISCOVERY_TTL_MS)
    ? await probeOnce(discoveryCache.baseUrl, settings && settings.apiKey, 1500)
    : null;
  if (cached && cached.ok) {
    return { ok: true, baseUrl: discoveryCache.baseUrl, models: cached.models, discovered: true };
  }

  const found = await discover(settings && settings.apiKey);
  if (found && found.ok) {
    discoveryCache = { baseUrl: found.baseUrl, at: Date.now() };
    console.log('[lmstudio] 自动发现可用端点: ' + found.baseUrl);
    return { ok: true, baseUrl: found.baseUrl, models: found.models, discovered: true };
  }

  return {
    ok: false,
    baseUrl: configured,
    models: [],
    error: direct.error || ('HTTP ' + (direct.status || '未知')),
  };
}

async function ping(baseUrl, apiKey, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + '/models', {
      headers: headers(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const data = await response.json();
    const models = Array.isArray(data && data.data) ? data.data : [];
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function startLmsServer() {
  const lms = findLms();
  if (!lms) return Promise.resolve({ ok: false, error: '未找到 lms CLI（~/.lmstudio/bin/lms.exe）' });

  return new Promise((resolve) => {
    try {
      const child = spawn(lms, ['server', 'start'], { stdio: 'ignore', windowsHide: true });
      child.on('error', (error) => resolve({ ok: false, error: error.message }));
      child.on('exit', () => resolve({ ok: true }));
      setTimeout(() => resolve({ ok: true }), 15000);
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

async function ensureServer(baseUrl, apiKey, autoStart) {
  let result = await ping(baseUrl, apiKey);
  if (result.ok || !autoStart) return result;

  console.log('[lmstudio] api unreachable, trying to start local server...');
  await startLmsServer();

  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    result = await ping(baseUrl, apiKey, 3000);
    if (result.ok) {
      console.log('[lmstudio] local server is up.');
      return result;
    }
  }
  return result;
}

async function listModels(settings) {
  const resolved = await resolveBaseUrl(settings);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error || '连不上 LM Studio',
      hint: '没找到 LM Studio 的本地服务。请打开 LM Studio → 加载一个模型 → 开发者/Developer 里把本地服务打开；'
        + '新版 LM Studio（0.4.x）端口或路径可能不同，本应用会自动扫描，扫不到时请确认服务确实是 Started。',
    };
  }
  const models = (resolved.models || [])
    .filter((m) => !m.type || m.type === 'llm')
    .map((m) => ({
      id: modelIdOf(m),
      publisher: m.publisher,
      size: m.size_bytes,
      loaded: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0,
    }))
    .filter((m) => m.id);
  return {
    ok: true,
    models,
    baseUrl: resolved.baseUrl,
    discovered: !!resolved.discovered,
    hint: models.length
      ? (resolved.discovered ? ('已自动改用 ' + resolved.baseUrl) : '')
      : 'LM Studio 已连上，但还没加载模型。请在 LM Studio 里加载（Load）一个模型，再回来刷新。',
  };
}

async function chatStream(options) {
  const {
    baseUrl, apiKey, model, messages, temperature, maxTokens, signal,
    onDelta, onReasoning, onFinish,
  } = options;

  const controller = new AbortController();
  const timers = [];
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort());
  }

  const url = normalizeBaseUrl(baseUrl) + '/chat/completions';
  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? '已取消' : error.message };
  }

  if (!response.ok || !response.body) {
    let detail = '';
    try { detail = await response.text(); } catch (_) { /* ignore */ }
    return { ok: false, error: 'HTTP ' + response.status + ' ' + detail.slice(0, 300) };
  }

  const decoder = new TextDecoder('utf8');
  let buffer = '';
  let content = '';
  let reasoning = '';

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch (_) { continue; }
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (onReasoning) onReasoning(delta.reasoning_content);
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      return { ok: false, error: error.message, partial: content };
    }
  } finally {
    timers.forEach(clearTimeout);
  }

  if (content.length === 0 && reasoning.length > 0) content = '';
  if (onFinish) onFinish({ content, reasoning });
  return { ok: true, content, reasoning };
}

module.exports = {
  listModels, chatStream, ensureServer, ping, normalizeBaseUrl, findLms,
  resolveBaseUrl, discover, lmStudioPorts, pickModel, modelIdOf,
};
