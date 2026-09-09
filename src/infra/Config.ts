import { readFile } from 'node:fs/promises'

import { z } from 'zod'

const taskFlagsSchema = z.object({
  dailySet: z.boolean(),
  specialPromotions: z.boolean().default(true),
  morePromotions: z.boolean(),
  appActivities: z.boolean(),
  appCheckIn: z.boolean(),
  readToEarn: z.boolean(),
  pcSearch: z.boolean(),
  mobileSearch: z.boolean(),
  punchCards: z.boolean(),
  claimBonusPoints: z.boolean()
})

export const applicationConfigSchema = z.object({
  locale: z.literal('zh-CN'),
  market: z.literal('CN'),
  timezone: z.string().min(1),
  tasks: taskFlagsSchema,
  search: z
    .object({
      delayMinSeconds: z.number().int().min(5).max(300),
      delayMaxSeconds: z.number().int().min(5).max(300),
      scroll: z.boolean(),
      clickResult: z.boolean(),
      resultVisitSeconds: z.number().int().min(1).max(120).default(8)
    })
    .refine((value) => value.delayMaxSeconds >= value.delayMinSeconds, {
      message: 'delayMaxSeconds must be greater than or equal to delayMinSeconds'
    }),
  retention: z.object({
    logsDays: z.number().int().min(1).max(365),
    diagnosticsHours: z.number().int().min(1).max(168),
    dailyBackups: z.number().int().min(1).max(31),
    weeklyBackups: z.number().int().min(1).max(52)
  })
})

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>

export const DEFAULT_CONFIG: ApplicationConfig = applicationConfigSchema.parse({
  locale: 'zh-CN',
  market: 'CN',
  timezone: 'Asia/Shanghai',
  tasks: {
    dailySet: true,
    specialPromotions: true,
    morePromotions: true,
    appActivities: true,
    appCheckIn: true,
    readToEarn: true,
    pcSearch: true,
    mobileSearch: false,
    punchCards: true,
    claimBonusPoints: true
  },
  search: {
    delayMinSeconds: 30,
    delayMaxSeconds: 60,
    scroll: true,
    clickResult: false,
    resultVisitSeconds: 8
  },
  retention: { logsDays: 30, diagnosticsHours: 24, dailyBackups: 7, weeklyBackups: 4 }
})

export async function loadConfig(path: string): Promise<ApplicationConfig> {
  const raw = await readFile(path, 'utf8')
  return applicationConfigSchema.parse(JSON.parse(raw) as unknown)
}

export async function loadConfigOrDefault(path: string): Promise<ApplicationConfig> {
  try {
    return await loadConfig(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG
    throw error
  }
}
