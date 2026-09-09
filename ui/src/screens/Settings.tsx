import type { SelectorOptionType } from "@astryxdesign/core/Selector"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Selector } from "@astryxdesign/core/Selector"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Table, pixel, proportional } from "@astryxdesign/core/Table"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useRef, useState } from "react"

import {
  ConfirmButton,
  IconAction,
  MonoText,
  RelTime,
  TogglePill,
} from "../components/common"
import { DatabaseBackup } from "../components/DatabaseBackup"
import { Page } from "../components/Page"
import { StoredCredentials } from "../components/StoredCredentials"
import { PlusIcon, Trash2Icon } from "../icons"
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
import "./settings.css"

type IpRow = IpAllowlistEntry & Record<string, unknown>
type TrustedJwtDigestRow = TrustedJwtDigestEntry & Record<string, unknown>

function loadBundle(): Promise<SettingsBundle> {
  return loadSettingsBundle(get)
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback
}

function ServerStatus({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <Badge
      variant={enabled ? "success" : "neutral"}
      label={`${label}: ${enabled ? "Yes" : "No"}`}
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
      header: "IP address",
      width: proportional(1),
      renderCell: (item) => (
        <div className="settings-entry-details">
          <MonoText>{item.ip}</MonoText>
          <Text type="supporting" color="secondary">
            Source: {item.source}
          </Text>
          <HStack gap={1} wrap="wrap">
            <Text type="supporting" color="secondary">
              Last seen:
            </Text>
            {item.lastSeenAt ?
              <RelTime ts={item.lastSeenAt} />
            : <Text type="supporting">—</Text>}
          </HStack>
        </div>
      ),
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
      key: "actions",
      header: "",
      width: pixel(44),
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
      renderCell: (item) => (
        <div className="settings-entry-details">
          <Text weight="medium">{item.label}</Text>
          <MonoText>{item.digest}</MonoText>
          <HStack gap={1} wrap="wrap">
            <Text type="supporting" color="secondary">
              Created:
            </Text>
            <RelTime ts={item.createdAt} />
          </HStack>
        </div>
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
      key: "actions",
      header: "",
      width: pixel(44),
      align: "end",
      renderCell: (item) => (
        <ConfirmButton
          label={`Delete ${item.label}`}
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
        <div className="settings-layout">
          <Card className="settings-card settings-summary">
            <VStack gap={3}>
              <Heading level={2}>Server Configuration</Heading>
              <dl className="settings-server-facts">
                <div>
                  <dt>Version</dt>
                  <dd>{data.settings.version}</dd>
                </div>
                <div>
                  <dt>Port</dt>
                  <dd>{data.settings.port}</dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>
                    <MonoText>{data.settings.host}</MonoText>
                  </dd>
                </div>
                <div>
                  <dt>Database</dt>
                  <dd>
                    <MonoText>{data.settings.dataDir}</MonoText>
                  </dd>
                </div>
              </dl>
              <HStack gap={2} wrap="wrap" vAlign="center">
                <ServerStatus
                  label="API key configured"
                  enabled={data.settings.authEnabled}
                />
                <ServerStatus
                  label="Multi-token mode"
                  enabled={data.settings.multiToken}
                />
                <ServerStatus
                  label="Sentry"
                  enabled={data.settings.sentryEnabled}
                />
                <ServerStatus
                  label="Groq"
                  enabled={data.settings.groqEnabled}
                />
                <ServerStatus
                  label="Debug mode"
                  enabled={data.settings.debug}
                />
                <ServerStatus
                  label="Verbose logging"
                  enabled={data.settings.verbose}
                />
              </HStack>
            </VStack>
          </Card>

          <div className="settings-columns">
            <section
              className="settings-column settings-credentials"
              aria-labelledby="settings-credentials-heading"
            >
              <Heading level={2} id="settings-credentials-heading">
                Credentials &amp; speech
              </Heading>
              <StoredCredentials />
              <Card className="settings-card">
                <VStack gap={3}>
                  <Heading level={3}>Codex Dictation Cleanup</Heading>
                  <Text type="supporting" color="secondary">
                    Used by /codex/responses
                  </Text>
                  <Selector
                    label="Cleanup model"
                    options={cleanupOptions}
                    value={cleanupValue}
                    onChange={setCleanupDraft}
                    width="100%"
                  />
                  <HStack gap={2} wrap="wrap">
                    <Button
                      label="Save"
                      variant="secondary"
                      isLoading={isSavingCleanup}
                      onClick={handleSaveCleanup}
                    />
                  </HStack>
                </VStack>
              </Card>
            </section>

            <section
              className="settings-column settings-access"
              aria-labelledby="settings-access-heading"
            >
              <Heading level={2} id="settings-access-heading">
                Access controls
              </Heading>
              <Card className="settings-card">
                <VStack gap={3}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Heading level={3}>IP Allowlist</Heading>
                    <Badge variant="neutral" label="Used by /transcribe" />
                  </HStack>
                  <HStack gap={2} vAlign="end" wrap="wrap">
                    <div className="settings-inline-field">
                      <TextInput
                        label="IP address"
                        value={newIp}
                        onChange={setNewIp}
                        placeholder={ipAddressPlaceholder(data.currentIp)}
                        width="100%"
                      />
                    </div>
                    <Button
                      label="Add"
                      variant="secondary"
                      icon={<PlusIcon />}
                      isLoading={isAddingIp}
                      isDisabled={isAddingIp}
                      onClick={handleAddIp}
                    />
                  </HStack>
                  <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
                    <Text type="supporting" id="settings-ip-list-label">
                      {data.allowlist.length} IP{" "}
                      {data.allowlist.length === 1 ? "address" : "addresses"}
                      {` · ${data.allowlist.filter((entry) => entry.enabled).length} enabled`}
                    </Text>
                    {data.allowlist.length > 0 ?
                      <ConfirmButton
                        label="Clear all"
                        size="sm"
                        confirmTitle="Clear IP allowlist"
                        confirmDescription="Remove every IP address from the allowlist?"
                        confirmActionLabel="Clear all"
                        onConfirm={handleClearAllowlist}
                      />
                    : null}
                  </HStack>
                  {data.allowlist.length === 0 ?
                    <div className="settings-empty-list">
                      <VStack gap={1}>
                        <Text weight="medium">No allowlisted IPs</Text>
                        <Text type="supporting" color="secondary">
                          Add an IP address to allow access to /transcribe.
                        </Text>
                      </VStack>
                    </div>
                  : <div
                      className="settings-access-list"
                      role="region"
                      aria-labelledby="settings-ip-list-label"
                      tabIndex={0}
                    >
                      <Table
                        tableProps={{ "aria-label": "IP allowlist" }}
                        data={data.allowlist as Array<IpRow>}
                        columns={ipColumns}
                        idKey="ip"
                        density="compact"
                        textOverflow="wrap"
                        dividers="rows"
                        hasHover
                      />
                    </div>
                  }
                </VStack>
              </Card>

              <Card className="settings-card">
                <VStack gap={3}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Heading level={3}>Trusted JWT Digests</Heading>
                    <Badge variant="neutral" label="Inference only" />
                  </HStack>
                  <Text type="supporting" color="secondary">
                    Generate a local Codex ChatGPT auth file with the repository
                    PowerShell script, then paste only its SHA-256 digest here.
                  </Text>
                  <TextInput
                    label="Device label"
                    value={newJwtLabel}
                    onChange={setNewJwtLabel}
                    width="100%"
                  />
                  <TextInput
                    label="SHA-256 digest"
                    value={newJwtDigest}
                    onChange={setNewJwtDigest}
                    width="100%"
                  />
                  <HStack gap={2} hAlign="between" vAlign="center" wrap="wrap">
                    <Text type="supporting" id="settings-jwt-list-label">
                      {data.trustedJwtDigests.length} trusted{" "}
                      {data.trustedJwtDigests.length === 1 ?
                        "digest"
                      : "digests"}
                      {` · ${data.trustedJwtDigests.filter((entry) => entry.enabled).length} enabled`}
                    </Text>
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
                    <div className="settings-empty-list">
                      <VStack gap={1}>
                        <Text weight="medium">No trusted JWT digests</Text>
                        <Text type="supporting" color="secondary">
                          Generate a digest on the Codex PC, then register it
                          here.
                        </Text>
                      </VStack>
                    </div>
                  : <div
                      className="settings-access-list"
                      role="region"
                      aria-labelledby="settings-jwt-list-label"
                      tabIndex={0}
                    >
                      <Table
                        tableProps={{ "aria-label": "Trusted JWT digests" }}
                        data={
                          data.trustedJwtDigests as Array<TrustedJwtDigestRow>
                        }
                        columns={trustedJwtDigestColumns}
                        idKey="id"
                        density="compact"
                        textOverflow="wrap"
                        dividers="rows"
                        hasHover
                      />
                    </div>
                  }
                </VStack>
              </Card>
            </section>

            <section
              className="settings-column settings-administration"
              aria-labelledby="settings-administration-heading"
            >
              <Heading level={2} id="settings-administration-heading">
                Administration &amp; backup
              </Heading>
              <Card className="settings-card">
                <VStack gap={3}>
                  <Heading level={3}>Administrator password</Heading>
                  <Text type="supporting" color="secondary">
                    Changing your password signs out other administrator
                    sessions. API client credentials stay active.
                  </Text>
                  <TextInput
                    type="password"
                    label="Current password"
                    value={currentPassword}
                    onChange={setCurrentPassword}
                    width="100%"
                  />
                  <TextInput
                    type="password"
                    label="New password"
                    value={newPassword}
                    onChange={setNewPassword}
                    width="100%"
                  />
                  <TextInput
                    type="password"
                    label="Confirm new password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    width="100%"
                  />
                  <HStack gap={2} wrap="wrap">
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
                  </HStack>
                </VStack>
              </Card>
              <DatabaseBackup onExport={() => void handleExport()} />
            </section>
          </div>
        </div>
      : null}
    </Page>
  )
}
