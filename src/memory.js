// memory.js —— 关系记忆：好感累积、指数淡忘、容量淘汰、亲缘系数。
//
// 模块级契约（Task 8 / Task 9 / Task 10 是主要消费者，动这个文件之前先读）：
//
// 1. **affection 住在这里，不在情绪向量里。** spec 4.5 的注意事项写得很明确：
//    情绪恰好六个分量（joy anger fear curiosity sleepy arousal），而"依恋谁"
//    本质上是关于**一段关系**的，不是关于当下状态的，所以它是 memory 里针对
//    特定对象的关系性数值。Task 9 的卖萌触发读的就是这里的
//    affectionFor(memory, PLAYER_ID)，不是任何情绪分量。
//
// 2. mutator —— decay / prune / remember —— 都**原地修改**传入的 memory 对象，
//    并且**返回 undefined**，与 src/needs.js、src/emotions.js 的形状一致。
//    所以调用方必须写：
//
//      decay(c.memory, dt);                 // ✅ memory 被就地推进
//      c.memory = decay(c.memory, dt);      // ❌ c.memory 变成 undefined
//
//    ensure / adjust 是同一约定的**例外**：它们也原地改，但返回那条 MemoryEntry，
//    因为调用方常常紧接着就要读它（const e = adjust(m, id, d)）。
//    这条差异由测试 'mutator 约定：decay / prune / remember 原地改并返回
//    undefined，只读函数不改入参' 钉住。
//
// 3. 只有 createMemory() 会产生新对象；get / affectionFor / familiarityFor /
//    kinshipBetween 是纯读函数，不修改入参。模块本身**无状态** ——
//    没有任何模块级可变量，两只生物的记忆互不渗透。
//
// 4. MemoryEntry 恒为五个键：{ id, familiarity, affection, kinship, role }。
//    remember() 的入参**必须五个键齐全**：它用 {...entry} 原样拷贝，不做补全，
//    缺键的后果全部静默（以下均已实测）：
//      缺 role     → e.role 是 undefined，而亲属判定是 e.role !== null，
//                    undefined !== null 为真 → 被误当亲属、走慢十倍的速率：
//                    0.9 经 10 秒得 0.8821788 而不是 0.7368577。
//      缺 kinship  → undefined >= 0.25 为 false → 本该慢衰减的祖孙/表亲
//                    按普通速率被忘掉。
//      缺数值键    → `e.affection *= f` 是读-改-写，undefined * f = NaN，
//                    而 clamp 的两个比较对 NaN 都是 false，NaN 会原样穿过。
//                    更糟的是它会被存盘洗白：JSON.stringify 把 NaN 写成 null，
//                    读回来 null * f = 0 —— 一段恩怨无声无息地归零。
//    所以 Task 6 的存档层必须逐条校验五个键齐全且为有限数，不能信任文件内容。
import { CONFIG } from './config.js';

export const PLAYER_ID = 'PLAYER';

// 两个导出常量都**冻结**，纪律来自 Task 2 复查：src/genes.js 的 PATTERNS 曾被
// 别处 .reverse() 静默重排，后果是所有生物的花纹错位而没有任何一处抛错。
// KINSHIP 被改写的后果更隐蔽：KINSHIP.mate = 0.5 会让繁殖过的两只从此被判成
// 近亲、绝不再求偶 —— 种群静默绝育。
// 注意：**摘掉 Object.freeze 不会让任何 deepEqual 内容断言变红**（deepEqual
// 比内容与原型，不比可变性），所以冻结本身由测试
// 'ROLES 与 KINSHIP 被冻结，且冻结这件事本身被钉住' 单独钉住。
export const ROLES = Object.freeze(['mother', 'father', 'sibling', 'mate', 'offspring']);

// 亲缘系数用于近亲回避（spec 4.12 第 5 条：kinship > 0.25 绝不进入求偶）。
// mate 为 0 —— 配偶没有血缘关系，不能因为"它是我伴侣"就误判为近亲而拒绝交配。
// 于是"伴侣不被遗忘"与"伴侣可以繁殖"这两件事走**两条独立通道**：
// 前者看 role（见 decay），后者只看 kinship（见 Task 8）。
// 这个分工由测试 'role 为 mate 走慢衰减，但 kinship 仍是 0（Task 8 的近亲
// 回避不得拦住配偶）' 钉住。
//
// 查表警告：KINSHIP 是朴素对象字面量，原型键在它上面解析成 **truthy 的继承值**
// （KINSHIP['constructor'] 是函数），所以 `if (!KINSHIP[role])` 挡不住它们。
// 按 role 查表的调用方必须用 Object.hasOwn(KINSHIP, role)，或先用 ROLES 判成员
// 资格。这与 src/emotions.js 的 applyEvent 用 Object.hasOwn 拒绝 'toString'
// 是同一类决定。
export const KINSHIP = Object.freeze({
  mother: 0.5, father: 0.5, sibling: 0.5, offspring: 0.5,
  grandparent: 0.25, grandchild: 0.25, halfSibling: 0.25,
  mate: 0,
});

// 与 needs.js / emotions.js 的 clamp01 同型：两个比较对 NaN 都是 false，
// 所以 NaN 会**原样穿过**。这里刻意不加逐调用的有限性守卫（60Hz × 24 只生物的
// 热路径上白付开销），改由长跑测试
// '长跑（5 分钟 @60Hz，固定种子驱动）后所有条目有限、在范围内、容量不越界'
// 兜住整体不变量；跨模块累积仍由 Task 10 的收尾断言负责。
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createMemory() {
  return { entries: [] };
}

// 线性扫描而不是 Record<id, entry> 索引：容量上限是 12，扫描成本可以忽略，
// 而索引会让 'toString' / 'constructor' / '__proto__' 这类 id 解析成继承值。
// 这个选择由测试 'id 是普通字符串：原型链键名不会被误当成已有记录' 钉住。
export function get(memory, id) {
  for (const e of memory.entries) if (e.id === id) return e;
  return null;
}

// 幂等：已存在则返回原记录，且不用 opts 覆盖已有的 kinship / role。
// 覆盖会毁掉"它是它妈妈"这类一旦确立就不该再变的关系。
export function ensure(memory, id, opts) {
  const existing = get(memory, id);
  if (existing) return existing;
  const entry = {
    id,
    familiarity: 0,
    affection: 0,
    kinship: opts && opts.kinship !== undefined ? opts.kinship : 0,
    role: opts && opts.role !== undefined ? opts.role : null,
  };
  memory.entries.push(entry);
  // 保护刚建立的这条：新记录的 familiarity 是 0，
  // 若不保护，记忆满时"第一次见面"会被自己挤掉 —— 它将永远记不住任何新个体。
  // 最尖锐的形式（旧条目全部 familiarity = 1、新条目 0）由测试
  // '记忆满时新建的条目一定留下（哪怕所有旧条目 familiarity 都是 1）' 钉住。
  prune(memory, id);
  return entry;
}

// dFamiliarity 默认 0.05：绝大多数互动（喂食、抚摸、撞击）都会同时加深熟悉度，
// 所以给个默认值省得每个调用点都写；只有"纯好感变化、不该更熟悉"的场合
// （例如读档后的修正）才显式传 0。
export function adjust(memory, id, dAffection, dFamiliarity = 0.05) {
  const e = ensure(memory, id);
  e.affection = clamp(e.affection + dAffection, -1, 1);
  e.familiarity = clamp(e.familiarity + dFamiliarity, 0, 1);
  return e;
}

export function affectionFor(memory, id) {
  const e = get(memory, id);
  return e ? e.affection : 0;
}

export function familiarityFor(memory, id) {
  const e = get(memory, id);
  return e ? e.familiarity : 0;
}

export function kinshipBetween(memory, id) {
  const e = get(memory, id);
  return e ? e.kinship : 0;
}

// 指数衰减：affection *= exp(-rate * dt)
//
// 用 exp 而非 (1 - rate*dt)，才能做到与时间步长严格无关 ——
// 这是"手机 120Hz 与电脑 60Hz 下恩怨淡化速度一致"的数学保证，
// 也是共享存档在两台设备间不会漂移的前提。
//
// 这一点是**实测过的**，不是散文：30 秒时程下 dt = 1/60、1/30、0.5 三种步长
// 两两之差 ≤ 4.42e-14（断言容差 1e-9）；同样条件下把公式换成 (1 - rate*dt)，
// 最细与最粗之差是 9.6006e-4 —— 容差的 960060 倍，当场变红。
// 见测试 'decay 的步长无关性在长时程、三种步长、严格内部值下都成立'。
// 对照：src/emotions.js 的 update 是 brief 指定的前向欧拉，**不具**步长无关性，
// 那是刻意的，两者不要互相"修正"。
//
// 乘法衰减还天然保持符号：好感不会从正翻负，也不会越过 0 反弹。
// 逐步单调性由测试 'decay 让好感幅度单调收缩、不越零、不振荡（600 步逐步检查）' 钉住。
//
// 亲属与伴侣用慢得多的速率（近乎不忘），见 spec 4.8。判定是两条通道之一：
//   e.role !== null      —— 母子 / 父子 / 同胞 / 伴侣，关系一旦确立就慢衰减
//   e.kinship >= 0.25    —— 没有角色但有血缘（表亲、祖孙），同样慢衰减
// 阈值两侧（恰好 0.25 与 0.24）都由测试 'kinship 阈值两侧都被钉住：恰好 0.25
// 走慢衰减，0.24 走快衰减' 用字面量钉住。
//
// 速率量级（CONFIG 的「记忆」段）已被字面量钉住，半衰期实测为：
//   affectionDecay    0.02  → 普通好感   34.657 秒减半
//   affectionDecayKin 0.002 → 亲属好感  346.574 秒减半（慢 10 倍）
//   familiarityDecay  0.004 → 熟悉度    173.287 秒减半（没有亲属变体）
export function decay(memory, dt) {
  for (const e of memory.entries) {
    const isKin = e.role !== null || e.kinship >= 0.25;
    const affRate = isKin ? CONFIG.affectionDecayKin : CONFIG.affectionDecay;
    e.affection *= Math.exp(-affRate * dt);
    e.familiarity *= Math.exp(-CONFIG.familiarityDecay * dt);
  }
}

// 超出容量时淘汰 familiarity 最低的。
// "遗忘"本身就是真实的：多代之后不可能记住每一只先祖。
// 这同时也是内存上界 —— 种群再大，每只的记忆开销恒定（12 条）。
//
// protectId：本次淘汰中豁免的条目。ensure() 传入新建条目的 id，
// 否则新记录（familiarity 0）会在被记住之前就立刻被淘汰掉。
// 这个形参由测试 'prune 的 protectId 参数真的豁免那一条（直接调用，不经
// ensure）' 直接演练 —— 构造的正是"被保护者恰好是全场最低"这种对立情形，
// 删掉豁免逻辑或把淘汰方向反转成"淘汰最高"都会当场变红。
//
// 注意两条路径的行为差异（brief 如此规定，此处如实记录）：
//   传 protectId → 只精确移除一条，用于 ensure 的逐条增长；
//   不传         → 按 familiarity 降序排序后截断到 12，用于 remember / 读档，
//                  可能一次移除多条。排序会**重排 entries 的顺序**，
//                  但顺序不承载语义（get 是线性扫描）。
export function prune(memory, protectId) {
  if (memory.entries.length <= CONFIG.memoryCapacity) return;
  const protectedEntry = protectId === undefined ? null : get(memory, protectId);
  if (protectedEntry) {
    // 精确移除"未被豁免的条目里 familiarity 最低的那条"。
    // 不做整体排序截断 —— 那会把刚建立的记录一起排到末尾再切掉。
    // 并列时取先遇到的那条；并列的取舍不是 spec 规定的行为，故不钉住。
    let victim = null;
    for (const e of memory.entries) {
      if (e === protectedEntry) continue;
      if (victim === null || e.familiarity < victim.familiarity) victim = e;
    }
    if (victim) {
      memory.entries.splice(memory.entries.indexOf(victim), 1);
      return;
    }
  }
  // 无豁免（或全部都是被豁免的）时，按 familiarity 降序保留前 N 条。
  // entries 的顺序不承载语义 —— get() 是线性扫描，这里排序只为截断。
  memory.entries.sort((a, b) => b.familiarity - a.familiarity);
  memory.entries.length = CONFIG.memoryCapacity;
}

// 存档恢复用：直接写入一条完整记录，同 id 覆盖。
// 必须拷贝（{...entry}）而不是持有引用，否则存档对象与运行时状态
// 会共享同一个对象，序列化时机不同就会写出不一致的数据。
// 覆盖已存在的条目时是**原地改字段**而不是替换对象，这样调用方局部变量里
// 持有的旧引用仍然有效 —— 由测试 'remember 覆盖同 id 时原地更新（持有旧引用
// 的调用方不会失效）' 钉住。
// 入参五个键必须齐全，见模块头第 4 条。
export function remember(memory, entry) {
  const existing = get(memory, entry.id);
  if (existing) {
    existing.familiarity = entry.familiarity;
    existing.affection = entry.affection;
    existing.kinship = entry.kinship;
    existing.role = entry.role;
    return;
  }
  memory.entries.push({ ...entry });
  prune(memory);
}
