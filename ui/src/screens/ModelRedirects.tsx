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
import { Tooltip } from "@astryxdesign/core/Tooltip"
import { useState } from "react"

import type {
  ModelRedirect,
  ModelRoutingSafety,
  RedirectSourceEffort,
  RedirectTargetEffort,
  RedirectTargetVerbosity,
} from "../lib/types"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  IconAction,
  MonoText,
  RowActions,
  TogglePill,
} from "../components/common"
import { ModelRoutingWarning } from "../components/ModelRoutingWarning"
import { Page } from "../components/Page"
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  PencilIcon,
  Trash2Icon,
} from "../icons"
import { del, get, patch, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface RedirectRow extends ModelRedirect, Record<string, unknown> {}

const TARGET_PRESERVE = "__preserve__"

const SOURCE_EFFORT_OPTIONS = [
  { value: "all", label: "All effort levels" },
  { value: "default", label: "Default (no effort)" },
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
]

const TARGET_EFFORT_OPTIONS = [
  { value: TARGET_PRESERVE, label: "Preserve effort" },
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
]

const TARGET_VERBOSITY_OPTIONS = [
  { value: TARGET_PRESERVE, label: "Preserve verbosity" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

function capitalizeWord(value: string): string {
  return value === "xhigh" ? "XHigh" : (
      value.charAt(0).toUpperCase() + value.slice(1)
    )
}

function sourceEffortBadgeLabel(effort: RedirectSourceEffort): string {
  if (effort === "all") return "all efforts"
  if (effort === "default") return "no effort"
  return capitalizeWord(effort)
}

function targetEffortBadgeLabel(
  effort: RedirectTargetEffort | null | undefined,
): string {
  return effort ? capitalizeWord(effort) : "preserve"
}

function targetVerbosityBadgeLabel(
  verbosity: RedirectTargetVerbosity | null | undefined,
): string {
  return verbosity ? capitalizeWord(verbosity) : "preserve"
}

interface RedirectFormState {
  name: string
  sourceModel: string
  sourceEffort: RedirectSourceEffort
  targetModel: string
  targetEffort: string
  targetVerbosity: string
}

const EMPTY_FORM: RedirectFormState = {
  name: "",
  sourceModel: "",
  sourceEffort: "all",
  targetModel: "",
  targetEffort: TARGET_PRESERVE,
  targetVerbosity: TARGET_PRESERVE,
}

function toRequestBody(form: RedirectFormState) {
  return {
    name: form.name.trim() || undefined,
    sourceModel: form.sourceModel.trim(),
    sourceEffort: form.sourceEffort,
    targetModel: form.targetModel.trim(),
    targetEffort:
      form.targetEffort === TARGET_PRESERVE ? null : form.targetEffort,
    targetVerbosity:
      form.targetVerbosity === TARGET_PRESERVE ? null : form.targetVerbosity,
  }
}

async function loadRedirects() {
  const [redirects, safety] = await Promise.all([
    get<Array<ModelRedirect>>("/dashboard/api/model-redirects"),
    get<ModelRoutingSafety>("/dashboard/api/model-routing-safety"),
  ])
  return { redirects, safety }
}

export default function ModelRedirectsScreen() {
  const toast = useToast()
  const { data, error, loading, reload } = useAsyncData(loadRedirects, [])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RedirectFormState>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)

  const redirects = data?.redirects ?? []

  function startEdit(row: ModelRedirect) {
    setEditingId(row.id)
    setForm({
      name: row.name ?? "",
      sourceModel: row.sourceModel,
      sourceEffort: row.sourceEffort,
      targetModel: row.targetModel,
      targetEffort: row.targetEffort ?? TARGET_PRESERVE,
      targetVerbosity: row.targetVerbosity ?? TARGET_PRESERVE,
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  async function saveForm() {
    if (!form.sourceModel.trim() || !form.targetModel.trim()) {
      toast.error("Source and target model are required")
      return
    }
    setIsSaving(true)
    try {
      const body = toRequestBody(form)
      if (editingId) {
        await patch(`/dashboard/api/model-redirects/${editingId}`, body)
        toast.success("Redirect updated")
      } else {
        await post("/dashboard/api/model-redirects", body)
        toast.success("Redirect created")
      }
      cancelEdit()
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to save redirect",
      )
    } finally {
      setIsSaving(false)
    }
  }

  async function move(id: string, direction: "up" | "down") {
    try {
      await post(`/dashboard/api/model-redirects/${id}/move`, { direction })
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to reorder redirect",
      )
    }
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      await patch(`/dashboard/api/model-redirects/${id}/toggle`, { enabled })
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to toggle redirect",
      )
      throw caught
    }
  }

  async function deleteRedirect(id: string) {
    try {
      await del(`/dashboard/api/model-redirects/${id}`)
      toast.success("Redirect deleted")
      if (editingId === id) cancelEdit()
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to delete redirect",
      )
    }
  }

  const columns: Array<TableColumn<RedirectRow>> = [
    {
      key: "order",
      header: "Order",
      width: pixel(84),
      renderCell: (item) => {
        const index = redirects.findIndex((r) => r.id === item.id)
        return (
          <HStack gap={0.5}>
            <IconAction
              label="Move up"
              icon={<ArrowUpIcon />}
              isDisabled={index <= 0}
              onClick={() => move(item.id, "up")}
            />
            <IconAction
              label="Move down"
              icon={<ArrowDownIcon />}
              isDisabled={index === -1 || index >= redirects.length - 1}
              onClick={() => move(item.id, "down")}
            />
          </HStack>
        )
      },
    },
    {
      key: "name",
      header: "Name",
      width: proportional(1),
      renderCell: (item) => (
        <Text color={item.name ? "primary" : "secondary"}>
          {item.name ?? "—"}
        </Text>
      ),
    },
    {
      key: "source",
      header: "Source",
      width: proportional(2),
      renderCell: (item) => (
        <HStack gap={2} vAlign="center">
          <MonoText>{item.sourceModel}</MonoText>
          <Badge
            variant="neutral"
            label={sourceEffortBadgeLabel(item.sourceEffort)}
          />
        </HStack>
      ),
    },
    {
      key: "target",
      header: "Target",
      width: proportional(2),
      renderCell: (item) => (
        <HStack gap={2} vAlign="center">
          <ArrowRightLeftIcon width={14} height={14} opacity={0.5} />
          <MonoText>{item.targetModel}</MonoText>
          <Badge
            variant="neutral"
            label={targetEffortBadgeLabel(item.targetEffort)}
          />
        </HStack>
      ),
    },
    {
      key: "verbosity",
      header: "Verbosity",
      width: pixel(104),
      renderCell: (item) => (
        <Badge
          variant="neutral"
          label={targetVerbosityBadgeLabel(item.targetVerbosity)}
        />
      ),
    },
    {
      key: "conflicts",
      header: "Conflicts",
      width: pixel(110),
      renderCell: (item) =>
        item.conflicts.length === 0 ?
          <Badge variant="success" label="clear" />
        : <Tooltip
            content={`Conflicts with: ${item.conflicts
              .map((c) => c.name ?? c.id)
              .join(", ")}`}
          >
            <Badge
              variant="error"
              icon={<AlertTriangleIcon width={14} height={14} />}
              label={`${item.conflicts.length} conflicts`}
            />
          </Tooltip>,
    },
    {
      key: "enabled",
      header: "Enabled",
      width: pixel(72),
      align: "center",
      renderCell: (item) => (
        <TogglePill
          label="Enabled"
          value={item.enabled}
          onChange={(value) => toggleEnabled(item.id, value)}
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
            label="Delete redirect"
            confirmTitle="Delete redirect?"
            confirmDescription={`This removes the redirect from ${item.sourceModel} to ${item.targetModel}.`}
            confirmActionLabel="Delete"
            variant="destructive"
            size="sm"
            icon={<Trash2Icon />}
            isIconOnly
            onConfirm={() => deleteRedirect(item.id)}
          />
        </RowActions>
      ),
    },
  ]

  return (
    <Page
      kicker="Control"
      title="Model Redirects"
      onRefresh={reload}
      isRefreshing={loading}
    >
      <ModelRoutingWarning safety={data?.safety} />
      <Text type="supporting" color="secondary">
        Silent — clients see the original model
      </Text>

      {error ?
        <Banner
          status="error"
          title="Failed to load model redirects"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={48} index={index} />
          ))}
        </VStack>
      : null}

      {data && redirects.length === 0 ?
        <EmptyState
          title="No model redirects"
          description="Add a redirect below to silently reroute requests to a different model."
        />
      : null}

      {redirects.length > 0 ?
        <DataTable
          data={redirects as unknown as Array<RedirectRow>}
          columns={columns}
          idKey="id"
        />
      : null}

      <Card>
        <VStack gap={4}>
          <Heading level={3}>
            {editingId ? "Edit redirect" : "Add redirect"}
          </Heading>
          <FormLayout>
            <TextInput
              label="Name"
              value={form.name}
              onChange={(value) => setForm((f) => ({ ...f, name: value }))}
              isOptional
            />
            <FormLayout direction="horizontal">
              <TextInput
                label="Source model"
                value={form.sourceModel}
                onChange={(value) =>
                  setForm((f) => ({ ...f, sourceModel: value }))
                }
                isRequired
              />
              <Selector
                label="Source effort"
                value={form.sourceEffort}
                onChange={(value) =>
                  setForm((f) => ({
                    ...f,
                    sourceEffort: value as RedirectSourceEffort,
                  }))
                }
                options={SOURCE_EFFORT_OPTIONS}
              />
            </FormLayout>
            <FormLayout direction="horizontal">
              <TextInput
                label="Target model"
                value={form.targetModel}
                onChange={(value) =>
                  setForm((f) => ({ ...f, targetModel: value }))
                }
                isRequired
              />
              <Selector
                label="Target effort"
                value={form.targetEffort}
                onChange={(value) =>
                  setForm((f) => ({ ...f, targetEffort: value }))
                }
                options={TARGET_EFFORT_OPTIONS}
              />
            </FormLayout>
            <Selector
              label="Target verbosity"
              value={form.targetVerbosity}
              onChange={(value) =>
                setForm((f) => ({ ...f, targetVerbosity: value }))
              }
              options={TARGET_VERBOSITY_OPTIONS}
            />
          </FormLayout>
          <HStack gap={2} hAlign="end">
            {editingId ?
              <Button label="Cancel" variant="ghost" onClick={cancelEdit} />
            : null}
            <Button
              label={editingId ? "Save changes" : "Add redirect"}
              variant="primary"
              isLoading={isSaving}
              clickAction={saveForm}
            />
          </HStack>
        </VStack>
      </Card>
    </Page>
  )
}
