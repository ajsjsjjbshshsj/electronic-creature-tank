# server.ps1 —— 静态文件服务。零依赖：只用 Windows PowerShell 5.1 自带的 .NET HttpListener。
#
# 为什么必须有它：浏览器把 file:// 下的 ES Modules 当跨源请求拒绝加载，
# 双击 index.html 只会得到一片空白。所以"零依赖"指零 npm 依赖，不是零服务器。
#
# 静态文件服务 + /api/save（共享存档，2026-10-29 落地）。
# ⚠️ /api/save **没有认证**：能连上这个端口的人都能读写这缸 ⇒ 只适合家庭局域网。
# 协议见 docs/superpowers/specs/2026-10-29-shared-save-lan-design.md。

[CmdletBinding()]
param(
  [int]$Port = 8123,
  [string]$Root = '',
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# $Root 的默认值必须在脚本体里补，不能写成 [string]$Root = $PSScriptRoot：
# Windows PowerShell 5.1 求值 param 默认值时 $PSScriptRoot 还是空串（实测：
# 换成纯 ASCII 目录同样为空，所以与本项目根目录的中文名无关），于是
# [IO.Path]::GetFullPath('') 直接抛异常、服务器根本起不来。
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = $PSScriptRoot }

# ⚠️ .js 必须是 text/javascript：ES Modules 对 MIME 有硬性要求，送成 text/plain
# 浏览器会直接拒绝执行 <script type="module">，症状是页面全黑、服务器日志一切正常。
$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
  '.md'   = 'text/plain; charset=utf-8'
}

$RootFull = [System.IO.Path]::GetFullPath($Root)
# 必须带尾部分隔符再比前缀：否则 F:\电子宠物-备份\ 也会"以 F:\电子宠物 开头"，
# 目录穿越守卫就漏了一个真实可越权读取的兄弟目录。
$RootPrefix = $RootFull.TrimEnd('\') + '\'

# ---- 访问口令（2026-10-31）----
# 为什么需要它：tailscale funnel 会把这条缸挂到**公网**上，而 /api/save 本身没有认证
# —— 谁拿到网址谁就能读、能改、能清档。所以给整个服务器加一道 Cookie 门：
# 页面与接口都要过，口令存在本地文件里（不进版本库），第一次启动自动生成。
# 分享时发"含口令的链接"（`?k=...`）：浏览器会记住 Cookie，之后不再需要带它。
$TokenFile = Join-Path $RootFull 'access-token.txt'
$Utf8Token = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
  $bytes = New-Object byte[] 18
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $tok = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').Replace('=', '')
  [System.IO.File]::WriteAllText($TokenFile, $tok, $Utf8Token)
}
$AccessToken = ([System.IO.File]::ReadAllText($TokenFile, $Utf8Token)).Trim()

function Test-Access($ctx) {
  # 返回 'ok'（Cookie 已对上）/ 'grant'（这次带了 ?k=，要对上并种 Cookie）/ 'deny'
  try {
    $c = $ctx.Request.Cookies['tank']
    if ($null -ne $c -and "$($c.Value)" -ceq $AccessToken) { return 'ok' }
  } catch { }
  $k = $ctx.Request.QueryString['k']
  if ($null -ne $k -and "$k" -ceq $AccessToken) { return 'grant' }
  return 'deny'
}

function Send-PasswordPage($ctx) {
  $res = $ctx.Response
  $res.StatusCode = 401
  $res.ContentType = 'text/html; charset=utf-8'
  $res.Headers.Add('Cache-Control', 'no-store')
  $html = '<!doctype html><meta charset="utf-8"><title>要口令</title>' +
    '<style>body{background:#0B0620;color:#ffd9e8;font:16px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0}' +
    'form{text-align:center}input{font:inherit;padding:8px 12px;border-radius:10px;border:1px solid #ffd9e8;background:#1A0B2E;color:inherit}' +
    'button{font:inherit;padding:8px 16px;border-radius:10px;border:0;background:#ffd9e8;color:#2d1240;margin-left:8px}</style>' +
    '<form method="get"><div>这条缸要口令</div><input name="k" autofocus autocomplete="off"><button>进</button></form>'
  $bytes = $Utf8Token.GetBytes($html)
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.Close()
}

function Send-Granted($ctx) {
  $res = $ctx.Response
  $res.StatusCode = 302
  $res.Headers.Add('Set-Cookie', "tank=$AccessToken; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax")
  $res.Headers.Add('Location', $ctx.Request.Url.AbsolutePath)
  $res.ContentLength64 = 0
  $res.Close()
}

function Start-Listener([string]$Prefix) {
  $l = New-Object System.Net.HttpListener
  $l.Prefixes.Add($Prefix)
  $l.Start()
  return $l
}

# 先试 +:（所有网卡，手机同 WiFi 可打开同一个缸）。它需要 URL ACL 授权，
# 普通用户会拿到 AccessDenied —— 那就退回 localhost，并把授权命令打印出来，
# 而不是静默地只服务本机（那会让 spec"手机电脑同一个缸"莫名其妙失效、且无从归因）。
$Listener = $null
$LanMode = $true
try {
  $Listener = Start-Listener "http://+:$Port/"
} catch {
  $LanMode = $false
  $Listener = Start-Listener "http://localhost:$Port/"
}

Write-Host ''
Write-Host '  电子生物缸 · 本地服务器已启动' -ForegroundColor Magenta
Write-Host "  本机打开： http://localhost:$Port/" -ForegroundColor Cyan
if ($LanMode) {
  # 只列**别人真能连上**的地址：169.254.*（链路本地，没拿到 DHCP 时的兜底）连不上，
  # 列出来只会让人挑错。192.168.* 排前面（家庭局域网里最常见的那一类）。
  # 2026-10-31 实测：不过滤时横幅里六行有五行是 169.254，唯一的 192.168 夹在中间。
  # 100.64–100.127 是 Tailscale 用的 CGNAT 段：它由下面那条"异地（Tailscale）"专行列，
  # 混在"同一 WiFi"里会让人以为那是家里局域网的地址。
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -ne '127.0.0.1' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.IPAddress -notmatch '^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.'
    } |
    Sort-Object @{ Expression = { if ($_.IPAddress -like '192.168.*') { 0 } else { 1 } } }, IPAddress
  foreach ($ip in $candidates) {
    Write-Host "  同一 WiFi： http://$($ip.IPAddress):$Port/" -ForegroundColor Green
  }
} else {
  Write-Host '  ⚠ 目前只能本机访问。要让手机/朋友打开同一个缸，用管理员 PowerShell 跑一次：' -ForegroundColor Yellow
  Write-Host "     netsh http add urlacl url=http://+:$Port/ user=$env:USERNAME" -ForegroundColor Yellow
}

# Tailscale（异地共享这一档）：装了并把这一台加进 tailnet，就把 100.x 那条地址打出来 ——
# 朋友要开的就是它。没装 / 没登录 / 命令失败一律安静跳过，不许因为探测失败把服务器搞崩。
# ⚠️ 它仍然走同一个端口与同一套 URL ACL：上面那条 urlacl 没跑的话，Tailscale 也连不上。
$TailscaleIp = $null
try {
  # PATH 里找不到就试安装目录：Windows 安装器**不一定**把 Tailscale 加进当前会话的 PATH
  # （2026-10-31 实测：服务在跑、tailscale.exe 在 Program Files，而 Get-Command 找不到它）。
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  $tsExe = if ($ts) { $ts.Source } else { Join-Path (Join-Path $env:ProgramFiles 'Tailscale') 'tailscale.exe' }
  if (Test-Path -LiteralPath $tsExe) {
    $line = (& $tsExe ip -4 2>$null | Select-Object -First 1)
    if ("$line" -match '^100\.') { $TailscaleIp = "$line".Trim() }
  }
} catch { }
if ($TailscaleIp) {
  Write-Host "  异地（Tailscale）： http://$($TailscaleIp):$Port/" -ForegroundColor Green
}
Write-Host "  含口令的链接： http://localhost:$Port/?k=$AccessToken" -ForegroundColor Cyan
Write-Host "     （发给朋友的就是这一条；他打开一次就记住，之后不用再带口令）" -ForegroundColor DarkGray
Write-Host "     换口令：删掉 $TokenFile 再重启。" -ForegroundColor DarkGray
Write-Host '  关掉本窗口或 Ctrl+C 即停止。' -ForegroundColor DarkGray
Write-Host ''


# ---- /api/save（共享存档，2026-10-29）----
# 协议与控制方 2026-10-29 的两条裁定见 docs/superpowers/specs/2026-10-29-shared-save-lan-design.md。
# ⚠️ **没有认证**：能连上这个端口的人都能读、能写这缸，所以它只适合家庭局域网。
# revision 只由**服务器**递增（spec §7.5 原文）：客户端携带它加载时读到的那个数，
# 两边各算一套编号的那种错法在这里一次性排掉。
$SaveFile = Join-Path $RootFull 'save.json'
$SaveTemp = Join-Path $RootFull 'save.json.tmp'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-ApiJson($ctx, [int]$status, $payload) {
  # 空响应体必须写 0 字节而不是"空对象"：404 那条路由的约定就是没有 body。
  $text = if ($null -eq $payload) { '' } else { ConvertTo-Json -InputObject $payload -Depth 40 -Compress }
  $bytes = $Utf8NoBom.GetBytes($text)
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.ContentLength64 = $bytes.Length
  if ($bytes.Length -gt 0) { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
  $ctx.Response.Close()
}

function Read-SaveFile {
  if (-not (Test-Path -LiteralPath $SaveFile -PathType Leaf)) { return $null }
  try { return ([System.IO.File]::ReadAllText($SaveFile, $Utf8NoBom) | ConvertFrom-Json) }
  # 坏档按"没有"处理：下一次 PUT 从 0 重新建。**不删也不改**那份坏文件 ——
  # 它是证据（spec §7.7 对坏档的一贯态度）。
  catch { return $null }
}

function Invoke-SaveApi($ctx) {
  $method = $ctx.Request.HttpMethod
  $doc = Read-SaveFile
  $cur = if ($null -eq $doc) { 0 } else { [int]$doc.revision }

  if ($method -eq 'GET') {
    if ($null -eq $doc) { Write-ApiJson $ctx 404 $null }
    else { Write-ApiJson $ctx 200 ([pscustomobject]@{ revision = $cur; doc = $doc }) }
    return
  }
  if ($method -eq 'DELETE') {
    # 清档：删掉磁盘上那一份（幂等 —— 本来就没有也返回 200）。
    # 这条路由是"清档"按钮的远端一半：少了它，远端模式下按清档只清本机，
    # 刷新之后服务器那份又回来了（用户看到的是"清档没生效"）。
    if (Test-Path -LiteralPath $SaveFile) { Remove-Item -LiteralPath $SaveFile -Force }
    Write-ApiJson $ctx 200 ([pscustomobject]@{ revision = 0 })
    return
  }
  if ($method -ne 'PUT') { Write-ApiJson $ctx 405 $null; return }

  $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, $Utf8NoBom)
  $raw = $reader.ReadToEnd()
  $reader.Dispose()
  $body = $null
  try { $body = $raw | ConvertFrom-Json } catch { $body = $null }
  if ($null -eq $body -or $null -eq $body.doc) { Write-ApiJson $ctx 400 $null; return }

  $base = 0
  if ($null -ne $body.baseRevision) { $base = [int]$body.baseRevision }
  if ($base -ne $cur) {
    # **一个字节都不写**（§7.5 "不覆盖"）。409 带回磁盘上的版本：客户端的"接管"要用它。
    Write-ApiJson $ctx 409 ([pscustomobject]@{ revision = $cur })
    return
  }

  $next = $cur + 1
  # revision 由服务器盖上去，客户端送来的那个值一律不认（Add -Force 覆盖它）。
  $body.doc | Add-Member -NotePropertyName revision -NotePropertyValue $next -Force
  $text = ConvertTo-Json -InputObject $body.doc -Depth 40 -Compress
  # 原子写：先 tmp 再 Move。写到一半断电也不会在 save.json 上留下半份档。
  [System.IO.File]::WriteAllText($SaveTemp, $text, $Utf8NoBom)
  Move-Item -LiteralPath $SaveTemp -Destination $SaveFile -Force
  Write-ApiJson $ctx 200 ([pscustomobject]@{ revision = $next })
}

if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($Listener.IsListening) {
    $Context = $Listener.GetContext()
    $Res = $Context.Response
    try {
      # 访问口令门：整台服务器（页面 + 接口）都过这一道，见上面 $TokenFile 那段。
      $access = Test-Access $Context
      if ($access -eq 'deny') { Send-PasswordPage $Context; continue }
      if ($access -eq 'grant') { Send-Granted $Context; continue }

      $Raw = $Context.Request.Url.AbsolutePath
      if ($Raw -eq '/') { $Raw = '/index.html' }

      # /api/save 走存档路由；其余 /api/* 一律 404（不给自己留暗门）。
      if ($Raw -eq '/api/save') {
        Invoke-SaveApi $Context
        continue        # Invoke-SaveApi 自己关了响应，别再走下面的静态文件分支
      }
      if ($Raw.StartsWith('/api/')) {
        # 必须**关掉**响应再 continue：只设 StatusCode 不关，客户端会一直等 body
        # （实测症状：fetch 永远挂着，验收脚本在第七项停死）。
        $Res.StatusCode = 404
        $Res.ContentLength64 = 0
        $Res.Close()
        continue
      }

      $Decoded = [System.Uri]::UnescapeDataString($Raw)
      $Candidate = [System.IO.Path]::GetFullPath((Join-Path $RootFull $Decoded.TrimStart('/')))

      # 目录穿越守卫。这个服务器会绑到局域网，同网段任何设备都能访问，
      # 所以 ../../ 必须挡住 —— 否则整个磁盘都是只读公开的。
      if (-not $Candidate.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $Res.StatusCode = 403
      } elseif (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        $Res.StatusCode = 404
      } else {
        $Ext = [System.IO.Path]::GetExtension($Candidate).ToLowerInvariant()
        $Bytes = [System.IO.File]::ReadAllBytes($Candidate)
        if ($Mime.ContainsKey($Ext)) { $Res.ContentType = $Mime[$Ext] }
        else { $Res.ContentType = 'application/octet-stream' }
        $Res.ContentLength64 = $Bytes.Length
        $Res.OutputStream.Write($Bytes, 0, $Bytes.Length)
      }
    } catch {
      # spec §7.7：绝不让整个世界崩溃。单个请求出错只回 500，服务器继续跑。
      try { $Res.StatusCode = 500 } catch { }
    }
    try { $Res.OutputStream.Close() } catch { }
  }
} finally {
  $Listener.Close()
}
