import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts credential values at rest with the deployment's ENCRYPTION_KEY (AES-256-GCM). `context` is bound in as
 * associated data, so a ciphertext only decrypts for the record it was written for (e.g. one Upstream Server's id):
 * copying it onto another row fails instead of leaking the secret there.
 */
export function createCredentialVault(key: Buffer) {
  if (key.length !== 32) throw new Error("the credential vault needs a 32-byte key");
  return {
    seal(plaintext: string, context: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.of(VERSION), iv, cipher.getAuthTag(), ciphertext]);
    },

    /** Throws if the data was tampered with, sealed for another context, or sealed with another key. */
    open(sealed: Buffer, context: string): string {
      if (sealed[0] !== VERSION) throw new Error(`unknown credential format ${sealed[0]}`);
      const iv = sealed.subarray(1, 1 + IV_BYTES);
      const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

export type CredentialVault = ReturnType<typeof createCredentialVault>;
