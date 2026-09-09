import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { useEffect, useState } from "react"

import { CopyIcon, EyeIcon, EyeOffIcon } from "../icons"
import { post } from "../lib/api"
import { createSecretRequestGuard } from "../lib/secret-request-guard"
import { useToast } from "../lib/toast"
import { IconAction } from "./common"

export function SecretValue({
  label,
  maskedValue,
  revealPath,
  actions,
}: {
  label: string
  maskedValue: string
  revealPath: string
  actions?: ReactNode
}) {
  const [raw, setRaw] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [guard] = useState(createSecretRequestGuard)
  const toast = useToast()
  useEffect(() => () => guard.invalidate(), [guard])

  function hide() {
    guard.invalidate()
    setRaw(undefined)
    setLoading(false)
  }

  async function loadValue(): Promise<string> {
    const result = await post<{ credential: string }>(revealPath)
    if (typeof result.credential !== "string" || !result.credential)
      throw new Error("The key could not be revealed")
    return result.credential
  }

  async function reveal() {
    if (raw !== undefined || loading) {
      hide()
      return
    }
    const isCurrent = guard.begin()
    setLoading(true)
    try {
      const value = await loadValue()
      if (isCurrent()) setRaw(value)
    } catch (error) {
      if (isCurrent())
        toast.error(
          error instanceof Error ? error.message : "Could not reveal key",
        )
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  async function copy() {
    const isCurrent = guard.begin()
    setLoading(true)
    try {
      const value = raw ?? (await loadValue())
      if (!isCurrent()) return
      await navigator.clipboard.writeText(value)
      if (isCurrent()) toast.success("Key copied")
    } catch {
      if (isCurrent()) toast.error("Could not copy the key")
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }

  return (
    <VStack gap={1} style={{ minWidth: 0, flex: 1 }}>
      <Text weight="medium">{label}</Text>
      <HStack gap={2} vAlign="center">
        <Text type="code" style={{ overflowWrap: "anywhere", flex: 1 }}>
          {raw ?? maskedValue}
        </Text>
        <IconAction
          label={`${raw !== undefined || loading ? "Hide" : "Reveal"} ${label}`}
          icon={raw !== undefined || loading ? <EyeOffIcon /> : <EyeIcon />}
          onClick={reveal}
        />
        <IconAction
          label={`Copy ${label}`}
          icon={<CopyIcon />}
          isDisabled={loading}
          onClick={copy}
        />
        {actions}
      </HStack>
    </VStack>
  )
}
import type { ReactNode } from "react"
