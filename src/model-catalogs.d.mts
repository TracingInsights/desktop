export interface StaticModelCatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
}

export const STATIC_CODEX_MODELS: StaticModelCatalogEntry[];
export const STATIC_XAI_MODELS: StaticModelCatalogEntry[];
