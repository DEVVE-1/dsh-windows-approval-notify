# Foreground-window matching used by notify-host.ps1.
# Test-DshForegroundMatches returns $true when the title of the current
# foreground window contains any of the given markers (case-insensitive),
# which means the DSH window is the program the user is looking at.
Add-Type -Namespace DshNotify -Name Window -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
'@

function Get-DshForegroundTitle {
    try {
        $hwnd = [DshNotify.Window]::GetForegroundWindow()
        if ($hwnd -eq [System.IntPtr]::Zero) { return '' }
        $sb = New-Object System.Text.StringBuilder 1024
        [void][DshNotify.Window]::GetWindowText($hwnd, $sb, $sb.Capacity)
        return $sb.ToString()
    } catch {
        return ''
    }
}

function Test-DshForegroundMatches([object[]]$markers) {
    if ($null -eq $markers) { return $false }
    $title = Get-DshForegroundTitle
    if ([string]::IsNullOrWhiteSpace($title)) { return $false }
    foreach ($marker in $markers) {
        $text = [string]$marker
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        if ($title.IndexOf($text, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}
