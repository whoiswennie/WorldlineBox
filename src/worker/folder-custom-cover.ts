import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";

const COVER_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

const COVER_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const COVER_DIRECTORY = "folder-covers";

/** Canonical extension stored on disk, or null when the file is not an image cover. */
export function folderCoverStoredExtension(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  if (!COVER_EXTENSIONS.has(extension)) return null;
  if (extension === ".jpeg") return ".jpg";
  if (extension === ".tiff") return ".tif";
  return extension;
}

export function folderCoverMimeType(relativeName: string): string {
  return COVER_MIME[path.extname(relativeName).toLowerCase()] ?? "application/octet-stream";
}

function folderCoverFileStem(folderKey: string): string {
  return createHash("sha256").update(folderKey).digest("hex").slice(0, 32);
}

/** Stable file name. Folder ids can contain slashes, so they are not used as paths. */
export function folderCoverRelativeName(folderKey: string, extension: string): string {
  return path.posix.join(COVER_DIRECTORY, `${folderCoverFileStem(folderKey)}${extension}`);
}

function uniqueFolderCoverRelativeName(folderKey: string, extension: string): string {
  const nonce = randomBytes(4).toString("hex");
  return path.posix.join(COVER_DIRECTORY, `${folderCoverFileStem(folderKey)}-${nonce}${extension}`);
}

/**
 * Resolve a stored cover name to a file strictly inside
 * `.worldlinebox/folder-covers/`. `.`, empty, `library.db`, and any path that
 * lands outside that directory are rejected so a bad row cannot delete the
 * catalog or another library file.
 */
export function folderCoverAbsolutePath(libraryPath: string, relativeName: string): string {
  if (typeof relativeName !== "string" || relativeName.trim() === "" || relativeName === "." || relativeName === "..") {
    throw new Error("Folder cover path escaped the library.");
  }
  const coversDir = path.resolve(libraryPath, ".worldlinebox", COVER_DIRECTORY);
  const root = path.resolve(libraryPath, ".worldlinebox");
  const absolute = path.resolve(root, relativeName);
  const prefix = coversDir + path.sep;
  if (!absolute.startsWith(prefix) || path.basename(absolute).toLowerCase() === "library.db") {
    throw new Error("Folder cover path escaped the library.");
  }
  if (existsSync(coversDir)) {
    const realCovers = realpathSync(coversDir);
    const parent = path.dirname(absolute);
    if (existsSync(parent)) {
      const realParent = realpathSync(parent);
      const realPrefix = realCovers + path.sep;
      if (realParent !== realCovers && !realParent.startsWith(realPrefix)) {
        throw new Error("Folder cover path escaped the library.");
      }
    }
  }
  return absolute;
}

/** Leave at least 1 MiB free after the copy. */
export function folderCoverFitsOnDisk(libraryPath: string, sourcePath: string): boolean {
  const size = statSync(sourcePath).size;
  const space = statfsSync(libraryPath);
  return space.bavail * space.bsize >= size + 1_048_576;
}

function resolvedCoverPath(libraryPath: string, relativeName: string): string | null {
  try {
    return folderCoverAbsolutePath(libraryPath, relativeName);
  } catch {
    return null;
  }
}

/**
 * Copy the chosen image into `.worldlinebox/folder-covers/` without removing or
 * overwriting the previous cover. The caller commits the database row, then
 * deletes the previous file.
 */
export function installFolderCoverFile(input: {
  libraryPath: string;
  folderKey: string;
  sourcePath: string;
  previousRelativeName?: string | null;
}): string {
  const extension = folderCoverStoredExtension(input.sourcePath);
  if (!extension) {
    throw new Error("FOLDER_COVER_UNSUPPORTED");
  }
  if (!folderCoverFitsOnDisk(input.libraryPath, input.sourcePath)) {
    throw new Error("FOLDER_COVER_NO_SPACE");
  }
  const stable = folderCoverRelativeName(input.folderKey, extension);
  const previousAbsolute = input.previousRelativeName
    ? resolvedCoverPath(input.libraryPath, input.previousRelativeName)
    : null;
  const stableAbsolute = folderCoverAbsolutePath(input.libraryPath, stable);
  const relativeName = previousAbsolute && previousAbsolute === stableAbsolute
    ? uniqueFolderCoverRelativeName(input.folderKey, extension)
    : stable;
  const destination = folderCoverAbsolutePath(input.libraryPath, relativeName);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    copyFileSync(input.sourcePath, temporary);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return relativeName;
}

/**
 * Commit the new cover rows, then delete the previous files.
 * A failed commit removes only the staged files and leaves the previous cover.
 */
export function commitReplacingFolderCoverFiles(input: {
  libraryPath: string;
  stagedRelativeNames: readonly string[];
  previousRelativeNames: readonly string[];
  commit: () => void;
}): void {
  try {
    input.commit();
  } catch (error) {
    for (const relativeName of input.stagedRelativeNames) {
      if (!relativeName) continue;
      try {
        removeFolderCoverFile(input.libraryPath, relativeName);
      } catch {
        // Keep the original commit failure.
      }
    }
    throw error;
  }
  const staged = new Set(input.stagedRelativeNames);
  for (const relativeName of input.previousRelativeNames) {
    if (!relativeName || staged.has(relativeName)) continue;
    try {
      removeFolderCoverFile(input.libraryPath, relativeName);
    } catch {
      // The row already points at the new file. A later sweep can remove this one.
    }
  }
}

export function removeFolderCoverFile(libraryPath: string, relativeName: string): void {
  const absolute = resolvedCoverPath(libraryPath, relativeName);
  if (!absolute) return;
  rmSync(absolute, { force: true });
}

/**
 * Cover files that are no longer named by a row. Recent files are left alone
 * so a replace that has written the new bytes but not committed yet is not
 * collected.
 */
export function listStaleFolderCoverFiles(
  libraryPath: string,
  referencedRelativeNames: ReadonlySet<string>,
  minAgeMs = 60_000,
): string[] {
  const coversDir = path.resolve(libraryPath, ".worldlinebox", COVER_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(coversDir);
  } catch {
    return [];
  }
  const now = Date.now();
  const stale: string[] = [];
  for (const name of names) {
    const relativeName = path.posix.join(COVER_DIRECTORY, name);
    if (referencedRelativeNames.has(relativeName)) continue;
    const absolute = resolvedCoverPath(libraryPath, relativeName);
    if (!absolute) continue;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < minAgeMs) continue;
    } catch {
      continue;
    }
    stale.push(relativeName);
  }
  return stale;
}
