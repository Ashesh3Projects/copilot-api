import type { StorageConfig } from "~/lib/storage/config"
import type { TursoStorageOptions } from "~/lib/storage/turso"
import type { Storage } from "~/lib/storage/types"

import { LocalSqliteStorage } from "~/lib/storage/local-sqlite"
import { TursoStorage } from "~/lib/storage/turso"

export function createStorage(
  config: StorageConfig,
  options?: TursoStorageOptions,
): Storage {
  if (config.kind === "sqlite") return new LocalSqliteStorage(config.path)
  return new TursoStorage(config, options)
}
