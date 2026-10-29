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
// KINSHIP 被改写的后果更隐蔽：KINSHIP.companion = 0.5 会让繁殖过的两只从此被判成
// 近亲、绝不再求偶 —— 种群静默绝育。
// 注意：**摘掉 Object.freeze 不会让任何 deepEqual 内容断言变红**（deepEqual
// 比内容与原型，不比可变性），所以冻结本身由测试
// 'ROLES 与 KINSHIP 被冻结，且冻结这件事本身被钉住' 单独钉住。
// 2026-10-20 孤雌：'mate' 改名 'companion'（长期凑在一起的社交伙伴）—— 这套繁殖里
// 没有配偶这个概念了，但**关系本身必须留着**，否则缸里只剩血亲一种关系。
// 'father' **保留**：存档 v1 的条目里 role 可能是 'father'，而 remember() 会校验
// role ∈ ROLES —— 删了它，旧档一读就抛错。没有生产者不等于可以删，这里就是例子。
export const ROLES = Object.freeze(['mother', 'father', 'sibling', 'companion', 'offspring']);

// 亲缘系数是**客观血缘事实**，与"它们关系多好"无关。
// companion 为 0 —— 伙伴没有血缘。于是"伙伴不被遗忘"与"伙伴不是亲属"走
// **两条独立通道**：前者看 role（见 decay 的慢衰减判定），后者只看 kinship。
// 2026-10-20：原来这段写的是"近亲回避（mate 为 0，配偶可以繁殖）"，
// 那个闸门已随孤雌制删除，但两条通道分开的结构原样保留 —— 它防的是
// "为了让某段关系不被遗忘而顺手把它的亲缘也调高"，这个诱惑一直都在。

// 亲缘系数用于近亲回避（spec 4.12 第 5 条：kinship > 0.25 绝不进入求偶）。
// mate 为 0 —— 配偶没有血缘关系，不能因为"它是我伴侣"就误判为近亲而拒绝交配。
// 于是"伴侣不被遗忘"与"伴侣可以繁殖"这两件事走**两条独立通道**：
// 前者看 role（见 decay），后者只看 kinship（见 Task 8）。
// 这个分工由测试 'role 为 companion 走慢衰减，但 kinship 仍是 0（原
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
  companion: 0,
});

// 与 needs.js / emotions.js 的 clamp01 同型：两个比较对 NaN 都是 false，
// 所以 NaN 会**原样穿过**。这里刻意不加逐调用的有限性守卫（60Hz × 24 只生物的
// 热路径上白付开销），改由长跑测试
// '长跑（5 分钟 @60Hz，固定种子驱动）后所有条目有限、在范围内、容量不越界'
// 兜住整体不变量；跨模块累积仍由 Task 10 的收尾断言负责。
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 记忆条目里必须是有限数的三个键（另两个是 id 字符串与 role 枚举/ null）。
// 刻意**不导出**：导出就要连带 Object.freeze 与冻结测试，而它只在 remember 内部用，
// 没有跨模块共享的需要 —— 不导出的常量不可能被别的任务就地改掉。
// 键集漂移由测试 '长跑之后每个条目仍是恰好五个键' 兜住：新增/删改键会先让那条变红。
const NUMERIC_ENTRY_KEYS = ['familiarity', 'affection', 'kinship'];

// ensure 的 opts 只接受这两个键，理由见 ensure 上方。同样刻意不导出。
const ENSURE_OPT_KEYS = ['kinship', 'role'];

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
//
// opts 只接受 kinship 与 role 两个键，**未知键抛错而不是静默丢弃**。
// 这不是洁癖：Task 8 会在这里写入亲缘关系，而拼错的键（'kinShip'、'Kinship'、
// 'relationship'）如果被静默忽略，kinship 就停在默认 0 ——
// 于是 `kinship > 0.25` 的近亲回避**静默失效**，兄妹可以互相求偶，
// 而整条链路上没有任何一处报错。症状只是"后代越来越奇怪"。
export function ensure(memory, id, opts) {
  const existing = get(memory, id);
  if (existing) return existing;
  if (opts !== undefined && opts !== null) {
    // Object.keys 只取自有键，所以原型键不会被误当成未知键报出来。
    for (const key of Object.keys(opts)) {
      if (!ENSURE_OPT_KEYS.includes(key)) {
        throw new TypeError(
          `ensure: 未知的 opts 键 "${key}"（只接受 ${ENSURE_OPT_KEYS.join(' / ')}）。` +
          '静默丢弃会让 kinship 停在 0，进而让近亲回避失效。',
        );
      }
    }
  }
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
// 这个 0.05 由测试 'adjust 的默认 familiarity 增量是 0.05（字面量钉住，不是 > 0）'
// 用硬编码字面量钉住 —— 任何正数都能通过 `> 0`，包括 0.9（那会把熟悉度一步推到
// 饱和，抹掉"要互动多次才熟络"的节奏），所以必须钉精确值。
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

// ---- companion（spec §4.8：长期凑在一起、会自发同步脉动的那只）----
// 生产者在 sim.js 的 tickSocial（2026-10-27）；在此之前这个 role 全仓**没有一处会写**，
// 于是家谱的伙伴虚线与信息卡的"同伴"行恒为空（清单 §17.3 如实记过这一条）。
//
// 三个函数各只管一件事，合起来是设计文档的裁定 3：
//   · 至多一个伙伴；· 血缘优先，永不覆盖；· 换人要先把旧的 demote 掉。
// "占位者是否还活着"要读世界，所以那半步判在 sim.js（promoteIfNeeded），不在这里 ——
// 本模块不认识 world，这是它保持纯数据层的原因。
export function companionOf(memory) {
  for (const e of memory.entries) if (e.role === 'companion') return e;
  return null;
}

// 幂等且**不覆盖**：与 ensure 不覆盖已有 kinship/role 同一条纪律 ——
// "它是它妈妈"这条事实不该被社交改写成"它是它伙伴"。
// 已有别的伙伴时返回 false：唯一性在这里守，不靠调用方自觉。
export function promoteCompanion(memory, id) {
  const cur = companionOf(memory);
  if (cur !== null && cur.id !== id) return false;
  const e = ensure(memory, id);
  if (e.role !== null) return false;
  e.role = 'companion';
  return true;
}

// 只 demote 伙伴。条目不存在时返回 false 且**不新建**：
// 顺手 ensure 会让"查一下"变成"记一笔"，那是记忆层最不该有的副作用。
export function demoteCompanion(memory, id) {
  const e = get(memory, id);
  if (!e || e.role !== 'companion') return false;
  e.role = null;
  return true;
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
//
// **玩家那条的 familiarity 不衰减**（好感仍照常衰减）—— 这是 spec §4.8 内部
// 一处冲突经人类裁定后的结果，不是实现方的即兴发挥：
//   §4.8 既说对玩家的记忆是"回到电脑上它还认得你"的实现基础，
//   又说"容量上限 12 条，超出时淘汰 familiarity 最低的"，且未豁免玩家。
//   两者在长会话里冲突：熟悉度半衰期 173 秒，在热闹的缸里玩家十几分钟不互动，
//   玩家那条就会成为淘汰候选 → 这只生物把玩家整个忘掉，
//   之后 memory[PLAYER] 被当作全新关系重建（affection 从 0 开始），
//   于是"卖萌"（依赖 memory[PLAYER].affection 高）也失去依据。
//   离线期间不受影响 —— 验收标准 #5 规定离开时世界冻结、不推进。
// 裁定（人类选定）：**豁免 familiarity 的衰减与淘汰，但好感照常淡化。**
// 语义上这样最自洽，正好用上这个结构已有的两个字段：
//   familiarity = 熟悉度（认得你是谁）→ 应当持久
//   affection   = 好感（此刻对你什么感觉）→ 按 spec「恩怨会淡忘」
// 所以玩家那条的 affection 仍走普通速率（role 为 null、kinship 为 0 ⇒ 非亲属）。
// 由测试 '玩家那条的 familiarity 不衰减，但好感照常衰减' 钉住。
export function decay(memory, dt) {
  for (const e of memory.entries) {
    const isKin = e.role !== null || e.kinship >= 0.25;
    const affRate = isKin ? CONFIG.affectionDecayKin : CONFIG.affectionDecay;
    e.affection *= Math.exp(-affRate * dt);
    // 只有玩家被豁免 familiarity 衰减；其余（含亲属）一律照常。
    if (e.id !== PLAYER_ID) {
      e.familiarity *= Math.exp(-CONFIG.familiarityDecay * dt);
    }
  }
}

// 超出容量时淘汰 familiarity 最低的。
// "遗忘"本身就是真实的：多代之后不可能记住每一只先祖。
// 这同时也是内存上界 —— 种群再大，每只的记忆开销恒定（12 条）。
//
// **玩家那条（PLAYER_ID）永不淘汰**，两条路径都豁免。理由见 decay 上方的裁定说明：
// 玩家被整个忘掉会让"它还认得你"与"卖萌"一起失去依据。
// 容量上限**不因此松动** —— 永不少留，只是换一个人被忘掉。
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
  // 玩家那条与本次的 protectId 一样，都不是淘汰候选。两条路径共用这一个判定，
  // 避免"只改了其中一条路径"这种很容易漏的缺陷（测试对两条路径分别钉住）。
  const playerEntry = get(memory, PLAYER_ID);
  const isExempt = (e) => e === protectedEntry || (playerEntry !== null && e === playerEntry);
  if (protectedEntry) {
    // 精确移除"未被豁免的条目里 familiarity 最低的那条"。
    // 不做整体排序截断 —— 那会把刚建立的记录一起排到末尾再切掉。
    // 并列时取先遇到的那条；并列的取舍不是 spec 规定的行为，故不钉住。
    let victim = null;
    for (const e of memory.entries) {
      if (isExempt(e)) continue;
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
  // 玩家那条若本该被截掉，就把它换进保留区的最后一格，替掉那里原本的一条。
  // 用交换而不是"先删玩家再截断再插回"，是为了不改变数组长度语义、
  // 也不让玩家那条的**对象引用**失效（adjust 等调用方可能正持有它）。
  if (playerEntry && !memory.entries.slice(0, CONFIG.memoryCapacity).includes(playerEntry)) {
    const lastKept = CONFIG.memoryCapacity - 1;
    const playerIndex = memory.entries.indexOf(playerEntry);
    const displaced = memory.entries[lastKept];
    memory.entries[lastKept] = playerEntry;
    memory.entries[playerIndex] = displaced;
  }
  memory.entries.length = CONFIG.memoryCapacity;
}

// 存档恢复用：直接写入一条完整记录，同 id 覆盖。
// 必须拷贝（{...entry}）而不是持有引用，否则存档对象与运行时状态
// 会共享同一个对象，序列化时机不同就会写出不一致的数据。
// 覆盖已存在的条目时是**原地改字段**而不是替换对象，这样调用方局部变量里
// 持有的旧引用仍然有效 —— 由测试 'remember 覆盖同 id 时原地更新（持有旧引用
// 的调用方不会失效）' 钉住。
//
// 入参五个键必须齐全且数值有限 —— 这一条由下面的校验**强制执行**，
// 不只是注释里的期望（模块头第 4 条）。
//
// 为什么校验必须在这里，而不是留给调用方小心：
// 这是整个模拟核里唯一一个输入可能来自磁盘上任意字节的入口 ——
// Plan 3 会把 JSON.parse 的结果直接灌进来。而缺字段的后果是**静默**的：
//   存档少写 familiarity → undefined
//   → undefined *= exp(...) 得 NaN
//   → decay 之后 affection/familiarity 都是 NaN
//   → JSON.stringify 把 NaN 写成 null，读回来变成 0
// 于是"存档里少一个字段"最终表现为"这条关系的好感是 0"，
// 全程没有一处报错，玩家看到的只是"它好像不认识我了"。
// NaN 还会让 prune 的排序比较器 b.familiarity - a.familiarity 返回 NaN，
// 使淘汰顺序变得不可预测。
// 与本模块其余部分、以及本项目已确立的契约一致：非法输入要抛错，
// 不要静默降级（对照 rng.pick([]) 抛错、emotions.applyEvent 对原型键抛错）。
export function remember(memory, entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError(
      `remember: 记忆条目必须是对象，收到 ${entry === null ? 'null' : typeof entry}`,
    );
  }
  if (typeof entry.id !== 'string' || entry.id === '') {
    throw new TypeError(`remember: 记忆条目的 id 必须是非空字符串，收到 ${JSON.stringify(entry.id)}`);
  }
  // 三个数值键。写成常量而不是内联字面量，是为了让"哪三个键该是有限数"
  // 只有一处定义；键集若增删，测试 '长跑之后每个条目仍是恰好五个键' 会先变红。
  for (const key of NUMERIC_ENTRY_KEYS) {
    if (!Number.isFinite(entry[key])) {
      throw new TypeError(
        `remember: 条目 "${entry.id}" 的 ${key} 必须是有限数，收到 ${String(entry[key])}` +
        '（存档缺这个字段会得到 undefined，运算后变 NaN，静默污染这条关系）',
      );
    }
  }
  // role 只允许 null 或 ROLES 之一。这里顺带给了 ROLES 一个**生产代码里的消费者**
  // （此前它只被测试引用）：Task 8 写 role、Plan 3 校验存档，都走这一道门。
  // 用 ROLES.includes 而不是 KINSHIP[role] 查真值 —— 后者挡不住原型键。
  if (entry.role !== null && !ROLES.includes(entry.role)) {
    throw new TypeError(
      `remember: 条目 "${entry.id}" 的 role 必须是 null 或 ROLES 之一，收到 ${String(entry.role)}`,
    );
  }
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
