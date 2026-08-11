/**
 * Static model catalogs shared by the desktop bridge and SvelteKit proxies.
 *
 * This dependency-free module lives beside the bridge so Electron's default
 * packaging includes it. The SvelteKit routes import the same source at build
 * time, preventing the desktop and web catalogs from drifting apart.
 */

// Mirrors the recommended Codex model list published at
// https://developers.openai.com/codex/models (ChatGPT sign-in path, which is
// what this integration proxies through). gpt-5.2 and gpt-5.3-codex are
// deprecated for ChatGPT sign-in and are intentionally excluded. Keep this in
// sync with that docs page; the CLI catalog (codex-rs/models-manager/models.json)
// also lists deprecated slugs and should not be used as the sole source of truth.
// gpt-5.6 is added per user request: OpenAI lists it as a trusted-partner
// preview (https://platform.openai.com/docs/models). Its official context
// window is not yet published; 256000 is used as a conservative placeholder.
// It may only be selectable for accounts with preview access. The sol/terra/luna
// sub-variants were confirmed via the user's partner portal.
export const STATIC_CODEX_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 256000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 256000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 256000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 256000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 256000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 256000 },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    contextWindow: 256000
  }
];

export const STATIC_XAI_MODELS = [
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', contextWindow: 256000 },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 256000 },
  { id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 256000 },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 Reasoning',
    contextWindow: 256000
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20 Non-reasoning',
    contextWindow: 256000
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    name: 'Grok 4.20 Multi-agent',
    contextWindow: 256000
  },
  {
    id: 'grok-composer-2.5-fast',
    name: 'Grok Composer 2.5 Fast',
    contextWindow: 256000
  }
];
