import { describe, expect, it } from 'vitest';
import {
  ModelCredentialCipher,
  modelCredentialFingerprint,
  parseModelCredentialMasterKey,
} from '../src/index.js';

const masterKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const wrongKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

describe('ModelCredentialCipher', () => {
  it('encrypts and decrypts API keys with AES-256-GCM', () => {
    const cipher = new ModelCredentialCipher(masterKey);
    const encrypted = cipher.encrypt({
      profile_id: 'profile_a',
      credential_revision: 1,
      api_key: 'gateway-a-secret',
    });

    expect(encrypted.ciphertext).not.toContain('gateway-a-secret');
    expect(Buffer.from(encrypted.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(encrypted.auth_tag, 'base64')).toHaveLength(16);
    expect(encrypted.credential_fingerprint).toBe(modelCredentialFingerprint('gateway-a-secret'));
    expect(cipher.decrypt({ profile_id: 'profile_a', credential_revision: 1, ...encrypted })).toBe('gateway-a-secret');
  });

  it('uses a random IV for repeated encryptions', () => {
    const cipher = new ModelCredentialCipher(masterKey);
    const first = cipher.encrypt({ profile_id: 'profile_a', credential_revision: 1, api_key: 'same-secret' });
    const second = cipher.encrypt({ profile_id: 'profile_a', credential_revision: 1, api_key: 'same-secret' });

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('fails closed for tampered ciphertext, iv, tag, aad, and wrong keys', () => {
    const cipher = new ModelCredentialCipher(masterKey);
    const encrypted = cipher.encrypt({ profile_id: 'profile_a', credential_revision: 1, api_key: 'gateway-a-secret' });

    expect(() => cipher.decrypt({ profile_id: 'profile_a', credential_revision: 1, ...encrypted, ciphertext: tamperBase64(encrypted.ciphertext) })).toThrow(/MODEL_CREDENTIAL_DECRYPT_FAILED/u);
    expect(() => cipher.decrypt({ profile_id: 'profile_a', credential_revision: 1, ...encrypted, iv: tamperBase64(encrypted.iv) })).toThrow();
    expect(() => cipher.decrypt({ profile_id: 'profile_a', credential_revision: 1, ...encrypted, auth_tag: tamperBase64(encrypted.auth_tag) })).toThrow(/MODEL_CREDENTIAL_DECRYPT_FAILED/u);
    expect(() => cipher.decrypt({ ...encrypted, profile_id: 'profile_a', credential_revision: 2 })).toThrow(/MODEL_CREDENTIAL_DECRYPT_FAILED/u);
    expect(() => new ModelCredentialCipher(wrongKey).decrypt({ profile_id: 'profile_a', credential_revision: 1, ...encrypted })).toThrow(/MODEL_CREDENTIAL_DECRYPT_FAILED/u);
  });

  it('validates master key format', () => {
    expect(parseModelCredentialMasterKey(masterKey)).toHaveLength(32);
    expect(() => parseModelCredentialMasterKey('not-base64')).toThrow(/MODEL_CREDENTIAL_MASTER_KEY_INVALID/u);
    expect(() => parseModelCredentialMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/MODEL_CREDENTIAL_MASTER_KEY_INVALID/u);
  });
});

function tamperBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64');
}
