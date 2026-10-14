param(
    [int]$ProcessId,
    [string]$OutputPath
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Screenshot {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }
}
"@

# Find window by process ID
$proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Error "Process not found: $ProcessId"
    exit 1
}

$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Error "No main window for PID $ProcessId"
    exit 1
}

# Get window rectangle
$rect = New-Object Win32Screenshot+RECT
[Win32Screenshot]::GetWindowRect($hwnd, [ref]$rect) | Out-Null

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

Write-Host "Window: $width x $height at ($($rect.Left), $($rect.Top))"

if ($width -le 0 -or $height -le 0) {
    Write-Error "Invalid dimensions"
    exit 1
}

# Bring to front
[Win32Screenshot]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300

# Capture
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
$bitmap.Save($OutputPath)
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Saved to: $OutputPath"
