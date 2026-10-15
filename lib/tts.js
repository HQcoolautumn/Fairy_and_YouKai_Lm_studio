'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { cleanWav } = require('./audio');

const LIB_DIR = __dirname;
const WORKER_SCRIPT = path.join(LIB_DIR, 'tts-worker.ps1');
const SPEAK_SCRIPT = path.join(LIB_DIR, 'tts-speak.ps1');
const VOICES_SCRIPT = path.join(LIB_DIR, 'tts-voices.ps1');

const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女·温柔）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女·活泼）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男·清朗）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男·沉稳）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北·女）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西·女）' },
  { id: 'zh-HK-WanLungNeural', name: '雲龍（粤语·男）' },
];

// 每次合成起一次 PowerShell 进程：比常驻 worker 慢一点，但在任何宿主环境下都稳定

function runPowerShell(scriptPath, extraArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    if (extraArgs) args.push.apply(args, extraArgs);

    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      reject(new Error('语音合成超时' + (stderr ? '：' + stderr.trim().slice(0, 200) : '')));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error('语音合成失败(' + code + ')：' + (stderr.trim() || stdout.trim() || '未知错误').slice(0, 300)));
    });
  });
}

function listLocalVoices() {
  return runPowerShell(VOICES_SCRIPT, [], 25000)
    .then((result) => {
      const parsed = JSON.parse(result.stdout.trim() || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((voice) => ({
        id: voice.id,
        name: voice.name + '（' + (voice.culture || '') + '）',
        culture: voice.culture,
        source: voice.source,
      }));
    })
    .catch((error) => {
      console.warn('[tts] list voices failed:', error.message);
      return [];
    });
}

function detectAudioType(buffer) {
  if (buffer.length > 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF') return 'audio/wav';
  if (buffer.length > 3 && buffer.slice(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buffer.length > 2 && buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return 'audio/mpeg';
  return 'audio/wav';
}

function synthesizeLocal(text, voice, rate, pitch) {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const textFile = path.join(os.tmpdir(), 'fairy-tts-' + stamp + '.txt');
  const audioFile = path.join(os.tmpdir(), 'fairy-tts-' + stamp + '.bin');

  try {
    fs.writeFileSync(textFile, text, { encoding: 'utf8' });
  } catch (error) {
    return Promise.reject(error);
  }

  const args = [
    '-TextFile', textFile,
    '-Voice', voice || '',
    '-Rate', String(Number(rate) || 0),
    '-Pitch', String(Number(pitch) || 0),
    '-Out', audioFile,
  ];

  return runPowerShell(SPEAK_SCRIPT, args, 45000)
    .then(() => {
      const buffer = fs.readFileSync(audioFile);
      return { contentType: detectAudioType(buffer), buffer };
    })
    .finally(() => {
      try { fs.unlinkSync(textFile); } catch (_) { /* noop */ }
      try { fs.unlinkSync(audioFile); } catch (_) { /* noop */ }
    });
}

// ---------------------------------------------------------------- Edge TTS

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4D';
const SEC_VERSION = '1-130.0.2849.68';

function secMsGec() {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  return crypto.createHash('sha256').update(String(rounded) + TRUSTED_TOKEN, 'ascii').digest('hex').toUpperCase();
}

function connectionId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function edgeSsml(text, voice, rate, pitch) {
  const rateValue = Number(rate) || 0;
  const rateAttr = (rateValue >= 0 ? '+' : '') + rateValue + '%';
  const pitchValue = Number(pitch) || 0;
  const pitchAttr = (pitchValue >= 0 ? '+' : '') + pitchValue + 'Hz';
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">'
    + '<voice name="' + voice + '">'
    + '<prosody rate="' + rateAttr + '" pitch="' + pitchAttr + '">' + escapeXml(text) + '</prosody>'
    + '</voice></speak>';
}

async function synthesizeEdge(text, voice, rate, pitch) {
  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error('当前 Node 版本不支持 WebSocket，无法使用在线音色');

  const requestId = connectionId();
  const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
    + '?TrustedClientToken=' + TRUSTED_TOKEN
    + '&Sec-MS-GEC=' + secMsGec()
    + '&Sec-MS-GEC-Version=' + SEC_VERSION
    + '&ConnectionId=' + requestId;

  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocketImpl(url, { 'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfoldm' });
    } catch (error) {
      reject(error);
      return;
    }
    socket.binaryType = 'arraybuffer';

    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch (_) { /* noop */ }
        reject(new Error('在线合成超时'));
      }
    }, 25000);

    const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    socket.addEventListener('open', () => {
      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      });
      const configMessage = 'X-Timestamp:' + now() + '\r\n'
        + 'Content-Type:application/json; charset=utf-8\r\n'
        + 'Path:speech.config\r\n\r\n' + config;
      socket.send(configMessage);

      const ssml = edgeSsml(text, voice, rate, pitch);
      const ssmlMessage = 'Path:ssml\r\n'
        + 'X-RequestId:' + requestId + '\r\n'
        + 'X-Timestamp:' + now() + '\r\n'
        + 'Content-Type:application/ssml+xml\r\n\r\n' + ssml;
      socket.send(ssmlMessage);
    });

    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch (_) { /* noop */ }
            resolve({ contentType: 'audio/mpeg', buffer: Buffer.concat(chunks) });
          }
        }
        return;
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const separator = buffer.indexOf('\r\n\r\n');
      const audio = separator >= 0 ? buffer.slice(separator + 4) : buffer;
      if (audio.length) chunks.push(audio);
    });

    socket.addEventListener('error', (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('在线合成失败（需要联网）：' + ((event && event.message) || '')));
      }
    });

    socket.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (chunks.length) resolve({ contentType: 'audio/mpeg', buffer: Buffer.concat(chunks) });
        else reject(new Error('在线合成无返回'));
      }
    });
  });
}

// ----------------------------------------------------------- GPT-SoVITS 兼容

async function synthesizeSovits(text, settings) {
  if (!settings || !settings.sovitsUrl) throw new Error('未配置 GPT-SoVITS 服务地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(settings.sovitsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        text_lang: settings.sovitsTextLang || 'zh',
        ref_audio_path: settings.sovitsRefAudio || '',
        prompt_text: settings.sovitsPromptText || '',
        prompt_lang: settings.sovitsPromptLang || 'zh',
        text_split_method: 'cut5',
        batch_size: 1,
        media_type: 'wav',
        parallel_infer: false,
        // 采样参数：略微收紧随机性，减少句尾的毛刺与杂色
        top_k: settings.sovitsTopK || 12,
        top_p: settings.sovitsTopP || 1,
        temperature: settings.sovitsTemperature || 0.9,
        repetition_penalty: settings.sovitsRepetitionPenalty || 1.35,
        speed_factor: settings.sovitsSpeed || 1.0,
        split_bucket: true,
        fragment_interval: 0.3,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('GPT-SoVITS HTTP ' + response.status);
    let buffer = Buffer.from(await response.arrayBuffer());

    // 后处理：压掉 GPT-SoVITS 常见的句尾/字间底噪（失败就原样返回，绝不让播放炸掉）
    if (settings.sovitsDenoise !== false && buffer.length > 1024 && buffer.toString('ascii', 0, 4) === 'RIFF') {
      try {
        buffer = cleanWav(buffer, 'tts');
      } catch (_) { /* noop */ }
    }

    return { contentType: 'audio/wav', buffer };
  } finally {
    clearTimeout(timer);
  }
}

async function listVoices(settings) {
  const engines = [
    { id: 'local', name: '系统离线音色', available: true },
    { id: 'edge', name: '在线音色（需联网）', available: true },
    { id: 'sovits', name: 'GPT-SoVITS 本地音响（9880）', available: false },
  ];

  const voices = { local: [], edge: EDGE_VOICES, sovits: [] };

  voices.local = await listLocalVoices();
  if (!voices.local.length) engines[0].available = false;

  if (settings && settings.sovitsUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(settings.sovitsUrl.replace(/\/tts\/?$/, '/docs'), { signal: controller.signal });
      clearTimeout(timer);
      engines[2].available = response.ok;
    } catch (_) {
      engines[2].available = false;
    }
  }

  return { engines, voices };
}

async function synthesize(text, options) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('空文本');

  switch ((options && options.engine) || 'local') {
    case 'edge':
      return synthesizeEdge(trimmed, options.voice || EDGE_VOICES[0].id, options.rate, options.pitch);
    case 'sovits':
      return synthesizeSovits(trimmed, options.settings || {});
    default:
      return synthesizeLocal(trimmed, options.voice, options.rate, options.pitch);
  }
}

function shutdown() {
  // 单次调用模式没有常驻进程，无需清理
}

module.exports = { listVoices, synthesize, shutdown, EDGE_VOICES };
