import { useEffect, useMemo, useRef, useState } from "react";

import { parseAssetMarkdown } from "../plugins/plugin-community-readme";
import type { WorldlineBoxLibraryApi } from "../shared/library-api";
import { isMarkdownTextName, textCardPreviewSnippet } from "../shared/text-media";
import { useT } from "./i18n";
import { PluginReadmeView } from "./PluginReadmeView";

const previewCache = new Map<string, string>();
const previewInFlight = new Map<string, Promise<string | null>>();
const previewGenerations = new Map<string, number>();

function cacheKey(libraryId: string, assetId: string, revisionId: string): string {
  return `${libraryId}:${assetId}:${revisionId}:source`;
}

export type TextAssetPreviewTileProps = {
  api: WorldlineBoxLibraryApi;
  libraryId: string;
  assetId: string;
  /** Busts cache when the text revision changes. */
  revisionId: string;
  className?: string;
  snippetClassName?: string;
  /** Relative path or display name. `.md` / `.markdown` render formatted. */
  fileName?: string;
  /** Inspector card-feel tilt host (experiment/card-feel-preview subset). */
  cardFeelTilt?: boolean;
};

/**
 * Shared 4:3 text preview tile for Inspector hero and browse cards.
 * Loads a capped UTF-8 prefix via Worker IPC and caches by revision.
 */
export function TextAssetPreviewTile({
  api,
  libraryId,
  assetId,
  revisionId,
  className = "text-asset-preview",
  snippetClassName = "text-asset-preview-snippet",
  fileName = "",
  cardFeelTilt = false,
}: TextAssetPreviewTileProps) {
  const t = useT();
  const tileRef = useRef<HTMLDivElement>(null);
  const markdown = isMarkdownTextName(fileName);
  const key = cacheKey(libraryId, assetId, revisionId);
  const [source, setSource] = useState<string | null>(
    () => previewCache.get(key) ?? null,
  );
  const markdownBlocks = useMemo(
    () => (markdown && source != null ? parseAssetMarkdown(source) : []),
    [markdown, source],
  );

  useEffect(() => {
    const cached = previewCache.get(key);
    if (cached != null) {
      queueMicrotask(() => setSource(cached));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => setSource(null));

    const load = (): void => {
      if (cancelled) return;
      const existing = previewInFlight.get(key);
      const generation = previewGenerations.get(key) ?? 0;
      if (!previewGenerations.has(key)) previewGenerations.set(key, generation);
      const request = existing ?? api
        .readTextAsset({ libraryId, assetId, maxBytes: 2048 })
        .then((result) => {
          if (!result.ok) return null;
          const next = result.value.content;
          if ((previewGenerations.get(key) ?? 0) !== generation) return null;
          previewCache.set(key, next);
          return next;
        })
        .catch(() => null);
      if (!existing) {
        previewInFlight.set(key, request);
        void request.finally(() => {
          if (previewInFlight.get(key) === request) previewInFlight.delete(key);
          if (!previewInFlight.has(key)) previewGenerations.delete(key);
        });
      }
      void request.then((next) => {
        if (!cancelled && next != null) setSource(next);
      });
    };

    const tile = tileRef.current;
    if (!tile || typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        cancelled = true;
      };
    }
    // A browse response can contain hundreds of text assets. Do not enqueue a
    // Worker read for every mounted card; only cards entering the viewport
    // need a snippet. The Inspector hero is visible immediately and follows
    // the same path. This keeps text previews from competing with thumbnails,
    // search and viewer requests in the shared Worker queue (WorldlineBox-29125f).
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { root: null, rootMargin: "240px" },
    );
    observer.observe(tile);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [api, assetId, key, libraryId]);

  return (
    <div
      className={className}
      ref={tileRef}
      {...(cardFeelTilt ? { "data-card-feel-tilt": "" } : {})}
    >
      {markdown && markdownBlocks.length > 0 ? (
        <div className="text-asset-preview-markdown">
          <PluginReadmeView
            blocks={markdownBlocks}
            empty=""
            imageLabel=""
            interactive={false}
            onOpenUrl={() => undefined}
          />
        </div>
      ) : (
        <pre className={snippetClassName}>
          {source == null ? t("preview.textLoading") : textCardPreviewSnippet(source)}
        </pre>
      )}
    </div>
  );
}

/** Drop cached snippets after an in-app text save so cards refresh. */
export function invalidateTextAssetPreviewCache(
  libraryId: string,
  assetId: string,
): void {
  const prefix = `${libraryId}:${assetId}:`;
  for (const key of previewCache.keys()) {
    if (key.startsWith(prefix)) previewCache.delete(key);
  }
  for (const key of previewInFlight.keys()) {
    if (key.startsWith(prefix)) previewInFlight.delete(key);
  }
  for (const key of previewGenerations.keys()) {
    if (key.startsWith(prefix)) {
      previewGenerations.set(key, (previewGenerations.get(key) ?? 0) + 1);
    }
  }
}
