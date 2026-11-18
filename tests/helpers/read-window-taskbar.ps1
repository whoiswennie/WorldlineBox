param([Parameter(Mandatory=$true)][UInt64]$WindowHandle, [string]$ShortcutIcon, [string]$ReferenceIcon)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowTaskbar {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern uint PrivateExtractIconsW(string path, int index, int width, int height, out IntPtr icon, out uint id, uint count, uint flags);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  public static string IconDigest(string path, int size) {
    IntPtr handle; uint id;
    if (PrivateExtractIconsW(path, 0, size, size, out handle, out id, 1, 0) != 1 || handle == IntPtr.Zero)
      throw new InvalidOperationException("Windows could not extract the icon from " + path);
    try {
      using (var icon = System.Drawing.Icon.FromHandle(handle))
      using (var bitmap = icon.ToBitmap())
      using (var stream = new System.IO.MemoryStream())
      using (var hash = System.Security.Cryptography.SHA256.Create()) {
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return Convert.ToBase64String(hash.ComputeHash(stream.ToArray()));
      }
    } finally { DestroyIcon(handle); }
  }
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
if ($ShortcutIcon) {
  foreach ($size in 16,24,32,48) {
    if ([WindowTaskbar]::IconDigest($ShortcutIcon, $size) -ne [WindowTaskbar]::IconDigest($ReferenceIcon, $size)) {
      throw "The Windows shortcut does not render the project icon at $size pixels."
    }
  }
}
@{
  appId = [WindowTaskbar]::Read($WindowHandle, 5)
  icon = [WindowTaskbar]::Read($WindowHandle, 3)
  displayName = [WindowTaskbar]::Read($WindowHandle, 4)
  relaunchCommand = [WindowTaskbar]::Read($WindowHandle, 2)
} | ConvertTo-Json -Compress
