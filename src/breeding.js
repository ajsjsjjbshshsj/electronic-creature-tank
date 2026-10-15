import { CONFIG } from './config.js';
import { inherit } from './genes.js';
import { canBreed, createCreature } from './creature.js';
import { KINSHIP, affectionFor, ensure, kinshipBetween } from './memory.js';

// 卵的 id 计数器。模块级状态是这里唯一的例外 ——
// 它只用于生成唯一 id，不参与任何模拟决策，因此不影响可复现性。
let eggSeq = 0;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 求偶的前置门槛。全部是硬性事实（阶段、血缘、距离、状态），
// 不含任何"意愿"判断 —— 意愿由 courtshipScore 的连续评分表达。
export function canCourt(a, b, opts) {
  if (a === b || a.id === b.id) return false;
  if (!canBreed(a) || !canBreed(b)) return false;
  if (a.courtship || b.courtship) return false;

  // 近亲回避（spec 4.12 第 5 条）：双向检查，只要一方记得亲缘就拒绝。
  // 用 > 而非 >= —— kinship 恰好 0.25（半同胞/祖孙）属于允许的边缘，
  // 严格超过才拒绝。
  const kinA = kinshipBetween(a.memory, b.id);
  const kinB = kinshipBetween(b.memory, a.id);
  if (kinA > CONFIG.kinshipMateMax || kinB > CONFIG.kinshipMateMax) return false;

  // 好感太低就不开始（spec 4.12 第 2 条：若一方 affection 太低 → 拒绝，转身离开）。
  // 这是"意愿"里唯一被当作硬门槛的一项 —— 依据是 spec 把它明确写成"拒绝"，
  // 而不像 arousal / hunger / fear 那样可以被其他因素抵消。
  // 原计划漏了这条：`rejectionAffection` 被列进 Consumes，却只在 Task 10 里
  // 当作"被拒后的记忆惩罚"使用，于是 affection = -1 的一对也会开始完整的求偶仪式。
  // 阈值两侧（恰好 -0.15 允许 / 低于则拒绝）由测试钉住。
  if (affectionFor(a.memory, b.id) < CONFIG.rejectionAffection) return false;
  if (affectionFor(b.memory, a.id) < CONFIG.rejectionAffection) return false;

  if (opts.distance > CONFIG.courtshipRange) return false;

  // 意愿门槛：arousal 足够、不太饿、不太害怕
  const minArousal = 0.35;
  const maxHunger = 0.75;
  const maxFear = 0.5;
  if (a.emotions.arousal < minArousal || b.emotions.arousal < minArousal) return false;
  if (a.needs.hunger > maxHunger || b.needs.hunger > maxHunger) return false;
  if (a.emotions.fear > maxFear || b.emotions.fear > maxFear) return false;

  return true;
}

// 求偶的效用分，供 behavior.js 作为一个候选行为参与竞争。
//
// 种群上限在这里体现为"评分被压低"，而不是返回 false（spec 4.12 第 6 条）。
// 区别很重要：压低意味着它们仍会偶尔尝试、然后彼此失去兴趣 —— 这是行为；
// 归零意味着代码禁止了一件本该由世界规则解释的事 —— 那是穿帮。
//
// 渐变而非断崖：从 70% 容量开始线性衰减，该乘数到满容量时降到 0.12 倍
// （实测：population 8/24 时得分 2.5182124518，24/24 时 0.3021854942，比值恰好 0.12；
//   70%（16.8）与 69%（16.56）的得分相同，说明转折点确实在 0.7）。
export function courtshipScore(a, b, opts) {
  if (!canCourt(a, b, opts)) return 0;

  const loadRatio = opts.populationCap > 0 ? opts.population / opts.populationCap : 0;
  const crowding = loadRatio < 0.7
    ? 1
    : 1 - ((loadRatio - 0.7) / 0.3) * 0.88;      // 0.7→1.0 时从 1 降到 0.12

  const affection = (affectionFor(a.memory, b.id) + affectionFor(b.memory, a.id)) / 2;
  const willingness = (a.thresholds.courtshipWillingness + b.thresholds.courtshipWillingness) / 2;
  const arousal = (a.emotions.arousal + b.emotions.arousal) / 2;
  // 距离越近越容易开始；归一化到 [0,1]
  const proximity = 1 - opts.distance / CONFIG.courtshipRange;

  return Math.max(0, crowding * willingness * (0.4 + arousal) * (0.6 + proximity) * (1 + affection));
}

// 仪式时长必须双方一致 —— 否则一方先结束会导致另一方卡在求偶状态。
export function startCourtship(a, b, rng) {
  const duration = rng.range(CONFIG.courtship.min, CONFIG.courtship.max);
  a.courtship = { partnerId: b.id, t: 0, duration, phase: 0 };
  b.courtship = { partnerId: a.id, t: 0, duration, phase: 0 };
}

// 推进仪式。返回 'complete' 时清空 courtship，
// 保证同一场仪式不会被完成两次（否则会产两窝卵）。
//
// phase 把仪式切成四段（spec 4.12 第 2 条），供表现层编舞：
//   0 绕圈（速度逐渐同步）  1 体色脉动同步  2 前端轻触  3 膨胀展示
export function tickCourtship(c, dt) {
  const court = c.courtship;
  if (!court) return 'ongoing';
  court.t += dt;
  const progress = Math.min(1, court.t / court.duration);
  court.phase = progress < 0.35 ? 0 : progress < 0.6 ? 1 : progress < 0.85 ? 2 : 3;
  if (court.t >= court.duration) {
    c.courtship = null;
    return 'complete';
  }
  return 'ongoing';
}

export function interruptCourtship(c) {
  c.courtship = null;
}

// 产卵。位置落在缸底附近（y 大 = 靠近底部，与世界坐标 y 向下增长一致），
// 母体若在中上层，卵也会沉到缸底 —— 这符合"沉性卵"的直觉。
export function layEggs(mother, father, rng, opts) {
  const count = rng.int(CONFIG.eggsPerClutch[0], CONFIG.eggsPerClutch[1]);
  const eggs = [];
  for (let i = 0; i < count; i++) {
    eggSeq += 1;
    eggs.push({
      id: `e${eggSeq}`,
      // 每枚卵独立走一次分离+重组+变异，所以同窝各不相同
      genes: inherit(rng, mother.genes, father.genes),
      age: 0,
      pos: {
        x: clamp01(mother.pos.x + rng.range(-0.04, 0.04)),
        y: clamp01(rng.range(0.78, 0.97)),
      },
      motherId: mother.id,
      fatherId: father.id,
      // 不可孵化不是"不产卵"，而是"产了但光会慢慢熄灭"（spec 4.12 第 6 条）
      viable: !opts.atPopulationCap,
    });
  }

  // 双亲互记为 mate。用 includes 去重，否则反复产卵会把 mates 塞满同一个 id。
  if (!mother.lineage.mates.includes(father.id)) mother.lineage.mates.push(father.id);
  if (!father.lineage.mates.includes(mother.id)) father.lineage.mates.push(mother.id);

  return eggs;
}

export function tickEgg(egg, dt) {
  egg.age += dt;
  if (!egg.viable) return 'failed';
  return egg.age >= CONFIG.stage.egg ? 'ready' : 'incubating';
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
    ensure(baby.memory, o.id, { kinship: k, role: roleInBaby });
    ensure(o.memory, baby.id, { kinship: k, role: roleInOther });
  }
}

// 孵化。基因组直接取自卵，不再二次变异 ——
// 变异已经在配子形成时发生过了，再加一次会让遗传学模型失真。
export function hatch(egg, rng, opts) {
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
    father: egg.fatherId,
    rng,
  });

  // 孩子认得父母（spec 4.11：幼体"认妈妈"）。
  // 父母侧的记忆由 sim.js 写回 —— 本模块不持有世界，拿不到父母对象。
  if (egg.motherId) ensure(baby.memory, egg.motherId, { kinship: KINSHIP.mother, role: 'mother' });
  if (egg.fatherId) ensure(baby.memory, egg.fatherId, { kinship: KINSHIP.father, role: 'father' });

  return baby;
}
