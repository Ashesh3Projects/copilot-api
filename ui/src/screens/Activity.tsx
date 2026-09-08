import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { useState } from "react"

import { ConfirmButton, EmptyState } from "../components/common"
import { Page } from "../components/Page"
import { del, get } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface ActivityPage {
  records: Array<{
    id: string
    recordedAt: number
    payload: { message?: string; type?: string; handler?: string }
  }>
  cursor: string | null
  collection: {
    degraded: boolean
    pendingRecords: number
    droppedRecords: number
    unknownGaps: number
    knownLostRecords: number
  }
}
export default function ActivityScreen() {
  const [cursor, setCursor] = useState<string>()
  const { data, error, loading, reload } = useAsyncData(
    () =>
      get<ActivityPage>(
        "/dashboard/api/activity?limit=100"
          + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      ),
    [cursor],
  )
  const toast = useToast()
  return (
    <Page
      kicker="Monitor"
      title="Activity"
      onRefresh={reload}
      isRefreshing={loading}
    >
      <VStack gap={4}>
        {error ?
          <Banner
            status="error"
            title="Could not load activity"
            description={error.message}
          />
        : null}
        {(
          data?.collection.degraded
          || data?.collection.unknownGaps
          || data?.collection.knownLostRecords
        ) ?
          <Banner
            status="warning"
            title="History may be incomplete"
            description={`Queued: ${data.collection.pendingRecords}. Known dropped records: ${data.collection.knownLostRecords}. Unclean runs: ${data.collection.unknownGaps}.`}
          />
        : null}
        <HStack gap={2} wrap="wrap">
          <Button
            label="Latest"
            variant="secondary"
            onClick={() => {
              setCursor(undefined)
              reload()
            }}
          />
          <ConfirmButton
            label="Clear activity"
            confirmTitle="Clear activity history"
            confirmDescription="Remove stored activity records. Usage totals and account settings are retained."
            onConfirm={async () => {
              await del("/dashboard/api/activity")
              setCursor(undefined)
              reload()
              toast.success("Activity cleared")
            }}
          />
        </HStack>
        {data?.records.length === 0 ?
          <EmptyState
            title="No activity"
            description="New gateway activity appears here as it is recorded."
          />
        : null}
        {data?.records.map((record) => (
          <Card key={record.id}>
            <VStack gap={1}>
              <Text type="supporting" color="secondary">
                {new Date(record.recordedAt).toLocaleString()} ·{" "}
                {record.payload.handler || record.payload.type || "Gateway"}
              </Text>
              <Text>{record.payload.message || "Activity recorded"}</Text>
            </VStack>
          </Card>
        ))}
        {data?.cursor ?
          <Button
            label="Older activity"
            variant="secondary"
            onClick={() => setCursor(data.cursor ?? undefined)}
          />
        : null}
      </VStack>
    </Page>
  )
}
