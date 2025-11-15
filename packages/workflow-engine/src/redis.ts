import IORedis, {
  type Cluster,
  type ClusterNode,
  type ClusterOptions,
  type Redis,
  type RedisOptions,
} from 'ioredis'
import type { ConnectionOptions } from 'tls'
import pino from 'pino'
import {
  REDIS_MODE_ENV,
  REDIS_NAMESPACE_ENV,
  REDIS_URL_ENV,
  type RedisMode,
  createRedisKeyFactory,
} from '@kb-labs/workflow-constants'

const DEFAULT_REDIS_URL = 'redis://localhost:6379'

export type RedisClient = Redis | Cluster

export interface LoggerLike {
  debug?(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string | Error, meta?: Record<string, unknown>): void
}

export interface CreateRedisClientOptions {
  mode?: RedisMode
  url?: string
  namespace?: string
  redisOptions?: RedisOptions
  cluster?: {
    nodes: Array<string | ClusterNode>
    options?: ClusterOptions
  }
  sentinel?: {
    name: string
    hosts: Array<string | { host: string; port: number }>
    username?: string
    password?: string
    db?: number
    tls?: boolean | ConnectionOptions
  }
  logger?: LoggerLike
}

function toClusterNode(node: string | ClusterNode): ClusterNode {
  if (typeof node !== 'string') {
    return node
  }
  const [host, port] = node.split(':')
  return { host, port: port ? Number(port) : 6379 }
}

function toSentinelConfig(host: string | { host: string; port: number }) {
  if (typeof host !== 'string') {
    return host
  }
  const [hostname, port = '26379'] = host.split(':')
  return { host: hostname, port: Number(port) }
}

function resolveMode(explicit?: RedisMode): RedisMode {
  const envMode = (process.env[REDIS_MODE_ENV] as RedisMode | undefined)?.toLowerCase?.()
  const mode = explicit ?? envMode ?? 'standalone'
  if (mode !== 'standalone' && mode !== 'cluster' && mode !== 'sentinel') {
    return 'standalone'
  }
  return mode
}

function resolveUrl(explicit?: string): string {
  return explicit ?? process.env[REDIS_URL_ENV] ?? DEFAULT_REDIS_URL
}

export interface RedisClientFactoryResult {
  client: RedisClient
  keys: ReturnType<typeof createRedisKeyFactory>
}

export function createRedisClient(
  options: CreateRedisClientOptions = {},
): RedisClientFactoryResult {
  const mode = resolveMode(options.mode)
  const logger =
    options.logger ??
    pino({
      name: 'workflow-redis',
      level: process.env.LOG_LEVEL ?? 'info',
    })

  let client: RedisClient

  if (mode === 'cluster') {
    const nodes =
      options.cluster?.nodes ??
      process.env.KB_REDIS_CLUSTER_NODES?.split(',').filter(Boolean)
    if (!nodes || nodes.length === 0) {
      throw new Error(
        'Cluster mode selected but no nodes provided. Set KB_REDIS_CLUSTER_NODES or pass cluster.nodes.',
      )
    }
    client = new IORedis.Cluster(
      nodes.map(toClusterNode),
      options.cluster?.options,
    )
  } else if (mode === 'sentinel') {
    const sentinelHosts =
      options.sentinel?.hosts ??
      process.env.KB_REDIS_SENTINELS?.split(',').filter(Boolean)
    const name =
      options.sentinel?.name ?? process.env.KB_REDIS_SENTINEL_NAME ?? 'mymaster'

    if (!sentinelHosts || sentinelHosts.length === 0) {
      throw new Error(
        'Sentinel mode selected but no hosts provided. Set KB_REDIS_SENTINELS or pass sentinel.hosts.',
      )
    }

    const tlsOption = options.sentinel?.tls
    const tls: ConnectionOptions | undefined =
      tlsOption === true
        ? {}
        : tlsOption === false || tlsOption == null
          ? undefined
          : tlsOption

    const sentinelOptions: RedisOptions = {
      ...(options.redisOptions ?? {}),
      sentinels: sentinelHosts.map(toSentinelConfig),
      name,
      username:
        options.sentinel?.username ?? process.env.KB_REDIS_SENTINEL_USERNAME,
      password:
        options.sentinel?.password ?? process.env.KB_REDIS_SENTINEL_PASSWORD,
      db: options.sentinel?.db,
    }

    if (tls) {
      sentinelOptions.tls = tls
    }

    client = new IORedis(sentinelOptions)
  } else {
    const url = resolveUrl(options.url)
    client = options.redisOptions
      ? new IORedis(url, options.redisOptions)
      : new IORedis(url)
  }

  client.on('error', (error: unknown) => {
    const message =
      error instanceof Error ? error.message : error ? String(error) : ''
    logger.error('Redis connection error', { error: message })
  })

  client.on('reconnecting', () => {
    logger.warn('Redis reconnecting...')
  })

  client.on('connect', () => {
    logger.info('Redis connection established')
  })

  const namespace =
    options.namespace ?? process.env[REDIS_NAMESPACE_ENV] ?? 'kb'

  const keys = createRedisKeyFactory({ namespace })

  return { client, keys }
}


