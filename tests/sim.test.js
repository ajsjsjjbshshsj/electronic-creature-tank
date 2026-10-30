import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import {
  PLAYER_ID, affectionFor, familiarityFor, get, ensure, KINSHIP,
  adjust as adjustMemory, companionOf,
} from '../src/memory.js';
import { createCreature, sizeOf } from '../src/creature.js';
import { ALL_GENES, randomGenome } from '../src/genes.js';
import { MOODS } from '../src/emotions.js';
import { WORD_POOL } from '../src/lexicon.js';
import { hear } from '../src/heard.js';
import { layEggs } from '../src/breeding.js';
import { MIN_DURATION, EAT_HUNGER } from '../src/behavior.js';
import { serialize, migrate } from '../src/save.js';
import { thresholds } from '../src/personality.js';
import { familyModelFor } from '../src/family.js';
import { relationRowsFor } from '../src/hud.js';
import {
  createWorld, tickWorld, perceive, addCreature, spawnFood, aliveCreatures, worldStats,
  restoreWorld,
} from '../src/sim.js';

const step = (world, seconds, dt = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) tickWorld(world, dt);
};

test('createWorld 生成 CONFIG.initialCreatures 只亚成体（spec 9.1）', () => {
  const w = createWorld({ seed: 1 });
  assert.equal(aliveCreatures(w).length, CONFIG.initialCreatures);
  for (const c of aliveCreatures(w)) {
    assert.equal(c.stage, 'juvenile', '初始个体应是亚成体，好让玩家几分钟内看到求偶');
    assert.equal(c.alive, true);
  }
});

test('初始个体色相都在粉色区间', () => {
  const w = createWorld({ seed: 2 });
  for (const c of aliveCreatures(w)) {
    assert.ok(c.traits.hue >= 315 || c.traits.hue <= 25, `色相越界: ${c.traits.hue}`);
  }
});

test('初始个体位置都在缸内', () => {
  const w = createWorld({ seed: 3 });
  for (const c of aliveCreatures(w)) {
    assert.ok(c.pos.x >= 0 && c.pos.x <= 1, `x 越界: ${c.pos.x}`);
    assert.ok(c.pos.y >= 0 && c.pos.y <= 1, `y 越界: ${c.pos.y}`);
  }
});

test('初始个体 id 互不重复', () => {
  const w = createWorld({ seed: 4 });
  const ids = w.creatures.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('初始个体性格各异（不是克隆）', () => {
  const w = createWorld({ seed: 5 });
  const bolds = aliveCreatures(w).map((c) => c.traits.personality.bold);
  assert.ok(new Set(bolds.map((b) => b.toFixed(3))).size > 1, '初始个体应有性格差异');
});

test('新缸带有初始光藻', () => {
  const w = createWorld({ seed: 6 });
  assert.ok(w.foods.length > 0, '新缸应有食物，否则初始个体会立刻饿死');
  assert.ok(w.foods.every((f) => f.kind === 'algae'));
});

test('populationCap 可被覆盖（手机 16 / 桌面 24）', () => {
  assert.equal(createWorld({ seed: 7, populationCap: 16 }).populationCap, 16);
  assert.equal(createWorld({ seed: 7 }).populationCap, CONFIG.populationCap.desktop);
});

test('Task 10 追加的四组常量被字面量钉住（config.test.js 没有覆盖它们）', () => {
  // 这四组是 Task 10 才加进 config.js 的，而 tests/config.test.js 的 spec §11 断言里
  // 一条都没提到它们 —— 于是 `mournDuration: 6` 改成 0.6、`dissolveDuration: 4`
  // 改成 40 都不会有任何测试变红。哀悼与溶散是**只由这两个数字决定**的可观察行为，
  // 所以它们的量级必须钉在某个测试里。
  assert.equal(CONFIG.mournDuration, 6);
  assert.equal(CONFIG.dissolveDuration, 4);

  assert.equal(CONFIG.motion.baseSpeed, 0.055);
  assert.deepEqual({ ...CONFIG.motion.stageFactor },
    { hatchling: 0.45, juvenile: 0.85, adult: 1, elder: 0.55 });
  assert.equal(CONFIG.motion.fleeFactor, 2.2);
  assert.equal(CONFIG.motion.facingLerp, 6);
  assert.equal(CONFIG.motion.wallMargin, 0.03);
  // 逃命必须是加速（倍率 > 1），否则"逃"这个意图在表现上等于没有
  assert.ok(CONFIG.motion.fleeFactor > 1, 'fleeFactor 是加速倍率，必须大于 1');
  // （原 courtshipFactor < 1 那条随求偶制删除：没有仪式，就没有"靠近时放慢"这件事。）

  assert.equal(CONFIG.food.algae.energy, 0.45);
  assert.equal(CONFIG.food.nectar.energy, 0.85);
  assert.equal(CONFIG.food.crystal.energy, 0.15);
  assert.equal(CONFIG.food.algae.respawn, true);
  assert.equal(CONFIG.food.nectar.respawn, false);
  assert.equal(CONFIG.food.crystal.respawn, false);
  assert.equal(CONFIG.food.crystal.calms, 0.5);
  assert.ok(CONFIG.food.nectar.energy > CONFIG.food.algae.energy,
    '蜜珠是高能量食物，必须比光藻更顶饿');
  assert.ok(CONFIG.food.algae.energy > CONFIG.food.crystal.energy,
    '冰晶是安抚用的低能量食物');
});

test('同种子下 tick 完全可复现（Global Constraints 的硬性要求）', () => {
  const run = (seed) => {
    const w = createWorld({ seed });
    step(w, 60);
    return JSON.stringify({
      creatures: w.creatures.map((c) => ({
        id: c.id, age: +c.age.toFixed(4), stage: c.stage,
        x: +c.pos.x.toFixed(5), y: +c.pos.y.toFixed(5),
        hunger: +c.needs.hunger.toFixed(5), joy: +c.emotions.joy.toFixed(5),
      })),
      stats: w.stats,
      foods: w.foods.length,
    });
  };
  assert.equal(run(42), run(42), '同种子两次运行必须逐位相同');
  assert.notEqual(run(42), run(43), '不同种子应产生不同世界');
});

test('world.time 随 tick 推进且与步长无关', () => {
  const a = createWorld({ seed: 8 });
  const b = createWorld({ seed: 8 });
  step(a, 10, 1 / 60);
  step(b, 10, 1 / 30);
  assert.ok(Math.abs(a.time - b.time) < 1e-6, `${a.time} vs ${b.time}`);
  assert.ok(Math.abs(a.time - 10) < 0.05);
});

test('生物永远不会游出缸外', () => {
  const w = createWorld({ seed: 9 });
  for (let i = 0; i < 300 * 60; i++) {
    tickWorld(w, 1 / 60);
    for (const c of w.creatures) {
      assert.ok(c.pos.x >= 0 && c.pos.x <= 1, `x 越界: ${c.pos.x}`);
      assert.ok(c.pos.y >= 0 && c.pos.y <= 1, `y 越界: ${c.pos.y}`);
    }
  }
});

test('facing 始终是单位向量（即使撞墙或急转）', () => {
  const w = createWorld({ seed: 10 });
  step(w, 120);
  for (const c of w.creatures) {
    const len = Math.hypot(c.facing.x, c.facing.y);
    assert.ok(Math.abs(len - 1) < 1e-6, `facing 长度 = ${len}`);
  }
});

test('spawnFood 拒绝未知食物种类（原型键不得被静默当成合法食物）', () => {
  // 守的是 `CONFIG.food[kind]` 这个字符串查表：CONFIG.food 是朴素对象字面量，
  // 'toString' / 'constructor' 经原型链解析成 truthy 的函数，于是
  // `if (!CONFIG.food[kind])` 拦不住它们，而 `.energy` 得到 undefined。
  // ⚠️ 实测：那**不会**变成 NaN 饥饿 —— needs.feed 的形参有默认值
  // （amount = CONFIG.needs.feedAmount = 0.45），undefined 会落回默认份量：
  // 让饥饿 0.9153 的生物吃掉 kind = 'toString' 的食物，实测饥饿 = 0.4653。
  // 真实后果是静默喂错份量，外加 eat 事件把原型键名当 foodKind 送给表现层。
  // 与 emotions.applyEvent 拒绝 'toString' 是同一类纪律：未知输入必须抛错。
  const w = createWorld({ seed: 40, initialCreatures: 0 });
  // createWorld 会先投放 12 份初始光藻（否则新缸一开局就闹饥荒），
  // 所以这里必须先腾空，否则下面"抛错后不应留下任何食物"数到的是那 12 份。
  w.foods.length = 0;
  for (const bad of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'meat', '', null]) {
    assert.throws(() => spawnFood(w, bad, { x: 0.5, y: 0.5 }), TypeError,
      `食物种类 ${String(bad)} 必须抛错，不能静默接受`);
  }
  assert.equal(w.foods.length, 0, '抛错后不应留下任何食物');
  // 反面：三种合法食物都必须被接受（别把校验写得太严）
  for (const kind of ['algae', 'nectar', 'crystal']) {
    assert.doesNotThrow(() => spawnFood(w, kind, { x: 0.5, y: 0.5 }), `${kind} 是合法的`);
  }
  assert.equal(w.foods.length, 3);
  assert.deepEqual(w.foods.map((f) => f.kind), ['algae', 'nectar', 'crystal']);
});

test('跑完模拟后每条 needs / emotions 都是有限数，且在 [0,1]', () => {
  // ⚠️ 这条是交接要求第 1 条，原先**缺失**（本节测试块里连一次 Number.isFinite 都没有）。
  // 为什么必须有：`clamp01` 写成 `v < 0 ? 0 : v > 1 ? 1 : v` 会**原样放过 NaN**
  // （两个比较对 NaN 都是 false），而 `mostUrgent()` 与 `dominant()` 的 `>` 比较
  // 对 NaN 也恒为 false —— 于是一个 NaN 分量会在需求紧迫度与情绪表现里
  // **静默失去发言权，全程不报错**。
  // 只断言 [0,1] 抓不到它：`NaN >= 0` 与 `NaN <= 1` 都为假，所以 NaN 会被
  // 误报成"越界"，诊断信息就丢了 —— 所以**有限性断言必须放在范围断言之前**。
  // 位置同样重要：放在一段模拟**跑完之后**，绝不放进 60Hz × 24 只生物的热路径。
  const w = createWorld({ seed: 11 });
  step(w, 300);
  for (const c of w.creatures) {
    for (const [k, v] of Object.entries(c.needs)) {
      assert.ok(Number.isFinite(v), `needs.${k} = ${v}（非有限数：clamp01 不会拦住 NaN）`);
      assert.ok(v >= 0 && v <= 1, `needs.${k} = ${v}`);
    }
    for (const [k, v] of Object.entries(c.emotions)) {
      assert.ok(Number.isFinite(v), `emotions.${k} = ${v}（非有限数：clamp01 不会拦住 NaN）`);
      assert.ok(v >= 0 && v <= 1, `emotions.${k} = ${v}`);
    }
  }
  // 防空转：跑完之后确实还有活着的个体可查，否则上面两个循环什么都没检查
  assert.ok(w.creatures.length > 0, '防空转：这一步之后应当还有个体');
});

test('记忆条目数不超过容量上限', () => {
  const w = createWorld({ seed: 12, initialCreatures: 20, populationCap: 24 });
  step(w, 200);
  for (const c of w.creatures) {
    assert.ok(c.memory.entries.length <= CONFIG.memoryCapacity,
      `${c.id} 记忆溢出: ${c.memory.entries.length}`);
  }
});

// ---------- 感知与空间网格 ----------

test('perceive 只返回感知半径内的邻居', () => {
  const w = createWorld({ seed: 13, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.1, y: 0.1, age: 600, rng: createRng(1) });
  const near = createCreature({ id: 'near', name: 'N', x: 0.15, y: 0.1, age: 600, rng: createRng(2) });
  const far = createCreature({ id: 'far', name: 'F', x: 0.95, y: 0.95, age: 600, rng: createRng(3) });
  for (const c of [a, near, far]) addCreature(w, c);
  const senses = perceive(w, a);
  const ids = senses.neighbors.map((n) => n.id);
  assert.ok(ids.includes('near'), '近邻应被感知');
  assert.ok(!ids.includes('far'), '远处的不该被感知');
  assert.ok(!ids.includes('a'), '不该把自己算作邻居');
});

test('perceive 的 neighbors 按距离升序', () => {
  const w = createWorld({ seed: 14, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, a);
  for (const [id, d] of [['n3', 0.2], ['n1', 0.05], ['n2', 0.12]]) {
    addCreature(w, createCreature({ id, name: id, x: 0.5 + d, y: 0.5, age: 600, rng: createRng(2) }));
  }
  const dists = perceive(w, a).neighbors.map((n) => n.dist);
  for (let i = 1; i < dists.length; i++) assert.ok(dists[i] >= dists[i - 1], `未排序: ${dists}`);
});

test('perceive 的并列距离按 id 字典序裁决（不取决于网格扫描顺序与插入顺序）', () => {
  // 网格按 cx 升序、再按 cy 升序扫描，所以**先被扫描到**的那只在不裁决并列时排前面。
  // 而 behavior.scoreAll / decide 直接读 neighbors[0] / foods[0] / threats[0]，
  // 于是"谁是最近的那只"会取决于它落在哪个格子、以及谁先被 addCreature ——
  // 这不是设计选择，只是扫描顺序的副产物，且没有任何测试能看见它。
  // 这里显式裁决并列（dist 相同则比 id），把顺序钉成与扫描/插入顺序无关。
  const w = createWorld({ seed: 47, initialCreatures: 0 });
  w.foods.length = 0;
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, a);
  // 'zz' 在 x = 0.4（格子 4，先被扫描到），'aa' 在 x = 0.6（格子 6）。
  // 两者到 a 的距离都恰好是 0.1：不裁决并列时排前面的是扫描顺序更早的 'zz'。
  addCreature(w, createCreature({ id: 'zz', name: 'Z', x: 0.4, y: 0.5, age: 600, rng: createRng(2) }));
  addCreature(w, createCreature({ id: 'aa', name: 'A2', x: 0.6, y: 0.5, age: 600, rng: createRng(3) }));

  const near = perceive(w, a).neighbors;
  assert.equal(near.length, 2, '前置条件：两只都应在感知半径内');
  assert.equal(near[0].dist, near[1].dist, '前置条件：两只距离必须完全相等');
  assert.deepEqual(near.map((n) => n.id), ['aa', 'zz'],
    '并列时应按 id 字典序，而不是网格扫描顺序（扫描顺序会给出 zz 在前）');

  // 食物不经过网格，走的是 world.foods 的数组顺序，同样要按 id 裁决：
  // 先生成 x = 0.6 的那份、后生成 x = 0.4 的，不裁决时数组顺序会把远的排在前面。
  const farFood = spawnFood(w, 'algae', { x: 0.6, y: 0.5 });
  const closeFood = spawnFood(w, 'algae', { x: 0.4, y: 0.5 });
  const foods = perceive(w, a).foods;
  assert.equal(foods.length, 2, '前置条件：两份食物都在感知半径内');
  assert.equal(foods[0].dist, foods[1].dist, '前置条件：两份食物等距');
  assert.ok(foods[0].id < foods[1].id,
    `并列时应按 id 字典序，实际 ${foods.map((f) => f.id).join(' < ')}`);
  assert.deepEqual(foods.map((f) => f.id), [closeFood.id, farFood.id].sort(),
    '等距的两份食物不能按数组插入顺序（那会把后放的近食排在最后）');
});

test('perceive 返回的 foods 按距离升序', () => {
  const w = createWorld({ seed: 15, initialCreatures: 0 });
  w.foods.length = 0;
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, a);
  spawnFood(w, 'algae', { x: 0.9, y: 0.9 });
  spawnFood(w, 'algae', { x: 0.55, y: 0.5 });
  spawnFood(w, 'algae', { x: 0.7, y: 0.6 });
  const foods = perceive(w, a).foods;
  assert.equal(foods.length, 2, '第三个食物在感知半径外，不该出现');
  assert.ok(Math.abs(foods[0].dist - 0.05) < 1e-9, `最近的应排在第一位，实际 dist = ${foods[0].dist}`);
  for (let i = 1; i < foods.length; i++) assert.ok(foods[i].dist >= foods[i - 1].dist);
});

test('网格查询结果与暴力遍历一致（空间网格不能漏掉邻居）', () => {
  const w = createWorld({ seed: 16, initialCreatures: 24, populationCap: 24 });
  step(w, 30);
  for (const c of aliveCreatures(w)) {
    const sensed = new Set(perceive(w, c).neighbors.map((n) => n.id));
    const brute = new Set(
      aliveCreatures(w)
        .filter((o) => o.id !== c.id
          && Math.hypot(o.pos.x - c.pos.x, o.pos.y - c.pos.y) <= CONFIG.perceiveRadius)
        .map((o) => o.id),
    );
    assert.deepEqual([...sensed].sort(), [...brute].sort(), `${c.id} 的感知结果与暴力遍历不一致`);
  }
});

test('playerHand 为 null 时 senses.playerHand 也为 null', () => {
  const w = createWorld({ seed: 17 });
  assert.equal(perceive(w, aliveCreatures(w)[0]).playerHand, null);
});

test('设置 world.playerHand 后能被感知到', () => {
  const w = createWorld({ seed: 18, initialCreatures: 1 });
  const c = aliveCreatures(w)[0];
  c.pos = { x: 0.5, y: 0.5 };
  w.playerHand = { pos: { x: 0.55, y: 0.5 }, speed: 0.02 };
  const senses = perceive(w, c);
  assert.ok(senses.playerHand, '应感知到玩家的手');
  assert.ok(Math.abs(senses.playerHand.dist - 0.05) < 1e-6);
});

test('broodScore 只对可繁殖的个体给正分（幼体与死者为 0）', () => {
  const w = createWorld({ seed: 19, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const kid = createCreature({ id: 'kid', name: 'K', x: 0.6, y: 0.5, age: 10, rng: createRng(3) });
  const dead = createCreature({ id: 'dead', name: 'D', x: 0.6, y: 0.6, age: 600, rng: createRng(4) });
  dead.alive = false;
  for (const c of [a, kid, dead]) addCreature(w, c);
  a.emotions.arousal = 0.9; kid.emotions.arousal = 0.9; dead.emotions.arousal = 0.9;
  a.broodT = 999; kid.broodT = 999; dead.broodT = 999;   // 都"憋满了"

  assert.ok(perceive(w, a).broodScore > 0, '成体憋满时应给正分');
  assert.equal(perceive(w, kid).broodScore, 0, '亚成体不得产卵（canBreed 只看阶段）');
  assert.equal(perceive(w, dead).broodScore, 0, '死者不得产卵');
  // 孤雌下这里**不再有候选列表**：没有对象，就没有"谁是合法求偶对象"这回事。
  // 原测试断言的是 ids 含 b 不含 kid/a，现在它对应的语义变成"我能不能生"。
});

// ---------- 意图锁定语义 ----------

test('同一意图反复胜出时，每个最短时长周期重新决策并刷新目标（不会被锁死，也不会每帧抖动）', () => {
  // 这条钉住 intentTime 的语义，因为它是**唯一**约束"多久重新决策一次"的量：
  //   · 若重新决策时**不**重置 intentTime，同一个 kind 连着胜出时计时会一路累加，
  //     于是比较恒真、decide() 变成**每帧**都跑，而每次调用都会重抽一遍候选噪声 ——
  //     本该防抖的机制反而成了抖动的来源；
  //   · 同一 kind 再次胜出时若丢掉 decide 的新意图，目标点就永远停在第一次的快照上
  //     （只要 explore 一直胜出，它走到那个点后就原地不动；beg 会一直追着一个
  //      早已移开的手的位置）。
  // 所以语义定为：**每次重新决策都换成新意图并重新计时**，即每个意图至少保持
  // minDuration、之后按 minDuration 的节奏（而不是每帧）重新决策一次。
  const w = createWorld({ seed: 45, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, c);
  c.traits.personality.curious = 1;      // 实测 explore 全程落在 0.39~0.76，而 idle 只有 0.12（噪声 ±12% 翻不过来）
  c.thresholds.exploreRadius = 0.3;
  c.emotions.curiosity = 1;              // 从第一 tick 起 curiosity 就在高位，避免开头几个 tick 落在 idle 上
  // A4 加了 hop 之后，中性 activity 的个体在 joy 抬头时会跳走，这条就会误报。
  // 它测的是**重新决策的节奏**，不是谁胜出 —— 所以把 hop 压到不可能赢，而不是去改 hop 的公式。
  c.thresholds.hopWeight = 0;

  const targets = new Set();
  let resets = 0;
  for (let i = 0; i < 20 * 60; i++) {
    c.needs.hunger = 0;   // 把饥饿按住：随机再生的光藻可能落在嘴边，那会让这条测试变成对再生概率的赌注
    tickWorld(w, 1 / 60);
    assert.equal(c.intent.kind, 'explore', `第 ${i} tick 的意图变成了 ${c.intent.kind}`);
    // 刚跑完 tick 时，计时器要么刚被重置为 0，要么还没到 minDuration —— 不可能越过它
    assert.ok(c.intentTime < c.intent.minDuration,
      `intentTime ${c.intentTime} 越过了 minDuration ${c.intent.minDuration}：重新决策没有重置计时`);
    targets.add(`${c.intent.targetPos.x},${c.intent.targetPos.y}`);
    if (c.intentTime === 0) resets += 1;
  }
  assert.equal(c.intent.minDuration, MIN_DURATION.explore,
    'explore 的锁定时长应来自 behavior 的 MIN_DURATION（不是本地字面量）');
  // 20 秒 / 2.04 秒 ≈ 9~10 次重新决策；宽限到 4 次也足以与"每帧都决策"区分开
  assert.ok(resets >= 4, `20 秒内只重新决策了 ${resets} 次，锁定时长没有被遵守`);
  assert.ok(targets.size >= 4,
    `20 秒内只出现过 ${targets.size} 个探索目标点：同一 kind 再次胜出时目标没有被刷新`);
});

// ---------- 食物 ----------

test('spawnFood 返回带 id 的食物并加入世界', () => {
  const w = createWorld({ seed: 20, initialCreatures: 0 });
  w.foods.length = 0;
  const f = spawnFood(w, 'nectar', { x: 0.3, y: 0.4 });
  assert.equal(f.kind, 'nectar');
  assert.deepEqual(f.pos, { x: 0.3, y: 0.4 });
  assert.equal(w.foods.length, 1);
  assert.ok(f.id);
});

test('食物被吃掉后从世界移除，进食者饥饿下降', () => {
  const w = createWorld({ seed: 21, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, c);
  c.needs.hunger = 0.9;
  spawnFood(w, 'algae', { x: 0.5, y: 0.5 });
  const before = w.foods.length;
  step(w, 15);
  assert.ok(w.foods.length < before || c.needs.hunger < 0.9,
    '食物应被吃掉，或饥饿应下降');
});

test('进食阈值 EAT_DIST 在行为层与执行层是同一个数（执行层不得内联别的字面量）', () => {
  // behavior.scoreAll 用 EAT_DIST 判定"够得着才选 eat"，sim 的 executeIntent
  // 用**同一个常量**判定"够得着才真的吃"。两处若漂移就会出现"选了 eat 却吃不到"的
  // 死循环：评分门槛更宽时，生物在 eat 半径外沿被选中 eat，执行层却够不着、不喂食，
  // 锁定到期后重新决策又选中 eat —— 它贴着一份光藻饿死，而两处各自的字面量
  // 都是"合理的数"，没有任何测试会变红。这条就是给执行层那份数字准备的钉子。
  const w = createWorld({ seed: 48, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, c);
  c.needs.hunger = 0.9;
  // 距离 0.03 < EAT_DIST(0.035)：第一个 tick 就应当在**原地**吃掉，不需要先移动
  spawnFood(w, 'algae', { x: 0.53, y: 0.5 });
  tickWorld(w, 1 / 60);
  assert.equal(w.foods.length, 0, '距离 0.03 < EAT_DIST，第一个 tick 就该吃到');
  assert.equal(c.intent, null, '吃完后意图应清空（下一步重新决策）');
  assert.equal(c.pos.x, 0.5, '已经在够得着的范围内就不该先移动 —— 移动说明执行层用了更小的阈值');
  assert.equal(c.pos.y, 0.5);
  assert.ok(c.needs.hunger < 0.9, '吃到东西后饥饿应下降');

  // 另一侧：距离 0.045 > EAT_DIST ⇒ 行为层不该选中 eat（执行层更宽的情况走不到这条路径，
  // 因为 intent 由行为层决定；这里钉住的是"门槛没有被放宽到 0.045"）
  const w2 = createWorld({ seed: 49, initialCreatures: 0 });
  w2.foods.length = 0;
  const c2 = createCreature({ id: 'c2', name: 'C2', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w2, c2);
  c2.needs.hunger = 0.9;
  spawnFood(w2, 'algae', { x: 0.545, y: 0.5 });
  tickWorld(w2, 1 / 60);
  assert.notEqual(c2.intent && c2.intent.kind, 'eat', '距离 0.045 > EAT_DIST，不该选中 eat');
  assert.equal(w2.foods.length, 1, '够不着就不该被吃掉');
});

test('超过种群上限时产卵 readiness 被压低而不是归零（spec §4.12 第 6 条：不得硬阻断）', () => {
  // 与求偶时代同一条语义，只是换了主语：满员时它**照样孵、照样产卵**，
  // 只是那些卵的光会慢慢熄灭。硬阻断（评分恰好 0）会穿帮 ——
  // 玩家会看到"缸满了它们突然就不孵了"，而不是一条世界规则。
  const mk = (cap) => {
    const w = createWorld({ seed: 50, initialCreatures: 0, populationCap: cap });
    w.foods.length = 0;
    const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
    addCreature(w, a);
    a.emotions.arousal = 0.9;
    a.needs.hunger = 0.1;
    a.needs.energy = 0.1;
    a.broodT = 999;                       // 憋满，让 crowding 成为唯一变量
    return w;
  };
  const scoreOf = (w) => perceive(w, w.creatures[0]).broodScore;
  const below = scoreOf(mk(24));   // 1/24 装载：crowding = 1
  const over = scoreOf(mk(1));     // 满员：loadRatio 夹到 1，取 crowding 的下限

  assert.ok(below > 0, '前置条件：上限之下的 readiness 应大于 0');
  assert.ok(over > 0, '满员时不得压到 0 —— 那就是 spec §4.12 第 6 条禁止的硬阻断');
  assert.ok(Math.abs(over / below - 0.12) < 1e-12,
    `上限压力应把评分压到恰好 0.12 倍（crowdingFactor 的下限），实际比值 ${over / below}`);
});

test('光藻会自然再生，但不会超过 foodMax', () => {
  const w = createWorld({ seed: 22, initialCreatures: 0 });
  w.foods.length = 0;
  step(w, 600);
  assert.ok(w.foods.length > 0, '光藻应再生');
  assert.ok(w.foods.length <= CONFIG.foodMax, `食物溢出: ${w.foods.length}`);
});

test('蜜珠不会自然再生（只能由玩家投喂，spec 6.2）', () => {
  const w = createWorld({ seed: 23, initialCreatures: 0 });
  w.foods.length = 0;
  step(w, 600);
  assert.ok(w.foods.every((f) => f.kind === 'algae'), '自然再生的只应是光藻');
});

test('食物 id 互不重复', () => {
  const w = createWorld({ seed: 24, initialCreatures: 0 });
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const f = spawnFood(w, 'algae', { x: 0.5, y: 0.5 });
    assert.ok(!ids.has(f.id), `食物 id 重复: ${f.id}`);
    ids.add(f.id);
  }
});

// ---------- 死亡、哀悼与繁殖 ----------

test('个体活满寿命后死亡，并被溶散清理出 creatures', () => {
  const w = createWorld({ seed: 25, initialCreatures: 1 });
  const c = aliveCreatures(w)[0];
  c.age = 1139;                 // 逼近寿命终点（1140）
  step(w, 20);
  assert.equal(c.alive, false, '应已死亡');
  assert.equal(w.stats.deaths, 1, 'deaths 应恰好记一次 —— 多记说明 onDeath 被重放');
  step(w, CONFIG.dissolveDuration + 5);
  assert.ok(!w.creatures.includes(c), '溶散完毕后尸体应被移除');
});

test('溶散动画的时长由 dying 哨兵值决定 —— 哨兵必须远小于 dissolveDuration', () => {
  // Task 7 只把哨兵值钉成字面量 1e-6，而它与溶散时长的**关系**在这里才能断言：
  // CONFIG.dissolveDuration 是 Task 10 才追加进 config.js 的，
  // Task 7 跑在它前面时该字段还不存在（undefined），比较会得到 NaN。
  // 为什么这个关系承重：Task 10 用 `c.dying += dt` 累加、与 dissolveDuration 比较来决定移除。
  // 若哨兵被写成 1（"动画已开始"的另一种自然读法），溶散会被静默截短（4 秒 → 3 秒），
  // 表现层看到的就是"尸体消失得太快"，且没有任何一处报错。
  // ⚠️ 这里**不要**再写一次字面量 `1e-6`：哨兵值本身由 Task 7 的测试
  // 'dying 的哨兵值受字面量约束（远小于溶散时长）' 钉住（那才是它的归属地）。
  // 在这里重复一遍字面量就成了两处会各自漂移的常量 —— 将来只改一处不会有测试变红。
  // 本 Task 只负责断言"哨兵 与 dissolveDuration 的关系"，用运行时的实际值。
  //
  // 也不能整段 step 过去再读：reapDead 每 tick 都在累加 dying，尸体在
  // dissolveDuration 秒后就被移除了，那时读到的 4.000001 是**累加值**而不是哨兵
  // （实测整段 step(20) 后再断言 `sentinel < dissolveDuration` 必然失败）。
  // 所以逐 tick 走到刚死的那一刻，此时 dying = 哨兵 + 本 tick 的 dt
  // （tickCreature 判死 → reapDead 在同一 tick 已经加过一次 dt）。
  const mkWorld = () => {
    const w = createWorld({ seed: 31, initialCreatures: 1 });
    const c = aliveCreatures(w)[0];
    c.age = 1139;
    return { w, c };
  };
  const dieOne = (world, victim) => {
    let guard = 0;
    while (victim.alive && guard++ < 600) tickWorld(world, 1 / 60);
  };

  const first = mkWorld();
  dieOne(first.w, first.c);
  assert.ok(!first.c.alive, '前置条件：已死亡');
  assert.ok(first.w.creatures.includes(first.c), '前置条件：尸体还没被收走');
  const dyingAtDeath = first.c.dying;
  assert.ok(dyingAtDeath > 0 && dyingAtDeath < CONFIG.dissolveDuration,
    `死亡当 tick 的 dying ${dyingAtDeath} 应落在 (0, dissolveDuration) 内`);
  assert.ok(dyingAtDeath < CONFIG.dissolveDuration * 0.01,
    `死亡当 tick 的 dying ${dyingAtDeath} 必须远小于 dissolveDuration ${CONFIG.dissolveDuration}`
    + '（它 = 哨兵 + 一个 dt；哨兵若被写成 1，溶散动画会被静默截短）');

  // 正常世界：刚好差一点点时尸体还在（证明溶散确实需要接近满时长）
  const second = mkWorld();
  dieOne(second.w, second.c);
  assert.ok(!second.c.alive, '前置条件：已死亡');
  step(second.w, CONFIG.dissolveDuration - 0.5);
  assert.ok(second.w.creatures.includes(second.c), '不满 dissolveDuration 时尸体应仍在（动画还没播完）');
  step(second.w, 1);
  assert.ok(!second.w.creatures.includes(second.c), '超过 dissolveDuration 后应被移除');
});

test('死亡时恰好发出一次 death 事件（供表现层与音效消费）', () => {
  const w = createWorld({ seed: 26, initialCreatures: 1 });
  const c = aliveCreatures(w)[0];
  c.age = 1139;
  w.events.length = 0;
  step(w, 5);
  const deaths = w.events.filter((e) => e.kind === 'death');
  assert.equal(deaths.length, 1,
    `death 事件应恰好一条（重放说明 onDeath 跑了两遍），实际 ${JSON.stringify(w.events)}`);
  assert.equal(deaths[0].id, c.id);
  assert.ok(deaths[0].name, 'death 事件应带上名字供表现层使用');
  assert.deepEqual(deaths[0].pos, { ...c.pos }, 'death 事件应带上死亡位置');
});

test('附近的个体会进入哀悼（mourn > 0，spec 4.11）', () => {
  const w = createWorld({ seed: 27, initialCreatures: 0 });
  const dying = createCreature({ id: 'dying', name: 'D', x: 0.5, y: 0.5, age: 1139.5, rng: createRng(1) });
  const nearby = createCreature({ id: 'near', name: 'N', x: 0.52, y: 0.5, age: 600, rng: createRng(2) });
  const faraway = createCreature({ id: 'far', name: 'F', x: 0.05, y: 0.05, age: 600, rng: createRng(3) });
  for (const c of [dying, nearby, faraway]) addCreature(w, c);
  step(w, 5);
  assert.equal(dying.alive, false);
  assert.ok(nearby.mourn > 0, `近处个体应哀悼，实际 mourn = ${nearby.mourn}`);
  assert.equal(faraway.mourn, 0, '远处的不该哀悼');
});

test('哀悼会随时间结束', () => {
  const w = createWorld({ seed: 28, initialCreatures: 0 });
  const dying = createCreature({ id: 'dying', name: 'D', x: 0.5, y: 0.5, age: 1139.5, rng: createRng(1) });
  const nearby = createCreature({ id: 'near', name: 'N', x: 0.52, y: 0.5, age: 600, rng: createRng(2) });
  for (const c of [dying, nearby]) addCreature(w, c);
  step(w, 5);
  assert.ok(nearby.mourn > 0);
  step(w, CONFIG.mournDuration + 2);
  assert.equal(nearby.mourn, 0, '哀悼应结束，不能永久卡住');
});

test('目击死亡的个体会收到 death 情绪冲击', () => {
  const w = createWorld({ seed: 29, initialCreatures: 0 });
  const dying = createCreature({ id: 'dying', name: 'D', x: 0.5, y: 0.5, age: 1139.9, rng: createRng(1) });
  const nearby = createCreature({ id: 'near', name: 'N', x: 0.52, y: 0.5, age: 600, rng: createRng(2) });
  for (const c of [dying, nearby]) addCreature(w, c);

  // 用 fear 作信号，不用 joy。
  //
  // joy 是个坏指标：nearby 的 joy 目标值本来就大于 0（吃饱、有邻居），
  // 所以"joy 从 0.9 掉下来了"完全可能只是惯性在趋近目标，
  // 跟有没有目击死亡毫无关系 —— 那样的测试永远通过，也就永远发现不了回归。
  //
  // fear 的**目标值**在这里确实是 0：nearby 的 safety=0、身边没有威胁
  // （dying 的体型 26.40 只有 nearby 的 21.55 的 1.22 倍，够不到 perceive 的 1.35 倍门槛）、
  // 也没人对它生气。所以惯性只会把 fear 往 0 拉。
  // 但 fear 有**两个**事件来源，不是只有 death：两者相距 0.02，小于它们的接触距离
  // ((26.40+21.55)/2000 = 0.02398)，所以第 1 个 tick 的 resolve 会先给一次 'bumped'
  // （实测 fear +0.04、anger +0.14）。作为对照，把 fear 抬到 0.2 以上的只有
  // applyEvent('death') 的 +0.25；那 0.04 的基线按目标 0 的惯性往下衰减
  // （6 个 tick 后约 0.033），够不到下面的 0.1 门槛。
  nearby.emotions.fear = 0;
  nearby.needs.safety = 0;

  // 推进 0.2 秒（12 个 tick）：dying 的年龄是 1139.9，死亡落在第 6 个 tick，
  // 之后 6 个 tick 的惯性把 0.25 的冲击衰减到实测 0.2366 —— 仍是 0.1 门槛的两倍多。
  step(w, 0.2);

  assert.equal(dying.alive, false, '前置条件：dying 应已死亡');
  assert.ok(nearby.mourn > 0, '前置条件：nearby 应在哀悼半径内');
  assert.ok(
    nearby.emotions.fear > 0.1,
    `目击同族死亡应把 fear 抬起来（冲击 +0.25，惯性衰减后实测 0.2366），实际 ${nearby.emotions.fear}`,
  );
});

test('新缸在没有玩家干预时会自行求偶产卵（arousal 不得被循环门控锁死在 0）', () => {
  // spec 9.1 的承诺是"几分钟内就能看到第一次求偶"，而这依赖 arousal 能自己升起来。
  // 危险写法是把 canBreed 情境也挂在"已经有合法求偶对象"上：
  //   arousal 目标值 = canBreed ? … : 0；而 broodScore 里 arousal 是一项乘子
  //   ⇒ 谁也开不了头，全缸 arousal 恒为 0，永远不会求偶、永远没有后代，
  //     而且不报错、不抛异常 —— 症状只是"这个缸不生"。
  // 所以这里跑一个**没有任何手动赋值**的新缸，要求它自己走到产卵。
  const w = createWorld({ seed: 46 });
  const startArousal = aliveCreatures(w).map((c) => c.emotions.arousal);
  // ⚠️ 不要写死成 [0,0,0,0]：初始个体数由 CONFIG.initialCreatures 决定（2026-10-14 已由 4 调到 8）。
  // 写死数组会让"改创始个体数"这个纯配置动作变成一次莫名其妙的测试失败。
  // 这里要钉的是**语义**（每只出生时 arousal 都是 0，没有任何手动赋值），不是个数。
  assert.equal(startArousal.length, CONFIG.initialCreatures, '前置条件：初始个体数与配置一致');
  assert.deepEqual(startArousal, new Array(CONFIG.initialCreatures).fill(0), '前置条件：出生时 arousal 为 0');

  step(w, 400);
  const maxArousal = Math.max(...aliveCreatures(w).map((c) => c.emotions.arousal));
  assert.ok(maxArousal > 0.35,
    `成体的 arousal 应能自然升过求偶门槛 0.35，实际最高 ${maxArousal}`);
  assert.ok(w.stats.births > 0 || w.eggs.length > 0,
    `新缸应在无人干预下自行求偶产卵，实际 eggs=${w.eggs.length} births=${w.stats.births}`);
});

test('两只成体长时间相处会产卵', () => {
  const w = createWorld({ seed: 30, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  for (const c of [a, b]) {
    addCreature(w, c);
    c.emotions.arousal = 0.95;
    c.needs.hunger = 0.05;
    c.needs.energy = 0.05;
  }
  w.foods.length = 0;
  for (let i = 0; i < 8; i++) spawnFood(w, 'nectar', { x: 0.5 + i * 0.01, y: 0.5 });
  step(w, 60);
  assert.ok(w.eggs.length > 0 || w.stats.births > 0,
    `60 秒内应产卵，实际 eggs=${w.eggs.length} births=${w.stats.births}`);
});

test('卵孵化后成为新个体，且世代数递增', () => {
  const w = createWorld({ seed: 31, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, generation: 1, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, generation: 1, rng: createRng(2) });
  for (const c of [a, b]) {
    addCreature(w, c);
    c.emotions.arousal = 0.95;
    c.needs.hunger = 0.05;
    c.needs.energy = 0.05;
  }
  for (let i = 0; i < 8; i++) spawnFood(w, 'nectar', { x: 0.5 + i * 0.01, y: 0.5 });
  const before = w.creatures.length;
  step(w, 120);
  assert.ok(w.creatures.length > before, '应有新个体孵化');
  assert.ok(w.stats.births > 0);
  const baby = w.creatures.find((c) => c.stage === 'hatchling');
  assert.ok(baby, '应能找到幼体');
  assert.ok(baby.generation >= 2, `世代应递增，实际 ${baby.generation}`);
  assert.ok(w.stats.generation >= 2);
});

test('孵化出的幼体记得母亲，母亲也记得孩子', () => {
  const w = createWorld({ seed: 32, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  for (const c of [a, b]) {
    addCreature(w, c);
    c.emotions.arousal = 0.95;
    c.needs.hunger = 0.05;
    c.needs.energy = 0.05;
  }
  for (let i = 0; i < 8; i++) spawnFood(w, 'nectar', { x: 0.5 + i * 0.01, y: 0.5 });
  step(w, 150);
  const baby = w.creatures.find((c) => c.stage === 'hatchling');
  assert.ok(baby, '应已孵化');
  // 原来这里钉死是 a 当母亲（双亲制下 slot 0 就是母方）。孤雌下哪只先憋够不可预测，
  // 所以改成顺着幼体自己记的母亲去找 —— 断言的关系没变，变的只是"谁是母亲"由谁说了算。
  const mother = w.creatures.find((c) => c.id === baby.lineage.mother);
  assert.ok(mother, '幼体必须记着自己的母亲');
  assert.ok(mother.lineage.offspring.includes(baby.id), '母亲应记录子代');
  assert.ok(b.lineage.offspring.includes(baby.id), '父亲应记录子代');
  // 原来这里找的是 id === 'a'（双亲制下 a 固定是母方）。孤雌下哪只先憋够不可预测，
  // 所以顺着幼体自己记的母亲去找 —— 断言的关系没变，只是"谁是母亲"改由数据说了算。
  const momEntry = baby.memory.entries.find((e) => e.id === baby.lineage.mother);
  assert.ok(momEntry, '孩子应记得妈妈');
  assert.equal(momEntry.kinship, 0.5);
  // （原「双亲应互记为 mate」那条随 mate 角色一起删除。孤雌下没有配偶，
  //   lineage.mates 这个数组本身也再没有生产者。）
});


test('达种群上限时不再有新个体孵化（叙事化上限，spec 4.12 第 6 条）', () => {
  const w = createWorld({ seed: 34, initialCreatures: 0, populationCap: 2 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  addCreature(w, a);
  addCreature(w, b);

  // 直接把一窝"在上限压力下产出的卵"放进世界。
  //
  // 不让这条测试去赌"求偶会不会恰好在 250 秒内发生"：种群上限对求偶评分的
  // 压制已经在 Task 8 单独测过了，这里要测的是 sim 对不可孵化卵的处理。
  // 混在一起的话，测试失败时无法区分是"上限没生效"还是"这次运气不好没求偶"。
  const clutch = layEggs(a, createRng(9), { atPopulationCap: true });
  for (const egg of clutch) w.eggs.push(egg);

  step(w, 250);
  assert.equal(aliveCreatures(w).length, 2, '不得有新个体出现');
  assert.ok(w.stats.hatchFailures > 0, '应记录孵化失败（卵的光慢慢熄灭）');
  // 原来这里断言的是 `w.eggs.length === 0`。**孤雌下它不再成立，而且是因为机制在生效**：
  // a 与 b 在这 250 秒里会各自持续憋出新的卵（满员时同样产、只是不孵化、慢慢熄灭），
  // 所以缸里永远有新鲜卵在dimming 窗口内。改成只查**我们放进去的那一窝**有没有被清掉。
  const planted = new Set(clutch.map((e) => e.id));
  assert.equal(w.eggs.filter((e) => planted.has(e.id)).length, 0, '放进去的那窝卵应在熄灭后被清理掉');
  // 反向确认只看漂入那一枚。原先断言"缸里还有别的新卵"，等于把这条绑到顺带产卵的
  // 时机上 —— A4 给精力消耗乘 energyDrainFactor 之后时机一变它就碎，而想测的东西没变。
  // 前置条件：满员时**照样产卵**，只是那些卵不孵化（spec §4.12 第 6 条的叙事）。
  // 原来这里是一条"缸里还有别的卵"的反向确认，那等于把本条绑到顺带产卵的时机上 ——
  // A4 给精力消耗乘 energyDrainFactor 之后时机一变就碎，而想测的东西没变。
  // 改成直接钉住机制前提：这一窝必须非空，否则下面那句"已被清理"会因为
  // 压根没放进去东西而恒真。
  assert.ok(clutch.length > 0, '满员时 layEggs 仍应产卵（只是 viable=false）');
});

test('孵化失败的卵会先变暗再散去，不会无限堆积', () => {
  const w = createWorld({ seed: 35, initialCreatures: 0, populationCap: 1 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  // 把双亲推成老年（年龄与阶段都改，保持状态自洽）：这条测试关心的是 sim 对
  // **不可孵化卵**的处理，不该被"成体的 arousal 现在能自然升起来"带来的额外求偶干扰 ——
  // 那会让下面的 laid 计数被新的卵打乱。老年的 canBreed 为 false，arousal 恒为 0。
  for (const c of [a, b]) { c.age = 1000; c.stage = 'elder'; }
  addCreature(w, a);
  addCreature(w, b);

  let laid = 0;
  for (let clutch = 0; clutch < 5; clutch++) {
    for (const egg of layEggs(a, createRng(100 + clutch), { atPopulationCap: true })) {
      w.eggs.push(egg);
      laid++;
    }
  }
  assert.ok(laid >= 5, `前置条件：应产下了若干枚卵，实际 ${laid}`);

  // 熄灭之前的那一段必须先走一遍：`else if (!egg.failCounted)` 这条去重分支
  // 只在"已判定失败、但还没到散去时刻"的窗口里被走到。
  // 少了 egg.failCounted 这道闸，同一枚卵会在每一 tick 各记一次失败
  // （探针实测：这里 65 秒处就已是 35100 次 = 3900 tick × 9 枚，而不是 9 次；
  //   到 180 秒散去前会涨到 97200 = 10800 tick × 9 枚），
  // 而"只断言终值"的写法虽然也看得见它，却看不见失败是在哪个窗口里被数到的。
  step(w, CONFIG.stage.egg + 5);
  assert.equal(w.eggs.length, laid, '还不该散去：卵要先暗一会儿');
  assert.equal(w.stats.hatchFailures, laid, '每枚失败的卵在熄灭阶段就应被计入且只计入一次');

  step(w, CONFIG.stage.egg * 3 + 10 - (CONFIG.stage.egg + 5));   // 越过"光熄灭"的时刻
  assert.equal(w.eggs.length, 0, '所有失败的卵都应已散去');
  assert.equal(w.stats.hatchFailures, laid, '散去时不得重复计数');
});

// 上面两条测的都是**产卵时就已满员**的卵（layEggs 写 viable=false，走 failed 路径）。
// 下面两条测的是另一条路径：卵是在**未满时合法产下**的（viable=true），
// 但 60 秒后孵化时缸刚好满了。缺了 tickEggs 里那道孵化时闸门，
// 这枚卵会被 addCreature 强制塞进一个已满的缸 —— 实测后果是种群冲到上限的两倍以上
// （4 个种子 × 45 分钟：峰值 52 / 47 / 30 / 29，上限 24）。
// 这两条是那道闸门唯一的自动化覆盖：tests/simulate.mjs 虽然也断言峰值，
// 但它的文件名不匹配 Node 测试 runner 的模式，`node --test tests/` 根本不会跑它。
function fullTankWithReadyEgg(seed, eggSeed, eggAge) {
  const w = createWorld({ seed, initialCreatures: 0, populationCap: 2 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  // 推成老年（年龄与阶段都改，保持状态自洽）：老年 canBreed=false、arousal 恒 0，
  // 于是这两只绝不会自己再产卵，下面的 births / hatchFailures 计数只反映被测的那一枚卵。
  // age 1000 距离死亡（1140）还有 140 秒，远大于本组测试的总时长。
  for (const c of [a, b]) { c.age = 1000; c.stage = 'elder'; }
  addCreature(w, a);
  addCreature(w, b);

  // viable=true ⇒ "产卵那一刻缸还没满"；再把 age 推到到期，模拟"60 秒后孵化时缸满了"
  const [egg] = layEggs(a, createRng(eggSeed), { atPopulationCap: false });
  egg.age = eggAge;
  w.eggs.push(egg);
  return { w, a, b, egg };
}

test('满员时到期的卵会**等位置**，位置一空就补上（既不爆缸也不判死）', () => {
  const { w, a, egg } = fullTankWithReadyEgg(60, 7, CONFIG.stage.egg);
  assert.equal(aliveCreatures(w).length, 2, '前置条件：缸已满（上限 2）');
  assert.equal(w.eggs.length, 1, '前置条件：世界里有且只有被测的那一枚卵');

  step(w, 30);
  assert.equal(aliveCreatures(w).length, 2, '满员期间不得孵化 —— 种群绝不能越过上限');
  assert.ok(w.eggs.includes(egg), '到期的卵应该**留着等**，而不是被当场判死');
  assert.equal(w.stats.births, 0, '没有位置就没有出生');
  assert.equal(w.stats.hatchFailures, 0, '等待期间不得计入孵化失败（它还没失败）');

  // 腾出一个位置。不必等尸体溶散：闸门读的是 aliveCreatures 的数量。
  a.alive = false;
  step(w, 1);
  assert.equal(w.stats.births, 1, '位置一空，排队中的卵就该立刻补上');
  assert.equal(aliveCreatures(w).length, 2, '补位后重新满员，但**不超过**上限');
  assert.ok(!w.eggs.includes(egg), '孵出去的卵应从世界移除');
});

test('一直等不到位置的卵会在 3×egg 后熄灭，且只计入一次孵化失败', () => {
  // age 设在"熄灭时刻"前 1 秒：先证明它这一段仍在**等**（不计数），
  // 再越过时刻证明它散去且**只**计一次 —— 与不可孵化卵共用同一条 3×egg 时间轴。
  const { w, egg } = fullTankWithReadyEgg(61, 8, CONFIG.stage.egg * 3 - 1);

  step(w, 0.5);
  assert.ok(w.eggs.includes(egg), '还没越过熄灭时刻：应该仍在等');
  assert.equal(w.stats.hatchFailures, 0, '等待期间不计数');

  step(w, 1);
  assert.ok(!w.eggs.includes(egg), '等不到位置就该让光熄灭、从世界散去');
  assert.equal(w.stats.hatchFailures, 1, '只在散去那一刻计入一次');
  assert.equal(aliveCreatures(w).length, 2, '种群始终不超过上限');

  step(w, 10);
  assert.equal(w.stats.hatchFailures, 1, '卵已移除，不得重复计数');
});

// ---------- 鲁棒性 ----------

test('单只生物抛异常时被隔离为 sick，其余照常运行（spec 7.7）', () => {
  const w = createWorld({ seed: 36, initialCreatures: 3 });
  const victim = aliveCreatures(w)[0];
  const others = aliveCreatures(w).slice(1);
  // 破坏一只生物的内部结构，迫使它在 tick 中抛错
  Object.defineProperty(victim, 'needs', {
    get() { throw new Error('注入的故障'); },
    configurable: true,
  });
  const agesBefore = others.map((c) => c.age);
  assert.doesNotThrow(() => step(w, 10), '世界不得因单只生物的错误而崩溃');
  assert.equal(victim.sick, true, '故障个体应被隔离');
  for (let i = 0; i < others.length; i++) {
    assert.ok(others[i].age > agesBefore[i], `${others[i].id} 应继续正常生活`);
  }
  const errors = w.events.filter((e) => e.kind === 'error');
  assert.equal(errors.length, 1,
    `故障个体应只报一次错（后续 tick 必须跳过它），实际 ${errors.length} 条`);
  assert.equal(errors[0].id, victim.id);
  assert.match(errors[0].message, /注入的故障/);
});

test('sick 个体不再参与繁殖', () => {
  const w = createWorld({ seed: 37, initialCreatures: 2 });
  const [a, b] = aliveCreatures(w);
  a.sick = true;
  a.emotions.arousal = 0.95;
  b.emotions.arousal = 0.95;
  step(w, 100);
  assert.equal(w.eggs.length, 0, 'sick 个体不该繁殖');
});

test('世界清空后 tick 不抛错（最后一只死掉的边界情况）', () => {
  const w = createWorld({ seed: 38, initialCreatures: 1 });
  const c = aliveCreatures(w)[0];
  c.age = 1139.9;
  step(w, 30);
  assert.equal(aliveCreatures(w).length, 0);
  assert.doesNotThrow(() => step(w, 60), '空缸应能安静地继续 tick');
});

test('events 队列可被消费方清空，且不影响后续 tick', () => {
  const w = createWorld({ seed: 39 });
  step(w, 10);
  w.events.length = 0;
  assert.doesNotThrow(() => step(w, 10));
});

test('worldStats 汇总关键指标', () => {
  const w = createWorld({ seed: 40 });
  step(w, 60);
  const s = worldStats(w);
  for (const k of ['time', 'population', 'alive', 'eggs', 'foods', 'births', 'deaths', 'generation', 'hatchFailures']) {
    assert.ok(k in s, `worldStats 缺少 ${k}`);
  }
  assert.equal(s.alive, aliveCreatures(w).length);
  assert.equal(s.population, w.creatures.length);
});

test('addCreature 是强制加入，上限由 layEggs 的 viable 标记把关', () => {
  // addCreature 故意不检查上限：它有两个调用方 ——
  // createWorld（初始投放）与 tickEggs（孵化）。
  // 孵化那条路径的上限由**两处**共同把关，各自负责一种时序：
  //   · layEggs 的 viable=false —— 产卵**那一刻**缸就满了（卵从一开始就要熄灭）；
  //   · tickEggs 的孵化时闸门 —— 产卵时未满、但 60 秒后**孵化时**满了（见上面两条测试）。
  // 在 addCreature 里再查一次会有第三个地方维护同一条规则，迟早打架。
  const w = createWorld({ seed: 41, initialCreatures: 0, populationCap: 2 });
  for (let i = 0; i < 5; i++) {
    addCreature(w, createCreature({ id: `x${i}`, name: `X${i}`, x: 0.5, y: 0.5, age: 600, rng: createRng(i) }));
  }
  assert.equal(w.creatures.length, 5);
  assert.doesNotThrow(() => step(w, 5), '超出上限的世界仍应能正常 tick');
});

test('温柔的手停在附近会累积对玩家的熟悉度（卖萌门槛的引导来源）', () => {
  const w = createWorld({ seed: 42, initialCreatures: 0 });
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, c);
  w.foods.length = 0;
  w.playerHand = { pos: { x: 0.52, y: 0.5 }, speed: 0.01 };   // 缓慢 = 抚摸

  assert.equal(familiarityFor(c.memory, PLAYER_ID), 0, '前置条件：一开始它不认识你');
  step(w, 20);

  assert.ok(
    familiarityFor(c.memory, PLAYER_ID) > 0,
    '温柔的手停在附近应让它慢慢认识你 —— 这是 beg（卖萌）能被触发的唯一引导来源',
  );
});

test('熟悉度建立后，卖萌行为真的会出现（不是永远不可达的死代码）', () => {
  const w = createWorld({ seed: 43, initialCreatures: 0 });
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, c);
  w.foods.length = 0;
  // 让它乐意凑过来，并且把随机基因的另外两个干扰项也按住 ——
  // 只钉 playerApproach 是不够的：explore 的分数 = curiosity × (0.4 + exploreRadius) × …，
  // 本种子的 exploreRadius 高达 0.667，explore 会一直压着 beg（实测 90 秒里
  // beg 一次都没赢过）。这与"避免这条测试变成对随机基因的赌注"是同一件事。
  c.thresholds.playerApproach = 0.8;
  c.traits.personality.curious = 0;      // curiosity 目标值降到 novelty×0.6 = 0.36（手在附近时 novelty 是 0.6）
  c.thresholds.exploreRadius = 0;        // 再把 (0.4 + exploreRadius) 压到 0.4 ⇒ explore ≈ 0.14
  c.needs.energy = 0.05;                 // 别让 rest 冒出来（energy > 0.55 时它有 1.4 的底分）
  w.playerHand = { pos: { x: 0.52, y: 0.5 }, speed: 0.01 };

  let sawBeg = false;
  for (let i = 0; i < 60 * 90 && !sawBeg; i++) {
    tickWorld(w, 1 / 60);
    if (c.intent && c.intent.kind === 'beg') sawBeg = true;
  }
  assert.ok(sawBeg, '90 秒的温柔陪伴后应出现过卖萌；若从未出现，说明 beg 的门槛打不开');
  assert.ok(affectionFor(c.memory, PLAYER_ID) > 0, '卖萌期间应累积好感');
});

test('粗暴的手不累积熟悉度，反而会让它怕你', () => {
  const w = createWorld({ seed: 44, initialCreatures: 0 });
  const c = createCreature({ id: 'c', name: 'C', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, c);
  w.foods.length = 0;
  w.playerHand = { pos: { x: 0.52, y: 0.5 }, speed: 0.9 };    // 快速 = 戳
  step(w, 20);
  assert.equal(familiarityFor(c.memory, PLAYER_ID), 0, '戳它不该让它认识你');
  assert.ok(c.emotions.fear > 0, '被戳应产生害怕（threat 情境）');
});

test('父母条目被容量淘汰后会被重新缓存回来（spec 4.11「认妈妈」活得过淘汰）', () => {
  // 这条钉住的是实现方自行加的一处**偏离 brief** 的机制（refreshKinMemory）——
  // 复查指出它当时**完全没有测试**：删掉整个函数，381 条全绿，
  // 而"雏体忘了妈妈"这个后果会静默回来。
  //
  // 场景是**确定可复现**的（不是"试过，150 秒后母亲还是没了"那种无法复核的说法）：
  // 亲属条目由 hatch / registerKinship 用 ensure 建立，familiarity 恒为 0；
  // memory.prune 在超过容量时按"familiarity 最低"淘汰，且只保护**本次**新建的那一条 ——
  // 于是一旦记忆超出容量，familiarity 为 0 且最早写入的父母条目就是第一个牺牲品。
  const w = createWorld({ seed: 7 });
  const c = aliveCreatures(w)[0];
  c.lineage.mother = 'MOM';
  c.lineage.father = 'DAD';
  ensure(c.memory, 'MOM', { kinship: KINSHIP.mother, role: 'mother' });
  ensure(c.memory, 'DAD', { kinship: KINSHIP.father, role: 'father' });
  // 把记忆塞过容量上限，强制发生淘汰
  for (let i = 0; i < CONFIG.memoryCapacity + 2; i++) ensure(c.memory, `x${i}`);

  // 前置条件：父母条目确实已被挤掉（否则这条测试是在测空气）
  assert.equal(get(c.memory, 'MOM'), null, '前置条件：母亲条目应已被容量淘汰');
  assert.ok(c.memory.entries.length <= CONFIG.memoryCapacity, '前置条件：容量上限仍被遵守');

  tickWorld(w, CONFIG.fixedDt);

  const mom = get(c.memory, 'MOM');
  const dad = get(c.memory, 'DAD');
  assert.ok(mom, 'tickWorld 之后母亲条目应被重新缓存回来（否则"认妈妈"会永久失效）');
  assert.equal(mom.kinship, KINSHIP.mother, '补回来的条目必须带正确的亲缘系数');
  assert.equal(mom.role, 'mother', '补回来的条目必须带正确的角色');
  assert.ok(dad, '父亲条目同样应被补回');
  assert.equal(dad.role, 'father');
  // 反向：补回来不能突破容量上限（否则就成了"永不忘"，与 spec 4.8 的遗忘设计相悖）
  assert.ok(c.memory.entries.length <= CONFIG.memoryCapacity,
    `补缓存不得突破容量上限：${c.memory.entries.length} > ${CONFIG.memoryCapacity}`);
});

test('抚摸能买到好感，卖萌在真实缸里真的会出现（用户明确要求的行为）', () => {
  // ⚠️ 这条守的是一个**曾经真实存在**的失败：验收模拟器实测"卖萌在真实缸里一次都不出现"。
  // 机制（量出来的，不是猜的）：好感在内核里只有 beg 分支会累积
  // （温柔的手只给 familiarity，不给 affection），而 beg 的最高效用分（≈0.15）
  // 低于缸里普通活动的地板（explore 0.4~0.6、socialize 1~2、court 3~4），
  // 于是 beg 永远排不上号 ⇒ affection 恒为 0 ⇒ 卖萌的门永远打不开 —— 死锁。
  // 修法是把 CONFIG.behavior.begUrgency 从 1.3 调到 7.0（扫值数据见 src/config.js 的注释）。
  // 这条测试把"抚摸 → 卖萌 → 好感上升"整条链钉住，防止有人把权重调回去而无人察觉。
  const w = createWorld({ seed: 5 });
  for (let i = 0; i < Math.round(60 / CONFIG.fixedDt); i++) {
    tickWorld(w, CONFIG.fixedDt); w.events.length = 0;
  }
  // 挑一只**愿意靠近玩家**（playerApproach > 0.2）且年轻的个体：
  // playerApproach ≤ 0 的按设计永远不会卖萌（spec 4.9：暴躁/胆小的一见手就躲），
  // 拿它来测只会得到一条恒 0 的曲线；太老的会在观察期间死掉、白白截断数据。
  const cand = aliveCreatures(w)
    .filter((c) => c.thresholds.playerApproach > 0.2 && c.age < 900)
    .sort((a, b) => a.age - b.age)[0];
  assert.ok(cand, '前置条件：缸里应当有 playerApproach > 0.2 且年轻的个体可观察');
  assert.equal(affectionFor(cand.memory, PLAYER_ID), 0, '前置条件：还没互动过，好感应为 0');

  // 温柔地抚摸 20 秒（手速远低于 HAND_SPEED_POKE = 0.25）
  const steps = Math.round(20 / CONFIG.fixedDt);
  w.playerHand = { pos: { x: cand.pos.x, y: cand.pos.y }, speed: 0.01 };
  let begTicks = 0;
  for (let i = 0; i < steps; i++) {
    w.playerHand.pos.x = cand.pos.x;
    w.playerHand.pos.y = cand.pos.y;
    tickWorld(w, CONFIG.fixedDt);
    w.events.length = 0;
    if (cand.intent && cand.intent.kind === 'beg') begTicks += 1;
  }
  w.playerHand = null;

  // 1) 卖萌真的被选中过 —— 这正是用户要的"会卖萌的"
  assert.ok(begTicks > 0,
    `抚摸 20 秒期间一次都没卖萌（beg 胜出 0/${steps}）—— 说明 begUrgency 又落回了不可达的量级`);
  // 2) 于是好感真的买到了（"抚摸有意义"的前提）
  assert.ok(affectionFor(cand.memory, PLAYER_ID) > 0,
    '抚摸买不到好感（affection 仍为 0）—— 卖萌的门 (affection>0.1 || familiarity>0.3) 会因此永远打不开');
  // 3) 熟悉度也应当上升（温柔的手本来就该让它认识你）
  assert.ok(familiarityFor(cand.memory, PLAYER_ID) > 0.3,
    '抚摸应当让它认识你（familiarity 上升）');
});

test('种群循环的廉价门：新缸 420 秒内必须真的孵出个体（长模拟的守门人）', () => {
  // 为什么这条门存在（计划「跨 Task 交接要求」第 4 条的落地）：
  // tests/simulate.mjs 是**手动**验收门 —— 它不匹配 Node 测试 runner 的文件名模式
  //（没有 `.test` / `-test` / `test-` 标记，且目录是 `tests` 而不是 `test`），
  // 所以 `node --test tests/` 不会执行它。反过来说，"种群循环整个坏掉"这类问题
  // 本该只有人手动跑一次 60 分钟模拟才会暴露 —— 那太晚了。
  //
  // 这条门守的是最小的一环：新缸在没有任何人工干预时，必须自己走完
  // 求偶 → 产卵 → 孵化。**必须断言 births 而不是 eggs**：上面那条
  // '新缸在没有玩家干预时会自行求偶产卵' 接受 `eggs > 0 || births > 0`，
  // 于是"卵产得出来、但 hatch 这条路断了"在它眼里是绿的。
  //
  // 时长与种子的选择是**量出来的**，不是拍的（实测 Node v20.19.0 本机）：
  //   · 420 模拟秒（25200 步）在种子 1 上孵出 22 只，阈值 1 有 22 倍余量；
  //   · 同一批 7 个种子（1/999/31337/20261014/42/46/7）在 420 秒时 births 全部 ≥ 1，
  //     而 300 秒时种子 31337 还是 0 —— 所以取 420 秒而不是 300 秒；
  //   · 单个世界 420 秒实测 2.5 秒（独立进程）/ 4.5 秒（跑在 node:test 里，JIT 与 GC 不同）；
  //     而交接要求里建议的 900 秒要约 10.5 秒 —— 加入本门之前全量 382 条用例总共才 11.1 秒，
  //     代价不成比例，故不采用那个时长。
  const t0 = Date.now();
  const w = createWorld({ seed: 1 });
  step(w, 420);
  assert.ok(w.stats.births >= 1,
    `420 模拟秒内应至少孵出一只（求偶→产卵→孵化整条链），实际 births=${w.stats.births} `
    + `eggs=${w.eggs.length}`);
  assert.ok(w.stats.generation >= 2, `世代应至少推进到 2，实际 ${w.stats.generation}`);
  // 顺手把耗时也钉个上界：它一旦退化（例如每 tick 变成 O(n²) 暴力感知），
  // 全量回归会先变慢再变红，而不是悄无声息地拖到分钟级。
  assert.ok(Date.now() - t0 < 20000,
    `420 模拟秒不应超过 20 秒墙钟（实测 2.5–4.5 秒），实际 ${Date.now() - t0}ms`);
});

// ---------- 2026-10-20 孤雌：两条由变异探针逼出来的测试 ----------

test('满员时产出的卵一律不可孵化（结算必须把 atCap 传下去）', () => {
  // 探针：把 layEggs 的 { atPopulationCap: atCap } 改成硬编码 false → 全库 358 条**无一变红**。
  // 也就是说"缸满了卵会慢慢熄灭"这条 spec §4.12 第 6 条的叙事，
  // 原来只在上限压分那一条里被测到（评分变低），**产卵那一刻的 viable 没人测**。
  const w = createWorld({ seed: 71, initialCreatures: 0, populationCap: 2 });
  w.foods.length = 0;
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  for (const c of [a, b]) {
    addCreature(w, c);
    c.emotions.arousal = 0.95;
    c.needs.hunger = 0.05;
    c.needs.energy = 0.05;
    c.broodT = 9999;                        // 两只都憋满
  }
  step(w, 60);
  assert.ok(w.eggs.length > 0, '前置条件：这一小时里必须真的产了卵，否则下面那条是空断言');
  assert.ok(w.eggs.every((e) => e.viable === false),
    `满员时产下的每一枚卵都必须 viable=false，实际有 ${w.eggs.filter((e) => e.viable).length} 枚可孵化`);
});

test('一次 brood 意图只产一窝（一次性标记不得失效）', () => {
  // 探针：把 case 'brood' 里的 `if (!intent.laid)` 改成 `if (true)` → 全库无一变红。
  // 那个标记是"孵一次 = 产一窝"的唯一保证；它失效的话每 tick 都会产 1–3 枚，
  // 症状是卵在缸底指数堆积，而所有平均值断言照样好看。
  const w = createWorld({ seed: 77, initialCreatures: 0, populationCap: 24 });
  w.foods.length = 0;
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  addCreature(w, a);
  a.emotions.arousal = 0.95;
  a.needs.hunger = 0.05;
  a.needs.energy = 0.05;
  a.broodT = 9999;
  // 强制一个 brood 意图并让它持续 10 秒（每 tick 都走 executeIntent）
  a.intent = { kind: 'brood', minDuration: 999 };
  step(w, 10);
  assert.ok(w.eggs.length >= 1, '前置条件：这一窝里必须真的产了卵');
  assert.ok(w.eggs.length <= CONFIG.eggsPerClutch[1],
    `一次意图最多产一窝（${CONFIG.eggsPerClutch[1]} 枚），实际 ${w.eggs.length} 枚 ⇒ 一次性标记失效`);
});

// ==================== 2026-10-20 Task A3：外来血统漂入 ====================
//
// ⚠️ 这一组只钉**机制契约**，不钉"漂入维持了多样性"。
// 后者需要一条正反两向的判据，而基线实测（.superpowers/sdd/tmp/diag-drift.mjs）
// 给出了两个否掉现有设计的结果，见下面 test('满员时漂入被挡…') 的注释。
// 判据等策略定了再补 —— 拿一条测不出东西的指标冒充验收，是本项目反复抓的那类事。

const founders = (w, n, seed, age = 400) => {
  const r = createRng(seed);
  for (let i = 0; i < n; i++) {
    const genes = {};
    for (const g of ALL_GENES) genes[g] = [r.next(), r.next()];
    addCreature(w, createCreature({
      id: `f${i}`, name: `F${i}`, x: 0.3 + i * 0.04, y: 0.5, age, genes, rng: r,
    }));
  }
};

test('漂入按 driftInterval 到点发生（有位置时）', () => {
  const w = createWorld({ seed: 5, initialCreatures: 0, populationCap: 24, driftInterval: 240 });
  step(w, 300);
  assert.equal(w.stats.driftIns, 1, '300 秒应漂入一次');
  const e = w.eggs.find((x) => x.drift);
  assert.ok(e, '漂入物必须带 drift 标记');
  assert.equal(e.motherId, null, '漂入的蛋没有母亲 —— 这是家谱上"外来支系"的唯一线索');
  assert.equal(e.fatherId, null);
  assert.ok(e.viable, '漂入的蛋必须可孵化，否则它进来做什么');
});

test('漂入携带的等位基因与缸内任何个体都不相同（真的补进新血统）', () => {
  // driftInterval 取 30 而不是 240：createWorld 会把缸填到 initialCreatures（传 0 时
  // 落到 CONFIG.initialCreatures=8），创始代一成年就开始产卵，240 秒时缸已经满了 ——
  // 满员会挡掉漂入，这条就变成在测上一条策略而不是"补进新血统"。取 30 秒抢在满员之前。
  const w = createWorld({ seed: 7, initialCreatures: 0, populationCap: 24, driftInterval: 30 });
  founders(w, 4, 11);
  step(w, 40);
  const e = w.eggs.find((x) => x.drift);
  assert.ok(e, '前置条件：必须已经漂入一枚');
  const local = new Set();
  for (const c of w.creatures) for (const g of ALL_GENES) for (const a of c.genes[g]) local.add(Math.round(a * 1e6));
  const fresh = e.genes.hue.map((a) => Math.round(a * 1e6)).filter((a) => !local.has(a));
  assert.equal(fresh.length, 2, '漂入蛋的 hue 两个等位都应是缸里没见过的新等位');
});

test('满员时漂入挤出一格：最老的老年个体漂走，种群不超上限', () => {
  // 控制方裁定 C（2026-10-20）。原来这条测的是"满员就跳过"，而实测那是空操作 ——
  // 缸一旦跑起来就长期钉在上限，40 个漂入窗口全部落空，开与关的模拟逐字节相同。
  //
  // 用 age=1000 造老年（elder 区间 960–1140）。**不能手改 stage**：
  // ageCreature 每 tick 都按年龄重算它，改完活不过第一帧（实测踩过）。
  const w = createWorld({ seed: 9, initialCreatures: 0, populationCap: 3, driftInterval: 60 });
  founders(w, 3, 13, 1000);
  // 三只必须**不同龄**：founders() 给的是同一个 age，那样"最老的那只"无从判定，
  // reduce 会退化成"取第一个"而测试照样绿 —— 写这条测试时差点就漏在这里。
  w.creatures.forEach((c, k) => { c.age = 990 + k * 20; });
  assert.ok(w.creatures.every((c) => c.stage === 'elder'), '前置条件：三只都必须是老年');
  const oldest = w.creatures.reduce((x, y) => (y.age > x.age ? y : x));
  step(w, 100);
  assert.equal(w.stats.driftIns, 1, '满员但有老年个体时，漂入必须真的进得来');
  assert.equal(w.stats.emigrations, 1, '应当有一只老年个体漂走');
  assert.ok(!w.creatures.some((c) => c.id === oldest.id), '被移走的应是最老的那只');
  assert.ok(aliveCreatures(w).length <= 3, `不得超过上限，实际 ${aliveCreatures(w).length}`);
  // 漂走不是死亡：不记 deaths、不发 death 事件（spec §4.11 的哀悼挂在"死亡"上）
  assert.equal(w.stats.deaths, 0, 'emigrate 不得计入 deaths');
  assert.ok(w.events.some((e) => e.kind === 'emigrate'), '应发出 emigrate 事件供表现层消费');
  assert.ok(!w.events.some((e) => e.kind === 'death'), '不得发出 death 事件');
});

test('满员且缸里没有老年个体时，这一轮放弃（不降低标准去搬成体）', () => {
  // age=700 → 成体（480–960）：满员、但没有可腾位的老年个体。
  // 只跑 100 秒 —— 再久它们就老死、位置自然腾出来，那就不是在测本条了。
  const w = createWorld({ seed: 15, initialCreatures: 0, populationCap: 3, driftInterval: 60 });
  founders(w, 3, 17, 700);
  assert.ok(w.creatures.every((c) => c.stage === 'adult'), '前置条件：三只都必须是成体而非老年');
  step(w, 100);
  assert.equal(w.stats.driftIns, 0, '没有可腾位的老年个体时不得强塞进来');
  assert.equal(w.stats.emigrations, 0);
  assert.ok(w.nextDriftAt > 100, '被挡掉的窗口必须已把时钟推过去（否则每帧重查）');
});

test('漂入完全确定：同种子两次跑出同样的时刻、数量与基因', () => {
  const once = () => {
    const w = createWorld({ seed: 21, initialCreatures: 0, populationCap: 24, driftInterval: 240 });
    step(w, 1500);
    return { n: w.stats.driftIns, genes: w.eggs.filter((e) => e.drift).map((e) => JSON.stringify(e.genes.hue)) };
  };
  const a = once(), b = once();
  assert.deepEqual(a, b, '漂入必须走 world.rng，否则同种子不可复现');
});

// ---------------------------------------------------------------- 求关注升级链（spec §4.10，Task A4 尾）
//
// 计时器是 `c.begIgnored`（秒）。它**只在手在场且不回应时**累加：
// 没人在场还越攒越气，读起来是"这只对着空气闹脾气"，是坏的表现。
// "被理睬"的判定与熟悉度通道**共用同一个谓词**（sim.isPetting）——
// 两处各自写一遍迟早漂移，所以只允许一个定义点。

const ESC = CONFIG.behavior.begEscalate;

// 一只缸里只有它自己、手一直晃在"看得见但摸不到"的距离上的个体。
// 手跟着它挪，所以 dist 恒为 0.15：抚摸门是 perceiveRadius × 0.5 = 0.14，
// 若让它偶尔飘近一点，"被冷落"就变成随机事件，测试会不稳。
const ignoredTank = (seed) => {
  const w = createWorld({ seed, initialCreatures: 0 });
  w.foods.length = 0;                       // 别让觅食/进食的 joy 冲击掺进来
  const c = createCreature({ id: 'lonely', name: 'L', x: 0.5, y: 0.5, age: 600, rng: createRng(seed) });
  addCreature(w, c);
  w.playerHand = { pos: { x: 0.65, y: 0.5 }, speed: 0.01 };
  return { w, c };
};
const hover = (w, c) => { w.playerHand.pos.x = c.pos.x + 0.15; w.playerHand.pos.y = c.pos.y; };

test('手不在场时 begIgnored 不累加（没人在场不该生闷气）', () => {
  const { w, c } = ignoredTank(60);
  w.playerHand = null;
  step(w, 20);
  assert.equal(c.begIgnored, 0, '没有玩家在场，升级计时必须停在 0');
});

test('被冷落满 8 秒会发一次 ignored 冲击，而且只发一次', () => {
  const { w, c } = ignoredTank(61);
  let crossings = 0;
  let jump = 0;
  let prevIgnored = c.begIgnored;
  let prevAnger = c.emotions.anger;
  for (let i = 0; i < Math.round(14 * 60); i++) {
    hover(w, c);
    tickWorld(w, 1 / 60);
    if (prevIgnored < ESC.protestAfter && c.begIgnored >= ESC.protestAfter) {
      crossings += 1;
      jump = c.emotions.anger - prevAnger;
    }
    prevIgnored = c.begIgnored;
    prevAnger = c.emotions.anger;
  }
  assert.equal(crossings, 1, '跨过第二级这个时刻只应发生一次（不是每 tick 都炸一次）');
  assert.ok(jump > 0.15, `ignored 事件必须让 anger 当场跳起来，实测 ${jump.toFixed(4)}`);
  assert.ok(c.begIgnored >= ESC.protestAfter, `前置条件：计时应已越过 ${ESC.protestAfter}`);
});

test('被抚摸后升级计数归零（spec §4.10 的"被理睬"出口）', () => {
  const { w, c } = ignoredTank(62);
  // 用 hover 而不是 step：手必须始终停在"看得见摸不到"的那 0.15 上。
  // 若放手让它自己飘，dist 会随机穿过 0.14 的抚摸门或 0.42 的感知门，
  // 于是这条测试测的是随机游走而不是归零。
  for (let i = 0; i < Math.round(6 * 60); i++) { hover(w, c); tickWorld(w, 1 / 60); }
  assert.ok(c.begIgnored > 3, `前置条件：应先已升到第一级，实测 ${c.begIgnored.toFixed(2)}`);
  for (let i = 0; i < 60; i++) {
    w.playerHand.pos.x = c.pos.x;          // 手凑过去，速度仍然温柔 ⇒ 命中 isPetting
    w.playerHand.pos.y = c.pos.y;
    tickWorld(w, 1 / 60);
  }
  assert.equal(c.begIgnored, 0, '被理睬之后不该继续记着这笔冷落账');
});

test('升级到第一级后 hop 会带目标点跳向手，升级前的 hop 没有目标点', () => {
  const { w, c } = ignoredTank(63);
  let before = 0;
  let after = 0;
  for (let i = 0; i < Math.round(12 * 60); i++) {
    hover(w, c);
    tickWorld(w, 1 / 60);
    const it = c.intent;
    if (it && it.kind === 'hop' && it.targetPos) {
      if (i / 60 < ESC.hopAfter) before += 1; else after += 1;
    }
  }
  assert.equal(before, 0, '升级前的 hop 是原地蹦，不该追手');
  assert.ok(after > 0, '升级到第一级后应出现"跳到手跟前"的 hop');
});

test('一次 hop 只扣一次精力（intent.costed 是承重的）', () => {
  const w = createWorld({ seed: 64, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'h', name: 'H', x: 0.5, y: 0.5, age: 600, rng: createRng(64) });
  addCreature(w, c);
  c.needs.energy = 0.1;
  // 直接把意图钉成一次长 hop，绕开决策 —— 这样"扣费时机"是唯一变量
  c.intent = { kind: 'hop', minDuration: 999 };
  const e0 = c.needs.energy;
  tickWorld(w, 1 / 60);
  const e1 = c.needs.energy;
  tickWorld(w, 1 / 60);
  const e2 = c.needs.energy;
  assert.ok(e1 - e0 >= CONFIG.hop.energyCost, `第一 tick 应扣到精力：${(e1 - e0).toFixed(6)}`);
  assert.ok(e2 - e1 < 1e-4, `同一意图的第二 tick 不该再扣：${(e2 - e1).toFixed(6)}`);
});

test('好动的个体累计 hop 次数更多（"消耗量随 activity 上升"是累计意义上的）', () => {
  // ⚠️ 单次 hop 的扣费是常量（CONFIG.hop.energyCost），不随 activity 变。
  // 所以这条测的是**累计**：好动的跳得频繁，自己先把精力耗光，然后必须歇。
  // 两只只改 activity，其余基因共用同一份 —— 否则测的是随机基因（上一轮踩过两次）。
  const genes = randomGenome(createRng(65));
  const run = (activity) => {
    const w = createWorld({ seed: 66, initialCreatures: 0 });
    w.foods.length = 0;
    w.playerHand = null;
    const c = createCreature({
      id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, genes: JSON.parse(JSON.stringify(genes)),
    });
    c.traits.personality.activity = activity;
    c.thresholds = thresholds(c.traits.personality);
    addCreature(w, c);
    let hops = 0;
    let prev = null;
    for (let i = 0; i < Math.round(120 * 60); i++) {
      tickWorld(w, 1 / 60);
      const k = c.intent ? c.intent.kind : null;
      if (k === 'hop' && prev !== 'hop') hops += 1;
      prev = k;
    }
    return hops;
  };
  const lively = run(1);
  const quiet = run(0);
  assert.ok(lively > quiet, `好动者应跳得更多：${quiet} vs ${lively}`);
  assert.ok(lively > 0, '前置条件：好动者确实跳过，否则上面只是不等式空转');
});

test('同一颗种子下升级链整条可复现（计时、档位与意图序列）', () => {
  const play = () => {
    const { w, c } = ignoredTank(67);
    const seq = [];
    let maxAnger = 0;
    for (let i = 0; i < Math.round(15 * 60); i++) {
      hover(w, c);
      tickWorld(w, 1 / 60);
      maxAnger = Math.max(maxAnger, c.emotions.anger);
      seq.push(`${c.intent ? c.intent.kind : '-'}:${c.begIgnored.toFixed(3)}`);
    }
    return { seq, maxAnger, protested: seq.some((s) => s.startsWith('protest:')) };
  };
  const a = play();
  const b = play();
  assert.deepEqual(a.seq, b.seq, '同种子下意图与计时必须逐步相同');
  // 读的是**过程中的峰值**而不是末值：ignored 的冲击之后 anger 按惯性平复回去，
  // 到 15 秒末早就归零了 —— 拿末值断言等于测空气。
  assert.ok(a.protested, '前置条件：这条链真的走到了第二级（出现过 protest）');
  assert.ok(a.maxAnger > 0.2, `protest 阶段应出现过怒气，峰值 ${a.maxAnger.toFixed(3)}`);
});

// ---------------------------------------------------------------- 语言层接线（Task A6）

// 把世界压成一个**不含语言痕迹**的指纹：个体状态、卵、食物、种群统计。
// 用来证明"关掉文字层之后缸照样跑"不是断言一句空话。
//
// ⚠️ 刻意**不含 id**：`eggSeq` / `foodSeq` 是 breeding.js 与 sim.js 的模块级计数器，
// 同一进程里先跑的那个世界会把后面的编号推高（sim.js 的文件头就写明它"不消费随机数、
// 也不进任何数值计算"）。把它们读成"世界变了"是误报；
// 位置对齐由数组下标保证，两个世界的个体是同一批、同一顺序。
const fingerprint = (w) => ({
  time: w.time,
  stats: { ...w.stats, said: 0 },
  creatures: w.creatures.map((c) => [
    c.alive, c.stage, c.age.toFixed(6),
    c.pos.x.toFixed(12), c.pos.y.toFixed(12),
    c.needs.hunger.toFixed(12), c.needs.energy.toFixed(12),
    c.needs.social.toFixed(12), c.needs.safety.toFixed(12),
    c.emotions.joy.toFixed(12), c.emotions.anger.toFixed(12), c.emotions.fear.toFixed(12),
    (c.intent ? c.intent.kind : '-'), c.begIgnored.toFixed(3),
    // 口癖是从主流的 fork 抽的，开与关两边都会抽 ⇒ 它必须相同；
    // 而 speech.nextAt / lastTokens 是语言层私有状态，关掉时本来就是空的。
    c.catchphrase,
  ]),
  eggs: w.eggs.map((e) => [e.age.toFixed(3), e.eggTint, e.viable, e.motherId === null ? 0 : 1]),
  foods: w.foods.map((f) => [f.kind, f.pos.x.toFixed(9), f.pos.y.toFixed(9)]),
});

test('真实缸里确实会出词，且每条 say 都带 2–5 个 token 与合法心情档', () => {
  const w = createWorld({ seed: 70 });
  const said = [];
  for (let i = 0; i < Math.round(600 * 60); i++) {
    tickWorld(w, 1 / 60);
    for (const ev of w.events) if (ev.kind === 'say') said.push(ev);
    w.events.length = 0;
  }
  assert.ok(said.length >= 20, `600 秒的缸里只出了 ${said.length} 句：语言层大概没接上`);
  assert.equal(w.stats.said, said.length, 'stats.said 必须与事件数一致（不能一个记了一个没记）');
  for (const ev of said) {
    assert.ok(ev.tokens.length >= 2 && ev.tokens.length <= CONFIG.speech.maxTokens,
      `句长越界：${ev.text}`);
    assert.ok(MOODS.includes(ev.mood), `say 事件带了非法心情档 ${ev.mood}`);
    assert.equal(ev.text, ev.tokens.join(' '));
  }
  // 五档之外的档位不能是唯一的输出 —— 只出 calm 说明 moodOf 在真实缸里根本没铺开
  const kinds = new Set(said.map((e) => e.mood));
  assert.ok(kinds.size >= 2, `真实缸里只出现过 ${[...kinds].join('/')} 一种心情档，桥可能没接通`);
});

test('关掉文字层之后，缸的其余状态逐位不变（语言层是只读旁路，不是第二条因果链）', () => {
  // 这条是 spec §4.13.2 第 2 条在**规则档**里的等价保证：那条对 API 档写死了
  // "不许因为模型返回的内容去改 needs/emotions/behavior/memory"，
  // 规则档同样必须成立 —— 否则"会说话"就不是一件可关上的事，而是世界的一部分因果。
  //
  // 它同时守住实现的一个具体诱惑：把出词抽样接到 world.rng 上。
  // 那样做每次出词都会平移整条主流，于是开与关的两只缸会长成两个不同的世界，
  // 而这条测试会变红 —— 且红得说不清，所以 speechRng 必须是独立的一条流。
  const play = (speechEnabled) => {
    const w = createWorld({ seed: 71, speechEnabled });
    for (let i = 0; i < Math.round(420 * 60); i++) {
      tickWorld(w, 1 / 60);
      w.events.length = 0;
    }
    return { w, fp: fingerprint(w), said: w.stats.said };
  };
  const off = play(false);
  const on = play(true);
  assert.equal(off.said, 0, '关闭时一句都不该出');
  assert.ok(on.said > 0, '前置条件：开着必须真的出词，否则下面的逐位相同是不等式空转');
  assert.deepEqual(off.fp, on.fp, '关掉文字层只该少掉文字，不该改变世界');
});

test('口癖在出生时抽定一次，跑完整缸仍然是那一个词', () => {
  // spec §4.13.1：口癖"在出生时抽定一次并固化进个体"。
  // 反面写法是出词时现抽 —— 那它就不是"这只宠物的口癖"，而是随机字幕。
  const w = createWorld({ seed: 72 });
  const born = new Map(aliveCreatures(w).map((c) => [c.id, c.catchphrase]));
  for (const c of aliveCreatures(w)) assert.ok(c.catchphrase, '初始个体应在建缸时就已有口癖');
  for (let i = 0; i < Math.round(600 * 60); i++) { tickWorld(w, 1 / 60); w.events.length = 0; }
  for (const [id, phrase] of born) {
    const c = w.creatures.find((x) => x.id === id);
    if (c) assert.equal(c.catchphrase, phrase, `${id} 的口癖变了`);
  }
  const hatched = aliveCreatures(w).filter((c) => !born.has(c.id));
  assert.ok(hatched.length === 0 || hatched.every((c) => c.catchphrase),
    '新孵化的个体也必须自带口癖（由 hatch 走 createCreature 的 rng）');
});
test('world.speechEnabled 是运行时开关，且默认取自 CONFIG.speech.enabled', () => {
  // spec §4.13.1.1 第 3 条：CONFIG 深冻结，所以"关掉文字层"这件事**不可能**在测试里
  // 靠改 CONFIG 演出来。开关必须住在 world 上，计划 3 的设置页才有地方写它。
  // 这条同时钉住两件事：默认值来源，以及 opts 能覆盖它。
  const w = createWorld({ seed: 1 });
  assert.equal(w.speechEnabled, CONFIG.speech.enabled);
  assert.equal(createWorld({ seed: 1, speechEnabled: false }).speechEnabled, false);
});

test('出词用独立分叉流：speechRng 与 rng 不是同一个对象，且同种子可复现', () => {
  // spec §4.13.1.1 第 1 条的实现形式。若有人把它换回 world.rng，
  // sim.test.js 那条"关掉文字层后两缸指纹逐位相同"会红 —— 这里是第二道更直接的闸。
  const a = createWorld({ seed: 5 });
  assert.ok(a.speechRng !== a.rng, '必须是 fork 出来的另一条流');
  assert.equal(typeof a.speechRng.next, 'function');
  assert.deepEqual(
    Array.from({ length: 8 }, () => createWorld({ seed: 5 }).speechRng.next()),
    Array.from({ length: 8 }, () => createWorld({ seed: 5 }).speechRng.next()),
    '同种子下分叉流必须逐位相同',
  );
});

// ---------------------------------------------------------------- 听进去的话（Task A7 接线）

test('玩家对它说的话，会在之后的相关情境里自己冒出来（端到端）', () => {
  // spec §4.8.1 的例子："存了「吃饭」，在它 hunger 高时说出来 ⇒ 看起来就是
  // 它记得你说过吃饭，而且它现在想吃"。
  // 这条把 hear → recall → maybeSay → say 事件整条链钉住：任一环节没接上都会红。
  const w = createWorld({ seed: 80, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'e2e', name: '饿饿', x: 0.5, y: 0.5, age: 600, rng: createRng(80) });
  c.traits.personality.talk = 0.9;
  c.thresholds = thresholds(c.traits.personality);
  addCreature(w, c);
  c.needs.hunger = 0.9;                       // 听到时就饿，之后仍然饿 ⇒ 需求线索对得上
  hear(c, '吃饭', createRng(1), w.time, { mood: 'sad', need: 'hunger' });
  assert.ok(c.heard.length >= 1, `前置条件：词得存进去（分词结果 ${JSON.stringify(c.heard.map((e) => e.token))}）`);
  const stored = c.heard[0].token;

  const said = [];
  for (let i = 0; i < Math.round(400 * 60); i++) {
    c.needs.hunger = Math.max(0.6, c.needs.hunger - 0.001);   // 让它一直是"饿"这个处境
    tickWorld(w, 1 / 60);
    for (const ev of w.events) if (ev.kind === 'say') said.push(ev.text);
    w.events.length = 0;
  }
  assert.ok(said.length >= 5, `前置条件：这一路要说够多句，实测 ${said.length}`);
  assert.ok(said.some((t) => t.includes(stored)),
    `听过 ${stored} 之后 400 秒里一次都没提过：${said.slice(0, 6).join(' | ')}`);
});

test('骂过它的词它不再自己提（价格是承重的，不是存档里的装饰）', () => {
  // 与上一条只差 hear 时的心情档：anger → 价格 -0.8 ≤ suppressBelow → 永不召回。
  // "有的词它会躲"必须是可观察的行为差异，而不是信息卡上一个没人看的数字。
  const run = (mood) => {
    const w = createWorld({ seed: 81, initialCreatures: 0 });
    w.foods.length = 0;
    const c = createCreature({ id: 'p', name: '泡泡', x: 0.5, y: 0.5, age: 600, rng: createRng(81) });
    c.traits.personality.talk = 0.9;
    c.thresholds = thresholds(c.traits.personality);
    addCreature(w, c);
    c.needs.hunger = 0.9;
    hear(c, '吃饭', createRng(1), w.time, { mood, need: 'hunger' });
    const token = c.heard[0].token;
    const texts = [];
    for (let i = 0; i < Math.round(400 * 60); i++) {
      c.needs.hunger = Math.max(0.6, c.needs.hunger - 0.001);
      tickWorld(w, 1 / 60);
      for (const ev of w.events) if (ev.kind === 'say') texts.push(ev.text);
      w.events.length = 0;
    }
    return { token, n: texts.length, mentioned: texts.filter((t) => t.includes(token)).length };
  };
  const happy = run('happy');
  const angry = run('anger');
  assert.ok(happy.n >= 5 && angry.n >= 5, `两边都要出够多句（${happy.n}/${angry.n}）`);
  assert.ok(happy.mentioned > 0, `正价的词该提过（${happy.token}）`);
  assert.equal(angry.mentioned, 0, `负价的词一次都不该提，实测 ${angry.mentioned} 次（${angry.token}）`);
});

test('heard 是只读旁路：存了话的缸，关掉文字层之后其余状态仍逐位不变', () => {
  // A6 那条对照测试的加强版。这里两缸**都**hear 同一段话（hear 是玩家输入，
  // 与文字层开关无关），差别只有"会不会把话讲出来"。
  // 若有人让 recall 去改 needs/emotions/memory，这条会当场把他抓出来。
  const play = (speechEnabled) => {
    const w = createWorld({ seed: 82, speechEnabled });
    for (let k = 0; k < 20; k++) {
      for (const c of aliveCreatures(w)) {
        hear(c, '宝宝今天也要好好吃饭哦 要摸摸 怕怕 玩 开心', createRng(500 + k), w.time, {
          mood: 'calm', need: 'hunger',
        });
      }
      step(w, 3);
    }
    return fingerprint(w);
  };
  assert.deepEqual(play(false), play(true), '听进去的话不该改变世界，只该改变它说出来的话');
});

// ---------------------------------------------------------------- 它在看着你（spec §4.6 末段）
//
// B15 交付眼睛时确认过：这条**内核做不到** —— facing 只在 moveToward 里更新，
// 而表现层不许写世界状态。当时**没有**在 render 里偷改 c.facing 假装做到，
// 因为那会把一个内核缺口伪装成已完成。这一组就是补那个缺口。
//
// ⚠️ 人设一律把意图钉成 idle（minDuration 1e9 ⇒ tickCreature 永不重新决策）。
// 第一版没钉，于是"好感高转向手"那条**在功能还不存在的情况下就绿了** ——
// 因为 affection 0.8 会让 beg 胜出，而 beg 的目标点就是手，moveToward 顺手把
// facing 拧过去了。那是 beg 的副产品，不是"它在看着你"。
// 同理第二版还写过"移动中 facing 必须贴着速度方向（< 0.35）"，那也是错的：
// moveToward 里的 facing 是**带惯性的 lerp**（spec §4.6"转向有惯性，不是瞬间掉头"），
// 目标方向大改后它会名正言顺地滞后。改成测"移动中不被拧向手"。

const facingAngle = (c) => Math.atan2(c.facing.y, c.facing.x);
const angleGap = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
};

// 一只**静止**的成体 + 一只在右边的手。好感由参数给（null = 完全不建 PLAYER 条目）。
const lookTank = (seed, affection) => {
  const w = createWorld({ seed, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'lk', name: 'L', x: 0.4, y: 0.5, age: 960, rng: createRng(seed) });
  addCreature(w, c);
  c.needs.hunger = 0.02; c.needs.energy = 0.02; c.needs.social = 0.02; c.needs.safety = 0;
  if (affection !== null) {
    ensure(c.memory, PLAYER_ID);
    const e = get(c.memory, PLAYER_ID);
    e.familiarity = 1;
    e.affection = affection;
  }
  c.facing.x = 0; c.facing.y = -1;          // 面朝上方：与"右边的手"差 90°，可观测
  c.intent = { kind: 'idle', minDuration: 1e9 };   // 钉死成不动，排除 beg/explore 的副产品
  w.playerHand = { pos: { x: 0.75, y: 0.5 }, speed: 0.01 };
  return { w, c, handAngle: 0 };            // 手在正右方 ⇒ 目标角 0
};

test('好感高且静止时，facing 会缓慢转向玩家的手（spec §4.6「它在看你」）', () => {
  const { w, c, handAngle } = lookTank(900, 0.8);
  const gap0 = angleGap(facingAngle(c), handAngle);
  assert.ok(gap0 > 1.5, `前置条件：起手应背对手 90°，实测 ${gap0.toFixed(3)}`);
  assert.equal(c.moving, false, '前置条件：它必须站着不动');
  step(w, 3);
  const gap1 = angleGap(facingAngle(c), handAngle);
  assert.ok(gap1 < gap0 * 0.5, `三秒后应已转过去大半：${gap0.toFixed(3)} → ${gap1.toFixed(3)}`);
  assert.ok(gap1 < 0.2, `最终应基本对上手指向：${gap1.toFixed(3)}`);
});

test('好感 ≤ 0 时反而转开', () => {
  const { w, c, handAngle } = lookTank(901, -0.5);
  step(w, 3);
  assert.ok(angleGap(facingAngle(c), handAngle) > 2.2,
    `不喜欢它就不该盯着看，实测与手指向夹角 ${angleGap(facingAngle(c), handAngle).toFixed(3)}`);
});

test('好感在中间地带时什么都不动（不是"有手就盯着"）', () => {
  const { w, c } = lookTank(902, 0.1);
  const before = { x: c.facing.x, y: c.facing.y };
  step(w, 3);
  assert.deepEqual({ x: c.facing.x, y: c.facing.y }, before,
    '0 < 好感 < lookTowardAffection 之间必须完全不动');
});

test('正在移动时手的存在**完全不改变** facing（逃跑与觅食的方向不许被拧弯）', () => {
  // ⚠️ 这条是**探针逼出来的第二版**。第一版测的是"移动中 facing 离手指向的角度下界 > 1.0"，
  // 于是把 `if (c.moving) return` 这道门整个摘掉，它**仍然全绿** ——
  // 因为 moveToward 每 tick 的转向步长比 lookAtHand 大，两个相反的拉力叠加后
  // 角度下界照样满足。**测"结果还差得远"抓不到"过程被污染"**。
  // 正确的断言是 A/B 逐位对照：同一颗种子、同一个钉死的意图、同一段路，
  // 只差"手在不在场"，facing 轨迹必须**逐 tick 完全相同**。
  const run = (withHand) => {
    const w = createWorld({ seed: 903, initialCreatures: 0 });
    w.foods.length = 0;
    const c = createCreature({ id: 'mv', name: 'M', x: 0.4, y: 0.5, age: 960, rng: createRng(903) });
    addCreature(w, c);
    ensure(c.memory, PLAYER_ID);
    const e = get(c.memory, PLAYER_ID);
    e.familiarity = 1; e.affection = 0.9;
    c.thresholds.playerApproach = 0;           // 关掉 beg，别让"边觅食边卖萌"混进来
    c.needs.hunger = 0.95;
    c.facing.x = 0; c.facing.y = -1;
    // 把意图钉成"一直往左走"：手在右边，所以任何一次"被手拉过去"都会留下痕迹。
    c.intent = { kind: 'explore', targetPos: { x: 0.05, y: 0.5 }, minDuration: 1e9 };
    if (withHand) w.playerHand = { pos: { x: 0.75, y: 0.5 }, speed: 0.01 };
    const seq = [];
    let movingTicks = 0;
    for (let i = 0; i < Math.round(6 * 60); i++) {
      tickWorld(w, 1 / 60);
      if (c.moving) movingTicks += 1;
      seq.push(`${c.facing.x.toFixed(12)},${c.facing.y.toFixed(12)}`);
    }
    return { seq, movingTicks };
  };
  const withHand = run(true);
  const noHand = run(false);
  assert.ok(noHand.movingTicks > 120,
    `前置条件：这一路必须真的在移动，实测 ${noHand.movingTicks} tick`);
  assert.deepEqual(withHand.seq, noHand.seq,
    '手在场与不在场的 facing 轨迹不同 ⇒ 移动中那道门没挡住转向');
});

test('转向速率由 bold 调制，且单 tick 步长有上限（是一次 glance，不是瞬间掉头）', () => {
  const run = (bold) => {
    const { w, c, handAngle } = lookTank(904, 0.9);
    c.traits.personality.bold = bold;
    c.thresholds = thresholds(c.traits.personality);
    let maxStep = 0;
    let prev = facingAngle(c);
    for (let i = 0; i < Math.round(1 * 60); i++) {
      tickWorld(w, 1 / 60);
      const now = facingAngle(c);
      maxStep = Math.max(maxStep, angleGap(now, prev));
      prev = now;
    }
    return { left: angleGap(handAngle, facingAngle(c)), maxStep, thr: c.thresholds.turnRate };
  };
  const shy = run(0);
  const boldy = run(1);
  assert.ok(boldy.maxStep > shy.maxStep, `胆大的应转得更快：${shy.maxStep} vs ${boldy.maxStep}`);
  const cap = (s) => s.thr * CONFIG.behavior.lookRateFactor / 60;
  assert.ok(shy.maxStep <= cap(shy) + 1e-9, `单 tick 步长越过上限：${shy.maxStep} > ${cap(shy)}`);
  assert.ok(boldy.maxStep <= cap(boldy) + 1e-9, `单 tick 步长越过上限：${boldy.maxStep} > ${cap(boldy)}`);
  assert.ok(boldy.left < shy.left, '同样一秒后，胆大的更接近手指向');
});

test('手不在场时 facing 保持上一次（spec §4.6「静止时保持上一次的 facing」）', () => {
  const { w, c } = lookTank(905, 0.9);
  step(w, 2);
  const held = { x: c.facing.x, y: c.facing.y };
  w.playerHand = null;
  step(w, 3);
  assert.deepEqual({ x: c.facing.x, y: c.facing.y }, held,
    '没有可看的对象时不许自己飘 —— 它不会失去朝向');
});

test('facing 始终是单位向量（转向用 cos/sin 重写，不许累积长度漂移）', () => {
  const { w, c } = lookTank(906, 0.9);
  for (let i = 0; i < Math.round(30 * 60); i++) {
    tickWorld(w, 1 / 60);
    const len = Math.hypot(c.facing.x, c.facing.y);
    assert.ok(Math.abs(len - 1) < 1e-9, `第 ${i} tick 长度漂到 ${len}`);
  }
});

test('同种子下整条转向可复现', () => {
  const play = () => {
    const { w, c } = lookTank(907, 0.9);
    const seq = [];
    for (let i = 0; i < Math.round(5 * 60); i++) {
      tickWorld(w, 1 / 60);
      seq.push(`${c.facing.x.toFixed(9)},${c.facing.y.toFixed(9)}`);
    }
    return seq;
  };
  assert.deepEqual(play(), play());
});

// ---------------------------------------------------------------- 抚摸买到好感（spec §6.1，Task B17b）
//
// 这条补的是**两个**洞：
//   ① spec §6.1 的表写着"抚摸 → affection+ / joy+"，而内核里 affection 只有 beg 会累积 ——
//     温柔的手只买得到 familiarity（"认识"）。
//   ② `CONFIG.emotions.eventMagnitude.petted` 从计划 1 起就**没有任何生产者**
//     （grep 全 src/ 只有定义处）。一个永远不会被 applyEvent 到的事件种类，
//     就是 Task 9 复查抓过的"无生产者的字段"。
// 两条一起补：真的贴上去摸，才买好感，并且那一刻才发 petted。
//
// ⚠️ 这里的"发一次 petted"指的是 `applyEvent(c.emotions, 'petted')` ——
// 它是**情绪冲击**（joy +0.4 / fear −0.2 那种一次性跳变），**不是** world.events 里的一条。
// 第一版按"世界事件"去数，数到 0 还以为功能没接上。两者在 sim.js 里是完全不同的东西：
// 前者改情绪向量，后者是给表现层的一次性通知（say / death / laid …）。
// 数"跳变次数"的办法是可靠的：惯性的单步最多把 joy 推 (target−joy)×min(1,1.6/60) ≈ 0.027，
// 所以一 tick 内 joy 跳 > 0.2 只可能来自 applyEvent。

// 三条通道的分工必须清楚，否则"挂机就能刷好感"会毁掉 spec §6.1 的全部要点：
//   手在附近且温柔        → familiarity（认识你）
//   手**贴着身体**且温柔  → affection（喜欢你）+ petted 事件（一次抚摸只发一次）
//   它主动 beg 蹭上来     → affection（原有通道，不变）

const petTank = (seed) => {
  const w = createWorld({ seed, initialCreatures: 0 });
  w.foods.length = 0;
  const c = createCreature({ id: 'pt', name: 'P', x: 0.5, y: 0.5, age: 960, rng: createRng(seed) });
  addCreature(w, c);
  c.needs.hunger = 0.02; c.needs.energy = 0.02; c.needs.social = 0.02; c.needs.safety = 0;
  ensure(c.memory, PLAYER_ID);
  const e = get(c.memory, PLAYER_ID);
  e.familiarity = 0.5; e.affection = 0;
  c.thresholds.playerApproach = 0;      // 关掉 beg 那条通道，让好感**只可能**来自抚摸
  // 钉成 idle：不然它会自己游走，而手是固定的，接触就会一会儿断一会儿 ——
  // 于是"petted 恰好发一次"测的是随机游走而不是抚摸语义。
  c.intent = { kind: 'idle', minDuration: 1e9 };
  return { w, c };
};
// 世界坐标下的"贴在身上"：半径 ≈ sizeOf/1000（与 resolve 的接触距离同一口径）
const touchDist = (c) => sizeOf(c) / 1000;

test('温柔地贴着它 → affection 上升，且 petted 事件恰好发一次', () => {
  const { w, c } = petTank(920);
  w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.01 };
  let jumps = 0;
  let pettedApplied = 0;
  let prevJoy = c.emotions.joy;
  for (let i = 0; i < Math.round(6 * 60); i++) {
    tickWorld(w, 1 / 60);
    if (c.emotions.joy - prevJoy > 0.2) jumps += 1;
    prevJoy = c.emotions.joy;
    if (c.beingPetted) pettedApplied += 1;
    w.events.length = 0;
  }
  assert.ok(pettedApplied > 300, `前置条件：这六秒必须真的处于抚摸中，实测 ${pettedApplied} tick`);
  assert.equal(jumps, 1, '一次抚摸只发一次 petted 冲击（每 tick 都发的话 joy 会被瞬间推到顶）');
  assert.ok(affectionFor(c.memory, PLAYER_ID) > 0.1,
    `贴着摸六秒应买到明显好感，实测 ${affectionFor(c.memory, PLAYER_ID).toFixed(3)}`);
});

test('手离开再回来算**第二次**抚摸（episode 边界，不是永久一次性）', () => {
  const { w, c } = petTank(921);
  const touch = () => { w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.01 }; };
  const leave = () => { w.playerHand = { pos: { x: 0.5 + touchDist(c) * 6, y: 0.5 }, speed: 0.01 }; };
  const countPetted = (seconds) => {
    let n = 0;
    let prev = c.emotions.joy;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      tickWorld(w, 1 / 60);
      if (c.emotions.joy - prev > 0.2) n += 1;
      prev = c.emotions.joy;
      w.events.length = 0;
    }
    return n;
  };
  touch();
  assert.equal(countPetted(2), 1, '第一次抚摸');
  leave();
  assert.equal(countPetted(2), 0, '离开期间不该再发');
  assert.equal(c.beingPetted, false, '离开后必须落回"没在被摸"');
  touch();
  assert.equal(countPetted(2), 1, '再贴回来必须算第二次 —— 否则第二次起就永远静默');
});

test('粗暴地贴着不算抚摸：不发 petted、不买好感', () => {
  const { w, c } = petTank(922);
  w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.9 };   // > HAND_SPEED_POKE
  let petted = 0;
  let prevJoy = c.emotions.joy;
  for (let i = 0; i < Math.round(6 * 60); i++) {
    tickWorld(w, 1 / 60);
    if (c.emotions.joy - prevJoy > 0.2) petted += 1;
    prevJoy = c.emotions.joy;
    w.events.length = 0;
  }
  assert.equal(petted, 0, '戳不是抚摸');
  assert.ok(affectionFor(c.memory, PLAYER_ID) <= 0,
    `戳不该买到好感，实测 ${affectionFor(c.memory, PLAYER_ID).toFixed(4)}`);
});

test('近但**没贴上**：只买 familiarity，不买 affection（两条通道的分工仍然成立）', () => {
  const { w, c } = petTank(923);
  // 放在 isPetting 的门内（< perceiveRadius×0.5）、接触半径之外
  const d = (touchDist(c) * 1.6 + CONFIG.perceiveRadius * 0.5) / 2;
  assert.ok(d > touchDist(c) * CONFIG.behavior.petContactRatio,
    `前置条件：这个距离必须落在接触半径之外：${d.toFixed(4)}`);
  assert.ok(d < CONFIG.perceiveRadius * 0.5, `前置条件：又必须在抚摸门之内：${d.toFixed(4)}`);
  w.playerHand = { pos: { x: 0.5 + d, y: 0.5 }, speed: 0.01 };
  let petted = 0;
  let prevJoy = c.emotions.joy;
  for (let i = 0; i < Math.round(6 * 60); i++) {
    tickWorld(w, 1 / 60);
    if (c.emotions.joy - prevJoy > 0.2) petted += 1;
    prevJoy = c.emotions.joy;
    w.events.length = 0;
  }
  assert.equal(petted, 0, '没贴上就不该有 petted 冲击');
  assert.equal(affectionFor(c.memory, PLAYER_ID), 0, '光是把手放在那儿不能刷好感');
  assert.ok(familiarityFor(c.memory, PLAYER_ID) > 0.5, '但熟悉度照涨（"认识"）');
});

test('抚摸买到的好感**照常淡忘**（spec §4.8 的裁定不许开后门）', () => {
  const { w, c } = petTank(924);
  w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.01 };
  step(w, 5);
  const peak = affectionFor(c.memory, PLAYER_ID);
  assert.ok(peak > 0.1, `前置条件：先摸出一点好感，实测 ${peak.toFixed(3)}`);
  w.playerHand = null;
  step(w, 60);
  const after = affectionFor(c.memory, PLAYER_ID);
  assert.ok(after < peak * 0.5,
    `停手 60 秒后好感必须明显淡下去（半衰期 34.7s）：${peak.toFixed(3)} → ${after.toFixed(3)}`);
  assert.ok(familiarityFor(c.memory, PLAYER_ID) > 0.5, '而"认识你"这条仍然豁免衰减');
});

test('抚摸整条链在同一种子下可复现', () => {
  const play = () => {
    const { w, c } = petTank(925);
    const seq = [];
    for (let i = 0; i < Math.round(8 * 60); i++) {
      const d = touchDist(c) * (0.3 + 0.05 * Math.sin(i / 30));   // 缓慢划动，速度仍温柔
      w.playerHand = { pos: { x: 0.5 + d, y: 0.5 }, speed: 0.02 };
      tickWorld(w, 1 / 60);
      seq.push(`${affectionFor(c.memory, PLAYER_ID).toFixed(9)}|${c.beingPetted ? 1 : 0}|${c.emotions.joy.toFixed(9)}`);
      w.events.length = 0;
    }
    return seq;
  };
  assert.deepEqual(play(), play());
});

// ---------------------------------------------------------------- 戳与惊吓（spec §6.1，Task B17c）
//
// spec §6.1 的原话："抚摸与戳是同一根手指、不同速度，反应完全相反。这个区分是整个
// 交互的核心。" 判定写在下一段："速度超过阈值且位移方向反复（戳）判为戳"。
//
// 三条通道的完整分工（B17b 立了前两条，这里补后两条）：
//   温柔 + 贴上   → affection + 、petted 冲击一次
//   快速 + 贴上   → poked 冲击一次、safety 受冲击（needs.startle）、不买好感
//   手突然出现    → startled 冲击一次（"吓一跳"，与划动无关）
//
// ⚠️ 这三条都必须**只走 world.playerHand**：它是内核唯一接受表现层写入的字段，
// 所以 input.js 要给它加 `down` 与 `appeared` 两个读数，而不是另开一条通道。

test('快速戳它：poked 冲击一次、safety 受冲击、好感一点不涨', () => {
  const { w, c } = petTank(930);
  w.playerHand = {
    pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.9, down: true, appeared: false,
  };
  let jumps = 0;
  let prevJoy = c.emotions.joy;
  let prevSafety = c.needs.safety;
  let safetyJump = 0;
  for (let i = 0; i < Math.round(6 * 60); i++) {
    tickWorld(w, 1 / 60);
    if (c.emotions.joy - prevJoy > 0.2) jumps += 1;
    if (c.needs.safety - prevSafety > 0.2) safetyJump = Math.max(safetyJump, c.needs.safety - prevSafety);
    prevJoy = c.emotions.joy;
    prevSafety = c.needs.safety;
    w.events.length = 0;
  }
  assert.equal(jumps, 0, '戳不许发 petted 冲击（joy 那一跳是抚摸独有的）');
  assert.ok(safetyJump >= CONFIG.needs.startleAmount * 0.9,
    `needs.startle 必须真的被调用（safety 应跳 ${CONFIG.needs.startleAmount}），实测 ${safetyJump.toFixed(3)}`);
  assert.ok(affectionFor(c.memory, PLAYER_ID) <= 0, '戳不买好感');
  assert.ok(c.emotions.fear > 0.3, `被戳应当害怕，实测 fear ${c.emotions.fear.toFixed(3)}`);
  assert.equal(c.beingPoked, true, '戳是一个持续的 episode（与抚摸对称）');
});

test('poked 只在上升沿发一次；手抬起再戳算第二次', () => {
  const { w, c } = petTank(931);
  const poke = () => {
    w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.9, down: true, appeared: false };
  };
  const lift = () => {
    w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.9, down: false, appeared: false };
  };
  const countFearJumps = (seconds) => {
    let n = 0;
    let prev = c.emotions.fear;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      tickWorld(w, 1 / 60);
      if (c.emotions.fear - prev > 0.2) n += 1;
      prev = c.emotions.fear;
      w.events.length = 0;
    }
    return n;
  };
  poke();
  assert.equal(countFearJumps(2), 1, '第一次戳：一次 poked 冲击');
  lift();
  assert.equal(countFearJumps(1), 0, '抬手之后不该再有冲击');
  assert.equal(c.beingPoked, false, '抬手之后 episode 必须落回');
  poke();
  assert.equal(countFearJumps(2), 1, '再戳必须再算一次 —— 否则第二次起永远静默');
});

test('手突然出现（appeared）→ startled 一次，且与是否贴上无关', () => {
  const { w, c } = petTank(932);
  w.playerHand = null;
  step(w, 1);
  let jumps = 0;
  let prev = c.emotions.fear;
  // 第一 tick 报 appeared:true，之后报 false（input 层的一次性标记）
  w.playerHand = { pos: { x: 0.5 + 0.1, y: 0.5 }, speed: 0.0, down: false, appeared: true };
  for (let i = 0; i < 600; i++) {
    tickWorld(w, 1 / 60);
    if (c.emotions.fear - prev > 0.2) jumps += 1;
    prev = c.emotions.fear;
    if (i === 0) w.playerHand.appeared = false;
    w.events.length = 0;
  }
  assert.equal(jumps, 1, '突然出现只吓一次，不是每 tick 都吓');
});

test('温柔的划动不会触发 poked / startled 的任何一条', () => {
  const { w, c } = petTank(933);
  w.playerHand = {
    pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.02, down: true, appeared: false,
  };
  let fearJumps = 0;
  let prevFear = c.emotions.fear;
  for (let i = 0; i < Math.round(4 * 60); i++) {
    tickWorld(w, 1 / 60);
    if (c.emotions.fear - prevFear > 0.2) fearJumps += 1;
    prevFear = c.emotions.fear;
    w.events.length = 0;
  }
  assert.equal(fearJumps, 0, '抚摸不许带惊吓');
  assert.equal(c.beingPoked, false);
  assert.ok(affectionFor(c.memory, PLAYER_ID) > 0.1, '而好感照买（B17b 那条通道没被改坏）');
});

test('playerHand 缺 down / appeared 时按 false 处理（老形状不许崩，也不许静默当成 true）', () => {
  const { w, c } = petTank(934);
  w.playerHand = { pos: { x: 0.5 + touchDist(c) * 0.4, y: 0.5 }, speed: 0.9 };   // 没有 down / appeared
  assert.doesNotThrow(() => step(w, 1));
  assert.equal(c.beingPoked, false, '缺 down 就当没按下 —— 反过来会把每次快速移动都当成戳');
  assert.equal(c.beingPetted, false);
});

// ================================================================ 拎着玩（grab & carry，2026-10-24 Task 3）
//
// 内核侧的判据。这一段最要紧的一条是"拖一只 ≠ 连续戳"：
// 不处理的话 isPoking（按下 + 手速快 + 贴上身体）对拖拽三条全满足，
// 玩家得到的不是"我拎起了它"而是"我一动它就被连扎"。
// 断的是**次数**（数出来就是 0）—— 断"情绪没变"在分支根本没走到时也会绿。

// 夹具：默认缸（createWorld 自带初代）+ 把每只钉成 idle。
// 钉 idle 的理由与 petTank 那条一模一样：不锁的话它自己游走，而手是固定的，
// 接触会一会儿断一会儿，于是"拎的语义"测成了随机游走。
const grabWorld = (opts = {}) => {
  const w = createWorld({ seed: 20261024, ...opts });
  w.foods.length = 0;
  for (const c of w.creatures) {
    c.intent = { kind: 'idle', minDuration: 1e9 };
    ensure(c.memory, PLAYER_ID);
  }
  return w;
};

test('senses.playerHand.grab 不是 world.playerHand.grab 那个对象（跨帧必须拷贝）', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  const grab = { id: c.id };
  w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false, grab };
  const s = perceive(w, c);
  assert.deepEqual(s.playerHand.grab, { id: c.id });
  assert.notEqual(s.playerHand.grab, grab,
    '按引用搬 ⇒ 表现层改一个字段就等于写了内核的感知（main.js:932 那条 ⚠️ 说的正是这种）');
});

test('被拎的那只不受感知半径限制（甩到对面不许静默脱手）', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  w.playerHand = { pos: { x: 0.99, y: 0.01 }, speed: 1.2, down: true, appeared: false,
    grab: { id: c.id } };
  const far = Math.hypot(0.99 - c.pos.x, 0.01 - c.pos.y);
  assert.ok(far > CONFIG.perceiveRadius * 1.5, `夹具得把手拉到感知半径之外，实距 ${far.toFixed(3)}`);
  const s = perceive(w, c);
  assert.ok(s.playerHand && s.playerHand.grab,
    `半径门外 grab 就丢了 ⇒ 内核每 tick 追一个不存在的 pos（dist=${far.toFixed(3)}）`);
});

// ⚠️ needs.safety 存的是**不安全度**（spec §4.4 四条都是匮乏度；needs.js:74 的 recovery 是 `-=`，
// :82 的 startle 是 `+=`）。所以"被吓到"= 这个数**变大**。写反一次就会得到一条
// 永远绿的假判据 —— 这也是本文件里所有 safety 断言的读法。
test('同一段"按下 + 快 + 贴上"的手样本：没拎是戳，拎住了就不是戳', () => {
  const oneTick = (grabId) => {
    const w = grabWorld();
    const c = w.creatures[0];
    c.traits.personality.clingy = 0.95;     // 排除"因为享受所以走了别的路径"这种巧合
    c.traits.personality.irritable = 0;
    c.pos = { x: 0.5, y: 0.5 };
    w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.5, down: true, appeared: false,
      grab: grabId === null ? null : { id: grabId } };
    const s0 = c.needs.safety;
    tickWorld(w, CONFIG.fixedDt);
    return { pokes: w.events.filter((e) => e.kind === 'poke').length,
      dStartle: c.needs.safety - s0, id: c.id };
  };
  const poking = oneTick(null);
  assert.ok(poking.pokes >= 1, `夹具失效：同样的手样本没 grab 时也没发 poke（${poking.pokes}）`);
  assert.ok(poking.dStartle > 0.1,
    `没拎时也没被 startle（Δ不安全度=${poking.dStartle.toFixed(3)}）—— 这条判据在空转`);
  const held = oneTick(poking.id);
  assert.equal(held.pokes, 0, '被拎的那只还是被发了 poke');
  assert.ok(held.dStartle < 0.05,
    `被拎住反而被吓了（Δ不安全度=${held.dStartle.toFixed(3)}）：让路只让了一半？`);
});

test('拎着 A 快速划过 B ⇒ B 的 poke 照发（让路必须逐只判，不是整只手一刀切）', () => {
  const w = grabWorld();
  const a = w.creatures[0];
  const b = w.creatures[1];
  b.pos = { x: 0.5, y: 0.5 };
  a.pos = { x: 0.12, y: 0.12 };              // A 离得远，纯粹用来当"手里那只"
  w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.6, down: true, appeared: false,
    grab: { id: a.id } };
  tickWorld(w, CONFIG.fixedDt);
  assert.ok(w.events.some((e) => e.kind === 'poke' && e.id === b.id),
    `B 没被算成戳（整只手一刀切了？）：${JSON.stringify(w.events.map((e) => e.kind))}`);
  assert.ok(!w.events.some((e) => e.kind === 'poke' && e.id === a.id), 'A 却被扎了');
});

// 拎着时 familiarity 只剩 carryEffects 一条通道。这条存在的理由很具体：
// CONFIG.grab.familiarityRate 与被它替掉的那条**同值**（0.04/s），
// 所以写成叠加就是 0.08/s —— 玩家看不出来，只有速率断言抓得住。
test('拎着时 familiarity 只从一条通道来（一秒恰好买到 grab.familiarityRate）', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  const m = get(c.memory, PLAYER_ID);
  m.familiarity = 0.2; m.affection = 0;      // 从中间值起，免得钳位把差异吃掉
  const before = m.familiarity;
  for (let i = 0; i < 60; i += 1) {
    w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
    w.events.length = 0;
  }
  const gained = get(c.memory, PLAYER_ID).familiarity - before;
  const want = CONFIG.grab.familiarityRate;
  assert.ok(gained > 0, '一条都没买到 ⇒ 夹具没真拎起来（grab 转发了吗？）');
  assert.ok(gained < want * 1.6,
    `一秒买到 ${gained.toFixed(4)}，远超多通道叠加的嫌疑（单通道 = ${want.toFixed(4)}）`);
});

// 上升沿必须靠寄存器而不是"这帧速度过阈值"判次数：倍速子步会把同一份手样本喂进多个 tick。
test('抓住之后 grab 事件只发一次；重复拎要重复发', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  const hand = (on) => {
    w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: on, appeared: false,
      grab: on ? { id: c.id } : null };
  };
  hand(true);
  let first = 0;
  for (let i = 0; i < 20; i += 1) { tickWorld(w, CONFIG.fixedDt); first += w.events.filter((e) => e.kind === 'grab').length; w.events.length = 0; }
  assert.equal(first, 1, `一次拎发了 ${first} 个 grab 事件`);
  assert.equal(c.held, true);
  hand(false);
  tickWorld(w, CONFIG.fixedDt);
  assert.equal(c.held, false, '松手之后寄存器没归零 ⇒ 下一次拎不会再发事件');
  hand(true);
  let second = 0;
  for (let i = 0; i < 20; i += 1) { tickWorld(w, CONFIG.fixedDt); second += w.events.filter((e) => e.kind === 'grab').length; w.events.length = 0; }
  assert.equal(second, 1, `第二次拎发了 ${second} 个`);
});

// R-2 的机器形式：性格与好感决定方向。两行的 scale 若都写成 1，抗拒的那只 joy 会涨（又哭又笑）。
test('同一句话拎两只：黏人又好感的享受，易怒又陌生的抗拒', () => {
  const run = (o) => {
    const w = grabWorld();
    const c = w.creatures[0];
    c.traits.personality.clingy = o.clingy;
    c.traits.personality.irritable = o.irritable;
    ensure(c.memory, PLAYER_ID);
    const m = get(c.memory, PLAYER_ID);
    m.affection = o.aff; m.familiarity = 1;
    // ⚠️ 起点必须落在 (0,1) 的**严格内部**：初代个体的 joy 出厂是 0，
    // 于是 grabbedRough 那个 −0.2 被 clamp01 整个吃掉，测出来的是情绪惯性回收（+0.012），
    // 而不是冲击本身 —— 这正是 emotions.test.js 那条"起点选择"注释警告过的错法。
    c.emotions.joy = 0.55; c.emotions.anger = 0.25; c.emotions.fear = 0.25;
    const j0 = c.emotions.joy, a0 = c.emotions.anger, f0 = c.emotions.fear;
    w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
    return { dj: c.emotions.joy - j0, da: c.emotions.anger - a0, df: c.emotions.fear - f0,
      ev: w.events.find((e) => e.kind === 'grab') };
  };
  const happy = run({ clingy: 1, irritable: 0, aff: 1 });
  const mad = run({ clingy: 0, irritable: 1, aff: 0 });
  assert.ok(happy.ev.enjoy > 0.999, `夹具该把 enjoy 推到顶，实为 ${happy.ev.enjoy}`);
  assert.ok(mad.ev.enjoy < 0.001, `夹具该把 enjoy 推到底，实为 ${mad.ev.enjoy}`);
  // ⚠️ 断**确切幅度**而不是断符号：探针 P4 把 grabbedRough 的 scale 从 (1 − enjoy) 写成 1，
  // 只断符号的两端夹具抓不住它 —— enjoy=0 时 1−enjoy 本来就等于 1，两种写法数值相同。
  // 顶端那一格才分得开：enjoy=1 时正解是"rough 完全不参与"（+0.3），
  // 错写是"rough 满额也上"（+0.3 − 0.2 = +0.1）。
  assert.ok(happy.dj > 0.25, `享受的那只 joy 只涨了 ${happy.dj.toFixed(3)}（期望满 +0.3）= 两行没互补`);
  assert.ok(mad.dj < -0.15, `抗拒的那只 joy 变了 ${mad.dj.toFixed(3)}（期望约 −0.2）`);
  assert.ok(mad.da > 0 && mad.df > 0);
  assert.ok(happy.ev.enjoy > mad.ev.enjoy);
});

// ---------------------------------------------------------------- 运动接管（R-6）
// 被拎的那只走独立的临界阻尼追随，不复用 moveToward —— 后者把速率钳在 baseSpeed，
// 症状是"一拖就脱手"。下面这三条量的都是"跟不跟手"与"松手甩不甩得出去"。
test('拎着手在缸对面：身体朝手追，且速度可以超过 baseSpeed（moveToward 做不到）', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  c.pos = { x: 0.2, y: 0.5 };
  w.playerHand = { pos: { x: 0.8, y: 0.5 }, speed: 0.6, down: true, appeared: false,
    grab: { id: c.id } };
  const x0 = c.pos.x;
  tickWorld(w, CONFIG.fixedDt);
  assert.ok(c.pos.x > x0, `没朝手走：${x0} → ${c.pos.x}`);
  const free = createWorld({ seed: 20261024 });     // 对照：同一只不被拎，走 moveToward 的上限
  assert.ok(c.vel.x > CONFIG.motion.baseSpeed,
    `速度没超过 baseSpeed（${c.vel.x.toFixed(3)} ≤ ${CONFIG.motion.baseSpeed}）= 还是那条被钳的腿`);
  assert.ok(free, '夹具对照缸建不出来');
});

// ⚠️ 这条刻意**不**断"needs 逐字节不变" —— decayNeeds 每 tick 都在动（拎着 moving=true 还多耗
// energy），那种断言会在正确实现上红。要钉的是"撞墙这件事本身不额外吓人"，
// 所以拿同一种子、同一只、只差手位的两条 run 比 Δ不安全度。
const carryTo = (handX, seed = 20261024) => {
  const w = grabWorld({ seed });
  const c = w.creatures[0];
  c.pos = { x: 0.2, y: 0.5 };              // 从左边出发，不然"到没到墙"根本没说
  const s0 = c.needs.safety;
  for (let i = 0; i < 240; i += 1) {
    w.playerHand = { pos: { x: handX, y: 0.5 }, speed: 0.8, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
    w.events.length = 0;
  }
  const g = w.creatures.find((x) => x.id === c.id);
  return { x: g.pos.x, vx: g.vel.x, dSafety: g.needs.safety - s0 };
};

test('拖到墙外：身体一路追到右壁、被 clampPos 截住、撞墙那轴速度归零、且不额外吓人', () => {
  const open = carryTo(0.5);          // 手在缸中央 ⇒ 全程不碰墙
  const wall = carryTo(5);            // 手在缸外 ⇒ 一路压到右壁
  assert.ok(wall.x > 0.85,
    `夹具在空转：根本没被拖到墙边（x=${wall.x.toFixed(3)}）—— 没有 held 运动律时这条就会这样绿`);
  assert.ok(Math.abs(open.x - 0.5) < 0.12, `对照缸跑歪了：open.x=${open.x.toFixed(3)}`);
  assert.ok(wall.x <= 1 - CONFIG.motion.wallMargin + 1e-9, `越界了：${wall.x}`);
  assert.ok(wall.vx <= 1e-9, `撞墙那轴还在往外推：${wall.vx}`);
  assert.ok(wall.dSafety <= open.dSafety + 1e-6,
    `撞墙比不撞墙更吓人（Δ不安全度 wall=${wall.dSafety.toFixed(4)} open=${open.dSafety.toFixed(4)}）`);
});

test('松手那一下 vel 不归零（惯性），下一 tick 决策重新接管', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  c.pos = { x: 0.4, y: 0.5 };
  w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.6, down: true, appeared: false,
    grab: { id: c.id } };
  tickWorld(w, CONFIG.fixedDt);
  const fling = c.vel.x;
  assert.ok(fling > 0, `追随没给出朝手方向的速度：${fling}`);
  w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.6, down: false, appeared: false, grab: null };
  tickWorld(w, CONFIG.fixedDt);
  assert.equal(c.held, false);
  assert.ok(c.vel.x > 0, `松手即归零 = 甩不出去（${c.vel.x}）`);
});

// spec §6 那张表的最后一行："个体间碰撞照旧参与"。
// ⚠️ 这条一开始写成"a 与 b 重叠、手按在 a 上" —— 那种夹具**在没有 held 运动律时也是绿的**
// （a 本来就会把 b 推开），什么也没钉。现在改成：把 a 拖**进** b，
// 于是"b 被推开"只有在 a 真的被手带着走时才发生。
test('把 a 拖进 b：邻居被推开（held 分支不许顺手跳过碰撞）', () => {
  const w = grabWorld();
  const a = w.creatures[0];
  const b = w.creatures[1];
  a.pos = { x: 0.2, y: 0.5 };
  b.pos = { x: 0.5, y: 0.5 };
  const bx0 = b.pos.x;
  for (let i = 0; i < 90; i += 1) {
    w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0.3, down: true, appeared: false,
      grab: { id: a.id } };
    tickWorld(w, CONFIG.fixedDt);
    w.events.length = 0;
  }
  assert.ok(a.pos.x > 0.45, `a 没被拖到手边（${a.pos.x.toFixed(3)}）：这条又在空转`);
  assert.ok(Math.abs(b.pos.x - bx0) > 1e-4,
    `b 一点没被推开（${bx0} → ${b.pos.x}）：held 分支把碰撞也跳过了？`);
});

test('held 是瞬时寄存器：入档再读回来是 false，序列化里没有 "held" 这个键', () => {
  const w = grabWorld();
  const c = w.creatures[0];
  w.playerHand = { pos: { x: c.pos.x, y: c.pos.y }, speed: 0, down: true, appeared: false,
    grab: { id: c.id } };
  tickWorld(w, CONFIG.fixedDt);
  assert.equal(c.held, true, '夹具没把这只拎起来，这条在空转');
  const doc = serialize(w);
  assert.ok(!/"held"/.test(JSON.stringify(doc)), '表现层瞬时状态入档了（spec §7.2）');
  const w2 = createWorld({ seed: 1, initialCreatures: 0 });
  restoreWorld(w2, migrate(JSON.parse(JSON.stringify(doc))));
  assert.equal(w2.creatures.find((x) => x.id === c.id).held, false,
    '读档后 held 残留 ⇒ 那只一进场就被判成"正被拎着"，而没有人会去清它');
});

test('同种子同手样本跑 300 tick ⇒ fingerprint 逐字段相同（含被拎的那只）', () => {
  const run = () => {
    const w = grabWorld({ seed: 20261024 });
    const c = w.creatures[0];
    for (let i = 0; i < 300; i += 1) {
      const a = 0.5 + 0.2 * Math.sin(i / 9);
      w.playerHand = { pos: { x: a, y: 0.5 }, speed: 0.3, down: true, appeared: i === 0,
        grab: { id: c.id } };
      tickWorld(w, CONFIG.fixedDt);
      w.events.length = 0;
    }
    return JSON.stringify(fingerprint(w));
  };
  assert.equal(run(), run());
});

// ================================================================ 手喂（2026-10-25）
//
// 把饿的那只拖到食物上就算喂。批准的设计里三条约束各自对应一条判据：
//   ① 门槛沿用内核觅食那对数（EAT_DIST 与 hunger 门）⇒ 手喂**不新开供给通道**；
//   ② 吃下去的结算与它自己吃必须是同一个函数 ⇒ "两边逐字段相同"（两处各写一遍，
//      冰晶的 `calms` 这种后加分支就会只进一边）；
//   ③ 唯一的差别是好感：手喂买一点，速率比抚摸低。

const feedFixture = (o = {}) => {
  const w = createWorld({ seed: 20261025 });
  w.foods.length = 0;
  const c = w.creatures[0];
  c.pos = { x: 0.5, y: 0.5 };
  c.vel = { x: 0, y: 0 };
  c.needs.hunger = o.hunger === undefined ? 0.9 : o.hunger;
  ensure(c.memory, PLAYER_ID);
  const m = get(c.memory, PLAYER_ID);
  m.affection = 0; m.familiarity = 1;
  const f = spawnFood(w, o.kind || 'algae', { x: 0.5, y: 0.5 });
  // 锁死 minDuration：不许重新决策，否则"它自己走过去吃"与"手把它放到食物上"
  // 两条路会被 decide() 的随机噪声搅在一起
  c.intent = o.selfEat ? { kind: 'eat', targetId: f.id, minDuration: 1e9 }
    : { kind: 'idle', minDuration: 1e9 };
  // 两边的**手**摆同一个位置、同一个速度（speed 0 ⇒ 不算粗暴，emotionCtx.novelty 同值），
  // 只有 grab 不同 —— 这是②那条"逐字段相同"能成立的前提，不是凑巧。
  w.playerHand = { pos: { x: 0.5, y: 0.5 }, speed: 0, down: true, appeared: false,
    grab: o.held ? { id: c.id } : null };
  return { w, c, f, m };
};

const afterOneTick = (o) => {
  const { w, c, m } = feedFixture(o);
  // ⚠️ 三个混淆源都得按住，这条比较才只比"吃这一口"：
  //   ① c.held 预置 true —— 否则"被拎起来的上升沿"（grabbedHappy / grabbedRough，
  //      实测 fear +0.152 / anger +0.122）会混进来。现实顺序也正是"先拎起来、再拖到食物上"。
  //   ② beingPetted 预置 true —— 自吃那一侧的手是"贴着身体不动"，正满足抚摸判据，
  //      上升沿会发 petted（实测 joy +0.4，就是第一次跑这条时那 0.389 的差）。
  //      预置只关掉**事件**，连续的那点好感照旧买（下面的关系式算的就是它）。
  //   ③ 情绪留 1e-5 容差 —— 被拎的那只 moving=true，energy 一 tick 多耗 4.9e-5，
  //      而情绪目标读 energy ⇒ 惯性挪动量差一点。合法分叉，不是结算漂移。
  if (o.held) c.held = true;
  c.beingPetted = true;
  const h0 = c.needs.hunger, j0 = c.emotions.joy, a0 = c.emotions.anger, f0 = c.emotions.fear;
  tickWorld(w, CONFIG.fixedDt);
  return {
    dHunger: c.needs.hunger - h0, dJoy: c.emotions.joy - j0,
    dAnger: c.emotions.anger - a0, dFear: c.emotions.fear - f0,
    foods: w.foods.length, aff: m.affection,
    kinds: w.events.filter((e) => e.kind === 'eat').map((e) => e.foodKind),
  };
};

test('饿的拎到食物上：吃了、hunger 降、食物少一份、事件里有 eat', () => {
  const r = afterOneTick({ held: true });
  assert.equal(r.foods, 0, `手喂没吃：还剩 ${r.foods} 份`);
  assert.ok(r.dHunger < -0.4, `hunger 没怎么降：${r.dHunger.toFixed(4)}`);
  assert.deepEqual(r.kinds, ['algae']);
  assert.ok(r.dJoy > 0, 'fed 该让 joy 涨（它自己吃也是这个）');
});

// 反空判据：这条与上一条共用夹具，只改 hunger。"份数不减"在分支根本没走到时同样成立，
// 是上一条（饿 → 确实少一份）让它有意义。
test('饱的拎到食物上：一份都不减、好感也不涨（手喂不新开供给通道）', () => {
  const r = afterOneTick({ held: true, hunger: 0.01 });
  assert.equal(r.foods, 1, '不饿也被喂进去了');
  assert.deepEqual(r.kinds, []);
  assert.equal(r.aff, 0, `不饿也记好感：${r.aff} ⇒ 闸门没生效`);
});

test('同一份食物：自吃与手喂的结算逐字段相同，好感差恰好等于 feedAffection 减抚摸那一格', () => {
  const self = afterOneTick({ selfEat: true });
  const hand = afterOneTick({ held: true });
  assert.equal(self.foods, 0, '夹具：自吃那一侧也没吃到，比较在空转');
  assert.equal(hand.foods, 0);
  assert.deepEqual(hand.kinds, self.kinds);
  // 饥饿是**逐位**相同的：decay 里饥饿不随 moving 变（needs.js:47-52 只读体型与贪吃），
  // 所以两边唯一的不同来源就是那口 feed。这条不留容差。
  assert.equal(hand.dHunger, self.dHunger);
  // 三条情绪留 1e-5：被拎的那只 moving=true ⇒ 这一 tick 的 energy 比自吃那只多耗 4.9e-5，
  // 而 emotion 的目标值读 energy ⇒ 惯性往目标挪的量差一点点。**这是合法的分叉，不是结算漂移**，
  // 写死 0 会红得没有道理。1e-5 又远小于任何一处"忘了 calms / 忘了 fed"的量级（0.05~0.45）。
  for (const k of ['dJoy', 'dAnger', 'dFear']) {
    assert.ok(Math.abs(hand[k] - self[k]) < 1e-5,
      `${k} 两边差 ${(hand[k] - self[k]).toExponential(3)} ⇒ 结算不再是同一个函数了`);
  }
  // 自吃那一侧的手也贴着身体 ⇒ 它顺带买到一格抚摸好感；手喂那一侧抚摸被让路、
  // 买到的是 feedAffection。所以差是**两个常数之差**，不是 feedAffection 本身。
  const want = CONFIG.grab.feedAffection - CONFIG.behavior.petAffectionRate * CONFIG.fixedDt;
  assert.ok(Math.abs((hand.aff - self.aff) - want) < 1e-12,
    `好感差 ${(hand.aff - self.aff).toExponential(4)}，期望 ${want.toExponential(4)}`);
});

test('从一堆食物上拖过去：吃到不饿就停口，不会把整缸吸干', () => {
  const per = CONFIG.food.algae.energy;
  const w = createWorld({ seed: 20261026 });
  w.foods.length = 0;
  const c = w.creatures[0];
  c.needs.hunger = 1;
  c.pos = { x: 0.3, y: 0.5 };
  ensure(c.memory, PLAYER_ID);
  for (let i = 0; i < 10; i += 1) spawnFood(w, 'algae', { x: 0.31 + i * 0.04, y: 0.5 });
  let eaten = 0;
  for (let i = 0; i < 240 && w.foods.length > 0; i += 1) {
    const x = 0.3 + i * 0.004;
    w.playerHand = { pos: { x, y: 0.5 }, speed: 1.0, down: true, appeared: false,
      grab: { id: c.id } };
    tickWorld(w, CONFIG.fixedDt);
    eaten += w.events.filter((e) => e.kind === 'eat').length;
    w.events.length = 0;
  }
  const want = Math.ceil((1 - EAT_HUNGER) / per);
  assert.ok(Math.abs(eaten - want) <= 1,
    `吃掉 ${eaten} 份，按 feedAmount ${per} 与闸门 ${EAT_HUNGER} 应为 ${want} 上下`);
  assert.ok(c.needs.hunger <= EAT_HUNGER + 0.02,
    `停口时还饿着：${c.needs.hunger.toFixed(3)}`);
  assert.ok(w.foods.length >= 6, `整缸被吸干（剩 ${w.foods.length} 份）：闸门没起作用`);
});

// ================================================================ 端到端：教它一个词，它自己会说出来
//
// hear / recall / speech 的前缀各自都有判据，但**接起来通不通**此前一条都没钉 ——
// 而 spec §6.3 那句"你叫它，它回头；过几代它自己会喊"正是这条通道存在的理由。
// 中间任何一环断掉（比如 speak 不再把 recall 的结果塞进 ctx.heard），
// 缸里仍然"会说话"，只是永远不会提那个词，而单测全绿。
test('教它一个词，它会在内核里自己说出来（heard → recall → speech → say 全链路）', () => {
  const w = createWorld({ seed: 4242 });
  const c = w.creatures[0];
  // 用一个**不在词表里、也不是任何同伴名字**的串：这样"它说出来了"只可能是从 heard 里来的，
  // 而不是 WORD_POOL 本来就有那 13 个词，也不是走了 ctx.other.name 那条前缀。
  const TOKEN = '咕咕噜';
  assert.ok(!WORD_POOL.includes(TOKEN), '判据词撞进词表了 ⇒ 这条判据会假绿');
  assert.ok(!w.creatures.some((o) => o !== c && o.name === TOKEN), '判据词撞了别的个体的名字');
  c.name = TOKEN;                       // spec 的那个形状：它学会的第一个词是自己的名字
  // 心情定价格：anger −0.8 < suppressBelow −0.6 ⇒ **被骂着学会的词它自己再也不提**。
  // 这条是 2026-10-25 真页面那一趟量出来的（「星尘」学在愤怒里，永远召不回），
  // 所以判据必须学在 happy(+0.6) 里 —— 否则测的是"价格闸门"而不是"链路通不通"。
  const teach = () => hear(c, TOKEN, w.speechRng, w.time, { mood: 'happy', need: 'hunger' });
  teach();
  assert.equal(c.heard.length, 1, '一个词都没存进去：tokenize 或 selectCandidates 断了');
  assert.equal(c.heard[0].token, TOKEN, '存进去的不是那个词');
  const said = [];
  for (let i = 0; i < Math.round(1200 * 60); i++) {
    // 让它一直是"最饿"的那只：recall 的线索是**此刻最紧的需求**，换线索就不提它了。
    c.needs.hunger = 0.9; c.needs.social = 0.1; c.needs.energy = 0.6; c.needs.safety = 0;
    if (i > 0 && i % (240 * 60) === 0) teach();   // 隔几分钟再听一遍（uses↑ ⇒ 半衰期加倍）
    tickWorld(w, CONFIG.fixedDt);
    for (const ev of w.events) if (ev.kind === 'say' && ev.id === c.id) said.push(ev.text);
    w.events.length = 0;
  }
  assert.ok(said.length > 20,
    `这只 1200 秒里只说了 ${said.length} 句：夹具不对，下面那条"说出来了"不算证据`);
  assert.ok(said.some((s) => s.includes(TOKEN)),
    `教了 6 遍、饿了 1200 秒，一次也没提那个词：${JSON.stringify(said.slice(0, 6))}`);
});

// ================================================================ 社交同步（spec §4.12 第 6 条）
//
// 下面这一组测的是**接线**：门控六条已经在 tests/social.test.js 里逐条钉过
// （打破任一条 ⇒ pairEligible 为假），所以这里的 helper 把那六个条件一次摆好，
// 每条测试只改动它自己要测的那一条。
//
// 一律用 initialCreatures: 2 或 3 的小缸：八只的满缸里第三者会把这一对撞开，
// 距离一旦越过 pairDist 一个 tick，同步度就从 1 掉到 0.994，下一 tick 再跨一次上升沿
// —— 那会让"40 秒恰好一记铃"变成看运气。第三者碰撞不是这条测试要测的东西。

function bondFrom(a, b) {
  a.pos.x = 0.40; a.pos.y = 0.50;
  b.pos.x = 0.46; b.pos.y = 0.50;
  for (const [c, o] of [[a, b], [b, a]]) {
    c.intent = {
      kind: 'socialize', targetId: o.id,
      targetPos: { x: o.pos.x, y: o.pos.y }, minDuration: 1e6,
    };
    c.intentTime = 0;
    c.needs.hunger = 0;
    c.emotions.joy = 0.8;
    adjustMemory(c.memory, o.id, 0.5, 0.5);      // delta：好感/熟悉度都到 0.5，门是 0.15
  }
  return [a, b];
}

// 每 tick 按住"这条测试不是在测的"那几条门：
// · hunger —— 0.0083/秒，95 秒会自己涨过 fedMin（饥饿 0.4），于是测到的是"饿散了"；
// · joy —— 情绪基线会不会自己掉下来是 emotions 的事，这条门在 social.test.js 里钉过；
// · 意图锁 —— decide() 每 minDuration 重抽一次，重抽之后这一对就不再互相锁定了。
function holdBond(a, b) {
  for (const [c, o] of [[a, b], [b, a]]) {
    c.needs.hunger = 0;
    c.emotions.joy = Math.max(c.emotions.joy, CONFIG.mood.happyJoyMin + 0.2);
    if (!c.intent || c.intent.kind !== 'socialize' || c.intent.targetId !== o.id) {
      c.intent = {
        kind: 'socialize', targetId: o.id,
        targetPos: { x: o.pos.x, y: o.pos.y }, minDuration: 1e6,
      };
      c.intentTime = 0;
    }
  }
}

function stepBonded(world, pair, seconds, dt = CONFIG.fixedDt) {
  const out = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i += 1) {
    holdBond(pair[0], pair[1]);
    tickWorld(world, dt);
    for (const ev of world.events) if (ev.kind === 'synced') out.push(ev);
    world.events.length = 0;
  }
  return out;
}

function pairWorld(seed, count = 2) {
  const world = createWorld({ seed, initialCreatures: count });
  return [world, bondFrom(world.creatures[0], world.creatures[1])];
}

test('同步期间互买好感与熟悉度，而独处的对照只会被时间淡掉', () => {
  const [world, [a, b]] = pairWorld(3);
  adjustMemory(a.memory, PLAYER_ID, 0.4, 0.7);
  adjustMemory(b.memory, PLAYER_ID, 0.4, 0.7);

  // 对照：**独处**的一只，记忆里同样有一条 0.5 的记录（对着一个不存在于缸里的 id）。
  // 它没有第二只可凑，于是那张账上只剩 decay —— "涨"与"跌"的差别就只能来自"有没有那另一只"。
  // ⚠️ 原先的对照是"把对方按住饿"：在"凑在一起就慢慢涨好感"这条慢通道接上之后，
  //    饿着的一对仍然贴在一起，对照缸也会涨，那条判据就废了。
  const solo = createWorld({ seed: 3, initialCreatures: 1 });
  const lonely = solo.creatures[0];
  adjustMemory(lonely.memory, 'ghost', 0.5, 0.5);
  adjustMemory(lonely.memory, PLAYER_ID, 0.4, 0.7);
  const soloBefore = affectionFor(lonely.memory, 'ghost');

  stepBonded(world, [a, b], 10);
  const aff = affectionFor(a.memory, b.id);
  assert.ok(aff > 0.6, `十秒同步之后好感只到 ${aff}（起点 0.5）`);
  assert.ok(familiarityFor(a.memory, b.id) > 0.5,
    `熟悉度也要涨，实到 ${familiarityFor(a.memory, b.id)}`);
  assert.ok(affectionFor(b.memory, a.id) > 0.6, '必须两边都写：只写一边家谱与升级都会瘸');

  const n = Math.round(10 / CONFIG.fixedDt);
  for (let i = 0; i < n; i += 1) {
    tickWorld(solo, CONFIG.fixedDt);
    solo.events.length = 0;
  }
  const soloAff = affectionFor(lonely.memory, 'ghost');
  assert.ok(soloAff < soloBefore, `独处的那条该下降，实到 ${soloAff}（起点 ${soloBefore}）`);

  // 对玩家那一条：同步缸与独处缸经过**同样的时间**（都会被 decay 淡掉），
  // 所以逐字节相等才说明 tickSocial 没有把好感顺手加到手所代表的 PLAYER 上。
  // 直接和"10 秒前的旧值"比是不行的：decay 本来就会改它，那会把正确的实现判红。
  assert.equal(JSON.stringify(a.memory.entries.find((e) => e.id === PLAYER_ID)),
    JSON.stringify(lonely.memory.entries.find((e) => e.id === PLAYER_ID)),
    '社交只许写"对彼此"的那一条：把玩家那条一起加是最容易犯的错');

  assert.ok(aff > soloAff + 0.1, `两缸的差值要够大，否则上面那条判据分辨不了什么（${aff} vs ${soloAff}）`);
});

test('同步把 arousal 推上去（§4.5 那一行"社交高峰"从此有生产者）', () => {
  const [world, [a, b]] = pairWorld(3);
  a.emotions.arousal = 0;
  b.emotions.arousal = 0;
  stepBonded(world, [a, b], 12);
  // 0.2 这条线是有含义的：同步到顶的稳态增量是 arousalRate/inertia = 0.34，
  // 而原来 0.12 那版稳态只有 0.075（5 秒实测 0.055）—— 那在脉率/膨胀上看不出来。
  // 所以这条判据同时在钉"注入存在"与"注入够大"，而不只是大于 0。
  assert.ok(a.emotions.arousal > 0.2, `arousal 只到 ${a.emotions.arousal}`);
  assert.ok(b.emotions.arousal > 0.2, `对方也要一起亮，实到 ${b.emotions.arousal}`);
  assert.ok(Number.isFinite(a.emotions.arousal) && a.emotions.arousal <= 1);

  // 对照组：同样的两只、同样 12 秒，只把对方按住饿 —— arousal 必须留在低位。
  // 没有这一半的话，"arousal 涨了"也可能来自好奇/产卵别的通道。
  const [ctrlWorld, ctrl] = pairWorld(3);
  ctrl[0].emotions.arousal = 0;
  ctrl[1].emotions.arousal = 0;
  const ticks = Math.round(12 / CONFIG.fixedDt);
  for (let i = 0; i < ticks; i += 1) {
    holdBond(ctrl[0], ctrl[1]);
    ctrl[1].needs.hunger = 1;
    tickWorld(ctrlWorld, CONFIG.fixedDt);
    ctrlWorld.events.length = 0;
  }
  assert.ok(ctrl[0].emotions.arousal < 0.1,
    `没同步的一对不该被推高，实到 ${ctrl[0].emotions.arousal}`);
});

test('synced 事件是上升沿：一次 episode 恰好一条，且带 withId', () => {
  const [world, [a, b]] = pairWorld(3);
  const seen = stepBonded(world, [a, b], 40);
  assert.equal(seen.length, 1, `40 秒里响了 ${seen.length} 记，应该恰好一记（6 秒跨一次顶）`);
  assert.deepEqual([seen[0].id, seen[0].withId].sort(), [a.id, b.id].sort(),
    '事件要带上"跟谁"：铃声之外的消费方（将来的气泡）只有这个读数');
});

test('打破 fedMin 那一条门，40 秒里一记铃都不该有', () => {
  const [world, pair] = pairWorld(3);
  let n = 0;
  const ticks = Math.round(40 / CONFIG.fixedDt);
  for (let i = 0; i < ticks; i += 1) {
    holdBond(pair[0], pair[1]);
    pair[1].needs.hunger = 1;                 // 对方饿着：这条门在 social.test.js 里也钉过
    tickWorld(world, CONFIG.fixedDt);
    n += world.events.filter((e) => e.kind === 'synced').length;
    world.events.length = 0;
  }
  assert.equal(n, 0, `门没关住：响了 ${n} 记`);
});

test('长期同步之后**双方**都记下 companion，家谱虚线与信息卡同伴行同源出现', () => {
  const [world, [a, b]] = pairWorld(3);
  stepBonded(world, [a, b], CONFIG.social.totalSeconds + 5);
  assert.equal(companionOf(a.memory)?.id, b.id, '升级必须是双方的：只升一边家谱画不出边');
  assert.equal(companionOf(b.memory)?.id, a.id);

  const model = familyModelFor(world, a.id);
  assert.equal(model.edges.filter((e) => e.kind === 'companion').length, 1,
    '家谱的伙伴虚线：这一轮之前恒为 0 条（清单 §17.3 如实记过）');
  const rows = relationRowsFor(a, world);
  const pal = rows.find((r) => r.label === '同伴');
  assert.ok(pal && String(pal.value).includes(b.name),
    `信息卡的同伴行该写着 ${b.name}，实到 ${JSON.stringify(rows)}`);
});

test('伙伴还活着时不换人；伙伴死了之后才可以结新伙（裁定 3）', () => {
  const world = createWorld({ seed: 3, initialCreatures: 3 });
  const [a, b] = bondFrom(world.creatures[0], world.creatures[1]);
  const c = world.creatures[2];
  const secs = CONFIG.social.totalSeconds + 5;
  stepBonded(world, [a, b], secs);
  assert.equal(companionOf(a.memory).id, b.id, '前置条件：a 的伙伴是 b');

  // b 还活着，只是不再参与：a 与 c 摆成合格对，同步够久 —— 伙伴不许被换掉。
  bondFrom(a, c);
  stepBonded(world, [a, c], secs);
  assert.equal(companionOf(a.memory).id, b.id,
    'b 还活着就换人的话，家谱那条虚线会随谁先凑上对而跳来跳去');

  // b 死掉之后，a 才可以与 c 结伙（一颗星不该永远守着尸体）。
  b.alive = false;
  stepBonded(world, [a, c], secs + 20);
  assert.equal(companionOf(a.memory).id, c.id, 'b 死了之后 a 应该能结新伙');
  assert.equal(a.memory.entries.filter((e) => e.role === 'companion').length, 1,
    '换人是"改那一条"，不是"再加一条"：至多一个伙伴');
});

test('血缘优先：已经是 mother 的那条不会被社交改写成 companion', () => {
  const [world, [a, b]] = pairWorld(3);
  // ensure 对**已存在**的条目只返回、不改写（这是它自己的契约），而 bondFrom
  // 已经把这条建出来了，所以要直接把血缘写上去。
  const mom = ensure(a.memory, b.id);
  mom.role = 'mother';
  mom.kinship = KINSHIP.mother;
  stepBonded(world, [a, b], CONFIG.social.totalSeconds + 5);
  assert.equal(get(a.memory, b.id).role, 'mother', '血缘是历史事实，覆盖它等于伪造家谱');
  assert.equal(companionOf(a.memory), null);
});

test('tickSocial 不给个体长新键、也不在世界对象上挂新容器', () => {
  const [world, [a]] = pairWorld(3);
  const cKeys = Object.keys(a).sort().join(',');
  const wKeys = Object.keys(world).sort().join(',');
  stepBonded(world, [a, world.creatures[1]], 20);
  assert.equal(Object.keys(a).sort().join(','), cKeys, '进度只许写进已有的三个字段');
  assert.equal(Object.keys(world).sort().join(','), wKeys,
    '不许在世界上新挂一个 pairs 容器：那会是第二份真相，还要跟着存档一起管');
});

test('A 追 B、B 追 C 时 A 与 B 不响：互相指向是门控，不是装饰', () => {
  // 纯层那条"互相指向"（social.test.js 门控五条里的第三条）在**世界**里的对应判据。
  // 少了它，一列排队的星星会被判成一对对在同步 —— 拥挤的缸里"A 追 B、B 追 C"很常见。
  const world = createWorld({ seed: 3, initialCreatures: 3 });
  const [a, b, c] = world.creatures;
  a.pos.x = 0.40; a.pos.y = 0.50;
  b.pos.x = 0.46; b.pos.y = 0.50;
  c.pos.x = 0.52; c.pos.y = 0.50;
  adjustMemory(a.memory, b.id, 0.5, 0.5);
  adjustMemory(b.memory, a.id, 0.5, 0.5);     // 好感、距离、吃饱都合格，只差"互相"
  const hold = (x, y) => {
    x.needs.hunger = 0;
    x.emotions.joy = CONFIG.mood.happyJoyMin + 0.2;
    if (!x.intent || x.intent.kind !== 'socialize' || x.intent.targetId !== y.id) {
      x.intent = {
        kind: 'socialize', targetId: y.id,
        targetPos: { x: y.pos.x, y: y.pos.y }, minDuration: 1e6,
      };
      x.intentTime = 0;
    }
  };
  let n = 0;
  const ticks = Math.round(40 / CONFIG.fixedDt);
  for (let i = 0; i < ticks; i += 1) {
    hold(a, b);
    hold(b, c);
    tickWorld(world, CONFIG.fixedDt);
    n += world.events.filter((e) => e.kind === 'synced').length;
    world.events.length = 0;
  }
  assert.equal(n, 0, `a→b、b→c 不是一对，40 秒里却响了 ${n} 记`);
});

// ---- 亲属容忍（spec §4.8/§4.12："更容忍亲属靠近"）----
//
// 这条在 2026-10-29 之前**没有生产者**：碰撞结算对所有个体一视同仁，perceive 也不按 kinship
// 放宽距离。判据必须两样同时测：推开得更少（身体）与好感罚更轻（关系）——
// 只测前者的话，一个"推得少但照样记仇"的实现会全绿。

function overlapWorld(related) {
  const world = createWorld({ seed: 41, initialCreatures: 2 });
  const [a, b] = world.creatures;
  a.pos.x = 0.5; a.pos.y = 0.5;
  b.pos.x = 0.5 + 1e-5; b.pos.y = 0.5;      // 几乎完全重叠（d > 1e-6，会进碰撞分支）
  for (const c of [a, b]) {
    c.vel.x = 0; c.vel.y = 0; c.moving = false;
    c.intent = { kind: 'rest', minDuration: 1e6 };
    c.intentTime = 0;
  }
  if (related) {
    ensure(a.memory, b.id, { kinship: KINSHIP.mother, role: 'mother' });
    ensure(b.memory, a.id, { kinship: KINSHIP.mother, role: 'offspring' });
  }
  return { world, a, b };
}

test('亲属更容忍靠近：同样重叠的一对，亲人被推开得更少、好感罚也更轻', () => {
  const kinRun = overlapWorld(true);
  const strangerRun = overlapWorld(false);
  tickWorld(kinRun.world, CONFIG.fixedDt);
  tickWorld(strangerRun.world, CONFIG.fixedDt);

  const distOf = ({ a, b }) => Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
  const kinDist = distOf(kinRun);
  const strangerDist = distOf(strangerRun);
  assert.ok(strangerDist > 0, '对照组必须先真的被推开，否则这条测试什么都没测');
  assert.ok(Math.abs(kinDist / strangerDist - CONFIG.behavior.kinPushScale) < 0.05,
    `亲人被推开的距离应当是对照的 ${CONFIG.behavior.kinPushScale} 倍，实测 ${kinDist.toFixed(6)} vs ${strangerDist.toFixed(6)}`);

  const kinAff = affectionFor(kinRun.a.memory, kinRun.b.id);
  const strangerAff = affectionFor(strangerRun.a.memory, strangerRun.b.id);
  assert.ok(strangerAff < 0, '陌生人撞一下必须掉好感（对照）');
  assert.ok(kinAff > strangerAff, `亲属掉得必须更少：${kinAff} vs ${strangerAff}`);
  assert.ok(Math.abs(kinAff - strangerAff * CONFIG.behavior.kinBumpScale) < 1e-9,
    `亲属的好感罚应当是对照的 ${CONFIG.behavior.kinBumpScale} 倍：${kinAff} vs ${strangerAff}`);
  // 反向：完全无亲缘（默认 0）的一对**不许**吃这个折扣 —— 上面两组之外的第三组，
  // 否则"kinship > 0 才打折"这条条件本身没被验过。
  const plain = overlapWorld(false);
  tickWorld(plain.world, CONFIG.fixedDt);
  assert.equal(affectionFor(plain.a.memory, plain.b.id), strangerAff, '无亲缘的对照组之间必须一致');
});
