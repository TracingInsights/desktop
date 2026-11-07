/**
 * Custom provider registry — CRUD for user-registered inference endpoints.
 *
 * The registry file (`userData/providers.json`) holds only non-secret
 * provider metadata. API keys live in a separate `userData/provider-keys.json`
 * file, encrypted with safeStorage when available and stored plaintext
 * (mode 0600) otherwise — the harness never silently refuses to save (see
 * the safeStorage fallback note in docs/custom-providers-desktop.md).
 *
 * Pure Node + injected deps so `bun test` can drive it without Electron:
 *   - `userDataDir`  — directory for the JSON files (app.getPath('userData'))
 *   - `safeStorage`  — Electron safeStorage (encryptString/decryptString/
 *                      isEncryptionAvailable); a mock for tests
 *   - `confirm`      — native confirmation shown when a write reroutes traffic
 *                      (add, or update where baseUrl/protocol changes)
 *
 * Target validation (§D4): loopback hosts over http, remote hosts over https
 * only — delegated to shared.isAllowedTarget / shared.normalizeBaseUrl.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isAllowedTarget,
  normalizeBaseUrl,
  inferenceError
} from './protocols/shared.mjs';

export const REGISTRY_FILE = 'providers.json';
export const KEYS_FILE = 'provider-keys.json';

const PROTOCOLS = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses'
]);

function invalid(message) {
  return inferenceError('invalid_request', { providerMessage: message });
}

/** Accept `string[]` or `{ id, reasoning? }[]` (and mixed). */
export function normalizeModels(models, reasoningModels) {
  const byId = new Map();
  if (Array.isArray(models)) {
    for (const m of models) {
      if (typeof m === 'string') {
        const id = m.trim();
        if (id && !byId.has(id)) byId.set(id, { id });
        continue;
      }
      if (m && typeof m === 'object' && typeof m.id === 'string') {
        const id = m.id.trim();
        if (!id) continue;
        byId.set(id, {
          id,
          ...(m.reasoning === true ? { reasoning: true } : {})
        });
      }
    }
  }
  if (Array.isArray(reasoningModels)) {
    const reasoning = new Set(
      reasoningModels.map((raw) => String(raw ?? '').trim()).filter(Boolean)
    );
    for (const [id, entry] of byId) {
      if (reasoning.has(id)) entry.reasoning = true;
      else delete entry.reasoning;
    }
    for (const id of reasoning) {
      if (!byId.has(id)) byId.set(id, { id, reasoning: true });
    }
  }
  return [...byId.values()];
}

function publicModels(entry) {
  const stored = Array.isArray(entry.models) ? entry.models : [];
  const ids = [];
  const reasoningModels = [];
  for (const m of stored) {
    if (typeof m === 'string') {
      if (m) ids.push(m);
      continue;
    }
    if (m && typeof m.id === 'string' && m.id) {
      ids.push(m.id);
      if (m.reasoning) reasoningModels.push(m.id);
    }
  }
  return { ids, reasoningModels };
}

function readJson(file) {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode });
}

/** true when safeStorage can encrypt (and therefore decrypt) at rest. */
function encryptionAvailable(storage) {
  return Boolean(storage?.isEncryptionAvailable?.());
}

function encrypt(storage, plaintext) {
  if (!plaintext) return null;
  if (encryptionAvailable(storage)) {
    return {
      encrypted: true,
      value: storage.encryptString(plaintext).toString('base64')
    };
  }
  return { encrypted: false, value: plaintext };
}

function decrypt(storage, stored) {
  if (!stored) return null;
  if (stored.encrypted && encryptionAvailable(storage)) {
    try {
      return storage.decryptString(Buffer.from(stored.value, 'base64'));
    } catch {
      return null;
    }
  }
  if (!stored.encrypted) return stored.value;
  return null;
}

export function createProviderRegistry(deps = {}) {
  const {
    userDataDir = '',
    safeStorage = undefined,
    confirm = async () => true
  } = deps;

  const registryFile = () => join(userDataDir, REGISTRY_FILE);
  const keysFile = () => join(userDataDir, KEYS_FILE);

  function loadRegistry() {
    const value = readJson(registryFile());
    if (!value || !Array.isArray(value.providers)) return [];
    return value.providers.filter(
      (p) => p && typeof p.id === 'string' && typeof p.baseUrl === 'string'
    );
  }

  function loadKeys() {
    const value = readJson(keysFile());
    return value && typeof value === 'object' && value.keys ? value.keys : {};
  }

  function persistRegistry(providers) {
    writeJson(registryFile(), { providers });
  }

  function persistKeys(keys) {
    writeJson(keysFile(), { keys });
  }

  /** Public provider info — never returns the key, only `hasKey`. */
  function toInfo(entry, keys) {
    const { ids, reasoningModels } = publicModels(entry);
    return {
      id: entry.id,
      label: entry.label,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      models: ids,
      ...(reasoningModels.length > 0 ? { reasoningModels } : {}),
      hasKey: Boolean(keys[entry.id]),
      updatedAt: entry.updatedAt ?? 0
    };
  }

  /** Resolve an entry (metadata + decrypted key) by id. */
  function resolve(id) {
    const entry = loadRegistry().find((p) => p.id === id);
    if (!entry) return null;
    const stored = loadKeys()[id];
    return {
      entry,
      apiKey: decrypt(safeStorage, stored) ?? undefined
    };
  }

  function validate({ label, protocol, baseUrl, models }) {
    if (label !== undefined && !String(label ?? '').trim()) {
      return invalid('Provider label is required.');
    }
    if (protocol !== undefined && !PROTOCOLS.has(protocol)) {
      return invalid(`Unsupported protocol: ${protocol}.`);
    }
    if (baseUrl !== undefined) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized) return invalid('Enter a valid base URL.');
      let parsed;
      try {
        parsed = new URL(normalized);
      } catch {
        return invalid('Enter a valid base URL.');
      }
      if (!isAllowedTarget(normalized)) {
        return invalid(
          'The endpoint must be a local loopback URL over http (127.0.0.1 / localhost / ::1) or a remote https:// URL.'
        );
      }
      if (parsed.protocol === 'http:' && parsed.hostname === '::1') {
        // `::1` must be bracket-form for fetch; normalizeBaseUrl preserves
        // origin text, so normalize to the bracketed canonical form.
        return { ok: true, normalized };
      }
    }
    if (models !== undefined) {
      if (!Array.isArray(models)) {
        return invalid('Models must be a list of model ids.');
      }
      const bad = models.some((m) => {
        if (typeof m === 'string') return false;
        return !(m && typeof m === 'object' && typeof m.id === 'string');
      });
      if (bad) return invalid('Models must be a list of model ids.');
    }
    return { ok: true };
  }

  return {
    /** List metadata for every registered provider (never keys). */
    list() {
      const keys = loadKeys();
      return loadRegistry().map((entry) => toInfo(entry, keys));
    },

    get(id) {
      const resolved = resolve(id);
      return resolved ? toInfo(resolved.entry, loadKeys()) : undefined;
    },

    /** Full resolution including the decrypted key (main-process only). */
    resolve(id) {
      return resolve(id);
    },

    async add(input = {}) {
      const check = validate(input);
      if (check && !check.ok && check.error) return check;
      if (!PROTOCOLS.has(input.protocol)) {
        return invalid(`Unsupported protocol: ${input.protocol}.`);
      }
      if (!input.baseUrl) return invalid('Enter a base URL.');
      const normalized = normalizeBaseUrl(input.baseUrl);
      if (!isAllowedTarget(normalized)) {
        return invalid(
          'The endpoint must be a local loopback URL over http (127.0.0.1 / localhost / ::1) or a remote https:// URL.'
        );
      }

      // Rerouting traffic → explicit native confirmation.
      const approved = await confirm(normalized);
      if (!approved) {
        return invalid('Add cancelled.');
      }

      const id = `custom:${randomUUID()}`;
      const entry = {
        id,
        label: String(input.label ?? '').trim() || 'Custom provider',
        protocol: input.protocol,
        baseUrl: normalized,
        models: normalizeModels(input.models, input.reasoningModels),
        updatedAt: Date.now()
      };

      const registry = loadRegistry();
      registry.push(entry);
      persistRegistry(registry);

      if (input.apiKey) {
        const keys = loadKeys();
        keys[id] = encrypt(safeStorage, input.apiKey);
        persistKeys(keys);
      }

      return { ok: true, id };
    },

    async update(id, patch = {}) {
      const existing = resolve(id);
      if (!existing) {
        return invalid(`Unknown provider: ${id}.`);
      }
      const check = validate(patch);
      if (check && !check.ok && check.error) return check;

      const nextBaseUrl =
        patch.baseUrl !== undefined
          ? normalizeBaseUrl(patch.baseUrl)
          : existing.entry.baseUrl;
      const nextProtocol = patch.protocol ?? existing.entry.protocol;

      if (!isAllowedTarget(nextBaseUrl)) {
        return invalid(
          'The endpoint must be a local loopback URL over http (127.0.0.1 / localhost / ::1) or a remote https:// URL.'
        );
      }

      // Only confirm when traffic actually reroutes (baseUrl or protocol
      // changes); metadata-only edits apply silently so the dialog does not
      // become click-through muscle memory.
      const reroutes =
        nextBaseUrl !== existing.entry.baseUrl ||
        nextProtocol !== existing.entry.protocol;
      if (reroutes) {
        const approved = await confirm(nextBaseUrl);
        if (!approved) {
          return invalid('Update cancelled.');
        }
      }

      const registry = loadRegistry();
      const index = registry.findIndex((p) => p.id === id);
      if (index === -1) return invalid(`Unknown provider: ${id}.`);
      registry[index] = {
        ...existing.entry,
        ...(patch.label !== undefined
          ? { label: String(patch.label).trim() || existing.entry.label }
          : {}),
        ...(patch.protocol !== undefined ? { protocol: nextProtocol } : {}),
        ...(patch.baseUrl !== undefined ? { baseUrl: nextBaseUrl } : {}),
        ...(patch.models !== undefined || patch.reasoningModels !== undefined
          ? {
              models: normalizeModels(
                patch.models !== undefined
                  ? patch.models
                  : existing.entry.models,
                patch.reasoningModels
              )
            }
          : {}),
        updatedAt: Date.now()
      };
      persistRegistry(registry);

      if (patch.apiKey !== undefined) {
        const keys = loadKeys();
        if (patch.apiKey) {
          keys[id] = encrypt(safeStorage, patch.apiKey);
        } else {
          delete keys[id];
        }
        persistKeys(keys);
      }

      return { ok: true };
    },

    remove(id) {
      const registry = loadRegistry();
      const next = registry.filter((p) => p.id !== id);
      if (next.length === registry.length) {
        return invalid(`Unknown provider: ${id}.`);
      }
      persistRegistry(next);
      const keys = loadKeys();
      if (id in keys) {
        delete keys[id];
        persistKeys(keys);
      }
      return { ok: true };
    },

    /** true when the registry (or the key file) is stored without encryption. */
    keysStoredUnencrypted() {
      return (
        !encryptionAvailable(safeStorage) && Object.keys(loadKeys()).length > 0
      );
    }
  };
}
