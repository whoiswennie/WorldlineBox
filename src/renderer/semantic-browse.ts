import type { AssetSummary, FilterClause, SearchQuery, SearchScope, SortDefinition } from "../shared/asset-types";
import type { SemanticSearchPageSize } from "./semantic-search-preferences";
import type { BrowseSearchPageRegistration } from "./use-browse-pagination";

/** Semantic results keep the toolbar query so later pages do not become an empty search. */
export function semanticBrowseRegistration(input: {
  libraryId: string;
  query: SearchQuery | null;
  filters?: FilterClause[] | null;
  scope?: SearchScope | null;
  sort?: SortDefinition | null;
  showIgnored: boolean;
  rankedAssetIds: readonly string[];
  rankedPageSize: SemanticSearchPageSize;
  items: AssetSummary[];
  similaritySourceAssetId?: string;
}): BrowseSearchPageRegistration {
  return {
    libraryId: input.libraryId,
    query: input.query,
    filters: input.filters ?? null,
    scope: input.scope ?? null,
    sort: input.sort ?? null,
    showIgnored: input.showIgnored,
    rankedAssetIds: input.rankedAssetIds,
    rankedPageSize: input.rankedPageSize,
    items: input.items,
    total: input.rankedAssetIds.length,
    offset: 0,
    ...(input.similaritySourceAssetId ? { similaritySourceAssetId: input.similaritySourceAssetId } : {}),
  };
}


/**
 * Keyword hits stay visible and rank ahead of semantic-only matches.
 * Shared IDs keep the keyword position; semantic order fills the rest.
 */
export function mergeKeywordAndSemanticRanks(input: {
  keywordAssetIds: readonly string[];
  semanticAssetIds: readonly string[];
}): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const assetId of input.keywordAssetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    merged.push(assetId);
  }
  for (const assetId of input.semanticAssetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    merged.push(assetId);
  }
  return merged;
}
