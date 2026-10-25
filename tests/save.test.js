// Task A8：存档 v1 → v2 迁移（spec §7.2 末）。
//
// 迁移是那种"做错了没有任何症状"的代码：旧档读进来照样跑，只是所有个体的性格
// 悄悄趋同、或者某只生物在画面上凭空消失（sizeOf 变 NaN）。
// 所以这里的每一条断言都在盯**静默失败**，而不是盯报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { ALL_GENES, randomGenome, decode } from '../src/genes.js';
import { createRng } from '../src/rng.js';
import { assertColorStop } from './ctx-stub.js';
import { SAVE_VERSION, migrate, assertCreatureShape } from '../src/save.js';
import { ROLES } from '../src/memory.js';
import { createWorld, tickWorld, addCreature } from '../src/sim.js';

// 一份**v1 形状**的旧档：14 个位点（缺 fluff / eggTint / activity / talk / intellect / broody / ...）、
// 没有 catchphrase、没有 heard、没有 eggBoost、卵没有 eggSize / eggTint。
const V1_GENES = ['hue', 'sat', 'pattern', 'size', 'glow', 'blush', 'eye', 'body'];
const v1Doc = (over = {}) => ({
  version: 1,
  revision: 3,
  savedAt: '2026-10-14T10:00:00Z',
  world: { seed: 12345, time: 900 },
  creatures: [
    {
      id: 'c1', name: '泡泡', customName: false, generation: 2,
      stage: 'juvenile', age: 214.5, alive: true, sick: false,
      genes: Object.fromEntries(V1_GENES.map((g) => [g, [0.4, 0.7]])),
      needs: { hunger: 0.2, energy: 0.4, social: 0.1, safety: 0.05 },
      emotions: { joy: 0.6, anger: 0, fear: 0.1, curiosity: 0.3, sleepy: 0.2, arousal: 0 },
      pos: { x: 0.4, y: 0.6 }, vel: { x: 0, y: 0 },
      memory: [{ id: 'c2', familiarity: 0.8, affection: 0.5, kinship: 0.5, role: 'sibling' }],
      lineage: { mother: 'c0', father: 'c9', offspring: [] },
    },
    {
      id: 'c2', name: '团团', customName: false, generation: 2,
      stage: 'juvenile', age: 200, alive: true, sick: false,
      genes: Object.fromEntries(V1_GENES.map((g) => [g, [0.4, 0.7]])),
      needs: { hunger: 0.2, energy: 0.4, social: 0.1, safety: 0.05 },
      emotions: { joy: 0.6, anger: 0, fear: 0.1, curiosity: 0.3, sleepy: 0.2, arousal: 0 },
      pos: { x: 0.5, y: 0.6 }, vel: { x: 0, y: 0 },
      memory: [],
      lineage: { mother: 'c0', father: null, offspring: [] },
    },
  ],
  eggs: [{ id: 'e1', motherId: 'c1', age: 12, pos: { x: 0.3, y: 0.95 },
           genes: Object.fromEntries(ALL_GENES.map((g) => [g, [0.5, 0.5]])) }],
  stats: { births: 12, deaths: 3, generation: 4, hatchFailures: 0 },
  ...over,
});

test('SAVE_VERSION 是 2，且 v1 档被升到 2', () => {
  assert.equal(SAVE_VERSION, 2);
  assert.equal(migrate(v1Doc()).version, 2);
});

test('新增位点用 rng(seed + id) 派生：同一份旧档迁移两次逐位相同', () => {
  // 可复现性是这整个项目的地基（spec 8.1）。迁移若用 Math.random，
  // 同一份存档在两台设备上会长成两个不同的缸 —— 而 §7 的整个"多设备共享"就废了。
  const a = migrate(v1Doc());
  const b = migrate(v1Doc());
  assert.deepEqual(a, b, '迁移必须是纯函数');
  for (const g of ALL_GENES) {
    assert.deepEqual(a.creatures[0].genes[g], b.creatures[0].genes[g], `${g} 两次迁移不一致`);
    assert.equal(a.creatures[0].catchphrase, b.creatures[0].catchphrase);
  }
});

test('迁移**不取默认值**：两只基因完全相同的旧个体，迁移后新位点必须不同', () => {
  // 这条是本次最容易做错、也**最没有症状**的一处。
  // v1 里两只 c1 / c2 的八条位点被写成一模一样的 [0.4, 0.7]（就是为了让这条能区分），
  // 若实现给新位点填默认值（比如一律 0.5），迁移后它们仍然完全相同 ——
  // 缸照常跑，只是"每只都不一样"这件事悄悄没了。
  const m = migrate(v1Doc());
  const [x, y] = m.creatures;
  const same = ALL_GENES.filter((g) => JSON.stringify(x.genes[g]) === JSON.stringify(y.genes[g]));
  assert.ok(same.length < ALL_GENES.length,
    '两只旧个体的全部位点迁移后仍两两相同 ⇒ 新位点是取默认值而不是派生的');
  // 而且旧的八条**一个都不许被动过**（迁移不该顺手"修正"已有数值）
  for (const g of V1_GENES) {
    assert.deepEqual(x.genes[g], [0.4, 0.7], `${g} 是旧档里就有的位点，不许改`);
  }
  assert.notEqual(x.catchphrase, undefined, 'catchphrase 必须补上');
  assert.notEqual(y.catchphrase, undefined);
});

test('father 键在旧档非 null 时原样保留（那是历史事实，不是待清理的脏数据）', () => {
  const m = migrate(v1Doc());
  assert.equal(m.creatures[0].lineage.father, 'c9', '孤雌制删的是"未来会有父亲"，不是"过去有过父亲"');
  assert.equal(m.creatures[1].lineage.father, null);
});

test('heard / speech / eggBoost / broodT / begIgnored 缺失时补齐，且补的是可参与运算的值', () => {
  const m = migrate(v1Doc());
  for (const c of m.creatures) {
    assert.deepEqual(c.heard, []);
    assert.deepEqual(Object.keys(c.speech).sort(), ['lastTokens', 'nextAt']);
    // ⚠️ 这三个必须是**数**：undefined 会让 sizeOf 变 NaN，于是那只生物在画面上消失，
    // 而全程没有任何一处抛错（creature.sizeOf 的 || 0 只兜了 eggBoost 一个）。
    for (const k of ['eggBoost', 'broodT', 'begIgnored']) {
      assert.ok(Number.isFinite(c[k]), `${k} 必须是有限数，收到 ${String(c[k])}`);
    }
  }
});

test('卵补 eggSize / eggTint / viable：缺 eggSize 会让 hatch 算出 NaN 的 eggBoost', () => {
  const m = migrate(v1Doc());
  const e = m.eggs[0];
  assert.ok(Number.isFinite(e.eggSize), 'eggSize 必须是有限数');
  assert.ok(e.eggSize >= CONFIG.eggSize.min && e.eggSize <= CONFIG.eggSize.max,
    `eggSize 越界：${e.eggSize}`);
  assert.ok(CONFIG.eggTint.colors.includes(e.eggTint), `非法蛋色 ${e.eggTint}`);
  assert.equal(e.viable, true);
  // 派生而非固定：两枚旧卵不该拿到一模一样的大小
  const two = v1Doc();
  two.eggs.push({ ...two.eggs[0], id: 'e2' });
  const m2 = migrate(two);
  assert.notEqual(m2.eggs[0].eggSize, m2.eggs[1].eggSize, '两枚卵的 eggSize 相同 ⇒ 迁移在取默认值');
});

test('漂入时钟与新增统计补齐，nextDriftAt 不被填成 0（那会让读档第一 tick 就漂入）', () => {
  const m = migrate(v1Doc());
  assert.equal(m.world.driftInterval, CONFIG.drift.interval);
  assert.equal(m.world.nextDriftAt, 900 + CONFIG.drift.interval, '应给"从现在起一个间隔后"，不是立刻');
  assert.deepEqual(m.stats, { ...m.stats, driftIns: 0, emigrations: 0, said: 0 });
});

test('traits 与 thresholds 由 genes 重建，而不是从旧档读', () => {
  // 存档的真相只有 genes。存派生态等于存两份会各自漂移的东西（spec §7.2 的反面推论），
  // 而 v1 档里本来就没有这两个字段 —— 不重建的话读档第一 tick 就抛
  // "Cannot read properties of undefined (reading 'size')"（实测踩到的）。
  const m = migrate(v1Doc());
  for (const c of m.creatures) {
    assert.ok(c.traits && typeof c.traits === 'object', 'traits 必须重建出来');
    assert.ok(Number.isFinite(c.traits.size), `traits.size 必须是数，收到 ${String(c.traits.size)}`);
    assert.ok(c.thresholds && Number.isFinite(c.thresholds.hopWeight), 'thresholds 必须由性格算出');
    assert.deepEqual(Object.keys(c.thresholds).sort(), [
      'angerDuration', 'angerThreshold', 'broodInterval', 'energyDrainFactor', 'exploreRadius',
      'fearThreshold', 'heardCapacity', 'hopMinDuration', 'hopWeight', 'hungerTrigger',
      'misspeakChance', 'playerApproach', 'socialTrigger', 'speechCooldown', 'turnRate',
    ], '阈值表必须与 personality.thresholds 的当前形状一致');
    assert.ok(Array.isArray(c.lineage.mates), 'lineage.mates 缺失时补空数组（layEggs 会 push 它）');
  }
});

test('迁移不得污染调用方的原档（返回新对象）', () => {
  const doc = v1Doc();
  const before = structuredClone(doc);
  migrate(doc);
  assert.deepEqual(doc, before, 'migrate 直接改入参的话，迁移失败时原档已经被破坏了');
});

test('比本程序新的版本抛错，而不是静默降级', () => {
  assert.throws(() => migrate({ version: 99, creatures: [] }), /比本程序支持的/);
  assert.throws(() => migrate(null), TypeError);
  assert.throws(() => migrate({ version: 1 }), /creatures/);
  assert.throws(() => migrate({ version: 1, creatures: [null] }), TypeError);
  assert.throws(() => migrate({ version: 1, creatures: [{ genes: {} }] }), /id/);
});

test('assertCreatureShape 挡住缺字段与脏 role（remember() 的门绕不过读档路径）', () => {
  const m = migrate(v1Doc());
  assert.equal(assertCreatureShape(m.creatures[0]), true, '正常迁移结果应通过自检');
  const bad1 = structuredClone(m.creatures[0]);
  delete bad1.memory.entries[0].affection;
  assert.throws(() => assertCreatureShape(bad1), /affection/);
  const bad2 = structuredClone(m.creatures[0]);
  bad2.memory.entries[0].role = 'wife';
  assert.throws(() => assertCreatureShape(bad2), /role/);
  const bad3 = structuredClone(m.creatures[0]);
  bad3.memory.entries[0].kinship = '0.5';          // 字符串在 JSON 里合法，运算时变 NaN
  assert.throws(() => assertCreatureShape(bad3), /kinship/);
  const bad4 = structuredClone(m.creatures[0]);
  bad4.memory = [];                                // 没迁移过的裸数组形状
  assert.throws(() => assertCreatureShape(bad4), /entries/);
  assert.ok(!ROLES.includes('wife'), '前置条件：这个 role 确实是脏的');

  // ---- 基因那一半（F-17，2026-10-25）----
  // bad3 那条的理由在基因上同样成立，而后果大一档：记忆里的 NaN 只是"它好像不认识我了"，
  // 基因里的 NaN 会穿过 decode 变成 hue=NaN，再变成 'hsla(NaN, 70%, 73%, 0.95)' 喂给
  // addColorStop —— 真浏览器在那里**当场抛**，于是读档之后每一帧都飞（清单 §12.11 实测表）。
  const bad5 = structuredClone(m.creatures[0]);
  bad5.genes.hue = [0.5];                          // 短数组：alleles[1] 是 undefined → NaN
  assert.throws(() => assertCreatureShape(bad5), /hue/);
  const bad6 = structuredClone(m.creatures[0]);
  bad6.genes.sat = 0.4;                            // 不是等位基因对，而是一个裸数
  assert.throws(() => assertCreatureShape(bad6), /sat/);
  const bad7 = structuredClone(m.creatures[0]);
  bad7.genes.size = ['0.2', 0.7];                  // 字符串在 JSON 里合法，乘法里变 NaN
  assert.throws(() => assertCreatureShape(bad7), /size/);
});

test('基因脏 → decode 出 NaN → 颜色串被 ctx 桩的域检查拦下（F-17 的因果链，不是推测）', () => {
  // 这条判据把两端接起来：上半是"这样的基因真的会算出 NaN hue"，
  // 下半是"NaN hue 真的会变成一个真浏览器要抛的串"。缺了下半，上一行注释就是断言不出来的说法。
  const g = randomGenome(createRng(7));
  g.hue = [0.5];
  const t = decode(g);
  assert.ok(!Number.isFinite(t.hue), `前置条件：短数组基因应当解码出 NaN hue，实测 ${t.hue}`);
  const h = (315 + t.hue * (70 / 360)) % 360;      // 与 decode 同一类线性映射，只为造一个串
  assert.throws(() => assertColorStop(0, `hsla(${h}, 70%, 73%, 0.95)`), /域检查/);
  // 反空对照：正常基因出来的串必须过得了同一道检查
  const ok = decode(randomGenome(createRng(8)));
  assertColorStop(0, `hsla(${ok.hue}, 70%, 73%, 0.95)`);
});


test('memory 的两种形状都接受：存档里是裸数组，运行时是 { entries }', () => {
  // 这一条守住"存档形状只有一个定义点"。若不在这里转换，每个调用方就得各写一次兼容，
  // 而漏写的那个的症状是 refreshKinMemory 抛 "memory.entries is not iterable"。
  const bare = v1Doc();
  const wrapped = v1Doc();
  wrapped.creatures[0].memory = { entries: bare.creatures[0].memory };
  const a = migrate(bare).creatures[0].memory;
  const b = migrate(wrapped).creatures[0].memory;
  assert.deepEqual(a, b, '两种入参形状必须收敛成同一个运行时形状');
  assert.ok(Array.isArray(a.entries), '输出必须是 { entries: [] }');
  assert.deepEqual(a.entries[0], { id: 'c2', familiarity: 0.8, affection: 0.5, kinship: 0.5, role: 'sibling' });
});

test('迁移出来的旧个体读回世界后仍能跑（形状兼容，不是一堆缺字段的数据）', () => {
  // 这条是整个文件的收口：上面各条钉的是字段，这条钉的是"这些字段拼起来还能用"。
  const m = migrate(v1Doc());
  const w = createWorld({ seed: 1, initialCreatures: 0 });
  for (const c of m.creatures) {
    addCreature(w, { ...c, intent: null, intentTime: 0, moving: false, resting: false });
  }
  for (let i = 0; i < 600; i++) tickWorld(w, 1 / 60);
  for (const c of w.creatures) {
    if (!c.alive) continue;
    for (const [k, v] of Object.entries(c.needs)) {
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `needs.${k} = ${v}`);
    }
    for (const [k, v] of Object.entries(c.emotions)) {
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `emotions.${k} = ${v}`);
    }
  }
});
