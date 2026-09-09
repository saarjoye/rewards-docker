export interface BackupRetention {
  daily: number
  weekly: number
}

export interface BackupDescriptor {
  path: string
  createdAt: string
  cadence: 'daily' | 'weekly'
}

export function selectBackupsToKeep(
  backups: readonly BackupDescriptor[],
  retention: BackupRetention
): Set<string> {
  const keep = new Set<string>()
  for (const cadence of ['daily', 'weekly'] as const) {
    const limit = cadence === 'daily' ? retention.daily : retention.weekly
    backups
      .filter((backup) => backup.cadence === cadence)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit)
      .forEach((backup) => keep.add(backup.path))
  }
  return keep
}
