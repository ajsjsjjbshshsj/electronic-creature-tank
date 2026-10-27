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
  // ⚠️ 47 → 56、48 → 49（2026-10-22 B18）：新增 **CONFIG.audio 一段 + 八张声表子行**
  // （joy / beg / anger / sleepy / hatch / death / thud / chirp = 8 个节点，加本体 1 个 = 9）。
  // 与 B19a 相反，这一次**必须**用子表而不是平铺标量：八行各有 9–13 个同形字段
  // （fromHz / toHz / noteSec / attack / peak / pitchMix …），"每一行形状一样"这件事
  // 只有子表能被逐行比对（tests/config.test.js 的"八行共同形状"那条）。
  // 两个新数还是**用 node 数出来的**，不是估的：
  //   node -e "import('./src/config.js').then(({CONFIG})=>{let n=0;const w=x=>{if(x===null\
  //   ||typeof x!=='object')return;n++;for(const k of Object.keys(x))w(x[k])};w(CONFIG);\
  //   console.log('nodes',n,'keys',Object.keys(CONFIG).length)})"      →  nodes 56 keys 49
  // ⚠️ 56 → 57、49 → 50（2026-10-22 B19b-i）：新增 **CONFIG.api 一段**（一个节点、18 个标量）。
  // 与 B18 的八张声表相反，这一段只需要一个节点：18 个旋钮之间没有"逐键比对"的结构关系
  // （它们各自的两侧取值由 tests/api.test.js 钉行为），而子表会让节点数与顶层键数各加一 ——
  // ⚠️ 57 / 50 **不变**（2026-10-22 B19b-ii）：那一段加了**两个**标量（18 → 19 → 20 项：apiHoldMs、pendingCap）。
  // 标量不是节点，段名也不是新段，所以这两条计数纹丝不动 —— 这个"不动"是**实测**出来的
  // （把上面那行 node -e 的遍历抄过来数一遍），不是按"加标量不影响计数"这条规律推的。
  // 那正是这里要的摩擦：加一段就必须在下面那张段名清单里说清楚。
  // ⚠️ 这一段里**永远不许出现 API key 的值**（spec §7.2 末）：CONFIG 深冻结且提交进仓库，
  //    而 key 只住本机存储。endpoint / model 两个默认值是空字符串，就是这条的形状证据。
  //   node -e "import('./src/config.js').then(({CONFIG})=>{let n=0;const w=x=>{if(x===null\
  //   ||typeof x!=='object')return;n++;for(const k of Object.keys(x))w(x[k])};w(CONFIG);\
  //   console.log('nodes',n,'keys',Object.keys(CONFIG).length)})"      →  nodes 57 keys 50
  // ⚠️ 57 → 58、50 → 51（2026-10-22 Task C-1）：新增 **CONFIG.save 一段**（一个节点、4 个标量：
  //    everySimSec / minIntervalMs / key / corruptKey）。这一段是"存档落地"那四条裁定的数值侧，
  //    两个时间常数各有一条 boot 级用例钉着行为（tests/save.test.js 末段的节奏与下限那两条），
  //    两个键名由 R-2 钉死 —— 键名带版本号，所以 SAVE_VERSION 变了必须同时改这里（那是故意的摩擦）。
  // 数出来的，不是推的：上面那行 node -e 的遍历抄过来跑一遍 →  nodes 58 keys 51
  // ⚠️ 58 → 60、51 → 52（2026-10-23 计划 3 Task 2）：新增 **CONFIG.avatar 一段**（两个节点：
  //    avatar 本身 + avatar.file 那张八行表）。这一段是"HUD 肖像层"的全部真相 ——
  //    行为侧由 tests/avatar.test.js 钉（八张各有生产者、表外名字造不出来、文件名两边不同名），
  //    这里只钉形状。file 那张表**必须**是 8 个键：素材就八张脸，多一个是死条目、少一个是黑图。
  // ⚠️ 60 → 61、52 → 53（2026-10-23 计划 3 Task 3）：新增 **CONFIG.hud 一段**（一个节点、9 个标量）。
  //    其中 tapMaxPx / holdMinMs / minHitPx 三个是 **gestures.js 的唯一真相源** —— Task 1 落地时
  //    它自带一份 DEFAULTS 兜底（那时 CONFIG.hud 还不存在），Task 3 把那份收编了，
  //    于是"两处数字要同步改"这个隐患从结构上消失。行为侧由 tests/gestures.test.js 与
  //    tests/hud.test.js 钉；这里只钉"这一段的形状"。
  // ⚠️ 61 → 63、53 → 54（2026-10-24 拎着玩 Task 1）：新增 **CONFIG.grab 一段**（两个节点：
  //    grab 与其 w 子表；七个键里六个标量 + 一个权重子表）。
  //    事件表的两行（grabbedHappy / grabbedRough）**留到 Task 3** 与生产者同时加 ——
  //    constraints.test.js 那条"每种事件种类都要有生产者"会在只有行没有生产者时红，
  //    这是计划原文的一处顺序错。数字用 node -e 跑出来：Task 1 后 63 / 54，Task 3 加两行后 **65 / 54**。
  // ⚠️ 65 → 66、54 → 55（2026-10-25 手部视觉）：新增 **CONFIG.hand 一段**（一个节点、19 个标量）。
  //    形状与行为分工同 avatar/hud：几何换算由 tests/hand.test.js 钉，绘制账单由
  //    tests/render-hand.test.js 钉；这里只钉"这一段确实存在且没有被悄悄拓宽"。
  // ⚠️ 66 → 67、55 → 56（2026-10-27 伙伴同步）：新增 **CONFIG.social 一段**（一个节点、11 个标量）。
  //    与 grab 同型：旋钮之间没有"逐键比对"的结构关系，所以不需要子表。
  //    行为由 tests/social.test.js（纯层门控）与 tests/sim.test.js（tickSocial 接线）钉。
  assert.equal(visited.length, 67, `CONFIG 的对象/数组节点数变了（现 ${visited.length}）`);
  // 段名同样精确钉住：只有节点数会漏掉"删了一段又加了一段、总数恰好一样"这种巧合。
  assert.deepEqual(Object.keys(CONFIG).sort(), [
    'affectionDecay', 'affectionDecayKin', 'api', 'audio', 'avatar', 'behavior', 'blink', 'body', 'bodyPoints',
    'broody', 'colors', 'dissolveDuration', 'drift', 'dtAccumCap', 'eggFailChanceAtCap', 'eggSize',
    'eggTint', 'eggsPerClutch', 'emotions', 'eye', 'eyeWidthRatio', 'familiarityDecay', 'fixedDt',
    'fluff', 'food', 'foodMax', 'foodRespawnRate', 'glowHueBuckets', 'grab', 'gridCell', 'hand',
    'heard', 'hop', 'hud', 'hueRange', 'initialCreatures', 'maxSize', 'memoryCapacity', 'minSize',
    'mood', 'motion', 'mournDuration', 'mournRadius', 'mutationRate', 'needs', 'particles',
    'perceiveRadius', 'populationCap', 'render', 'save', 'social', 'speech', 'stage', 'star', 'tail',
    'timeScales',
  ], 'CONFIG 顶层键名（56 个，数出来的不是估的）变了 —— 加一项或删一项都要在这里说清楚');
  assert.equal(Object.keys(CONFIG).length, 56);
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
    'CONFIG.audio', 'CONFIG.audio.joy', 'CONFIG.audio.chirp',                     // B18 新增（叫声表与两张增量行）
    'CONFIG.api',                                                                 // B19b-i 新增（可选 API 档的形状与默认值，里面没有 key）
    'CONFIG.save',                                                                // C-1 新增（存档落地的两个常数 + 两个键名）
    'CONFIG.avatar', 'CONFIG.avatar.file',                                        // 计划 3 Task 2 新增（HUD 肖像层：目录 + 那张八行表）
    'CONFIG.hud',                                                                 // 计划 3 Task 3 新增（HUD 的九个常数，其中三个是 gestures.js 的真相源）
    'CONFIG.grab', 'CONFIG.grab.w', 'CONFIG.emotions.eventMagnitude.grabbedRough',  // 拎着玩（Task 1 常数 + Task 3 两张事件行）
    'CONFIG.hand',                                                                // 手部视觉（几何换算与绘制账单分别在 hand/render-hand 测试里）
    'CONFIG.social',                                                              // 伙伴同步（2026-10-27：门控与同步度读数的 11 个旋钮）
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

test('情绪惯性与十个事件冲击都在（mated→laid、rejected 随孤雌删除、ignored 随升级链、grabbed* 随拎着玩）', () => {
  assert.equal(CONFIG.emotions.inertia, 1.6);
  const kinds = Object.keys(CONFIG.emotions.eventMagnitude).sort();
  assert.deepEqual(kinds,
    ['bumped', 'death', 'fed', 'grabbedHappy', 'grabbedRough', 'ignored', 'laid',
     'petted', 'poked', 'startled']);
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
  // 这组数原本逐字取自 spec §11（2026-10-20 那一版）：
  //   STAR_OUTER_RATIO=1.0  STAR_INNER_RATIO=0.62  FLUFF_LEN_RATIO=0.18  FLUFF_SPRITES=2
  //   TAIL_SEGS=3  TAIL_LEN_RATIO=0.5  TAIL_SWING_BASE=1.2  BLINK_INTERVAL_BASE=4.0
  // 其中 STAR_INNER_RATIO 已经在 D-1 里被**量**改了（见下），spec §11 跟着回写。
  assert.deepEqual(Object.keys(CONFIG.star).sort(), ['corners', 'innerRatio', 'outerRatio']);
  assert.equal(CONFIG.star.corners, 5, '五角星的"五"：spec §11 没单列，但 body.js 不许有字面量');
  assert.equal(CONFIG.star.outerRatio, 1.0);
  // 0.62 → 0.71 是**量出来的**（D-1，2026-10-23），不是调出来的：
  // 用户新配的 assets/star_puff_*.png 是这只生物现在的样子。量法两步 ——
  // ① 零依赖解 PNG + 360 条射线二分轮廓半径，② 按 72° 对称化。
  // 只走①会读到 min/max=0.545（睡帽压出来的那条深沟），上一版据此定成 0.55 并加了一个
  // tipPower=3.2 的钝度旋钮，两处都被①的污染带偏；对称化之后凹口是 0.71，
  // 而"钝"这件事由**过渡形状**（smoothstep，见 body.js）免费拿到，不需要旋钮 ⇒ 已删。
  // 这条注释原本那句"改它必须是一次有意识的动作"现在兑现了：有意识，且带着数。
  assert.equal(CONFIG.star.innerRatio, 0.71, '照素材对称轮廓量的凹口深度（逐瓣 0.55–0.80，中位 0.70）');
  assert.ok(CONFIG.star.innerRatio > 0 && CONFIG.star.innerRatio < CONFIG.star.outerRatio,
    '内凹必须严格小于外角，否则"不是星形就是圆"');

  assert.deepEqual(Object.keys(CONFIG.fluff).sort(), [
    'lenRatio', 'petPressAlpha', 'petPressWidth', 'petSpread', 'petTuftAlpha',
    'petTuftLen', 'petTuftWidth', 'sprites',
  ]);
  assert.equal(CONFIG.fluff.lenRatio, 0.18);
  // sprites = 2 是 spec §4.7 那条性能生死线的读数：
  // 只画"毛尖浅色碎边"才只需要 2 张；按"每根毛有自己的颜色"要 32 色相桶 × 8 蓬松档 = 256 张。
  assert.equal(CONFIG.fluff.sprites, 2);
  assert.ok(CONFIG.fluff.petSpread > 0 && CONFIG.fluff.petSpread < Math.PI / 2,
    '局部倒伏扇区必须小于半圈，否则会绕整只一圈');
  assert.ok(CONFIG.fluff.petPressAlpha > 0 && CONFIG.fluff.petPressAlpha <= 1);
  assert.ok(CONFIG.fluff.petTuftAlpha > 0 && CONFIG.fluff.petTuftAlpha <= 1);
  assert.ok(CONFIG.fluff.petTuftLen > 0 && CONFIG.fluff.petTuftWidth > 0);
  assert.ok(CONFIG.fluff.petPressWidth >= 1, '压毛带至少要盖过原来的毛尖宽度');

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

test('眼睛的五十八个旋钮齐备（F-2 加了 fitMargin），且十行表的方向性不等式成立（数值侧守，映射侧由 eyes.test.js 负责）', () => {
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
    'fearLid', 'fearOffset', 'fearPupil', 'fearShrink', 'fitMargin',
    'forward', 'handNearRadius', 'happyLid', 'happyPupil',
    'highlightRadius', 'highlightX', 'highlightY', 'leakGain',
    'lookMax', 'lookTrustMin', 'neutralPupil', 'phaseModulus',
    'pupilMax', 'pupilMin', 'sadHighlightY', 'sadLid',
    'sadLowerLid', 'sadOffset', 'sadPupil', 'sadSpacing',
    'sleepyBlinkStretch', 'sleepyLid', 'spacing', 'starPoints',
    'starScaleMax', 'starSpinMax', 'starSpinPeriod', 'trustAffectionMin',
    'trustBlinkStretch',
  ], '五十八个旋钮，不多不少。⚠️ 这里**没有** sadTopLid 是故意的：spec 逐字"不是上眼睑下垂"');
  // F-2（2026-10-22）加的第 58 个：fitMargin。它是**标量**，所以 §11 那两条全局计数不动。
  assert.ok(Y.fitMargin > 0 && Y.fitMargin < 0.2,
    `fitMargin 必须是正的、且不能大到把两只眼挤到重叠：${Y.fitMargin}`);
  assert.ok(Y.spacing * 2 > (Y.fitMargin + CONFIG.eyeWidthRatio) * 2,
    '基准间距必须还容得下两只眼（fitMargin 收进去之后也不许它们相碰）');

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
  assert.deepEqual([R.tailSegFactor, R.tailTaper, R.tailLiftFactor], [1.5, 0.12, 0.30]);

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
  // ⚠️ 这条原来写的是 `tailSegFactor <= 1`，理由"段与段会糊成一坨"—— 那是**单位滑手**：
  // render.js 里 `segPx = 尾长 × scale × 0.5 / 段数`，也就是**半个节点间距**，所以 factor ≤ 1
  // 真正禁止的是"半径 ≤ 半个间距"，即**两段永远不可能重叠** —— 而尾巴要读成一条恰恰必须重叠。
  // 这条守卫就是 F-tail 那个缺陷的成因（B20 量到三段之间各留一道缝）。
  // 正确的上界是"半径不超过一个完整间距"（否则尾根会粗过它自己的长度，读成一坨）：factor ≤ 2。
  // "必须重叠"这半边不在这里钉 —— 它要用真实节点间距算，归 tests/render-body.test.js 的 F-tail 两条。
  assert.ok(R.tailSegFactor > 0 && R.tailSegFactor <= 2,
    `单段贴图半径不得超过一个节点间距（factor 的上界是 2，不是 1：segPx 是半个间距）：${R.tailSegFactor}`);
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

test('软体弹簧的二十九个常量齐备，且两端都欠阻尼（spec §4.7 过冲要求的数值前提）', () => {
  const B = CONFIG.body;
  assert.deepEqual(Object.keys(B).sort(), [
    'angerFlatten', 'angerSharpen', 'arousalExpand', 'curiosityElongate', 'dentDecay', 'dentMax',
    'dyingCalm', 'dyingCollapse', 'fearShrink', 'impactEps', 'impactFullDent', 'joyExpand',
    'maxStretchSpeed', 'petDentMax', 'pulseAmpArousal', 'pulseAmpBase', 'pulseAmpJoy', 'pulseAmpSleepy',
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
  assert.equal(B.petDentMax, 0.16);
  assert.ok(B.petDentMax < B.dentMax, '抚摸应当比碰撞浅');
  assert.equal(B.dentDecay, 6.0);
  // 阈值必须高于单步平滑位移（baseSpeed × fixedDt = 0.000917），否则"匀速游动"会被当成一直在撞
  assert.ok(B.impactEps > CONFIG.motion.baseSpeed * CONFIG.fixedDt,
    'impactEps 必须高于匀速单步位移，否则平滑游动会被判成连续冲击');
  assert.ok(B.impactFullDent > B.impactEps);
});

// ---- B18（2026-10-22）：叫声表。分工与 eye / render 两组完全一致 ----
// 这里钉**数本身与数之间的排序**（spec §5.4 那张表的逐字数只有这一处能钉），
// "audio.js 有没有照这些数算"由 tests/audio.test.js 负责。只钉一侧会漏：
//   只钉行为 → 把 joy.toHz 从 900 改成 600 时行为断言仍然全绿（它按 CONFIG 比）；
//   只钉数值 → 把音高因子写成常数时数值全对，而"小只高、大只低"那条承诺没了。

test('叫声表的三十六项齐备（28 个调度量 + 8 张声表子行，node 数出来的），且 spec §5.4 逐字那几个数被钉死', () => {
  const W = CONFIG.audio;
  assert.deepEqual(Object.keys(W).sort(), [
    'affectionMin', 'anger', 'beg', 'chirp', 'chirpGapSec', 'cooldownSec', 'death', 'fallbackSampleRate',
    'filterQ', 'filterRatioMax', 'filterRatioMin', 'hatch', 'hueBuckets', 'hueTurn', 'joy',
    'lfoSeedModulus', 'lfoSeedSpread', 'lookaheadSec', 'masterGain', 'maxVoices',
    'noiseBufferSec', 'noiseStepSec', 'overtoneMix', 'overtoneRatioMax', 'overtoneRatioMin',
    'pitchMax', 'pitchMin', 'refSize', 'releaseSec', 'silenceGain', 'sleepy', 'sleepyMin',
    'thud', 'thudGapSec', 'thudPerSec', 'tiredMin',
  ], 'CONFIG.audio 的三十六项键集（node 数出来的），不多不少：28 个调度量 + 八张声表子行');

  // 八行的**共同形状**：少了任何一项都会让某一行听得出差别而测不出来（"短促"变长、"极轻"变响），
  // 所以整行 deepEqual 键集而不是只抽查 fromHz。noise*/lfo* 是可选附加层，允许多出来。
  const CORE = ['attack', 'fromHz', 'gapSec', 'noteSec', 'peak', 'pitchMix', 'reps', 'toHz', 'wave'];
  for (const key of ['joy', 'beg', 'anger', 'sleepy', 'hatch', 'death', 'thud', 'chirp']) {
    const extra = Object.keys(W[key]).filter((k) => !CORE.includes(k));
    assert.deepEqual(Object.keys(W[key]).filter((k) => CORE.includes(k)).sort(), CORE,
      `${key} 那一行缺了核心字段`);
    for (const k of extra) {
      assert.ok(/^(noise|lfo)/.test(k), `${key} 那一行多出一个不认识字段 ${k} —— 只许 noise*/lfo* 这两类附加层`);
    }
  }
  assert.deepEqual(Object.keys(W.beg).filter((k) => /^(noise|lfo)/.test(k)).sort(),
    ['noiseCount', 'noiseDur', 'noiseGap', 'noisePeak'], '卖萌那一行必须带气泡噪声层（spec 逐字）');
  assert.deepEqual(Object.keys(W.hatch).filter((k) => /^(noise|lfo)/.test(k)).sort(),
    ['noiseCount', 'noiseDur', 'noiseGap', 'noisePeak'], '孵化那一行必须带细碎裂声层（spec 逐字）');
  assert.deepEqual(Object.keys(W.anger).filter((k) => /^(noise|lfo)/.test(k)).sort(),
    ['lfoDepthHz', 'lfoRateBase'], '生气那一行必须带"轻微抖动"，而抖动是 LFO 而不是噪声');

  // ---- spec §5.4 表里的逐字数（改它们要先改 spec）----
  assert.deepEqual([W.joy.fromHz, W.joy.toHz, W.joy.reps, W.joy.wave], [600, 900, 2, 'sine'],
    'spec 逐字："咐咐 两声短促上滑正弦，600→900Hz"');
  assert.ok(W.joy.toHz > W.joy.fromHz, '上滑');
  assert.deepEqual([W.beg.fromHz, W.beg.toHz, W.beg.wave], [400, 200, 'triangle'],
    'spec 逐字："啵 快速下滑 400→200Hz + 一点气泡噪声"');
  assert.ok(W.beg.toHz < W.beg.fromHz, '下滑');
  // "低沉咕噜 90–140Hz"：两端都必须落在这个区间里，而这一行是全表最低的一档音区
  assert.ok(W.anger.fromHz >= 90 && W.anger.fromHz <= 140, `anger.fromHz ${W.anger.fromHz} 出界`);
  assert.ok(W.anger.toHz >= 90 && W.anger.toHz <= 140, `anger.toHz ${W.anger.toHz} 出界`);
  assert.ok(W.anger.lfoDepthHz > 0 && W.anger.lfoDepthHz < W.anger.toHz,
    '"轻微"抖动：深度必须远小于基频，否则那是颤音不是呼噜');

  // 三条只有方向没有数的行（spec 逐字："长缓慢下滑，柔和起音" / "极轻的下滑，几乎听不见" /
  // "细碎裂声 + 一个上扬小音"）—— 方向在这里钉成不等式，读起来才不至于全靠 audio.test.js 的相对断言
  assert.ok(W.sleepy.toHz < W.sleepy.fromHz, '困倦必须是下滑');
  assert.ok(W.sleepy.noteSec > W.joy.noteSec * 4, `"长"：${W.sleepy.noteSec} 必须明显长于短促那几行`);
  assert.ok(W.sleepy.attack / W.sleepy.noteSec > 0.2, '"柔和起音"：attack 要占音长的可观一段');
  assert.ok(W.death.toHz < W.death.fromHz, '死亡必须是下滑');
  const peaks = ['joy', 'beg', 'anger', 'sleepy', 'hatch', 'death', 'thud', 'chirp']
    .map((k) => W[k].peak);
  assert.equal(W.death.peak, Math.min(...peaks), '"几乎听不见"：peak 必须是全表最低一档');
  assert.ok(W.hatch.toHz > W.hatch.fromHz, '孵化那记小音是上扬的');
  assert.ok(W.hatch.noiseCount >= 3, '"细致"= 多个短段，不是连续一段噪声');
  for (const k of ['beg', 'hatch']) {
    assert.ok(W[k].noisePeak < W[k].peak, `${k} 的噪声是从属层，不许盖过那一声明本身`);
  }

  // 两条计划 2 增量（spec §5.4.1 第 5 条）：数在这里，**为什么加**在 spec 里
  assert.ok(W.thud.toHz < W.thud.fromHz && W.thud.toHz >= 40, '落地闷响：下滑且不跌进次声');
  assert.equal(W.thud.pitchMix, 0.5, '只有落地这一行打折 —— 它已经贴地，全额乘音高会把大只推出可听范围');
  assert.ok(W.chirp.noteSec < Math.min(W.joy.noteSec, W.beg.noteSec), '「啾」必须是全表最短（spec 逐字"极短"）');

  // 音高随体型：clamp 两端与参考体型
  assert.equal(W.refSize, (CONFIG.minSize + CONFIG.maxSize) / 2,
    '参考体型就是 needs 那段算出来的中性成体（26），表里的 Hz 是给这只定的');
  assert.ok(W.pitchMin < 1 && W.pitchMax > 1, '因子必须横跨 1：小只往上、大只往下');
  assert.ok(W.pitchMax * W.chirp.toHz < 8000, `最高的一记不许推近超声：${W.pitchMax * W.chirp.toHz}Hz`);
  assert.ok(W.pitchMin * W.thud.toHz > 30, '最小的因子也不许把落地声推出可听范围（手机扬声器）');
  // 音色分桶：桶数与 needs 的色相区间必须能整除得开（每桶 ≥ 2° 才谈得上"家族"）
  assert.ok(W.hueBuckets >= 2 && 70 / W.hueBuckets >= 2,
    `每桶只有 ${(70 / W.hueBuckets).toFixed(2)}°，同一家族会被切成两副嗓子`);
  assert.ok(W.filterRatioMin > 1, '低通中心必须在基频之上，否则砍掉的是基频（变成音量而不是音色）');
  assert.ok(W.filterRatioMax > W.filterRatioMin);
  assert.ok(W.overtoneRatioMin > 1 && W.overtoneRatioMax > W.overtoneRatioMin,
    '倍音必须高于基频一个整数量级，两端之间才有"拍频可分辨"的余地');
  assert.ok(W.overtoneRatioMin > 2 && W.overtoneRatioMax < 3,
    '倍音比要留在"略偏的八度"这一带：过 3 就变成五度，那是另一个音程而不是另一种嗓子');
  assert.ok(W.overtoneMix > 0 && W.overtoneMix < 0.5, '倍音是从属共鸣');
  // 上界与节流：这三条是"不许机关枪"与"不许无界增长"的数值前提
  assert.ok(Number.isInteger(W.maxVoices) && W.maxVoices >= 1 && W.maxVoices <= 16,
    `同时发声数必须是个小整数：${W.maxVoices}`);
  assert.ok(W.cooldownSec > 0, '冷却为 0 ⇒ 跨越判据在阈值沿线抖动时会连发');
  assert.ok(W.thudGapSec > 0 && W.thudPerSec > W.thudGapSec,
    '每只的落地间隔必须**大于**全局间隔，否则全局那道闸形同虚设');
  assert.ok(W.masterGain > 0 && W.masterGain < 0.5, 'spec §5.4 逐字"音量很小"');
  assert.ok(W.silenceGain > 0 && W.silenceGain < 0.01, '包络终点的"零"必须非零（exponentialRamp 遇 0 抛）');
  assert.ok(W.lookaheadSec > 0 && W.lookaheadSec < 0.1, '提前量太短会截起音，太长会听出延迟');
  assert.ok(W.releaseSec > 0 && W.releaseSec < W.joy.noteSec, '释音段必须短于最短的那一行');
  assert.ok(W.noiseBufferSec > W.noiseStepSec * 6,
    '共享 buffer 必须盖过最大偏移（noiseCount 上限 6 × step）+ 最长一段，否则后面的段读成静音');
  assert.ok(Number.isInteger(W.lfoSeedModulus) && W.lfoSeedModulus >= 2, '抖动速率的个体差靠这个取模');
  assert.ok(W.lfoSeedSpread > 0 && W.lfoSeedSpread * W.lfoSeedModulus < 1,
    '抖动速率的偏移之和必须小于一倍，否则两只"生气"呼噜得完全不像同一声明');
  // 检测阈值：三条自己的（另两条读 CONFIG.mood，唯一定义点，不许在这里重抄）
  assert.ok(W.sleepyMin > 0 && W.sleepyMin < 1 && W.tiredMin > 0 && W.tiredMin < 1, '都是 [0,1] 的分量');
  assert.ok(W.affectionMin > CONFIG.behavior.lookTowardAffection,
    '撒娇那一声的门槛必须高于"它开始看你"，否则陌生人也一直在撒娇');
  assert.equal(W.joyMin, undefined, 'joy 的阈值只许有 CONFIG.mood.happyJoyMin 一处定义');
  assert.equal(W.angerMin, undefined, 'anger 同上（CONFIG.mood.angerMin）');
});

// ---- B19b-i（2026-10-22）：可选 API 档。分工与上面各组一致 ----
// 这里钉**数与数之间的上界关系**，"api.js 有没有照这些数算"由 tests/api.test.js 钉。
// 这一段最特殊的一条要求是**它不该有内容的地方必须真的空着**：endpoint / model 是空串，
// 而 key 连一个字段都没有（spec §7.2 末：key 绝不进共享存档；CONFIG 又是提交进仓库的）。

test('可选 API 档的二十项旋钮（node 数出来的）：默认关闭、没有存放 key 的位置、两侧上界自洽', () => {
  const A = CONFIG.api;
  assert.deepEqual(Object.keys(A).sort(), [
    'apiHoldMs', 'enabled', 'endpoint', 'maxInFlight', 'maxTokensOut', 'maxTokensOutCap', 'model',
    'nameMaxChars', 'pendingCap', 'personaLines', 'suggestionMaxChars', 'summaryHeardTop',
    'summaryMaxChars', 'summaryNeedTop', 'temperature', 'temperatureMax', 'textMaxChars',
    'timeoutMaxMs', 'timeoutMs', 'wordMaxChars',
  ], 'CONFIG.api 的二十项键集（node 数出来的）变了 —— 加一项删一项都要在这里说清楚');
  assert.equal(Object.keys(A).length, 20);
  // ⚠️ 18 → 19 → 20（2026-10-22 B19b-ii）：加的两个都是**标量**（apiHoldMs、pendingCap），不是子表，
  // 所以上面那两条全局计数（节点 57 / 顶层键 50）都不动 —— 实测过，不是推断。

  // 默认关闭：spec §4.13.2 标题逐字「默认关闭」。与文字层那条刻意相反 ——
  // 文字层默认开（不联网也完整运行），API 档默认关（填了才引入网络依赖，spec §2 那行）。
  assert.equal(A.enabled, false);
  assert.equal(CONFIG.speech.enabled, true);

  // **这一段里不许有能装 key 的东西**：任何字符串字段都必须是空串。
  // 这条比"键名里不许出现 key"更硬 —— 后者挡不住有人加一个 `apiKey: ''` 或者
  // 把真端点连 token 一起提交进来（那是泄露，不是降级，spec §7.2 末第 4 条）。
  for (const [k, v] of Object.entries(A)) {
    if (typeof v === 'string') {
      assert.equal(v, '', `CONFIG.api.${k} 是非空字符串：端点与 key 都只能由调用方在本机填`);
    } else {
      assert.ok(typeof v === 'number' || typeof v === 'boolean',
        `CONFIG.api.${k} 必须是标量（这一段是形状表，不是状态表）`);
    }
  }

  assert.equal(A.timeoutMs, 4000);
  assert.equal(A.timeoutMaxMs, 15000);
  assert.deepEqual([A.maxTokensOut, A.maxTokensOutCap], [24, 64]);
  assert.deepEqual([A.temperature, A.temperatureMax], [0.7, 2]);
  assert.equal(A.maxInFlight, 2);
  assert.equal(A.textMaxChars, 40);
  assert.deepEqual([A.summaryNeedTop, A.summaryHeardTop, A.personaLines], [2, 3, 3]);
  assert.deepEqual([A.nameMaxChars, A.wordMaxChars, A.suggestionMaxChars], [12, 8, 48]);
  assert.equal(A.summaryMaxChars, 420);

  // 上界关系：cfg 能覆盖的那三个都必须被夹住，否则"cfg 越界 ⇒ null"那条测试无从谈起
  assert.ok(A.timeoutMs > 0 && A.timeoutMs <= A.timeoutMaxMs, '默认超时必须落在自己给的上界内');
  assert.ok(A.maxTokensOut >= 1 && A.maxTokensOut <= A.maxTokensOutCap);
  assert.ok(A.temperature >= 0 && A.temperature <= A.temperatureMax);
  assert.ok(Number.isInteger(A.maxInFlight) && A.maxInFlight >= 1
    && A.maxInFlight <= CONFIG.speech.onscreenMax,
    `在途请求数不该超过同屏气泡上限（${CONFIG.speech.onscreenMax}）：否则回复会比能显示的多出一截排队`);
  // max_tokens 必须够写一句 2–5 个词，又不许够写一段散文（spec §4.13.1 的句式纪律）
  assert.ok(A.maxTokensOutCap > CONFIG.speech.maxTokens * 4,
    '上限太紧会让合法的短句被服务端截断 —— 截断的回复比拒绝更难查');
  assert.ok(A.maxTokensOutCap < 200, '上限松到能写一段话，"最多 2 行"就只剩校验在挡');
  // 摘要条数不许越过来源的条数（四条匮乏度 / 性格九项）
  assert.ok(A.summaryNeedTop >= 1 && A.summaryNeedTop <= NEED_KEYS.length,
    `summaryNeedTop 不能超过 NEED_KEYS 的 ${NEED_KEYS.length} 条`);
  assert.ok(A.personaLines >= 1 && A.personaLines <= 9, '性格九项（spec §4.9 那张表）');
  // 字符侧的两道闸必须互相容得下合法短句：五个词最窄也要 5×2 字 + 4 个空格
  assert.ok(A.textMaxChars >= CONFIG.speech.maxTokens * 2 + (CONFIG.speech.maxTokens - 1),
    'textMaxChars 比合法最短一句还窄 ⇒ 校验会把一切都拒成 too-long');
  assert.ok(A.nameMaxChars >= 2 && A.wordMaxChars >= 2 && A.suggestionMaxChars >= 2,
    '夹到 1 个字符等于把那一格删掉，模型会以为它没有');
  // 逐格上界之和必须落在总预算里（tests/api.test.js 钉的是它的行为侧：尾部字段没被裁掉）
  assert.ok(A.summaryMaxChars > A.nameMaxChars + A.wordMaxChars + A.suggestionMaxChars
    + A.summaryHeardTop * A.wordMaxChars, '总预算比逐格上界之和还小 ⇒ 必填字段会被裁掉');

  // ---- B19b-ii（2026-10-22）新增的那一个旋钮：一句话最多被按多久 ----
  // 它是这一档**唯一的代价**，所以两侧都得有闸：
  //   · 上限 1200ms 是"玩家还看得见这只在说话"与"别把缸打成延迟一截的哑剧"之间的折中；
  //   · **严格小于** bubbleTtl×1000 是显示纪律（spec §4.13.1「3 秒淡出」）：按到比整条气泡
  //     的命还久，那句话一出场就该开始淡出了，等于把它按住到看不见 —— 而那仍然是"取消"，
  //     不是"延后"。一个能被填成破坏显示纪律的值的旋钮，必须有一条写着它不许那样的闸。
  assert.equal(A.apiHoldMs, 1200);
  assert.ok(Number.isInteger(A.apiHoldMs) && A.apiHoldMs > 0, 'apiHoldMs 必须是正整数毫秒');
  assert.ok(A.apiHoldMs <= 1200, `apiHoldMs 越过了 1200 毫秒的天花板：${A.apiHoldMs}`);
  assert.ok(A.apiHoldMs < CONFIG.speech.bubbleTtl * 1000,
    `apiHoldMs(${A.apiHoldMs}) 必须严格小于 bubbleTtl×1000(${CONFIG.speech.bubbleTtl * 1000})`);
  // 与请求预算的关系不是等式而是** min()**：接线层按住的那一拍到期时就把请求掐掉，
  // 所以默认值下（timeoutMs 4000 > apiHoldMs 1200）"迟到的回复"是常态而不是边缘情况 ——
  // 这条由 tests/api.test.js 的 boot 级用例钉住行为侧，这里只钉"两个数各是什么"。
  assert.ok(A.timeoutMs !== A.apiHoldMs, '请求预算与按住时长是两件事，不许合成一个数');

  // pendingCap：暂存队列的槽位数。它是 main.js 那个接线层的**唯一**内存上界，
  // 所以必须自己成立，不许借绘制层的 bubblePoolCapacity()（那是"屏幕上能挂几条"，不是"按着几拍"）。
  // 下界由 maxInFlight 决定：在途的每一个都必须有自己的槽位，否则刚发出去就被顶掉，
  // 症状是"开了这一档反而几乎换不到词"，而且不报错。
  assert.equal(A.pendingCap, 8);
  assert.ok(Number.isInteger(A.pendingCap) && A.pendingCap > 0, 'pendingCap 必须是正整数');
  assert.ok(A.pendingCap >= A.maxInFlight,
    `pendingCap(${A.pendingCap}) 至少装得下 maxInFlight(${A.maxInFlight}) 个在途请求，否则发出去就被顶掉`);
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

// ---- C-1（2026-10-22）：存档落地（spec §7.2.1）。分工同前：
// 这里钉**数与数之间的关系**，"main.js 有没有照这些数落盘"由 tests/save.test.js 末段那组
// boot 级用例钉。这一段最容易做错的是那两个**键名**：它们带版本号，而版本号的含义就是
// "格式变了就别再读旧的那一个" —— 键名与 SAVE_VERSION 脱钩等于把两代存档搅在一起。

test('存档落地的四项常数：节奏用模拟秒、下限严格低于最坏节奏、两个键名各住一处且都带版本号', () => {
  const S = CONFIG.save;
  assert.deepEqual(Object.keys(S).sort(), ['corruptKey', 'everySimSec', 'key', 'minIntervalMs'],
    'CONFIG.save 的键集（node 数出来的）变了 —— 加一项删一项都要在这里说清楚');
  // 键名：两个都在**同一个命名空间**里，且都带 v2 那个后缀（裁定 R-2）。
  // ⚠️ 断言里写的是字面量而不是模板串：拼出来就测不到"有人把版本号从名字里删掉"这件事。
  assert.equal(S.key, 'tank.save.v2');
  assert.equal(S.corruptKey, 'tank.save.v2.corrupt');
  assert.notEqual(S.key, S.corruptKey, '主键与隔离区共用一个键 ⇒ 隔离这一步本身就是那次覆盖');
  assert.ok(S.key.includes('.v2'), '键名里没有版本号：SAVE_VERSION 改了旧档还会被当新档读');
  assert.ok(S.corruptKey.startsWith(S.key), '隔离区必须留在同一个前缀下，否则"清掉这一缸"清不干净');
  // 与 API 档那把 key **必须**是两个键（R-2 的后半句：那一份永不进存档）。
  assert.notEqual(S.key, 'tank.api.v1');

  // 落盘节奏：**模拟秒**（裁定 R-3）。取 30 的依据写在 config.js 那段注释里（实测数在 §7.2.1 R-4）。
  assert.equal(S.everySimSec, 30);
  assert.ok(Number.isFinite(S.everySimSec) && S.everySimSec > 0, 'everySimSec 必须是正数模拟秒');
  // 一条上界关系：一次落盘之间至少要走完 200 个子步，否则"每写一次 = 一次 160KB 同步写"
  // 就会被摊到肉眼可见的频率上（fixedDt 是 1/60，所以 30 秒 = 1800 步）。
  assert.ok(S.everySimSec / CONFIG.fixedDt >= 200,
    `每 ${S.everySimSec} 模拟秒只落 ${S.everySimSec / CONFIG.fixedDt} 次盘都算不上"几次一写"，节奏太密`);

  // 墙上时钟下限（裁定 R-4）：它兜的是事件那两条路（连点标签页会连着发 visibilitychange）。
  assert.equal(S.minIntervalMs, 2000);
  assert.ok(S.minIntervalMs > 0, '下限必须是正毫秒');
  // ⚠️ 这条是**关系**断言，也是这一段唯一会拦住调参的：
  // 下限若高到"4× 倍速下 30 模拟秒都等不齐一次写"，计划内的落盘就会被它挤掉，
  // 于是存档密度反过来受节流控制 —— 那与 R-3 把节奏定成模拟秒的意图正相反。
  const fastestWallMs = (S.everySimSec / Math.max(...CONFIG.timeScales)) * 1000;
  assert.ok(S.minIntervalMs < fastestWallMs,
    `minIntervalMs(${S.minIntervalMs}) 必须严格小于最快倍速下的自然节奏(${fastestWallMs}ms)，否则节流会吃掉计划内的落盘`);
});

// ---------------------------------------------------------------- 拎着玩（grab & carry）
// 这一段是 2026-10-24 计划的 Task 1。两条判据里只有形状那条是钉数的，
// 另一条是**关系判据** —— 它拦的不是"谁改了数值"，而是"把两个手感旋钮调到互相打架"。
// 事件表那两行（grabbedHappy / grabbedRough）**不在这里**：
// tests/constraints.test.js 有一条"每种情绪事件种类都必须有生产者"，
// 所以加行必须与 Task 3 的生产者同一个提交落地，否则那一轮收尾不绿。
// 这是计划本身的一处顺序错，见 plans/2026-10-24-grab-and-carry.md 的执行日志。
test('CONFIG.grab 一段的形状（八个键：七个标量 + 一个三项权重子表）', () => {
  assert.deepEqual(Object.keys(CONFIG.grab).sort(),
    ['affectionRate', 'familiarityRate', 'feedAffection', 'followStiffness', 'pullOutRatio',
     'shakePerSecond', 'shakeSpeedFloor', 'w'],
    `CONFIG.grab 键集变了：${Object.keys(CONFIG.grab).sort()}`);
  assert.deepEqual(Object.keys(CONFIG.grab.w).sort(), ['affection', 'clingy', 'irritable']);
  for (const [k, v] of Object.entries(CONFIG.grab)) {
    if (k === 'w') continue;
    assert.ok(Number.isFinite(v) && v > 0, `${k} 必须是正数，实为 ${v}`);
  }
});

// ---------------------------------------------------------------- 玩家的手（2026-10-25）
// 形状由 hand.js 的 handPoseInto 消费；这里钉键集与几条互相打架会立刻出症状的关系。
test('CONFIG.hand 的十九个视觉旋钮齐备，摸头朝向、尺寸与手指分离自洽', () => {
  const H = CONFIG.hand;
  assert.deepEqual(Object.keys(H).sort(), [
    'alpha', 'contactAlpha', 'contactLineWidth', 'contactPulseRate', 'contactRadius',
    'fingerDrop', 'fingerRadius', 'fingerSpread', 'maxPx', 'minPx', 'offsetX', 'offsetY',
    'palmHeight', 'palmRadius', 'palmWidth', 'rockAngle', 'rockRate', 'strokeWidth',
    'viewportRatio',
  ], `CONFIG.hand 键集变了：${Object.keys(H).sort()}`);
  assert.equal(Object.keys(H).length, 19);
  for (const [k, v] of Object.entries(H)) {
    assert.ok(Number.isFinite(v), `${k} 必须是有限数，实为 ${v}`);
    if (k === 'offsetY') assert.ok(v < 0, '掌心必须在接触点上方（摸头），offsetY 必须为负');
    else assert.ok(v > 0, `${k} 必须是正数，实为 ${v}`);
  }
  assert.deepEqual([H.minPx, H.maxPx, H.viewportRatio], [40, 56, 0.07],
    '手要比上一版小一号；40–56 是布局尺度');
  assert.ok(H.minPx < H.maxPx, `最小手掌 ${H.minPx} 必须小于上限 ${H.maxPx}`);
  assert.ok(H.alpha <= 1 && H.contactAlpha <= 1, '透明度不许越过 1');
  assert.ok(H.contactAlpha < H.alpha, '接触光必须比手本体更淡，否则会喧宾夺主');
  assert.ok(H.rockAngle > 0 && H.rockAngle < 0.5, '抚摸摆动必须看得见又不至于把手甩飞');
  assert.ok(H.palmWidth > H.fingerRadius && H.palmHeight > H.fingerRadius,
    '掌心必须比手指粗，否则读出来是一把折扇');
  assert.ok(H.palmRadius >= H.palmWidth && H.palmRadius >= H.palmHeight,
    '镜像边界用的掌缘必须覆盖掌心椭圆的半宽半高，否则掌会先出屏再翻');
  // 第一版"胡萝卜"的数值根源：相邻指端中心距 0.147×size，小于胶囊外径 0.19×size。
  // 最小尺寸下相邻指端中心距 = fingerSpread/3 × minPx；外径 = 2×r + 2×strokeWidth。
  const tipGap = (H.fingerSpread / 3) * H.minPx;
  const capsuleOuter = 2 * (H.fingerRadius * H.minPx + H.strokeWidth);
  assert.ok(tipGap > capsuleOuter,
    `最小手掌上四指仍会粘连：指端间距 ${tipGap} ≤ 胶囊外径 ${capsuleOuter}`);
  assert.ok(H.contactLineWidth < H.minPx * 0.1, '接触光描边要细，不能用手指的线宽');
  assert.ok(H.contactPulseRate > H.rockRate * 1.2,
    '接触圈必须比手腕摆得更快、错开相位，否则两个动作糊成一个');
  assert.match(CONFIG.colors.handSkin, /^#[0-9a-f]{6}$/i);
  assert.match(CONFIG.colors.handShade, /^#[0-9a-f]{6}$/i);
  assert.notEqual(CONFIG.colors.handSkin, CONFIG.colors.sakura,
    '手必须换成人手的肉色，不再借用星绒绒的樱花粉');
});

// 越界阈值必须严格大于抚摸接触阈值，否则"拎"与"摸"同时为真，Task 3 的让路规则白写。
test('pullOutRatio 必须严格大于 petContactRatio —— 否则摸与拎重叠', () => {
  assert.ok(CONFIG.grab.pullOutRatio > CONFIG.behavior.petContactRatio,
    `重叠了：pullOutRatio ${CONFIG.grab.pullOutRatio} ≤ petContactRatio ${CONFIG.behavior.petContactRatio}`);
});

// R-3 的机器形式之一：被拎起来不许比被戳一下更疼。
// 逐项比绝对值而不是比总和 —— 总和相同而方向调换（fear 换成 joy）也能骗过总数比较。
test('grabbedRough 不许比 poked 更疼（逐项对比绝对值）', () => {
  const rough = CONFIG.emotions.eventMagnitude.grabbedRough;
  const poked = CONFIG.emotions.eventMagnitude.poked;
  for (const [k, v] of Object.entries(rough)) {
    assert.ok(Math.abs(v) <= Math.abs(poked[k] ?? 0) + 1e-12,
      `${k}：被拎 ${v} 比被戳 ${poked[k]} 还狠，那没人敢碰娃娃了`);
  }
});

// 两行必须成对：applyEvent 对每一项乘同一个 scale，
// 少一行就等于"被拎起来只有一种方向"，R-2（性格 × 好感）当场失效。
test('grabbedHappy 与 grabbedRough 必须成对存在，且符号方向相反', () => {
  const happy = CONFIG.emotions.eventMagnitude.grabbedHappy;
  const rough = CONFIG.emotions.eventMagnitude.grabbedRough;
  assert.ok(happy.joy > 0, '享受那一行该升 joy');
  assert.ok(rough.joy < 0, '抗拒那一行该降 joy —— 两行同号就等于只有一行');
  assert.ok(rough.anger > 0 && rough.fear > 0);
});
