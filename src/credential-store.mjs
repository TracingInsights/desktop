/**
 * Credential store — safeStorage-backed persistence for Codex/xAI OAuth
 * tokens in the main process. Tokens never leave the main process; only
 * masked signals (`masked`) return to the page.
 *
 * On Linux without a keyring, safeStorage is unavailable or weakly encrypted;
 * like the provider registry, keys fall back to a mode-0600 plaintext file
 * rather than refusing to save (docs/custom-providers-desktop.md §2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CREDENTIALS_FILE = 'credentials.json';

function encryptionAvailable(storage) {
  return Boolean(storage?.isEncryptionAvailable?.());
}

function encrypt(storage, plaintext) {
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

export function createCredentialStore(deps = {}) {
  const { userDataDir = '', safeStorage = undefined } = deps;

  const file = () => join(userDataDir, CREDENTIALS_FILE);

  function readAll() {
    try {
      if (!existsSync(file())) return {};
      const parsed = JSON.parse(readFileSync(file(), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(value) {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  return {
    /** Load and decrypt a stored credential, or null when absent/corrupt. */
    load(name) {
      const stored = readAll()[name];
      if (!stored) return null;
      const plaintext = decrypt(safeStorage, stored);
      if (!plaintext) return null;
      try {
        return JSON.parse(plaintext);
      } catch {
        return null;
      }
    },

    save(name, credential) {
      const all = readAll();
      all[name] = encrypt(safeStorage, JSON.stringify(credential));
      writeAll(all);
    },

    delete(name) {
      const all = readAll();
      if (name in all) {
        delete all[name];
        writeAll(all);
      }
    },

    /** true when a credential exists and is stored without encryption. */
    storedUnencrypted(name) {
      const stored = readAll()[name];
      return Boolean(stored && !stored.encrypted);
    }
  };
}
