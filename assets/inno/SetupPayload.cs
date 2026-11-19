using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Threading;

internal static class SetupPayload
{
    private const string InstallerName = "WorldlineBoxInstall.exe";
    private const string DataName = "WorldlineBoxInstall-1.bin";
    private const int DigestLength = 32;

    internal static int Run(Func<string, int> launchInstaller, Action<long, long> onProgress)
    {
        var assembly = Assembly.GetExecutingAssembly();
        long installerLength, dataLength;
        byte[] installerDigest, dataDigest;
        using (var layout = new BinaryReader(assembly.GetManifestResourceStream("SetupPayload.bin")))
        {
            installerLength = layout.ReadInt64();
            installerDigest = layout.ReadBytes(DigestLength);
            dataLength = layout.ReadInt64();
            dataDigest = layout.ReadBytes(DigestLength);
        }
        long totalLength = checked(installerLength + dataLength);
        using (var source = new FileStream(assembly.Location, FileMode.Open, FileAccess.Read, FileShare.Read,
                                           1024 * 1024, FileOptions.SequentialScan))
        {
            if (installerLength <= 0 || dataLength <= 0 || totalLength >= source.Length)
                throw new InvalidDataException();

            // The builder appends the installer and data, in that order, to the launcher.
            source.Position = source.Length - totalLength;
            string folder = CreateWorkingDirectory();
            string installer = Path.Combine(folder, InstallerName);
            string data = Path.Combine(folder, DataName);
            try
            {
                long copied = 0;
                var buffer = new byte[1024 * 1024];
                ExtractFile(source, installer, installerLength, installerDigest, buffer, ref copied, totalLength, onProgress);
                ExtractFile(source, data, dataLength, dataDigest, buffer, ref copied, totalLength, onProgress);
                using (File.OpenRead(installer))
                using (File.OpenRead(data))
                    return launchInstaller(installer);
            }
            finally
            {
                CleanWorkingDirectory(folder, installer, data);
            }
        }
    }

    private static void ExtractFile(Stream source, string filename, long length, byte[] expectedDigest,
                                    byte[] buffer, ref long copied, long total, Action<long, long> onProgress)
    {
        using (var target = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                                           buffer.Length, FileOptions.SequentialScan))
        using (var hash = SHA256.Create())
        {
            while (length > 0)
            {
                int chunk = source.Read(buffer, 0, (int)Math.Min(length, buffer.Length));
                if (chunk == 0)
                    throw new InvalidDataException();
                target.Write(buffer, 0, chunk);
                hash.TransformBlock(buffer, 0, chunk, buffer, 0);
                length -= chunk;
                copied += chunk;
                onProgress(copied, total);
            }
            hash.TransformFinalBlock(buffer, 0, 0);
            if (!hash.Hash.SequenceEqual(expectedDigest))
                throw new InvalidDataException();
        }
    }

    private static string CreateWorkingDirectory()
    {
        string folder = Path.Combine(Path.GetTempPath(), "WorldlineBoxSetup-" + Guid.NewGuid().ToString("N"));
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        using (var user = WindowsIdentity.GetCurrent())
            AllowDirectoryAccess(security, user.User);
        AllowDirectoryAccess(security, new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
        AllowDirectoryAccess(security, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
        Directory.CreateDirectory(folder, security);
        return folder;
    }

    private static void AllowDirectoryAccess(DirectorySecurity security, SecurityIdentifier sid)
    {
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
    }

    private static void CleanWorkingDirectory(string folder, string installer, string data)
    {
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                File.Delete(installer);
                File.Delete(data);
                Directory.Delete(folder);
                return;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            Thread.Sleep(200);
        }
    }
}
