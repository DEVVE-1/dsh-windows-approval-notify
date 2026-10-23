# DSH approval notification host.
# Reads one JSON object per line from stdin: {"title":"...","body":"..."}
# Preloads the WinRT toast API once, then shows a toast per line.
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $appId = 'com.deepseek.dsh'
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
} catch {
    [Console]::Out.WriteLine('fatal')
    [Console]::Out.Flush()
    exit 1
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    try {
        $payload = $line | ConvertFrom-Json
        $title = [System.Security.SecurityElement]::Escape([string]$payload.title)
        $body = [System.Security.SecurityElement]::Escape([string]$payload.body)
        $xml = '<toast activationType="foreground"><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>'
        $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
        $doc.LoadXml($xml)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
        $toast.Tag = 'dshApproval'
        $toast.Group = 'dshNotify'
        $notifier.Show($toast)
        [Console]::Out.WriteLine('ok')
    } catch {
        [Console]::Out.WriteLine('err')
    }
    [Console]::Out.Flush()
}
