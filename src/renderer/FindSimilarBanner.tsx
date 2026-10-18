import type { ReactNode } from "react";

import { Icon } from "./Icons";
import { useT } from "./i18n";

export function FindSimilarBanner({
  displayName,
  coverUrl,
  onBack,
}: {
  displayName: string;
  coverUrl: string | null;
  onBack: () => void;
}): ReactNode {
  const t = useT();
  return (
    <div className="find-similar-banner" role="status">
      {coverUrl ? (
        <img alt="" className="find-similar-banner-thumb" src={coverUrl} />
      ) : (
        <span aria-hidden="true" className="find-similar-banner-thumb" />
      )}
      <span className="find-similar-banner-copy">
        <strong>{t("settings.semanticSearch.similarBanner")}</strong>
        {displayName ? <span>{displayName}</span> : null}
      </span>
      <button className="find-similar-banner-back" onClick={onBack} type="button">
        <Icon name="chevron-left" size={14} />
        {t("settings.semanticSearch.similarBack")}
      </button>
    </div>
  );
}
