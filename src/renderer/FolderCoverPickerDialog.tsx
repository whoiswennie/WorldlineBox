import { useEffect, useState } from "react";

import { coverSrc, sourceSrc } from "./asset-card-hover-preview";
import { folderCoverPickerAssetMatches } from "./folder-cover-picker";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import { DialogShell } from "./ui/patterns";

export interface FolderCoverPickerAsset {
  assetId: string;
  displayName: string;
  relativeFilePath: string;
  thumbnailArtifactId: string | null;
  previewRevisionId: string | null;
}

export interface FolderCoverPickerDialogProps {
  open: boolean;
  libraryId: string | null;
  selectedAssetId: string;
  pageSize: number;
  loadPage: (query: string, offset: number) => Promise<{
    items: FolderCoverPickerAsset[];
    total: number;
  }>;
  onSelect: (assetId: string) => void;
  onConfirm: (assetId: string) => void;
  onCancel: () => void;
}

function pickerThumbSrc(libraryId: string, asset: FolderCoverPickerAsset): string | null {
  if (asset.thumbnailArtifactId) return coverSrc(libraryId, asset.thumbnailArtifactId);
  if (asset.previewRevisionId) return sourceSrc(libraryId, asset.assetId, asset.previewRevisionId);
  return null;
}

/** Thumbnail grid of library images, searchable by name or path. */
export function FolderCoverPickerDialog({
  open,
  libraryId,
  selectedAssetId,
  pageSize,
  loadPage,
  onSelect,
  onConfirm,
  onCancel,
}: FolderCoverPickerDialogProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FolderCoverPickerAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setItems([]);
      setTotal(0);
      setNextOffset(0);
      setLoading(true);
      setLoadFailed(false);
    }
  }

  useEffect(() => {
    if (!open || !libraryId) return;
    let cancelled = false;
    const delay = query.trim() ? 200 : 0;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadFailed(false);
      void loadPage(query, 0)
        .then((page) => {
          if (cancelled) return;
          const visible = page.items.filter((asset) => folderCoverPickerAssetMatches(asset, query));
          setItems(visible);
          setTotal(page.total);
          setNextOffset(pageSize);
        })
        .catch(() => {
          if (cancelled) return;
          setItems([]);
          setTotal(0);
          setLoadFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, libraryId, query, loadPage, pageSize]);

  if (!open || !libraryId) return null;
  const trimmed = query.trim();
  const canSave = items.some((asset) => asset.assetId === selectedAssetId);
  const canLoadMore = !loading && !loadingMore && nextOffset < total;

  function loadMore() {
    if (!canLoadMore) return;
    setLoadingMore(true);
    void loadPage(query, nextOffset)
      .then((page) => {
        setItems((current) => {
          const seen = new Set(current.map((asset) => asset.assetId));
          const appended = page.items.filter(
            (asset) => folderCoverPickerAssetMatches(asset, query) && !seen.has(asset.assetId),
          );
          return [...current, ...appended];
        });
        setTotal(page.total);
        setNextOffset((offset) => offset + pageSize);
      })
      .catch(() => {
        setLoadFailed(true);
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <DialogShell
        className="create-dialog folder-cover-picker-dialog"
        dialogId="folder-cover-picker"
        headerActions={
          <button
            className="dialog-close"
            onClick={onCancel}
            type="button"
            {...iconActionAttrs(t("common.cancel"))}
          >
            <Icon name="close" size={16} />
          </button>
        }
        title={t("dialog.folderCover.title")}
      >
        <label className="field-label" htmlFor="folder-cover-search">
          {t("dialog.folderCover.search")}
        </label>
        <input
          className="text-field folder-cover-picker-search"
          id="folder-cover-search"
          onChange={(event) => {
            setQuery(event.target.value);
            setItems([]);
            setTotal(0);
            setNextOffset(0);
            setLoading(true);
            setLoadFailed(false);
          }}
          placeholder={t("dialog.folderCover.searchPlaceholder")}
          type="search"
          value={query}
        />
        {loadFailed ? (
          <p className="folder-cover-picker-status">{t("dialog.folderCover.loadFailed")}</p>
        ) : loading && items.length === 0 ? (
          <p className="folder-cover-picker-status">{t("dialog.folderCover.loading")}</p>
        ) : items.length === 0 ? (
          <p className="folder-cover-picker-status">
            {trimmed ? t("dialog.folderCover.noMatch") : t("dialog.folderCover.empty")}
          </p>
        ) : (
          <div className="folder-cover-picker-grid" aria-label={t("dialog.folderCover.title")}>
            {items.map((asset) => {
              const selected = asset.assetId === selectedAssetId;
              const src = pickerThumbSrc(libraryId, asset);
              return (
                <button
                  aria-pressed={selected}
                  className={`folder-cover-picker-cell${selected ? " is-selected" : ""}`}
                  key={asset.assetId}
                  onClick={() => onSelect(asset.assetId)}
                  onDoubleClick={() => onConfirm(asset.assetId)}
                  title={asset.relativeFilePath}
                  type="button"
                >
                  <span className="folder-cover-picker-thumb">
                    {src ? <img alt="" src={src} /> : <Icon name="file" size={20} />}
                  </span>
                  <span className="folder-cover-picker-name">{asset.displayName}</span>
                </button>
              );
            })}
          </div>
        )}
        {canLoadMore ? (
          <div className="dialog-actions">
            <button className="secondary-button" onClick={loadMore} type="button">
              {loadingMore ? t("dialog.folderCover.loading") : t("dialog.folderCover.loadMore")}
            </button>
          </div>
        ) : null}
        <p className="field-help">{t("dialog.folderCover.help")}</p>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onCancel} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="primary-button"
            disabled={!canSave}
            onClick={() => onConfirm(selectedAssetId)}
            type="button"
          >
            {t("dialog.folderCover.save")}
          </button>
        </div>
      </DialogShell>
    </div>
  );
}
