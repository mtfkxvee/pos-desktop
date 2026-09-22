# Sends raw bytes (ESC/POS commands) to a serial/COM port — used for
# Bluetooth thermal printers.
#
# Pairing a Bluetooth printer over the classic SPP (Serial Port Profile) —
# which is what nearly every cheap 58mm/80mm Bluetooth thermal printer
# speaks — makes Windows create a normal virtual COM port for it (visible in
# Device Manager under "Ports (COM & LPT)" once paired, e.g. "COM5"). From
# there it's just a serial port: no Web Bluetooth, no native Node addon
# (`noble`/`bluetooth-serial-port`, which would need rebuilding against
# Electron's ABI on every machine — see main/printer.js's own note on why
# the `printer` npm package's native build was a dead end).
#
# .NET's System.IO.Ports.SerialPort (bundled with every Windows install)
# writes straight to that COM port with zero native-module dependency —
# same zero-install-step philosophy as print-raw.ps1's Win32 spooler path.
param(
  [Parameter(Mandatory = $true)][string]$PortName,
  [Parameter(Mandatory = $true)][string]$FilePath,
  [int]$BaudRate = 9600
)

$bytes = [System.IO.File]::ReadAllBytes($FilePath)

$port = New-Object System.IO.Ports.SerialPort($PortName, $BaudRate, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$port.WriteTimeout = 5000
try {
  $port.Open()
} catch {
  Write-Error "Gagal membuka $PortName (printer nyala & sudah di-pair via Bluetooth Settings? port dipakai app lain?): $($_.Exception.Message)"
  exit 1
}
try {
  $port.Write($bytes, 0, $bytes.Length)
  # Bluetooth SPP buffers a bit on the printer side — give it a moment to
  # actually drain/flush before we close the port out from under it.
  Start-Sleep -Milliseconds 300
} catch {
  Write-Error "Gagal menulis ke $PortName : $($_.Exception.Message)"
  exit 1
} finally {
  $port.Close()
}
Write-Output "OK"
