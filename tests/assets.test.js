import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';

// 静态资源的一致性守卫。
//
// 为什么需要它：spec §3.4-5 决定把静态深水背景交给 CSS（省掉每帧一次全屏填充），
// 于是同一组颜色**必然**在两个地方各存一份 —— CONFIG.colors 与 css/main.css。
// CSS 读不到 JS，这份重复消不掉；那就让测试盯着它，别让两边各自漂移。
// 漂移的症状极难查：缸底沉积带（render.js 用 CONFIG）和背景（CSS 用字面量）
// 会慢慢对不上色，而没有任何一处报错。

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('css/main.css 的三个背景色与 CONFIG.colors 逐字相同', () => {
  const css = read('../css/main.css');
  for (const [name, hex] of [
    ['bgTop', CONFIG.colors.bgTop],
    ['bgMid', CONFIG.colors.bgMid],
    ['bgBottom', CONFIG.colors.bgBottom],
  ]) {
    // 大小写不敏感地找：CSS 里写小写十六进制是常见习惯，
    // 但"颜色相同"不该被大小写判成不一致。
    assert.ok(
      css.toLowerCase().includes(hex.toLowerCase()),
      `css/main.css 里没有 ${name} = ${hex}；spec §3.4-5 要求背景由 CSS 承担，两边必须同色`,
    );
  }
});

// ---- HUD 的"可见性"是跨文件的两个定义点（F-12，2026-10-25 浏览器实跑抓到）----
// hud.js 往 .hud-card 上写 is-open / is-settings，css/main.css 才是决定 display 的那一半。
// 桩里没有 CSS：类名写错了、或者 CSS 那条规则被删了，DOM 侧的判据全部照绿，
// 而玩家看到的是"点了没反应"。所以这里双向钉：两边都必须提到同一个类名。
test('hud.js 写的可见类与 css/main.css 读的可见类必须是同一批', () => {
  const css = read('../css/main.css');
  const js = read('../src/hud.js');
  for (const cls of ['is-open', 'is-settings']) {
    assert.ok(css.includes(`.hud-card.${cls}`),
      `hud.js 在写 ${cls}，但 css/main.css 里没有 .hud-card.${cls} 这条规则 ⇒ 写了等于没写`);
    assert.ok(js.includes(`'${cls}'`),
      `css/main.css 还按 .hud-card.${cls} 决定可见性，而 hud.js 已经不写它了 ⇒ 设置页再也打不开`);
  }
  // is-open 必须真的开 display，否则上面两条钉住的是一句空规则。
  assert.match(css, /\.hud-card\.is-open\s*\{[^}]*display:\s*block/);
});

// 心形的填充度是同一个道理的第二个实例：JS 写一个 CSS 自定义属性，名字对不上就静默无效。
// F-14 抓的是"写的方式"不对（style['--x']=v 进不了层叠），这条抓"名字"漂移 ——
// 两边各改一半的症状是心形永远空着，而没有任何一处报错。
test('--heart-fill 这个名字在 hud.js 与 css/main.css 之间不许漂移', () => {
  const css = read('../css/main.css');
  const js = read('../src/hud.js');
  assert.match(js, /setProperty\(\s*['"]--heart-fill['"]/);
  assert.ok(css.includes('--heart-fill:'), 'css 侧不再声明默认值 ⇒ setProperty 写进一个没人读的名字');
  assert.ok(css.includes('var(--heart-fill'), 'css 侧不再消费它 ⇒ 写进去也没人画');
});

test('index.html 用 type="module" 引 /src/main.js，且声明了 viewport-fit=cover', () => {
  const html = read('../index.html');
  assert.match(html, /<script[^>]+type=["']module["'][^>]+src=["']\/src\/main\.js["']/);
  // viewport-fit=cover 是 iOS 安全区（env(safe-area-inset-*)）生效的前提，
  // 少了它 css 里那几条 padding 恒为 0，刘海屏上 HUD 会被挖掉一块。
  assert.match(html, /viewport-fit=cover/);
});

test('package.json 仍然零依赖（计划 2 不得引入任何 npm 包）', () => {
  const pkg = JSON.parse(read('../package.json'));
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[key], undefined, `package.json 不得出现 ${key}（spec §1 原则 5、§10）`);
  }
  assert.equal(pkg.type, 'module');
});

test('server.ps1 把 .js 送成 JavaScript MIME，且有目录穿越守卫', () => {
  const ps1 = read('../server.ps1');
  // ES Modules 对 MIME 有硬性要求：送成 text/plain 浏览器直接拒绝执行，
  // 症状是页面全黑而服务器日志一切正常。这条断言就是防这个。
  assert.match(ps1, /'\.js'\s*=\s*'text\/javascript/);
  assert.match(ps1, /StartsWith/);           // 目录穿越守卫
  assert.match(ps1, /UnescapeDataString/);   // 中文路径解码（本项目根目录就叫「电子宠物」）
});

test('start.bat 先起服务器、后开浏览器，且带 -NoBrowser', () => {
  // 顺序是承重的：server.ps1 自己开浏览器的话，它会**先于监听就绪**打开，
  // 浏览器拿到连接拒绝，用户必须手动刷新 —— 症状是"有时候打不开"。
  // bat 用 start 起独立窗口的服务器（-NoBrowser 让它别开），等 2 秒再开浏览器。
  const bat = read('../start.bat');
  assert.match(bat, /server\.ps1/);
  assert.match(bat, /-NoBrowser/, '服务器窗口不许自己开浏览器');
  assert.ok(bat.indexOf('-NoBrowser') < bat.lastIndexOf('start "" "http'),
    '-NoBrowser 的服务器必须先于开浏览器那一步出现');
  assert.match(bat, /chcp 65001/, '控制台代码页要是 UTF-8，否则中文路径与横幅都会乱码');
});

test('.gitattributes 把 .bat 钉成 CRLF（唯一的双击产物，不能赌 cmd.exe 宽容）', () => {
  // 全仓库是 `* text=auto eol=lf`，但 start.bat 存在的唯一理由就是"十年后双击还能打开"
  // （spec §1 原则 5），而 cmd.exe 读纯 LF 批处理在 label/goto 上会出鬼。
  // 这条断言防的是"有人顺手把例外规则删了"—— 删掉不会有任何测试变红，
  // 只在某台机器上双击时才炸，而那正是最难归因的一类。
  const attrs = read('../.gitattributes');
  assert.match(attrs, /^\*\.bat\s+text\s+eol=crlf\s*$/m, '缺了 .bat 的 CRLF 例外');
  assert.match(attrs, /^\*\s+text=auto\s+eol=lf\s*$/m, '全仓库仍应是 LF');
});
