import type { TableColumn } from "@astryxdesign/core/Table"
import type { CSSProperties } from "react"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Grid } from "@astryxdesign/core/Grid"
import { ProgressBar } from "@astryxdesign/core/ProgressBar"
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useMemo, useState } from "react"

import type {
  RoutingAccountUsage,
  RoutingAffinitySources,
  RoutingBalanceStatus,
  RoutingModelUsage,
  RoutingTelemetrySnapshot,
  RoutingTimeSeriesPoint,
  RoutingWindow,
  UsageData,
  UsageSection,
} from "../lib/types"

import {
  DataTable,
  EmptyState,
  fmtRelative,
  MonoText,
} from "../components/common"
import { Page } from "../components/Page"
import { ResponsivePair } from "../components/ResponsivePair"
import { ChartBarIcon, SearchIcon } from "../icons"
import { get } from "../lib/api"
import { useAsyncData, useDelayedPolling } from "../lib/usePolling"

const ROUTING_POLL_INTERVAL_MS = 10_000

function loadUsage(): Promise<UsageData> {
  return get<UsageData>("/dashboard/api/usage")
}

function loadRoutingUsage(
  window: RoutingWindow,
): Promise<RoutingTelemetrySnapshot> {
  return get<RoutingTelemetrySnapshot>(
    `/dashboard/api/usage-routing?window=${window}`,
  )
}

function humanizeKey(key: string): string {
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function progressVariant(utilization: number): "success" | "warning" | "error" {
  if (utilization > 0.9) return "error"
  if (utilization >= 0.7) return "warning"
  return "success"
}

function fmtCountdown(resetsAtSeconds: number): string {
  const diffSec = Math.max(0, resetsAtSeconds - Math.floor(Date.now() / 1000))
  const days = Math.floor(diffSec / 86400)
  const hours = Math.floor((diffSec % 86400) / 3600)
  const minutes = Math.floor((diffSec % 3600) / 60)

  if (days > 0) return `resets in ${days}d ${hours}h`
  if (hours > 0) return `resets in ${hours}h ${minutes}m`
  return `resets in ${minutes}m`
}

function fmtPercent(value: number, digits = 1): string {
  return `${(Number.isFinite(value) ? value * 100 : 0).toFixed(digits)}%`
}

function fmtRate(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

interface NumericField {
  key: keyof UsageSection
  label: string
}

const NUMERIC_FIELDS: Array<NumericField> = [
  { key: "tokens_used", label: "Tokens Used" },
  { key: "request_count", label: "Requests" },
  { key: "total_tokens", label: "Total Tokens" },
  { key: "total_input_tokens", label: "Input Tokens" },
  { key: "total_output_tokens", label: "Output Tokens" },
  { key: "total_requests", label: "Total Requests" },
]

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <VStack gap={0.5}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      <Text type="large" weight="semibold">
        {value.toLocaleString()}
      </Text>
    </VStack>
  )
}

function UsageSectionCard({
  name,
  section,
}: {
  name: string
  section: UsageSection
}) {
  const numericFields = NUMERIC_FIELDS.filter(
    ({ key }) => typeof section[key] === "number",
  )

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={3}>{humanizeKey(name)}</Heading>

        {section.utilization !== undefined ?
          <VStack gap={1}>
            <ProgressBar
              label={`${humanizeKey(name)} utilization`}
              value={section.utilization * 100}
              hasValueLabel
              formatValueLabel={(value) => `${value.toFixed(1)}% used`}
              variant={progressVariant(section.utilization)}
            />
            {section.resets_at !== undefined ?
              <Text type="supporting" color="secondary">
                {fmtCountdown(section.resets_at)}
              </Text>
            : null}
          </VStack>
        : null}

        {section.first_request_at != null ?
          <HStack gap={1}>
            <Text type="supporting" color="secondary">
              First request:
            </Text>
            <Text type="supporting" color="secondary">
              {fmtRelative(section.first_request_at * 1000)}
            </Text>
          </HStack>
        : null}

        {numericFields.length > 0 ?
          <Grid columns={{ minWidth: 120 }} gap={3}>
            {numericFields.map(({ key, label }) => (
              <MiniStat
                key={key}
                label={label}
                value={section[key] as number}
              />
            ))}
          </Grid>
        : null}
      </VStack>
    </Card>
  )
}

function UsageCards({ data }: { data: UsageData }) {
  const sectionEntries = Object.entries(data)
  if (sectionEntries.length === 0) {
    return (
      <EmptyState
        icon={<ChartBarIcon />}
        title="No usage data"
        description="Usage sections will appear here once requests start flowing."
      />
    )
  }

  return (
    <Grid columns={{ minWidth: 320 }} gap={4}>
      {sectionEntries.map(([name, section]) => (
        <UsageSectionCard key={name} name={name} section={section} />
      ))}
    </Grid>
  )
}

function PulseMetric({
  label,
  value,
  supporting,
}: {
  label: string
  value: string
  supporting: string
}) {
  return (
    <Card variant="muted" className="usage-metric">
      <VStack gap={0.5}>
        <Text type="label" color="secondary">
          {label}
        </Text>
        <Heading level={3}>{value}</Heading>
        <Text type="supporting" color="secondary">
          {supporting}
        </Text>
      </VStack>
    </Card>
  )
}

interface UsageChartStyle extends CSSProperties {
  "--usage-bar-height": string
}

function chartStyle(value: number, maximum: number): UsageChartStyle {
  const percent = maximum > 0 ? Math.max(2, (value / maximum) * 100) : 2
  return { "--usage-bar-height": `${percent}%` }
}

function chartLabel(point: RoutingTimeSeriesPoint): string {
  const time = new Date(point.timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
  return `${time}: ${point.requests} requests, ${point.extraCalls} extra calls`
}

function RoutingChart({ points }: { points: Array<RoutingTimeSeriesPoint> }) {
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [point.requests, point.extraCalls]),
  )
  return (
    <div
      className="usage-chart"
      aria-label="Requests and extra upstream calls over time"
      role="img"
    >
      <span className="usage-visually-hidden">
        {points.map((point) => chartLabel(point)).join("; ")}
      </span>
      {points.map((point) => (
        <div
          className="usage-chart-group"
          key={point.timestamp}
          title={chartLabel(point)}
        >
          <span
            className="usage-chart-bar usage-chart-requests"
            style={chartStyle(point.requests, maximum)}
          />
          <span
            className="usage-chart-bar usage-chart-extra"
            style={chartStyle(point.extraCalls, maximum)}
          />
        </div>
      ))}
    </div>
  )
}

function RoutingPulse({ data }: { data: RoutingTelemetrySnapshot }) {
  const amplification =
    data.totals.requests > 0 ?
      data.totals.upstreamCalls / data.totals.requests
    : 0
  return (
    <Card className="usage-pulse">
      <VStack gap={4}>
        <VStack gap={0.5}>
          <Heading level={2}>Routing pulse</Heading>
          <Text type="supporting" color="secondary">
            Live in-memory activity · detailed history retained for 24 hours
          </Text>
        </VStack>
        <div className="usage-pulse-layout">
          <Grid columns={{ minWidth: 150 }} gap={2}>
            <PulseMetric
              label="Requests"
              value={data.totals.requests.toLocaleString()}
              supporting={`${fmtRate(data.totals.requests / data.windowMinutes)} / min`}
            />
            <PulseMetric
              label="Upstream calls"
              value={data.totals.upstreamCalls.toLocaleString()}
              supporting={`${amplification.toFixed(2)}× amplification`}
            />
            <PulseMetric
              label="Retries"
              value={data.totals.retries.toLocaleString()}
              supporting={`${fmtPercent(data.totals.upstreamCalls > 0 ? data.totals.retries / data.totals.upstreamCalls : 0)} of calls`}
            />
            <PulseMetric
              label="Failovers"
              value={data.totals.failovers.toLocaleString()}
              supporting={`${fmtPercent(data.totals.requests > 0 ? data.totals.failovers / data.totals.requests : 0)} of requests`}
            />
            <Text type="supporting" color="secondary">
              Process lifetime: {data.lifetime.requests.toLocaleString()}{" "}
              requests · {data.lifetime.upstreamCalls.toLocaleString()} calls ·{" "}
              {data.lifetime.retries.toLocaleString()} retries ·{" "}
              {data.lifetime.failovers.toLocaleString()} failovers
            </Text>
          </Grid>
          <VStack gap={2}>
            <HStack gap={3} wrap="wrap">
              <Text type="supporting" color="secondary">
                <span className="usage-legend usage-legend-requests" /> Requests
              </Text>
              <Text type="supporting" color="secondary">
                <span className="usage-legend usage-legend-extra" /> Extra calls
              </Text>
            </HStack>
            <RoutingChart points={data.timeSeries} />
          </VStack>
        </div>
      </VStack>
    </Card>
  )
}

type ModelUsageRow = RoutingModelUsage & Record<string, unknown>

function AccountDistribution({
  model,
  multiToken,
}: {
  model: RoutingModelUsage
  multiToken: boolean
}) {
  if (model.accounts.length === 0) {
    return (
      <Text type="supporting" color="secondary">
        {model.provider === "GitHub Copilot" && !multiToken ?
          "Default credential"
        : "N/A · external provider"}
      </Text>
    )
  }

  return (
    <VStack gap={1}>
      <div className="usage-account-distribution">
        {model.accounts.map((account) => (
          <span
            key={account.accountId}
            className={`usage-account-segment usage-account-${account.accountId % 6}`}
            style={{ width: fmtPercent(account.share, 2) }}
            title={`Account #${account.accountId}: ${account.upstreamCalls.toLocaleString()} calls`}
          />
        ))}
      </div>
      <Text type="supporting" color="secondary">
        {model.accounts
          .map(
            (account) =>
              `#${account.accountId} ${fmtPercent(account.share, 0)}`,
          )
          .join(" · ")}
      </Text>
    </VStack>
  )
}

function modelColumns(multiToken: boolean): Array<TableColumn<ModelUsageRow>> {
  return [
    {
      key: "model",
      header: "Model / provider",
      width: proportional(2, { minWidth: 190 }),
      renderCell: (item) => (
        <VStack gap={0.5}>
          <MonoText>{item.model}</MonoText>
          <Badge variant="neutral" label={item.provider} />
        </VStack>
      ),
    },
    {
      key: "requests",
      header: "Requests",
      width: pixel(86),
      align: "end",
      renderCell: (item) => item.requests.toLocaleString(),
    },
    {
      key: "upstreamCalls",
      header: "Calls",
      width: pixel(76),
      align: "end",
      renderCell: (item) => item.upstreamCalls.toLocaleString(),
    },
    {
      key: "share",
      header: "Share",
      width: pixel(76),
      align: "end",
      renderCell: (item) => fmtPercent(item.share),
    },
    {
      key: "amplification",
      header: "Amplification",
      width: pixel(112),
      align: "end",
      renderCell: (item) => (
        <VStack gap={0} hAlign="end">
          <Text>{item.amplification.toFixed(2)}×</Text>
          <Text type="supporting" color="secondary">
            {item.retries} retry · {item.failovers} failover
          </Text>
        </VStack>
      ),
    },
    {
      key: "successRate",
      header: "Success",
      width: pixel(82),
      align: "end",
      renderCell: (item) => fmtPercent(item.successRate),
    },
    {
      key: "accounts",
      header: "Accounts",
      width: proportional(1.5, { minWidth: 180 }),
      renderCell: (item) => (
        <AccountDistribution model={item} multiToken={multiToken} />
      ),
    },
  ]
}

function ModelUsageTable({
  data,
  filter,
}: {
  data: RoutingTelemetrySnapshot
  filter: string
}) {
  const needle = filter.trim().toLowerCase()
  const rows = data.models.filter(
    (model) =>
      !needle
      || model.model.toLowerCase().includes(needle)
      || model.provider.toLowerCase().includes(needle),
  )
  return (
    <Card>
      <VStack gap={3}>
        <VStack gap={0.5}>
          <Heading level={2}>Model usage &amp; routing</Heading>
          <Text type="supporting" color="secondary">
            Effective upstream models, provider calls, and account destinations
          </Text>
        </VStack>
        {rows.length > 0 ?
          <DataTable
            data={rows as Array<ModelUsageRow>}
            columns={modelColumns(data.multiToken)}
            idKey="id"
          />
        : <EmptyState
            title={
              data.models.length === 0 ?
                "Waiting for model traffic"
              : "No models match"
            }
            description={
              data.models.length === 0 ?
                "Model and provider rows appear when requests begin flowing."
              : "Try a different model or provider filter."
            }
          />
        }
      </VStack>
    </Card>
  )
}

function balanceVariant(
  status: RoutingBalanceStatus,
): "neutral" | "success" | "warning" | "error" {
  if (status === "skewed") return "warning"
  if (status === "within_range") return "success"
  return "neutral"
}

function balanceLabel(status: RoutingBalanceStatus): string {
  if (status === "skewed") return "Review skew"
  if (status === "within_range") return "Within range"
  if (status === "insufficient_data") return "Collecting data"
  return "Not applicable"
}

function AccountBalanceRow({ account }: { account: RoutingAccountUsage }) {
  const health = account.healthy ? "Healthy" : "Unhealthy"
  return (
    <div className="usage-account-row">
      <HStack gap={1.5} vAlign="center">
        <StatusDot
          variant={account.healthy ? "success" : "error"}
          label={`${account.label} ${health}`}
        />
        <VStack gap={0}>
          <Text weight="medium">{account.label}</Text>
          <Text type="supporting" color="secondary">
            {account.githubUsername ? `@${account.githubUsername} · ` : ""}
            {account.accountType ?? "single token"}
          </Text>
        </VStack>
      </HStack>
      <div className="usage-balance-track">
        <span style={{ width: fmtPercent(account.selectionShare, 2) }} />
      </div>
      <VStack gap={0} hAlign="end">
        <Text weight="medium">
          {account.selected.toLocaleString()} selections
        </Text>
        <Text type="supporting" color="secondary">
          {fmtPercent(account.selectionShare)} actual · expected{" "}
          {fmtPercent(account.expectedShare)}
        </Text>
      </VStack>
      <VStack gap={0} hAlign="end">
        <Text>{account.upstreamCalls.toLocaleString()} calls</Text>
        <Text type="supporting" color="secondary">
          {fmtPercent(account.callShare)} call share · delta{" "}
          {account.selectionDelta >= 0 ? "+" : ""}
          {fmtPercent(account.selectionDelta)}
        </Text>
        <Badge
          variant={balanceVariant(account.balanceStatus)}
          label={balanceLabel(account.balanceStatus)}
        />
      </VStack>
    </div>
  )
}

const EMPTY_AFFINITY_SOURCES: RoutingAffinitySources = {
  claude_session: 0,
  copilot_session: 0,
  codex_session: 0,
  claude_metadata: 0,
  codex_metadata: 0,
  codex_thread: 0,
  unidentified: 0,
}

export function normalizeAffinitySources(
  sources: RoutingAffinitySources | undefined,
): RoutingAffinitySources {
  return { ...EMPTY_AFFINITY_SOURCES, ...sources }
}

function AccountBalance({ data }: { data: RoutingTelemetrySnapshot }) {
  const sourceCounts = normalizeAffinitySources(data.affinitySources)
  const affinitySources = [
    ["claude_session", "Claude session"],
    ["copilot_session", "Copilot session"],
    ["codex_session", "Codex session"],
    ["claude_metadata", "Claude metadata"],
    ["codex_metadata", "Codex metadata"],
    ["codex_thread", "Codex thread"],
    ["unidentified", "Unidentified"],
  ] as const
  return (
    <Card height="100%">
      <VStack gap={3}>
        <VStack gap={0.5}>
          <Heading level={2}>Account balance</Heading>
          <Text type="supporting" color="secondary">
            Initial selections compared with each model's eligible accounts
          </Text>
        </VStack>
        <VStack gap={0}>
          {data.accounts.map((account) => (
            <AccountBalanceRow
              key={account.accountId ?? "default"}
              account={account}
            />
          ))}
        </VStack>
        <HStack gap={1} wrap="wrap" aria-label="Routing affinity sources">
          {affinitySources
            .filter(
              ([source]) =>
                source === "unidentified" || sourceCounts[source] > 0,
            )
            .map(([source, label]) => (
              <Badge
                key={source}
                variant="neutral"
                label={`${label}: ${sourceCounts[source].toLocaleString()}`}
              />
            ))}
        </HStack>
      </VStack>
    </Card>
  )
}

function RouteBreakdown({ data }: { data: RoutingTelemetrySnapshot }) {
  return (
    <Card height="100%">
      <VStack gap={3}>
        <VStack gap={0.5}>
          <Heading level={2}>Route breakdown</Heading>
          <Text type="supporting" color="secondary">
            Client protocols paired with their final provider destination
          </Text>
        </VStack>
        {data.routes.length > 0 ?
          <div className="usage-route-grid">
            {data.routes.map((route) => (
              <Card key={route.route} variant="muted">
                <VStack gap={0.5}>
                  <Text weight="medium">{route.route}</Text>
                  <Text type="supporting" color="secondary">
                    {route.requests.toLocaleString()} requests ·{" "}
                    {route.upstreamCalls.toLocaleString()} calls
                  </Text>
                  <Text type="supporting" color="secondary">
                    {fmtPercent(route.share)} of upstream traffic
                  </Text>
                </VStack>
              </Card>
            ))}
          </div>
        : <EmptyState
            title="Waiting for route activity"
            description="Protocol and destination routes appear after the first model call."
          />
        }
      </VStack>
    </Card>
  )
}

function RoutingSurface({
  data,
  filter,
}: {
  data: RoutingTelemetrySnapshot
  filter: string
}) {
  return (
    <VStack gap={4}>
      {data.totals.requests === 0 && data.totals.upstreamCalls === 0 ?
        <Banner
          status="info"
          title="Waiting for routing activity"
          description="Configured account health is visible below; model and route statistics appear as requests arrive."
        />
      : null}
      <RoutingPulse data={data} />
      <ModelUsageTable data={data} filter={filter} />
      <ResponsivePair minWidth={360}>
        <AccountBalance data={data} />
        <RouteBreakdown data={data} />
      </ResponsivePair>
    </VStack>
  )
}

export default function UsageScreen() {
  const [window, setWindow] = useState<RoutingWindow>("1h")
  const [filter, setFilter] = useState("")
  const usage = useAsyncData(loadUsage, [])
  const routing = useAsyncData(() => loadRoutingUsage(window), [window])
  useDelayedPolling(routing.reloadSilently, ROUTING_POLL_INTERVAL_MS, [window])

  const actions = useMemo(
    () => (
      <HStack gap={2} vAlign="center" wrap="wrap">
        <TextInput
          label="Filter routing models"
          isLabelHidden
          value={filter}
          onChange={setFilter}
          placeholder="Filter model or provider"
          startIcon={SearchIcon}
          hasClear
        />
        <SegmentedControl
          label="Routing usage window"
          size="sm"
          value={window}
          onChange={(value) => setWindow(value as RoutingWindow)}
        >
          <SegmentedControlItem value="15m" label="15m" />
          <SegmentedControlItem value="1h" label="1h" />
          <SegmentedControlItem value="6h" label="6h" />
          <SegmentedControlItem value="24h" label="24h" />
        </SegmentedControl>
      </HStack>
    ),
    [filter, window],
  )

  const refreshAll = () => {
    usage.reload()
    routing.reload()
  }

  return (
    <Page
      kicker="Monitor"
      title="Usage"
      actions={actions}
      onRefresh={refreshAll}
      isRefreshing={usage.loading || routing.loading}
    >
      {usage.error ?
        <Banner
          status="error"
          title="Failed to load usage"
          description={usage.error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={usage.reload} />
          }
        />
      : null}

      {!usage.data && usage.loading ?
        <Grid columns={{ minWidth: 320 }} gap={4}>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={160} index={index} />
          ))}
        </Grid>
      : null}

      {usage.data ?
        <UsageCards data={usage.data} />
      : null}

      {routing.error ?
        <Banner
          status="error"
          title="Failed to load routing usage"
          description={routing.error.message}
          endContent={
            <Button
              label="Retry"
              variant="secondary"
              onClick={routing.reload}
            />
          }
        />
      : null}

      {!routing.data && routing.loading ?
        <VStack gap={3}>
          <Skeleton height={220} />
          <Skeleton height={300} index={1} />
        </VStack>
      : null}

      {routing.data ?
        <RoutingSurface data={routing.data} filter={filter} />
      : null}
    </Page>
  )
}
