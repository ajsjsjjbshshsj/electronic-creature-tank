import { CONFIG } from './config.js';
import { inherit, phenotype, eggTintBucket } from './genes.js';
import { createCreature } from './creature.js';
import { KINSHIP, ensure } from './memory.js';

// 卵的 id 计数器。模块级状态是这里唯一的例外 ——
// 它只用于生成唯一 id，不参与任何模拟决策，因此不影响可复现性。
let eggSeq = 0;

// 把卵编号**只向前**推到至少 n（读档路径专用，Task C-1 / sim.js 的 restoreWorld）。
//
// 上面那句"不影响可复现性"讲的是**同一个进程内**：新进程从 0 起。而存档接上之后出现了
// 一个新场景 —— 一份跑了 200 分钟的档在新进程里读回来，里面已经有 e1…e87 这些编号，
// 而计数器从 0 起，于是第一枚新卵就叫 `e1`，孵化出的个体叫 `c-e1`，**与档里已有的一只同名**。
// byIdIn / memory.get 都按 id 取第一个，症状是"它记得的那只不是它妈"，全程不报错。
// 把避让做成"从存档内容推导出来的确定值"顺带还回了一条性质：同一份档读十次，
// 读完后下一个编号是同一个数 —— 这条由 tests/save.test.js 的 boot 级用例钉住。
// 只前进不回退：回退会让同一进程里两批卵撞上彼此，那比读档更糟。
export function reserveEggSeq(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`reserveEggSeq: 需要非负整数，收到 ${String(n)}`);
  }
  if (n > eggSeq) eggSeq = n;
  return eggSeq;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------- 2026-10-20 孤雌改造：求偶整段删除 ----------
// 这里原有 canCourt / courtshipScore / startCourtship / tickCourtship / interruptCourtship
// 五个导出（约 100 行）。spec §4.12 改成"自己下蛋就行，不需要交配"之后，
// 它们服务的机制没有了：没有受者，就没有"能不能求偶""求偶评分""仪式进度"。
//
// 被删掉的画面里有一样东西**不打算丢**：体色脉动同步。spec §4.12 第 6 条把它
// 改挂在 socialize 的高级表现上（两只高好感、高 joy 的个体自发同步），
// 小铃音也跟着挪。那是 B 阶段的活，这里先记账。
//
// kinshipOf / registerKinship **原样保留** —— 亲缘仍是客观事实，
// 亲属偏好、守巢、家谱三处都要用。死的只是"闸门"，不是"关系"。

// 种群拥挤乘数（spec §4.12 第 6 条：上限要表现为"压低"，不是"禁止"）。
// 原来内联在被删掉的 courtshipScore 里；孤雌改造后由 sim 的 broodScore 复用 ——
// **这条语义与有没有父方无关**，所以它必须活下来，不能跟着求偶函数一起删。
// 下限 0.12 是"永不为 0"的那道保险：归零就成了 spec 明令禁止的硬阻断。
export function crowdingFactor(loadRatio) {
  if (loadRatio < 0.7) return 1;
  return Math.max(0.12, 1 - ((Math.min(1, loadRatio) - 0.7) / 0.3) * 0.88);
}

// 产卵（孤雌）。位置落在缸底附近（y 大 = 靠近底部，与世界坐标 y 向下增长一致），
// 母体若在中上层，卵也会沉到缸底 —— 这符合"沉性卵"的直觉。
//
// 基因走**自体合并**：`inherit(rng, mother.genes, mother.genes)`。inherit 本身一行未改
// （spec §4.12 第 3 条）—— 两个配子各自独立分离 + 变异，所以同窝每枚蛋仍然互不相同。
// 代价是杂合度每代砍一半，由 sim 的外来血统漂入补，见 §4.12 与 Task A3。
export function layEggs(mother, rng, opts) {
  const count = rng.int(CONFIG.eggsPerClutch[0], CONFIG.eggsPerClutch[1]);
  // 蛋色取**母方**的 eggTint 表现型，不是子代的：一窝蛋同色，"这一家都下蓝蛋"
  // 这条家谱线索才存在（spec §4.1 加这个位点的唯一理由）。子代自己的 eggTint 等位
  // 要到它成年产卵时才兑现。
  // 这里从 genes 现算而不是读 mother.traits.eggTint —— 表现型是出生时算的快照，
  // 而存档恢复与测试都会事后改 genes，缓存值会过期。
  const tint = eggTintBucket(phenotype('eggTint', mother.genes.eggTint));
  const eggs = [];
  for (let i = 0; i < count; i++) {
    eggSeq += 1;
    eggs.push({
      id: `e${eggSeq}`,
      // 每枚卵独立走一次分离 + 变异，所以同窝各不相同
      genes: inherit(rng, mother.genes, mother.genes),
      age: 0,
      pos: {
        x: clamp01(mother.pos.x + rng.range(-0.04, 0.04)),
        y: clamp01(rng.range(0.78, 0.97)),
      },
      motherId: mother.id,
      // fatherId 这个键**保留**、恒 null：存档 v1 里它有值，删键会改变存档形状，
      // 迁移成本远高于留一个恒 null 的字段（spec §7.2）。
      fatherId: null,
      eggSize: rollEggSize(mother, rng),
      eggTint: tint,
      // 不可孵化不是"不产卵"，而是"产了但光会慢慢熄灭"（spec 4.12 第 6 条）
      viable: !opts.atPopulationCap,
    });
  }

  // 2026-10-20：原「双亲互记 mate」的 20 行随求偶制删除。
  // 那段曾是 role:'mate' 的唯一生产者；现在 mate 这个 role 本身已经不存在了
  // （spec §4.8 改成 companion），而 companion 的生产者在社交路径上，不在产卵里。
  return eggs;
}

// 蛋大小：母方的 size 表现型 × broody × 营养，再加一点抖动。
// 营养项 (1 − hunger) 是**玩家能直接感知的因果** —— "喂得好，蛋就大"（spec §4.11），
// 这条比数值本身重要，所以它必须真的单调，由测试钉住。
function rollEggSize(mother, rng) {
  const { min, max } = CONFIG.eggSize;
  const sizeP = (mother.traits.size - CONFIG.minSize) / (CONFIG.maxSize - CONFIG.minSize);
  const broodyP = mother.traits.personality.broody;
  const u = clamp01(
    0.30 + 0.25 * sizeP + 0.15 * broodyP + 0.30 * (1 - mother.needs.hunger)
      + rng.range(-0.10, 0.10),
  );
  return min + u * (max - min);
}

// 孵化时长随蛋大小上升（"大的孵得久"）。系数在 CONFIG，边界值由测试夹住。
export function eggDuration(egg) {
  const { min, max, durationFactor } = CONFIG.eggSize;
  const u = clamp01((egg.eggSize - min) / (max - min));
  return CONFIG.stage.egg * (durationFactor[0] + durationFactor[1] * u);
}

export function tickEgg(egg, dt) {
  egg.age += dt;
  if (!egg.viable) return 'failed';
  return egg.age >= eggDuration(egg) ? 'ready' : 'incubating';
}

// 谱系 → 亲缘系数（交接要求第 5 条）。
//
// Task 5 只提供 KINSHIP 系数表与 kinshipBetween 查询，**不做**任何从谱系出发的推导，
// 所以 grandparent / grandchild / halfSibling 这三个系数在 Task 5 里没有生产者。
// 这段是它们的**唯一生产者**。没有它，真实数据里每对个体的 kinship 都是 0：
//   · `kinship > 0.25` 的近亲回避永不触发 → 兄妹可以互相求偶
//   · `memory.decay` 的 `>= 0.25` 慢衰减通道永不激活
// 两者都**静默**退化，全链路不报错，症状只是"后代越来越奇怪"。
//
// 只走 lineage，不读 memory —— 亲缘是客观事实，不该取决于"它是否还记得"；
// memory 里的 kinship 只是这条事实的**缓存**（由 registerKinship 写入）。
// 深度走到两代，足以覆盖 spec 4.8 列出的全部关系。
export function kinshipOf(a, b, byId) {
  if (a === b || a.id === b.id) return 0;
  const parentsOf = (c) => [c.lineage.mother, c.lineage.father].filter(Boolean);
  const pa = parentsOf(a);
  const pb = parentsOf(b);

  // 亲子：一方的亲本里有另一方
  if (pa.includes(b.id) || pb.includes(a.id)) return KINSHIP.offspring;

  // 同胞 / 半同胞：共享亲本数决定。两个都共享 ⇒ 全同胞；只共享一个 ⇒ 半同胞。
  const shared = pa.filter((p) => pb.includes(p));
  if (shared.length >= 2) return KINSHIP.sibling;
  if (shared.length === 1) return KINSHIP.halfSibling;

  // 祖孙：b 是 a 某个亲本的亲本（或反之）。系数对称（都是 0.25），不必区分方向。
  if (byId) {
    const grandparentsOf = (c) => parentsOf(c).flatMap((pid) => {
      const p = byId(pid);
      return p ? parentsOf(p) : [];
    });
    if (grandparentsOf(a).includes(b.id) || grandparentsOf(b).includes(a.id)) {
      return KINSHIP.grandparent;
    }
  }
  return 0;
}

// 出壳后把亲缘事实写进双方记忆（缓存层）。
// 用 ensure 的**写入路径**：对方 id 对这条记忆而言是新键，所以 ensure 会真的创建条目。
// （反面注意：ensure 对**已存在**的条目是幂等的，不会覆盖 kinship ——
//   这正是测试里 seedKin 必须用 remember 而不能用 ensure 的原因。）
export function registerKinship(baby, others, byId) {
  const parents = [baby.lineage.mother, baby.lineage.father].filter(Boolean);
  // 亲缘是**客观事实**，所以这里不能只靠 ensure 的幂等写入 —— 那会让结果依赖调用顺序。
  // 具体危险：若对方的记忆里**已经**有一条针对这只雏体的条目（例如它们在社交中先打过照面，
  // sim 的 adjust 建出了 kinship 默认 0 的条目），那么 ensure 会静默失效，
  // 亲缘停在 0 → 近亲回避静默失效。所以 ensure 之后显式把缓存值写正。
  //
  // role 只在算出非 null 时才覆盖：0.25 那两档（祖孙/半同胞）在 ROLES 里没有对应角色，
  // 若用 null 去覆盖，会把已确立的 role（如父母的 'offspring'）抹掉。
  const writeFact = (memory, id, kinship, role) => {
    const e = ensure(memory, id, { kinship, role });
    if (e.kinship !== kinship) e.kinship = kinship;
    if (role !== null && e.role !== role) e.role = role;
  };
  for (const o of others) {
    if (o.id === baby.id) continue;
    const k = kinshipOf(baby, o, byId);
    if (k <= 0) continue;
    // role 按**各自视角**填，且只能是 ROLES 里的成员：
    // 对雏体而言对方是 mother/father/sibling；对对方而言雏体是 offspring。
    // 祖孙与半同胞（0.25）在 ROLES 里没有对应角色，留 null。
    const roleInBaby = o.id === baby.lineage.mother ? 'mother'
      : o.id === baby.lineage.father ? 'father'
        : k === KINSHIP.sibling ? 'sibling' : null;
    const roleInOther = parents.includes(o.id) ? 'offspring'
      : k === KINSHIP.sibling ? 'sibling' : null;
    writeFact(baby.memory, o.id, k, roleInBaby);
    writeFact(o.memory, baby.id, k, roleInOther);
  }
}

// 孵化。基因组直接取自卵，不再二次变异 ——
// 变异已经在配子形成时发生过了，再加一次会让遗传学模型失真。
export function hatch(egg, rng, opts) {
  const { min, max, hatchGain } = CONFIG.eggSize;
  const u = clamp01((egg.eggSize - min) / (max - min));
  const baby = createCreature({
    id: `c-${egg.id}`,
    name: opts.nameFor(egg.genes, 0),
    x: clamp01(egg.pos.x + rng.range(-0.01, 0.01)),
    y: clamp01(egg.pos.y + rng.range(-0.01, 0.01)),
    age: 0,
    stage: 'hatchling',
    genes: egg.genes,
    generation: opts.generation,
    mother: egg.motherId,
    father: egg.fatherId,      // 孤雌下恒 null，但键保留（存档形状契约）
    // 蛋大小给的是**起点**，不是终点：这个加成按 (1 − growthFactor) 衰减，
    // 到成体峰值恰好归零，所以成年体型完全由 size 基因定
    // （EGG_SIZE_BIAS = 0，控制方 2026-10-20 裁定；见 creature.sizeOf）。
    eggBoost: (u - 0.5) * hatchGain,
    rng,
  });

  // 孩子认得妈妈（spec 4.11：幼体"认妈妈"）。
  // 母亲侧的记忆由 sim.js 写回 —— 本模块不持有世界，拿不到母亲对象。
  // 下面那条 father 分支保留但**永不触发**（egg.fatherId 恒 null）：
  // 留着是为了让"父方条目不会被写入"这件事由测试正面钉住，而不是靠巧合。
  if (egg.motherId) ensure(baby.memory, egg.motherId, { kinship: KINSHIP.mother, role: 'mother' });
  if (egg.fatherId) ensure(baby.memory, egg.fatherId, { kinship: KINSHIP.father, role: 'father' });

  return baby;
}
