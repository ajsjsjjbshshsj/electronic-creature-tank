import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { PLAYER_ID, affectionFor, familiarityFor, get, ensure, KINSHIP } from '../src/memory.js';
import { createCreature } from '../src/creature.js';
import { layEggs } from '../src/breeding.js';
import { MIN_DURATION } from '../src/behavior.js';
import {
  createWorld, tickWorld, perceive, addCreature, spawnFood, aliveCreatures, worldStats,
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
  assert.equal(CONFIG.motion.courtshipFactor, 0.55);
  assert.equal(CONFIG.motion.facingLerp, 6);
  assert.equal(CONFIG.motion.wallMargin, 0.03);
  // 逃命必须比求偶快，否则"逃"这个意图在表现上等于没有
  assert.ok(CONFIG.motion.fleeFactor > 1, 'fleeFactor 是加速倍率，必须大于 1');
  assert.ok(CONFIG.motion.courtshipFactor < 1, '求偶应放慢，而不是加速');

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

test('courtshipOptions 只包含合法的求偶对象', () => {
  const w = createWorld({ seed: 19, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  const kid = createCreature({ id: 'kid', name: 'K', x: 0.6, y: 0.5, age: 10, rng: createRng(3) });
  for (const c of [a, b, kid]) addCreature(w, c);
  a.emotions.arousal = 0.9; b.emotions.arousal = 0.9;
  const options = perceive(w, a).courtshipOptions;
  const ids = options.filter((o) => o.score > 0).map((o) => o.id);
  assert.ok(ids.includes('b'), '成年个体 b 应是合法候选');
  assert.ok(!ids.includes('kid'), '幼体不该是候选');
  assert.ok(!ids.includes('a'), '不该把自己列为候选');
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

test('超过种群上限时求偶评分被压低而不是归零（spec 4.12 第 6 条：不得硬阻断）', () => {
  // spec 4.12 第 6 条要的是"达上限时表现为求偶评分被压低 + 卵不孵化"，
  // **不是**"不许求偶"。硬阻断（评分恰好 0）会穿帮：玩家看到的是"缸满了以后
  // 它们突然互相不理不睬"，而不是"它们还试，但总是失去兴趣"。
  // 这里同时钉住两侧：评分必须 > 0，且被压到 breeding 里那个 0.12 的下限。
  const mk = (cap) => {
    const w = createWorld({ seed: 50, initialCreatures: 0, populationCap: cap });
    w.foods.length = 0;
    const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
    const b = createCreature({ id: 'b', name: 'B', x: 0.53, y: 0.5, age: 600, rng: createRng(2) });
    for (const c of [a, b]) {
      addCreature(w, c);
      c.emotions.arousal = 0.9;
      c.needs.hunger = 0.1;
      c.needs.energy = 0.1;
    }
    return w;
  };
  const scoreOf = (w) => perceive(w, w.creatures[0]).courtshipOptions.find((o) => o.id === 'b').score;
  const below = scoreOf(mk(24));   // 2/24 = 8.3% 装载：crowding = 1
  const over = scoreOf(mk(1));     // 2/1 = 200% 装载：夹到 1，取 crowding 的下限

  assert.ok(below > 0, '前置条件：上限之下的求偶评分应大于 0');
  assert.ok(over > 0, '超过上限时不得把求偶评分硬压到 0（那就是 spec 4.12 第 6 条禁止的硬阻断）');
  assert.ok(Math.abs(over / below - 0.12) < 1e-12,
    `上限压力应把评分压到恰好 0.12 倍（breeding 的 crowding 下限），实际比值 ${over / below}`);
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
  //   arousal 目标值 = canBreed ? … : 0；而 courtshipScore 又要求双方 arousal >= 0.35
  //   ⇒ 谁也开不了头，全缸 arousal 恒为 0，永远不会求偶、永远没有后代，
  //     而且不报错、不抛异常 —— 症状只是"这个缸不生"。
  // 所以这里跑一个**没有任何手动赋值**的新缸，要求它自己走到产卵。
  const w = createWorld({ seed: 46 });
  const startArousal = aliveCreatures(w).map((c) => c.emotions.arousal);
  assert.deepEqual(startArousal, [0, 0, 0, 0], '前置条件：出生时 arousal 为 0');

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

test('孵化出的幼体记得父母，父母也记得孩子', () => {
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
  assert.ok(a.lineage.offspring.includes(baby.id), '母亲应记录子代');
  assert.ok(b.lineage.offspring.includes(baby.id), '父亲应记录子代');
  const momEntry = baby.memory.entries.find((e) => e.id === 'a');
  assert.ok(momEntry, '孩子应记得妈妈');
  assert.equal(momEntry.kinship, 0.5);
  assert.equal(a.lineage.mates.includes('b'), true, '双亲应互记为 mate');
});

test('同胞之间不会求偶（近亲回避在世界层面生效）', () => {
  const w = createWorld({ seed: 33, initialCreatures: 0 });
  const a = createCreature({ id: 'a', name: 'A', x: 0.5, y: 0.5, age: 600, rng: createRng(1) });
  const b = createCreature({ id: 'b', name: 'B', x: 0.55, y: 0.5, age: 600, rng: createRng(2) });
  for (const c of [a, b]) {
    addCreature(w, c);
    c.emotions.arousal = 0.95;
    c.needs.hunger = 0.05;
    c.needs.energy = 0.05;
  }
  for (let i = 0; i < 10; i++) spawnFood(w, 'nectar', { x: 0.5 + i * 0.01, y: 0.5 });
  step(w, 250);
  const babies = w.creatures.filter((c) => c.lineage.mother === 'a' && c.lineage.father === 'b');
  assert.ok(babies.length >= 2, `需要同胞才能验证近亲回避，实际 ${babies.length} 只`);
  // 把同胞都催成成体，看它们会不会互相求偶
  for (const kid of babies) { kid.age = 600; kid.stage = 'adult'; kid.emotions.arousal = 0.95; }
  w.eggs.length = 0;
  step(w, 200);
  const siblingEggs = w.eggs.filter(
    (e) => babies.some((k) => k.id === e.motherId) && babies.some((k) => k.id === e.fatherId),
  );
  assert.equal(siblingEggs.length, 0, '同胞之间绝不能产卵');
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
  const clutch = layEggs(a, b, createRng(9), { atPopulationCap: true });
  for (const egg of clutch) w.eggs.push(egg);

  step(w, 250);
  assert.equal(aliveCreatures(w).length, 2, '不得有新个体出现');
  assert.ok(w.stats.hatchFailures > 0, '应记录孵化失败（卵的光慢慢熄灭）');
  assert.equal(w.eggs.length, 0, '失败的卵应在熄灭后被清理掉');
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
    for (const egg of layEggs(a, b, createRng(100 + clutch), { atPopulationCap: true })) {
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
  // 孵化那条路径的上限已经在 layEggs 里通过 viable=false 把过关了，
  // 这里再查一次会有两个地方各自维护同一条规则，迟早打架。
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
