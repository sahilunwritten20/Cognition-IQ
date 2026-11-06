import Redis from 'ioredis';

export function createRedis(url: string): Redis {
  // Redis must never block exam endpoints (T-05): don't crash on errors, cap retries per command.
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false });
  client.on('error', () => {
    /* surfaced through /ready as "degraded" */
  });
  return client;
}

export async function isRedisReady(client: Redis): Promise<boolean> {
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}
