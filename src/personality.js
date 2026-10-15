// 性格基因 → 阈值与权重的纯映射（spec 4.9）。
//
// 设计要点：性格不指定行为，只调阈值与权重。
// 本模块是纯函数、无状态、不依赖随机源 —— 同一份性格永远给出同一组阈值，
// 这是"固定种子下决策可复现"（spec 8.1）能成立的前提。
//
// 每个方向的注释都写明了"高 → 效果"，改数值时照着注释检查方向，
// 方向搞反是本模块最容易犯且最难发现的错误。
export function thresholds(p) {
  const bold = p.bold;
  const clingy = p.clingy;
  const irritable = p.irritable;
  const gluttonous = p.gluttonous;
  const curious = p.curious;
  const libido = p.libido;

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

    // libido 高 → 更容易接受求偶（作为求偶评分的乘子）
    courtshipWillingness: 0.6 + libido * 0.8,
  };
}
