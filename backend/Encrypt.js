// ═══════════════════════════════════════════════════════
//  encrypt.js — AES-256-CBC encryption utility
//  Used to encrypt/decrypt sensitive landlord M-Pesa
//  credentials stored in the database.
//
//  Requires in .env:
//    ENCRYPTION_KEY=<32-char random string>
//
//  Generate a key:
//    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
//  Usage:
//    const { encrypt, decrypt } = require('./encrypt');
//    const cipher = encrypt('my-secret');   // store this in DB
//    const plain  = decrypt(cipher);        // use this for API calls
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // AES block size

// ── Get key from env — must be exactly 32 bytes ──
function getKey() {
    const raw = process.env.ENCRYPTION_KEY;
    if (!raw) throw new Error('ENCRYPTION_KEY is not set in .env');

    // Accept either a 64-char hex string or a 32-char plain string
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
        return Buffer.from(raw, 'hex'); // 32 bytes from hex
    }

    if (raw.length >= 32) {
        return Buffer.from(raw.slice(0, 32), 'utf8'); // use first 32 chars
    }

    throw new Error('ENCRYPTION_KEY must be at least 32 characters or 64 hex chars');
}

// ── Encrypt plain text → "iv:ciphertext" string ──
function encrypt(plainText) {
    if (!plainText) return null;

    const key = getKey();
    const iv  = crypto.randomBytes(IV_LENGTH);

    const cipher     = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted  = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);

    // Store as "hex_iv:hex_ciphertext" — both parts needed for decryption
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// ── Decrypt "iv:ciphertext" string → plain text ──
function decrypt(encryptedText) {
    if (!encryptedText) return null;

    const key    = getKey();
    const parts  = encryptedText.split(':');

    if (parts.length !== 2) {
        throw new Error('Invalid encrypted value format — expected "iv:ciphertext"');
    }

    const iv         = Buffer.from(parts[0], 'hex');
    const ciphertext = Buffer.from(parts[1], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return decrypted.toString('utf8');
}

// ── Safe decrypt — returns null instead of throwing on bad data ──
function safeDecrypt(encryptedText) {
    try {
        return decrypt(encryptedText);
    } catch {
        return null;
    }
}

// ── Check if a value is already encrypted ──
function isEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 2 && /^[0-9a-f]+$/i.test(parts[0]) && /^[0-9a-f]+$/i.test(parts[1]);
}

module.exports = { encrypt, decrypt, safeDecrypt, isEncrypted };