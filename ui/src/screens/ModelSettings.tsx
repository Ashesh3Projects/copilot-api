import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { FormLayout } from "@astryxdesign/core/FormLayout"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton"
import { useState } from "react"

import type {
  ModelRequestParameter,
  ModelSetting,
  ReasoningEffort,
} from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  IconAction,
  MonoText,
  RowActions,
} from "../components/common"
import { Page } from "../components/Page"
import { PencilIcon, Trash2Icon } from "../icons"
import { del, get, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface SettingRow extends ModelSetting, Record<string, unknown> {}

type SettingEffort = ReasoningEffort
type TriState = "unset" | "true" | "false"

const EFFORT_OPTIONS: Array<SettingEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const OMIT_PARAM_OPTIONS: Array<ModelRequestParameter> = [
  "temperature",
  "top_p",
]

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "XHigh" : (
      effort.charAt(0).toUpperCase() + effort.slice(1)
    )
}

function toTriState(value: boolean | null | undefined): TriState {
  if (value === true) return "true"
  if (value === false) return "false"
  return "unset"
}

function fromTriState(value: TriState): boolean | null {
  if (value === "true") return true
  if (value === "false") return false
  return null
}

interface SettingFormState {
  model: string
  sentryModelName: string
  supportedReasoningEfforts: Array<SettingEffort>
  defaultReasoningEffort: SettingEffort | null
  implicitReasoningDefault: TriState
  exposeVirtualReasoningModels: TriState
  supportsAssistantPrefill: TriState
  unsupportedRequestParameters: Array<ModelRequestParameter>
}

const EMPTY_SETTING_FORM: SettingFormState = {
  model: "",
  sentryModelName: "",
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  implicitReasoningDefault: "unset",
  exposeVirtualReasoningModels: "unset",
  supportsAssistantPrefill: "unset",
  unsupportedRequestParameters: [],
}

function toSettingBody(form: SettingFormState) {
  return {
    model: form.model.trim(),
    sentryModelName: form.sentryModelName.trim() || null,
    supportedReasoningEfforts: form.supportedReasoningEfforts,
    defaultReasoningEffort: form.defaultReasoningEffort,
    implicitReasoningDefault: fromTriState(form.implicitReasoningDefault),
    exposeVirtualReasoningModels: fromTriState(
      form.exposeVirtualReasoningModels,
    ),
    supportsAssistantPrefill: fromTriState(form.supportsAssistantPrefill),
    unsupportedRequestParameters: form.unsupportedRequestParameters,
  }
}

function loadSettings(): Promise<Array<ModelSetting>> {
  return get<Array<ModelSetting>>("/dashboard/api/model-settings")
}

function BadgeList({
  items,
  variant = "neutral",
}: {
  items: Array<string>
  variant?: "neutral" | "info" | "warning"
}) {
  if (items.length === 0) return <Text color="secondary">—</Text>
  return (
    <HStack gap={1} wrap="wrap">
      {items.map((item) => (
        <Badge key={item} variant={variant} label={effortLabel(item)} />
      ))}
    </HStack>
  )
}

export default function ModelSettingsScreen() {
  const toast = useToast()
  const { data, error, loading, reload } = useAsyncData(loadSettings, [])

  const [editingModel, setEditingModel] = useState<string | null>(null)
  const [form, setForm] = useState<SettingFormState>(EMPTY_SETTING_FORM)
  const [isSaving, setIsSaving] = useState(false)

  const settings = data ?? []

  function startEdit(row: ModelSetting) {
    setEditingModel(row.model)
    setForm({
      model: row.model,
      sentryModelName: row.sentryModelName ?? "",
      supportedReasoningEfforts: row.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: row.defaultReasoningEffort ?? null,
      implicitReasoningDefault: toTriState(row.implicitReasoningDefault),
      exposeVirtualReasoningModels: toTriState(
        row.exposeVirtualReasoningModels,
      ),
      supportsAssistantPrefill: toTriState(row.supportsAssistantPrefill),
      unsupportedRequestParameters: row.unsupportedRequestParameters ?? [],
    })
  }

  function cancelEdit() {
    setEditingModel(null)
    setForm(EMPTY_SETTING_FORM)
  }

  async function saveSetting() {
    if (!form.model.trim()) {
      toast.error("Model ID is required")
      return
    }
    setIsSaving(true)
    try {
      await post("/dashboard/api/model-settings", toSettingBody(form))
      toast.success(
        editingModel ? "Model setting updated" : "Model setting created",
      )
      cancelEdit()
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ?
          caught.message
        : "Failed to save model setting",
      )
    } finally {
      setIsSaving(false)
    }
  }

  async function deleteSetting(model: string) {
    try {
      await del(`/dashboard/api/model-settings/${encodeURIComponent(model)}`)
      toast.success("Model setting deleted")
      if (editingModel === model) cancelEdit()
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ?
          caught.message
        : "Failed to delete model setting",
      )
    }
  }

  const columns: Array<TableColumn<SettingRow>> = [
    {
      key: "model",
      header: "Model",
      width: proportional(2),
      renderCell: (item) => (
        <VStack gap={0.5}>
          <MonoText>{item.model}</MonoText>
          {item.sentryModelName ?
            <Text type="supporting" color="secondary">
              Sentry: {item.sentryModelName}
            </Text>
          : null}
        </VStack>
      ),
    },
    {
      key: "reasoning",
      header: "Reasoning",
      width: proportional(2),
      renderCell: (item) => {
        const efforts = item.supportedReasoningEfforts ?? []
        if (efforts.length === 0 && !item.defaultReasoningEffort) {
          return <Text color="secondary">—</Text>
        }
        return (
          <HStack gap={1} wrap="wrap">
            {efforts.map((effort) => (
              <Badge
                key={effort}
                variant={
                  effort === item.defaultReasoningEffort ? "info" : "neutral"
                }
                label={
                  effort === item.defaultReasoningEffort ?
                    `${effortLabel(effort)} (default)`
                  : effortLabel(effort)
                }
              />
            ))}
            {item.implicitReasoningDefault === true ?
              <Badge variant="success" label="implicit" />
            : null}
          </HStack>
        )
      },
    },
    {
      key: "behavior",
      header: "Behavior",
      width: proportional(1),
      renderCell: (item) => {
        const badges = []
        if (item.exposeVirtualReasoningModels != null) {
          badges.push(
            <Badge
              key="virtual"
              variant={item.exposeVirtualReasoningModels ? "info" : "neutral"}
              label={
                item.exposeVirtualReasoningModels ? "Virtual: show" : (
                  "Virtual: hide"
                )
              }
            />,
          )
        }
        if (item.supportsAssistantPrefill != null) {
          badges.push(
            <Badge
              key="prefill"
              variant={item.supportsAssistantPrefill ? "success" : "error"}
              label={
                item.supportsAssistantPrefill ? "Prefill: yes" : "Prefill: no"
              }
            />,
          )
        }
        if (badges.length === 0) return <Text color="secondary">Default</Text>
        return (
          <HStack gap={1} wrap="wrap">
            {badges}
          </HStack>
        )
      },
    },
    {
      key: "unsupportedRequestParameters",
      header: "Omit Params",
      width: pixel(120),
      renderCell: (item) => (
        <BadgeList
          items={item.unsupportedRequestParameters ?? []}
          variant="warning"
        />
      ),
    },
    {
      key: "actions",
      header: "",
      width: pixel(88),
      align: "end",
      renderCell: (item) => (
        <RowActions>
          <IconAction
            label="Edit"
            icon={<PencilIcon />}
            onClick={() => startEdit(item)}
          />
          <ConfirmButton
            label="Delete model setting"
            confirmTitle="Delete model setting?"
            confirmDescription={`This removes the override for ${item.model}.`}
            confirmActionLabel="Delete"
            variant="destructive"
            size="sm"
            icon={<Trash2Icon />}
            isIconOnly
            onConfirm={() => deleteSetting(item.model)}
          />
        </RowActions>
      ),
    },
  ]

  return (
    <Page
      kicker="Control"
      title="Model Settings"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load model settings"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={4}>
          <Skeleton height={360} />
          <Skeleton height={360} />
        </VStack>
      : null}

      {data ?
        <VStack gap={4}>
          <Card>
            <VStack gap={4}>
              <Heading level={3}>
                {editingModel ? "Edit setting" : "Add setting"}
              </Heading>
              <FormLayout>
                <TextInput
                  label="Model ID"
                  value={form.model}
                  onChange={(value) => setForm((f) => ({ ...f, model: value }))}
                  isRequired
                  isDisabled={editingModel !== null}
                />
                <TextInput
                  label="Sentry reported name"
                  value={form.sentryModelName}
                  onChange={(value) =>
                    setForm((f) => ({ ...f, sentryModelName: value }))
                  }
                  isOptional
                />
                <VStack gap={1}>
                  <Text type="label" color="secondary">
                    Supported efforts
                  </Text>
                  <ToggleButtonGroup
                    type="multiple"
                    label="Supported efforts"
                    value={form.supportedReasoningEfforts}
                    onChange={(values) =>
                      setForm((f) => {
                        const next = values as Array<SettingEffort>
                        return {
                          ...f,
                          supportedReasoningEfforts: next,
                          defaultReasoningEffort:
                            (
                              f.defaultReasoningEffort
                              && next.includes(f.defaultReasoningEffort)
                            ) ?
                              f.defaultReasoningEffort
                            : null,
                        }
                      })
                    }
                  >
                    {EFFORT_OPTIONS.map((effort) => (
                      <ToggleButton
                        key={effort}
                        value={effort}
                        label={effortLabel(effort)}
                      />
                    ))}
                  </ToggleButtonGroup>
                </VStack>
                <Selector
                  label="Default effort"
                  value={form.defaultReasoningEffort}
                  onChange={(value) =>
                    setForm((f) => ({
                      ...f,
                      defaultReasoningEffort: value as SettingEffort | null,
                    }))
                  }
                  options={form.supportedReasoningEfforts.map((effort) => ({
                    value: effort,
                    label: effortLabel(effort),
                  }))}
                  placeholder="Not set"
                  hasClear
                  isDisabled={form.supportedReasoningEfforts.length === 0}
                />
                <Selector
                  label="Implicit default"
                  value={form.implicitReasoningDefault}
                  onChange={(value) =>
                    setForm((f) => ({
                      ...f,
                      implicitReasoningDefault: value as TriState,
                    }))
                  }
                  options={[
                    { value: "unset", label: "Not set" },
                    { value: "true", label: "Enabled" },
                    { value: "false", label: "Disabled" },
                  ]}
                />
                <Selector
                  label="Virtual variants"
                  value={form.exposeVirtualReasoningModels}
                  onChange={(value) =>
                    setForm((f) => ({
                      ...f,
                      exposeVirtualReasoningModels: value as TriState,
                    }))
                  }
                  options={[
                    { value: "unset", label: "Not set" },
                    { value: "true", label: "Show" },
                    { value: "false", label: "Hide" },
                  ]}
                />
                <Selector
                  label="Assistant prefill"
                  value={form.supportsAssistantPrefill}
                  onChange={(value) =>
                    setForm((f) => ({
                      ...f,
                      supportsAssistantPrefill: value as TriState,
                    }))
                  }
                  options={[
                    { value: "unset", label: "Not set" },
                    { value: "true", label: "Supported" },
                    { value: "false", label: "Unsupported" },
                  ]}
                />
                <VStack gap={1}>
                  <Text type="label" color="secondary">
                    Omit request params
                  </Text>
                  <ToggleButtonGroup
                    type="multiple"
                    label="Omit request params"
                    value={form.unsupportedRequestParameters}
                    onChange={(values) =>
                      setForm((f) => ({
                        ...f,
                        unsupportedRequestParameters:
                          values as Array<ModelRequestParameter>,
                      }))
                    }
                  >
                    {OMIT_PARAM_OPTIONS.map((param) => (
                      <ToggleButton key={param} value={param} label={param} />
                    ))}
                  </ToggleButtonGroup>
                </VStack>
              </FormLayout>
              <HStack gap={2} hAlign="end">
                {editingModel ?
                  <Button label="Cancel" variant="ghost" onClick={cancelEdit} />
                : null}
                <Button
                  label="Save setting"
                  variant="primary"
                  isLoading={isSaving}
                  clickAction={saveSetting}
                />
              </HStack>
            </VStack>
          </Card>

          <Card>
            <VStack gap={4}>
              <Heading level={3}>Configured models</Heading>
              {settings.length === 0 ?
                <EmptyState
                  title="No model settings"
                  description="Add a setting above to override behavior for a specific model."
                />
              : <DataTable
                  data={settings as unknown as Array<SettingRow>}
                  columns={columns}
                  idKey="model"
                />
              }
            </VStack>
          </Card>
        </VStack>
      : null}
    </Page>
  )
}
