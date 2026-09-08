import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Switch } from "@astryxdesign/core/Switch"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import type { ModelRouting, ModelRoutingModel } from "../lib/types"

import { DataTable, EmptyState, MonoText } from "../components/common"
import { Page } from "../components/Page"
import { RouteIcon, SearchIcon } from "../icons"
import { ApiError, get, post } from "../lib/api"
import {
  formatModelRoutingAccountDetails,
  formatModelRoutingAccountSummary,
  modelRoutingAccountDisabledReason,
  modelRoutingAccountStatus,
} from "../lib/model-routing"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

type ModelRow = ModelRoutingModel & Record<string, unknown>

function loadRouting(): Promise<ModelRouting> {
  return get<ModelRouting>("/dashboard/api/model-routing")
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback
}

function matchesFilter(model: ModelRoutingModel, filter: string): boolean {
  if (!filter.trim()) return true
  const needle = filter.trim().toLowerCase()
  return (
    model.id.toLowerCase().includes(needle)
    || model.name.toLowerCase().includes(needle)
    || model.vendor.toLowerCase().includes(needle)
  )
}

export default function ModelRoutingScreen() {
  const { data, error, loading, reload } = useAsyncData(loadRouting, [])
  const toast = useToast()
  const [filter, setFilter] = useState("")

  async function handleToggle(
    modelId: string,
    accountId: number,
    enabled: boolean,
  ) {
    try {
      await post("/dashboard/api/model-routing", {
        modelId,
        accountId,
        enabled,
      })
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update model routing"))
      throw caught
    }
  }

  const models = data?.models ?? []
  const filteredModels = models.filter((model) => matchesFilter(model, filter))

  const columns: Array<TableColumn<ModelRow>> =
    data ?
      [
        {
          key: "model",
          header: "Model",
          width: proportional(2, { minWidth: 200 }),
          renderCell: (item) => (
            <VStack gap={0.5}>
              <HStack gap={1.5} vAlign="center">
                <Text weight="medium">{item.name}</Text>
                <Badge variant="neutral" label={item.vendor} />
                {item.preview ?
                  <Badge variant="info" label="preview" />
                : null}
              </HStack>
              <MonoText>{item.id}</MonoText>
            </VStack>
          ),
        },
        ...data.accounts.map((account): TableColumn<ModelRow> => {
          const accountSummary = formatModelRoutingAccountSummary(account)
          const accountDetails = formatModelRoutingAccountDetails(account)
          const disabledReason = modelRoutingAccountDisabledReason(account)
          const status = modelRoutingAccountStatus(account)
          let statusVariant: "neutral" | "success" | "error" = "neutral"
          if (!disabledReason)
            statusVariant = account.healthy ? "success" : "error"

          return {
            key: `account-${account.id}`,
            header: (
              <div aria-label={accountSummary} title={accountSummary}>
                <HStack gap={1.5} vAlign="center" hAlign="center" width="100%">
                  <StatusDot
                    variant={statusVariant}
                    label={accountSummary}
                    tooltip={accountSummary}
                  />
                  <VStack gap={0} hAlign="start">
                    <Text weight="medium">Account #{account.id}</Text>
                    <Text type="supporting">{accountDetails}</Text>
                    {disabledReason ?
                      <Text type="supporting">{status}</Text>
                    : null}
                  </VStack>
                </HStack>
              </div>
            ),
            width: pixel(180),
            align: "center",
            renderCell: (item) => {
              const entry = item.accounts.find(
                (acct) => acct.accountId === account.id,
              )
              return (
                <div title={disabledReason}>
                  <Switch
                    label={`Toggle ${item.name} on account ${account.id}`}
                    isLabelHidden
                    value={entry?.enabled ?? false}
                    isDisabled={entry === undefined || Boolean(disabledReason)}
                    changeAction={(value) =>
                      handleToggle(item.id, account.id, value)
                    }
                  />
                </div>
              )
            },
          }
        }),
      ]
    : []

  return (
    <Page
      kicker="Control"
      title="Model Routing"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        data ?
          <TextInput
            label="Filter models"
            isLabelHidden
            value={filter}
            onChange={setFilter}
            placeholder="Filter by id, name, or vendor"
            startIcon={SearchIcon}
            hasClear
          />
        : null
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load model routing"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={2}>
          <Skeleton height={72} />
          <Skeleton height={320} index={1} />
        </VStack>
      : null}

      {data && !data.multiToken ?
        <Banner
          status="info"
          title="Multi-token routing is off"
          description="These per-account overrides have limited effect until multi-token mode is enabled."
        />
      : null}

      {data && models.length === 0 ?
        <EmptyState
          icon={<RouteIcon />}
          title="No models available"
          description="Models will appear here once the Copilot backend reports available accounts."
        />
      : null}

      {data && models.length > 0 && filteredModels.length === 0 ?
        <EmptyState
          title="No models match your filter"
          description="Try a different id, name, or vendor."
        />
      : null}

      {filteredModels.length > 0 ?
        <DataTable
          data={filteredModels as Array<ModelRow>}
          columns={columns}
          idKey="id"
        />
      : null}
    </Page>
  )
}
