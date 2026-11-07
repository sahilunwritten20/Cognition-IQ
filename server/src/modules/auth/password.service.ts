import { argon2id, hash, verify } from 'argon2';
import { randomInt } from 'node:crypto';
import { randomToken } from '../../common/crypto';

export interface PasswordConfig {
  memoryKib: number;
  timeCost: number;
}

export class PasswordService {
  private dummy?: Promise<string>;

  constructor(private readonly cfg: PasswordConfig) {}

  hash(plain: string): Promise<string> {
    return hash(plain, {
      type: argon2id,
      memoryCost: this.cfg.memoryKib,
      timeCost: this.cfg.timeCost,
      parallelism: 1,
    });
  }

  async verify(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain);
    } catch {
      return false;
    }
  }

  /** Burn the same CPU time for unknown users so response time does not reveal valid login IDs. */
  async verifyAgainstDummy(plain: string): Promise<void> {
    this.dummy ??= this.hash(randomToken(16));
    await this.verify(await this.dummy, plain);
  }
}

// No look-alike characters (0/O, 1/l/I) so temporary passwords are easy to read out.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateTemporaryPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_ALPHABET.charAt(randomInt(TEMP_ALPHABET.length));
  return out;
}
