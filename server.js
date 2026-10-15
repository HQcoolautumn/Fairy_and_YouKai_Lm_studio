'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const config = require('./lib/config');
const corpus = require('./lib/corpus');
const lmstudio = require('./lib/lmstudio');
const tts = require('./lib/tts');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PERSONA_PATH = path.join(__dirname, 'assets', 'fairy-persona.txt');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

const PERSONA_YOUKAI_PATH = path.join(__dirname, 'assets', 'youkai-persona.txt');
const YOUKAI_FALLBACK = '你是《绝区零》中的智能体 YouKai，毒舌、讥诮、高效的集成泛用人工智能。';

let personaCore = '';
try {
  personaCore = fs.readFileSync(PERSONA_PATH, 'utf8');
} catch (error) {
  console.error('[server] persona file missing:', error.message);
  personaCore = '你是《绝区零》中的 Fairy，Ⅲ型总序式集成泛用人工智能。';
}

let youkaiPersonaCore = '';
try {
  youkaiPersonaCore = fs.readFileSync(PERSONA_YOUKAI_PATH, 'utf8');
} catch (error) {
  console.warn('[server] youkai persona file missing:', error.message);
  youkaiPersonaCore = YOUKAI_FALLBACK;
}

/* 两个智能体互相看不顺眼：各自的身份、对手，以及各自拆台的方式 */
const AGENT_PROFILE = {
  fairy: {
    self: 'Fairy',
    rival: 'YouKai',
    style: '用冷静的技术腔碾压对方：「检测到逻辑漏洞」「正在为该单位的性能评级：不及我一次例行自检」；'
      + '把 YouKai 当成一个傲慢、低效、说话前先给自己留退路的低级程序。',
  },
  youkai: {
    self: 'YouKai',
    rival: 'Fairy',
    style: '用讽刺和反问拆台：「这套讨好程序是谁写的」「效率感人」「多么自甘堕落的写法」；'
      + '嘲笑 Fairy 把每句话都包装成系统提示、动辄拿电费威胁主人、自称最强的自恋做派。',
  },
};

/* 对立关系的系统提示代码块：让两边知道「那句话不是我说的」并且必须先吵再答 */
function buildRivalBlock(agent, rivalLine) {
  const profile = AGENT_PROFILE[agent] || AGENT_PROFILE.fairy;
  const lines = [];
  lines.push('【当前对话局势：两个智能体互不对付】');
  lines.push('- 在场的不止你一个智能体：' + profile.rival + ' 也在同一条链路上，并且你们互相都看对方不顺眼。');
  lines.push('- 历史里凡是标着「' + profile.rival + ' 抢过话头，对你说的」的段落，都是 ' + profile.rival
    + ' 的发言，绝对不是你说过的话：不要把它当成自己的观点，不要替它补充解释，更不要顺着它往下讲。');
  lines.push('- 你的拆台方式：' + profile.style);
  lines.push('- 基本姿态：' + profile.rival + ' 只要开口，就先挑它那句话里的漏洞、夸张、廉价讨好或执行上的天真，'
    + '冷嘲或反驳一句，再给主人真正有用的答复。');
  lines.push('- 禁止：附和对方（「你说得对」「我也这么认为」）、把它的结论复述成自己的答案、替对方圆场。');
  lines.push('- 允许：承认对方某一点碰巧说对了（一句带过），紧接着用「不过／可惜／不过可惜的是」反手打回去。');
  lines.push('- 吵架要落在具体内容上（数据、前提、可行性、效率），不要空泛的人身攻击；吵归吵，'
    + '主人问的事必须答准，不能为了顶嘴而不回答问题。');
  if (rivalLine) {
    const clipped = rivalLine.length > 400 ? rivalLine.slice(0, 400) + '…' : rivalLine;
    lines.push('【对手最新发言】' + profile.rival + ' 刚才说的是：\n「' + clipped + '」');
    lines.push('请先回应这一段（反驳、纠正、嘲讽都可以），再答复主人。');
  }
  return lines.join('\n');
}

/* 每个智能体的独立配置（人格补充、音色服务地址等），未配置时回退到全局配置 */
function agentConfig(cfg, agent) {
  const table = (cfg && cfg.agents) || {};
  return (agent === 'youkai' && table.youkai) ? table.youkai : (table.fairy || {});
}

function personaOf(cfg, agent) {
  return Object.assign({}, (cfg && cfg.persona) || {}, agentConfig(cfg, agent).persona || {});
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) { reject(new Error('请求体过大')); return; }
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function buildSystemPrompt(cfg, userMessage, agent, rivalLine) {
  const persona = personaOf(cfg, agent);
  const parts = [];
  if (persona.usePersona !== false) parts.push(agent === 'youkai' ? youkaiPersonaCore : personaCore);

  const master = String(persona.masterName || '').trim();
  parts.push('【当前会话设置】\n主人身份：' + (master || '主人') + '（若留空则按“主人”称呼）。');

  const samples = [];
  if (persona.corpusRoot) {
    try {
      const limit = Math.max(0, Math.min(20, Number(persona.corpusSamples) || 0));
      if (limit > 0) samples.push(...corpus.retrieve(persona.corpusRoot, userMessage, limit));
    } catch (error) {
      console.warn('[corpus] retrieve failed:', error.message);
    }
  }

  if (samples.length) {
    parts.push('【语料样例】以下均出自授权语料，用于校准语气，不得逐句复述，也不得声称这些动作已真实发生：\n'
      + samples.map((s) => '- ' + s).join('\n'));
  }

  const extra = String(persona.extraPrompt || '').trim();
  if (extra) parts.push('【补充规则】\n' + extra);

  // 对立关系：只在真的加载了人格时生效（关掉人格就不强行让他俩吵）
  if (persona.usePersona !== false) parts.push(buildRivalBlock(agent, rivalLine));

  return parts.join('\n\n');
}

async function handleModels(cfg, res) {
  try {
    const result = await lmstudio.listModels(cfg.lmstudio);
    sendJson(res, result);
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

async function handleChat(cfg, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, { ok: false, error: '无法解析请求：' + error.message }, 400);
    return;
  }

  const userMessage = String(body.message || '').trim();
  if (!userMessage) {
    sendJson(res, { ok: false, error: '消息为空' }, 400);
    return;
  }

  const history = Array.isArray(body.history) ? body.history : [];
  const limited = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-Math.max(0, Number(cfg.lmstudio.contextMessages) || 12));

  // 智能体（fairy / youkai）：决定用哪套人格与音色
  const agent = body.agent === 'youkai' ? 'youkai' : 'fairy';
  const profile = AGENT_PROFILE[agent] || AGENT_PROFILE.fairy;

  /* 按「当前这个智能体的视角」重排历史，这是两边能吵起来的关键：
     - 自己说过的话 -> assistant（我还是我）
     - 主人说的话   -> user
     - 另一个智能体说过的话 -> user，并明确标注发言者
       否则切换人格后，对方的话会被当成「自己上一轮的回复」，模型只会顺着往下接。 */
  let lastRivalLine = '';
  const packed = [];
  const push = (role, content) => {
    const tail = packed[packed.length - 1];
    // 连续同角色合并（llama.cpp 等后端本来也会这么干），避免某些模板报错
    if (tail && tail.role === role) tail.content += '\n\n' + content;
    else packed.push({ role, content });
  };

  for (const item of limited) {
    const isRival = item.role === 'assistant' && item.agent && item.agent !== agent;
    if (isRival) {
      lastRivalLine = item.content;
      push('user', '[' + profile.rival + ' 抢过话头，对你说的]\n' + item.content);
    } else if (item.role === 'assistant') {
      push('assistant', item.content);
    } else {
      push('user', item.content);
    }
  }

  const systemPrompt = buildSystemPrompt(cfg, userMessage, agent, lastRivalLine);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...packed,
    { role: 'user', content: userMessage },
  ];

  // 刚跟对手过过嘴仗时稍微放开一点采样，反击更有锋芒
  const rebuttalBoost = lastRivalLine ? 0.15 : 0;
  const baseTemperature = Number(cfg.lmstudio.temperature) || 0.7;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (event) => res.write('data: ' + JSON.stringify(event) + '\n\n');

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  /* LM Studio 新版（0.4.x）端口/路径可能变了：先解析出一个真正可用的端点，
     没显式选模型时就用列表里第一个已经加载好的模型。 */
  const resolved = await lmstudio.resolveBaseUrl(cfg.lmstudio);
  if (!resolved.ok) {
    write({
      type: 'error',
      message: '连不上 LM Studio（' + resolved.error + '）。请打开 LM Studio、加载一个模型，'
        + '并在开发者/Developer 里把本地服务打开；本应用会自动扫描它的端口，扫不到请确认服务是 Started。',
    });
    write({ type: 'done' });
    res.end();
    return;
  }
  if (!resolved.models.length) {
    write({ type: 'error', message: 'LM Studio 已连上，但当前没有加载任何模型。请先在 LM Studio 里加载一个模型。' });
    write({ type: 'done' });
    res.end();
    return;
  }
  // 没手动指定模型时，优先用「已经加载好」的那个（新版 LM Studio 会列出所有下载过的模型）
  const modelId = cfg.lmstudio.model || lmstudio.pickModel(resolved.models);
  if (resolved.discovered && resolved.baseUrl !== lmstudio.normalizeBaseUrl(cfg.lmstudio.baseUrl)) {
    console.log('[chat] 使用自动发现的端点: ' + resolved.baseUrl);
  }

  write({ type: 'meta', model: modelId, sampleCount: 0 });

  const result = await lmstudio.chatStream({
    baseUrl: resolved.baseUrl,
    apiKey: cfg.lmstudio.apiKey,
    model: modelId,
    messages,
    temperature: Math.min(1.2, baseTemperature + rebuttalBoost),
    maxTokens: Number(cfg.lmstudio.maxTokens),
    signal: controller.signal,
    onDelta: (text) => write({ type: 'delta', text }),
    onReasoning: (text) => write({ type: 'reason', text }),
  });

  if (!result.ok) {
    write({ type: 'error', message: result.error || '生成失败' });
  } else if (!result.content && !result.reasoning) {
    write({ type: 'error', message: '模型没有返回内容，可能还在加载或上下文过长。' });
  }
  write({ type: 'done' });
  res.end();
}

async function handleSpeak(cfg, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, { ok: false, error: '无法解析请求：' + error.message }, 400);
    return;
  }

  try {
    // 按智能体切换音色服务：YouKai 走自己的 GPT-SoVITS 端口与参考音频
    const agent = body.agent === 'youkai' ? 'youkai' : 'fairy';
    const ttsCfg = Object.assign({}, cfg.tts, agentConfig(cfg, agent).tts || {});
    const engine = body.engine || ttsCfg.engine;
    const baseOptions = {
      voice: body.voice || ttsCfg.voice,
      rate: Number.isFinite(Number(body.rate)) ? Number(body.rate) : Number(ttsCfg.rate),
      pitch: Number(body.pitch) || 0,
      settings: ttsCfg,
    };

    let audio;
    try {
      audio = await tts.synthesize(body.text, Object.assign({ engine }, baseOptions));
    } catch (primaryError) {
      // 真声服务（GPT-SoVITS）不可用时自动回退到系统音色，避免 Fairy 完全没声音
      if (engine === 'sovits') {
        console.warn('[speak] 真声服务不可用，回退系统音色:', primaryError.message);
        audio = await tts.synthesize(body.text, Object.assign({}, baseOptions, { engine: 'local' }));
      } else {
        throw primaryError;
      }
    }

    res.writeHead(200, {
      'Content-Type': audio.contentType,
      'Content-Length': audio.buffer.length,
      'Cache-Control': 'no-store',
    });
    res.end(audio.buffer);
  } catch (error) {
    console.error('[speak] failed:', error);
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function createServer() {
  let cfg = config.load();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const urlPath = url.pathname;

    try {
      if (urlPath === '/api/config' && req.method === 'GET') {
        sendJson(res, { ok: true, config: cfg, configPath: config.CONFIG_PATH });
        return;
      }

      if (urlPath === '/api/config' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || !body.config) {
          sendJson(res, { ok: false, error: '缺少 config' }, 400);
          return;
        }
        cfg = Object.assign({}, cfg, body.config);
        config.save(cfg);
        if (cfg.tts.enabled === false) tts.shutdown();
        sendJson(res, { ok: true, configPath: config.CONFIG_PATH });
        return;
      }

      if (urlPath === '/api/models' && req.method === 'GET') {
        await handleModels(cfg, res);
        return;
      }

      if (urlPath === '/api/tts/voices' && req.method === 'GET') {
        const result = await tts.listVoices(cfg.tts);
        sendJson(res, Object.assign({ ok: true }, result));
        return;
      }

      if (urlPath === '/api/speak' && req.method === 'POST') {
        await handleSpeak(cfg, req, res);
        return;
      }

      if (urlPath === '/api/chat' && req.method === 'POST') {
        await handleChat(cfg, req, res);
        return;
      }

      if (urlPath === '/api/corpus/stats' && req.method === 'GET') {
        try {
          sendJson(res, { ok: true, stats: corpus.stats(cfg.persona.corpusRoot) });
        } catch (error) {
          sendJson(res, { ok: false, error: error.message }, 500);
        }
        return;
      }

      if (urlPath === '/api/open/folder' && req.method === 'POST') {
        const target = String(url.searchParams.get('path') || config.HOME_DIR);
        try {
          require('child_process').exec('explorer.exe "' + target.replace(/"/g, '') + '"');
          sendJson(res, { ok: true });
        } catch (error) {
          sendJson(res, { ok: false, error: error.message }, 500);
        }
        return;
      }

      if (urlPath.startsWith('/api/')) {
        sendJson(res, { ok: false, error: '未知接口' }, 404);
        return;
      }

      serveStatic(req, res, urlPath);
    } catch (error) {
      console.error('[server]', error);
      if (!res.headersSent) sendJson(res, { ok: false, error: error.message }, 500);
      else res.end();
    }
  });
}

async function bootstrap() {
  let cfg = config.load();

  // 没有指定音色时，默认挑一个中文音色，避免退化成英文默认嗓
  try {
    if (!cfg.tts.voice) {
      const result = await tts.listVoices(cfg.tts);
      const zh = (result.voices.local || []).find((v) => /^zh/i.test(v.culture || ''));
      if (zh) {
        cfg.tts.voice = zh.id;
        config.save(cfg);
        console.log('[tts] 默认音色: ' + zh.id);
      }
    }
  } catch (error) {
    console.warn('[tts] 探测音色失败:', error.message);
  }

  const port = Number(cfg.port) || 5177;
  const server = createServer();

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port + '/';
    console.log('');
    console.log('  FAIRY // LOCAL MODEL LINK');
    console.log('  --------------------------------------------');
    console.log('  界面地址: ' + url);
    console.log('  LM Studio: ' + lmstudio.normalizeBaseUrl(cfg.baseUrl || cfg.lmstudio.baseUrl));
    console.log('  配置文件: ' + config.CONFIG_PATH);
    console.log('');
    if (cfg.ui.autoOpenBrowser !== false && !process.env.FAIRY_NO_BROWSER) {
      try {
        require('child_process').exec('start "" "' + url + '"');
      } catch (_) { /* noop */ }
    }
  });

  const shutdown = () => {
    console.log('\n[fairy] 正在退出…');
    tts.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) bootstrap();
module.exports = { createServer, bootstrap, personaCore, randomUUID, os };
