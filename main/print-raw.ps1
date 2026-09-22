# Sends raw bytes (ESC/POS commands) directly to a Windows printer via the
# print spooler's RAW data type — the standard Microsoft-documented pattern
# for sending non-GDI data to a printer (see KB322091 / "RawPrinterHelper").
#
# Used instead of a native Node addon (like the `printer` npm package) because
# that package's C++ source doesn't compile against modern MSVC/Node — see
# main/printer.js for the full story. This has zero native-module dependency:
# .NET's own C# compiler (bundled with every Windows install) handles the
# Win32 P/Invoke via Add-Type, so this works out of the box on every outlet
# machine with no extra install step.
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$FilePath
)

# Add-Type with inline C# recompiles from source on EVERY invocation unless
# told to cache the compiled assembly — that recompile is the single biggest
# chunk of "why does printing feel slow" (measured ~0.5-0.8s of the total
# per-print time, on top of the unavoidable ~0.2-0.4s powershell.exe cold
# start). Compiling once to a cached DLL next to this script and loading
# THAT on every subsequent print turns it into a near-instant Add-Type -Path.
$cacheDll = Join-Path $PSScriptRoot "RawPrinterHelper.dll"

if (Test-Path $cacheDll) {
  Add-Type -Path $cacheDll
} else {
  # -OutputAssembly writes the DLL to disk but does NOT load it into this
  # session by itself — load it explicitly right after so the very first
  # print (the one that has to compile) still works, not just later ones.
  Add-Type -OutputAssembly $cacheDll -OutputType Library -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static bool SendBytesToPrinter(string printerName, byte[] bytes, out string error)
    {
        error = "";
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "POS Receipt";
        di.pDataType = "RAW";

        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
        {
            error = "OpenPrinter failed for '" + printerName + "' (Win32 error " + Marshal.GetLastWin32Error() + ")";
            return false;
        }
        try
        {
            if (!StartDocPrinter(hPrinter, 1, di))
            {
                error = "StartDocPrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
                return false;
            }
            StartPagePrinter(hPrinter);
            IntPtr pUnmanagedBytes = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
                int written;
                if (!WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out written))
                {
                    error = "WritePrinter failed (Win32 error " + Marshal.GetLastWin32Error() + ")";
                    return false;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pUnmanagedBytes);
            }
            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
        return true;
    }
}
"@
  Add-Type -Path $cacheDll
}

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
$err = ""
$result = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes, [ref]$err)
if (-not $result) {
  Write-Error $err
  exit 1
}
Write-Output "OK"
