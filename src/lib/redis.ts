import Redis from 'ioredis';

/**
 * Le Passeur, le Conservateur et le rate limiting ont besoin de compteurs
 * expirants. En production c'est Redis. Sans REDIS_URL, on bascule sur un
 * store mémoire : l'app tourne en local sans dépendance externe, mais les
 * compteurs meurent avec le process (dev / test uniquement).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

class MemoryStore implements KeyValueStore {
  private data = new Map<string, { value: string; expiresAt: number | null }>();

  private read(key: string): string | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string) {
    return this.read(key);
  }

  async setex(key: string, seconds: number, value: string) {
    this.data.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
  }

  async incr(key: string) {
    const current = Number(this.read(key) ?? 0) + 1;
    const previous = this.data.get(key);
    this.data.set(key, { value: String(current), expiresAt: previous?.expiresAt ?? null });
    return current;
  }

  async expire(key: string, seconds: number) {
    const entry = this.data.get(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
  }

  async del(key: string) {
    this.data.delete(key);
  }
}

class RedisStore implements KeyValueStore {
  constructor(private client: Redis) {}

  get(key: string) {
    return this.client.get(key);
  }

  async setex(key: string, seconds: number, value: string) {
    await this.client.setex(key, seconds, value);
  }

  incr(key: string) {
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number) {
    await this.client.expire(key, seconds);
  }

  async del(key: string) {
    await this.client.del(key);
  }
}

const globalForStore = globalThis as unknown as { heritageStore?: KeyValueStore };

function createStore(): KeyValueStore {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[store] REDIS_URL absent en production : compteurs non partagés entre instances.');
    }
    return new MemoryStore();
  }
  return new RedisStore(new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false }));
}

export const store: KeyValueStore = globalForStore.heritageStore ?? createStore();

if (process.env.NODE_ENV !== 'production') globalForStore.heritageStore = store;

/** Exporté pour les tests : permet un store neuf et isolé. */
export function createMemoryStore(): KeyValueStore {
  return new MemoryStore();
}
