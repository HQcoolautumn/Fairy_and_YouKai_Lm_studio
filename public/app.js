'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  models: [],
  voices: { local: [], edge: [], sovits: [] },
  conversation: [],
  streaming: false,
  speaking: false,
  comforting: false,
  controller: null,
  audioUrls: [],
};

const PRESETS = {
  greet: 'Fairy，你在吗？',
  status: '播报一下当前链路状态。',
  joke: '说一句 Fairy 风格的冷笑话。',
};

function setStatus(name, hint) {
  document.body.className = document.body.className
    .replace(/state-\S+/g, '').trim();
  if (name) document.body.classList.add('state-' + name);
  $('state-label').textContent = labelOf(name);
  $('state-hint').textContent = hint || '';

  const avatar = $('avatar');
  if (avatar) avatar.setAttribute('data-state', visualStateOf(name));
}

function visualStateOf(name) {
  switch (name) {
    case 'thinking': return 'thinking';
    case 'speaking': return 'speaking';
    case 'comforting': return 'comforting';
    case 'error': return 'error';
    default: return 'normal';
  }
}

function flickerOnce() {
  const avatar = $('avatar');
  if (!avatar) return;
  avatar.setAttribute('data-flicker', 'true');
  setTimeout(() => avatar.removeAttribute('data-flicker'), 320);
}

// -------------------------------------------------- 动画反应（移植自 Fairy-DSH）

const COMFORT_HINTS = ['别担心', '别怕', '没关系', '没事的', '加油', '抱抱', '辛苦了',
  '注意安全', '小心', '慢慢来', '安心', '放心', '不用担心', '振作', '我陪着', '我在这里'];
const DISTRESS_HINTS = ['好累', '好难', '难过', '心烦', '崩溃', '压力大', '害怕', '紧张',
  '失落', '失败', '焦虑', '难受', '孤单', '委屈', '撑不住', '想哭'];

function isComforting(text, userText) {
  const reply = String(text || '');
  const ask = String(userText || '');
  if (DISTRESS_HINTS.some((key) => ask.includes(key))) return true;
  return COMFORT_HINTS.some((key) => reply.includes(key));
}

function setLifecycle(value) {
  const avatar = $('avatar');
  if (avatar) avatar.setAttribute('data-lifecycle', value);
}

/* 偶发故障：同一时刻只允许一个，避免与状态切换互相打断 */
const glitchState = { timer: null, clear: null };

function fireGlitch() {
  // 必须取当前显示的那一套形象：另一套是 display:none，动它画面上看不到
  const mascot = document.querySelector('body[data-agent="youkai"] .mascot-youkai')
    || document.querySelector('.mascot-fairy');
  const signal = mascot && mascot.querySelector('.fairy-signal');
  if (!signal) return;
  signal.style.setProperty('--fairy-g-x', ((Math.random() * 2 - 1) * 3).toFixed(2) + 'px');
  signal.style.setProperty('--fairy-g-skew', ((Math.random() * 2 - 1) * 1.2).toFixed(2) + 'deg');
  signal.style.setProperty('--fairy-g-bright', (1.06 + Math.random() * 0.12).toFixed(2));
  signal.style.setProperty('--fairy-g-contrast', (1.10 + Math.random() * 0.14).toFixed(2));
  signal.setAttribute('data-glitch', 'true');

  clearTimeout(glitchState.clear);
  glitchState.clear = setTimeout(() => {
    signal.removeAttribute('data-glitch');
    ['--fairy-g-x', '--fairy-g-skew', '--fairy-g-bright', '--fairy-g-contrast']
      .forEach((name) => signal.style.removeProperty(name));
  }, 140 + Math.random() * 160);
}

function scheduleGlitch() {
  clearTimeout(glitchState.timer);
  glitchState.timer = setTimeout(() => {
    if (!document.hidden) fireGlitch();
    scheduleGlitch();
  }, 5000 + Math.random() * 9000);
}

/* HDD 模式切换时的整帧故障过渡 */
function transitionGlitch() {
  const avatar = $('avatar');
  if (!avatar) return;
  avatar.setAttribute('data-transition-glitch', 'true');
  setTimeout(() => avatar.removeAttribute('data-transition-glitch'), 340);
}

// -------------------------------------------------- 主题（深色系 / 浅色系）

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', value === 'light');
  const label = $('theme-label');
  if (label) label.textContent = value === 'light' ? '浅色' : '深色';
  const select = $('set-theme');
  if (select) select.value = value;
  if (state.config) state.config.ui = Object.assign({}, state.config.ui, { theme: value });
}

/* -------------------------------------------------- 智能体（Fairy ⇄ YouKai） */

function currentAgent() {
  return document.body.getAttribute('data-agent') === 'youkai' ? 'youkai' : 'fairy';
}

function agentName() {
  return currentAgent() === 'youkai' ? 'YOUKAI' : 'FAIRY';
}

/* 切换形象 + 整页主题（YouKai 为红色系），选择持久化到 config.ui.agent */
function applyAgent(agent) {
  const value = agent === 'youkai' ? 'youkai' : 'fairy';
  document.body.setAttribute('data-agent', value);
  const label = $('agent-label');
  if (label) label.textContent = value === 'youkai' ? 'YouKai' : 'Fairy';
  const brand = document.querySelector('.brand-title');
  if (brand) brand.textContent = agentName();
  document.title = agentName() + ' // LOCAL MODEL LINK';
  const input = $('input');
  if (input) input.placeholder = '向 ' + agentName() + ' 下达指令…（Enter 发送 / Shift+Enter 换行）';
  if (state.config) state.config.ui = Object.assign({}, state.config.ui, { agent: value });
}

/* 真·全屏：进全屏播动画，播完/跳过再退回普通窗口。失败就退回铺满网页，不影响使用 */
function enterFullscreen(el) {
  if (!el) return;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(el);
    if (p && typeof p.catch === 'function') p.catch(() => { /* 被拒绝就用网页内全屏兜底 */ });
  } catch (_) { /* noop */ }
}

function exitFullscreen() {
  const active = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
  if (!active) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (!exit) return;
  try {
    const p = exit.call(document);
    if (p && typeof p.catch === 'function') p.catch(() => { /* noop */ });
  } catch (_) { /* noop */ }
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}

/* 启动器用的是浏览器级全屏（等同 F11），Fullscreen API 查不到它，只能靠窗口尺寸判断 */
function inBrowserFullscreen() {
  try {
    return window.innerHeight >= (screen.height - 2) && window.innerWidth >= (screen.width - 2);
  } catch (_) {
    return false;
  }
}

/* 顶栏那个 ⛶：进入/退出全屏。退出也可以直接按 Esc（浏览器原生行为） */
function toggleFullscreen() {
  if (isFullscreen()) { exitFullscreen(); return; }
  if (inBrowserFullscreen()) { setStatus('idle', '已经是全屏了，按 Esc 退出'); return; }
  enterFullscreen(document.documentElement);
}

function syncFullscreenButton() {
  const btn = $('btn-fullscreen');
  if (!btn) return;
  const on = isFullscreen();
  btn.textContent = on ? '⤡' : '⛶';
  btn.title = on ? '退出全屏（也可按 Esc）' : '进入全屏（Esc 退出）';
}

/* 兼容 --start-fullscreen 偶尔不生效的情况：
   带 ?fs=1 打开时先自己试一次，被浏览器拦了就在用户第一次点击/按键时补一次。 */
function armAutoFullscreen() {
  if (!/[?&]fs=1(?:&|$)/.test(location.search)) return;
  // 启动器的 --start-fullscreen 已经生效时别再叠一层 Fullscreen API
  if (isFullscreen() || inBrowserFullscreen()) return;
  const once = () => {
    document.removeEventListener('pointerdown', once);
    document.removeEventListener('keydown', once);
    if (!isFullscreen()) enterFullscreen(document.documentElement);
  };
  enterFullscreen(document.documentElement);
  document.addEventListener('pointerdown', once);
  document.addEventListener('keydown', once);
}

/* Fairy 开机动画：每次打开页面都播一次（开机音效 + 自检日志逐字打印），
   点击任意处 / 按 Esc 都能跳过；音效被浏览器拦了就静音播，绝不卡住动画。 */
const BOOT_LOG_LINES = [
  '> 建立本地链路 ………… [OK]',
  '> 校验人格完整性 ……… [OK]',
  '> 接入本地推理宿主 …… [OK]',
  '> FAIRY // LINK READY',
];

function playFairyBoot() {
  const overlay = $('fairy-boot');
  const log = $('boot-log');
  const audio = $('fairy-boot-audio');
  const skip = $('boot-skip');
  if (!overlay) return;

  const timers = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    timers.length = 0;
    overlay.classList.remove('show');
    try { if (audio) { audio.pause(); audio.currentTime = 0; } } catch (_) { /* noop */ }
  };

  if (log) log.innerHTML = '';
  overlay.classList.add('show');
  if (skip) skip.onclick = finish;
  overlay.onclick = finish;

  if (audio) {
    try { audio.currentTime = 0; } catch (_) { /* noop */ }
    const playing = audio.play();
    if (playing && typeof playing.catch === 'function') {
      playing.catch(() => {
        try { audio.muted = true; } catch (_) { /* noop */ }
        const retry = audio.play();
        if (retry && typeof retry.catch === 'function') retry.catch(() => { /* noop */ });
      });
    }
  }

  BOOT_LOG_LINES.forEach((line, i) => {
    timers.push(setTimeout(() => {
      if (finished || !log) return;
      const row = document.createElement('span');
      log.appendChild(row);
      let k = 0;
      const step = () => {
        if (finished) return;
        k += 1;
        const head = line.slice(0, k);
        const done = k >= line.length;
        const mark = line.indexOf('[');
        if (done && mark > 0) row.innerHTML = head.slice(0, mark) + '<em>' + head.slice(mark) + '</em>';
        else row.textContent = head;
        if (!done) timers.push(setTimeout(step, 14));
      };
      step();
    }, 240 + i * 560));
  });

  // 兜底：无论发生什么，到点一定收起，绝不把界面锁在开机画面
  timers.push(setTimeout(finish, 240 + BOOT_LOG_LINES.length * 560 + 1100));
}

/* YouKai 开场动画：每次切换到 YouKai 都完整播放一次（没有「仅首次」限制），可点击/按 Esc 跳过 */
function playYouKaiIntro() {
  const overlay = $('youkai-intro');
  const video = $('youkai-intro-video');
  if (!overlay || !video) return;

  let guard = null;
  let fsTimer = null;

  const finish = () => {
    if (guard) { clearTimeout(guard); guard = null; }
    if (fsTimer) { clearTimeout(fsTimer); fsTimer = null; }
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    overlay.classList.remove('show');
    try { video.pause(); video.currentTime = 0; } catch (_) { /* noop */ }
    // 等淡出结束再退出全屏，避免中间闪一下页面
    fsTimer = setTimeout(exitFullscreen, 420);
  };

  // 按 Esc 时浏览器会自己退出全屏，这里补一刀把动画一起收掉
  const onFsChange = () => {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (!active && overlay.classList.contains('show')) finish();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // 兜底：视频卡住 / 时长读不到时也要按时收起，绝不把界面锁死
  const armGuard = () => {
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const ms = Math.min(Math.max(d > 0 ? d * 1000 + 600 : 12000, 1500), 30000);
    if (guard) clearTimeout(guard);
    guard = setTimeout(finish, ms);
  };

  video.onended = finish;
  video.onerror = finish;
  video.onloadedmetadata = armGuard;
  const skip = $('intro-skip');
  if (skip) skip.onclick = finish;

  // 每次都从头播，避免残留上次进度导致「看起来没播」
  try { video.currentTime = 0; } catch (_) { /* noop */ }
  // 必须先显示再申请全屏：对 visibility:hidden 的元素请求全屏会被拒绝
  overlay.classList.add('show');
  enterFullscreen(overlay);
  armGuard();

  const start = () => {
    const playing = video.play();
    if (playing && typeof playing.catch === 'function') {
      playing.catch(() => {
        // 浏览器拦截带声音的自动播放时，静音重试一次，保证动画一定播出来
        try { video.muted = true; } catch (_) { /* noop */ }
        const retry = video.play();
        if (retry && typeof retry.catch === 'function') retry.catch(finish);
      });
    }
  };
  start();
}

/* 只回写 ui 片段，避免覆盖抽屉里尚未保存的其他设置 */
async function saveUiPatch(patch) {
  if (!state.config) return;
  const ui = Object.assign({}, state.config.ui, patch);
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: Object.assign({}, state.config, { ui }) }),
    });
    const data = await response.json();
    if (data.ok) state.config = Object.assign({}, state.config, { ui });
  } catch (_) { /* 主题仅本地生效，失败不影响使用 */ }
}

function labelOf(name) {
  switch (name) {
    case 'thinking': return '分析中';
    case 'speaking': return '播报中';
    case 'comforting': return '安抚中';
    case 'error': return '异常';
    default: return '待机';
  }
}

function setMeter(id, value) {
  const el = $(id);
  if (el) el.style.width = Math.max(0, Math.min(100, value)) + '%';
}

function setChip(id, text, kind) {
  const el = $(id);
  if (!el) return;
  if (kind === 'dot') {
    el.className = 'chip ' + (text || '');
    return;
  }
  el.className = 'chip mono ' + (kind || '');
  el.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => '<pre><code>' + code.replace(/^\n/, '') + '</code></pre>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/^\s*###?\s+(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>');
  html = html.replace(/^\s*\d+\.\s+(.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  const blocks = html.split(/\n{2,}/).map((block) => {
    if (/^\s*<(pre|ul|ol|h3|li)/.test(block)) return block;
    return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
  });
  return blocks.join('');
}

function stripForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, '。代码块已省略。')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' 链接 ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_#>|~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  const cleaned = stripForSpeech(text);
  if (!cleaned) return [];
  const rough = cleaned.replace(/([。！？；：!?;])/g, '$1\u0001').split('\u0001');
  const parts = [];
  for (const piece of rough) {
    const value = piece.trim();
    if (!value) continue;
    if (value.length > 60) {
      const chunks = value.match(/[\s\S]{1,45}(?:[，,、]|[^，,、]{0,10}$)/g) || [value];
      parts.push(...chunks.map((c) => c.trim()).filter(Boolean));
    } else if (parts.length && value.length < 4) {
      parts[parts.length - 1] += value;
    } else {
      parts.push(value);
    }
  }
  return parts.filter((p) => /[一-龥A-Za-z0-9]/.test(p));
}

function addMessage(role) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = role === 'user' ? 'MASTER' : role === 'fairy' ? agentName() + ' // HDD' : 'SYSTEM';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.appendChild(meta);
  wrap.appendChild(bubble);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
  return { wrap, bubble };
}

function addSystem(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg system';
  wrap.textContent = text;
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
}

// ------------------------------------------------------------------ 音频播放

const player = $('player');
let audioQueue = [];
let audioIndex = 0;
let stopAudioFlag = false;

function releaseAudio() {
  audioQueue.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
  audioQueue = [];
  audioIndex = 0;
}

async function playQueue() {
  if (stopAudioFlag || audioIndex >= audioQueue.length) {
    state.speaking = false;
    state.comforting = false;
    setStatus('idle', '链路待命');
    releaseAudio();
    return;
  }
  state.speaking = true;
  setStatus(state.comforting ? 'comforting' : 'speaking', '正在播报第 ' + (audioIndex + 1) + '/' + audioQueue.length + ' 段');

  const current = audioQueue[audioIndex];
  // 这一段的合成必须真正完成才能播。ensureReady 会把同一个 Promise 缓存在 item.job 上，
  // 所以这里 await 的是「正在进行的那一次请求」，而不是重新发一次、也不是直接放弃。
  if (!current.url && !current.failed) {
    setStatus(state.comforting ? 'comforting' : 'speaking', '正在合成第 ' + (audioIndex + 1) + '/' + audioQueue.length + ' 段');
    await ensureReady(audioIndex);
  }
  if (stopAudioFlag) { state.speaking = false; setStatus('idle', '已中断播报'); releaseAudio(); return; }
  if (current.failed || !current.url) {
    audioIndex += 1;
    playQueue();
    return;
  }

  // 单段失败只跳过这一段，不再把整条队列掐掉
  let advanced = false;
  const advance = (markFailed) => {
    if (advanced) return;
    advanced = true;
    if (markFailed) current.failed = true;
    if (stopAudioFlag) { state.speaking = false; setStatus('idle', '已中断播报'); releaseAudio(); return; }
    audioIndex += 1;
    playQueue();
  };

  player.onended = () => { advance(false); };
  player.onerror = () => { advance(true); };

  try {
    player.src = current.url;
    await player.play();
  } catch (_) {
    // 自动播放被拦截 / 解码异常等：跳过这一段，后面的继续
    if (!stopAudioFlag) setStatus(state.comforting ? 'comforting' : 'speaking', '第 ' + (audioIndex + 1) + ' 段播放异常，已跳过');
    advance(true);
  }

  // 提前把后面几段也合成好，减少句间等待
  prefetch(audioIndex + 1);
  prefetch(audioIndex + 2);
}

// 返回该index的合成 Promise（已存在就直接复用），没有则返回 null
function ensureReady(index) {
  const item = audioQueue[index];
  if (!item || item.url || item.failed) return item ? item.job || null : null;
  if (!item.job) item.job = synthesize(index);
  return item.job;
}

async function prefetch(index) {
  const job = ensureReady(index);
  if (job) await job;
}

async function synthesize(index) {
  const item = audioQueue[index];
  if (!item) return;
  const payload = JSON.stringify({
    text: item.text,
    agent: currentAgent(),
    engine: state.config.tts.engine,
    voice: state.config.tts.voice,
    rate: state.config.tts.rate,
    pitch: state.config.tts.pitch,
  });
  // 失败重试一次，避免偶发错误吃掉一整段话
  for (let attempt = 0; attempt < 2; attempt++) {
    if (typeof stopAudioFlag !== 'undefined' && stopAudioFlag) return;
    try {
      const response = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (!response.ok) continue;
      const blob = await response.blob();
      item.url = URL.createObjectURL(blob);
      if (stopAudioFlag) { try { URL.revokeObjectURL(item.url); } catch (_) { /* noop */ } item.url = null; }
      setMeter('meter-voice', 100);
      return;
    } catch (_) {
      /* 下一轮重试 */
    }
  }
  item.failed = true;
}

async function speakText(text, comforting) {
  if (!state.config.tts.enabled) return;
  const sentences = splitSentences(text);
  if (!sentences.length) return;

  state.comforting = !!comforting;
  stopAudioFlag = false;
  releaseAudio();
  audioQueue = sentences.map((s) => ({ text: s, url: null }));
  audioIndex = 0;

  await prefetch(0);
  playQueue();
}

function stopSpeaking() {
  stopAudioFlag = true;
  audioIndex = audioQueue.length;
  try { player.pause(); } catch (_) { /* noop */ }
  state.speaking = false;
  state.comforting = false;
  releaseAudio();
  setStatus('idle', '播报已停止');
}

// ------------------------------------------------------------------ 对话

async function sendMessage(text) {
  const content = String(text || '').trim();
  if (!content || state.streaming) return;

  stopSpeaking();
  const user = addMessage('user');
  user.bubble.textContent = content;
  state.conversation.push({ role: 'user', content });

  const reply = addMessage('fairy');
  reply.bubble.classList.add('caret');
  const reasoningBox = document.createElement('div');
  reasoningBox.className = 'reasoning';
  reasoningBox.style.display = 'none';

  state.streaming = true;
  $('btn-stop').disabled = false;
  setStatus('thinking', '正在通过本地模型推理');
  setLifecycle('running');
  flickerOnce();
  setMeter('meter-link', 60);

  const controller = new AbortController();
  state.controller = controller;

  let answer = '';
  let reasoning = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content, history: state.conversation.slice(0, -1), agent: currentAgent() }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf8');
    let buffered = '';

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffered += decoder.decode(result.value, { stream: true });

      let index;
      while ((index = buffered.indexOf('\n\n')) >= 0) {
        const event = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 2);
        if (!event.startsWith('data:')) continue;
        let payload;
        try { payload = JSON.parse(event.slice(5).trim()); } catch (_) { continue; }

        if (payload.type === 'delta') {
          answer += payload.text;
          reply.bubble.innerHTML = renderMarkdown(answer);
          $('messages').scrollTop = $('messages').scrollHeight;
        } else if (payload.type === 'reason') {
          reasoning += payload.text;
          reasoningBox.style.display = 'block';
          reasoningBox.textContent = reasoning;
          reply.wrap.appendChild(reasoningBox);
        } else if (payload.type === 'error') {
          addSystem('生成失败：' + payload.message);
          setStatus('error', payload.message);
        } else if (payload.type === 'meta') {
          setChip('chip-model', payload.model || '', 'ok');
        }
      }
    }
  } catch (error) {
    const message = error.name === 'AbortError' ? '已中断' : error.message;
    if (!answer) addSystem('连接失败：' + message);
    setStatus('error', message);
  } finally {
    reply.bubble.classList.remove('caret');
    state.streaming = false;
    state.controller = null;
    $('btn-stop').disabled = true;
    setLifecycle('completed');
    setMeter('meter-link', 100);
  }

  if (answer) {
    if (!reply.bubble.innerHTML.trim()) reply.bubble.innerHTML = renderMarkdown(answer);
    // 记录发言者：服务端要靠它判断哪句是自己说的、哪句是「另一个智能体」说的
    state.conversation.push({ role: 'assistant', content: answer, agent: currentAgent() });
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const readBtn = document.createElement('button');
    readBtn.className = 'mini';
    readBtn.textContent = '朗读';
    readBtn.onclick = () => speakText(answer, isComforting(answer, content));
    const copyBtn = document.createElement('button');
    copyBtn.className = 'mini';
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => navigator.clipboard.writeText(answer);
    actions.appendChild(readBtn);
    actions.appendChild(copyBtn);
    reply.wrap.appendChild(actions);

    if (state.config.tts.enabled && state.config.tts.autoRead) {
      await speakText(answer, isComforting(answer, content));
    } else {
      setStatus('idle', '链路待命');
    }
  } else {
    setStatus('idle', '链路待命');
  }
}

// ------------------------------------------------------------------ 设置

function fillNumber(id, valueId, value, suffix) {
  $(id).value = value;
  $(valueId).textContent = value + (suffix || '');
}

function applyConfigToForm() {
  const cfg = state.config;
  $('set-baseUrl').value = cfg.lmstudio.baseUrl;
  $('set-apiKey').value = cfg.lmstudio.apiKey;
  $('set-model').value = cfg.lmstudio.model;
  fillNumber('set-temp', 'val-temp', cfg.lmstudio.temperature);
  fillNumber('set-maxtok', 'val-maxtok', cfg.lmstudio.maxTokens);
  fillNumber('set-ctx', 'val-ctx', cfg.lmstudio.contextMessages, ' 条');
  $('set-autostart').checked = cfg.lmstudio.autoStartServer !== false;

  $('set-usepersona').checked = cfg.persona.usePersona !== false;
  $('set-master').value = cfg.persona.masterName;
  fillNumber('set-samples', 'val-samples', cfg.persona.corpusSamples, ' 条');
  $('set-corpus').value = cfg.persona.corpusRoot;
  $('set-extra').value = cfg.persona.extraPrompt;

  $('set-tts').checked = cfg.tts.enabled;
  $('set-autoread').checked = cfg.tts.autoRead;
  $('set-engine').value = cfg.tts.engine;
  fillNumber('set-rate', 'val-rate', cfg.tts.rate);
  fillNumber('set-pitch', 'val-pitch', cfg.tts.pitch || 0);
  $('set-sovitsUrl').value = cfg.tts.sovitsUrl;
  $('set-sovitsRef').value = cfg.tts.sovitsRefAudio;
  $('set-sovitsText').value = cfg.tts.sovitsPromptText;

  $('set-hdd').checked = cfg.ui.hdd !== false;
  $('set-autoopen').checked = cfg.ui.autoOpenBrowser !== false;
  $('set-port').value = cfg.port;

  applyTheme((cfg.ui && cfg.ui.theme) || 'dark');
  // 每次打开都从 Fairy 起步：不沿用上次停在的 YouKai，保证默认启动一定是 Fairy
  applyAgent('fairy');
  if (cfg.ui && cfg.ui.agent && cfg.ui.agent !== 'fairy') {
    cfg.ui.agent = 'fairy';
    saveUiPatch({ agent: 'fairy' });
  }
  refreshVoiceOptions();
  updateChipsFromConfig();
}

function collectForm() {
  return {
    port: Number($('set-port').value) || state.config.port,
    lmstudio: {
      baseUrl: $('set-baseUrl').value.trim(),
      apiKey: $('set-apiKey').value.trim(),
      model: $('set-model').value,
      temperature: Number($('set-temp').value),
      maxTokens: Number($('set-maxtok').value),
      contextMessages: Number($('set-ctx').value),
      autoStartServer: $('set-autostart').checked,
    },
    persona: {
      usePersona: $('set-usepersona').checked,
      masterName: $('set-master').value.trim(),
      corpusSamples: Number($('set-samples').value),
      corpusRoot: $('set-corpus').value.trim(),
      extraPrompt: $('set-extra').value,
    },
    tts: {
      enabled: $('set-tts').checked,
      autoRead: $('set-autoread').checked,
      engine: $('set-engine').value,
      voice: $('set-voice').value,
      rate: Number($('set-rate').value),
      pitch: Number($('set-pitch').value),
      sovitsUrl: $('set-sovitsUrl').value.trim(),
      sovitsRefAudio: $('set-sovitsRef').value.trim(),
      sovitsPromptText: $('set-sovitsText').value.trim(),
    },
    ui: {
      hdd: $('set-hdd').checked,
      autoOpenBrowser: $('set-autoopen').checked,
      theme: $('set-theme').value,
      agent: (state.config.ui && state.config.ui.agent) || 'fairy',
    },
  };
}

function refreshVoiceOptions() {
  const engine = $('set-engine').value;
  const list = (state.voices[engine] || []);
  const select = $('set-voice');
  select.innerHTML = '';
  if (!list.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（当前引擎无可用音色）';
    select.appendChild(option);
    return;
  }
  list.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.name;
    select.appendChild(option);
  });
  if (state.config && state.config.tts.voice) select.value = state.config.tts.voice;
  if (!select.value && list.length) select.value = list[0].id;
}

function updateChipsFromConfig() {
  const cfg = state.config;
  setChip('chip-voice', cfg.tts.enabled ? '语音：' + (cfg.tts.voice || '默认') : '语音：关', cfg.tts.enabled ? 'ok' : '');
  setChip('chip-model', cfg.lmstudio.model || '默认模型', cfg.lmstudio.model ? 'ok' : 'warn');
  setMeter('meter-corpus', Math.min(100, (cfg.persona.corpusSamples / 16) * 100));
  setMeter('meter-voice', cfg.tts.enabled ? 100 : 0);
}

async function loadConfig() {
  const response = await fetch('/api/config');
  const data = await response.json();
  if (data.ok) state.config = data.config;
  applyConfigToForm();
}

async function loadModels() {
  const response = await fetch('/api/models');
  const data = await response.json();
  const select = $('set-model');
  select.innerHTML = '';
  if (!data.ok) {
    setChip('chip-lm', 'LM Studio 未连接', 'err');
    addSystem('LM Studio 未连接：' + (data.error || '') + ' ' + (data.hint || ''));
    setStatus('error', '无法连接 LM Studio');
    return;
  }

  state.models = data.models;
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '（跟随 LM Studio 默认模型）';
  select.appendChild(empty);
  data.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.id;
    select.appendChild(option);
  });
  if (state.config.lmstudio.model) select.value = state.config.lmstudio.model;
  else if (data.models.length) {
    select.value = data.models[0].id;
    state.config.lmstudio.model = data.models[0].id;
    updateChipsFromConfig();
  }

  setChip('chip-lm', 'LM Studio 已连接', 'ok');
  setMeter('meter-link', 100);
  setStatus('idle', '已加载 ' + data.models.length + ' 个模型');
}

async function loadVoices() {
  const response = await fetch('/api/tts/voices');
  const data = await response.json();
  if (!data.ok) return;
  state.voices = data.voices;
  refreshVoiceOptions();
}

async function saveConfig() {
  const payload = collectForm();
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: payload }),
  });
  const data = await response.json();
  $('save-note').textContent = data.ok ? '已保存并生效' : '保存失败：' + (data.error || '');
  if (data.ok) {
    state.config = Object.assign({}, state.config, JSON.parse(JSON.stringify(payload)));
    document.body.classList.toggle('hdd', payload.ui.hdd);
    applyTheme(payload.ui.theme);
    applyAgent(payload.ui.agent);
    updateChipsFromConfig();
    if (!payload.tts.enabled) stopSpeaking();
    setTimeout(() => { $('save-note').textContent = ''; }, 2600);
  }
}

// ------------------------------------------------------------------ 事件绑定

function bind() {
  const input = $('input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const text = input.value;
      input.value = '';
      input.style.height = 'auto';
      sendMessage(text);
    }
  });

  $('btn-send').onclick = () => {
    const text = input.value;
    input.value = '';
    input.style.height = 'auto';
    sendMessage(text);
  };

  $('btn-stop').onclick = () => {
    if (state.controller) state.controller.abort();
    stopSpeaking();
  };

  $('btn-settings').onclick = () => { $('drawer').classList.add('show'); $('mask').classList.add('show'); };
  $('btn-close-drawer').onclick = () => { $('drawer').classList.remove('show'); $('mask').classList.remove('show'); };
  $('mask').onclick = () => { $('drawer').classList.remove('show'); $('mask').classList.remove('show'); };

  $('btn-hdd').onclick = () => {
    transitionGlitch();
    document.body.classList.toggle('hdd');
    const hdd = document.body.classList.contains('hdd');
    if (state.config) state.config.ui.hdd = hdd;
    $('set-hdd').checked = hdd;
    saveUiPatch({ hdd });
  };

  $('btn-theme').onclick = () => {
    const next = document.body.classList.contains('theme-light') ? 'dark' : 'light';
    transitionGlitch();
    applyTheme(next);
    saveUiPatch({ theme: next });
  };

  $('btn-agent').onclick = () => {
    const next = currentAgent() === 'youkai' ? 'fairy' : 'youkai';
    transitionGlitch();
    applyAgent(next);
    // 每次切到 YouKai 都播开场动画（等故障闪屏过渡结束再进），不再受「已播过」标记限制
    if (next === 'youkai') setTimeout(playYouKaiIntro, 340);
    saveUiPatch({ agent: next });
  };

  $('btn-fullscreen').onclick = toggleFullscreen;
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
  syncFullscreenButton();

  /* Esc 跳过开场动画（开机序列 / YouKai 切换动画都算） */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const boot = $('fairy-boot');
    if (boot && boot.classList.contains('show')) {
      const bootSkip = $('boot-skip');
      if (bootSkip) bootSkip.click();
      return;
    }
    const overlay = $('youkai-intro');
    if (overlay && overlay.classList.contains('show')) {
      const skip = $('intro-skip');
      if (skip) skip.click();
    }
  });

  $('set-theme').onchange = () => applyTheme($('set-theme').value);

  /* 页面切到后台时冻结所有动画，回到前台再恢复 */
  document.addEventListener('visibilitychange', () => {
    const avatar = $('avatar');
    if (!avatar) return;
    if (document.hidden) avatar.setAttribute('data-visual-suspended', 'true');
    else avatar.removeAttribute('data-visual-suspended');
  });

  $('btn-clear').onclick = () => {
    stopSpeaking();
    state.conversation = [];
    $('messages').innerHTML = '';
    addSystem('会话已重置。');
    setStatus('idle', '链路待命');
  };

  document.querySelectorAll('.quick-btn').forEach((button) => {
    button.onclick = () => sendMessage((PRESETS[button.dataset.preset] || '').replace(/Fairy/g, agentName()));
  });

  [
    ['set-temp', 'val-temp', ''],
    ['set-maxtok', 'val-maxtok', ''],
    ['set-ctx', 'val-ctx', ' 条'],
    ['set-samples', 'val-samples', ' 条'],
    ['set-rate', 'val-rate', ''],
    ['set-pitch', 'val-pitch', ''],
  ].forEach(([rangeId, valueId, suffix]) => {
    $(rangeId).addEventListener('input', () => {
      $(valueId).textContent = $(rangeId).value + suffix;
    });
  });

  $('set-engine').onchange = () => refreshVoiceOptions();

  $('btn-save').onclick = saveConfig;

  $('btn-testvoice').onclick = () => {
    const text = '主人，链路测试通过。语音模块已就绪。';
    const previous = Object.assign({}, state.config.tts);
    state.config.tts.engine = $('set-engine').value;
    state.config.tts.voice = $('set-voice').value;
    state.config.tts.rate = Number($('set-rate').value);
    state.config.tts.pitch = Number($('set-pitch').value);
    state.config.tts.enabled = true;
    speakText(text);
    state.config.tts = previous;
  };
}

async function boot() {
  bind();
  armAutoFullscreen();
  await loadConfig();
  setLifecycle('idle');
  scheduleGlitch();
  setStatus('idle', '正在连接本地模型…');
  playFairyBoot();
  await Promise.all([loadModels(), loadVoices()]);
  addSystem('链路就绪。' + agentName() + ' 已接入本地推理宿主，人格语料会按对话内容动态校准。');
}

boot();
