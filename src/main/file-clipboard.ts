/**
 * OS file-path clipboard for Finder / Explorer interoperability (clarification #5).
 *
 * Electron 43 has no clipboard.writeFilePaths; we write/read platform pasteboard
 * formats so copied folders/files can paste outside WorldlineBox and vice versa.
 *
 * Renderer never sees absolute paths (REQ-COMMAND-003): Main only.
 */

import path from "node:path";

import { writeWin32FileClipboard, readWin32FileClipboard, readWin32FileClipboardSnapshot } from "./win32-file-clipboard";

export type FileClipboardPlatform = "darwin" | "win32" | "other";

export type FileClipboardDeps = {
  readonly platform: FileClipboardPlatform;
  readonly writeBuffer: (format: string, buffer: Buffer) => void;
  readonly readBuffer: (format: string) => Buffer;
  readonly hasFormat: (format: string) => boolean;
  readonly clear: () => void;
  /** Optional text fallback (path list) for apps that only paste text. */
  readonly writeText: (text: string) => void;
  /**
   * Windows-only native clipboard writer (standard CF_HDROP, ID 15). Injected
   * so unit tests can stub it; defaults to the koffi implementation.
   */
  readonly writeNativeWin32?: (filePaths: readonly string[], operation?: 'copy' | 'cut') => boolean;
  readonly readNativeWin32Snapshot?: typeof readWin32FileClipboardSnapshot;
  readonly readNativeWin32?: () => string[] | null;
};

export function detectFileClipboardPlatform(
  nodePlatform: NodeJS.Platform = process.platform,
): FileClipboardPlatform {
  if (nodePlatform === "darwin") return "darwin";
  if (nodePlatform === "win32") return "win32";
  return "other";
}

export function createFileClipboardDeps(): FileClipboardDeps {
  // Lazy-require so unit tests inject deps without loading Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { clipboard } = require("electron") as {
    clipboard: {
      writeBuffer: (format: string, buffer: Buffer) => void;
      readBuffer: (format: string) => Buffer;
      has: (format: string) => boolean;
      clear: () => void;
      writeText: (text: string) => void;
    };
  };
  return {
    platform: detectFileClipboardPlatform(),
    writeBuffer: (format, buffer) => clipboard.writeBuffer(format, buffer),
    readBuffer: (format) => clipboard.readBuffer(format),
    hasFormat: (format) => clipboard.has(format),
    clear: () => clipboard.clear(),
    writeText: (text) => clipboard.writeText(text),
    writeNativeWin32: writeWin32FileClipboard,
    readNativeWin32: readWin32FileClipboard,
    readNativeWin32Snapshot: readWin32FileClipboardSnapshot,
  };
}

/** Escape a path for inclusion in a minimal XML plist string array. */
export function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Build NSFilenamesPboardType / public.utf8-plain-text-compatible plist. */
export function buildNsFilenamesPlist(filePaths: readonly string[]): Buffer {
  const items = filePaths
    .map((filePath) => `  <string>${escapePlistString(filePath)}</string>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
${items}
</array>
</plist>
`;
  return Buffer.from(xml, "utf8");
}

/** Parse a string-array plist produced by Finder or {@link buildNsFilenamesPlist}. */
export function parseNsFilenamesPlist(buffer: Buffer): string[] {
  const xml = buffer.toString("utf8");
  const matches = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)];
  return matches.map((match) =>
    match[1]!
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&"),
  );
}

/**
 * CF_HDROP DROPFILES + double-null-terminated UTF-16LE path list.
 * @see https://learn.microsoft.com/windows/win32/shell/clipboard#cf_hdrop
 */
export function buildCfHdrop(filePaths: readonly string[]): Buffer {
  // DROPFILES: pFiles(4) + pt.x(4) + pt.y(4) + fNC(4) + fWide(4) = 20
  const headerSize = 20;
  const pathPayload = `${filePaths.join("\0")}\0\0`;
  const pathBytes = Buffer.from(pathPayload, "utf16le");
  const buffer = Buffer.alloc(headerSize + pathBytes.length);
  buffer.writeUInt32LE(headerSize, 0); // pFiles
  buffer.writeInt32LE(0, 4); // pt.x
  buffer.writeInt32LE(0, 8); // pt.y
  buffer.writeUInt32LE(0, 12); // fNC
  buffer.writeUInt32LE(1, 16); // fWide = TRUE
  pathBytes.copy(buffer, headerSize);
  return buffer;
}

export function parseCfHdrop(buffer: Buffer): string[] {
  if (buffer.length < 20) return [];
  const pFiles = buffer.readUInt32LE(0);
  const fWide = buffer.readUInt32LE(16) !== 0;
  if (pFiles < 20 || pFiles >= buffer.length) return [];
  const payload = buffer.subarray(pFiles);
  const text = fWide
    ? payload.toString("utf16le")
    : payload.toString("latin1");
  return text.split("\0\0", 1)[0]?.split("\0").filter(Boolean) ?? [];
}

export function writeFilePathsToClipboard(
  filePaths: readonly string[],
  deps: FileClipboardDeps,
  operation: 'copy' | 'cut' = 'copy',
): boolean {
  const absolute = filePaths
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      // Preserve Windows drive-letter paths even when Main runs on darwin
      // (unit tests / cross-compile). path.resolve would otherwise treat
      // `C:\…` as a relative segment under the cwd.
      if (path.win32.isAbsolute(entry) || path.posix.isAbsolute(entry)) {
        return entry;
      }
      return path.resolve(entry);
    })
    .filter((entry) => entry.length > 0);
  if (absolute.length === 0) return false;

  try {
    deps.clear();
    if (deps.platform === "darwin") {
      const plist = buildNsFilenamesPlist(absolute);
      deps.writeBuffer("NSFilenamesPboardType", plist);
      // Single-file URL helps some targets; multi stays on NSFilenames.
      if (absolute.length === 1) {
        const fileUrl = pathToFileUrl(absolute[0]!);
        deps.writeBuffer(
          "public.file-url",
          Buffer.from(fileUrl, "utf8"),
        );
      }
      // Do not call writeText here: Electron replaces the pasteboard and drops
      // NSFilenamesPboardType (WorldlineBox-z67e / MENU-032).
      return true;
    }
    if (deps.platform === "win32") {
      // Prefer the native Win32 clipboard (standard CF_HDROP, ID 15) so
      // Explorer/PureRef/Get-Clipboard -Format FileDropList can read it;
      // Electron's writeBuffer('CF_HDROP') registers a custom format with the
      // same name, which external apps cannot see.
      if (deps.writeNativeWin32?.(absolute, operation)) return true;
      deps.writeBuffer("CF_HDROP", buildCfHdrop(absolute));
      // FileNameW: first path, UCS-2, double-null terminated.
      const first = `${absolute[0]!}\0\0`;
      deps.writeBuffer("FileNameW", Buffer.from(first, "ucs2"));
      const effect = Buffer.alloc(4);
      effect.writeUInt32LE(operation === 'cut' ? 2 : 1);
      deps.writeBuffer('Preferred DropEffect', effect);
      return true;
    }
    if (process.platform === "linux") {
      deps.writeBuffer("x-special/gnome-copied-files", Buffer.from(
        [operation, ...absolute.map(pathToFileUrl)].join("\n"), "utf8",
      ));
    } else {
      deps.writeText(absolute.join("\n"));
    }
    return true;
  } catch {
    return false;
  }
}

export function readFilePathsFromClipboard(deps: FileClipboardDeps): string[] {
  try {
    const isAbs = (entry: string) =>
      path.win32.isAbsolute(entry) || path.posix.isAbsolute(entry);
    if (deps.platform === "darwin") {
      if (deps.hasFormat("NSFilenamesPboardType")) {
        return parseNsFilenamesPlist(
          deps.readBuffer("NSFilenamesPboardType"),
        ).filter(isAbs);
      }
      if (deps.hasFormat("public.file-url")) {
        const raw = deps.readBuffer("public.file-url").toString("utf8").trim();
        const filePath = fileUrlToPath(raw);
        return filePath && isAbs(filePath) ? [filePath] : [];
      }
      return [];
    }
    if (deps.platform === "win32") {
      const nativePaths = deps.readNativeWin32?.();
      // [] means a real CF_HDROP was present but unavailable/invalid; avoid
      // silently reducing it to FileNameW's first path. null permits legacy
      // Electron custom formats when the real native format is absent.
      if (nativePaths) return nativePaths.filter(isAbs);
      if (deps.hasFormat("CF_HDROP")) {
        return parseCfHdrop(deps.readBuffer("CF_HDROP")).filter(isAbs);
      }
      if (deps.hasFormat("FileNameW")) {
        const raw = deps
          .readBuffer("FileNameW")
          .toString("ucs2")
          .replace(/\0+$/, "");
        return raw && isAbs(raw) ? [raw] : [];
      }
      return [];
    }
    return readLinuxFileClipboard(deps).paths;
  } catch {
    return [];
  }
}

export function readFileClipboard(deps: FileClipboardDeps): { paths: string[]; operation: 'copy' | 'cut'; sequence?: number; unavailable?: boolean } {
  if (deps.platform === 'win32') {
    if (deps.readNativeWin32Snapshot) {
      const snapshot = deps.readNativeWin32Snapshot();
      if (!snapshot) return { paths: [], operation: 'copy', unavailable: true };
      return { ...snapshot, paths: snapshot.paths.filter(entry => path.win32.isAbsolute(entry)) };
    }
    const effect = deps.readBuffer('Preferred DropEffect');
    return {
      paths: readFilePathsFromClipboard(deps),
      operation: effect.length >= 4 && (effect.readUInt32LE(0) & 2) !== 0 ? 'cut' : 'copy',
    };
  }
  if (deps.platform === 'other') return readLinuxFileClipboard(deps);
  return { paths: readFilePathsFromClipboard(deps), operation: 'copy' };
}

function readLinuxFileClipboard(deps: FileClipboardDeps): { paths: string[]; operation: 'copy' | 'cut' } {
  const format = 'x-special/gnome-copied-files';
  const hasOperation = deps.hasFormat(format);
  const lines = deps.readBuffer(hasOperation ? format : 'text/uri-list').toString('utf8').split(/\r?\n/);
  const operation = hasOperation && lines.shift() === 'cut' ? 'cut' : 'copy';
  return { paths: lines.flatMap(line => {
    const candidate = fileUrlToPath(line.trim());
    return candidate && path.posix.isAbsolute(candidate) ? [candidate] : [];
  }), operation };
}

function pathToFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replaceAll("\\", "/");
  const withLeading =
    normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withLeading).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
}

function fileUrlToPath(fileUrl: string): string | null {
  if (!fileUrl.startsWith("file://")) return null;
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "file:" || url.hostname) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}
