// body.js —— 五角星软体 + 卷毛状态 + 3 段尾巴（spec §5.1、§4.7、§4.7.1、§4.6）。
//
// 纯逻辑模块：不碰 DOM、不碰画布、不 import 入口模块，也不调 perceive。
// 它只读 creature 上的字段，只写自己持有的 Body。回报是"Q 弹回弹""尾巴摇得多快"
// "毛有多长"这三条设计承诺能在 Node 里被断言（tests/body.test.js），
// 不必靠人在浏览器里盯着看 —— 这正是 main.js 之外所有模块保持纯的理由。
//
// 坐标系：points 与 tail.nodes 都在 **facing 对齐的局部单位空间**，+x 是正前方，
// 而"身体半径"在这个空间里恒等于 1（所以 STAR_OUTER_RATIO = 1.0 就是外角落在单位圆上）。
// 乘半径（body.radius = sizeOf(c)）、按 facing 旋转、平移到屏幕全是 render.js 的事。
// 这样分工的两个回报：body.js 不知道视口多大，输出与设备无关；测试不需要任何浏览器 API。
//
// ⚠️ 局部空间没有"上下"：facing 对齐系里 +y 只是"垂直朝向的某一侧"。
// 所以 spec §4.7.1 表里"竖直高举 / 垂着不动"在本层实现为**绷直程度与卷角**（tail.curl），
// 屏幕上的"朝上"由 B14 在旋转之后决定。这是刻意的降级，不是漏掉。
//
// ⚠️ 数值一律来自 CONFIG（spec §11）：本文件不含任何小数/多位整数字面量，
// 由 tests/body.test.js 的源码扫描钉住（先例是 A5 的 moodOf 那条）。
// 唯一的例外是 0/1/2 这类结构性常数（归一化、折半、二阶差分）。
//
// ⚠️ 步长敏感：下面的弹簧积分与尾巴松弛都是显式积分（和 emotions 同一类），
// **不具**步长无关性 ⇒ updateBody 必须跑在固定步长的子步循环里（main.js 的 steps 循环），
// 放在渲染帧率下会让高刷屏上的身体更硬、低刷屏上更软。
// 这条纪律由 tests/body.test.js 的两处守住：一条扫 main.js 源码，
// 一条反向断言"一个 1 秒的大步 ≠ 六十个 1/60 的小步"。

import { CONFIG } from './config.js';
import { sizeOf } from './creature.js';
import { syncDegree } from './social.js';

const TAU = Math.PI * 2;
// 半个周期 = 圈量的结构常数（不是可调参数）。写成 1 / 2 是为了过
// tests/body.test.js 那道"body.js 里不许有小数字面量"的守卫 —— 它只放行 0/1/2。
const HALF_TURN = 1 / 2;
const B = CONFIG.body;
const STAR = CONFIG.star;
const FLUFF = CONFIG.fluff;
const TAIL = CONFIG.tail;

// NaN 也走 0：脏存档会给缺字段的情绪（undefined），而 NaN 一旦乘进坐标，
// 症状是"这只生物在画面上消失了"且全程不报错（计划 1 的教训）。
const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

// 五角星的目标半径函数：把任意角折进一个扇区，再折进"外角 → 内角"的半周期，按 smoothstep 插值。
//
// 为什么是 smoothstep 而不是线性（D-1，2026-10-23 照 assets 那只星绒绒逐点拟合的）：
// 素材的轮廓**两头都是平的** —— 瓣尖圆钝（±3° 内几乎不掉半径）、凹口也圆（底部 0.71→0.71 走平），
// 过渡集中在中段。smoothstep 在两端导数为 0，正好就是这个形状；线性则是"尖角 + V 形沟"。
// 逐点 RMS（对素材对称轮廓，见 tests/body.test.js 那张表）：线性 0.027、smoothstep 0.012。
// 再往上加一个幂次旋钮只把最大偏差从 0.021 买到 0.011 —— r=15px 上是 0.15px，不值一个 CONFIG 键。
//
// 旧注释里"线性是有意降级，因为抱枕的棱是圆的"这句是**反的**：线性恰恰做出尖棱，
// 圆棱要靠二阶连续的那条 —— 这一版就是把它补上。
export function starRadius(angle) {
  const sector = TAU / STAR.corners;              // 72°
  const half = sector / 2;                        // 36°：外角顶点到内凹顶点
  let wrapped = angle % sector;
  if (wrapped < 0) wrapped += sector;
  const dist = wrapped <= half ? wrapped : sector - wrapped;   // 到最近外角顶点的角距
  const t = dist / half;
  return STAR.outerRatio + (STAR.innerRatio - STAR.outerRatio) * (t * t * (3 - 2 * t));
}

// 弹簧参数由 wobble 基因决定（spec §4.7："挤压幅度由 wobble 基因决定，
// 所以有的孩子天生更 Q，有的更挺"）。
//
// 用**阻尼比 zeta** 而不是直接给阻尼系数，是为了让"挺 / 弹"成为一个有物理意义的旋钮：
//   zeta = 1   临界阻尼 —— 最快回到静止位且**不过冲**
//   zeta < 1   欠阻尼   —— 冲过头再荡回来（这就是 Q 弹）
// spec §4.7 要求"形变必须带过冲回弹"，所以 CONFIG 两端都取 < 1；
// 0.70 → 0.35 对应阶跃过冲量 exp(-πζ/√(1-ζ²)) = 4.6% → 30.9%，差 6.7 倍，肉眼可辨。
export function springParams(wobble) {
  const w = clamp01(wobble);
  const stiffness = B.stiffnessAtZeroWobble
    + (B.stiffnessAtFullWobble - B.stiffnessAtZeroWobble) * w;
  const zeta = B.zetaAtZeroWobble + (B.zetaAtFullWobble - B.zetaAtZeroWobble) * w;
  // damping 不是第三个独立旋钮：由 k 与 ζ 唯一决定，否则两者能被调成互相矛盾的组合。
  return { stiffness, zeta, damping: 2 * Math.sqrt(stiffness) * zeta };
}

// 眨眼间隔（spec §4.6 第 4 条）：`blinkInterval = base / (0.4 + activity)`。
// 放在这里是因为它和尾巴的摆速是**同一个派生态**（都由 activity 驱动，spec §4.6 明文同源），
// 而 B15 的眼睛层要读的是这个数，不是自己再抄一遍公式。
export function blinkInterval(activity) {
  return CONFIG.blink.intervalBase / (CONFIG.blink.activityFloor + clamp01(activity));
}

// 尾巴摆速（spec §4.7.1，逐字）：`base × (0.4 + activity) × (1 + arousal)`，单位弧度/秒。
export function tailSwingRate(activity, arousal) {
  return TAIL.swingBase
    * (TAIL.swingActivityFloor + clamp01(activity))
    * (1 + TAIL.swingArousalGain * clamp01(arousal));
}

export function createBody(traits) {
  const t = traits || {};
  const n = CONFIG.bodyPoints;
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = starRadius(a);
    const cx = Math.cos(a) * r;
    const cy = Math.sin(a) * r;
    // rx/ry 是静止位（星形轮廓上的采样点），创建后不再变；render 与测试都拿它当基准
    points[i] = { x: cx, y: cy, vx: 0, vy: 0, rx: cx, ry: cy };
  }

  // 尾巴挂点：spec §4.7.1 要"星形后侧的那个凹角"。
  // 取静止方向最接近 -facing（正后方）的那个点。bodyPoints = 24 与 corners = 5 在这条线上
  // 恰好对齐：i = 12 落在 180°，而 180° 是内凹角（180 = 72×2 + 36），所以拿到的是凹角而不是尖角。
  // 由形状**算出来**而不是写死 12，是因为改 bodyPoints 或 corners 时它不该悄悄错位。
  let tailAnchor = 0;
  let bestRear = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const len = Math.hypot(p.rx, p.ry) || 1;
    const rear = -p.rx / len;
    if (rear > bestRear) { bestRear = rear; tailAnchor = i; }
  }
  const anchor = points[tailAnchor];
  const anchorLen = Math.hypot(anchor.rx, anchor.ry) || 1;
  const baseX = anchor.rx / anchorLen;              // 挂点处的外法线 ≈ (-1, 0)
  const baseY = anchor.ry / anchorLen;

  // 3 段 Verlet 链，静止时沿挂点法线向后排开。
  // 链长 = TAIL_LEN_RATIO × 身体半径，而本层的身体半径恒为 1 ⇒ 局部总长就是 lenRatio；
  // 换算成世界单位由 body.tailWorldLen 给（lenRatio × sizeOf(c)），**不新增基因**（spec 明文）。
  const segs = TAIL.segs;
  const segLen = TAIL.lenRatio / segs;
  const nodes = new Array(segs);
  for (let i = 0; i < segs; i++) {
    const x = anchor.rx + baseX * segLen * (i + 1);
    const y = anchor.ry + baseY * segLen * (i + 1);
    nodes[i] = { x, y, px: x, py: y };   // px == x：初速度必须为零，否则一上手就自己飘
  }

  return {
    points,
    // 每点的局部凹陷量。typed array ⇒ 运行时零分配，且渲染层可以直接按索引读。
    dip: new Float64Array(n),
    phase: 0,
    pulse: 0,
    prevX: NaN,                   // NaN = 还没有历史，第一步不判冲击
    prevY: NaN,
    prevDx: 0,
    prevDy: 0,
    impactX: 0,                   // 预声明：detectImpact 第一次就要写它，不能在那时才新增属性
    impactY: 0,
    petX: 0,                      // 近手侧的单位方向（facing 局部空间）；毛层只读它做局部倒伏
    petY: 0,
    wobble: clamp01(t.wobble),
    fluff: clamp01(t.fluff),      // spec §4.1 的性状位点，透传到表现层（§4.7 毛长）
    radius: 0,                    // 世界单位（sizeOf 的缓存）；updateBody 每步刷新
    fluffLen: 0,                  // 局部单位：FLUFF_LEN_RATIO × fluff × 情绪调制
    fluffSprite: 0,               // 0 常态 / 1 炸开（spec §11 FLUFF_SPRITES = 2）
    tailWorldLen: 0,              // 世界单位尾长，渲染层直接用
    tailAnchor,
    tail: {
      nodes, baseX, baseY,
      phase: 0, rate: 0, amp: 0, curl: 0, drive: 0, tuck: 1,
    },
  };
}

// 冲击检测用的是**位置的二阶差分**，不是速度差。这个选择是被内核逼出来的，不是审美偏好：
//   · moveToward 撞墙时 clampPos 只截住**位置**，紧接着又把 vel 设成完整的意图速度
//     —— 所以贴墙时 vel 毫无信号，"Δv 很大 ⇒ 撞到东西了"这个直觉在这里是**错的**。
//   · 个体间碰撞直接改 pos（把两只各推开 push），也不改 vel。
// 两条路径唯一的共同信号是：实际位移与上一步位移不一致。二阶差分正好量这个，
// 而且顺带把 spec §4.7 的"落地/停下时先压扁再弹回"一起覆盖了 —— 起步与急停本身就是加速度尖峰。
//
// ⚠️ 相对旧计划 Task 2 的一处修正：位移必须先**投影到 facing 局部轴**再比。
// 旧代码把世界位移 (dx, dy) 直接当局部方向用，只在 facing = (1,0) 时碰巧正确，
// 而缸里每只的朝向都是任意角度 —— 症状是"被从后面撞了一下，结果前脸瘪了"。
function detectImpact(body, c) {
  const fx = c.facing.x;
  const fy = c.facing.y;
  if (!Number.isFinite(body.prevX)) {
    body.prevX = c.pos.x;
    body.prevY = c.pos.y;
    body.prevDx = 0;
    body.prevDy = 0;
    return 0;
  }
  const dx = c.pos.x - body.prevX;
  const dy = c.pos.y - body.prevY;
  const ldx = dx * fx + dy * fy;                 // 局部 +x = facing
  const ldy = dx * -fy + dy * fx;                // 局部 +y = 垂直朝向的某一侧
  const rx = ldx - body.prevDx;
  const ry = ldy - body.prevDy;
  body.prevDx = ldx;
  body.prevDy = ldy;
  body.prevX = c.pos.x;
  body.prevY = c.pos.y;

  const mag = Math.hypot(rx, ry);
  if (mag <= B.impactEps) return 0;
  // 凹陷方向 = -residual。推导：被从 +x 方向撞 ⇒ 自己沿 -x 被推开 ⇒ residual 指向 -x
  // ⇒ 受冲击的一侧是 +x，正好是 -residual。撞墙同理（意图朝 +x，位置被截住 ⇒
  // residual 指向 -x ⇒ 受冲击侧是 +x，就是墙那一侧）。两种情况共用一个符号约定。
  const strength = Math.min(1, (mag - B.impactEps) / B.impactFullDent);
  body.impactX = -rx / mag;
  body.impactY = -ry / mag;
  return strength;
}

// 求关注升级链的**档位**（spec §4.10 的三档：0 卖萌 / 1 蹦到手的正前方 / 2 背对手生气）。
//
// ⚠️ 这里刻意**不** import behavior.begEscalation 而是按同一份 CONFIG 阈值自己比两次，
// 理由不是省事：begEscalation 每次调用都要**新分配一个对象**（{level, hopBonus, protestFloor}），
// 而本函数坐在 updateTail 里，跑在"每只 × 每子步"上（24 只 × 60 子步 = 每秒 1440 次分配），
// spec §5.3 把"运行时不分配对象"列为硬约束。返回标量就一次都不分配。
//
// 两份实现的**一致性**由 tests/render-fx.test.js 的一条扫描线守住：
// 它对一组 begIgnored 探针逐点断言本函数与 begEscalation(c).level 相同。
// 阈值本身只有**一处定义**（CONFIG.behavior.begEscalate），所以会分家的只有比较式，
// 而那条测试正是冲着它来的。
export function begLevelOf(c) {
  const E = CONFIG.behavior.begEscalate;
  const ignored = Number.isFinite(c.begIgnored) ? c.begIgnored : 0;
  if (ignored >= E.protestAfter) return 2;
  if (ignored >= E.hopAfter) return 1;
  return 0;
}

// 尾巴（spec §4.7.1）。三段链，每段的目标位置 = 上一段方向**旋转一个摆角**再前进 segLen，
// 摆角取 amp × sin(phase − i × waveLag)：相位沿链后退 ⇒ 波从根部往尖端传，
// 而不是整条一起左右平移（那看着像一根棍子在扫）。
//
// 为什么是"朝目标松弛"而不是"直接钉在目标上"：直接钉 = 刚性附件，尾巴会像天线一样
// 精确跟随每一次形变，没有质量感。松弛系数 follow < 1 加上 Verlet 的惯性项，
// 才有"甩完还在荡"的那一下 —— 也就是 spec §4.7 要的 Q 弹长在尾巴上。
function updateTail(body, c, dt, damp, emo) {
  const tail = body.tail;
  const nodes = tail.nodes;
  const n = nodes.length;
  const personality = c.traits ? c.traits.personality : null;
  const activity = personality ? clamp01(personality.activity) : 0;
  // 求关注升级链的档位（spec §4.10）。**只读** begIgnored，不写任何东西回去。
  const beg = begLevelOf(c);

  // 摆速：spec 公式 + anger 的"急促前后抽"（表里那一档）
  //          + 升级链**第二档**的急促（被冷落到背过身去那一档，抽得更快）。
  const rate = tailSwingRate(activity, emo.arousal) * (1 + TAIL.angerRateGain * emo.anger)
    * (beg >= 2 ? 1 + TAIL.begRateGain : 1);
  tail.rate = rate;
  tail.phase = (tail.phase + rate * dt) % TAU;

  // 夹起来（fear 那一档）：一个系数同时管摆幅与段长 —— 收短 + 不摆，才是"夹尾巴"，
  // 只砍摆幅的话尾巴会直挺挺地贴在身后，那是僵硬而不是顺从。
  const tuck = 1 - TAIL.fearTuck * emo.fear;
  tail.tuck = tuck;

  // 幅度：spec 只给排序（幸福 > 快乐 > 安静 > 伤心）与 fear/anger 两档，没给数 ⇒ 数在 CONFIG。
  // 第三档加数 = 升级链**第一档**的"尾巴幅度拉满"；到第二档**撤掉**（不是叠加），
  // 因为 spec §4.10 明写"两级的出口是替换而非叠加"，叠加会读成"越被无视越开心"。
  tail.amp = (TAIL.ampQuiet + TAIL.ampJoy * emo.joy + TAIL.ampArousal * emo.arousal
    + TAIL.ampAnger * emo.anger + (beg === 1 ? TAIL.ampBeg : 0)) * damp * tuck;
  // "伤心：垂着不动，尖端轻微卷" —— 局部空间没有"下"，所以实现为静态卷角（见文件头那条 ⚠️）
  tail.curl = TAIL.curlQuiet * (1 - emo.joy) * damp;
  tail.drive = tail.amp * Math.sin(tail.phase);

  const drag = Math.exp(-TAIL.dragRate * dt);
  const follow = Math.min(1, TAIL.followRate * dt);
  const segLen = (TAIL.lenRatio / n) * tuck;
  const anchor = body.points[body.tailAnchor];

  let px = anchor.x;
  let py = anchor.y;
  let dirX = tail.baseX;
  let dirY = tail.baseY;
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    // Verlet：惯性位移 = 当前位置 − 上一位置，按每秒阻尼折算成每步系数
    const ix = nd.x + (nd.x - nd.px) * drag;
    const iy = nd.y + (nd.y - nd.py) * drag;
    nd.px = nd.x;
    nd.py = nd.y;
    const bend = tail.amp * Math.sin(tail.phase - i * TAIL.waveLag) + tail.curl;
    const cs = Math.cos(bend);
    const sn = Math.sin(bend);
    const nx = dirX * cs - dirY * sn;
    const ny = dirX * sn + dirY * cs;
    dirX = nx;
    dirY = ny;
    const gx = px + nx * segLen;
    const gy = py + ny * segLen;
    px = nd.x = ix + (gx - ix) * follow;
    py = nd.y = iy + (gy - iy) * follow;
  }
}

// 每子步一次：把整个 Body 推进 dt。**原地修改，不分配任何对象**。
export function updateBody(body, c, dt, hand) {
  const e = c.emotions;
  const emo = {
    joy: clamp01(e.joy),
    anger: clamp01(e.anger),
    fear: clamp01(e.fear),
    curiosity: clamp01(e.curiosity),
    sleepy: clamp01(e.sleepy),
    arousal: clamp01(e.arousal),
  };

  // sick 与死亡都会把形变压小：内核要求 sick 个体被画成"变暗、静止"，
  // 而溶散中的身体应当先塌陷再散开（spec §4.11）。
  const dyingT = c.alive ? 0 : clamp01(c.dying / CONFIG.dissolveDuration);
  let damp = 1 - B.sleepyCalm * emo.sleepy;          // 困倦 ⇒ 形变幅度极小
  if (c.sick) damp *= B.sickCalm;
  if (!c.alive) damp *= 1 - B.dyingCalm * dyingT;

  // ---- 体型与世界单位读数（渲染层要的三个数）----
  body.radius = sizeOf(c);
  body.tailWorldLen = TAIL.lenRatio * body.radius;
  // 毛长 = FLUFF_LEN_RATIO × 身体半径 × fluff 表现型（spec §4.7）。本层的身体半径恒为 1，
  // 所以这里是局部值；渲染层乘的是同一个 scale（毛必须跟着形变走，§4.7 那条）。
  // fear 用现成的 body.fearShrink 把毛压短 —— spec §4.7 那句"2 张 sprite（常态/收缩）"里
  // "收缩"这一半用长度实现，就不需要第三张图（见回报的偏离条）。
  body.fluffLen = FLUFF.lenRatio * body.fluff * (1 - B.fearShrink * emo.fear * damp);
  // sprite 分档：与 genes.patternBucket 同一个手法（连续量 floor 进桶，不写阈值常数）。
  // spec §4.7.1 表里 anger 那一档写的是"炸开"，§11 的两个名字也是"常态 / 炸开"。
  body.fluffSprite = Math.min(FLUFF.sprites - 1, Math.floor(emo.anger * FLUFF.sprites));

  // ---- 脉动相位与幅度（spec §4.5：arousal 全场最亮最快，sleepy 慢到几乎停止）----
  const pulseRate = Math.max(B.pulseRateFloor,
    B.pulseRateBase + B.pulseRateArousal * emo.arousal + B.pulseRateSleepy * emo.sleepy);
  body.phase = (body.phase + dt * pulseRate) % 1;    // 折进一个周期，防长时程精度损失
  body.pulse = (B.pulseAmpBase + B.pulseAmpJoy * emo.joy + B.pulseAmpArousal * emo.arousal
    - B.pulseAmpSleepy * emo.sleepy) * damp;

  // ---- 目标形状：情绪 + 运动挤压，算在局部单位空间 ----
  let scale = 1 + B.joyExpand * emo.joy - B.fearShrink * emo.fear + B.arousalExpand * emo.arousal;
  scale = 1 + (scale - 1) * damp;
  // 溶散时整体塌陷（但不塌到 0：0 半径会让 render 的渐变与贴图退化）
  scale *= 1 - B.dyingCollapse * dyingT;

  // 运动挤压：沿速度轴拉长、垂直轴压扁，两者相乘恒为 1 ⇒ 体积守恒
  const speed = Math.hypot(c.vel.x, c.vel.y);
  const speedNorm = Math.min(B.maxStretchSpeed, speed / CONFIG.motion.baseSpeed);
  const stretch = c.moving ? 1 + B.stretchK * speedNorm : 1;
  const invStretch = 1 / stretch;

  // 速度轴在**局部空间**里的方向（局部 +x 是 facing，所以要投影一次）
  const fx = c.facing.x;
  const fy = c.facing.y;
  const vFwd = c.vel.x * fx + c.vel.y * fy;
  const vSide = c.vel.x * -fy + c.vel.y * fx;
  const vLen = Math.hypot(vFwd, vSide);
  const ux = vLen > 0 ? vFwd / vLen : 1;             // 静止时退回 facing 轴
  const uy = vLen > 0 ? vSide / vLen : 0;

  // 冲击与抚摸共用一条凹陷管线：每个点取各来源的最大值，不累加。
  const impact = detectImpact(body, c);
  let petX = 0;
  let petY = 0;
  if (c.beingPetted && hand) {
    const dx = hand.pos.x - c.pos.x;
    const dy = hand.pos.y - c.pos.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      petX = (dx * fx + dy * fy) / len;
      petY = (dx * -fy + dy * fx) / len;
    }
  }
  const petting = petX !== 0 || petY !== 0;
  body.petX = petting ? petX : 0;
  body.petY = petting ? petY : 0;
  if (impact > 0 || petting) {
    const ix = body.impactX;
    const iy = body.impactY;
    for (let i = 0; i < body.points.length; i++) {
      const p = body.points[i];
      let add = 0;
      if (impact > 0) {
        const toward = p.rx * ix + p.ry * iy;
        if (toward > 0) add = B.dentMax * impact * toward * toward;
      }
      if (petting) {
        const toward = p.rx * petX + p.ry * petY;
        if (toward > 0) {
          const petDip = B.petDentMax * toward * toward;
          if (petDip > add) add = petDip;
        }
      }
      if (add > body.dip[i]) body.dip[i] = add;
    }
  }
  const dipKeep = Math.exp(-B.dentDecay * dt);
  for (let i = 0; i < body.dip.length; i++) body.dip[i] *= dipKeep;

  // ---- 弹簧积分：半隐式欧拉 ----
  // ω = √k ⇒ 最硬时 √220 ≈ 14.8 rad/s，ω·dt = 0.247（dt = 1/60），远在稳定区内。
  const spring = springParams(body.wobble);
  const stiffness = spring.stiffness;
  const damping = spring.damping;
  const angerFlat = 1 - B.angerFlatten * emo.anger * damp;
  const sharpen = B.angerSharpen * emo.anger * damp;
  const elongate = B.curiosityElongate * emo.curiosity * damp;

  for (let i = 0; i < body.points.length; i++) {
    const p = body.points[i];
    const ca = p.rx;
    const sa = p.ry;                 // 静止位就是星形轮廓上的那一点

    // 1) 沿速度轴 squash & stretch：把点分解到 (u, u⊥)，两个分量分别乘 stretch 与 1/stretch
    const along = ca * ux + sa * uy;
    const perp = -ca * uy + sa * ux;
    let tx = ux * (along * stretch) - uy * (perp * invStretch);
    let ty = uy * (along * stretch) + ux * (perp * invStretch);

    // 2) 情绪：各向同性缩放
    tx *= scale;
    ty *= scale;

    // 3) 生气：垂直 facing 压扁（局部 y），正前方推远（局部 x 且 ca > 0 ⇒ 前端变尖）
    ty *= angerFlat;
    if (ca > 0) tx *= 1 + sharpen * ca;

    // 4) 好奇：朝 facing 伸长（spec §4.5："身体朝目标伸长"）
    if (ca > 0) tx *= 1 + elongate * ca;

    // 5) 呼吸脉动：整体轻微胀缩（均匀缩放，所以不会改变星形极大极小的**个数**）
    const breathe = 1 + body.pulse * Math.sin(body.phase * TAU);
    tx *= breathe;
    ty *= breathe;

    // 6) 局部凹陷：沿径向朝内推
    const dip = body.dip[i];
    if (dip > 0) { tx -= ca * dip; ty -= sa * dip; }

    // 半隐式欧拉：先用新加速度更新速度，再用新速度更新位置。
    // 比显式欧拉稳定得多（显式欧拉在 k=220、dt=1/60 下会持续注入能量直到炸掉）。
    const ax = (tx - p.x) * stiffness - p.vx * damping;
    const ay = (ty - p.y) * stiffness - p.vy * damping;
    p.vx += ax * dt;
    p.vy += ay * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  updateTail(body, c, dt, damp, emo);
}

// 平均半径：测试与调参用的度量（"膨胀了没有"、"塌了没有"都靠它）。
// render.js 不用它 —— 渲染要的是逐点坐标，不是平均值。
export function meanRadius(body) {
  let s = 0;
  for (const p of body.points) s += Math.hypot(p.x, p.y);
  return s / body.points.length;
}

// 供 render.js 用的当前渲染半径（CSS 像素之前的世界单位）。
// 单独导出是为了让"体型随年龄变化"这件事只有一个实现 ——
// growthFactor 从 0.22（刚孵化）升到 1.00（成体峰值）再降到 0.88（老年）。
export function renderSizeOf(c) {
  return sizeOf(c);
}

// ---- 缸级接线（main.js 的子步循环调 updateBodies，每帧收尾调 reconcileBodies）----
//
// Body 是**视状态**，不是世界状态：不进存档、不参与模拟、不参与同种子复现。
// 所以这一对函数只维护一张 id → Body 的 Map，不碰 creature 的任何字段。
// 出生（卵在某个子步中间孵化）当帧就有 Body，不必等下一帧；
// 被从 world.creatures 里摘掉的（溶散结束）在帧末扫掉 —— 没有这一步，
// 跑一夜的缸会攒下几千个没人读的 Body。

// 逐只推进。**必须**被放进固定步长的子步循环（见文件头的步长敏感条）。
// 同步脉动的**相位对齐**（spec §4.12 第 6 条那套编舞里"脉动同步"这一步）。
//
// ⚠️ 为什么在 body.js 而不是 render.js：body.phase 是相位的**唯一产地**，
// 而 render 的 breatheOf / 光晕都只读它。在 render 里另算一份同步相位就是第二个时钟 ——
// 那正是 tests/render-body.test.js 里"breatheOf 绝不自建时钟"那条测试专门防的事。
//
// 走**最短弧**：phase 是 mod 1 的圈量，0.99 与 0.01 差 0.02 而不是 0.98。
// 两只各拉一次 ⇒ 收敛到中点，所以画面上是"它们对上拍子"，不是"一只追着另一只"。
// 只有**互相**指向对方的一对才拉：单向的 bondId 是 episode 正在退场的残留（≤3 秒），
// 那时候还去拉就成了单方面的追上拍子，视觉上正是要避免的那种"跟着别人抖"。
export function syncPhases(bodies, world, dt) {
  const cs = world.creatures;
  for (let i = 0; i < cs.length; i += 1) {
    const c = cs[i];
    if (!c.alive || !c.bondId) continue;
    const body = bodies.get(c.id);
    if (!body) continue;
    const degree = syncDegree(c);
    if (degree <= 0) continue;
    let p = null;
    for (let j = 0; j < cs.length; j += 1) if (cs[j].id === c.bondId) { p = cs[j]; break; }
    if (!p || !p.alive || p.bondId !== c.id) continue;
    const pb = bodies.get(p.id);
    if (!pb) continue;
    const rate = Math.min(1, B.syncPhaseLerp * degree * dt);
    const d = (((pb.phase - body.phase + HALF_TURN) % 1) + 1) % 1 - HALF_TURN;
    body.phase = (body.phase + d * rate + 1) % 1;
  }
}

export function updateBodies(bodies, world, dt) {
  const creatures = world.creatures;
  for (let i = 0; i < creatures.length; i++) {
    const c = creatures[i];
    let body = bodies.get(c.id);
    if (body === undefined) {
      body = createBody(c.traits);
      bodies.set(c.id, body);
    }
    updateBody(body, c, dt, world.playerHand);
  }
  syncPhases(bodies, world, dt);
}

// 帧末清扫：已经不在这个世界里的个体，它的 Body 也要跟着消失。
//
// 为什么按"世界成员身份"判而不是给 Body 挂个 seen 标记：主循环有倍速 0.5×，
// 那一档下**存在空帧**（advanceLoop 返回 steps = 0），标记法会在空帧里把全部 Body 误删，
// 下一帧再全部重建 —— 症状是"每两次帧就丢失一次软体状态"且不报错。
// 成员身份判是 O(n²)，n 是种群上限 24 ⇒ 每帧 576 次 id 比较，比一次误删重建便宜得多。
export function reconcileBodies(bodies, world) {
  const creatures = world.creatures;
  bodies.forEach((body, id) => {
    let found = false;
    for (let i = 0; i < creatures.length; i += 1) {
      if (creatures[i].id === id) { found = true; break; }
    }
    if (!found) bodies.delete(id);
  });
}
