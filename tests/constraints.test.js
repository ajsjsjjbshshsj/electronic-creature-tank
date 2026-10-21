import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// 架构约束的自动化守卫。
//
// 为什么值得单独立一个测试文件：src/ 下的模块（rng、config，以及后续九个 Task 要加的
// genes / needs / emotions / behavior / world / sim …）全部是纯逻辑，正因为纯，
// 才能在 Node 里不起浏览器、不渲染一帧就跑完整套模拟测试。一旦有人图省事写下一个
// Math.random()（"固定种子可复现"当场失效）或者摸一下 document（模块在 Node 里直接
// 抛 ReferenceError），损失的是整个项目的可测性。这种约束靠人评审记不住，交给测试。
//
// 只扫 src/，不扫 tests/：本文件自己就把这些词当字符串字面量列了出来，
// 扫 tests/ 会自指报错。

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));

const listSrcFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSrcFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
};

// 扫描前先剥掉注释。这一步是必需的，不是洁癖：src/rng.js 的模块头注释里就明明白白
// 写着"绝不在其他模块调用 Math.random()"，src/config.js 的注释里也有大量中文说明；
// 直接扫原文会把这些散文当成违规，守卫第一天就是红的，然后被人注释掉了事。
//
// 这是启发式，不是解析器 —— 它不认识字符串字面量，所以：
//   const url = 'https://x';   里的 // 会被误判成行注释起点，把后半行一起删掉；
//   const re = /a\/*b/;        这类正则里的 /* 会被误判成块注释起点。
// 对本代码库够用：src/ 里的字符串是颜色值（'#FF6B9D'）和错误消息文本，
// 既不含 // 也不含 /*。而且这个启发式的偏差方向是"删多了"——
// 只会漏检（假阴性），绝不会把干净代码报成违规（假阳性），不会造成误报式的中断。
// 真到了要在 src/ 里写含 // 的字符串那天，把这里换成真正的词法扫描即可。
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* ... */ 块注释（含 /** 文档注释）
    .replace(/\/\/[^\n]*/g, ' ');          // // 行注释（保留换行结构，便于报错定位）

const FORBIDDEN_IDENTIFIERS = [
  'document',
  'window',
  'canvas',
  'requestAnimationFrame',
  'AudioContext',
  'fetch',
  'localStorage',
];

// 用 \b 词边界匹配，这样 canvasWidth、windowSize、fetchFood 这类正当的本地命名
// 不会被误伤 —— 要拦的是对浏览器全局对象的引用，不是恰好同前缀的标识符。
const findViolations = (pattern) => {
  const hits = [];
  for (const file of listSrcFiles(SRC_DIR)) {
    const body = stripComments(readFileSync(file, 'utf8'));
    for (const name of pattern) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      const count = (body.match(re) || []).length;
      if (count > 0) hits.push(`${relative(ROOT_DIR, file)}: ${name} ×${count}`);
    }
  }
  return hits;
};

test('约束扫描确实覆盖到了 src/ 下的模块（防空转）', () => {
  // 上面每一条断言都是"违规列表为空"，而这种断言在扫描范围意外变空时同样会通过 ——
  // 比如 src/ 被改名、或 *.js 后缀约定变了。所以先钉住"确实读到了文件"，
  // 否则守卫会在最需要它的时候悄悄失效。
  const files = listSrcFiles(SRC_DIR).map((f) => relative(ROOT_DIR, f));
  assert.ok(files.length >= 2, `src/ 下只找到 ${files.length} 个 .js 文件，至少应有 2 个`);
  for (const expected of [join('src', 'config.js'), join('src', 'rng.js')]) {
    assert.ok(files.includes(expected), `扫描漏掉了 ${expected}`);
  }
  // 2026-10-20 之后新加的四个纯逻辑模块也必须确实在扫描范围内。
  // 为什么单列这一条：上面那句"违规列表为空"在扫描范围意外变空时同样会通过，
  // 而语言层与存档层恰恰是最容易被"先写在一个大文件里再说"的诱惑绕过守卫的地方 ——
  // 尤其 speech.js：spec §4.13.2 允许它将来发 fetch，但**只许在 main.js 发**。
  // 这里把它钉进清单，将来谁想给 speech.js 开浏览器 API 的口子，得先改掉这条。
  for (const expected of ['speech.js', 'lexicon.js', 'heard.js', 'save.js']) {
    assert.ok(files.includes(join('src', expected)), `扫描清单里没有 src/${expected}`);
  }
});

test('src/ 下没有任何模块调用 Math.random()', () => {
  // 匹配调用 Math.random\s*\( 而不是裸提法：注释与散文里讨论这个名字是允许的
  // （rng.js 的模块头就要靠提到它来说明纪律），真正禁止的是执行它。
  // 一旦有人调用，"固定种子 → 固定结果"这条贯穿全项目的可复现性当场作废，
  // 而且失败会以"偶发的、只在某些种子上出现的测试抖动"形式出现，极难归因。
  const hits = [];
  for (const file of listSrcFiles(SRC_DIR)) {
    const body = stripComments(readFileSync(file, 'utf8'));
    const found = body.match(/Math\.random\s*\(/g);
    if (found) hits.push(`${relative(ROOT_DIR, file)}: Math.random( ×${found.length}`);
  }
  assert.deepEqual(hits, [], '随机性必须全部经由 src/rng.js，不得直接调用 Math.random()');
});

test('src/ 下没有任何模块引用 DOM / 浏览器 API', () => {
  // 这些标识符在 Node 里根本不存在，引用它们会让模块在 import 阶段就抛 ReferenceError，
  // 于是所有纯逻辑测试都跑不起来。渲染与音频是 Task 9/10 的职责，
  // 它们必须待在自己的模块里，由 sim 的输出驱动，而不是被核心逻辑反向依赖。
  const hits = findViolations(FORBIDDEN_IDENTIFIERS);
  assert.deepEqual(hits, [], '纯逻辑模块不得触碰 DOM / 浏览器 API');
});
