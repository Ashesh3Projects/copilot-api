import type { StatusDotProps } from "@astryxdesign/core/StatusDot"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { Collapsible } from "@astryxdesign/core/Collapsible"
import { IconButton } from "@astryxdesign/core/IconButton"
import { List, ListItem } from "@astryxdesign/core/List"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Switch } from "@astryxdesign/core/Switch"
import {
  pixel,
  proportional,
  Table,
  useTableSortable,
  useTableSortableState,
} from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useMemo, useState } from "react"

import type { LlmDebugDetail, LlmDebugEntry } from "../lib/types"

import {
  ConfirmButton,
  EmptyState,
  IconAction,
  MonoText,
  RelTime,
} from "../components/common"
import { JsonTreeViewer } from "../components/JsonTreeViewer"
import {
  LlmFallbackBadge,
  LlmFallbackBanner,
} from "../components/LlmFallbackIndicator"
import { Page } from "../components/Page"
import { RequestExportMenu } from "../components/RequestExportMenu"
import { ResponseInspector } from "../components/ResponseInspector"
import { ResponsivePair } from "../components/ResponsivePair"
import { VirtualizedCodeViewer } from "../components/VirtualizedCodeViewer"
import {
  BugIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  PlayIcon,
  SearchIcon,
  Trash2Icon,
} from "../icons"
import { ApiError, del, get } from "../lib/api"
import {
  canEditReplayCapture,
  canReplayCapture,
  captureOmissionMessage,
} from "../lib/capture-state"
import { formatDuration } from "../lib/duration-format"
import { parseJsonBody } from "../lib/json-tree"
import { requestPayloadView } from "../lib/llm-debug-detail-view"
import { navigate, useHashRoute } from "../lib/router"
import { useToast } from "../lib/toast"
import { useAsyncData, usePolling } from "../lib/usePolling"

const POLL_INTERVAL_MS = 10_000

// The real /api/llm-debug endpoint wraps the entries in a small envelope
// rather than returning a bare array (verified against
// src/lib/llm-debug-log.ts#listLlmDebugLogs). Not exported from lib/types.ts,
// so it's declared locally here.
interface LlmDebugListResponse {
  count: number
  entries: Array<LlmDebugEntry>
  cursor: string | null
  generatedAt: string
}

type DebugRow = LlmDebugEntry & Record<string, unknown>

type StatusFilter = "all" | LlmDebugEntry["status"]

function loadEntries(cursor?: string): Promise<LlmDebugListResponse> {
  return get<LlmDebugListResponse>(
    "/dashboard/api/llm-debug?limit=100"
      + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
  )
}

function loadDetail(id: string): Promise<LlmDebugDetail> {
  return get<LlmDebugDetail>(`/dashboard/api/llm-debug/${id}`)
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function totalBytes(entry: LlmDebugEntry): number {
  return entry.requestBodyBytes + (entry.responseBodyBytes ?? 0)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function statusDotVariant(
  status: LlmDebugEntry["status"],
): StatusDotProps["variant"] {
  if (status === "complete") return "success"
  if (status === "error") return "error"
  if (status === "aborted" || status === "interrupted") return "warning"
  return "accent"
}

function statusTextStyle(
  status: LlmDebugEntry["status"],
): React.CSSProperties | undefined {
  if (status === "error") return { color: "var(--color-error)" }
  if (status === "aborted" || status === "interrupted")
    return { color: "var(--color-warning)" }
  return undefined
}

function missingResponseText(status: LlmDebugEntry["status"]): string {
  if (status === "pending") return "Awaiting response…"
  if (status === "aborted" || status === "interrupted") {
    return "The request was aborted before the response completed."
  }
  return "No response was received."
}

export default function LlmDebugScreen() {
  const { param } = useHashRoute()

  return param ? <LlmDebugDetailView id={param} /> : <LlmDebugListView />
}

function LlmDebugListView() {
  const [cursor, setCursor] = useState<string>()
  const { data, error, loading, reload, reloadSilently } = useAsyncData(
    () => loadEntries(cursor),
    [cursor],
  )

  usePolling(
    () => {
      if (!cursor) reloadSilently()
    },
    POLL_INTERVAL_MS,
    [cursor],
  )

  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [isExporting, setIsExporting] = useState(false)

  const entries = useMemo(() => data?.entries ?? [], [data])

  const filtered = useMemo<Array<DebugRow>>(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (statusFilter !== "all" && entry.status !== statusFilter) return false
      if (!needle) return true
      const haystack =
        `${entry.method} ${entry.path} ${entry.model ?? ""} ${entry.requestId ?? ""} ${entry.fallback ? `fallback ${entry.fallback.sourceModel} ${entry.fallback.fromModel} ${entry.fallback.targetModel}` : ""}`.toLowerCase()
      return haystack.includes(needle)
    }) as Array<DebugRow>
  }, [entries, query, statusFilter])

  const { sortedData, sortConfig } = useTableSortableState<DebugRow>({
    data: filtered,
    defaultSort: [{ sortKey: "startedAt", direction: "descending" }],
    comparators: {
      startedAt: (a, b) =>
        new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      size: (a, b) => totalBytes(a) - totalBytes(b),
    },
  })
  const sortPlugin = useTableSortable<DebugRow>(sortConfig)

  function refreshLatest() {
    setCursor(undefined)
    reload()
  }

  async function handleClearAll() {
    await del("/dashboard/api/llm-debug")
    refreshLatest()
  }

  async function handleExport() {
    setIsExporting(true)
    try {
      const details = await Promise.all(
        entries.map((entry) => loadDetail(entry.id).catch(() => null)),
      )
      const full = details.filter(
        (detail): detail is LlmDebugDetail => detail !== null,
      )
      const blob = new Blob([JSON.stringify(full, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `llm-debug-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } finally {
      setIsExporting(false)
    }
  }

  const columns: Array<TableColumn<DebugRow>> = [
    {
      key: "status",
      header: "Status",
      width: pixel(128),
      sortable: true,
      renderCell: (row) => (
        <HStack gap={2} vAlign="center">
          <StatusDot
            variant={statusDotVariant(row.status)}
            label={row.status}
            isPulsing={row.status === "pending"}
          />
          <Text type="supporting" style={statusTextStyle(row.status)}>
            {capitalize(row.status)}
          </Text>
        </HStack>
      ),
    },
    {
      key: "path",
      header: "Endpoint",
      width: proportional(2, { minWidth: 220 }),
      sortable: true,
      renderCell: (row) => (
        <MonoText>
          {row.method} {row.path}
        </MonoText>
      ),
    },
    {
      key: "model",
      header: "Model",
      width: proportional(1, { minWidth: 120 }),
      sortable: true,
      renderCell: (row) => (
        <VStack gap={1}>
          {row.model ?
            <MonoText>{row.model}</MonoText>
          : <Text type="supporting" color="secondary">
              —
            </Text>
          }
          {row.fallback ?
            <LlmFallbackBadge fallback={row.fallback} />
          : null}
        </VStack>
      ),
    },
    {
      key: "size",
      header: "Req / Resp",
      width: pixel(120),
      align: "end",
      sortable: { sortKey: "size" },
      renderCell: (row) => (
        <Text type="supporting" color="secondary">
          {fmtBytes(row.requestBodyBytes)} / {fmtBytes(row.responseBodyBytes)}
        </Text>
      ),
    },
    {
      key: "durationMs",
      header: "Duration",
      width: pixel(96),
      align: "end",
      sortable: true,
      renderCell: (row) =>
        row.durationMs === undefined ?
          <Text type="supporting" color="secondary">
            —
          </Text>
        : <Text type="supporting" color="secondary">
            {formatDuration(row.durationMs)}
          </Text>,
    },
    {
      key: "startedAt",
      header: "Time",
      width: pixel(116),
      align: "end",
      sortable: true,
      renderCell: (row) => <RelTime ts={row.startedAt} />,
    },
    {
      key: "actions",
      header: "",
      width: pixel(48),
      align: "end",
      renderCell: (row) => (
        <IconAction
          label="Inspect request"
          icon={<ChevronRightIcon />}
          onClick={() => navigate("llm-debug", row.id)}
        />
      ),
    },
  ]

  return (
    <Page
      kicker="Monitor"
      title="LLM Debug"
      onRefresh={refreshLatest}
      isRefreshing={loading}
      actions={
        entries.length > 0 ?
          <HStack gap={2}>
            <Button
              label="Export this page"
              variant="secondary"
              icon={<DownloadIcon />}
              isLoading={isExporting}
              onClick={handleExport}
            />
            <ConfirmButton
              label="Clear All"
              confirmTitle="Clear all debug logs?"
              confirmDescription="This clears every captured LLM debug entry from memory. This cannot be undone."
              confirmActionLabel="Clear All"
              icon={<Trash2Icon />}
              onConfirm={handleClearAll}
            />
          </HStack>
        : undefined
      }
    >
      <Text type="supporting" color="secondary">
        Captures stay in server memory for 10 minutes after successful requests
        start and 1 hour for all other requests. Restarting the server clears
        them. Older captures may be removed earlier when memory is full.
      </Text>
      {error ?
        <Banner
          status="error"
          title="Failed to load debug logs"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={56} index={index} />
          ))}
        </VStack>
      : null}

      <HStack gap={2}>
        {data?.cursor ?
          <Button
            label="Older captures"
            variant="secondary"
            onClick={() => setCursor(data.cursor ?? undefined)}
          />
        : null}
      </HStack>
      {data && entries.length === 0 ?
        <EmptyState
          icon={<BugIcon />}
          title="No debug logs yet"
          description="LLM requests and responses will appear here as they are captured."
        />
      : null}

      {entries.length > 0 ?
        <VStack gap={3}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <TextInput
                label="Search debug logs"
                isLabelHidden
                placeholder="Search method, path, or model…"
                value={query}
                onChange={setQuery}
              />
            </StackItem>
            <SegmentedControl
              label="Filter by status"
              size="sm"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <SegmentedControlItem value="all" label="All" />
              <SegmentedControlItem value="error" label="Errors" />
              <SegmentedControlItem value="aborted" label="Aborted" />
              <SegmentedControlItem value="interrupted" label="Interrupted" />
              <SegmentedControlItem value="pending" label="Pending" />
              <SegmentedControlItem value="complete" label="Complete" />
            </SegmentedControl>
          </HStack>

          <HStack hAlign="between" vAlign="center">
            <Text type="supporting" color="secondary">
              {filtered.length === entries.length ?
                `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
              : `${filtered.length} of ${entries.length} entries`}
            </Text>
          </HStack>

          {filtered.length === 0 ?
            <EmptyState
              icon={<SearchIcon />}
              title="No matching logs"
              description="No debug logs match your search and filter. Try broadening them."
              actions={
                <Button
                  label="Clear filters"
                  variant="secondary"
                  onClick={() => {
                    setQuery("")
                    setStatusFilter("all")
                  }}
                />
              }
            />
          : <Table
              data={sortedData}
              columns={columns}
              idKey="id"
              density="compact"
              textOverflow="truncate"
              dividers="rows"
              hasHover
              plugins={{ sort: sortPlugin }}
            />
          }
        </VStack>
      : null}
    </Page>
  )
}

function HeaderList({
  headers,
  onCopy,
}: {
  headers: Record<string, string>
  onCopy: (value: string) => void
}) {
  const entries = Object.entries(headers)

  if (entries.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        No headers
      </Text>
    )
  }

  return (
    <List hasDividers density="compact">
      {entries.map(([key, value]) => (
        <ListItem
          key={key}
          label={key}
          description={value}
          endContent={
            <IconButton
              label={`Copy ${key}`}
              tooltip="Copy value"
              icon={<CopyIcon />}
              variant="ghost"
              size="sm"
              onClick={() => onCopy(value)}
            />
          }
        />
      ))}
    </List>
  )
}

function PayloadBlock({
  body,
  emptyText,
  label,
  onCopyError,
  onCopySuccess,
  viewMode,
  wrap,
}: {
  body: string | null
  emptyText: string
  label: string
  onCopyError: (message: string) => void
  onCopySuccess: () => void
  viewMode: "pretty" | "raw"
  wrap: boolean
}) {
  const parsed = useMemo(() => (body ? parseJsonBody(body) : null), [body])
  const payload = requestPayloadView(body, parsed, viewMode)

  if (payload.kind === "empty") {
    return (
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {label}
        </Text>
        <Text type="supporting" color="secondary">
          {emptyText}
        </Text>
      </VStack>
    )
  }

  const content: React.ReactNode =
    payload.kind === "tree" ?
      <JsonTreeViewer
        key={`${label}:${body}`}
        formatted={payload.formatted}
        label={label}
        value={payload.value}
        wrap={wrap}
        onCopy={onCopySuccess}
        onCopyError={onCopyError}
      />
    : <VirtualizedCodeViewer
        label={label}
        language={payload.language}
        value={payload.value}
        wrap={wrap}
        onCopyError={onCopyError}
        onCopySuccess={onCopySuccess}
      />

  return (
    <Collapsible defaultIsOpen trigger={label}>
      {content}
    </Collapsible>
  )
}

function LlmDebugDetailView({ id }: { id: string }) {
  const { data, error, loading, reload, reloadSilently } = useAsyncData(
    () => loadDetail(id),
    [id],
  )
  const toast = useToast()
  const [requestViewMode, setRequestViewMode] = useState<"pretty" | "raw">(
    "pretty",
  )
  const [wrap, setWrap] = useState(false)

  usePolling(
    () => {
      if (data?.status === "pending") reloadSilently()
    },
    POLL_INTERVAL_MS,
    [data?.status],
  )

  function copy(text: string) {
    void navigator.clipboard.writeText(text)
    toast.success("Copied")
  }

  const showReplay = data ? canEditReplayCapture(data) : false
  const captureWarning =
    data ?
      (captureOmissionMessage(data.request, data.status)
      ?? (data.response ?
        captureOmissionMessage(data.response, data.status)
      : undefined))
    : undefined
  const notFound = error instanceof ApiError && error.status === 404

  return (
    <Page
      kicker="Monitor"
      title="LLM Debug"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <HStack gap={2} wrap="wrap">
          <Button
            label="Copy link"
            variant="ghost"
            size="sm"
            icon={<ExternalLinkIcon />}
            onClick={() => copy(globalThis.location.href)}
          />
          <Button
            label={
              data && canReplayCapture(data) ? "Replay" : "Edit and replay"
            }
            variant="primary"
            icon={<PlayIcon />}
            isDisabled={!showReplay}
            tooltip={
              data && !showReplay ?
                "Replay supports POST /chat/completions and /responses captures"
              : undefined
            }
            onClick={() => navigate("llm-replay", id)}
          />
          <Button
            label="Back to list"
            variant="secondary"
            onClick={() => navigate("llm-debug")}
          />
        </HStack>
      }
    >
      {error && !notFound ?
        <Banner
          status="error"
          title="Failed to load debug log entry"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={4}>
          <Skeleton height={120} />
          <Skeleton height={240} index={1} />
        </VStack>
      : null}

      {notFound || (!data && !loading && !error) ?
        <EmptyState
          icon={<BugIcon />}
          title="Entry not found"
          description="This debug log entry could not be found. It may have expired or been cleared."
          actions={
            <Button
              label="Back to list"
              variant="secondary"
              onClick={() => navigate("llm-debug")}
            />
          }
        />
      : null}

      {captureWarning ?
        <Banner
          status="warning"
          title="Capture incomplete"
          description={captureWarning}
        />
      : null}
      {data?.fallback ?
        <LlmFallbackBanner fallback={data.fallback} />
      : null}
      {data ?
        <VStack gap={4}>
          {data.error ?
            <Banner
              status="error"
              title={data.error.name}
              description={data.error.message}
            >
              <VStack gap={2}>
                {(
                  data.error.code !== undefined
                  || data.error.errno !== undefined
                  || data.error.path !== undefined
                ) ?
                  <HStack gap={3} wrap="wrap" vAlign="center">
                    {data.error.code === undefined ? null : (
                      <HStack gap={1} vAlign="center">
                        <Text type="supporting">Code</Text>
                        <MonoText>{data.error.code}</MonoText>
                      </HStack>
                    )}
                    {data.error.errno === undefined ? null : (
                      <HStack gap={1} vAlign="center">
                        <Text type="supporting">Errno</Text>
                        <MonoText>{String(data.error.errno)}</MonoText>
                      </HStack>
                    )}
                    {data.error.path === undefined ? null : (
                      <HStack gap={1} vAlign="center">
                        <Text type="supporting">Upstream</Text>
                        <MonoText>{data.error.path}</MonoText>
                      </HStack>
                    )}
                  </HStack>
                : null}
                {data.error.stack ?
                  <CodeBlock
                    code={data.error.stack}
                    language="plaintext"
                    container="section"
                    title="Stack trace"
                    isWrapped={wrap}
                    onCopy={() => toast.success("Copied")}
                  />
                : null}
              </VStack>
            </Banner>
          : null}

          <ResponsivePair minWidth={420}>
            <Card>
              <VStack gap={3}>
                <Heading level={3}>Request</Heading>
                <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
                  <RequestExportMenu
                    id={id}
                    request={data.request}
                    onError={toast.error}
                    onExport={(format) => toast.success(`Exported ${format}`)}
                  />
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <SegmentedControl
                      label="Request body format"
                      size="sm"
                      value={requestViewMode}
                      onChange={(value) =>
                        setRequestViewMode(value as "pretty" | "raw")
                      }
                    >
                      <SegmentedControlItem value="pretty" label="Pretty" />
                      <SegmentedControlItem value="raw" label="Raw" />
                    </SegmentedControl>
                    <Switch
                      label="Wrap request"
                      value={wrap}
                      onChange={setWrap}
                    />
                  </HStack>
                </HStack>
                <HStack gap={3} vAlign="center" wrap="wrap">
                  <MonoText>{data.request.method}</MonoText>
                  <MonoText>{data.request.path}</MonoText>
                  <RelTime ts={data.startedAt} />
                  {data.durationMs === undefined ? null : (
                    <Text type="supporting" color="secondary">
                      {formatDuration(data.durationMs)}
                    </Text>
                  )}
                </HStack>
                <Text type="code" color="secondary">
                  {data.request.url}
                </Text>

                <Collapsible
                  trigger={`Request Headers (${Object.keys(data.request.headers).length})`}
                  defaultIsOpen={false}
                >
                  <HeaderList headers={data.request.headers} onCopy={copy} />
                </Collapsible>

                <PayloadBlock
                  label="Request Body"
                  body={data.request.body}
                  emptyText="No request body"
                  viewMode={requestViewMode}
                  wrap={wrap}
                  onCopyError={toast.error}
                  onCopySuccess={() => toast.success("Copied")}
                />
              </VStack>
            </Card>

            <Card>
              <VStack gap={3}>
                <Heading level={3}>Response</Heading>
                {data.response ?
                  <>
                    <ResponseInspector
                      durationMs={data.durationMs}
                      id={id}
                      responseIdentity={id}
                      response={data.response}
                      onCopyError={toast.error}
                      onCopySuccess={() => toast.success("Copied")}
                      onExport={(format) => toast.success(`Exported ${format}`)}
                      onExportError={toast.error}
                    />
                    {data.response.bodyReadError ?
                      <Banner
                        status="warning"
                        title="Response body read error"
                        description={data.response.bodyReadError.message}
                      />
                    : null}
                  </>
                : <Text type="supporting" color="secondary">
                    {missingResponseText(data.status)}
                  </Text>
                }
              </VStack>
            </Card>
          </ResponsivePair>
        </VStack>
      : null}
    </Page>
  )
}
