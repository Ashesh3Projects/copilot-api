import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useRef, useState } from "react"

import type {
  ModelFallbackConfig,
  ModelFallbackRule,
  ModelFallbackSettings,
} from "../lib/types"

import {
  ConfirmButton,
  EmptyState,
  IconAction,
  RowActions,
} from "../components/common"
import { ModelRoutingWarning } from "../components/ModelRoutingWarning"
import { Page } from "../components/Page"
import { ResponsivePair } from "../components/ResponsivePair"
import { FallbackIcon, PencilIcon, Trash2Icon } from "../icons"
import { del, get, put } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface RuleForm {
  id: string | null
  sourceModel: string
  targetModel: string
}

const EMPTY_RULE: RuleForm = { id: null, sourceModel: "", targetModel: "" }

function loadFallbacks(): Promise<ModelFallbackSettings> {
  return get<ModelFallbackSettings>("/dashboard/api/fallbacks")
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function fieldError(message: string | undefined) {
  return message ? { type: "error" as const, message } : undefined
}

function FallbackControls({
  initial,
  onBusyChange,
}: {
  initial: ModelFallbackSettings
  onBusyChange: (busy: boolean) => void
}) {
  const toast = useToast()
  const [settings, setSettings] = useState(initial)
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE)
  const [ttl, setTtl] = useState(String(initial.config.affinityTtlSeconds))
  const [capacity, setCapacity] = useState(
    String(initial.config.affinityMaxEntries),
  )
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [ruleErrors, setRuleErrors] = useState<{
    sourceModel?: string
    targetModel?: string
  }>({})
  const [cacheErrors, setCacheErrors] = useState<{
    ttl?: string
    capacity?: string
  }>({})
  const sourceRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<HTMLInputElement>(null)
  const ttlRef = useRef<HTMLInputElement>(null)
  const capacityRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const config = settings.config

  function startMutation() {
    if (busyRef.current) return false
    busyRef.current = true
    setIsSaving(true)
    onBusyChange(true)
    setSaveError(undefined)
    return true
  }

  function finishMutation() {
    busyRef.current = false
    setIsSaving(false)
    onBusyChange(false)
  }

  async function save(next: ModelFallbackConfig, message: string) {
    if (!startMutation()) return false
    try {
      const result = await put<ModelFallbackSettings>(
        "/dashboard/api/fallbacks",
        next,
      )
      setSettings(result)
      toast.success(message)
      return true
    } catch (error) {
      const message = errorMessage(error, "Failed to save fallback settings")
      setSaveError(message)
      toast.error(message)
      return false
    } finally {
      finishMutation()
    }
  }

  function editRule(rule: ModelFallbackRule) {
    setForm({
      id: rule.id,
      sourceModel: rule.sourceModel,
      targetModel: rule.targetModel,
    })
    setRuleErrors({})
    sourceRef.current?.focus()
  }

  function cancelEdit() {
    setForm(EMPTY_RULE)
    setRuleErrors({})
  }

  async function saveRule() {
    const sourceModel = form.sourceModel.trim()
    const targetModel = form.targetModel.trim()
    const current = config.rules.find((rule) => rule.id === form.id)
    const duplicate = config.rules.some(
      (rule) =>
        rule.id !== form.id && rule.enabled && rule.sourceModel === sourceModel,
    )
    let sourceError: string | undefined
    let targetError: string | undefined
    if (!sourceModel) sourceError = "Enter the model that may return HTTP 422."
    else if (sourceModel.length > 256) {
      sourceError = "Use a model ID with at most 256 characters."
    } else if (duplicate && (current?.enabled ?? true)) {
      sourceError = "This source model already has an enabled fallback."
    }
    if (!targetModel) targetError = "Enter the alternate model."
    else if (targetModel.length > 256) {
      targetError = "Use a model ID with at most 256 characters."
    } else if (sourceModel === targetModel) {
      targetError = "Choose a different model for the fallback."
    }
    setRuleErrors({ sourceModel: sourceError, targetModel: targetError })
    if (sourceError || targetError) {
      if (sourceError) sourceRef.current?.focus()
      else targetRef.current?.focus()
      return
    }

    const rule: ModelFallbackRule = {
      id: form.id ?? `fallback-${crypto.randomUUID()}`,
      sourceModel,
      targetModel,
      enabled: current?.enabled ?? true,
    }
    const rules =
      form.id ?
        config.rules.map((existing) =>
          existing.id === form.id ? rule : existing,
        )
      : [...config.rules, rule]
    if (
      await save(
        { ...config, rules },
        form.id ? "Fallback updated" : "Fallback added",
      )
    ) {
      cancelEdit()
    }
  }

  async function deleteRule(id: string) {
    const success = await save(
      { ...config, rules: config.rules.filter((rule) => rule.id !== id) },
      "Fallback deleted",
    )
    if (!success) throw new Error("Failed to delete fallback")
    if (form.id === id) cancelEdit()
  }

  async function saveCacheLimits() {
    const seconds = Number(ttl)
    const entries = Number(capacity)
    const ttlError =
      !Number.isInteger(seconds) || seconds < 60 || seconds > 604800 ?
        "Enter a whole number from 60 to 604800 seconds."
      : undefined
    const capacityError =
      !Number.isInteger(entries) || entries < 1 || entries > 100000 ?
        "Enter a whole number from 1 to 100000 entries."
      : undefined
    setCacheErrors({ ttl: ttlError, capacity: capacityError })
    if (ttlError || capacityError) {
      if (ttlError) ttlRef.current?.focus()
      else capacityRef.current?.focus()
      return
    }
    await save(
      { ...config, affinityTtlSeconds: seconds, affinityMaxEntries: entries },
      "Cache limits saved",
    )
  }

  async function clearCache() {
    if (!startMutation()) return
    try {
      const result = await del<{ success: boolean; cleared: number }>(
        "/dashboard/api/fallbacks/cache",
      )
      setSettings((current) => ({ ...current, cache: { entries: 0 } }))
      toast.success(`Cleared ${result.cleared} conversation entries`)
    } catch (error) {
      setSaveError(errorMessage(error, "Failed to clear conversation cache"))
      throw error
    } finally {
      finishMutation()
    }
  }

  return (
    <>
      <ModelRoutingWarning safety={settings.safety} />
      {saveError ?
        <Banner
          status="error"
          title="Changes were not saved"
          description={saveError}
        />
      : null}

      <Card>
        <VStack gap={4}>
          <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
            <VStack gap={1}>
              <Heading level={2}>Automatic fallback</Heading>
              <Text color="secondary">
                Follow configured alternates when each model returns HTTP 422.
              </Text>
            </VStack>
            <Badge label="HTTP 422 only" variant="neutral" />
          </HStack>
          <Switch
            label="Enable fallbacks"
            value={config.enabled}
            isDisabled={isSaving}
            changeAction={async (enabled) => {
              await save(
                { ...config, enabled },
                enabled ? "Fallbacks enabled" : "Fallbacks disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Rules match each model after Model Redirects. Fallback targets also
            follow Model Redirects. Each request can follow up to 3 fallback
            hops (4 model attempts).
          </Text>
          <VStack gap={1}>
            <Text type="code">A → B → C → D</Text>
            <Text type="supporting" color="secondary">
              Add one rule per arrow. Each hop requires HTTP 422. The chain
              stops at the first success, any other error, a model without an
              enabled fallback, or the 3-hop limit. A loop in either feature
              pauses all redirects and fallbacks until its rules are corrected.
            </Text>
          </VStack>
          <Switch
            label="Include diagnostic response headers"
            value={config.notifyClient}
            isDisabled={isSaving}
            changeAction={async (notifyClient) => {
              await save(
                { ...config, notifyClient },
                notifyClient ?
                  "Diagnostic headers enabled"
                : "Diagnostic headers disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Adds fallback source, target, and trigger headers for compatible
            clients and debugging. Codex Desktop and Claude Code do not
            currently offer a generic fallback notice.
          </Text>
          <Switch
            label="Show native client fallback notice"
            value={config.nativeClientNotice}
            isDisabled={isSaving}
            changeAction={async (nativeClientNotice) => {
              await save(
                { ...config, nativeClientNotice },
                nativeClientNotice ?
                  "Native client notice enabled"
                : "Native client notice disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Codex may describe this as cybersecurity routing; Claude Code may
            describe it as refusal fallback. Availability depends on client
            support. Claude Code must advertise its server fallback capability.
          </Text>
        </VStack>
      </Card>

      <Card>
        <VStack gap={4}>
          <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
            <Heading level={2}>Conversation affinity</Heading>
            <Text
              type="supporting"
              color="secondary"
              role="status"
              aria-live="polite"
            >
              {settings.cache.entries.toLocaleString()} cached conversations
            </Text>
          </HStack>
          <Switch
            label="Keep using the fallback for the same conversation"
            value={config.conversationAffinity}
            isDisabled={isSaving}
            changeAction={async (conversationAffinity) => {
              await save(
                { ...config, conversationAffinity },
                conversationAffinity ?
                  "Conversation affinity enabled"
                : "Conversation affinity disabled",
              )
            }}
          />
          <Text type="supporting" color="secondary">
            Reuse the final successful model for later requests with a
            recognized conversation ID. If it returns HTTP 422, its own fallback
            rules can continue the chain. Entries stay in memory and are removed
            when the server restarts. If full history is resent, only known old
            thinking blocks are removed; new fallback thinking is preserved.
          </Text>
          <ResponsivePair minWidth={260}>
            <TextInput
              ref={ttlRef}
              label="Cache lifetime (seconds)"
              description="60 to 604800 seconds. Default: 86400 (24 hours)."
              value={ttl}
              onChange={setTtl}
              isDisabled={isSaving}
              status={fieldError(cacheErrors.ttl)}
            />
            <TextInput
              ref={capacityRef}
              label="Maximum cached conversations"
              description="1 to 100000 entries. Default: 10000."
              value={capacity}
              onChange={setCapacity}
              isDisabled={isSaving}
              status={fieldError(cacheErrors.capacity)}
            />
          </ResponsivePair>
          <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
            <ConfirmButton
              label="Clear conversation cache"
              confirmTitle="Clear conversation cache?"
              confirmDescription="The next request in each conversation will try its source model again."
              confirmActionLabel="Clear cache"
              variant="secondary"
              isDisabled={isSaving || settings.cache.entries === 0}
              onConfirm={clearCache}
            />
            <Button
              label="Save cache limits"
              variant="secondary"
              isDisabled={isSaving}
              clickAction={saveCacheLimits}
            />
          </HStack>
        </VStack>
      </Card>

      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <Heading level={2}>Fallback rules</Heading>
          <Badge variant="neutral" label={`${config.rules.length} rules`} />
        </HStack>
        {!config.enabled && config.rules.length > 0 ?
          <Banner
            status="info"
            title="Fallbacks are disabled"
            description="Your rules are saved. Turn on Enable fallbacks to use them."
          />
        : null}
        {config.rules.length === 0 ?
          <EmptyState
            title="No fallback rules"
            description="Add a source model and the alternate to try when it returns HTTP 422."
            icon={<FallbackIcon width={28} height={28} />}
          />
        : null}
        {config.rules.map((rule) => (
          <Card key={rule.id}>
            <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
              <VStack gap={1}>
                <Text type="code" style={{ overflowWrap: "anywhere" }}>
                  {rule.sourceModel}
                </Text>
                <Text
                  type="supporting"
                  color="secondary"
                  style={{ overflowWrap: "anywhere" }}
                >
                  On HTTP 422 → {rule.targetModel}
                </Text>
              </VStack>
              <HStack gap={3} vAlign="center" wrap="wrap">
                <Switch
                  label={`Enable fallback for ${rule.sourceModel}`}
                  isLabelHidden
                  value={rule.enabled}
                  isDisabled={isSaving}
                  changeAction={async (enabled) => {
                    await save(
                      {
                        ...config,
                        rules: config.rules.map((current) =>
                          current.id === rule.id ?
                            { ...current, enabled }
                          : current,
                        ),
                      },
                      enabled ?
                        "Fallback rule enabled"
                      : "Fallback rule disabled",
                    )
                  }}
                />
                <RowActions>
                  <IconAction
                    label={`Edit fallback for ${rule.sourceModel}`}
                    icon={<PencilIcon />}
                    isDisabled={isSaving}
                    onClick={() => editRule(rule)}
                  />
                  <ConfirmButton
                    label={`Delete fallback for ${rule.sourceModel}`}
                    confirmTitle="Delete fallback rule?"
                    confirmDescription={`Remove the fallback from ${rule.sourceModel} to ${rule.targetModel}.`}
                    confirmActionLabel="Delete"
                    size="sm"
                    icon={<Trash2Icon />}
                    isIconOnly
                    isDisabled={isSaving}
                    onConfirm={() => deleteRule(rule.id)}
                  />
                </RowActions>
              </HStack>
            </HStack>
          </Card>
        ))}
      </VStack>

      <Card>
        <VStack gap={4}>
          <Heading level={2}>
            {form.id ? "Edit fallback" : "Add fallback"}
          </Heading>
          <FormLayout>
            <ResponsivePair minWidth={260}>
              <TextInput
                ref={sourceRef}
                label="Source model"
                description="Exact model ID after redirects."
                value={form.sourceModel}
                onChange={(sourceModel) =>
                  setForm((current) => ({ ...current, sourceModel }))
                }
                isRequired
                isDisabled={isSaving}
                status={fieldError(ruleErrors.sourceModel)}
              />
              <TextInput
                ref={targetRef}
                label="Alternate model"
                description="The model to try after HTTP 422."
                value={form.targetModel}
                onChange={(targetModel) =>
                  setForm((current) => ({ ...current, targetModel }))
                }
                isRequired
                isDisabled={isSaving}
                status={fieldError(ruleErrors.targetModel)}
              />
            </ResponsivePair>
          </FormLayout>
          <HStack hAlign="end" gap={2}>
            {form.id ?
              <Button
                label="Cancel"
                variant="ghost"
                isDisabled={isSaving}
                onClick={cancelEdit}
              />
            : null}
            <Button
              label={form.id ? "Save fallback" : "Add fallback"}
              variant="primary"
              isDisabled={isSaving}
              clickAction={saveRule}
            />
          </HStack>
        </VStack>
      </Card>
    </>
  )
}

export default function FallbacksScreen() {
  const { data, error, loading, reload } = useAsyncData(loadFallbacks, [])
  const [saving, setSaving] = useState(false)
  return (
    <Page
      kicker="Control"
      title="Fallbacks"
      onRefresh={reload}
      isRefreshing={loading || saving}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load fallbacks"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}
      {!data && loading ?
        <Skeleton height={220} />
      : null}
      {data ?
        <FallbackControls
          key={JSON.stringify(data)}
          initial={data}
          onBusyChange={setSaving}
        />
      : null}
    </Page>
  )
}
