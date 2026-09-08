import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import { useToast } from "../lib/toast"

export function DatabaseBackup() {
  const toast = useToast()
  const [currentPassword, setCurrentPassword] = useState("")
  const [backupPassword, setBackupPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  async function download() {
    setBusy(true)
    try {
      const csrf = document.cookie
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("__Host-copilot_admin_csrf="))
        ?.split("=")
        .slice(1)
        .join("=")
      const response = await fetch("/dashboard/api/settings/backup", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "x-copilot-csrf": csrf } : {}),
        },
        body: JSON.stringify({ currentPassword, backupPassword }),
      })
      if (!response.ok)
        throw new Error(
          "Backup failed. Check your password and database connection.",
        )
      const blob = await response.blob()
      const href = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = href
      link.download =
        response.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "copilot-api-backup.capi"
      link.click()
      URL.revokeObjectURL(href)
      setCurrentPassword("")
      setBackupPassword("")
      setConfirm("")
      toast.success("Encrypted backup downloaded")
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Backup failed")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <VStack gap={3}>
        <Heading level={3}>Encrypted database backup</Heading>
        <Text color="secondary">
          Includes stored accounts, credentials, settings and history. Restore
          into an empty local or Turso database with the storage restore
          command.
        </Text>
        <Banner
          status="info"
          title="Keep the backup password"
          description="It is not stored by the gateway. The configuration export is redacted and cannot restore your credentials."
        />
        <TextInput
          type="password"
          label="Current administrator password"
          value={currentPassword}
          onChange={setCurrentPassword}
        />
        <TextInput
          type="password"
          label="Backup password"
          value={backupPassword}
          onChange={setBackupPassword}
        />
        <TextInput
          type="password"
          label="Confirm backup password"
          value={confirm}
          onChange={setConfirm}
        />
        <Button
          label="Download encrypted backup"
          variant="secondary"
          isLoading={busy}
          isDisabled={
            busy
            || !currentPassword
            || !backupPassword
            || backupPassword !== confirm
          }
          onClick={() => void download()}
        />
      </VStack>
    </Card>
  )
}
