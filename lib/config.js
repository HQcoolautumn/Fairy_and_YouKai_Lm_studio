'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 分享版：配置默认放在程序目录下的 data\（由 start-fairy.ps1 设置 FAIRY_HOME），
// 不写 %USERPROFILE%\.fairy-lmstudio，避免和原版或别人机器上的配置互相覆盖。
// 没设 FAIRY_HOME 时回退到原来的位置。
const HOME_DIR = process.env.FAIRY_HOME
  ? path.resolve(process.env.FAIRY_HOME)
  : path.join(os.homedir(), '.fairy-lmstudio');
const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

// 分享版不带任何私有语料库，留空即可（corpus.js 会自动跳过）
const CORPUS_DEFAULT_ROOT = '';

function defaults() {
  return {
    port: 5177,
    lmstudio: {
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: '',
      temperature: 0.7,
      maxTokens: 1536,
      contextMessages: 12,
      // 默认不自动拉起 LM Studio 的后台服务：那种无界面的服务进程会占住 1234 端口，
      // 导致用户之后点 LM Studio 图标时界面出不来。界面本身运行时同样提供本地 API。
      autoStartServer: false,
      apiKey: '',
    },
    persona: {
      corpusRoot: CORPUS_DEFAULT_ROOT,
      masterName: '主人',
      corpusSamples: 6,
      extraPrompt: '',
      usePersona: true,
    },
    tts: {
      enabled: true,
      autoRead: true,
      engine: 'local',
      voice: '',
      rate: 2,
      pitch: 4,
      sovitsUrl: 'http://127.0.0.1:9880/tts',
      sovitsRefAudio: '',
      sovitsPromptText: '',
      sovitsTextLang: 'zh',
      sovitsPromptLang: 'zh',
      // 真声服务的降噪与采样参数（见 lib/audio.js、lib/tts.js）
      sovitsDenoise: true,
      sovitsTopK: 12,
      sovitsTopP: 1,
      sovitsTemperature: 0.9,
      sovitsRepetitionPenalty: 1.35,
      sovitsSpeed: 1.0,
    },
    ui: {
      hdd: true,
      autoOpenBrowser: true,
      // 'dark' 深色系（黑） / 'light' 浅色系（白）
      theme: 'dark',
      // 智能体：'fairy'（默认蓝）/ 'youkai'（红）。开场动画每次切换都播，不再记录「已播过」
      agent: 'fairy',
    },
    // 每个智能体的独立配置：人格补充规则与音色服务（未配置字段回退到全局 persona / tts）
    agents: {
      fairy: {
        persona: {},
        tts: {},
      },
      youkai: {
        persona: {
          // YouKai 不使用 Fairy 的语料库，人格完全由 assets/youkai-persona.txt 决定
          corpusRoot: '',
          corpusSamples: 0,
          extraPrompt: '',
        },
        // 分享版不内置任何训练音色：YouKai 同样走系统音色
        tts: {
          engine: 'local',
          sovitsUrl: '',
          sovitsRefAudio: '',
          sovitsPromptText: '',
        },
      },
    },
  };
}

function ensureHome() {
  if (!fs.existsSync(HOME_DIR)) fs.mkdirSync(HOME_DIR, { recursive: true });
  return HOME_DIR;
}

function deepMerge(base, patch) {
  const out = Object.assign({}, base);
  for (const key of Object.keys(patch || {})) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object') {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function load() {
  try {
    ensureHome();
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return deepMerge(defaults(), JSON.parse(raw));
    }
  } catch (error) {
    console.error('[config] load failed:', error.message);
  }
  return defaults();
}

function save(config) {
  ensureHome();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return CONFIG_PATH;
}

module.exports = { load, save, ensureHome, defaults, CONFIG_PATH, HOME_DIR, CORPUS_DEFAULT_ROOT };
