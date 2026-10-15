'use strict';

const fs = require('fs');
const path = require('path');

const FILES = [
  { file: 'personality/fairy_personality.json', tag: '人格' },
  { file: 'behavior/fairy_behavior_rules.json', tag: '行为' },
  { file: 'style/fairy_voice_model.json', tag: '语域' },
  { file: 'style/fairy_speech_style.json', tag: '风格' },
  { file: 'style/fairy_real_ai_antipatterns.json', tag: '禁例' },
  { file: 'canon/fairy_canon.json', tag: '正典' },
  { file: 'canon/fairy_anti_fanon.json', tag: '反二设' },
  { file: 'personality/fairy_relationships.json', tag: '关系' },
  { file: 'personality/fairy_world_view.json', tag: '世界观' },
];

const STOPWORDS = new Set([
  '主人', '可以', '什么', '怎么', '这样', '一个', '我们', '你们', '这个', '那个',
]);

let cache = { root: null, snippets: [] };

function toText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function bigrams(text) {
  const clean = String(text).toLowerCase().replace(/[\s\p{P}]/gu, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) grams.add(clean.slice(i, i + 2));
  if (clean.length === 1) grams.add(clean);
  return grams;
}

function collect(node, tag, out, depth) {
  if (depth > 9 || node == null) return;
  if (typeof node === 'string') {
    const text = toText(node);
    if (text.length >= 6 && text.length <= 200 && /[一-龥]/.test(text)) {
      out.push({ text, tag, grams: bigrams(text) });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, tag, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    // 优先取 `text` 字段（真实台词），其余字段作为补充线索
    if (typeof node.text === 'string') {
      const text = toText(node.text);
      if (text.length >= 6 && text.length <= 200 && /[一-龥]/.test(text)) {
        out.push({ text, tag, grams: bigrams(text) });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'text' || key === 'turn_id' || key === 'scene_id') continue;
      collect(node[key], tag, out, depth + 1);
    }
  }
}

function ensureLoaded(root) {
  if (cache.root === root && cache.snippets.length) return cache;

  const snippets = [];
  const seen = new Set();
  for (const entry of FILES) {
    const full = path.join(root, entry.file);
    if (!fs.existsSync(full)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      console.warn('[corpus] skip ' + entry.file + ': ' + error.message);
      continue;
    }
    const bucket = [];
    collect(parsed, entry.tag, bucket, 0);
    for (const item of bucket) {
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      snippets.push(item);
    }
  }

  cache = { root, snippets };
  return cache;
}

function keywords(query) {
  const clean = String(query || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const terms = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) {
    const gram = clean.slice(i, i + 2);
    if (!STOPWORDS.has(gram)) terms.add(gram);
  }
  return terms;
}

function retrieve(root, query, limit) {
  const { snippets } = ensureLoaded(root);
  const terms = keywords(query);
  if (!snippets.length) return [];

  const scored = [];
  for (const snippet of snippets) {
    if (!terms.size) {
      scored.push({ snippet, score: 0 });
      continue;
    }
    let score = 0;
    for (const gram of terms) {
      if (snippet.grams.has(gram)) score += 1;
    }
    if (score > 0) scored.push({ snippet, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, Math.max(0, limit));
  return picked.map((item) => '[' + item.snippet.tag + '] ' + item.snippet.text);
}

function stats(root) {
  const { snippets } = ensureLoaded(root);
  const byTag = new Map();
  for (const s of snippets) byTag.set(s.tag, (byTag.get(s.tag) || 0) + 1);
  return { total: snippets.length, byTag: Array.from(byTag.entries()) };
}

module.exports = { retrieve, stats, toText };
