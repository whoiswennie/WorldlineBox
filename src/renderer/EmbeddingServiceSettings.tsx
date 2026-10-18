import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  normalizeEmbeddingServiceUrl,
  parseEmbeddingDimensions,
  validateEmbeddingServiceDraft,
  type EmbeddingHttpAdapter,
  type EmbeddingProbeFailure,
  type EmbeddingServiceDestination,
  type EmbeddingServiceIssue,
} from "../shared/embedding/http-service";
import {
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
  normalizeSemanticImageBytes,
  normalizeSemanticImageEdgePx,
} from "../shared/embedding/image-limits";
import { EMBEDDING_MODALITIES, type EmbeddingModality } from "../shared/embedding/modalities";
import type { EmbeddingHttpServiceSummary } from "../shared/library-api";
import { EmbeddingApiFormatControl } from "./EmbeddingApiFormatControl";
import { notifyEmbeddingCatalogChanged } from "./embedding-catalog-events";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";

export type EmbeddingServiceSettingsApi = {
  embeddingListServices: () => Promise<{ ok: boolean; value?: EmbeddingHttpServiceSummary[] }>;
  embeddingSaveService: (input: {
    id?: string;
    name: string;
    description?: string;
    adapter?: EmbeddingHttpAdapter;
    destination: EmbeddingServiceDestination;
    baseUrl: string;
    modelName: string;
    apiKey?: string;
    modalities?: EmbeddingModality[];
    dimensions?: number | null;
    maxImageEdgePx?: number;
    maxImageBytes?: number;
  }) => Promise<{ ok: boolean; value?: { id: string } }>;
  embeddingDeleteService: (input: { id: string }) => Promise<{ ok: boolean }>;
  embeddingProbeService: (input: { id: string }) => Promise<{
    ok: boolean;
    value?: {
      textStatus: "verified" | "failed";
      dimensions: number | null;
      probeFailure: EmbeddingProbeFailure | null;
    };
  }>;
};

const MODALITY_KEYS = {
  image: "settings.semanticSearch.modalityImage",
  video: "settings.semanticSearch.modalityVideo",
  audio: "settings.semanticSearch.modalityAudio",
  text: "settings.semanticSearch.modalityText",
} as const;

const PLACEHOLDER_URL: Record<EmbeddingHttpAdapter, string> = {
  "openai-embeddings-v1": "http://127.0.0.1:11434/v1",
  "llamacpp-multimodal-v1": "http://127.0.0.1:8080/v1",
  "dashscope-multimodal-v1": "https://dashscope.aliyuncs.com/api/v1",
};

const PLACEHOLDER_MODEL: Record<EmbeddingHttpAdapter, string> = {
  "openai-embeddings-v1": "text-embedding-3-small",
  "llamacpp-multimodal-v1": "embeddinggemma-2",
  "dashscope-multimodal-v1": "qwen3-vl-embedding",
};

function parseImageMegabytes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return normalizeSemanticImageBytes(Number(trimmed) * 1024 * 1024);
}

const PROBE_FAILURE_KEYS = {
  network: "settings.semanticSearch.probeFailure.network",
  auth: "settings.semanticSearch.probeFailure.auth",
  format: "settings.semanticSearch.probeFailure.format",
  dimensions: "settings.semanticSearch.probeFailure.dimensions",
  https: "settings.semanticSearch.probeFailure.https",
} as const;

export function EmbeddingServiceSettings({
  api,
}: {
  api: EmbeddingServiceSettingsApi;
  /** @deprecated Grant UX removed; kept optional for call-site compatibility. */
  libraryId?: string;
}): ReactNode {
  const t = useT();
  const [services, setServices] = useState<EmbeddingHttpServiceSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modalities, setModalities] = useState<EmbeddingModality[]>(["text"]);
  const [adapter, setAdapter] = useState<EmbeddingHttpAdapter>("openai-embeddings-v1");
  const [dimensions, setDimensions] = useState("");
  const [maxImageEdge, setMaxImageEdge] = useState(String(CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX));
  const [maxImageMegabytes, setMaxImageMegabytes] = useState(String(CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES / (1024 * 1024)));
  const [issue, setIssue] = useState<EmbeddingServiceIssue | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remoteDestination = useMemo(() => {
    const place = normalizeEmbeddingServiceUrl(baseUrl)?.place;
    return place === "lan" || place === "internet";
  }, [baseUrl]);

  async function refresh(): Promise<void> {
    const listed = await api.embeddingListServices();
    setServices(listed.ok && listed.value ? listed.value : []);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const listed = await api.embeddingListServices();
      if (!cancelled) setServices(listed.ok && listed.value ? listed.value : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  function resetForm(): void {
    setEditingId(null);
    setName("");
    setDescription("");
    setBaseUrl("");
    setModelName("");
    setApiKey("");
    setAdapter("openai-embeddings-v1");
    setModalities(["text"]);
    setDimensions("");
    setMaxImageEdge(String(CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX));
    setMaxImageMegabytes(String(CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES / (1024 * 1024)));
    setIssue(null);
    setFormError(null);
  }

  function beginEdit(service: EmbeddingHttpServiceSummary): void {
    setEditingId(service.id);
    setName(service.name);
    setDescription(service.description ?? "");
    setBaseUrl(service.baseUrl);
    setModelName(service.modelName);
    setApiKey("");
    setAdapter(service.adapter);
    setModalities(service.modalities.length > 0 ? [...service.modalities] : ["text"]);
    setDimensions(service.dimensions == null ? "" : String(service.dimensions));
    setMaxImageEdge(String(service.maxImageEdgePx));
    setMaxImageMegabytes(String(Math.round(service.maxImageBytes / (1024 * 1024))));
    setIssue(null);
    setFormError(null);
    setOpen(true);
  }

  function toggleModality(modality: EmbeddingModality): void {
    setModalities((current) => (
      current.includes(modality)
        ? current.filter((item) => item !== modality)
        : EMBEDDING_MODALITIES.filter((item) => item === modality || current.includes(item))
    ));
  }

  async function save(): Promise<void> {
    const parsedDimensions = dimensions.trim() === "" ? null : parseEmbeddingDimensions(Number(dimensions.trim()));
    const parsedEdge = normalizeSemanticImageEdgePx(Number(maxImageEdge.trim()));
    const parsedBytes = parseImageMegabytes(maxImageMegabytes);
    const normalized = normalizeEmbeddingServiceUrl(baseUrl);
    const destination: EmbeddingServiceDestination = normalized?.place ?? "loopback";
    const nextIssue = validateEmbeddingServiceDraft({
      name,
      modelName,
      baseUrl,
      modalities,
      dimensions: dimensions.trim() === "" ? null : parsedDimensions,
      maxImageEdgePx: parsedEdge ?? Number.NaN,
      maxImageBytes: parsedBytes ?? Number.NaN,
    });
    const dimensionsIssue = dimensions.trim() !== "" && parsedDimensions === null;
    const resolvedIssue: EmbeddingServiceIssue | null = nextIssue ?? (dimensionsIssue ? "dimensions" : null);
    setIssue(resolvedIssue);
    if (resolvedIssue) {
      setFormError(t(`settings.semanticSearch.serviceIssue.${resolvedIssue}`));
      return;
    }
    setFormError(null);
    setBusy(true);
    const saved = await api.embeddingSaveService({
      ...(editingId ? { id: editingId } : {}),
      name,
      description,
      adapter,
      destination,
      baseUrl,
      modelName,
      modalities,
      dimensions: parsedDimensions,
      maxImageEdgePx: parsedEdge ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
      maxImageBytes: parsedBytes ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setBusy(false);
    if (!saved.ok || !saved.value) {
      const fallbackIssue = validateEmbeddingServiceDraft({
        name,
        modelName,
        baseUrl,
        modalities,
        dimensions: parsedDimensions,
      });
      setIssue(fallbackIssue);
      setFormError(
        fallbackIssue
          ? t(`settings.semanticSearch.serviceIssue.${fallbackIssue}`)
          : t("settings.semanticSearch.serviceSaveFailed"),
      );
      return;
    }
    resetForm();
    setOpen(false);
    await refresh();
    notifyEmbeddingCatalogChanged();
  }

  const urlPlaceholder = PLACEHOLDER_URL[adapter];
  const modelPlaceholder = PLACEHOLDER_MODEL[adapter];
  const addLabel = t("settings.semanticSearch.addService");

  return (
    <div className="semantic-custom-panel">
      <div className="app-settings-action-row semantic-settings-toolbar semantic-custom-header">
        <div className="app-settings-row-copy">
          <strong>{t("settings.semanticSearch.servicesTitle")}</strong>
          <span>{t("settings.semanticSearch.servicesHint")}</span>
        </div>
        <button
          className="semantic-install-icon-button"
          onClick={() => {
            if (open && !editingId) {
              setOpen(false);
              setFormError(null);
              return;
            }
            resetForm();
            setOpen(true);
          }}
          type="button"
          {...iconActionAttrs(addLabel)}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
      {services.length > 0 ? (
        <div className="semantic-model-list" role="list">
          {services.map((service) => (
            <ServiceStatus
              api={api}
              key={service.id}
              onChanged={async () => {
                await refresh();
                notifyEmbeddingCatalogChanged();
              }}
              onDelete={() => {
                void api.embeddingDeleteService({ id: service.id }).then(async () => {
                  await refresh();
                  notifyEmbeddingCatalogChanged();
                });
              }}
              onEdit={() => beginEdit(service)}
              service={service}
            />
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="semantic-service-form">
          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-name">{t("settings.semanticSearch.serviceName")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("settings.semanticSearch.serviceNamePlaceholder")}
              value={name}
            />
          </div>

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-description">{t("settings.semanticSearch.serviceDescription")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-description"
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("settings.semanticSearch.serviceDescriptionPlaceholder")}
              value={description}
            />
          </div>

          <EmbeddingApiFormatControl adapter={adapter} onChange={setAdapter} />

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-url">{t("settings.semanticSearch.serviceAddress")}</label>
            <input
              aria-invalid={issue === "url" || issue === "https" || issue === "loopback" || issue === "lan" ? true : undefined}
              className="text-field ai-config-input"
              id="embedding-service-url"
              maxLength={300}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={urlPlaceholder}
              spellCheck={false}
              value={baseUrl}
            />
            <p className="ai-config-hint">{t("settings.semanticSearch.serviceAddressHint")}</p>
            {remoteDestination ? (
              <p className="ai-config-hint">{t("settings.semanticSearch.serviceRemoteSendHint")}</p>
            ) : null}
          </div>

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-model">{t("settings.semanticSearch.serviceModel")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-model"
              maxLength={120}
              onChange={(event) => setModelName(event.target.value)}
              placeholder={modelPlaceholder}
              spellCheck={false}
              value={modelName}
            />
          </div>

          <div className="editor-field ai-config-field">
            <span className="micro-label ai-config-switches-title">{t("settings.semanticSearch.modalitiesTitle")}</span>
            <div
              className="ai-config-switches-row semantic-modality-row"
              role="group"
              aria-label={t("settings.semanticSearch.modalitiesTitle")}
            >
              {EMBEDDING_MODALITIES.map((modality) => (
                <label className="ai-config-check-row" key={modality}>
                  <input
                    checked={modalities.includes(modality)}
                    onChange={() => toggleModality(modality)}
                    type="checkbox"
                  />
                  {t(MODALITY_KEYS[modality])}
                </label>
              ))}
            </div>
          </div>

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-dimensions">{t("settings.semanticSearch.dimensions")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-dimensions"
              inputMode="numeric"
              onChange={(event) => setDimensions(event.target.value)}
              placeholder={t("settings.semanticSearch.dimensionsPlaceholder")}
              spellCheck={false}
              value={dimensions}
            />
            <p className="ai-config-hint">{t("settings.semanticSearch.dimensionsHint")}</p>
          </div>

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-image-edge">{t("settings.semanticSearch.imageEdge")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-image-edge"
              inputMode="numeric"
              onChange={(event) => setMaxImageEdge(event.target.value)}
              placeholder={String(CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX)}
              spellCheck={false}
              value={maxImageEdge}
            />
            <p className="ai-config-hint">{t("settings.semanticSearch.imageEdgeHint")}</p>
          </div>

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-image-bytes">{t("settings.semanticSearch.imageBytes")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-image-bytes"
              inputMode="numeric"
              onChange={(event) => setMaxImageMegabytes(event.target.value)}
              placeholder={String(CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES / (1024 * 1024))}
              spellCheck={false}
              value={maxImageMegabytes}
            />
            <p className="ai-config-hint">{t("settings.semanticSearch.imageBytesHint")}</p>
          </div>

          <div className="editor-field ai-config-field">
            <label className="micro-label" htmlFor="embedding-service-key">{t("settings.semanticSearch.serviceKey")}</label>
            <input
              className="text-field ai-config-input"
              id="embedding-service-key"
              maxLength={2048}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={editingId ? t("settings.semanticSearch.serviceKeyConfigured") : "sk-…"}
              spellCheck={false}
              type="password"
              value={apiKey}
            />
            <p className="ai-config-hint">{t("settings.semanticSearch.serviceFormHint")}</p>
          </div>

          {formError ? (
            <p className="settings-error-message" role="alert">{formError}</p>
          ) : null}

          <div className="semantic-service-form-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                resetForm();
                setOpen(false);
              }}
              type="button"
            >
              {t("common.cancel")}
            </button>
            <button className="primary-button" disabled={busy} onClick={() => { void save(); }} type="button">
              {t("settings.semanticSearch.serviceSave")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ServiceStatus({
  api,
  service,
  onChanged,
  onDelete,
  onEdit,
}: {
  api: EmbeddingServiceSettingsApi;
  service: EmbeddingHttpServiceSummary;
  onChanged: () => Promise<unknown>;
  onDelete: () => void;
  onEdit: () => void;
}): ReactNode {
  const t = useT();
  const [probing, setProbing] = useState(false);
  const [liveFailure, setLiveFailure] = useState<EmbeddingProbeFailure | null>(null);

  const failed = service.textStatus === "failed";
  const verified = service.textStatus === "verified";
  const failure = probing ? null : (liveFailure ?? service.probeFailure);
  const statusTone = probing
    ? "checking"
    : verified
      ? "connected"
      : failed
        ? "failed"
        : "idle";
  const statusLabel = probing
    ? t("settings.semanticSearch.serviceTesting")
    : verified
      ? t("settings.semanticSearch.serviceVerified")
      : failed
        ? t("settings.semanticSearch.serviceFailed")
        : t("settings.semanticSearch.serviceUnverified");
  const reason = failure ? t(PROBE_FAILURE_KEYS[failure]) : null;
  const editLabel = t("settings.semanticSearch.serviceEdit");
  const testLabel = probing ? t("settings.semanticSearch.serviceTesting") : t("settings.semanticSearch.serviceTest");
  const deleteLabel = t("settings.semanticSearch.serviceDelete");

  async function runProbe(): Promise<void> {
    setProbing(true);
    setLiveFailure(null);
    try {
      const result = await api.embeddingProbeService({ id: service.id });
      if (result.ok && result.value?.textStatus === "failed") {
        setLiveFailure(result.value.probeFailure);
      } else {
        setLiveFailure(null);
      }
      await onChanged();
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="semantic-model-card" role="listitem">
      <div className="semantic-model-card-copy">
        <div className="semantic-model-card-title-row">
          <strong>{service.name}</strong>
          <span className="sync-status-indicator" data-state={statusTone} role="status">
            <span className="sync-status-dot" data-state={statusTone} />
            <span className="semantic-service-status-label">
              {statusLabel}
              {verified && service.dimensions ? ` · ${service.dimensions}` : ""}
            </span>
            {reason ? (
              <span className="semantic-service-status-reason" title={reason}>
                {reason}
              </span>
            ) : null}
          </span>
        </div>
        {service.description ? <span>{service.description}</span> : null}
        <span>{service.modelName}</span>
        <span className="semantic-service-url">{service.baseUrl}</span>
      </div>
      <div className="semantic-model-card-action">
        <button
          className="semantic-install-icon-button is-secondary"
          onClick={onEdit}
          type="button"
          {...iconActionAttrs(editLabel)}
        >
          <Icon name="edit" size={15} />
        </button>
        <button
          className="semantic-install-icon-button is-secondary"
          disabled={probing}
          onClick={() => { void runProbe(); }}
          type="button"
          {...iconActionAttrs(testLabel)}
        >
          <Icon name={probing ? "loader" : "activity"} size={15} />
        </button>
        <button
          className="semantic-install-icon-button is-danger"
          disabled={probing}
          onClick={onDelete}
          type="button"
          {...iconActionAttrs(deleteLabel)}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}
