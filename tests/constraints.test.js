import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';

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

// 计划 2（B11）新增：只有这一个文件可以触碰浏览器 API。
//
// 白名单为什么这么短：render / body / input / audio 全部靠**依赖注入**拿到浏览器能力
// （ctx、目标元素、AudioContext 构造器、makeCanvas 工厂），源码里根本不出现那七个全局名，
// 所以它们**继续留在纯度守卫的覆盖范围内**，也继续能在 Node 里单测。
// 把白名单写短不是洁癖，是保住可测面积 —— 这四个模块里装着软体弹簧、坐标映射、
// 色相分桶、指针速度分类、嗓音参数映射，全是值得断言的纯数学。
// 真正无法豁免的只有 main.js：它是页面入口，必须自己拿 canvas、必须自己调 rAF。
const BROWSER_MODULES = [join('src', 'main.js')];

// 用 \b 词边界匹配，这样 canvasWidth、windowSize、fetchFood 这类正当的本地命名
// 不会被误伤 —— 要拦的是对浏览器全局对象的引用，不是恰好同前缀的标识符。
const findViolations = (pattern, excludeRel) => {
  const hits = [];
  const skip = excludeRel || [];
  for (const file of listSrcFiles(SRC_DIR)) {
    const rel = relative(ROOT_DIR, file);
    if (skip.includes(rel)) continue;
    const body = stripComments(readFileSync(file, 'utf8'));
    for (const name of pattern) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      const count = (body.match(re) || []).length;
      if (count > 0) hits.push(`${rel}: ${name} ×${count}`);
    }
  }
  return hits;
};

test('约束扫描确实覆盖到了 src/ 下的模块（防空转）', () => {
  // 上面每一条断言都是"违规列表为空"，而这种断言在扫描范围意外变空时同样会通过 ——
  // 比如 src/ 被改名、或 *.js 后缀约定变了。所以先钉住"确实读到了文件"，
  // 否则守卫会在最需要它的时候悄悄失效。
  const files = listSrcFiles(SRC_DIR).map((f) => relative(ROOT_DIR, f));
  assert.ok(files.length >= 6, `src/ 下只找到 ${files.length} 个 .js 文件，至少应有 6 个`);
  // main.js 必须**在扫描清单里**：否则「main.js 被豁免」和「main.js 没被扫到」
  // 这两种情况在下面那条白名单测试的断言上无法区分 —— 后者会让白名单指向空气，
  // 守卫一片绿，实则 src/ 已经没有任何文件被 DOM 扫描覆盖到。
  for (const expected of [join('src', 'config.js'), join('src', 'rng.js'), join('src', 'main.js')]) {
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
  // B13（2026-10-21）：渲染层**必须**留在这条扫描的覆盖范围内。
  // 旧计划 Task 4 Step 7 写的是"把 'render.js' 加回可 import 性那条的 ['body.js'] 数组"，
  // 但本文件的覆盖方式是 listSrcFiles 全量扫 src/，没有那样的白名单数组可改
  // —— 那条的字面要求在这里不存在，所以按**意图**落地：把 render.js 与 body.js
  // 钉进"确实被扫到"的清单。它们靠依赖注入拿 ctx / makeCanvas，源码里根本不出现
  // 那七个名字，因此不需要豁免；哪天有人给它们开白名单，这条会先红。
  // B17（2026-10-21）同一条按意图扩展到 input.js：监听目标由 attachInput 的**形参**传入，
  // Pointer Events 的 API 名（addEventListener / pointerdown / pointerId / setPointerCapture）
  // 不在这七个禁用名里，所以它既绑得到真元素，又不需要 document 也不需要 window。
  // B18（2026-10-22）扩展到 audio.js：音频图（那个以 A-u-d 开头的构造器的**实例**）由
  // createAudio({ graph }) 注入，本文件里连那个名字都不出现，所以整个叫声层
  // —— 嗓音映射、六声表、跨越判据、冷却、发声上限、节点收支 —— 继续在 Node 里可单测。
  for (const expected of ['body.js', 'render.js', 'input.js', 'audio.js']) {
    assert.ok(files.includes(join('src', expected)), `纯度守卫没有覆盖 src/${expected}`);
    assert.ok(!BROWSER_MODULES.includes(join('src', expected)),
      `src/${expected} 不该在浏览器模块白名单里（它靠注入，Node 里可单测）`);
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

test('除 main.js 外，src/ 下没有任何模块引用 DOM / 浏览器 API', () => {
  // 这些标识符在 Node 里根本不存在，引用它们会让模块在 import 阶段就抛 ReferenceError，
  // 于是所有纯逻辑测试都跑不起来。渲染与音频（B12–B18）靠依赖注入拿浏览器能力，
  // 连自己的模块里都不出现这些名字，因此它们仍在本条的覆盖范围内。
  const hits = findViolations(FORBIDDEN_IDENTIFIERS, BROWSER_MODULES);
  assert.deepEqual(hits, [], '除 main.js 外的模块不得触碰 DOM / 浏览器 API');
});

test('白名单没有腐烂：main.js 确实存在，且确实用到了浏览器 API', () => {
  // 白名单是**豁免**，所以它自己也要被守卫，否则会朝两个方向烂掉：
  //   · 文件被改名/删除 ⇒ 白名单指向空气，而新加的浏览器模块无人豁免 ⇒ 莫名变红；
  //   · 文件其实不需要豁免（比如有人把 DOM 代码搬回了 render.js 又把 render.js 加进白名单）
  //     ⇒ 白名单每多一项，纯度守卫就少覆盖一个模块，而且是**静默**少覆盖。
  for (const rel of BROWSER_MODULES) {
    const full = join(ROOT_DIR, rel);
    assert.ok(existsSync(full), `白名单里的 ${rel} 不存在，请把它从 BROWSER_MODULES 删掉`);
    const body = stripComments(readFileSync(full, 'utf8'));
    const used = FORBIDDEN_IDENTIFIERS.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
    assert.ok(used.length > 0, `${rel} 没有用到任何浏览器 API，不该留在白名单里（白名单是豁免，多余的豁免=守卫盲区）`);
    // 上面那句 used.length>0 允许"只用到一个冷门标识符"的蒙混过关 —— 不够。
    // 白名单的正例必须钉到 main.js 的**身份**上：它是页面入口，入口的充要条件是
    // 自己取 DOM 节点（document）并自己驱动帧循环（requestAnimationFrame）。
    // 没有这两条，"白名单"就可能是靠"main.js 恰好没写别的"侥幸通过的。
    //
    // B18（2026-10-22）加上第三个：AudioContext **必须**在这里被用到。
    // 白名单一直是那七个名的**唯一**豁免口子，而 src/audio.js 刻意一个都不碰（音频图靠注入）。
    // 于是"创建上下文"这件事如果不在 main.js，就只可能在两个地方：
    //   · 搬进了 audio.js ⇒ 那条模块当场掉出纯度守卫（本文件第一条测试会红，这是想要的）；
    //   · 根本没人创建 ⇒ 缸永远没声音，而**没有任何一条测试会红**（B17c 抓过的那类"接线没接到"）。
    // 这一条拦的是第二种。它和 tests/audio.test.js 里那两条 boot 用例是同一个约束的两面：
    // 这里查"源码里有这个构造"，那里查"真的在首次手势上跑起来了"。
    for (const required of ['document', 'requestAnimationFrame', 'AudioContext']) {
      assert.ok(used.includes(required),
        `${rel} 没有用到 ${required}：它要么不是页面入口（该移出白名单），要么那条通道没接线`);
    }
  }
});

test('依赖方向：任何纯模块都不得 import 浏览器模块', () => {
  // 这条才是真正保护可测性的约束。DOM 扫描保证"纯模块不碰 DOM"，
  // 而这条保证"纯模块不被浏览器模块反向拖下水"：
  // 一旦 body.js import 了 main.js，那么 import body.js 就会连带执行 main.js 的顶层代码，
  // 所有 body 测试在 Node 里当场 ReferenceError —— 纯度守卫却还是绿的（body.js 自己没写那些词）。
  const hits = [];
  for (const file of listSrcFiles(SRC_DIR)) {
    const rel = relative(ROOT_DIR, file);
    if (BROWSER_MODULES.includes(rel)) continue;
    const body = readFileSync(file, 'utf8');     // 这里**不剥注释**：import 语句不会写在注释里，
    for (const mod of BROWSER_MODULES) {         // 而剥注释的启发式会把 URL 里的 // 之后整行删掉
      const base = mod.split(/[\\/]/).pop();
      if (body.includes(`'./${base}'`) || body.includes(`"./${base}"`)) {
        hits.push(`${rel} import 了 ${mod}`);
      }
    }
  }
  assert.deepEqual(hits, [], '纯逻辑模块不得依赖浏览器模块');
});

test('每一种情绪事件种类都真的有生产者（不许留无人发出的事件种类）', () => {
  // 起因：`petted` 从计划 1 起就只有 CONFIG 里的定义，全 src/ 没有任何一处 applyEvent 它。
  // 一个永远不会被发出的事件种类，症状是"调了它没反应"——
  // 玩家以为摸它有用，实际那 0.4 的 joy 从来没加过。
  // 与 Task 9 复查撤掉 `rejected`、以及"无生产者的旋钮要撤"是同一条纪律，
  // 只是这次发生在事件表上。
  //
  // 写法上刻意用**源码扫描**而不是"跑一缸看出现过哪些"：后者会因某条路径在验收种子上
  // 恰好不走到而误报（mourn 只在有死亡时发、laid 只在憋满时发），
  // 而"代码里有没有这一行"是确定的、不需要运气的判据。
  // 逐行扫（而不是拼正则）：上一版把 `\\(` 写进 bash heredoc 时被吞成一个反斜杠，
  // 于是 new RegExp 收到未闭合的分组、测试直接 SyntaxError。
  // 判据本身不需要正则：注释已剥掉，剩下"这一行既调了 applyEvent 又带着这个字面量"就够了。
  // 已知的**待补生产者**清单。每条都必须写清"谁将来发它"，且这个清单只许变短、不许变长 ——
  // 新增一个没有任何生产者、也没写归属的事件种类，这条测试就是为拦它而存在。
  // 已经有生产者的种类若还留在这里，下面的 stale 断言会把它抓出来（防清单腐烂）。
  //
  // B17c 之后这张表是**空的**：poked 与 startled 的输入通道（down / appeared）已经接上。
  const PENDING_PRODUCERS = {};
  const lines = [];
  for (const f of listSrcFiles(SRC_DIR)) {
    for (const line of stripComments(readFileSync(f, 'utf8')).split('\n')) lines.push(line);
  }
  const missing = [];
  const stale = [];
  for (const kind of Object.keys(CONFIG.emotions.eventMagnitude)) {
    const produced = lines.some((l) => l.includes('applyEvent(')
      && (l.includes(`'${kind}'`) || l.includes(`"${kind}"`)));
    if (!produced && !PENDING_PRODUCERS[kind]) missing.push(kind);
    if (produced && PENDING_PRODUCERS[kind]) stale.push(kind);
  }
  assert.deepEqual(missing, [], `下列情绪事件没有任何生产者：${missing.join(', ')}`);
  assert.deepEqual(stale, [],
    `这些事件已经有生产者了，请把 PENDING_PRODUCERS 里的条目删掉：${stale.join(', ')}`);
  // 反向确认：petted 以前是死字段（只有定义、没人发），现在必须**不在**待补清单里
  assert.ok(!('petted' in PENDING_PRODUCERS), 'petted 已由 B17b 接上生产者');
});
