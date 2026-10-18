import {
  aiTagsSchemaDescription,
  buildAiAnalysisSystemPrompt,
} from '../../shared/ai-analysis-settings';
import { resolveGeminiGenerateContentUrl } from '../../shared/ai-endpoints';
import { buildAiAnalysisUserTextLines, parseAiAnalysisResultFromModelText, resolveAiAnalysisSettings } from './protocol';
import { isUnsupportedVisionResponse } from '../../shared/model-vision-capability';
import type { AiAnalysisRequest, AiAnalysisResult } from './protocol';
import { isAiAbortOrTimeoutError, VendorAdapterError } from './vendor-adapter';
import type { VendorAdapter, VendorId } from './vendor-adapter';

/**
 * Gemini structured-output schema sent via `responseSchema`.
 * Mirrors `aiStructuredOutputSchema` from protocol.ts.
 */
function buildGeminiResponseSchema(language: string) {
  return {
    type: 'object' as const,
    properties: {
      description: {
        type: 'string' as const,
        description: `Description of the asset content in ${language}.`,
        nullable: true,
      },
      tags: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: aiTagsSchemaDescription(language),
      },
      rating: {
        type: 'integer' as const,
        description: 'Aesthetic score from 1 to 5.',
        nullable: true,
      },
    },
    required: ['tags'],
    propertyOrdering: ['description', 'tags', 'rating'],
  };
}

/**
 * Maps HTTP status + body to a VendorAdapterError kind.
 */
function httpStatusToErrorKind(
  status: number,
  bodyText: string,
): VendorAdapterError['kind'] {
  switch (status) {
    case 401:
      return 'auth';
    case 403:
      return 'permission';
    case 429: {
      const lower = bodyText.toLowerCase();
      if (lower.includes('quota') || lower.includes('exhausted')) {
        return 'quota';
      }
      return 'rate_limit';
    }
    case 400:
      return 'invalid_response';
    default:
      if (status >= 500) {
        return 'network';
      }
      return 'invalid_response';
  }
}

/**
 * Gemini vendor adapter using the Generative Language API
 * (generativelanguage.googleapis.com).
 *
 * Structured output is enforced via `responseSchema` in the
 * generation config.
 */
export class GeminiVendorAdapter implements VendorAdapter {
  readonly id: VendorId = 'gemini';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string | undefined;
  private readonly _fetch: typeof fetch;

  constructor(
    apiKey: string,
    model: string,
    customFetch?: typeof fetch,
    baseUrl?: string,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this._fetch = customFetch ?? globalThis.fetch.bind(globalThis);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async analyze(
    request: AiAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<AiAnalysisResult> {
    const contents = this.#buildContents(request);
    const systemInstruction = this.#buildSystemInstruction(request);

    const url = resolveGeminiGenerateContentUrl(this.model, this.baseUrl, {
      apiKeyQuery: this.apiKey,
    });

    let response: Response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Official Google accepts ?key=; many relays (CC Switch Google
          // strategy) prefer x-goog-api-key. Send both for compatibility.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          system_instruction: systemInstruction,
          contents,
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: buildGeminiResponseSchema(request.language),
          },
        }),
        signal,
      });
    } catch (error: unknown) {
      throw this.#mapFetchError(error);
    }

    if (!response.ok) {
      throw await this.#mapHttpError(response);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error: unknown) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI service returned an unreadable response.',
        { cause: error, retryable: true },
      );
    }

    return this.#extractResult(json);
  }

  async probeConnection(signal?: AbortSignal): Promise<void> {
    const url = resolveGeminiGenerateContentUrl(this.model, this.baseUrl, {
      apiKeyQuery: this.apiKey,
    });
    let response: Response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Reply with the single word OK.' }],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 16,
          },
        }),
        signal,
      });
    } catch (error: unknown) {
      throw this.#mapFetchError(error);
    }
    if (!response.ok) {
      throw await this.#mapHttpError(response);
    }
    try {
      await response.json();
    } catch (error: unknown) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI service returned an unreadable response.',
        { cause: error },
      );
    }
  }

  // ------------------------------------------------------------------
  // Prompt construction
  // ------------------------------------------------------------------

  #buildSystemInstruction(request: AiAnalysisRequest): {
    parts: Array<{ text: string }>;
  } {
    const text = this.#buildSystemPromptText(request);
    return { parts: [{ text }] };
  }

  #buildSystemPromptText(request: AiAnalysisRequest): string {
    return buildAiAnalysisSystemPrompt({
      language: request.language,
      settings: resolveAiAnalysisSettings(request),
      enabledFields: request.enabledFields,
      existingTagNames: request.existingTagNames,
      mediaType: request.mediaType,
    });
  }

  #buildContents(
    request: AiAnalysisRequest,
  ): Array<Record<string, unknown>> {
    const parts: Array<Record<string, unknown>> = [];

    // Text part with context
    const textLines = buildAiAnalysisUserTextLines(request);
    parts.push({ text: textLines.join('\n') });

    // Image parts
    if (request.imageBase64) {
      parts.push({
        inlineData: {
          mimeType: request.mime,
          data: request.imageBase64,
        },
      });
    }

    if (request.contactSheetBase64) {
      parts.push({
        inlineData: {
          mimeType: request.contactSheetMime ?? 'image/png',
          data: request.contactSheetBase64,
        },
      });
    }

    return [{ role: 'user', parts }];
  }

  // ------------------------------------------------------------------
  // Error mapping
  // ------------------------------------------------------------------

  #mapFetchError(error: unknown): VendorAdapterError {
    if (isAiAbortOrTimeoutError(error)) {
      return new VendorAdapterError(
        'timeout',
        'The AI request timed out or was cancelled.',
        { cause: error },
      );
    }

    return new VendorAdapterError(
      'network',
      'Could not reach the AI service.',
      { cause: error },
    );
  }

  async #mapHttpError(response: Response): Promise<VendorAdapterError> {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      // Ignore.
    }

    const kind = httpStatusToErrorKind(response.status, bodyText);
    const message = `AI service returned HTTP ${response.status}`;

    return new VendorAdapterError(kind, message, {
      details: { httpStatus: response.status, modalityRejected: [400, 415, 422].includes(response.status) && isUnsupportedVisionResponse(bodyText) },
    });
  }

  // ------------------------------------------------------------------
  // Response extraction
  // ------------------------------------------------------------------

  #extractResult(json: unknown): AiAnalysisResult {
    if (typeof json !== 'object' || json === null) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI service returned an unexpected response shape.',
        { retryable: true },
      );
    }

    const body = json as Record<string, unknown>;

    // Gemini response format: { candidates: [{ content: { parts: [{ text }] } }] }
    if (!Array.isArray(body.candidates) || body.candidates.length === 0) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI service returned no candidates.',
        { retryable: true },
      );
    }

    const candidate: unknown = body.candidates[0];
    const rawContent = candidate !== null && typeof candidate === 'object'
      ? (candidate as Record<string, unknown>).content
      : undefined;
    const rawParts = rawContent !== null && typeof rawContent === 'object'
      ? (rawContent as Record<string, unknown>).parts
      : undefined;
    const parts = Array.isArray(rawParts)
      ? rawParts.filter((part): part is Record<string, unknown> =>
        part !== null && typeof part === 'object' && !Array.isArray(part))
      : [];

    if (!parts || parts.length === 0) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI service returned an empty response.',
        { retryable: true },
      );
    }

    const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text as string).join('');
    if (!text) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI response contained no text.',
        { retryable: true },
      );
    }

    const modelVersion =
      typeof body.modelVersion === 'string' && body.modelVersion.length > 0
        ? body.modelVersion
        : this.model;

    try {
      return parseAiAnalysisResultFromModelText(text, modelVersion);
    } catch (error: unknown) {
      throw new VendorAdapterError(
        'invalid_response',
        'The AI response did not match the required schema.',
        { cause: error, retryable: true },
      );
    }
  }
}
