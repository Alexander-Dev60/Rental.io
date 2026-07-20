// ═══════════════════════════════════════════════════════
//  encrypt.js — AES-256-GCM encryption utility (v2)
//  Used to encrypt/decrypt sensitive landlord M-Pesa
//  credentials stored in the database.
//
//  CHANGES FROM v1:
//    - CBC → GCM: adds an authentication tag, so tampered or
//      corrupted ciphertext fails loudly instead of silently
//      decrypting to garbage.
//    - Versioned keys: ciphertext now stores WHICH key encrypted
//      it, so you can rotate ENCRYPTION_KEY without breaking every
//      already-stored credential. Old data decrypts with its
//      original key version; new data always uses the current one.
//
//  Requires in .env (Render):
//    ENCRYPTION_KEY_V1=<64-char hex string>   ← your current key
//    ENCRYPTION_KEY_CURRENT_VERSION=1         ← which version new encrypts use
//
//  Generate a key:
//    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
//  ── Rotating the key later ──
//    1. Generate a new key, set ENCRYPTION_KEY_V2=<new hex key> (keep V1 too!)
//    2. Set ENCRYPTION_KEY_CURRENT_VERSION=2
//    3. Deploy. New encrypts use V2. Old V1 ciphertext still decrypts fine,
//       since the version prefix tells decrypt() which key to use.
//    4. (Optional, later) Run a one-off migration script that reads every
//       Property's mpesa* fields, decrypts, re-encrypts, saves — now
//       everything is V2 and you can eventually retire ENCRYPTION_KEY_V1.
//    Never delete an old ENCRYPTION_KEY_V* env var until you've confirmed
//    nothing in the DB still references that version.
//
//  Usage (unchanged):
//    const { encrypt, decrypt, safeDecrypt } = require('./encrypt');
//    const cipher = encrypt('my-secret');   // store this in DB
//    const plain  = decrypt(cipher);        // use this for API calls
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');

const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH    = 12; // 96-bit IV is the GCM-recommended size (not 16, that's a CBC-ism)
const AUTH_TAG_LEN = 16;

// ── Parse "V1:v2:v3" style hex keys from env into a Buffer ──
function parseKey(raw, envVarName) {
    if (!raw) return null;

    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
        return Buffer.from(raw, 'hex'); // 32 bytes from hex — preferred
    }
    if (raw.length >= 32) {
        // Fallback for a plain passphrase — still supported for compatibility,
        // but prefer generating a proper hex key (see header comment).
        return Buffer.from(raw.slice(0, 32), 'utf8');
    }

    throw new Error(`${envVarName} must be at least 32 characters, or 64 hex characters`);
}

// ── Look up the key for a specific version number ──
function getKeyForVersion(version) {
    const envVarName = `ENCRYPTION_KEY_V${version}`;
    const raw = process.env[envVarName];
    if (!raw) {
        throw new Error(
            `${envVarName} is not set — cannot decrypt data encrypted with key version ${version}. ` +
            `If you rotated keys, make sure old ENCRYPTION_KEY_V* vars stay set until all data is migrated.`
        );
    }
    return parseKey(raw, envVarName);
}

// ── Which key version should NEW encryptions use? ──
function getCurrentKeyVersion() {
    const v = parseInt(process.env.ENCRYPTION_KEY_CURRENT_VERSION, 10);
    if (!v || v < 1) {
        throw new Error(
            'ENCRYPTION_KEY_CURRENT_VERSION is not set (or invalid). Set it to the version ' +
            'number matching your current ENCRYPTION_KEY_V<n>, e.g. ENCRYPTION_KEY_CURRENT_VERSION=1'
        );
    }
    return v;
}

// ── Encrypt plain text → "v<version>:iv:ciphertext:authtag" string ──
function encrypt(plainText) {
    if (!plainText) return null;

    const version = getCurrentKeyVersion();
    const key     = getKeyForVersion(version);
    const iv      = crypto.randomBytes(IV_LENGTH);

    const cipher    = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const authTag   = cipher.getAuthTag();

    return `v${version}:${iv.toString('hex')}:${encrypted.toString('hex')}:${authTag.toString('hex')}`;
}

// ── Decrypt "v<version>:iv:ciphertext:authtag" string → plain text ──
function decrypt(encryptedText) {
    if (!encryptedText) return null;

    const parts = String(encryptedText).split(':');

    // Back-compat: v1-format ciphertext ("iv:ciphertext", no version prefix,
    // no auth tag) predates this file. If you have old CBC-encrypted data,
    // migrate it with a one-off script BEFORE deploying this version — this
    // function intentionally does not support decrypting legacy CBC data,
    // since silently mixing algorithms is a worse trap than a loud failure.
    if (parts.length !== 4 || !parts[0].startsWith('v')) {
        throw new Error(
            'Invalid or legacy encrypted value format — expected "v<version>:iv:ciphertext:authtag". ' +
            'If this is old CBC-encrypted data, run the migration script before decrypting.'
        );
    }

    const version    = parseInt(parts[0].slice(1), 10);
    const key        = getKeyForVersion(version);
    const iv         = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    const authTag    = Buffer.from(parts[3], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
}

// ── Safe decrypt — returns null instead of throwing on bad/tampered data ──
function safeDecrypt(encryptedText) {
    try {
        return decrypt(encryptedText);
    } catch {
        return null;
    }
}

// ── Check if a value looks like our encrypted format (any version) ──
function isEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return (
        parts.length === 4 &&
        /^v\d+$/.test(parts[0]) &&
        /^[0-9a-f]+$/i.test(parts[1]) &&
        /^[0-9a-f]+$/i.test(parts[2]) &&
        /^[0-9a-f]+$/i.test(parts[3])
    );
}

module.exports = { encrypt, decrypt, safeDecrypt, isEncrypted };