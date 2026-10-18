import { open, stat } from "node:fs/promises";

import {
  EMBEDDING_TEXT_MAX_CHARS,
  clipEmbeddingDocument,
  formatEmbeddingDocument,
} from "../shared/embedding/profile";

const EMBEDDING_TEXT_READ_BYTES = 256 * 1024;

/** Read a leading slice of a text asset and wrap it as an EmbeddingGemma document. */
export async function readEmbeddingDocument(filePath: string, title: string): Promise<string> {
  const info = await stat(filePath);
  if (info.size <= 0) throw new Error("Text file is empty.");
  const handle = await open(filePath, "r");
  try {
    const length = Math.min(info.size, EMBEDDING_TEXT_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const content = clipEmbeddingDocument(buffer.toString("utf8"), EMBEDDING_TEXT_MAX_CHARS);
    if (!content) throw new Error("Text file has no readable text.");
    return formatEmbeddingDocument(title, content);
  } finally {
    await handle.close();
  }
}
