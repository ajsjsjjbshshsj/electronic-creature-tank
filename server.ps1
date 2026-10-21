# server.ps1 —— 静态文件服务。零依赖：只用 Windows PowerShell 5.1 自带的 .NET HttpListener。
#
# 为什么必须有它：浏览器把 file:// 下的 ES Modules 当跨源请求拒绝加载，
# 双击 index.html 只会得到一片空白。所以"零依赖"指零 npm 依赖，不是零服务器。
#
# 本计划只做静态文件服务。spec §7.1 的 /api/save 读写属计划 3。

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
  foreach ($ip in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                   Where-Object { $_.IPAddress -ne '127.0.0.1' })) {
    Write-Host "  同一 WiFi： http://$($ip.IPAddress):$Port/" -ForegroundColor Green
  }
} else {
  Write-Host '  ⚠ 目前只能本机访问。要让手机打开同一个缸，用管理员 PowerShell 跑一次：' -ForegroundColor Yellow
  Write-Host "     netsh http add urlacl url=http://+:$Port/ user=$env:USERNAME" -ForegroundColor Yellow
}
Write-Host '  关掉本窗口或 Ctrl+C 即停止。' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($Listener.IsListening) {
    $Context = $Listener.GetContext()
    $Res = $Context.Response
    try {
      $Raw = $Context.Request.Url.AbsolutePath
      if ($Raw -eq '/') { $Raw = '/index.html' }
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
