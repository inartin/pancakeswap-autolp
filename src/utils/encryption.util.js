import sodium from 'sodium-native';
import { randomBytes } from 'crypto';

/**
 * Derives an encryption key from a master password using Argon2id
 *
 * @param {string} masterPassword - The master password
 * @param {Buffer} salt - Salt for key derivation (16 bytes)
 * @returns {Buffer} Derived encryption key (32 bytes)
 */
function deriveKey(masterPassword, salt) {
    const key = Buffer.allocUnsafe(sodium.crypto_secretbox_KEYBYTES);
    const password = Buffer.from(masterPassword);

    sodium.crypto_pwhash(
        key,
        password,
        salt,
        sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_ALG_ARGON2ID13
    );

    return key;
}

/**
 * Encrypts a private key using libsodium's secretbox (XSalsa20-Poly1305)
 *
 * @param {string} privateKey - The private key to encrypt (base58 string)
 * @param {string} masterPassword - The master password for encryption
 * @returns {Object} Object containing { encryptedKey: string, nonce: string, salt: string }
 */
export function encryptPrivateKey(privateKey, masterPassword) {
    if (!privateKey || !masterPassword) {
        throw new Error('Private key and master password are required');
    }

    // Generate random salt and nonce
    const salt = randomBytes(sodium.crypto_pwhash_SALTBYTES);
    const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES);

    // Derive encryption key from master password
    const key = deriveKey(masterPassword, salt);

    // Prepare message
    const message = Buffer.from(privateKey, 'utf8');
    const ciphertext = Buffer.allocUnsafe(message.length + sodium.crypto_secretbox_MACBYTES);

    // Encrypt
    sodium.crypto_secretbox_easy(ciphertext, message, nonce, key);

    // Return as base64 strings for easy storage
    return {
        encryptedKey: ciphertext.toString('base64'),
        nonce: nonce.toString('base64'),
        salt: salt.toString('base64')
    };
}

/**
 * Decrypts an encrypted private key
 *
 * @param {string} encryptedKey - The encrypted key (base64)
 * @param {string} nonce - The nonce used for encryption (base64)
 * @param {string} salt - The salt used for key derivation (base64)
 * @param {string} masterPassword - The master password
 * @returns {string} Decrypted private key
 */
export function decryptPrivateKey(encryptedKey, nonce, salt, masterPassword) {
    if (!encryptedKey || !nonce || !salt || !masterPassword) {
        throw new Error('All parameters are required for decryption');
    }

    try {
        // Convert from base64
        const ciphertext = Buffer.from(encryptedKey, 'base64');
        const nonceBuffer = Buffer.from(nonce, 'base64');
        const saltBuffer = Buffer.from(salt, 'base64');

        // Derive encryption key
        const key = deriveKey(masterPassword, saltBuffer);

        // Prepare buffer for decrypted message
        const message = Buffer.allocUnsafe(ciphertext.length - sodium.crypto_secretbox_MACBYTES);

        // Decrypt
        const success = sodium.crypto_secretbox_open_easy(message, ciphertext, nonceBuffer, key);

        if (!success) {
            throw new Error('Decryption failed - invalid password or corrupted data');
        }

        return message.toString('utf8');
    } catch (error) {
        throw new Error(`Failed to decrypt private key: ${error.message}`);
    }
}

/**
 * Securely clears sensitive data from memory
 *
 * @param {Buffer|string} data - Data to clear
 */
export function secureClear(data) {
    if (Buffer.isBuffer(data)) {
        sodium.sodium_memzero(data);
    } else if (typeof data === 'string') {
        // For strings, we can't directly zero memory, but we can provide this helper
        // to remind developers to not reuse variables
        return null;
    }
}
