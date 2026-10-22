import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { ALL_GENES } from '../src/genes.js';
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
  // 用下限的话，**删掉一整段 CONFIG 也不会报警**（21 个节点的下限在 44 个的现实下永远满足），
  // 而"遍历没走到某个子树"恰恰就是这种删除的症状。下限防不住它想防的东西。
  // 改成**精确相等**：往 CONFIG 里加常量会让这条变红 —— 那是**想要的摩擦**，
  // 加常量的人必须顺手把这里和下面的段名一起更新，正如 MAGNITUDES 那张表要求
  // 新增情绪事件的人同步更新测试一样。"每次加常量都要回来改测试"不是缺点，是守卫的代价。
  //
  // ⚠️ 39 → 44、41 → 46：B12（2026-10-21）加了 body / star / fluff / tail / blink 五段，
  // 每段一个节点。两个新数都是**用 node 数出来的**，不是估的。
  // ⚠️ 44 → 45、46 → 47：B13（2026-10-21）加了 CONFIG.render 一段（一个节点）。
  // 两个新数同样是数出来的，不是估的：
  //   node -e "import('./src/config.js').then(({CONFIG})=>{let n=0;const w=x=>{if(x===null\
  //   ||typeof x!=='object')return;n++;for(const k of Object.keys(x))w(x[k])};w(CONFIG);\
  //   console.log('nodes',n,'keys',Object.keys(CONFIG).length)})"      →  nodes 45 keys 47
  // ⚠️ 45 → 46、47 → 48：B15（2026-10-21）加了 CONFIG.eye 一段（一个节点、57 个旋钮）。
  // 加这一段的全部理由：spec §4.6 那张十行表的数只能有一处定义，而 eyes.js 不许有字面量。
  // ⚠️ 46 → 47（顶层键数仍 48）：B16（2026-10-21）在 CONFIG.colors 里加了 **eggTints 子表**
  // （一个节点、八个键）。它为什么必须是子表而不是八个平铺的键：蛋色的键集要能与
  // CONFIG.eggTint.colors（遗传位点那八个名字）**逐键比对** —— 平铺键做不到这件事，
  // 而"位点加了一色、色表忘了补"的症状是那颗卵静默沿用上一颗的颜色（tests/render-fx.test.js 钉）。
  // 同一 Task 还往 CONFIG.render / CONFIG.tail 里加了若干**标量**旋钮：标量不是节点，
  // 所以只动了下面两条键名清单，没动这里计数。
  // ⚠️ 47 不变、48 不变（2026-10-22 B19a）：气泡层加了 **12 个标量**进已有的 CONFIG.speech。
  // 这里刻意**不**给 speech 加子表：那 12 个旋钮之间没有「逐键比对」这类结构关系
  // （eggTints 那种子表是为了和遗传位点比键集），把它们包成一个 bubble 子节点只会多一个节点、
  // 换来零判据。代价如实记在这里：新增标量不会让上面两条计数变红，
  // 所以 speech 的**键集**改由下面那条 deepEqual 单独钉（那是本段唯一的护栏）。
  assert.equal(visited.length, 47, `CONFIG 的对象/数组节点数变了（现 ${visited.length}）`);
  // 段名同样精确钉住：只有节点数会漏掉"删了一段又加了一段、总数恰好一样"这种巧合。
  assert.deepEqual(Object.keys(CONFIG).sort(), [
    'affectionDecay', 'affectionDecayKin', 'behavior', 'blink', 'body', 'bodyPoints', 'broody',
    'colors', 'dissolveDuration', 'drift', 'dtAccumCap', 'eggFailChanceAtCap', 'eggSize', 'eggTint',
    'eggsPerClutch', 'emotions', 'eye', 'eyeWidthRatio', 'familiarityDecay', 'fixedDt', 'fluff',
    'food', 'foodMax', 'foodRespawnRate', 'glowHueBuckets', 'gridCell', 'heard', 'hop', 'hueRange',
    'initialCreatures', 'maxSize', 'memoryCapacity', 'minSize', 'mood', 'motion',
    'mournDuration', 'mournRadius', 'mutationRate', 'needs', 'particles', 'perceiveRadius',
    'populationCap', 'render', 'speech', 'stage', 'star', 'tail', 'timeScales',
  ], 'CONFIG 顶层键名（48 个，数出来的不是估的）变了 —— 加一项或删一项都要在这里说清楚');
  assert.equal(Object.keys(CONFIG).length, 48);
  for (const path of [
    'CONFIG',
    'CONFIG.behavior', 'CONFIG.eggTint', 'CONFIG.particles',   // 抽查时代漏掉的三个
    'CONFIG.emotions.eventMagnitude.poked',                       // 第三层
    'CONFIG.timeScales', 'CONFIG.hueRange', 'CONFIG.eggsPerClutch', // 数组节点
    'CONFIG.mood', 'CONFIG.heard', 'CONFIG.speech', 'CONFIG.hop',   // 2026-10-20 之后新增的四段
    'CONFIG.heard.moodPrice', 'CONFIG.behavior.begEscalate',        // 第三层的新增项
    'CONFIG.body', 'CONFIG.star', 'CONFIG.fluff', 'CONFIG.tail', 'CONFIG.blink',   // B12 新增五段
    'CONFIG.render',                                                              // B13 新增（水体与缩放）
    'CONFIG.eye',                                                                 // B15 新增（眼睛十行表）
    'CONFIG.colors.eggTints',                                                     // B16 新增（八色蛋的子表）
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

test('语言层的三十个旋钮（数出来的）：键集钉死，数值两侧分工', () => {
  // 分工同 §4.5.1 那组：这里钉**数值本身**，speech.test.js 钉它造成的比值与宽度差。
  // 只钉行为的话，把 sayGain 从 0.8 调到 0.08 会让整缸几乎不出词而没有任何一条测试报警；
  // 只钉数值的话，改公式形状（比如把 talk 从概率里拿掉）不会报警 —— 所以两边都要有。
  const s = CONFIG.speech;
  // ⚠️ B19a（2026-10-22）补的键集守卫：speech 是 8 个标量段里唯一没有 deepEqual 的一个，
  // 而它的 12 个气泡旋钮**不会**让上面那两条节点/顶层键计数变红（标量不是节点）。
  // 没有这一条，「加一个没人读的旋钮」在这段是完全静默的 —— 那正是本项目反复清账的那类债。
  assert.deepEqual(Object.keys(s).sort(), [
    'addressAffMin', 'addressChance', 'bubbleFadeHold', 'bubbleFontPx', 'bubbleHeadGap',
    'bubbleLineGap', 'bubbleMaxLines', 'bubbleMaxWidthFrac', 'bubblePadding', 'bubbleQueueMul',
    'bubbleStroke', 'bubbleTtl', 'catchphraseChance', 'cooldownMax', 'cooldownMin',
    'cutePoolFloor', 'enabled', 'heardBase', 'heardGain', 'maxTokens', 'middlePoolFloor',
    'misspeakMax', 'needSpeakMin', 'onscreenMax', 'otherNameChance', 'sayBase', 'sayGain',
    'talkFloor', 'tokensBase', 'tokensGain',
  ], 'CONFIG.speech 的键集（30 个，node 数出来的）变了 —— 加一项删一项都要在这里说清楚');
  assert.equal(Object.keys(s).length, 30);
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

// ---- B12（2026-10-21）：造型四组 + 软体弹簧，全部钉数值本身 ----
// 分工与上面三组同构：这里钉**数值**，tests/body.test.js 钉它造成的**行为差异**
// （形状是不是五角星、尾巴摆速随不随 activity、毛长随不随 fluff 基因）。
// 只钉行为的话，把 STAR_INNER_RATIO 从 0.62 改成 0.95 会让星形悄悄塌成圆而没有任何报警；
// 只钉数值的话，把摆速公式里的 (1 + arousal) 改成 (1 + fear) 也不会报警 —— 所以两边都要有。

test('五角星 / 卷毛 / 尾巴 / 眨眼四组的常量被字面量钉住（行为两侧由 body.test.js 负责）', () => {
  // 八个数逐字取自 spec §11（2026-10-20 那一版），不是估的：
  //   STAR_OUTER_RATIO=1.0  STAR_INNER_RATIO=0.62  FLUFF_LEN_RATIO=0.18  FLUFF_SPRITES=2
  //   TAIL_SEGS=3  TAIL_LEN_RATIO=0.5  TAIL_SWING_BASE=1.2  BLINK_INTERVAL_BASE=4.0
  assert.deepEqual(Object.keys(CONFIG.star).sort(), ['corners', 'innerRatio', 'outerRatio']);
  assert.equal(CONFIG.star.corners, 5, '五角星的"五"：spec §11 没单列，但 body.js 不许有字面量');
  assert.equal(CONFIG.star.outerRatio, 1.0);
  assert.equal(CONFIG.star.innerRatio, 0.62, '0.62 是照片那只的比例，改它必须是一次有意识的动作');
  assert.ok(CONFIG.star.innerRatio > 0 && CONFIG.star.innerRatio < CONFIG.star.outerRatio,
    '内凹必须严格小于外角，否则"不是星形就是圆"');

  assert.deepEqual(Object.keys(CONFIG.fluff).sort(), ['lenRatio', 'sprites']);
  assert.equal(CONFIG.fluff.lenRatio, 0.18);
  // sprites = 2 是 spec §4.7 那条性能生死线的读数：
  // 只画"毛尖浅色碎边"才只需要 2 张；按"每根毛有自己的颜色"要 32 色相桶 × 8 蓬松档 = 256 张。
  assert.equal(CONFIG.fluff.sprites, 2);

  assert.equal(CONFIG.tail.segs, 3);
  assert.equal(CONFIG.tail.lenRatio, 0.5, '链长 = 0.5 × 身体半径，**由体型派生、不新增基因**');
  assert.equal(CONFIG.tail.swingBase, 1.2);
  // 这两个数是 spec §4.7.1 那条公式**自身**的两个常数（搬进 CONFIG 只为了让 body.js 无字面量）
  assert.equal(CONFIG.tail.swingActivityFloor, 0.4);
  assert.equal(CONFIG.tail.swingArousalGain, 1);
  // ⚠️ 15 → 17：B16（2026-10-21）加了 ampBeg / begRateGain 两项，它们是 spec §4.10
  // 求关注升级链在**尾巴**这一条通道上的落点（第一档"尾巴幅度拉满"、第二档"生气"的急促）。
  // 档位本身**不在这里**：阈值只有 CONFIG.behavior.begEscalate 一处，body.js 读那两个秒数。
  assert.deepEqual(Object.keys(CONFIG.tail).sort(), [
    'ampAnger', 'ampArousal', 'ampBeg', 'ampJoy', 'ampQuiet', 'angerRateGain', 'begRateGain',
    'curlQuiet', 'dragRate', 'fearTuck', 'followRate', 'lenRatio', 'segs', 'swingActivityFloor',
    'swingArousalGain', 'swingBase', 'waveLag',
  ], '尾巴的十七个旋钮，不多不少（spec 只给了前三个数与后十个的**排序**，数值属 §12 授权）');
  assert.ok(CONFIG.tail.ampQuiet > 0, '安静档也必须还在摆（spec §4.7.1 表："低频慢摆"，不是"不动"）');
  assert.ok(CONFIG.tail.fearTuck > 0 && CONFIG.tail.fearTuck <= 1, 'fearTuck 是收缩分数');
  // 升级链那两项的方向性：第一档只加幅度、第二档只加速（spec §4.10"替换而非叠加"）。
  assert.ok(CONFIG.tail.ampBeg > 0, '第一档的"幅度拉满"必须真的加东西');
  assert.ok(CONFIG.tail.begRateGain > 0, '第二档的"急促前后抽"必须真的更快');

  assert.deepEqual(Object.keys(CONFIG.blink).sort(), ['activityFloor', 'intervalBase']);
  assert.equal(CONFIG.blink.intervalBase, 4.0);
  assert.equal(CONFIG.blink.activityFloor, 0.4,
    '眨眼与蹦跳同源的证据：两条公式用的是同一个 activity 地板');
});

test('眼睛的五十七个旋钮齐备，且十行表的方向性不等式成立（数值侧守，映射侧由 eyes.test.js 负责）', () => {
  // 分工与 mood / tail / blink 三组一样：这里钉**数本身与数之间的排序**，
  // eyes.test.js 钉"eyes.js 有没有照这些数算"。只钉一侧会漏：
  //   只钉行为 → 把 happyLid 从 0.30 改成 0.95 时行为断言仍然绿（它按 CONFIG 比）；
  //   只钉数值 → 把 eyeSpacing 的内收写成外扩时数值全对而画面是错的。
  const Y = CONFIG.eye;
  assert.deepEqual(Object.keys(Y).sort(), [
    'angerLid', 'angerPupil', 'angerSpacing', 'angerTopLid',
    'arousalPupil', 'begLid', 'begLiftY', 'begPupil',
    'blinkWaveFrac', 'blissLid', 'blissPupil', 'blushAlong',
    'blushAlpha', 'blushBegBoost', 'blushJoyBoost', 'blushMax',
    'blushOffsetX', 'blushOffsetY', 'blushRadius', 'curiosityAsym',
    'curiosityOffset', 'curiosityPupil', 'deathCloseSeconds', 'eyeSizeMin',
    'fearLid', 'fearOffset', 'fearPupil', 'fearShrink',
    'forward', 'handNearRadius', 'happyLid', 'happyPupil',
    'highlightRadius', 'highlightX', 'highlightY', 'leakGain',
    'lookMax', 'lookTrustMin', 'neutralPupil', 'phaseModulus',
    'pupilMax', 'pupilMin', 'sadHighlightY', 'sadLid',
    'sadLowerLid', 'sadOffset', 'sadPupil', 'sadSpacing',
    'sleepyBlinkStretch', 'sleepyLid', 'spacing', 'starPoints',
    'starScaleMax', 'starSpinMax', 'starSpinPeriod', 'trustAffectionMin',
    'trustBlinkStretch',
  ], '五十七个旋钮，不多不少。⚠️ 这里**没有** sadTopLid 是故意的：spec 逐字"不是上眼睑下垂"');

  // 七格"瞪圆 > 半睁 > 眯成一条"的排序
  assert.ok(Y.fearLid > Y.sadLid && Y.sadLid > Y.sleepyLid && Y.sleepyLid > Y.happyLid,
    '开合的排序是 spec 那张表的骨架：害怕瞪到最大 > 委屈半睁 > 困倦半闭 > 开心眯成 ^^');
  assert.ok(Y.happyLid > 0, '开心那一格必须是"一条弧"而不是"整个消失"');
  // 瞳孔：婴儿式最大，害怕最小
  assert.ok(Y.fearPupil < Y.angerPupil && Y.angerPupil < Y.neutralPupil, '瞪圆时瞳孔是缩小的');
  assert.ok(Y.neutralPupil < Y.happyPupil && Y.happyPupil < Y.blissPupil, '开心→幸福是逐步放大');
  assert.equal(Y.pupilMax, Y.begPupil, '瞳孔上限就是卖萌那一格：两个数分家会漂移');
  assert.ok(Y.pupilMin > 0 && Y.pupilMin < Y.fearPupil, '最小瞳孔也必须画得出来');
  assert.ok(Y.sadPupil > Y.neutralPupil, '委屈那一格"瞳孔放大"（裁定 2 里它与 fear 方向相反）');
  // 间距：惊吓外扩、生气内收 —— 两个符号必须相反
  assert.ok(Y.sadSpacing > 0 && Y.angerSpacing < 0, 'spec：伤心 eyeSpacing 外扩、anger 内收');
  assert.ok(Y.spacing + Y.angerSpacing > 0, '内收过头会让两眼交叉');
  // 前后：害怕与委屈都后移，好奇前倾
  assert.ok(Y.fearOffset < 0 && Y.sadOffset < 0 && Y.curiosityOffset > 0, '沿 facing 的方向不能写反');
  assert.ok(Math.abs(Y.fearOffset) + Y.forward > 0, '后移不许把眼睛移到中心线另一侧（那是后脑勺）');
  // 垂直：卖萌上望
  assert.ok(Y.begLiftY > 0, 'eyes.js 取负号写成向上；这里只保证幅度为正、方向由代码定');
  // 星星眼的"轻微"必须有上界，否则幸福那一格会抽风
  assert.ok(Y.starSpinMax > 0 && Y.starSpinMax < 1, `旋转幅度必须是"轻微"：${Y.starSpinMax}`);
  assert.ok(Y.starScaleMax > 0 && Y.starScaleMax < 0.5, `缩放幅度必须是"轻微"：${Y.starScaleMax}`);
  assert.ok(Y.starSpinPeriod > 1, '星转得太快就不是奖赏而是故障');
  assert.equal(Y.starPoints, 4, 'spec 逐字"四角星"');
  // 两个"缓慢"都必须真的慢（倍数 > 1）
  assert.ok(Y.sleepyBlinkStretch > 1 && Y.trustBlinkStretch > 1, '"极缓慢地眨"与 slow blink 都是把周期拉长');
  assert.ok(Y.blinkWaveFrac > 0 && Y.blinkWaveFrac < 1, '一次眨眼必须明显短于整个周期');
  assert.ok(Y.deathCloseSeconds > 0, '死亡那一格是"缓缓闭合"，不是瞬间归零');
  assert.ok(Y.leakGain > 0 && Y.leakGain < 1, '次要情绪的泄漏必须存在但不能盖过主导那一格');
  assert.ok(Y.lookTrustMin > 0 && Y.lookTrustMin < 1, '好感为零也要留一点余光，但不能满幅');
  assert.ok(Y.handNearRadius > 0 && Y.handNearRadius < 1, '手"在附近"必须是个有限的归一化距离');
  assert.ok(Y.eyeSizeMin > 0, '害怕收缩的下限若为 0，眼睛会在屏幕上塌成无效路径');
  // 高光：常态在上缘、委屈在下缘 —— 一个正一个负是"含泪"这件事的全部读数
  assert.ok(Y.highlightY < 0 && Y.sadHighlightY > 0, 'spec 逐字：委屈那格"高光偏到眼睛下缘"');
  // 腮红三档的排序（spec §4.5 的卖萌行"腮红泛开"）
  assert.ok(Y.blushBegBoost > Y.blushJoyBoost, '卖萌的腮红必须比单纯开心更明显');
  assert.ok(Y.blushMax > Y.blushAlpha + Y.blushJoyBoost, '上限不该把开心那一档截掉');
  assert.ok(Y.blushOffsetX > 0 && Y.blushRadius > 0, '腮红必须有位置与半径，否则等于没画');
});

test('渲染层的五十个旋钮被字面量钉住（水体与缩放 + 分层身体 + 溶散/卵/食物/蹦跳；行为两侧由 render-fx.test.js 负责）', () => {
  // 分工同 §4.5 / §4.7 那两组：config.test.js 钉**数值本身**，render.test.js 钉它造成的映射。
  // 只钉行为的话，把 scaleMin 从 1.5 调到 0.4 会让手机上"生物小到看不见"（spec §3.4-2
  // 点名要防的情况）而行为侧仍然全绿；只钉数值的话，改 clamp 的方向也不会报警。
  const R = CONFIG.render;
  // ⚠️ 31 → 50：B16（2026-10-21）加了 19 个旋钮（6 个溶散/粒子 + 2 个 sick + 1 个哀悼
  // + 5 个卵 + 1 个食物 + 4 个蹦跳），全部是标量 ⇒ 顶层节点数不动，只有这张清单变长。
  // 分工与上面几段一致：**数**在这里，**行为**在 tests/render-fx.test.js。
  assert.deepEqual(Object.keys(R).sort(), [
    'burstPool', 'dissolveAlphaPow', 'dissolveExpand', 'dissolveGlowPow', 'dissolveLift',
    'dissolveParticles', 'eggFailFadeTime', 'eggFailMinGlow', 'eggGlowPulse', 'eggRadius',
    'eggRevealAt', 'fluffSpriteSize', 'foodRadius', 'glowAlphaFactor', 'glowRadiusFactor',
    'glowSpriteSize', 'hopLandAt', 'hopLiftRatio', 'hopSquashMin', 'hopStretchAir', 'innerAlpha',
    'innerPulse', 'innerRadiusFactor', 'moteAlphaMax', 'moteAlphaMin', 'moteDrift',
    'moteRadiusMax', 'moteRadiusMin', 'moteRiseMax', 'moteRiseMin', 'moundCount', 'mournDim',
    'patternAlpha', 'patternMarkFactor', 'peltDarkCut', 'peltLitBoost', 'peltSatLift',
    'peltSpriteSize', 'scaleMax', 'scaleMin', 'scaleRef', 'sedimentHeight', 'shaftAlpha',
    'shaftCount', 'shaftSwayPeriod', 'sickDesat', 'sickDim', 'tailLiftFactor', 'tailSegFactor',
    'tailTaper',
  ], '五十个旋钮，不多不少（三个缩放 + 十二个水体 + 十六个分层身体 + 十九个 B16，数出来的）');

  // ---- 缩放（spec §3.4-2："由短边推导并 clamp"；三个数属 §12 授权的观感自定）----
  assert.deepEqual([R.scaleRef, R.scaleMin, R.scaleMax], [540, 1.5, 2.6]);
  assert.ok(R.scaleMin < R.scaleMax, 'clamp 的上下限不许反（反了会让每个视口都取到上限）');
  // 下限存在的唯一理由是手机：390×844 的短边 390 ⇒ 390/540 = 0.722 < scaleMin ⇒ 触底。
  // 把 scaleMin 抬到 2.6 会让所有设备都钉在上限上（clamp 退化成常量），这条就抓得住。
  assert.ok(390 / R.scaleRef < R.scaleMin, '手机竖屏必须落在下限上，否则 18.8px 的成体会回来');
  assert.ok(2160 / R.scaleRef > R.scaleMax, '4K 短边必须触顶，否则 24 只 104px 的团子挤满画面');

  // ---- 微粒（alpha 区间是 spec §4.3 的字面量，不是观感自定）----
  assert.deepEqual([R.moteAlphaMin, R.moteAlphaMax], [0.15, 0.40],
    'spec §4.3 原文："微粒：#FFD9E8，alpha 0.15–0.4" —— 改这两个数要先改 spec');
  assert.deepEqual([R.moteRiseMin, R.moteRiseMax], [0.006, 0.020]);
  assert.deepEqual([R.moteRadiusMin, R.moteRadiusMax], [0.6, 2.2]);
  assert.ok(R.moteRiseMin < R.moteRiseMax && R.moteRadiusMin < R.moteRadiusMax, '区间两端不许反');
  // 背景不是主角：最慢的微粒横穿整缸要 1/0.006 ≈ 167 秒（一帧 1/60 秒 ⇒ 一万帧）
  assert.ok(1 / R.moteRiseMin > 150, `最慢的上浮速度太快就不像深水了：${1 / R.moteRiseMin}s`);
  assert.equal(R.moteDrift, 0.004);
  assert.ok(R.moteDrift < R.moteRiseMin, '横向漂移必须慢于上浮，否则看起来像在横扫');
  assert.deepEqual([CONFIG.particles.desktop, CONFIG.particles.mobile], [120, 60],
    'spec §5.2："上浮微粒 60–120 个" —— 两端各取一档');

  // ---- 光束（spec §5.2："2–3 道缓慢摆动的柔光束"）----
  assert.ok(R.shaftCount >= 2 && R.shaftCount <= 3, `道数必须在 spec 给的 2–3 里，实测 ${R.shaftCount}`);
  assert.equal(R.shaftAlpha, 0.055, 'lighter 叠加下 alpha 稍大整缸就发灰');
  assert.equal(R.shaftSwayPeriod, 26, '一道光束摆一个来回的秒数；要慢到察觉不到在动');
  assert.ok(R.shaftSwayPeriod > 20, '摆动周期低于 20 秒就成了"闪烁的迪厅灯"');

  // ---- 缸底沉积带（spec §5.2："深色沉积带 + 几个柔软小丘（产卵点）"）----
  assert.equal(R.sedimentHeight, 0.085);
  assert.equal(R.moundCount, 5);
  // 这条是**承重的**几何关系：卵产在 y ∈ [0.78, 0.97]（breeding.js 的 rng.range），
  // 沉积带上沿在 1 − sedimentHeight ⇒ 必须盖过 0.915，才有"卵埋在沉积物里"而不是悬空。
  assert.ok(1 - R.sedimentHeight >= 0.915,
    `沉积带上沿只到 ${1 - R.sedimentHeight}，最低的卵（0.97）会悬在带子上方`);

  // ---- 分层身体（B14，spec §5.1 第 1/2/3/4/5/7 层）----
  // 这三组数值的"两侧行为"在 tests/render-body.test.js（不透明、不跨色相、层序、贴图上界），
  // 这里只钉数本身与**新旧造型之间的不等式** —— 那四处"必须改掉的旧设计"若被顺手改回去，
  // 红的第一下应该在这里，而不是等到 B20 实机看画面才发现团子又变回凝胶。
  assert.deepEqual([R.glowSpriteSize, R.peltSpriteSize, R.fluffSpriteSize], [128, 96, 160]);
  assert.ok(R.glowRadiusFactor > 1 && R.glowRadiusFactor < 2.6,
    '光晕半径必须比旧凝胶方案的 2.6 收小（spec §5.1 第 1 层：毛会散射光）');
  assert.ok(R.glowAlphaFactor > 0 && R.glowAlphaFactor < 0.55, '同上：alpha 降低');
  // 第 2 层不透明 ⇒ 本体的明暗跨度由这两项决定，且都必须留在 [0,1] 内（跨了就出白块/黑块）
  assert.deepEqual([R.peltLitBoost, R.peltDarkCut, R.peltSatLift], [0.13, 0.30, 0.10]);
  assert.ok(R.peltLitBoost > 0 && R.peltDarkCut > 0, '受光侧不提亮、背光侧不压暗 = 根本没有渐变');
  assert.ok(R.peltLitBoost + R.peltDarkCut >= 0.08,
    `明度跨度 ${(R.peltLitBoost + R.peltDarkCut).toFixed(2)}：毛绒的体积感靠这一档，太小就成了一张平色贴纸`);
  assert.ok(R.peltLitBoost < 0.5 && R.peltDarkCut < 0.7, '提亮/压暗过头会把同色相冲成白或黑');
  // 第 3 层：spec 逐字"alpha 压到 0.35 左右"
  assert.equal(R.patternAlpha, 0.35, 'spec §5.1 第 3 层："花纹是绣在毛里的，不是印在塑料上的"');
  assert.equal(R.patternMarkFactor, 0.16);
  // 第 4 层："发光核"（0.30 半径 / 0.85 alpha）改成"透过毛看到的一片柔和亮区"
  assert.ok(R.innerRadiusFactor > 0.30, '亮区半径必须大于旧发光核的 0.30，否则还是一"颗"');
  assert.ok(R.innerAlpha > 0 && R.innerAlpha < 0.85, '亮区 alpha 必须低于旧 coreAlpha 的 0.85');
  assert.deepEqual([R.innerRadiusFactor, R.innerAlpha, R.innerPulse], [0.46, 0.34, 0.45]);
  // 第 5 层：尾巴段数**不在这里**（在 CONFIG.tail.segs），这里只钉每段的画法
  assert.deepEqual([R.tailSegFactor, R.tailTaper, R.tailLiftFactor], [0.72, 0.20, 0.30]);

  // ---- B16（2026-10-21）：死亡溶散 / sick / 哀悼 / 卵 / 食物 / 蹦跳 ----
  // 分工与上面各段一致：这里钉**数**，行为在 tests/render-fx.test.js。
  // 三条"改回去就红"的结构关系写在下面，它们各自的对应行为断言在同名测试里。
  assert.deepEqual([R.dissolveExpand, R.dissolveLift, R.dissolveParticles], [1.9, 0.035, 14]);
  assert.deepEqual([R.dissolveAlphaPow, R.dissolveGlowPow], [2, 3]);
  // ⚠️ 这两条幂是 spec §4.11 那一行**顺序**的唯一实现："光慢慢熄灭 → 身体溶散"。
  // 把两者对调（或把 glow 调成更小）会让身体比光先淡掉，画面读起来就是"它淡出了视野"，
  // 而不是"它死了、散开了"。这条不等式是那个错误的唯一机器证据。
  assert.ok(R.dissolveGlowPow > R.dissolveAlphaPow,
    '光的幂必须**大于**身体的幂：幂越大掉得越快 ⇒ 光先熄灭');
  assert.ok(R.dissolveAlphaPow >= 2, '线性淡出（幂 1）读起来像关灯，不像"化进水里"');
  assert.ok(R.dissolveExpand > 1, '溶散必须是**散开**（>1），不是缩没');
  assert.ok(R.dissolveLift > 0 && R.dissolveLift < 0.1,
    `上浮量必须看得见又不夸张（归一化 ${R.dissolveLift} ≈ 1080 高的缸上 ${(R.dissolveLift * 1080).toFixed(0)}px）`);
  // 粒子池：**刻意**小于"同帧全部死亡"的最坏需求（24 × 14 = 336），靠环形覆盖保住零分配。
  assert.equal(R.burstPool, 240);
  assert.ok(R.burstPool > R.dissolveParticles, '单只死亡的粒子必须装得下');
  assert.ok(R.burstPool < CONFIG.populationCap.desktop * R.dissolveParticles,
    '池容量必须低于满缸同死的理论最坏值 —— 这是"覆盖最老粒子"而不是"扩容"的那条决定');

  assert.deepEqual([R.sickDim, R.sickDesat, R.mournDim], [0.35, 0.55, 0.72]);
  // sick 是故障、哀悼是情绪（spec §7.7 vs §4.11）：前者必须暗得更狠，但两者都不能暗到看不见。
  assert.ok(R.sickDim < R.mournDim, 'sick 必须比哀悼更暗，否则"这只不对劲"读不出来');
  assert.ok(R.sickDim > 0, '暗到 0 就是把 sick 又藏起来了 —— 正撞在"绝不静默"那条上');
  assert.ok(R.sickDesat > 0 && R.sickDesat < 1, '去饱和是分数，不是绝对饱和度');

  assert.deepEqual([R.eggRadius, R.eggGlowPulse, R.eggFailFadeTime, R.eggFailMinGlow, R.eggRevealAt],
    [12, 0.30, 22, 0.06, 0.60]);
  assert.ok(R.eggFailMinGlow > 0,
    '不可孵化的卵必须留**残光**：彻底消失就又变成一条静默的禁令（spec §4.12 第 6 条要避免的就是它）');
  assert.ok(R.eggRevealAt > 0.5 && R.eggRevealAt < 1,
    '"壳内透出轮廓"只能在孵化**后段**出现（spec §4.11 卵那一格的原话）');
  // 蛋是沉在缸底的世界物体，尺寸走 viewport.scale（spec §3.4-2）。手机短边触底 scale=1.5 时
  // 最小的蛋（eggSize 0.6）直径也得看得见，否则"这缸里有卵"这件事在手机上就没了。
  assert.ok(R.eggRadius * CONFIG.render.scaleMin * 0.6 * 2 >= 12,
    `手机上下限蛋的直径只有 ${(R.eggRadius * CONFIG.render.scaleMin * 0.6 * 2).toFixed(1)}px，太小`);
  assert.ok(R.eggFailFadeTime < CONFIG.stage.egg,
    '熄灭必须比孵化时长快：慢于 60 秒的话玩家看到的是"一枚一直不太亮的卵"，不是一个事件');

  assert.equal(R.foodRadius, 7);
  assert.ok(R.foodRadius * CONFIG.render.scaleMin * 2 * 0.6 >= 8,
    '吃到只剩一点的食物仍然要看得见（看不见＝"它凭空少了"，又是一条静默）');

  assert.deepEqual([R.hopLiftRatio, R.hopLandAt, R.hopSquashMin, R.hopStretchAir], [0.55, 0.72, 0.62, 1.10]);
  assert.ok(R.hopLandAt > 0.5 && R.hopLandAt < 1,
    '落地必须落在 hop 窗口之内，才留得出过冲回弹那一段（否则"过冲"永远播不完）');
  assert.ok(R.hopSquashMin < 1 && R.hopStretchAir > 1, '压扁 <1、拉长 >1（spec §4.7 的两个方向）');
  // 过冲量 = (1 − hopSquashMin) / 4（(1−q)² 包络在 q=0.5 处），必须"一点点"：
  // 弹得比压下去的还多就不再是 Q 弹，是一只橡皮球。
  assert.ok((1 - R.hopSquashMin) / 4 < 1 - R.hopSquashMin, '过冲必须严格小于压扁量');
  // 抬升以**身体半径**为单位：activity=0 时 0.275、activity=1 时 0.825（冲量之比 3 倍）。
  assert.ok(R.hopLiftRatio * CONFIG.hop.impulseBase * 0.5 > 0.2, '跳得太矮等于没跳');
  assert.ok(R.hopLiftRatio * CONFIG.hop.impulseBase * 1.5 < 1, '好动的也不该跳飞出身体直径的距离');

  // ---- B16 新增的颜色（spec §6.2 的三种食物 + §11 的八色蛋）----
  // 语义侧（避开粉色系、在深底上可读、不跟瞳孔撞色、键集与位点对齐）全在
  // tests/render-fx.test.js；这里只钉**色值本身**，因为改一个颜色不会有任何别的地方变红。
  assert.deepEqual([CONFIG.colors.algae, CONFIG.colors.nectar, CONFIG.colors.crystal],
    ['#7FE3B0', '#FFC46B', '#A8D8FF']);
  assert.deepEqual(Object.keys(CONFIG.colors.eggTints), [...CONFIG.eggTint.colors],
    '蛋色子表的键**顺序与集合**都必须与遗传位点那八个名字一致（Object.keys 用插入序，与 colors 同批书写）');
  // 蛋色的**相对明度次序**是这两枚特殊色唯一可机器核对的一半（另外那一半在屏上，进手工清单）：
  // 黑蛋是八色里最暗的、白蛋是最亮的。次序被调乱（比如把 lilac 做成近黑）时这里先红。
  const relLum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  const lumOf = CONFIG.eggTint.colors.map((k) => relLum(CONFIG.colors.eggTints[k]));
  const argExt = (cmp) => lumOf.reduce((best, v, i) => (cmp(v, lumOf[best]) ? i : best), 0);
  assert.equal(CONFIG.eggTint.colors[argExt((a, b) => a < b)], 'black',
    '黑蛋必须仍是八色里最暗的一档（它被抬到对比度下限之上，但不许抬过别的色）');
  assert.equal(CONFIG.eggTint.colors[argExt((a, b) => a > b)], 'white',
    '白蛋必须仍是最亮的一档（否则"白"这个名字就在骗人）');
  assert.ok(Math.max(...lumOf) - Math.min(...lumOf) > 60,
    '八色的明度跨度太窄就是一片同色气球');
  assert.ok(R.tailSegFactor > 0 && R.tailSegFactor <= 1, '单段贴图半径不得超过段长（段与段会糊成一坨）');
  assert.ok(R.tailTaper > 0 && R.tailTaper * (CONFIG.tail.segs - 1) < 1,
    '段间递减到最后一尖必须还有宽度，否则尾尖是 0 半径（drawImage 退化）');
  assert.equal(R.tailLiftFactor > 0, true, '屏幕空间的"高举"量为 0 ⇒ §4.7.1 表里幸福那一档画不出来');
  // 第 7 层碎边的长度**不在这里**：它与 CONFIG.fluff.lenRatio 同源（spec §4.7），
  // 再钉一份就会有两个各自漂移的常数。
  assert.equal(CONFIG.fluff.lenRatio, 0.18, 'spec §4.7 逐字：毛长 = fluff × 0.18 × 身体半径');
  assert.equal(CONFIG.fluff.sprites, 2, 'spec §4.7/§11 FLUFF_SPRITES = 2（常态/炸开）—— 第三张意味着按毛色分档的老路');
});

test('尾巴与眨眼都不许新增基因位点，且 activity 地板两处必须相等', () => {
  // spec §4.7.1 明文"不新增基因（性状已经够多了，加位点要付测试代价）"。
  // 反向确认：真长出 tail/star/blink 位点的话，genes.test.js 的槽位数断言也会红，
  // 但那条只数数量、不看名字 —— 这里补上名字这一半。
  const banned = /tail|star|blink|curl/i;
  assert.ok(!ALL_GENES.some((g) => banned.test(g)), '造型相关的不许成为基因位点');
  assert.equal(CONFIG.tail.swingActivityFloor, CONFIG.blink.activityFloor,
    'spec §4.6：眨眼频率与 §4.7.2 蹦跳同源，都由 activity 驱动 —— 地板分家就是假设分家');
});

test('软体弹簧的二十八个常量齐备，且两端都欠阻尼（spec §4.7 过冲要求的数值前提）', () => {
  const B = CONFIG.body;
  assert.deepEqual(Object.keys(B).sort(), [
    'angerFlatten', 'angerSharpen', 'arousalExpand', 'curiosityElongate', 'dentDecay', 'dentMax',
    'dyingCalm', 'dyingCollapse', 'fearShrink', 'impactEps', 'impactFullDent', 'joyExpand',
    'maxStretchSpeed', 'pulseAmpArousal', 'pulseAmpBase', 'pulseAmpJoy', 'pulseAmpSleepy',
    'pulseRateArousal', 'pulseRateBase', 'pulseRateFloor', 'pulseRateSleepy',
    'sickCalm', 'sleepyCalm', 'stiffnessAtFullWobble', 'stiffnessAtZeroWobble',
    'stretchK', 'zetaAtFullWobble', 'zetaAtZeroWobble',
  ], '软体弹簧的旋钮集，不多不少');
  assert.equal(B.stiffnessAtZeroWobble, 220);
  assert.equal(B.stiffnessAtFullWobble, 80);
  assert.equal(B.zetaAtZeroWobble, 0.70);
  assert.equal(B.zetaAtFullWobble, 0.35);
  // 两端都必须 < 1：spec §4.7"形变必须带过冲回弹"在数值层的前提。
  // 行为那一半在 body.test.js 的过冲测量里，这里守的是"没人把 1.2 写进来"。
  assert.ok(B.zetaAtZeroWobble < 1 && B.zetaAtFullWobble < 1, '过阻尼 = 不过冲 = 违反 §4.7');
  // 过冲量 exp(-πζ/√(1-ζ²))：4.6% → 30.9%，两端差 6.7 倍 —— 这是"挺 / Q"肉眼可辨的数值依据
  const overshoot = (zeta) => Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta));
  assert.ok(overshoot(B.zetaAtZeroWobble) < 0.05);
  assert.ok(overshoot(B.zetaAtFullWobble) > 0.30);
  assert.ok(overshoot(B.zetaAtFullWobble) / overshoot(B.zetaAtZeroWobble) > 6);

  assert.equal(B.stretchK, 0.18);
  assert.equal(B.maxStretchSpeed, 2.5);
  assert.ok(B.maxStretchSpeed > CONFIG.motion.fleeFactor, '上限必须留余量，否则逃命时饱和');

  assert.equal(B.joyExpand, 0.16);
  assert.equal(B.fearShrink, 0.25);
  assert.equal(B.arousalExpand, 0.12);
  assert.equal(B.angerFlatten, 0.22);
  assert.equal(B.angerSharpen, 0.35);
  assert.equal(B.curiosityElongate, 0.20);
  assert.equal(B.sleepyCalm, 0.70);
  assert.ok(B.sleepyCalm > 0 && B.sleepyCalm < 1, 'sleepyCalm 是"压到剩下多少"的系数');

  assert.equal(B.pulseRateBase, 0.9);
  assert.equal(B.pulseRateArousal, 2.6);
  assert.equal(B.pulseRateSleepy, -0.6);
  assert.equal(B.pulseRateFloor, 0.05);
  assert.equal(B.pulseAmpBase, 0.03);
  assert.equal(B.pulseAmpJoy, 0.05);
  assert.equal(B.pulseAmpArousal, 0.09);
  assert.equal(B.pulseAmpSleepy, 0.02);
  assert.ok(B.pulseRateSleepy < 0, 'sleepy 必须把脉率往下推（spec §4.5"慢到几乎停止"）');

  assert.equal(B.sickCalm, 0.15);
  assert.equal(B.dyingCalm, 0.6);
  assert.equal(B.dyingCollapse, 0.55);
  assert.ok(B.sickCalm < B.sleepyCalm, '生病必须比困倦更静止');
  assert.ok(B.dyingCollapse < 1, '溶散塌陷必须是**部分**的：塌到 1 会让半径归零、render 的渐变退化');

  assert.equal(B.impactEps, 0.0012);
  assert.equal(B.impactFullDent, 0.0040);
  assert.equal(B.dentMax, 0.34);
  assert.equal(B.dentDecay, 6.0);
  // 阈值必须高于单步平滑位移（baseSpeed × fixedDt = 0.000917），否则"匀速游动"会被当成一直在撞
  assert.ok(B.impactEps > CONFIG.motion.baseSpeed * CONFIG.fixedDt,
    'impactEps 必须高于匀速单步位移，否则平滑游动会被判成连续冲击');
  assert.ok(B.impactFullDent > B.impactEps);
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

test('「它在看着你」的三个阈值被字面量钉住，且中间地带必须存在', () => {
  // spec §4.6 末段：好感高转过去、好感低转开。写成"有手就盯着"就把这条变成挂机注视，
  // 所以**两个阈值之间必须有一段空隙**（lookAwayAffection < lookTowardAffection）——
  // 空隙是"它根本不在乎"的那档，由 sim.test.js 的"中间地带什么都不动"钉住行为。
  const b = CONFIG.behavior;
  assert.equal(b.lookTowardAffection, 0.2);
  assert.equal(b.lookAwayAffection, 0);
  assert.equal(b.lookRateFactor, 0.35);
  assert.ok(b.lookAwayAffection < b.lookTowardAffection,
    '两阈值相等就没有中间地带了，那时第三档（不动）永远不可达');
  // 速率是 turnRate 的分数：两端（0.5 与 6 rad/s）乘出来的角速度都要落在"一眼"的量级
  assert.ok(b.lookRateFactor > 0 && b.lookRateFactor < 1, 'lookRateFactor 是分数，不是绝对角速度');
  assert.ok(2 * b.lookRateFactor < 1 && 6 * b.lookRateFactor > 0.5,
    '一秒内既不能转不完 90°，也不能快到像瞬移');
});

test('抚摸通道的两个旋钮被字面量钉住，且好感速率与淡忘速率是同一量级', () => {
  // 分工同前：这里钉数值，sim.test.js 钉"贴着才买好感 / 靠近只买熟悉度 / 戳什么都不买"。
  const b = CONFIG.behavior;
  assert.equal(b.petContactRatio, 1.15);
  assert.equal(b.petAffectionRate, 0.06);
  assert.ok(b.petContactRatio > 1 && b.petContactRatio < 1.5,
    '接触半径必须略大于身体半径（擦到毛边就算摸到），但不能大到"隔着一段距离也算贴上来"');
  // 量级关系：摸 10 秒 +0.6，而好感半衰期 34.657s ⇒ 不摸了会很快还回去。
  // 这条断言防的是"把速率调成 6.0"那种让抚摸一次就永久封顶的改法。
  const tenSeconds = 10 * b.petAffectionRate;
  assert.ok(tenSeconds > 0.3 && tenSeconds < 0.9,
    `摸十秒买到的好感应在 (0.3, 0.9)，实测 ${tenSeconds}`);
  const halfLife = Math.log(2) / CONFIG.affectionDecay;
  assert.ok(tenSeconds / halfLife < 0.03,
    '十秒的收获量级必须远小于"半衰期秒数"，否则好感会只进不出、攒成永久封顶');
});
