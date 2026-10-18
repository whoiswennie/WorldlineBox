import { EMBEDDING_HTTP_ADAPTERS, type EmbeddingHttpAdapter } from "../shared/embedding/http-service";
import { useT } from "./i18n";

const COPY = {
  "openai-embeddings-v1": ["settings.semanticSearch.adapterOpenAi", "settings.semanticSearch.adapterOpenAiHint"],
  "llamacpp-multimodal-v1": ["settings.semanticSearch.adapterLlamaCpp", "settings.semanticSearch.adapterLlamaCppHint"],
  "dashscope-multimodal-v1": ["settings.semanticSearch.adapterDashScope", "settings.semanticSearch.adapterDashScopeHint"],
} as const;

export function EmbeddingApiFormatControl({ adapter, onChange }: {
  adapter: EmbeddingHttpAdapter;
  onChange: (adapter: EmbeddingHttpAdapter) => void;
}) {
  const t = useT();
  return (
    <div className="editor-field ai-config-field">
      <span className="micro-label">{t("settings.semanticSearch.adapterTitle")}</span>
      <div className="app-settings-option-group embedding-api-options" role="radiogroup" aria-label={t("settings.semanticSearch.adapterTitle")}>
        {EMBEDDING_HTTP_ADAPTERS.map((item) => (
          <button
            aria-checked={adapter === item}
            aria-describedby={`embedding-api-hint-${item}`}
            aria-label={t(COPY[item][0])}
            className="app-settings-option embedding-api-option"
            key={item}
            onClick={() => onChange(item)}
            role="radio"
            type="button"
          >
            <span>{t(COPY[item][0])}</span>
            <span className="ai-config-hint" id={`embedding-api-hint-${item}`}>{t(COPY[item][1])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
