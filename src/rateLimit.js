import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

const localBuckets = new Map();
const limiters = new Map();
let redis;
let redisRetryAt = 0;

export function hasDistributedRateLimit() {
  return Boolean(getRedisConfig());
}

export function hashRateLimitIdentifier(value, secret) {
  return crypto
    .createHmac('sha256', String(secret || 'slrack-rate-limit'))
    .update(String(value || 'unknown'))
    .digest('hex')
    .slice(0, 32);
}

export async function enforceRateLimit({ scope, identifier, limit, windowMs, cost = 1 }) {
  const normalizedScope = String(scope || 'default').replace(/[^a-z0-9:_-]/gi, '-').slice(0, 80);
  const normalizedIdentifier = String(identifier || 'unknown').slice(0, 120);
  const safeLimit = Math.max(1, Number(limit) || 1);
  const safeWindowMs = Math.max(1000, Number(windowMs) || 60_000);
  const safeCost = Math.max(1, Math.ceil(Number(cost) || 1));

  const redisClient = getRedis();
  if (redisClient) {
    try {
      const limiterKey = `${normalizedScope}:${safeLimit}:${safeWindowMs}`;
      let limiter = limiters.get(limiterKey);
      if (!limiter) {
        limiter = new Ratelimit({
          redis: redisClient,
          limiter: Ratelimit.slidingWindow(safeLimit, `${Math.ceil(safeWindowMs / 1000)} s`),
          analytics: false,
          prefix: `slrack:${normalizedScope}`
        });
        limiters.set(limiterKey, limiter);
      }

      const result = await limiter.limit(normalizedIdentifier, { rate: safeCost });
      return {
        ok: result.success,
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        distributed: true
      };
    } catch (error) {
      redisRetryAt = Date.now() + 30_000;
      console.warn('Distributed rate limit failed, using local fallback:', error?.message || error);
    }
  }

  return enforceLocalRateLimit(normalizedScope, normalizedIdentifier, safeLimit, safeWindowMs, safeCost);
}

function getRedis() {
  if (redis && Date.now() >= redisRetryAt) return redis;
  if (redisRetryAt && Date.now() < redisRetryAt) return null;
  const config = getRedisConfig();
  if (!config) return null;
  redis = new Redis(config);
  return redis;
}

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function enforceLocalRateLimit(scope, identifier, limit, windowMs, cost) {
  const now = Date.now();
  const key = `${scope}:${identifier}`;
  const bucket = localBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= windowMs) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += cost;
  localBuckets.set(key, bucket);
  pruneLocalBuckets(now);

  return {
    ok: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    reset: bucket.startedAt + windowMs,
    distributed: false
  };
}

function pruneLocalBuckets(now) {
  if (localBuckets.size < 2000) return;
  for (const [key, bucket] of localBuckets.entries()) {
    if (now - bucket.startedAt > 24 * 60 * 60 * 1000) localBuckets.delete(key);
  }
}
