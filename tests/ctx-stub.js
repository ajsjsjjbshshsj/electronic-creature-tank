// 记录型 ctx 桩的**共同那一半：域检查**。
//
// 为什么要单独一个文件（2026-10-25，清单 §12.11）：真 CanvasRenderingContext2D 在下面这几种
// 输入上是**当场抛**的，而四份各抄一份的桩照单全收 —— 于是"渲染层某处算出一个 NaN"
// 在测试里是一帧照常绘制，在真浏览器里是一整帧异常。与 F-13（`children.length=0`）、
// F-14（`style['--x']=v`）同一族：**桩替平台撒谎**。
//
// 真页面实测（同一台 Chrome，逐项试过）：
//   createRadialGradient 负半径            → DOMException
//   createLinearGradient 坐标 NaN          → TypeError
//   addColorStop at = 1.2 / NaN            → DOMException / TypeError
//   addColorStop 颜色 'hsla(NaN,…)' 等     → DOMException
//   ellipse 半径负                          → DOMException
// 反过来，`globalAlpha` / `fillStyle` / `font` 的非法值是**静默忽略**（读回 1 或前值），
// 所以那三个不设检查 —— 设了就是把桩改得比平台更严，那是另一种撒谎。
const BAD_NUM = /(?:^|[^\w])(NaN|Infinity|-Infinity)(?:[^\w]|$)/;
const COLOR_OK = /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\)|[a-z]+)$/i;

function finite(name, nums) {
  for (const [i, v] of nums.entries()) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`桩的域检查：${name} 的第 ${i} 个参数不是有限数（${String(v)}）`
        + ' —— 真浏览器在这里抛 TypeError/DOMException，一整帧都会飞掉');
    }
  }
}

export function assertGradient(kind, ...nums) {
  finite(`${kind}Gradient`, nums);
  const n = nums.length;
  // createRadialGradient(x0,y0,r0,x1,y1,r1)：两个半径不许为负
  if (kind === 'createRadial' && (nums[2] < 0 || nums[5] < 0)) {
    throw new DOMException(`桩的域检查：createRadialGradient 半径为负（${nums[2]} / ${nums[5]}）`);
  }
}

export function assertEllipse(rx, ry) {
  finite('ellipse', [rx, ry]);
  if (rx < 0 || ry < 0) {
    throw new DOMException(`桩的域检查：ellipse 半径为负（${rx} / ${ry}）`);
  }
}

export function assertColorStop(at, color) {
  finite('addColorStop 的位置', [at]);
  if (at < 0 || at > 1) {
    throw new DOMException(`桩的域检查：addColorStop 的位置越界（${at}），合法区间是 0..1`);
  }
  if (typeof color !== 'string' || BAD_NUM.test(color) || !COLOR_OK.test(color.trim())) {
    throw new DOMException(`桩的域检查：addColorStop 收到非法颜色串 ${JSON.stringify(color)}`
      + '（真浏览器抛 DOMException：SyntaxError）');
  }
}

/**
 * 一份真会抛的 gradient 桩。调用方拿到返回值后接着调 addColorStop，
 * 所以它**不能**是 undefined（那是各份桩当初抄 `{ addColorStop() {} }` 的原因），
 * 但也不许是"什么都不检查"的那个。
 */
export function makeGradient() {
  return { addColorStop: (at, color) => assertColorStop(at, color) };
}
