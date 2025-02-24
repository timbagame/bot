import { getDb } from '../connection';

export interface User {
  id?: number;
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  wallet?: {
    publicKey: string;
    encryptedPrivateKey: string; // Encrypted for security
  };
  createdAt?: Date;
  updatedAt?: Date;
}

export class UserModel {
  /**
   * Find a user by Telegram ID
   */
  async findByTelegramId(telegramId: number): Promise<User | null> {
    const db = getDb();
    const row = db.query(`SELECT * FROM users WHERE telegram_id = $telegramId`)
      .get({ $telegramId: telegramId });

    if (!row) return null;

    return this.rowToUser(row);
  }

  /**
   * Create a new user
   */
  async create(userData: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const db = getDb();
    db.query(`
      INSERT INTO users (
        telegram_id, username, first_name, last_name
      ) VALUES ($telegramId, $username, $firstName, $lastName)
    `).run({
      $telegramId: userData.telegramId,
      $username: userData.username || null,
      $firstName: userData.firstName || null,
      $lastName: userData.lastName || null
    });

    return this.findByTelegramId(userData.telegramId) as Promise<User>;
  }

  /**
   * Update a user
   */
  async update(telegramId: number, update: Partial<Omit<User, 'id' | 'telegramId' | 'createdAt' | 'updatedAt'>>): Promise<User | null> {
    const db = getDb();
    const user = await this.findByTelegramId(telegramId);

    if (!user) return null;

    const sets = [];
    const params: Record<string, any> = { $telegramId: telegramId };

    if (update.username !== undefined) {
      sets.push('username = $username');
      params.$username = update.username;
    }

    if (update.firstName !== undefined) {
      sets.push('first_name = $firstName');
      params.$firstName = update.firstName;
    }

    if (update.lastName !== undefined) {
      sets.push('last_name = $lastName');
      params.$lastName = update.lastName;
    }

    if (update.wallet) {
      sets.push('wallet_public_key = $publicKey');
      params.$publicKey = update.wallet.publicKey;

      sets.push('wallet_encrypted_private_key = $encryptedKey');
      params.$encryptedKey = update.wallet.encryptedPrivateKey;
    }

    if (sets.length === 0) return user;

    sets.push('updated_at = CURRENT_TIMESTAMP');

    db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE telegram_id = $telegramId`
    ).run(params);

    return this.findByTelegramId(telegramId);
  }

  /**
   * Save wallet information for a user
   */
  async saveWallet(telegramId: number, publicKey: string, encryptedPrivateKey: string): Promise<User | null> {
    const db = getDb();
    const user = await this.findByTelegramId(telegramId);

    if (!user) return null;

    db.query(`
      UPDATE users SET
        wallet_public_key = $publicKey,
        wallet_encrypted_private_key = $encryptedKey,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = $telegramId
    `).run({
      $publicKey: publicKey,
      $encryptedKey: encryptedPrivateKey,
      $telegramId: telegramId
    });

    return this.findByTelegramId(telegramId);
  }

  /**
   * Convert a database row to a User object
   */
  private rowToUser(row: any): User {
    const user: User = {
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };

    if (row.wallet_public_key) {
      user.wallet = {
        publicKey: row.wallet_public_key,
        encryptedPrivateKey: row.wallet_encrypted_private_key
      };
    }

    return user;
  }
}
