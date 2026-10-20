// 性格基因 → 阈值与权重的纯映射（spec 4.9）。
//
// 设计要点：性格不指定行为，只调阈值与权重。
// 本模块是纯函数、无状态、不依赖随机源 —— 同一份性格永远给出同一组阈值，
// 这是"固定种子下决策可复现"（spec 8.1）能成立的前提。
//
// 数值区间全部从 CONFIG 取（2026-10-20 起），不在这里硬编码 ——
// 新增的六项里 hop / speech / broody 的上下界都是要按观感调的旋钮，
// 钉在本文件里就等于绕过了 config.js 这个唯一来源。
import { CONFIG } from './config.js';
//
// 每个方向的注释都写明了"高 → 效果"，改数值时照着注释检查方向，
// 方向搞反是本模块最容易犯且最难发现的错误。
export function thresholds(p) {
  const bold = p.bold;
  const clingy = p.clingy;
  const irritable = p.irritable;
  const gluttonous = p.gluttonous;
  const curious = p.curious;
  const broody = p.broody;
  const activity = p.activity;
  const talk = p.talk;
  const intellect = p.intellect;
  const { hop: H, speech: S, broody: B } = CONFIG;

  return {
    // bold 高 → 需要更大的威胁才害怕（阈值高）
    fearThreshold: 0.3 + bold * 0.5,

    // irritable 高 → 一点火星就炸（阈值低）
    angerThreshold: 0.65 - irritable * 0.45,

    // irritable 高 → 气得更久（秒）
    angerDuration: 4 + irritable * 12,

    // gluttonous 高 → 还没真饿就去觅食（触发阈值低）
    hungerTrigger: 0.55 - gluttonous * 0.3,

    // clingy 高 → 稍感孤单就去找同伴（触发阈值低）
    socialTrigger: 0.5 - clingy * 0.28,

    // curious 高 → 探索半径大（归一化世界单位）
    exploreRadius: 0.25 + curious * 0.6,

    // 卖萌倾向：黏人与胆大都推高，暴躁压低。
    // 允许为负 —— 负值意味着它会主动避开玩家的手。
    // 两端取值由测试用字面量钉住：bold=1,clingy=1,irritable=0 → 0.8；
    // bold=0,clingy=0,irritable=1 → -0.35（负值这一侧必须真的被走到，
    // 否则"负值意味着避开玩家的手"这句话只是散文）。
    playerApproach: clingy * 0.5 + bold * 0.3 - irritable * 0.35,

    // bold 高 → 转身果断（rad/s）。胆小的迟疑，这本身就是身体语言。
    turnRate: 2 + bold * 4,

    // ⚠️ 孤雌改造的中间态，Task A2 删除。
    // 现在由 broody 驱动（原来的 libido 已不存在）。留着是因为 breeding.js / behavior.js
    // 的求偶评分仍在读它 —— 现在删会让分数静默变 NaN，那笔提交看起来是绿的但已经坏了。
    courtshipWillingness: 0.6 + broody * 0.8,

    // ---- 2026-10-20 新增六项（spec §4.9）----
    // 方向注释一律写"X 高 → 效果"，改数值时照注释检查方向；方向反了是本模块最难的 bug。

    // activity 高 → 更爱蹦（hop 的效用权重）
    hopWeight: H.weightBase + activity * H.weightGain,

    // activity 高 → 精力掉得快（"累了会休息"的物理前提；与 hopWeight 同向是刻意的，
    // 两者一起才让好动的个体自己把蹦跳停掉，而不需要任何硬门控）
    energyDrainFactor: H.drainBase + activity * H.drainGain,

    // talk 高 → 出词冷却短（秒）。min 侧给话痨，max 侧给高冷。
    speechCooldown: S.cooldownMax - talk * (S.cooldownMax - S.cooldownMin),

    // intellect 高 → 能记住的"听进去的话"更多（条数，取整后使用）
    heardCapacity: S.heardBase + intellect * S.heardGain,

    // intellect 高 → 复述越准（说错词的概率，0 处取 misspeakMax）
    misspeakChance: S.misspeakMax * (1 - intellect),

    // broody 高 → 自产卵间隔越短（秒）。区间来自 CONFIG，不在此处硬编码。
    broodInterval: B.intervalMax - broody * (B.intervalMax - B.intervalMin),
  };
}
