import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRegistry } from './provider-registry.mjs';

function mockSafeStorage(encryptionAvailable = true) {
  return {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  };
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'tif1ai-registry-'));
}

let dir;
let registry;

describe('provider registry', () => {
  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = tmpDir();
  });

  test('add/list/remove round-trip with encrypted key', async () => {
    registry = createProviderRegistry({
      userDataDir: dir,
      safeStorage: mockSafeStorage(),
      confirm: async () => true
    });
    const added = await registry.add({
      label: 'Ollama',
      protocol: 'openai-completions',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: 'secret',
      models: ['llama3']
    });
    expect(added.ok).toBe(true);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(added.id);
    expect(list[0].hasKey).toBe(true);
    expect(list[0].baseUrl).toBe('http://127.0.0.1:11434/v1');
    // The key never appears in the public metadata.
    expect(JSON.stringify(list)).not.toContain('secret');
  });

  test('resolve returns the decrypted key to the main process only', async () => {
    registry = createProviderRegistry({
      userDataDir: dir,
      safeStorage: mockSafeStorage(),
      confirm: async () => true
    });
    const added = await registry.add({
      label: 'Remote',
      protocol: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-123'
    });
    const resolved = registry.resolve(added.id);
    expect(resolved.apiKey).toBe('sk-123');
  });

  test('rejects non-loopback http targets', async () => {
    registry = createProviderRegistry({ userDataDir: dir });
    const result = await registry.add({
      label: 'LAN',
      protocol: 'openai-completions',
      baseUrl: 'http://192.168.1.10:11434'
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid_request');
  });

  test('skips the confirm dialog for metadata-only updates', async () => {
    let confirmations = 0;
    registry = createProviderRegistry({
      userDataDir: dir,
      safeStorage: mockSafeStorage(),
      confirm: async () => {
        confirmations += 1;
        return true;
      }
    });
    const added = await registry.add({
      label: 'Ollama',
      protocol: 'openai-completions',
      baseUrl: 'http://127.0.0.1:11434'
    });
    expect(confirmations).toBe(1); // add reroutes → confirmed

    const updated = await registry.update(added.id, { label: 'Renamed' });
    expect(updated.ok).toBe(true);
    expect(confirmations).toBe(1); // label-only edit applies silently
  });

  test('confirms again when baseUrl changes', async () => {
    let confirmations = 0;
    registry = createProviderRegistry({
      userDataDir: dir,
      safeStorage: mockSafeStorage(),
      confirm: async () => {
        confirmations += 1;
        return true;
      }
    });
    const added = await registry.add({
      label: 'Ollama',
      protocol: 'openai-completions',
      baseUrl: 'http://127.0.0.1:11434'
    });
    await registry.update(added.id, {
      baseUrl: 'https://api.example.com/v1'
    });
    expect(confirmations).toBe(2);
  });

  test('returns [] on a corrupt registry file', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(join(dir, 'providers.json'), '{not json');
    registry = createProviderRegistry({ userDataDir: dir });
    expect(registry.list()).toEqual([]);
  });

  test('stores object models with a reasoning flag', async () => {
    registry = createProviderRegistry({
      userDataDir: dir,
      confirm: async () => true
    });
    const added = await registry.add({
      label: 'Hosted',
      protocol: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'owner/model', reasoning: true }, 'plain']
    });
    const list = registry.list();
    expect(list[0].models).toEqual(['owner/model', 'plain']);
    expect(list[0].reasoningModels).toEqual(['owner/model']);
    expect(added.ok).toBe(true);

    const resolved = registry.resolve(added.id);
    expect(resolved.entry.models).toEqual([
      { id: 'owner/model', reasoning: true },
      { id: 'plain' }
    ]);
  });
});
