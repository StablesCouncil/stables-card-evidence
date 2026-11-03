# The Stables guardian on the founder's Windows PC, as a scheduled task that starts at log-on and restarts on failure.
# NOT RUN. Review, then run once in PowerShell (no administrator needed; the task runs as the current user):
#   pwsh -File install-windows-task.ps1 [-Remove]
# It runs `node guardian.mjs watch` in this folder's parent. Dry run unless guardian.config.json has "allowPost": true
# AND -Post is given here.
param([switch]$Remove, [switch]$Post)
$name = 'Stables guardian'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; return }
$dir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$arguments = 'guardian.mjs watch --config guardian.config.json' + ($(if ($Post) { ' --post' } else { '' }))
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $dir
$triggers = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)))
# Restart every minute on failure; never two at once (the repeating trigger only restarts it if it died).
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
  -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Description 'Watches the Stables card vault; see GUARDIAN_DESIGN.md' | Out-Null
Write-Output "Registered '$name' in $dir. Laptop note: a sleeping PC checks nothing; set sleep to Never while plugged in."
