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
