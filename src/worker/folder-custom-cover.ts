import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
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

/** Stable file name. Folder ids can contain slashes, so they are not used as paths. */
export function folderCoverRelativeName(folderKey: string, extension: string): string {
  const hash = createHash("sha256").update(folderKey).digest("hex").slice(0, 32);
  return path.posix.join("folder-covers", `${hash}${extension}`);
}

export function folderCoverAbsolutePath(libraryPath: string, relativeName: string): string {
  const root = path.resolve(libraryPath, ".worldlinebox");
  const absolute = path.resolve(root, relativeName);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error("Folder cover path escaped the library.");
  }
  return absolute;
}

/** Leave at least 1 MiB free after the copy. */
export function folderCoverFitsOnDisk(libraryPath: string, sourcePath: string): boolean {
  const size = statSync(sourcePath).size;
  const space = statfsSync(libraryPath);
  return space.bavail * space.bsize >= size + 1_048_576;
}

/**
 * Copy the chosen image into the library and replace any previous cover file
 * for this folder. Returns the relative name stored in the database.
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
  const relativeName = folderCoverRelativeName(input.folderKey, extension);
  const destination = folderCoverAbsolutePath(input.libraryPath, relativeName);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  try {
    copyFileSync(input.sourcePath, temporary);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  if (
    input.previousRelativeName
    && input.previousRelativeName !== relativeName
  ) {
    removeFolderCoverFile(input.libraryPath, input.previousRelativeName);
  }
  return relativeName;
}

export function removeFolderCoverFile(libraryPath: string, relativeName: string): void {
  rmSync(folderCoverAbsolutePath(libraryPath, relativeName), { force: true });
}
