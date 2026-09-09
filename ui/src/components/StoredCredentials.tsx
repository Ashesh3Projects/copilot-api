import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import { Trash2Icon } from "../icons"
import { api, get } from "../lib/api"
import { generateGatewayKey } from "../lib/gateway-creation"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"
import { ConfirmButton } from "./common"
import { SecretInput } from "./SecretInput"
import { SecretValue } from "./SecretValue"

interface Credential {
  id: string
  label: string
  createdAt: number
  revokedAt: number | null
  maskedValue: string
}
interface GroqStatus {
  apiKeyConfigured: boolean
  maskedValue: string | null
  revision: number
}
const root = "/dashboard/api/credentials"
const load = async () => {
  const [gateway, groq] = await Promise.all([
    get<{ credentials: Array<Credential>; revision: number }>(
      `${root}/gateway`,
    ),
    get<GroqStatus>(`${root}/groq`),
  ])
  return {
    credentials: gateway.credentials,
    revision: gateway.revision,
    groq,
  }
}
export function StoredCredentials() {
  const { data, error, reload } = useAsyncData(load, [])
  const toast = useToast()
  const [label, setLabel] = useState("")
  const [credential, setCredential] = useState("")
  const [revealGeneration, setRevealGeneration] = useState(0)
  const [groq, setGroq] = useState("")
  const [busy, setBusy] = useState(false)
  async function run(work: () => Promise<void>) {
    setBusy(true)
    try {
      await work()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Credential update failed",
      )
    } finally {
      setRevealGeneration((value) => value + 1)
      reload()
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
            Use these keys in API clients and dashboard sign-in. Add your own
            key or generate one, and reveal or copy stored keys whenever needed.
          </Text>
          <HStack gap={2} wrap="wrap" vAlign="end">
            <TextInput
              label="Key label"
              value={label}
              onChange={setLabel}
              placeholder="Laptop, automation…"
            />
            <SecretInput
              label="Key"
              value={credential}
              onChange={setCredential}
              placeholder="Enter a custom API key"
              isDisabled={busy}
              isRequired
            />
            <Button
              label="Generate"
              variant="secondary"
              isDisabled={busy}
              onClick={() => setCredential(generateGatewayKey())}
            />
            <Button
              label="Add key"
              variant="primary"
              isDisabled={busy || !data || !label.trim() || !credential.trim()}
              onClick={() =>
                void run(async () => {
                  await api(
                    "POST",
                    `${root}/gateway`,
                    { label, credential },
                    {
                      expectedRevision: data?.revision,
                    },
                  )
                  setLabel("")
                  setCredential("")
                  toast.success("Key added")
                })
              }
            />
          </HStack>
          {data?.credentials
            .filter((key) => key.revokedAt === null)
            .map((key) => (
              <SecretValue
                key={`${key.id}:${data.revision}:${revealGeneration}`}
                label={key.label}
                maskedValue={key.maskedValue}
                revealPath={`${root}/gateway/${encodeURIComponent(key.id)}/reveal`}
                actions={
                  <ConfirmButton
                    label={`Delete ${key.label}`}
                    isIconOnly
                    icon={<Trash2Icon />}
                    size="sm"
                    confirmActionLabel="Delete key"
                    confirmTitle="Delete gateway key"
                    confirmDescription="This permanently removes the key. API clients using it will lose access."
                    isDisabled={busy || data.credentials.length <= 1}
                    onConfirm={() =>
                      run(async () => {
                        await api(
                          "DELETE",
                          `${root}/gateway/${encodeURIComponent(key.id)}`,
                          undefined,
                          {
                            expectedRevision: data.revision,
                          },
                        )
                        toast.success("Key deleted")
                      })
                    }
                  />
                }
              />
            ))}
          {data?.credentials.length === 1 ?
            <Text type="supporting" color="secondary">
              Create a replacement before deleting your last gateway key.
            </Text>
          : null}
        </VStack>
      </Card>
      <Card>
        <VStack gap={3}>
          <Heading level={3}>Speech transcription</Heading>
          <Text color="secondary">
            {data?.groq.apiKeyConfigured ?
              "Reveal or copy the current key below. Enter a replacement only when you want to change it."
            : "Add a Groq API key to enable transcription."}
          </Text>
          {data?.groq.maskedValue ?
            <SecretValue
              key={`groq:${data.groq.revision}:${revealGeneration}`}
              label="Current Groq key"
              maskedValue={data.groq.maskedValue}
              revealPath={`${root}/groq/reveal`}
              actions={
                <ConfirmButton
                  label="Remove Groq key"
                  isIconOnly
                  icon={<Trash2Icon />}
                  size="sm"
                  isDisabled={busy}
                  confirmTitle="Remove Groq key"
                  confirmDescription="Speech transcription will be unavailable until a new key is saved."
                  onConfirm={() =>
                    run(async () => {
                      await api(
                        "PUT",
                        `${root}/groq`,
                        { clearApiKey: true },
                        {
                          expectedRevision: data.groq.revision,
                        },
                      )
                      toast.success("Groq key removed")
                    })
                  }
                />
              }
            />
          : null}
          <SecretInput
            label={
              data?.groq.apiKeyConfigured ?
                "Replacement Groq API key"
              : "Groq API key"
            }
            value={groq}
            onChange={setGroq}
            isDisabled={busy}
          />
          <HStack gap={2} wrap="wrap">
            <Button
              label="Save Groq key"
              variant="secondary"
              isDisabled={busy || !groq.trim()}
              onClick={() =>
                void run(async () => {
                  await api(
                    "PUT",
                    `${root}/groq`,
                    { apiKey: groq },
                    {
                      expectedRevision: data?.groq.revision,
                    },
                  )
                  setGroq("")
                  toast.success("Groq key saved")
                })
              }
            />
          </HStack>
        </VStack>
      </Card>
    </VStack>
  )
}
