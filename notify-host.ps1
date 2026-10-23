# DSH notification host.
# Reads one JSON object per line from stdin:
#   {"title":"...","body":"...","tag":"...","onlyWhenBackground":true,"activeWindowMarkers":["..."]}
# Prints "ready" once the foreground helper is loaded, then "skip" (suppressed
# because DSH is the foreground program), "ok", or "err" per line.
# The WinRT toast API is loaded on the first line that actually needs a toast.
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false

. (Join-Path $PSScriptRoot 'foreground.ps1')

$notifier = $null

function Initialize-Notifier {
    if ($null -ne $script:notifier) { return $true }
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $script:notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.deepseek.dsh')
        return $true
    } catch {
        [Console]::Out.WriteLine('fatal')
        [Console]::Out.Flush()
        return $false
    }
}

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    try {
        $payload = $line | ConvertFrom-Json
        if ($payload.onlyWhenBackground -eq $true) {
            if (Test-DshForegroundMatches @($payload.activeWindowMarkers)) {
                [Console]::Out.WriteLine('skip')
                [Console]::Out.Flush()
                continue
            }
        }
        if (-not (Initialize-Notifier)) { exit 1 }
        $title = [System.Security.SecurityElement]::Escape([string]$payload.title)
        $body = [System.Security.SecurityElement]::Escape([string]$payload.body)
        $xml = '<toast activationType="foreground"><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>'
        $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
        $doc.LoadXml($xml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
        $tag = [string]$payload.tag
        if ([string]::IsNullOrWhiteSpace($tag)) { $tag = 'dshNotify' }
        $toast.Tag = $tag
        $toast.Group = 'dshNotify'
        $notifier.Show($toast)
        [Console]::Out.WriteLine('ok')
    } catch {
        [Console]::Out.WriteLine('err')
    }
    [Console]::Out.Flush()
}
