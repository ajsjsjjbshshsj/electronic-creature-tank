import { CONFIG } from './config.js';
import { randomGenome, decode } from './genes.js';
import { createNeeds } from './needs.js';
import { createEmotions } from './emotions.js';
import { createMemory } from './memory.js';
import { thresholds } from './personality.js';
import { assignCatchphrase } from './speech.js';

// 不含 'egg' —— 卵是独立实体（见 breeding.js），
// 因为它没有需求、情绪、记忆，硬塞进 Creature 会让所有模块都要判空。
// 阶段名。**必须冻结**（项目纪律，见 Task 4/5）：这是被 creature / behavior / sim /
// 表现层共同 import 的共享数组，一次就地改写（STAGES[1] = 'adult'）会静默改变
// 阶段判定与外观映射，全链路不报错。冻结本身必须被测试钉住 ——
// **摘掉 Object.freeze 不会让任何 deepEqual 内容断言变红**（它比内容不比可变性）。
export const STAGES = Object.freeze(['hatchling', 'juvenile', 'adult', 'elder', 'dead']);

// 阶段边界在模块加载时算一次，避免每帧重复加法。
// 顺序必须与 STAGES 前四项一致。**刻意不导出**：导出就要连带 Object.freeze 与
// 冻结测试，而它只在 stageForAge / growthFactor 内部用（两者都只读），
// 没有跨模块共享的需要 —— 不导出的常量不可能被别的任务就地改掉。
const BOUNDARIES = [
  CONFIG.stage.hatchling,
  CONFIG.stage.hatchling + CONFIG.stage.juvenile,
  CONFIG.stage.hatchling + CONFIG.stage.juvenile + CONFIG.stage.adult,
  CONFIG.stage.hatchling + CONFIG.stage.juvenile + CONFIG.stage.adult + CONFIG.stage.elder,
];

export function createCreature(opts) {
  // rng 是必需参数。这条抛错是有意的：Global Constraints 禁止 Math.random()，
  // 让缺参数的调用立刻炸掉，比让它静默退化成一个不可复现的随机源好得多。
  // 只有"完全从既有基因组重建"（读档）时才允许不传 —— 那种情况必须传 genes。
  if (!opts.rng && !opts.genes) {
    throw new Error('createCreature 需要 rng 参数（或既有 genes）；禁止使用 Math.random');
  }
  // 显式 stage 必须在 STAGES 里。理由：STAGES 的成员是**按字面量**比较的
  // （canBreed 要 'adult'、isAdultLike 要 'adult'|'elder'、sim 的 motion 按名字查表），
  // 所以 'Adult' 这种大小写错误会静默产出一只**永远不能繁殖、也不算成年**的生物 ——
  // 不抛错、不报警，症状只是"这只怎么一直不生"。读档路径（计划 3）尤其容易带进脏值。
  // 与 memory.remember 校验 role ∈ ROLES 是同一条纪律：非法输入要抛错，不要静默降级。
  if (opts.stage !== undefined && opts.stage !== null && !STAGES.includes(opts.stage)) {
    throw new TypeError(
      `createCreature: 未知的 stage "${opts.stage}"，必须是 STAGES 之一：${STAGES.join(' / ')}`,
    );
  }
  const genes = opts.genes || randomGenome(opts.rng);
  const traits = decode(genes);
  const c = {
    id: opts.id,
    name: opts.name,
    customName: opts.customName || false,
    generation: opts.generation || 1,

    genes,
    traits,
    thresholds: thresholds(traits.personality),

    // 蛋大小带来的体型加成（孤雌，spec §4.11）。取值约 ±0.25，
    // 在 sizeOf 里按 (1 − growthFactor) 衰减，到成体峰值恰好归零 ——
    // 于是"起点由蛋定、终点由基因定"是**结构**保证的，不是靠文档提醒。
    eggBoost: opts.eggBoost || 0,

    age: opts.age || 0,
    stage: opts.stage || stageForAge(opts.age || 0),
    alive: true,
    sick: false,

    // dying 与 alive 分工不同，别合并成一条读数：
    //   dying —— 给表现层的"溶散进行中"秒数，非零即已开始；由 Task 10 的 reapDead 累加
    //   alive —— 给逻辑的存活门控（本文件的 ageCreature、canBreed 都看它）
    // 出生时是 0：活着的东西没有"溶散进度"可言。
    //
    // ⚠️ 这里原先写过一条理由 —— "出生值若非零，会让读档进来的尸体满足
    // `!c.alive && c.dying > 0 && !c.deathHandled` 从而重放 onDeath"。
    // 经复查**不成立**，已删除：Task 10 的 tickWorld 在调用 tickCreature 之前就有
    // `if (!c.alive || c.sick) continue;`，已经死掉的个体根本走不到那道闸门，
    // 所以出生值取多少都不会导致读档重放死亡。那道闸门真正处理的是
    // **同一 tick 内**刚被 ageCreature 判定死亡的个体。
    // 留着一条"听起来合理但不可达"的理由，比没有理由更糟 —— 它会误导
    // Plan 3 的存档作者去防一个不存在的问题。
    dying: 0,

    pos: { x: opts.x, y: opts.y },
    vel: { x: 0, y: 0 },
    facing: { x: 1, y: 0 },   // 单位向量；静止时保持上一次朝向（spec 4.6）

    // 三个状态容器各自新建，**不共享引用**：两只生物共用同一个 needs 对象的话，
    // 喂饱一只会同时喂饱另一只，而这里不会抛任何错（由测试
    // 'emotions / needs / memory 是独立实例，不共享引用' 钉住）。
    needs: createNeeds(),
    emotions: createEmotions(),
    memory: createMemory(),

    intent: null,
    intentTime: 0,
    resting: false,
    moving: false,

    // （原 courtship 状态机字段随孤雌制删除 —— 没有对象就没有"正在和谁仪式"。）
    broodT: 0,       // 憋卵计时（秒），broodScore 读它，产卵结算时归零
    // 求关注升级计时（秒）。spec §4.10 原写"挂在 memory[PLAYER] 上"，实现改挂在个体上，
    // 理由见 spec §4.10 的 2026-10-20 补注：记忆条目是被 remember() 校验的**五键磁盘契约**，
    // 为一个每帧累加的计时器加第六个键，会让所有关系条目和所有存档都长出一个用不上的字段。
    // 语义等价：它只在"玩家在场且不回应"时累加，被理睬或玩家离场即归零。
    // 此刻是否正被抚摸（温柔的手贴着身体）。只为 petted 事件的**上升沿**服务：
    // 一次抚摸发一次，而不是每 tick 发一次（每 tick 发的话 joy 会被瞬间推到顶）。
    beingPetted: false,
    // 同上，服务于"戳"（spec §6.1）的上升沿。戳与抚摸是同一根手指、不同速度，
    // 反应完全相反 —— 两条 episode 因此必须各自独立，不能合成一个"手在动"的布尔。
    beingPoked: false,
    begIgnored: 0,
    mourn: 0,          // 哀悼剩余秒数（spec 4.11）

    lineage: {
      mother: opts.mother || null,
      father: opts.father || null,
      // 同样每只一份新数组：lineage 是朴素的嵌套对象，共享 mates/offspring
      // 会让"记录配偶"静默写到另一只身上（由测试
      // 'lineage 的 mates/offspring 不共享引用' 钉住）。
      mates: [],
      offspring: [],
    },

    // ---- 语言层（spec §4.13.1，Task A6）----
    // 口癖是**出生时抽定一次、终身不变**的个体特征，所以它住在这里而不是表现层。
    // 走 opts.rng 的**分叉流**：同一家倾向同类口癖但不强制（spec 明文）。
    // ⚠️ fork() 会消费父流一次抽取，所以本行加下去之后 world.rng 的下游取值整体平移；
    //    这是可复现性的正常代价（同种子仍逐位相同），不是 bug —— 但验收脚本的读数会变。
    catchphrase: opts.catchphrase || null,
    // 语言层的私有状态：下一次最早能开口的时刻 + 上一句（防连发）。
    // 只有 speech.js 写它，别的模块都不该碰。
    speech: { nextAt: 0, lastTokens: null },
    // "听进去的话"（spec §4.8.1）。**刻意与 memory 分开**：记得你说的话 ≠ 记得你，
    // 混在一个池子里，热闹缸里的对话会把玩家本人从 12 条配额里挤掉。
    // 只有 heard.js 写它（hear），recall 是纯读的。
    heard: opts.heard || [],
  };
  if (opts.rng) assignCatchphrase(c, opts.rng.fork());
  return c;
}

export function stageForAge(age) {
  if (age < BOUNDARIES[0]) return 'hatchling';
  if (age < BOUNDARIES[1]) return 'juvenile';
  if (age < BOUNDARIES[2]) return 'adult';
  if (age < BOUNDARIES[3]) return 'elder';
  return 'dead';
}

// 年龄推进。`if (!c.alive) return` 是**单元层面**的契约
// （spec 8.1：死亡后不再 tick），由测试 '死亡后 ageCreature 不再推进' 钉住 ——
// 那条断言的是 **age 不再增长**，这才是门控真正挡住的东西。
//
// ⚠️ 这里原先写过"去掉门控会让 dying 被反复写回哨兵值、尸体永不消失"，
// 经复查**不成立**，已删除：尸体溶散由 Task 10 的 `reapDead` 独立负责
// （它对所有 alive=false 的个体做 `c.dying += dt`，与本门控无关），
// 而 tickWorld 又在调用 tickCreature 之前就跳过了所有非存活个体，
// 所以整合运行里 ageCreature 根本不会被用在尸体上。
export function ageCreature(c, dt) {
  if (!c.alive) return;
  c.age += dt;
  const next = stageForAge(c.age);
  if (next === 'dead') {
    c.alive = false;
    c.stage = 'elder';        // 阶段标签停在 elder，死亡由 alive/dying 表达
    // 非零哨兵值，表示"动画已开始"。⚠️ 这个值直接决定溶散动画播多久 ——
    // Task 10 用 `c.dying += dt` 累加、再与 CONFIG.dissolveDuration（4 秒）比较
    // 来决定何时移除尸体，若写成 1，动画会被静默截短到 3 秒。
    // 它由测试 'dying 的哨兵值受字面量约束（远小于溶散时长）' 用字面量 1e-6 钉住
    // （那条同时钉住 `> 0`）；与 dissolveDuration 的**关系**由 Task 10 的
    // '溶散动画的时长由 dying 哨兵值决定' 负责，本文件里不能断言 —— 
    // 本 Task 跑在 dissolveDuration 被加进 config.js 之前。
    c.dying = 1e-6;
    return;
  }
  if (next !== c.stage) c.stage = next;
}

// 连续生长（spec 4.11）：体型随年龄平滑插值，阶段只是能力门槛。
// 分段线性而非阶跃 —— 这样你看到的是"一天天长大"，不是某天突然变形。
// 老年段略微回缩（×0.88 下限），配合光转暗转暖，是衰老的可见信号。
//
// 只读 c.age（不读 stage、不读 traits），所以可以传裸对象 { age }；
// 这一点被测试 'growthFactor 的四段端点值与中点值都被字面量钉住' 顺带固定。
// 五组端点/中点值全部由该条用 1e-12 容差钉住，"相邻采样不跳变"（|Δ| < 0.08）
// 那条是单侧的，改斜率不会让它变红。
export function growthFactor(c) {
  // Math.max(0, …) 只挡负年龄：那只可能来自脏存档（opts.age 为负），
  // 而负的 growthFactor 会让 sizeOf 返回负数、表现层画出一个负尺寸的团块。
  // 合法路径上 age 从 0 起单调增长，所以这个下限不改变任何既有行为。
  const age = Math.max(0, c.age);
  const h = BOUNDARIES[0];
  const j = BOUNDARIES[1];
  const a = BOUNDARIES[2];
  const e = BOUNDARIES[3];

  if (age < h) return 0.22 + 0.28 * (age / h);                       // 0.22 → 0.50
  if (age < j) return 0.5 + 0.35 * ((age - h) / (j - h));            // 0.50 → 0.85
  if (age < a) return 0.85 + 0.15 * ((age - j) / (a - j));           // 0.85 → 1.00（峰值在 960）
  return 1 - 0.12 * Math.min(1, (age - a) / (e - a));                // 1.00 → 0.88
}

export function sizeOf(c) {
  const g = growthFactor(c);
  // eggBoost 的 (1 − g) 权重：出壳时 g = 0.22 ⇒ 用掉 78% 的加成；
  // 成体峰值 g = 1 ⇒ 系数恰好为 1，蛋的影响完全消失。
  // `|| 0` 不是防御性废话：存档 v1 的个体没有这个字段，读档后它是 undefined，
  // 不兜底会让 sizeOf 变 NaN，整只生物在画面上消失。
  return c.traits.size * g * (1 + (c.eggBoost || 0) * (1 - g));
}

// 只有成体能繁殖。老年不再繁殖（spec 4.11）。
// sick 个体也排除 —— 它是 tick 抛异常后的隔离标记（spec 7.7），
// 隔离期间继续繁殖会把问题扩散到下一代。
// 注意年龄不参与判定：本函数只看 stage / alive / sick，
// 而 stage 只由 ageCreature 在推进年龄时切换（测试里手改 age 必须同步改 stage）。
export function canBreed(c) {
  return c.alive && !c.sick && c.stage === 'adult';
}

// 成体与老年都算"成年" —— 用于社交判定、哀悼触发、以及幼体的"认妈妈"。
export function isAdultLike(c) {
  return c.stage === 'adult' || c.stage === 'elder';
}
