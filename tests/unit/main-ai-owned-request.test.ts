import { expect, test, vi } from "vitest";

import { DEFAULT_AI_ANALYSIS_SETTINGS } from "../../src/shared/ai-analysis-settings";
import { DEFAULT_AI_RELIABILITY_SETTINGS } from "../../src/shared/ai-reliability";
import {
  AiProfileStorageError,
  AiProfileValidationError,
} from "../../src/main/ai-profile-store";
import {
  tryHandleAiOwnedRequest,
  type AiOwnedConfig,
  type AiOwnedRequestRuntime,
} from "../../src/main/library-request/ai";

function config(overrides?: Partial<AiOwnedConfig>): AiOwnedConfig {
  return {
    hasKey: true,
    activeProfileId: "ai_000000000000000000000000",
    profiles: [{
      id: "ai_000000000000000000000000",
      name: "Test profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
      hasCredential: true,
    }],
    apiFormat: "openai_chat",
    model: "gpt-4o",
    baseUrl: "",
    descriptionEnabled: true,
    tagEnabled: true,
    ratingEnabled: true,
    analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
    concurrencyLimit: 2,
    maxAnalysisImageEdgePx: 2048,
    reliabilitySettings: DEFAULT_AI_RELIABILITY_SETTINGS,
    languages: ["zh-CN", "en"],
    autoAnalyzeEnabled: false,
    disclaimerAccepted: true,
    ...overrides,
  };
}

function runtime(overrides?: Partial<AiOwnedRequestRuntime>): AiOwnedRequestRuntime {
  return {
    loadAiConfig: () => config(),
    getDecryptedApiKey: () => "sk-test",
    getDecryptedProfileApiKey: () => "sk-test",
    saveAiConfig: vi.fn(),
    saveConnectionProfile: vi.fn(() => "ai_000000000000000000000000"),
    activateConnectionProfile: vi.fn(),
    deleteConnectionProfile: vi.fn(),
    workerAvailable: () => true,
    requestWorker: vi.fn(async () => ({
      ok: false as const,
      error: { code: "INTERNAL_ERROR" as const, message: "unused" },
    })),
    processAiQueue: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

test("unrelated renderer requests fall through", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "folder.list.request", libraryId: "lib-1" },
    runtime(),
  )).resolves.toBeUndefined();
});

test("assets.analyze returns not-configured when the key is missing", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "assets.analyze.request",
      libraryId: "lib-1",
      assetIds: ["asset-1"],
    },
    runtime({
      loadAiConfig: () => config({ hasKey: false }),
    }),
  )).resolves.toMatchObject({
    ok: false,
    error: { code: "AI_ANALYSIS_FAILED", reason: "AI_NOT_CONFIGURED" },
  });
});

test("asset.analyze falls through when enqueue does not create a job", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "asset.analyze.request",
      libraryId: "lib-1",
      assetId: "asset-1",
    },
    runtime({
      requestWorker: vi.fn(async () => ({
        ok: true as const,
        type: "ai.jobs.enqueued" as const,
        libraryId: "lib-1",
        jobIds: [],
        alreadyPendingJobIds: [],
        skippedAssetIds: ["asset-1"],
        enqueued: 0,
      })),
    }),
  )).resolves.toBeUndefined();
});

test.each(["ignored", "missing-id", "unsupported"])("an empty %s batch gives a neutral eligibility reason without inventing a provider or format failure", async assetId => {
  const processAiQueue = vi.fn();
  await expect(tryHandleAiOwnedRequest({ type: "assets.analyze.request", libraryId: "lib-1", assetIds: [assetId] }, runtime({
    requestWorker: vi.fn(async () => ({ ok: true as const, type: "ai.jobs.enqueued" as const, libraryId: "lib-1", enqueued: 0, jobIds: [], alreadyPendingJobIds: [], skippedAssetIds: [assetId] })), processAiQueue,
  }))).resolves.toMatchObject({ ok: false, error: { code: "AI_ANALYSIS_FAILED", reason: "AI_NO_ELIGIBLE_ASSETS" } });
  expect(processAiQueue).not.toHaveBeenCalled();
});

test("a missing global model is rejected before starting an asset job", async () => {
  const requestWorker = vi.fn();
  await expect(tryHandleAiOwnedRequest({ type: "assets.analyze.request", libraryId: "lib-1", assetIds: ["text"] }, runtime({ loadAiConfig: () => config({ model: " " }), requestWorker })))
    .resolves.toMatchObject({ ok: false, error: { reason: "AI_NOT_CONFIGURED" } });
  expect(requestWorker).not.toHaveBeenCalled();
});

test("ai.config.get maps the stored config onto the renderer payload", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtime(),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.config.got",
    apiFormat: "openai_chat",
    model: "gpt-4o",
    hasKey: true,
    activeProfileId: "ai_000000000000000000000000",
    profiles: [{ id: "ai_000000000000000000000000", hasCredential: true }],
  });
});

test("ai.config.get reports a profile storage failure instead of returning default settings", async () => {
  const logError = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtime({
      loadAiConfig: () => { throw new AiProfileStorageError(new Error("catalog is unreadable")); },
      logError,
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
  expect(logError).toHaveBeenCalledWith(
    "ai.profile-storage.read",
    expect.any(AiProfileStorageError),
    { operation: "ai.config.get.request" },
  );
});

test("analysis preference writes stop when the stored AI settings cannot be read", async () => {
  const saveAiConfig = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      enabledFields: { description: true, tags: true, rating: true },
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({
      loadAiConfig: () => { throw new Error("profile journal is corrupt"); },
      saveAiConfig,
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
  expect(saveAiConfig).not.toHaveBeenCalled();
});

test("analysis preferences save independently from connection profiles", async () => {
  const saveAiConfig = vi.fn();
  const saveConnectionProfile = vi.fn();
  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.config.set.request",
      enabledFields: { description: true, tags: false, rating: true },
      analysisSettings: {
        forceExistingTags: true,
        maxTags: 5,
        maxDescriptionCharsZh: 80,
        maxDescriptionWordsEn: 40,
        outputStyle: "concise",
        ratingRubric: "Use a five point scale.",
        customDescriptionPrompt: "",
        customTagPrompt: "",
      },
      autoAnalyzeEnabled: false,
      disclaimerAccepted: true,
    },
    runtime({ saveAiConfig, saveConnectionProfile }),
  )).resolves.toMatchObject({ ok: true, type: "ai.config.saved" });
  expect(saveConnectionProfile).not.toHaveBeenCalled();
  expect(saveAiConfig).toHaveBeenCalledWith(expect.objectContaining({
    apiFormat: "openai_chat",
    model: "gpt-4o",
    analysisSettings: expect.objectContaining({ forceExistingTags: true }),
  }));
});

test("AI search planning uses the active profile's model, endpoint, and credential", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            keywords: ["active-profile-keyword"],
            synonyms: [],
            exclusions: [],
            filters: [],
            sort: null,
          }),
        },
      }],
    }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  try {
    const activeConfig = config({
      activeProfileId: "ai_000000000000000000000006",
      profiles: [{
        id: "ai_000000000000000000000006",
        name: "Active profile",
        apiFormat: "openai_chat",
        model: "active-search-model",
        baseUrl: "https://active.example.invalid/v1",
        hasCredential: true,
      }],
      apiFormat: "openai_chat",
      model: "active-search-model",
      baseUrl: "https://active.example.invalid/v1",
      hasKey: true,
      disclaimerAccepted: true,
    });
    const getDecryptedApiKey = vi.fn(() => "active-profile-secret");
    const result = await tryHandleAiOwnedRequest(
      { type: "ai.search-plan.request", naturalQuery: "find active profile" },
      runtime({
        loadAiConfig: () => activeConfig,
        getDecryptedApiKey,
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://active.example.invalid/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer active-profile-secret" }),
      }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ model: "active-search-model" });
    expect(getDecryptedApiKey).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      type: "ai.search-plan.result",
      apiFormat: "openai_chat",
      model: "active-search-model",
      plan: { keywords: ["active-profile-keyword"] },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("profile save response exposes only its id", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "ai.profiles.save.request",
      name: "Private profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
      apiKey: "secret-token",
    },
    runtime({ saveConnectionProfile: vi.fn(() => "ai_000000000000000000000005") }),
  )).resolves.toEqual({
    ok: true,
    type: "ai.profiles.saved",
    id: "ai_000000000000000000000005",
  });
});

test("profile validation failures remain actionable settings errors", async () => {
  const logError = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.profiles.save.request",
      name: "Invalid profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
    },
    runtime({
      saveConnectionProfile: () => { throw new AiProfileValidationError("invalid profile"); },
      logError,
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_SETTINGS_INCOMPLETE" },
  });
  expect(logError).not.toHaveBeenCalled();
});

test.each([
  {
    scope: "ai.profile.save",
    request: {
      type: "ai.profiles.save.request" as const,
      name: "Private profile",
      apiFormat: "openai_chat" as const,
      model: "gpt-4o",
      baseUrl: "",
    },
    override: { saveConnectionProfile: () => { throw new Error("disk write failed"); } },
  },
  {
    scope: "ai.profile.activate",
    request: { type: "ai.profiles.activate.request" as const, id: "ai_000000000000000000000006" },
    override: { activateConnectionProfile: () => { throw new Error("safeStorage failed"); } },
  },
  {
    scope: "ai.profile.delete",
    request: { type: "ai.profiles.delete.request" as const, id: "ai_000000000000000000000006" },
    override: { deleteConnectionProfile: () => { throw new Error("credential delete failed"); } },
  },
])("profile storage failures are logged and returned as retryable errors: $scope", async ({ scope, request, override }) => {
  const logError = vi.fn();
  const result = await tryHandleAiOwnedRequest(
    request,
    runtime({ ...override, logError }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
  expect(logError).toHaveBeenCalledWith(scope, expect.any(Error), expect.any(Object));
});

test("profile activation and deletion are owned by Main", async () => {
  const activateConnectionProfile = vi.fn();
  const deleteConnectionProfile = vi.fn();
  const activateResult = await tryHandleAiOwnedRequest(
    { type: "ai.profiles.activate.request", id: "ai_000000000000000000000006" },
    runtime({ activateConnectionProfile }),
  );
  const deleteResult = await tryHandleAiOwnedRequest(
    { type: "ai.profiles.delete.request", id: "ai_000000000000000000000006" },
    runtime({ deleteConnectionProfile }),
  );

  expect(activateConnectionProfile).toHaveBeenCalledWith("ai_000000000000000000000006");
  expect(deleteConnectionProfile).toHaveBeenCalledWith("ai_000000000000000000000006");
  expect(activateResult).toMatchObject({ ok: true, type: "ai.profiles.activated" });
  expect(deleteResult).toMatchObject({ ok: true, type: "ai.profiles.deleted" });
});

test("profile save can explicitly clear its saved credential", async () => {
  const saveConnectionProfile = vi.fn(() => "ai_000000000000000000000006");
  await tryHandleAiOwnedRequest(
    {
      type: "ai.profiles.save.request",
      id: "ai_000000000000000000000006",
      name: "Private profile",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      baseUrl: "",
      clearCredential: true,
    },
    runtime({ saveConnectionProfile }),
  );

  expect(saveConnectionProfile).toHaveBeenCalledWith(expect.objectContaining({ clearCredential: true }));
});

test("stored connection probes keep their profile snapshot after the active profile changes", async () => {
  const getDecryptedProfileApiKey = vi.fn(() => "profile-secret");
  const getDecryptedApiKey = vi.fn(() => "new-active-profile-secret");
  const requestWorker = vi.fn(async () => ({
    ok: true as const,
    type: "ai.test-connection.result" as const,
    success: true,
  }));
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "wrong-renderer-model",
      baseUrl: "https://wrong.example.invalid",
      profileId: "ai_000000000000000000000006",
    },
    runtime({
      loadAiConfig: () => config({
        // Simulate a switch to profile 007 after the renderer captured profile 006.
        activeProfileId: "ai_000000000000000000000007",
        profiles: [{
          id: "ai_000000000000000000000006",
          name: "Target profile",
          apiFormat: "anthropic",
          model: "claude-test",
          baseUrl: "https://target.example.invalid",
          hasCredential: true,
        }, {
          id: "ai_000000000000000000000007",
          name: "New active profile",
          apiFormat: "anthropic",
          model: "claude-current",
          baseUrl: "https://current.example.invalid",
          hasCredential: true,
        }],
      }),
      getDecryptedProfileApiKey,
      getDecryptedApiKey,
      requestWorker,
    }),
  );

  expect(getDecryptedProfileApiKey).toHaveBeenCalledWith("ai_000000000000000000000006");
  expect(getDecryptedApiKey).not.toHaveBeenCalled();
  expect(requestWorker).toHaveBeenCalledWith(expect.objectContaining({
    apiFormat: "openai_chat",
    model: "wrong-renderer-model",
    baseUrl: "https://wrong.example.invalid",
    apiKey: "profile-secret",
  }));
  expect(JSON.stringify(result)).not.toContain("profile-secret");
});

test("connection probes report corrupt profile storage separately from a missing key", async () => {
  const result = await tryHandleAiOwnedRequest(
    {
      type: "ai.test-connection.request",
      apiFormat: "openai_chat",
      model: "gpt-4o",
      profileId: "ai_000000000000000000000006",
    },
    runtime({
      getDecryptedProfileApiKey: () => {
        throw new AiProfileStorageError(new Error("profile catalog is corrupt"));
      },
    }),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "AI_PROFILE_STORAGE_FAILED" },
  });
});

test("listing models uses a saved profile credential with the current draft endpoint and format", async () => {
  const fetchFn = vi.fn(async () => new Response(
    JSON.stringify({ data: [{ id: "draft-model" }] }),
    { status: 200 },
  ));
  vi.stubGlobal("fetch", fetchFn);
  try {
    const getDecryptedProfileApiKey = vi.fn(() => "profile-secret");
    const result = await tryHandleAiOwnedRequest(
      {
        type: "ai.list-models.request",
        apiFormat: "openai_chat",
        baseUrl: "https://draft.example.invalid/v1",
        profileId: "ai_000000000000000000000006",
      },
      runtime({
        loadAiConfig: () => config({
          profiles: [{
            id: "ai_000000000000000000000006",
            name: "Saved profile with an older endpoint",
            apiFormat: "anthropic",
            model: "saved-model",
            baseUrl: "https://saved.example.invalid",
            hasCredential: true,
          }],
        }),
        getDecryptedProfileApiKey,
      }),
    );

    expect(getDecryptedProfileApiKey).toHaveBeenCalledWith("ai_000000000000000000000006");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://draft.example.invalid/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer profile-secret" }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      type: "ai.list-models.result",
      models: ["draft-model"],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});


test("legacy global model clients update the active named connection without replacing its credential", async () => {
  const rt = runtime();
  const result = await tryHandleAiOwnedRequest({
    type: "ai.config.set.request", apiFormat: "anthropic", model: "custom-text-model", baseUrl: "https://example.invalid/model",
    autoAnalyzeEnabled: false, disclaimerAccepted: true,
  }, rt);
  expect(result).toEqual({ ok: true, type: "ai.config.saved" });
  expect(rt.saveConnectionProfile).toHaveBeenCalledWith({
    id: "ai_000000000000000000000000", name: "Test profile", apiFormat: "anthropic", model: "custom-text-model", baseUrl: "https://example.invalid/model",
  });
  expect(rt.activateConnectionProfile).not.toHaveBeenCalled();
});

test("legacy global model setup creates and activates a credential-bearing profile without a library", async () => {
  const rt = runtime({ loadAiConfig: () => config({ activeProfileId: null, profiles: [], hasKey: false }) });
  const result = await tryHandleAiOwnedRequest({
    type: "ai.config.set.request", apiFormat: "openai_chat", model: "text-model", baseUrl: "https://example.invalid/v1", apiKey: "fixture-key",
    autoAnalyzeEnabled: false, disclaimerAccepted: true,
  }, rt);
  expect(result).toEqual({ ok: true, type: "ai.config.saved" });
  expect(rt.saveConnectionProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Default AI connection", apiKey: "fixture-key" }));
  expect(rt.activateConnectionProfile).toHaveBeenCalledWith("ai_000000000000000000000000");
});

test("analysis preferences can be saved without credentials and never mutate a connection draft", async () => {
  const rt = runtime({ loadAiConfig: () => config({ activeProfileId: null, profiles: [], hasKey: false }) });
  expect(await tryHandleAiOwnedRequest({
    type: "ai.config.set.request", autoAnalyzeEnabled: false, disclaimerAccepted: true,
  }, rt)).toEqual({ ok: true, type: "ai.config.saved" });
  expect(rt.saveConnectionProfile).not.toHaveBeenCalled();
  expect(rt.activateConnectionProfile).not.toHaveBeenCalled();
  expect(rt.saveAiConfig).toHaveBeenCalled();
});
