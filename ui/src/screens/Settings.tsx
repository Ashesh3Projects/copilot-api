import type { SelectorOptionType } from "@astryxdesign/core/Selector"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Divider } from "@astryxdesign/core/Divider"
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useRef, useState } from "react"

import {
  ConfirmButton,
  DataTable,
  EmptyState,
  IconAction,
  MonoText,
  RelTime,
  TogglePill,
} from "../components/common"
import { DatabaseBackup } from "../components/DatabaseBackup"
import { Page } from "../components/Page"
import { ResponsivePair } from "../components/ResponsivePair"
import { StoredCredentials } from "../components/StoredCredentials"
import { DownloadIcon, PlusIcon, Trash2Icon } from "../icons"
import { ApiError, del, get, patch, post, put } from "../lib/api"
import { useToast } from "../lib/toast"
import {
  IpAddressRequiredError,
  addIpAllowlistEntry,
  addTrustedJwtDigest,
  clearIpAllowlist,
  ipAddressPlaceholder,
  loadSettingsBundle,
  type IpAllowlistEntry,
  type SettingsBundle,
  type TrustedJwtDigestEntry,
} from "../lib/types"
import { useAsyncData } from "../lib/usePolling"

type IpRow = IpAllowlistEntry & Record<string, unknown>
type TrustedJwtDigestRow = TrustedJwtDigestEntry & Record<string, unknown>

function loadBundle(): Promise<SettingsBundle> {
  return loadSettingsBundle(get)
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback
}

function boolBadge(value: boolean, trueLabel = "Yes", falseLabel = "No") {
  return (
    <Badge
      variant={value ? "success" : "neutral"}
      label={value ? trueLabel : falseLabel}
    />
  )
}

export default function SettingsScreen() {
  const { data, error, loading, reload } = useAsyncData(loadBundle, [])
  const toast = useToast()

  const [cleanupDraft, setCleanupDraft] = useState<string>()
  const [isSavingCleanup, setIsSavingCleanup] = useState(false)
  const [newIp, setNewIp] = useState("")
  const [isAddingIp, setIsAddingIp] = useState(false)
  const isAddingIpRef = useRef(false)
  const [newJwtLabel, setNewJwtLabel] = useState("")
  const [newJwtDigest, setNewJwtDigest] = useState("")
  const [isAddingJwtDigest, setIsAddingJwtDigest] = useState(false)
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [changingPassword, setChangingPassword] = useState(false)

  const changePassword = async () => {
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match.")
      return
    }
    setChangingPassword(true)
    try {
      await put("/dashboard/auth/password", { currentPassword, newPassword })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      toast.success(
        "Password changed. Other administrator sessions were signed out.",
      )
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not change the password"))
    } finally {
      setChangingPassword(false)
    }
  }

  const cleanupValue = cleanupDraft ?? data?.settings.codexCleanupModel ?? ""

  const setAddingIp = (value: boolean) => {
    isAddingIpRef.current = value
    setIsAddingIp(value)
  }

  const handleExport = async () => {
    try {
      const response = await fetch("/dashboard/api/settings/export", {
        credentials: "same-origin",
      })
      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`)
      }
      const blob = await response.blob()
      const disposition = response.headers.get("content-disposition") ?? ""
      const match = /filename="?([^";]+)"?/.exec(disposition)
      const filename = match?.[1] ?? "copilot-api-config.zip"
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
      toast.success("Config exported")
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Failed to export config",
      )
    }
  }

  const handleSaveCleanup = async () => {
    setIsSavingCleanup(true)
    try {
      await post("/dashboard/api/settings/codex-cleanup-model", {
        model: cleanupValue || null,
      })
      toast.success("Codex cleanup model updated")
      setCleanupDraft(undefined)
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update cleanup model"))
    } finally {
      setIsSavingCleanup(false)
    }
  }

  const handleAddIp = async () => {
    if (isAddingIpRef.current) return
    setAddingIp(true)
    try {
      await addIpAllowlistEntry(newIp, data?.currentIp ?? null, post)
      toast.success("IP added")
      setNewIp("")
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof IpAddressRequiredError ?
          caught.message
        : errorMessage(caught, "Failed to add IP"),
      )
    } finally {
      setAddingIp(false)
    }
  }

  const handleToggleIp = async (ip: string, enabled: boolean) => {
    try {
      await patch(`/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`, {
        enabled,
      })
      toast.success(enabled ? "IP enabled" : "IP disabled")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update IP"))
    }
  }

  const handleRemoveIp = async (ip: string) => {
    try {
      await del(`/dashboard/api/ip-allowlist/${encodeURIComponent(ip)}`)
      toast.success("IP removed")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to remove IP"))
    }
  }

  const handleClearAllowlist = async () => {
    try {
      const result = await clearIpAllowlist(del)
      toast.success(
        `Cleared ${result.cleared} IP${result.cleared === 1 ? "" : "s"}`,
      )
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to clear IP allowlist"))
      throw caught
    }
  }

  const handleAddJwtDigest = async () => {
    if (isAddingJwtDigest) return
    setIsAddingJwtDigest(true)
    try {
      await addTrustedJwtDigest(newJwtLabel, newJwtDigest, post)
      toast.success("Trusted JWT digest added")
      setNewJwtLabel("")
      setNewJwtDigest("")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to add trusted JWT digest"))
    } finally {
      setIsAddingJwtDigest(false)
    }
  }

  const handleToggleJwtDigest = async (id: string, enabled: boolean) => {
    try {
      await patch(
        `/dashboard/api/trusted-jwt-digests/${encodeURIComponent(id)}`,
        { enabled },
      )
      toast.success(
        enabled ? "Trusted JWT digest enabled" : "Trusted JWT digest disabled",
      )
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to update trusted JWT digest"))
    }
  }

  const handleRemoveJwtDigest = async (id: string) => {
    try {
      await del(`/dashboard/api/trusted-jwt-digests/${encodeURIComponent(id)}`)
      toast.success("Trusted JWT digest deleted")
      reload()
    } catch (caught) {
      toast.error(errorMessage(caught, "Failed to delete trusted JWT digest"))
    }
  }

  const cleanupOptions: Array<SelectorOptionType> =
    data ?
      [
        {
          value: "",
          label: `Use default (${data.settings.codexCleanupModelDefault ?? "none"})`,
        },
        ...data.settings.availableModels.map((model) => ({
          value: model,
          label: model,
        })),
        ...((
          data.settings.codexCleanupModel
          && !data.settings.availableModels.includes(
            data.settings.codexCleanupModel,
          )
        ) ?
          [
            {
              value: data.settings.codexCleanupModel,
              label: data.settings.codexCleanupModel,
            },
          ]
        : []),
      ]
    : []

  const ipColumns: Array<TableColumn<IpRow>> = [
    {
      key: "ip",
      header: "IP",
      width: proportional(2),
      renderCell: (item) => <MonoText>{item.ip}</MonoText>,
    },
    {
      key: "enabled",
      header: "Enabled",
      width: pixel(72),
      renderCell: (item) => (
        <TogglePill
          label={`Toggle ${item.ip}`}
          value={item.enabled}
          onChange={(next) => handleToggleIp(item.ip, next)}
        />
      ),
    },
    {
      key: "source",
      header: "Source",
      width: pixel(120),
      renderCell: (item) => <Text type="supporting">{item.source}</Text>,
    },
    {
      key: "lastSeen",
      header: "Last Seen",
      width: pixel(140),
      renderCell: (item) =>
        item.lastSeenAt ?
          <RelTime ts={item.lastSeenAt} />
        : <Text type="supporting">—</Text>,
    },
    {
      key: "actions",
      header: "",
      width: pixel(56),
      align: "end",
      renderCell: (item) => (
        <IconAction
          label={`Remove ${item.ip}`}
          icon={<Trash2Icon />}
          variant="destructive"
          onClick={() => handleRemoveIp(item.ip)}
        />
      ),
    },
  ]

  const trustedJwtDigestColumns: Array<TableColumn<TrustedJwtDigestRow>> = [
    {
      key: "label",
      header: "Device",
      width: proportional(1),
      renderCell: (item) => <Text>{item.label}</Text>,
    },
    {
      key: "digest",
      header: "SHA-256 digest",
      width: proportional(2),
      renderCell: (item) => (
        <span title={item.digest}>
          <MonoText>{item.digest}</MonoText>
        </span>
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      width: pixel(72),
      renderCell: (item) => (
        <TogglePill
          label={`Toggle ${item.label}`}
          value={item.enabled}
          onChange={(next) => handleToggleJwtDigest(item.id, next)}
        />
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      width: pixel(112),
      renderCell: (item) => <RelTime ts={item.createdAt} />,
    },
    {
      key: "actions",
      header: "",
      width: pixel(56),
      align: "end",
      renderCell: (item) => (
        <ConfirmButton
          label="Delete"
          isIconOnly
          icon={<Trash2Icon />}
          size="sm"
          confirmTitle="Delete trusted JWT digest"
          confirmDescription={`Delete the trusted digest for "${item.label}"?`}
          onConfirm={() => handleRemoveJwtDigest(item.id)}
        />
      ),
    },
  ]

  return (
    <Page
      kicker="System"
      title="Settings"
      onRefresh={reload}
      isRefreshing={loading}
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load settings"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <Skeleton height={480} />
      : null}

      {data ?
        <VStack gap={4}>
          <StoredCredentials />
          <DatabaseBackup />
          <Card>
            <VStack gap={3}>
              <Heading level={3}>Administrator password</Heading>
              <Text color="secondary">
                Changing your password signs out other administrator sessions.
                API client credentials stay active.
              </Text>
              <TextInput
                type="password"
                label="Current password"
                value={currentPassword}
                onChange={setCurrentPassword}
              />
              <TextInput
                type="password"
                label="New password"
                value={newPassword}
                onChange={setNewPassword}
              />
              <TextInput
                type="password"
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
              <Button
                label="Change password"
                variant="secondary"
                isLoading={changingPassword}
                isDisabled={
                  changingPassword
                  || !currentPassword
                  || newPassword.length < 4
                  || newPassword !== confirmPassword
                }
                onClick={() => void changePassword()}
              />
            </VStack>
          </Card>
          <ResponsivePair minWidth={470}>
            <Card>
              <VStack gap={4}>
                <Heading level={3}>Server Configuration</Heading>
                <MetadataList columns={2}>
                  <MetadataListItem label="Version">
                    {data.settings.version}
                  </MetadataListItem>
                  <MetadataListItem label="Port">
                    {data.settings.port}
                  </MetadataListItem>
                  <MetadataListItem label="Host">
                    {data.settings.host}
                  </MetadataListItem>
                  <MetadataListItem label="API Key Configured">
                    {boolBadge(data.settings.authEnabled)}
                  </MetadataListItem>
                  <MetadataListItem label="Multi-Token Mode">
                    {boolBadge(data.settings.multiToken)}
                  </MetadataListItem>
                  <MetadataListItem label="Sentry Enabled">
                    {boolBadge(data.settings.sentryEnabled)}
                  </MetadataListItem>
                  <MetadataListItem label="Groq Enabled">
                    {boolBadge(data.settings.groqEnabled)}
                  </MetadataListItem>
                  <MetadataListItem label="Database">
                    <MonoText>{data.settings.dataDir}</MonoText>
                  </MetadataListItem>
                  <MetadataListItem label="Debug Mode">
                    {boolBadge(data.settings.debug)}
                  </MetadataListItem>
                  <MetadataListItem label="Verbose Logging">
                    {boolBadge(data.settings.verbose)}
                  </MetadataListItem>
                </MetadataList>

                <Divider />

                <VStack gap={4}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Heading level={4}>Codex Dictation Cleanup</Heading>
                    <Badge variant="neutral" label="Used by /codex/responses" />
                  </HStack>
                  <Selector
                    label="Cleanup model"
                    options={cleanupOptions}
                    value={cleanupValue}
                    onChange={setCleanupDraft}
                  />
                  <HStack hAlign="end">
                    <Button
                      label="Save"
                      variant="primary"
                      isLoading={isSavingCleanup}
                      onClick={handleSaveCleanup}
                    />
                  </HStack>
                </VStack>

                <Divider />

                <HStack hAlign="end">
                  <Button
                    label="Export sanitized config"
                    variant="secondary"
                    icon={<DownloadIcon />}
                    onClick={() => void handleExport()}
                  />
                </HStack>
              </VStack>
            </Card>

            <Card>
              <VStack gap={4}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Heading level={3}>IP Allowlist</Heading>
                  <Badge variant="neutral" label="Used by /transcribe" />
                </HStack>
                <HStack gap={2} vAlign="end" wrap="wrap">
                  <TextInput
                    label="IP address"
                    value={newIp}
                    onChange={setNewIp}
                    placeholder={ipAddressPlaceholder(data.currentIp)}
                    width="min(100%, 320px)"
                  />
                  <Button
                    label="Add"
                    variant="secondary"
                    icon={<PlusIcon />}
                    isLoading={isAddingIp}
                    isDisabled={isAddingIp}
                    onClick={handleAddIp}
                  />
                </HStack>
                {data.allowlist.length > 0 ?
                  <ConfirmButton
                    label="Clear all"
                    confirmTitle="Clear IP allowlist"
                    confirmDescription="Remove every IP address from the allowlist?"
                    confirmActionLabel="Clear all"
                    onConfirm={handleClearAllowlist}
                  />
                : null}
                {data.allowlist.length === 0 ?
                  <EmptyState
                    title="No allowlisted IPs"
                    description="Add an IP address to allow access to /transcribe."
                  />
                : <DataTable
                    data={data.allowlist as Array<IpRow>}
                    columns={ipColumns}
                    idKey="ip"
                  />
                }
              </VStack>
            </Card>
          </ResponsivePair>

          <Card>
            <VStack gap={4}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Heading level={3}>Trusted JWT Digests</Heading>
                <Badge variant="neutral" label="Inference only" />
              </HStack>
              <Text type="supporting">
                Generate a local Codex ChatGPT auth file with the repository
                PowerShell script, then paste only its SHA-256 digest here.
              </Text>
              <HStack gap={2} vAlign="end" wrap="wrap">
                <TextInput
                  label="Device label"
                  value={newJwtLabel}
                  onChange={setNewJwtLabel}
                  width="min(100%, 240px)"
                />
                <TextInput
                  label="SHA-256 digest"
                  value={newJwtDigest}
                  onChange={setNewJwtDigest}
                  width="min(100%, 420px)"
                />
                <Button
                  label="Add"
                  variant="secondary"
                  icon={<PlusIcon />}
                  isLoading={isAddingJwtDigest}
                  isDisabled={isAddingJwtDigest}
                  onClick={handleAddJwtDigest}
                />
              </HStack>
              {data.trustedJwtDigests.length === 0 ?
                <EmptyState
                  title="No trusted JWT digests"
                  description="Generate a digest on the Codex PC, then register it here."
                />
              : <DataTable
                  data={data.trustedJwtDigests as Array<TrustedJwtDigestRow>}
                  columns={trustedJwtDigestColumns}
                  idKey="id"
                />
              }
            </VStack>
          </Card>
        </VStack>
      : null}
    </Page>
  )
}
