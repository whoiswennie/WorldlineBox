param([Parameter(Mandatory=$true)][UInt64]$WindowHandle)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowTaskbar {
  [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value { [FieldOffset(0)] public ushort kind; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Store {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out Key key);
    [PreserveSig] int GetValue(ref Key key, out Value value);
    [PreserveSig] int SetValue(ref Key key, ref Value value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll", PreserveSig=false)] static extern void SHGetPropertyStoreForWindow(IntPtr window, ref Guid id, [MarshalAs(UnmanagedType.Interface)] out Store store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
  public static string Read(ulong window, uint property) {
    Guid id = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); Store store;
    SHGetPropertyStoreForWindow(new IntPtr(unchecked((long)window)), ref id, out store);
    try {
      Key key = new Key { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = property }; Value value;
      Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
      try { return value.kind == 31 ? Marshal.PtrToStringUni(value.pointer) : null; }
      finally { PropVariantClear(ref value); }
    } finally { Marshal.ReleaseComObject(store); }
  }
}
'@
@{
  appId = [WindowTaskbar]::Read($WindowHandle, 5)
  icon = [WindowTaskbar]::Read($WindowHandle, 3)
  displayName = [WindowTaskbar]::Read($WindowHandle, 4)
  relaunchCommand = [WindowTaskbar]::Read($WindowHandle, 2)
} | ConvertTo-Json -Compress
