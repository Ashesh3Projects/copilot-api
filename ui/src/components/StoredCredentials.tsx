import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import { del, get, post, put } from "../lib/api"
import { gatewayCreationFeedback } from "../lib/gateway-creation"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"
import { ConfirmButton } from "./common"

interface Credential {
  id: string
  label: string
  createdAt: number
  revokedAt: number | null
}
const root = "/dashboard/api/credentials"
const load = async () => {
  const [gateway, groq] = await Promise.all([
    get<{ credentials: Array<Credential> }>(`${root}/gateway`),
    get<{ apiKeyConfigured: boolean }>(`${root}/groq`),
  ])
  return { credentials: gateway.credentials, groq: groq.apiKeyConfigured }
}
export function StoredCredentials() {
  const { data, error, reload } = useAsyncData(load, [])
  const toast = useToast()
  const [label, setLabel] = useState("")
  const [created, setCreated] = useState<string>()
  const [lostKey, setLostKey] = useState<{ id: string; label: string }>()
  const [groq, setGroq] = useState("")
  const [busy, setBusy] = useState(false)
  async function run(work: () => Promise<void>) {
    setBusy(true)
    try {
      await work()
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Credential update failed",
      )
      reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <VStack gap={4}>
      {error ?
        <Banner
          status="error"
          title="Could not load credentials"
          description={error.message}
        />
      : null}
      <Card>
        <VStack gap={3}>
          <Heading level={3}>Gateway credentials</Heading>
          <Text color="secondary">
            Use these keys in API clients and dashboard sign-in. Newly created
            keys are displayed once.
          </Text>
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput
              label="Key label"
              value={label}
              onChange={setLabel}
              placeholder="Laptop, automation…"
            />
            <Button
              label="Create key"
              variant="secondary"
              isDisabled={busy || !label.trim()}
              onClick={() =>
                void run(async () => {
                  const result = await post<{
                    id: string
                    label: string
                    credential?: string
                  }>(`${root}/gateway`, { label })
                  const feedback = gatewayCreationFeedback(result)
                  setCreated(feedback.credential)
                  if (feedback.lost) setLostKey(feedback.lost)
                  setLabel("")
                })
              }
            />
          </HStack>
          {lostKey ?
            <Banner
              status="warning"
              title="The key was created, but its value was not received"
              description={`The value for "${lostKey.label}" cannot be recovered. Create and save a replacement, then revoke this unused key. Existing clients are unchanged.`}
              endContent={
                <ConfirmButton
                  label="Revoke unused key"
                  confirmTitle="Revoke the key whose value was lost"
                  confirmDescription="Only this newly created key is revoked. Keep at least one other active gateway key."
                  onConfirm={() =>
                    run(async () => {
                      await del(`${root}/gateway/${lostKey.id}`)
                      setLostKey(undefined)
                      toast.success("Unused key revoked")
                    })
                  }
                />
              }
            />
          : null}
          {created ?
            <VStack gap={2}>
              <Banner
                status="warning"
                title="Save this key now"
                description="It cannot be displayed again after you dismiss it."
              />
              <TextInput
                label="New gateway key"
                value={created}
                onChange={() => {}}
              />
              <Button
                label="I saved it"
                variant="secondary"
                onClick={() => setCreated(undefined)}
              />
            </VStack>
          : null}
          {data?.credentials
            .filter((key) => key.revokedAt === null)
            .map((key) => (
              <HStack key={key.id} gap={2} hAlign="between" wrap="wrap">
                <Text>{key.label}</Text>
                <ConfirmButton
                  label="Revoke"
                  confirmTitle="Revoke gateway credential"
                  confirmDescription="Clients using this key lose access. The last active gateway credential cannot be revoked."
                  onConfirm={() =>
                    run(async () => {
                      await del(`${root}/gateway/${key.id}`)
                      toast.success("Credential revoked")
                    })
                  }
                />
              </HStack>
            ))}
        </VStack>
      </Card>
      <Card>
        <VStack gap={3}>
          <Heading level={3}>Speech transcription</Heading>
          <Text color="secondary">
            {data?.groq ?
              "A Groq key is stored. Leave blank to retain it."
            : "Add a Groq API key to enable transcription."}
          </Text>
          <TextInput
            type="password"
            label="Groq API key"
            value={groq}
            onChange={setGroq}
          />
          <HStack gap={2} wrap="wrap">
            <Button
              label="Save Groq key"
              variant="secondary"
              isDisabled={busy || !groq.trim()}
              onClick={() =>
                void run(async () => {
                  await put(`${root}/groq`, { apiKey: groq })
                  setGroq("")
                  toast.success("Groq key saved")
                })
              }
            />
            {data?.groq ?
              <ConfirmButton
                label="Remove key"
                confirmTitle="Remove Groq key"
                confirmDescription="Speech transcription will be unavailable until a new key is saved."
                onConfirm={() =>
                  run(async () => {
                    await put(`${root}/groq`, { clearApiKey: true })
                    toast.success("Groq key removed")
                  })
                }
              />
            : null}
          </HStack>
        </VStack>
      </Card>
    </VStack>
  )
}
