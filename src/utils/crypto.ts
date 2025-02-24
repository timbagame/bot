import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // For AES, this is always 16 bytes
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const ITERATIONS = 100000;

/**
 * Encrypt a private key using a password
 * @param privateKey The private key to encrypt
 * @param password The password to use for encryption
 * @returns The encrypted private key as a string
 */
export function encryptPrivateKey(privateKey: string, password: string): string {
  // Generate a random salt
  const salt = crypto.randomBytes(SALT_LENGTH);

  // Generate a key from the password and salt
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512');

  // Generate a random initialization vector
  const iv = crypto.randomBytes(IV_LENGTH);

  // Create cipher
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  // Encrypt the private key
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Get the authentication tag
  const tag = cipher.getAuthTag();

  // Combine the salt, iv, tag, and encrypted data into a single string
  const result = Buffer.concat([
    salt,
    iv,
    tag,
    Buffer.from(encrypted, 'hex')
  ]).toString('base64');

  return result;
}

/**
 * Decrypt an encrypted private key using a password
 * @param encryptedPrivateKey The encrypted private key
 * @param password The password used for encryption
 * @returns The decrypted private key
 */
export function decryptPrivateKey(encryptedPrivateKey: string, password: string): string {
  // Convert the encrypted data from base64 to a buffer
  const encryptedBuffer = Buffer.from(encryptedPrivateKey, 'base64');

  // Extract the salt, iv, tag, and encrypted data
  const salt = encryptedBuffer.subarray(0, SALT_LENGTH);
  const iv = encryptedBuffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = encryptedBuffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = encryptedBuffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH).toString('hex');

  // Generate the key from the password and salt
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512');

  // Create decipher
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  // Decrypt the private key
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
