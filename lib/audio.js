'use strict';

/**
 * 纯 Node 的 WAV 读写与语音清洗（不依赖 ffmpeg / 任何第三方包）。
 *
 * GPT-SoVITS 在参考音频带底噪、或模型本身略有毛刺时，合成语音的句尾/字间会有一层
 * 「沙沙」的杂音。这里用一条轻量链路把它压下去：
 *   1) 去直流 + 高通：干掉低频轰鸣与直流偏置
 *   2) 向下扩展器（软噪声门）：按帧估算底噪，句间/句尾的静音段压到很低，语音段完全放行
 *   3) 首尾淡入淡出：消掉爆音与尾音 abrupt cut
 *   4) 尾部静音裁剪 + 归一化：把剩下的尾巴收干净，顺便补一点音量
 */

// ------------------------------------------------------------------ WAV 读写

function parseWav(buffer) {
  if (buffer.length < 44) throw new Error('文件太小，不是有效 WAV');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 容器');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + Math.min(size, buffer.length - body));
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  if (fmt.audioFormat !== 1) throw new Error('只支持 PCM 编码的 WAV');
  if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 32) throw new Error('只支持 16/32 位深');

  const bytesPer = fmt.bitsPerSample / 8;
  const count = Math.floor(data.length / bytesPer);
  const samples = new Float32Array(count);
  if (fmt.bitsPerSample === 16) {
    for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  } else {
    for (let i = 0; i < count; i++) samples[i] = data.readInt32LE(i * 4) / 2147483648;
  }
  return { channels: fmt.channels, sampleRate: fmt.sampleRate, samples };
}

function encodeWav(channels, sampleRate, samples) {
  const bytesPer = 2;
  const dataSize = samples.length * bytesPer;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPer, 28);
  buf.writeUInt16LE(channels * bytesPer, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * bytesPer);
  }
  return buf;
}

// ------------------------------------------------------------------ 处理环节

/** 去直流 + 一阶高通（去掉低频轰鸣/风噪，对 "沙沙" 的宽频噪声也有轻微帮助） */
function highpass(samples, sampleRate, hz) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * hz);
  const a = rc / (rc + dt);
  const out = new Float32Array(samples.length);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    prevOut = a * (prevOut + x - prevIn);
    prevIn = x;
    out[i] = prevOut;
  }
  // 顺手把可能的直流残余再减一次
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length || 1;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/** 一阶低通：压掉「沙沙」感里最刺的那层高频（高于该频率的能量会被柔化） */
function lowpass(samples, sampleRate, hz) {
  if (!hz || hz >= sampleRate / 2 - 1000) return samples;
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * hz);
  const a = dt / (rc + dt);
  const out = new Float32Array(samples.length);
  let prev = samples[0] || 0;
  for (let i = 0; i < samples.length; i++) {
    prev = prev + a * (samples[i] - prev);
    out[i] = prev;
  }
  return out;
}

/**
 * 向下扩展器：低于底噪倍率的帧压下去，语音帧原样放过。
 * openRatio/closeRatio 越大越保守（只在很安静时才压），越小清理越狠但也更容易吃字尾。
 */
function expand(samples, sampleRate, opts) {
  const frameMs = 20;
  const hopMs = 10;
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const nFrames = Math.max(1, Math.floor((samples.length - frameSize) / hop) + 1);

  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let acc = 0;
    const start = f * hop;
    const end = Math.min(start + frameSize, samples.length);
    for (let i = start; i < end; i++) acc += samples[i] * samples[i];
    rms[f] = Math.sqrt(acc / Math.max(1, end - start));
  }

  // 底噪取较低的 15% 分位，避免把轻声说话当成噪声
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noiseFloor = Math.max(sorted[Math.floor(sorted.length * 0.15)] || 0, 1e-6);
  const openAt = noiseFloor * opts.openRatio;
  const closeAt = noiseFloor * opts.closeRatio;
  const span = Math.max(openAt - closeAt, 1e-9);

  const target = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    if (rms[f] >= openAt) target[f] = 1;
    else if (rms[f] <= closeAt) target[f] = opts.floorGain;
    else {
      const x = (rms[f] - closeAt) / span;
      const smooth = x * x * (3 - 2 * x); // smoothstep：过渡自然，不会有「咔」的门声
      target[f] = opts.floorGain + (1 - opts.floorGain) * smooth;
    }
  }

  // 起落平滑：开得快（不吞字头），落得慢（不抽气）
  const gain = new Float32Array(nFrames);
  let prev = target[0];
  for (let f = 0; f < nFrames; f++) {
    const coeff = target[f] > prev ? 0.55 : 0.12;
    prev = prev + (target[f] - prev) * coeff;
    gain[f] = prev;
  }

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const pos = i / hop;
    const f = Math.min(nFrames - 1, Math.floor(pos));
    const next = Math.min(nFrames - 1, f + 1);
    const frac = pos - f;
    const g = gain[f] + (gain[next] - gain[f]) * frac;
    out[i] = samples[i] * g;
  }
  return out;
}

function fadeEdges(samples, sampleRate, fadeInMs, fadeOutMs) {
  const nIn = Math.min(samples.length, Math.round((sampleRate * fadeInMs) / 1000));
  const nOut = Math.min(samples.length, Math.round((sampleRate * fadeOutMs) / 1000));
  for (let i = 0; i < nIn; i++) samples[i] *= i / nIn;
  for (let i = 0; i < nOut; i++) {
    samples[samples.length - 1 - i] *= i / nOut;
  }
  return samples;
}

/** 裁掉尾部（保留一点余韵），可选是否也裁开头 */
function trimTail(samples, sampleRate, threshold, keepMs) {
  let last = -1;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) > threshold) { last = i; break; }
  }
  if (last < 0) return samples.subarray(0, 0);
  const keep = Math.round((sampleRate * keepMs) / 1000);
  const end = Math.min(samples.length, last + keep);
  return samples.subarray(0, end);
}

function trimHead(samples, sampleRate, threshold, keepMs) {
  let first = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) { first = i; break; }
  }
  if (first < 0) return samples.subarray(0, 0);
  const keep = Math.round((sampleRate * keepMs) / 1000);
  const start = Math.max(0, first - keep);
  return samples.subarray(start);
}

/** 轻归一化：太小声时补增益，太吵时软限幅 */
function normalize(samples, targetPeak) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 1e-6) return samples;
  let g = targetPeak / peak;
  if (g > 4) g = 4;
  if (g < 0.9) g = 0.9; // 从来不主动压音量，只补不减
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * g;
    samples[i] = Math.abs(v) > 0.99 ? Math.tanh(v) * 0.99 : v;
  }
  return samples;
}

// ------------------------------------------------------------------ 对外主入口

const PRESETS = {
  // 合成语音：温和
  tts: {
    highpassHz: 70,
    lowpassHz: 13500,
    openRatio: 3.2,
    closeRatio: 1.5,
    floorGain: 0.06,
    fadeInMs: 8,
    fadeOutMs: 70,
    trimThreshold: 0.0016,
    trimTailKeepMs: 90,
    trimHead: false,
    targetPeak: 0.75,
  },
  // 参考音频：可以狠一点（参考音频干净，合成质量会明显上升）
  ref: {
    highpassHz: 80,
    lowpassHz: 15000,
    openRatio: 2.6,
    closeRatio: 1.25,
    floorGain: 0.03,
    fadeInMs: 10,
    fadeOutMs: 90,
    trimThreshold: 0.002,
    trimTailKeepMs: 60,
    trimHead: true,
    trimHeadKeepMs: 60,
    targetPeak: 0.85,
  },
};

/** 输入整个 WAV Buffer，输出清洗后的 WAV Buffer */
function cleanWav(buffer, presetName) {
  const preset = Object.assign({}, PRESETS[presetName] || PRESETS.tts);
  const { channels, sampleRate, samples } = parseWav(buffer);
  let out = highpass(samples, sampleRate, preset.highpassHz);
  if (preset.lowpassHz) out = lowpass(out, sampleRate, preset.lowpassHz);
  out = expand(out, sampleRate, preset);
  out = trimTail(out, sampleRate, preset.trimThreshold, preset.trimTailKeepMs);
  if (preset.trimHead) out = trimHead(out, sampleRate, preset.trimThreshold, preset.trimHeadKeepMs || 60);
  // 任何一环出问题（比如整段被判成噪声）都宁可用原音，绝不给回一段空音频
  if (out.length < sampleRate * 0.05) return buffer;
  out = fadeEdges(out, sampleRate, preset.fadeInMs, preset.fadeOutMs);
  out = normalize(out, preset.targetPeak);
  return encodeWav(channels, sampleRate, out);
}

// ------------------------------------------------------------------ 命令行：清洗 WAV 文件
if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('用法: node audio.js <输入.wav> <输出.wav> [tts|ref]');
    process.exit(1);
  }
  const [input, output, preset] = args;
  const cleaned = cleanWav(fs.readFileSync(input), preset || 'tts');
  fs.writeFileSync(output, cleaned);
  const before = fs.statSync(input).size;
  console.log(input + ' -> ' + output);
  console.log('  ' + (before / 1024).toFixed(0) + 'KB -> ' + (cleaned.length / 1024).toFixed(0) + 'KB，预设=' + (preset || 'tts'));
}

module.exports = { parseWav, encodeWav, cleanWav, PRESETS };
