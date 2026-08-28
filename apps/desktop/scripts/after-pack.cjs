const { access, rm } = require('node:fs/promises');
const { join } = require('node:path');

/**
 * Remove Electron's development placeholder when using a custom unpacked
 * distribution, then reject any shell that omitted a required Host resource.
 */
module.exports = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  await rm(join(resources, 'default_app.asar'), { force: true });
  await Promise.all([
    access(join(resources, 'app.asar')),
    access(join(resources, 'runtime', 'lib', 'bin.js')),
    access(join(resources, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')),
    access(join(resources, 'tools', 'ffmpeg', 'windows-x64', 'ffmpeg.exe')),
    access(join(resources, 'tools', 'ffmpeg', 'windows-x64', 'ffprobe.exe')),
    access(join(resources, 'tools', 'ffmpeg', 'windows-x64', 'ffplay.exe')),
    access(join(resources, 'tools', 'ffmpeg', 'windows-x64', 'LICENSE')),
    access(join(resources, 'tools', 'yt-dlp', 'windows-x64', 'yt-dlp.exe')),
    access(join(resources, 'tools', 'yt-dlp', 'windows-x64', 'LICENSE')),
    access(join(resources, 'tools', 'README.md')),
    access(join(resources, 'THIRD_PARTY_NOTICES.md')),
    access(join(resources, 'LICENSE')),
    access(join(resources, 'app-icon.ico')),
    access(join(resources, 'app-logo.png')),
  ]);
};
