# enable-lan.ps1 —— 一次性开通"局域网 / Tailscale 访问"的两条系统设置。
#
# ⚠️ 需要**管理员**权限。脚本自己**不会**提权：它只检查并说明，怎么提权由你决定。
#    用法：右键这个文件 → "使用 PowerShell 运行"，或者双击同目录的 enable-lan.bat。
#
# 它只做两件事，各自幂等（已经设过就跳过）：
#
#   1. netsh http add urlacl url=http://+:端口/ user=当前用户
#      为什么：server.ps1 用的是 .NET HttpListener。非管理员进程只能监听
#      已经**保留**给本用户的前缀，否则只能绑 localhost。表现就是"本机能开、
#      100.x / 局域网 IP 访问返回 400"（2026-10-31 实测）。
#
#   2. 一条入站防火墙规则：TCP 8123 放行。
#      为什么：Windows 默认挡入站。Tailscale 的网卡也是普通网络接口，
#      不给规则的话，外面连进来会被静默丢掉。
#
# 撤销（不想开了就跑这两条，同样要管理员）：
#   netsh http delete urlacl url=http://+:8123/
#   Remove-NetFirewallRule -DisplayName "Tank 8123"
#
# 安全边界（别删这段）：这两条一开，**同一局域网 / 同一 tailnet 里的任何设备**都能读写这条缸
# —— /api/save 没有应用层认证。所以别把 8123 转发到公网，也别把 Tailscale 地址发给 tailnet 外的人。

[CmdletBinding()]
param(
  [int]$Port = 8123,
  # -Check 只报告现状、不改任何东西（我在没有管理员权限时用它自检脚本能不能跑）
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ruleName = "Tank $Port"
$prefix = "http://+:$Port/"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-UrlAcl {
  # netsh 的输出是本地化文本，不解析措辞：只要这一行里出现我们的前缀就算有。
  $out = netsh http show urlacl "url=$prefix" 2>&1 | Out-String
  return $out -match [Regex]::Escape($prefix)
}

function Test-FirewallRule {
  $r = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  return $null -ne $r
}

$hasAcl = Test-UrlAcl
$hasRule = Test-FirewallRule
$isAdmin = Test-Admin

Write-Host ''
Write-Host '  电子生物缸 · 开放局域网 / Tailscale 访问' -ForegroundColor Magenta
Write-Host "  端口 $Port · URL ACL：$(if ($hasAcl) { '已有' } else { '缺' }) · 防火墙规则：$(if ($hasRule) { '已有' } else { '缺' })" -ForegroundColor DarkGray
Write-Host ''

if ($Check) {
  Write-Host '  （-Check：只报告，不改任何东西）' -ForegroundColor DarkGray
  Write-Host ''
  exit 0
}

if (-not $isAdmin) {
  Write-Host '  这个窗口不是管理员，什么都改不了。两种跑法：' -ForegroundColor Yellow
  Write-Host '   · 双击同目录的 enable-lan.bat（会弹 UAC，点"是"）' -ForegroundColor Yellow
  Write-Host '   · 或右键本文件 →"使用 PowerShell 运行"，再在 UAC 上点"是"' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

if ($hasAcl) {
  Write-Host '  · URL ACL 已经有了，跳过' -ForegroundColor DarkGray
} else {
  netsh http add urlacl "url=$prefix" "user=$env:USERNAME" | Out-Null
  Write-Host "  ✓ 已保留 $prefix 给 $env:USERNAME" -ForegroundColor Green
}

if ($hasRule) {
  Write-Host '  · 防火墙规则已经有了，跳过' -ForegroundColor DarkGray
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
    -LocalPort $Port -Action Allow -Profile Any | Out-Null
  Write-Host "  ✓ 已添加防火墙入站规则「$ruleName」（TCP $Port）" -ForegroundColor Green
}

Write-Host ''
Write-Host '  完成。现在重启 start.bat，横幅里会出现：' -ForegroundColor Cyan
Write-Host '   同一 WiFi： http://<你的局域网IP>:' -NoNewline
Write-Host "$Port/" -ForegroundColor Cyan
Write-Host '   异地（Tailscale）： http://100.x.x.x:' -NoNewline
Write-Host "$Port/   ← 发给朋友的就是这条" -ForegroundColor Cyan
Write-Host ''
Write-Host '  不想开了？管理员 PowerShell 里：' -ForegroundColor DarkGray
Write-Host '   netsh http delete urlacl url=http://+:' -NoNewline
Write-Host "$Port/" -ForegroundColor DarkGray
Write-Host "   Remove-NetFirewallRule -DisplayName `"$ruleName`"" -ForegroundColor DarkGray
Write-Host ''
