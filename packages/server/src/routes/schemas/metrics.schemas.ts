import { z } from '@hono/zod-openapi';

export const metricsQuerySchema = z.object({
  range: z.enum(['7', '30', '90', 'all']).optional(),
  account: z.string().optional(),
});

export const metricsResponseSchema = z
  .object({
    range: z.enum(['7', '30', '90', 'all']),
    account: z.string().nullable(),
    since: z.string().nullable(),
    today: z.string(),
    indexedFiles: z.number(),
    reparsedFiles: z.number(),
    accounts: z.array(z.string()),
    unpricedModels: z.array(z.string()),
    totals: z.object({
      tokens: z.number(),
      input: z.number(),
      output: z.number(),
      thinking: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      costUsd: z.number(),
      messages: z.number(),
      sessions: z.number(),
      turns: z.number(),
      cacheHitRatio: z.number(),
      webSearches: z.number(),
      webFetches: z.number(),
      workflowRuns: z.number(),
      gateStops: z.number(),
      queueWaits: z.number(),
    }),
    daily: z.array(
      z.object({
        day: z.string(),
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite5m: z.number(),
        cacheWrite1h: z.number(),
        costUsd: z.number(),
        sessions: z.number(),
        turns: z.number(),
        cacheHitRatio: z.number(),
      })
    ),
    byProject: z.array(
      z.object({
        project: z.string(),
        tokens: z.number(),
        costUsd: z.number(),
        sessions: z.number(),
      })
    ),
    byModel: z.array(
      z.object({ model: z.string(), tokens: z.number(), costUsd: z.number(), messages: z.number() })
    ),
    byAccount: z.array(
      z.object({
        account: z.string(),
        tokens: z.number(),
        costUsd: z.number(),
        sessions: z.number(),
      })
    ),
    byOrigin: z.array(z.object({ origin: z.string(), tokens: z.number(), sessions: z.number() })),
    bySidechain: z.array(z.object({ kind: z.string(), tokens: z.number(), messages: z.number() })),
    tools: z.array(z.object({ tool: z.string(), calls: z.number() })),
    workflows: z.object({
      runs: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          startedAt: z.string(),
          durationMs: z.number().nullable(),
          costUsd: z.number(),
          tokens: z.number(),
        })
      ),
      byStatus: z.array(z.object({ status: z.string(), count: z.number() })),
    }),
    gate: z.object({
      daily: z.array(z.object({ day: z.string(), verdict: z.string(), count: z.number() })),
      rules: z.array(z.object({ rule: z.string(), count: z.number() })),
    }),
    queue: z.object({
      daily: z.array(z.object({ day: z.string(), flag: z.string(), count: z.number() })),
      picks: z.number(),
      pickedAtHead: z.number(),
    }),
  })
  .openapi('MetricsResponse');
