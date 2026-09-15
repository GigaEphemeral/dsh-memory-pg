<#
.SYNOPSIS
  一键安装 @gigaephemeral/dsh-memory-pg 到指定 DSH profile。

.DESCRIPTION
  等价于手动执行：
    dsh plugin --profile <Profile> add @gigaephemeral/dsh-memory-pg@<Version>
  bundle 插件的 host half 需要重启 DSH web 才生效（非 HMR）。

.PARAMETER Profile
  目标 profile 名，默认 web。

.PARAMETER Version
  安装版本，默认 latest。

.EXAMPLE
  ./scripts/install.ps1
  ./scripts/install.ps1 -Profile m0test -Version 0.1.0
#>
param(
  [string]$Profile = 'web',
  [string]$Version = 'latest'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Write-Error @'
未找到 dsh 命令。请先安装 DSH 并确保 dsh 在 PATH 中；
或改用 npx 一次性执行：
  npx -y --package @deepseek-ai/dsh dsh plugin --profile web add @gigaephemeral/dsh-memory-pg@latest
'@
}

$pkg = "@gigaephemeral/dsh-memory-pg@$Version"
Write-Host "==> dsh plugin --profile $Profile add $pkg"
dsh plugin --profile $Profile add $pkg
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '已安装。bundle 插件 host half 需重启 DSH web 才生效（非 HMR）：'
Write-Host '  - 桌面版：重启 DSH 应用'
Write-Host '  - CLI：停止 dsh web 后重新启动'
Write-Host '重启后在设置面板配置数据库连接，即可使用 /memory-pg-* 命令。'
