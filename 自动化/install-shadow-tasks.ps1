param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Root = 'E:\fb+bm\public-knowledge-publisher'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$TaskName = 'OfficialKnowledge-ShadowHealth-30m'
$Script = Join-Path $Root '自动化\official-knowledge-coordinator.mjs'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "已移除任务：$TaskName"
  exit 0
}

if (-not (Test-Path -LiteralPath $Script)) { throw "未找到协调器：$Script" }
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Script) -WorkingDirectory $Root
$Triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(17) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650))
)
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings -Principal $Principal -Description '官方知识影子模式：每30分钟校验最后合格公开知识包；不联网刷新、不读取真实账户或经营数据。' -Force | Out-Null
Write-Output "已安装影子模式任务：$TaskName"
