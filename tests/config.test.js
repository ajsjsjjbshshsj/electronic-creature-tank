import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { MOODS } from '../src/emotions.js';
import { NEED_KEYS } from '../src/needs.js';
import { NEED_WORDS, STOPWORDS, WORD_POOL, tokenize } from '../src/lexicon.js';

// 本文件是 ES module，而 ESM 一律运行在严格模式下 —— 对冻结对象赋值本来就会抛
// TypeError。所以这里不需要写 'use strict'：模块顶层那条指令是空操作，删掉它行为
// 完全不变。此前注释声称"要靠 'use strict' 才能把静默失败变成抛错"，那是错的
// （在非模块的 sloppy-mode 脚本里才成立），已一并更正。
const expectFrozen = (obj, path) => {
  assert.ok(Object.isFrozen(obj), `${path} 未被冻结`);
  assert.throws(() => { obj.__probe__ = 1; }, TypeError, `${path} 仍可写入属性`);
};

test('deepFreeze 递归到 CONFIG 的每一个对象与数组节点', () => {
  // 原先的逐点抽查只碰到了 21 个节点里的 10 个：CONFIG.behavior、CONFIG.courtship、
  // CONFIG.particles 从来没被检查过 —— 一个恰好漏掉这些子树的 deepFreeze 回归，
  // 能让整套测试保持全绿。所以这里改成整棵树递归，逐节点断言 Object.isFrozen，
  // 并在失败时报出具体路径（如 CONFIG.emotions.eventMagnitude.poked），而不是只说"有东西没冻住"。
  //
  // 这一条取代了之前的「顶层被冻结」「嵌套对象也被冻结」「数组型配置被冻结」三条：
  // 它检查的节点是那三条的严格超集。（那三条里的写入探针与它们自己的 isFrozen
  // 断言在同一对象上重复 —— 冻结对象在严格模式下加属性必抛 —— 所以合并后没有丢覆盖面。）
  const unfrozen = [];
  const visited = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;   // 原始值无需冻结
    visited.push(path);
    if (!Object.isFrozen(node)) unfrozen.push(path);
    for (const key of Object.keys(node)) walk(node[key], `${path}.${key}`);
  };
  walk(CONFIG, 'CONFIG');

  assert.deepEqual(unfrozen, [], 'deepFreeze 漏掉了下列节点');

  // 防空转：遍历自身写错（一个节点都没走到）时，上面的 deepEqual 会空着通过。
  //
  // ⚠️ 这里原来是 `visited.length >= 21`，是台账里挂了很久的一条 Minor：
  // 用下限的话，**删掉一整段 CONFIG 也不会报警**（21 个节点的下限在 39 个的现实下永远满足），
  // 而"遍历没走到某个子树"恰恰就是这种删除的症状。下限防不住它想防的东西。
  // 改成**精确相等**：往 CONFIG 里加常量会让这条变红 —— 那是**想要的摩擦**，
  // 加常量的人必须顺手把这里和下面的段名一起更新，正如 MAGNITUDES 那张表要求
  // 新增情绪事件的人同步更新测试一样。"每次加常量都要回来改测试"不是缺点，是守卫的代价。
  assert.equal(visited.length, 39, `CONFIG 的对象/数组节点数变了（现 ${visited.length}）`);
  // 段名同样精确钉住：只有节点数会漏掉"删了一段又加了一段、总数恰好一样"这种巧合。
  assert.deepEqual(Object.keys(CONFIG).sort(), [
    'affectionDecay', 'affectionDecayKin', 'behavior', 'bodyPoints', 'broody', 'colors',
    'dissolveDuration', 'drift', 'dtAccumCap', 'eggFailChanceAtCap', 'eggSize', 'eggTint',
    'eggsPerClutch', 'emotions', 'eyeWidthRatio', 'familiarityDecay', 'fixedDt', 'food',
    'foodMax', 'foodRespawnRate', 'glowHueBuckets', 'gridCell', 'heard', 'hop', 'hueRange',
    'initialCreatures', 'maxSize', 'memoryCapacity', 'minSize', 'mood', 'motion',
    'mournDuration', 'mournRadius', 'mutationRate', 'needs', 'particles', 'perceiveRadius',
    'populationCap', 'speech', 'stage', 'timeScales',
  ], 'CONFIG 顶层键名（41 个，数出来的不是估的）变了 —— 加一项或删一项都要在这里说清楚');
  assert.equal(Object.keys(CONFIG).length, 41);
  for (const path of [
    'CONFIG',
    'CONFIG.behavior', 'CONFIG.eggTint', 'CONFIG.particles',   // 抽查时代漏掉的三个
    'CONFIG.emotions.eventMagnitude.poked',                       // 第三层
    'CONFIG.timeScales', 'CONFIG.hueRange', 'CONFIG.eggsPerClutch', // 数组节点
    'CONFIG.mood', 'CONFIG.heard', 'CONFIG.speech', 'CONFIG.hop',   // 2026-10-20 之后新增的四段
    'CONFIG.heard.moodPrice', 'CONFIG.behavior.begEscalate',        // 第三层的新增项
  ]) {
    assert.ok(visited.includes(path), `遍历没有到达 ${path}`);
  }
});

test('三层嵌套写入必须抛错（deepFreeze 递归深度的回归防线）', () => {
  // CONFIG.emotions.eventMagnitude.poked 是第三层。
  // 只递归两层的实现会让这一层保持可写，而它恰恰是调"手感"时最常改的地方。
  expectFrozen(CONFIG.emotions.eventMagnitude, 'CONFIG.emotions.eventMagnitude');
  expectFrozen(CONFIG.emotions.eventMagnitude.poked, 'CONFIG.emotions.eventMagnitude.poked');
  assert.throws(() => { CONFIG.emotions.eventMagnitude.poked.joy = 99; }, TypeError);
});

// ---- 以下钉住 spec §11 的默认值 ----
// 改动其中任何一个，都必须同时改 spec 与依赖它的测试；
// 让失败发生在这里，而不是在十个 Task 之外以莫名其妙的方式发生。

test('阶段时长之和就是寿命（1140 秒 = 19 分钟）', () => {
  const s = CONFIG.stage;
  assert.equal(s.egg, 60);
  assert.equal(s.hatchling, 180);
  assert.equal(s.juvenile, 300);
  assert.equal(s.adult, 480);
  assert.equal(s.elder, 180);
  assert.equal(s.hatchling + s.juvenile + s.adult + s.elder, 1140,
    '孵化后的四段之和决定寿命；Task 7 的阶段边界与死亡测试都依赖这个数');
});

test('种群上限：桌面 24 / 手机 16', () => {
  assert.equal(CONFIG.populationCap.desktop, 24);
  assert.equal(CONFIG.populationCap.mobile, 16);
  // 2026-10-14 由 4 调到 8（控制方裁定）。4 只创始个体下约 60% 的缸在一小时内整批灭绝，
  // 机制是**血统坍缩**而非繁殖率不够：4 只创始 → 平均只有 7.00 位不同母亲 →
  // 全缸变成单一亲缘组 → `kinship > 0.25` 的严格近亲回避把每一对都挡掉 → 出生冻结。
  // 实测存活门槛是"母亲数 ≥ 10 全活、≤ 7 全灭"。
  // 扫创始个体数（8 种子 × 60 分钟）：4→灭绝 5/8（母亲 7.00）、8→3/8（10.13）、12→2/8（13.13），
  // 单调且恰好在门槛处转折。取 8 不取 12：12 只一开缸就占掉上限 24 的一半，
  // 挤掉"看得见长大"的余量，而它也没做到 0/8。详见 src/config.js 的注释。
  // ⚠️ 灭绝被裁定为**合法结局**（玩家开新缸），不是 bug：spec §9.2 的六条验收依据里
  // 本来就没有"种群自我延续"。别把这条断言当成"缸必须永不灭绝"来"修"。
  assert.equal(CONFIG.initialCreatures, 8);
});

test('色相区间是粉色：315° 到 25°（跨 0°）', () => {
  assert.deepEqual([...CONFIG.hueRange], [315, 25]);
});

test('体型区间 14–38', () => {
  assert.equal(CONFIG.minSize, 14);
  assert.equal(CONFIG.maxSize, 38);
});

test('固定步长与累加上限', () => {
  assert.ok(Math.abs(CONFIG.fixedDt - 1 / 60) < 1e-12);
  assert.equal(CONFIG.dtAccumCap, 0.25);
  assert.deepEqual([...CONFIG.timeScales], [0.5, 1, 2, 4]);
});

test('孤雌繁殖常量齐备（求偶三常量已随 spec §4.12 删除）', () => {
  assert.deepEqual([...CONFIG.eggsPerClutch], [1, 3]);
  assert.equal(CONFIG.eggSize.min, 0.6);
  assert.equal(CONFIG.eggSize.max, 1.4);
  // 这条是裁定的钉子：控制方 2026-10-20 **不追认**蛋大小影响成年体型。
  // 没有它，将来有人觉得"大蛋就该长成大的"顺手调成 0.3，全库不会有任何测试变红。
  assert.equal(CONFIG.eggSize.bias, 0, 'EGG_SIZE_BIAS 必须是 0（裁定）');
  assert.equal(CONFIG.drift.interval, 240, '漂入是孤雌下多样性的唯一补给阀门');
  assert.equal(CONFIG.drift.form, 'egg');
  // 反向确认：删掉的必须真的没了。留着"看起来还在其实没人读"的常量，
  // 比删掉更糟 —— 调它不会有任何效果，而这正是"改了配置却没生效"那一类。
  assert.equal(CONFIG.kinshipMateMax, undefined, '近亲闸门常量必须已删除');
  assert.equal(CONFIG.courtship, undefined, '求偶时长区间必须已删除');
  assert.equal(CONFIG.rejectionAffection, undefined, '拒绝好感惩罚必须已删除');
});

test('记忆容量 12，三条衰减率齐备', () => {
  assert.equal(CONFIG.memoryCapacity, 12);
  assert.equal(CONFIG.affectionDecay, 0.02);
  assert.equal(CONFIG.affectionDecayKin, 0.002);
  assert.equal(CONFIG.familiarityDecay, 0.004);
  assert.ok(CONFIG.affectionDecayKin < CONFIG.affectionDecay,
    '亲属的淡忘必须比普通关系慢，否则"近乎不忘"不成立');
});

test('情绪惯性与八个事件冲击都在（mated→laid，rejected 随求偶制删除，ignored 随升级链新增）', () => {
  assert.equal(CONFIG.emotions.inertia, 1.6);
  const kinds = Object.keys(CONFIG.emotions.eventMagnitude).sort();
  assert.deepEqual(kinds,
    ['bumped', 'death', 'fed', 'ignored', 'laid', 'petted', 'poked', 'startled']);
  // 'rejected' 曾经的生产者只有一处：求偶被拒。孤雌下那个场景不存在了，
  // 所以整个事件种类删掉 —— 留一个永远不会被 applyEvent 到的种类，
  // 就是 Task 9 复查抓过的"无生产者的字段"。
  assert.ok(!('rejected' in CONFIG.emotions.eventMagnitude));
  // 'ignored' 的生产者恰好相反，它**有**：sim.tickCreature 在跨过第二级
  // （begIgnored ≥ begEscalate.protestAfter）的那一刻发一次，由
  // tests/sim.test.js 的"发一次 ignored 冲击，而且只发一次"钉住。
  assert.ok('ignored' in CONFIG.emotions.eventMagnitude);
});

test('求关注升级链的两个秒数与两个加成都在，且第二级 = 第一级 + 5 秒', () => {
  // 计划 A4 的陷阱条：升级链的强度必须从 begUrgency 推导，不能各写一个魔法数。
  // 这里把四个旋钮钉成字面量，behavior.test.js 再把"加成 = hopBonus × begUrgency"钉住 ——
  // 于是调 begUrgency 会让**两处同时变红**，两个常数就没法悄悄分家。
  const e = CONFIG.behavior.begEscalate;
  assert.equal(e.hopAfter, 3, 'spec §4.10：beg 了 3 秒没被理睬 → 升一级');
  assert.equal(e.protestAfter, 8, 'spec §4.10：再 5 秒仍没被理睬 → 再升一级（3 + 5 = 8）');
  assert.equal(e.protestAfter - e.hopAfter, 5, '两级之间必须正好是"再 5 秒"');
  assert.equal(e.hopBonus, 0.25);
  assert.equal(e.protestFloor, 0.25);
  // 加成写成 7.0 的分数，两端取值必须是二进制精确的 —— 否则测试里的字面量断言
  // 会像 personality 那组一样带上浮点尾巴（0.3 × 7 = 2.1000000000000005）。
  assert.equal(e.hopBonus * CONFIG.behavior.begUrgency, 1.75);
  assert.equal(e.protestFloor * CONFIG.behavior.begUrgency, 1.75);
  assert.ok(CONFIG.emotions.eventMagnitude.ignored, '第二级要有情绪冲击才读得出来');
  assert.deepEqual(CONFIG.emotions.eventMagnitude.ignored, { anger: 0.25, joy: -0.2 });
});

test('需求速率齐备，且休息是唯一的负值（恢复）', () => {
  const n = CONFIG.needs;
  for (const k of ['hungerRate', 'energyRateActive', 'energyRateIdle', 'socialRate',
    'safetyRecover', 'feedAmount', 'startleAmount', 'socialRelief']) {
    assert.equal(typeof n[k], 'number', `缺少 needs.${k}`);
    assert.ok(Number.isFinite(n[k]), `needs.${k} 非有限数`);
  }
  assert.ok(n.energyRateRest < 0, 'energyRateRest 必须是负数 —— 它是恢复而非消耗');
  assert.ok(n.energyRateActive > n.energyRateIdle, '移动应比静止更耗能');
  assert.ok(n.socialRelief > 0 && n.socialRelief < 1, 'socialRelief 是比例，应在 (0,1)');
});

test('感知半径大于网格边长（否则跨格邻居会漏）', () => {
  assert.ok(CONFIG.perceiveRadius > CONFIG.gridCell,
    `perceiveRadius ${CONFIG.perceiveRadius} 必须大于 gridCell ${CONFIG.gridCell}`);
});

test('package.json 不含任何依赖（零依赖约束）', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module', '必须是 ESM');
  // 逐个字段断言 undefined 是漏的：peerDependencies、optionalDependencies，
  // 乃至任何一个不在白名单里的键，都能从"dependencies/devDependencies 为空"旁边溜过去。
  // 而这条约束管着全部十一个 Task，这里是它唯一的自动化守卫 —— 所以改成整体键集比对，
  // 一次性堵掉所有入口：多一个键就红，不管那个键叫什么。
  assert.deepEqual(Object.keys(pkg).sort(), ['name', 'private', 'scripts', 'type'],
    'package.json 只允许这四个键 —— 任何依赖字段都违反零依赖约束');
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['simulate', 'test']);
});

test('五档心情的八个阈值被字面量钉住（两侧取值由 emotions.test.js 负责）', () => {
  // 分工：config.test.js 钉**数值本身**，emotions.test.js 钉**每个数两侧的档位**。
  // 只钉一侧的话，把 angerMin 从 0.5 改成 0.05 也能通过所有档位测试
  // （因为档位测试读的是 CONFIG），而这会让任何一生物在有点烦的时候都报"愤怒"。
  const m = CONFIG.mood;
  assert.deepEqual(Object.keys(m).sort(), [
    'angerMin', 'blissAffMin', 'blissJoyMin', 'blissNeedMax',
    'happyJoyMin', 'sadFearMin', 'sadJoyMax', 'sadSocialMin',
  ], '八个阈值，不多不少 —— 加一个就得同时加两侧档位的测试');
  assert.equal(m.angerMin, 0.5);
  assert.equal(m.sadJoyMax, 0.25);
  assert.equal(m.sadFearMin, 0.4);
  assert.equal(m.sadSocialMin, 0.7);
  assert.equal(m.happyJoyMin, 0.45);
  assert.equal(m.blissJoyMin, 0.6);
  assert.equal(m.blissNeedMax, 0.25);
  assert.equal(m.blissAffMin, 0.6);
  // 档位之间必须**有顺序**，否则五档会塌成三档（幸福线低于快乐线就是这种错误）
  assert.ok(m.blissJoyMin > m.happyJoyMin, '幸福必须比快乐要求更高的 joy');
  assert.ok(m.sadSocialMin > m.blissNeedMax, '社交匮乏线必须远高于"需求已满足"线');
});

test('语言层的十二个旋钮被字面量钉住（行为两侧由 speech.test.js 负责）', () => {
  // 分工同 §4.5.1 那组：这里钉**数值本身**，speech.test.js 钉它造成的比值与宽度差。
  // 只钉行为的话，把 sayGain 从 0.8 调到 0.08 会让整缸几乎不出词而没有任何一条测试报警；
  // 只钉数值的话，改公式形状（比如把 talk 从概率里拿掉）不会报警 —— 所以两边都要有。
  const s = CONFIG.speech;
  assert.equal(s.enabled, true, '默认必须开着：关掉是设置页的动作，不是出厂状态');
  assert.equal(s.cooldownMin, 6);
  assert.equal(s.cooldownMax, 18);
  assert.deepEqual([s.tokensBase, s.tokensGain], [2, 3]);
  assert.deepEqual([s.sayBase, s.sayGain], [0.15, 0.8]);
  assert.equal(s.talkFloor, 0.35);
  assert.deepEqual([s.cutePoolFloor, s.middlePoolFloor], [0.5, 0.2]);
  assert.equal(s.needSpeakMin, 0.35);
  assert.deepEqual([s.catchphraseChance, s.addressChance, s.otherNameChance], [0.6, 0.4, 0.35]);
  assert.equal(s.addressAffMin, 0.3);
  assert.equal(s.heardBase, 4);
  assert.equal(s.heardGain, 8);
  assert.equal(s.misspeakMax, 0.25);
  assert.equal(s.maxTokens, 5);
  assert.equal(s.onscreenMax, 2);
  assert.equal(s.bubbleTtl, 3);
  // 结构性关系（写错方向不会有症状，只会有手感）
  assert.ok(s.tokensBase + s.tokensGain <= s.maxTokens, 'token 预算的上限就是硬上限，不许越过');
  assert.ok(s.sayBase + s.sayGain <= 1, '概率的分子项之和不得超过 1（clamp 之前就该成立）');
  assert.ok(s.talkFloor > 0 && s.talkFloor < 1, 'talkFloor 是分数，不是概率');
  assert.ok(s.cutePoolFloor > s.middlePoolFloor, '萌系候选集的门槛必须比中性的高');
});


test('听进去的话的九个常量与价格表齐备，价格表键集与 MOODS 对齐', () => {
  // 分工同前两节：这里钉数值，heard.test.js 钉它造成的行为差异。
  const h = CONFIG.heard;
  assert.equal(h.halfLife, 300);
  assert.equal(h.strongUses, 2);
  assert.equal(h.strongFactor, 2);
  assert.equal(h.retainMin, 0.25);
  assert.equal(h.suppressBelow, -0.6);
  assert.equal(h.moodBoost, 0.5);
  assert.deepEqual([h.takeBase, h.takeGain], [1, 4]);
  // 价格表少一档的症状是静默的：undefined 进存档变 null、读回 0，
  // 于是那一档听到的词全部变成"中性价"，既不会被躲也不会被偏爱 —— 没有任何报错。
  assert.deepEqual(Object.keys(h.moodPrice).sort(), [...MOODS].sort(),
    '价格表必须恰好覆盖五档心情');
  assert.equal(h.moodPrice.calm, 0);
  assert.ok(h.moodPrice.anger < h.suppressBelow,
    'anger 必须落在"会被抑制"那一侧，否则"骂过它的词它会躲"永远不成立');
  assert.ok(h.moodPrice.sad > h.suppressBelow,
    'sad 不能落到抑制线以下 —— 饿的时候听到"吃饭"通常就是带着难过听的，被抑制就等于这个例子失效');
  assert.ok(h.moodPrice.bliss > 0 && h.moodPrice.happy > 0);
  assert.ok(Object.isFrozen(h.moodPrice), '价格表应被冻结');
});

test('NEED_WORDS 的键与 needs 的四条匮乏度是同一份键表（不是各抄一遍）', () => {
  // lexicon 与 heard 都按 needs 的键查表；漏一条的症状是"那条需求永远不被说出口、
  // 也永远想不起来"。needs.js 现在把 NEED_KEYS 导出，两边都从它对齐。
  assert.deepEqual([...NEED_KEYS].sort(), Object.keys(NEED_WORDS).sort());
  assert.deepEqual(NEED_KEYS.map((k) => typeof NEED_WORDS[k]), ['string', 'string', 'string', 'string']);
});

test('分词表：停用词与替换池都被冻结，且停用词表里没有单字词', () => {
  // 单字进停用表是危险的：中文分词按 2–3 gram 切，"好"这种单字本来就不会成为候选，
  // 把它列进表里只会让人以为表按子串生效（实际按整词等于才生效）。
  assert.ok(Object.isFrozen(STOPWORDS) && Object.isFrozen(WORD_POOL));
  for (const w of STOPWORDS) assert.ok(w.length >= 2, `停用词 "${w}" 短于两字，切法会误伤`);
  assert.ok(WORD_POOL.length >= 10, '替换池太小会让说错词退化成"原样再说一遍"');
  // 反向确认：停用词真的会被切掉（行为级，不钉具体切法 —— 计划 A7 的陷阱条）
  assert.ok(!tokenize('今天也要好好吃饭哦').includes('今天'), '停用词不该进候选');
});
