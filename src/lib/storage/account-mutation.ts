import { createHash } from "node:crypto"

import type { MutationContext } from "~/lib/storage/types"

import { StorageConflictError } from "~/lib/storage/errors"

/** Deterministic JSON for actual repository arguments; no plaintext enters markers. */
export function accountMutationDigest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.entries(item).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        }
        return item
      }),
    )
    .digest("hex")
}

export function bindAccountMutation(
  context: MutationContext,
  operation: string,
  input: unknown,
): MutationContext {
  if (!context.kind || !context.inputDigest)
    throw new StorageConflictError("Account mutation identity is required")
  return {
    ...context,
    kind: operation,
    inputDigest: accountMutationDigest({
      requestKind: context.kind,
      requestDigest: context.inputDigest,
      input,
    }),
  }
}
