import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import { api, get, put } from "../lib/api"
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
const root = "/dashboard/api/credentials"
const load = async () => {
  const [gateway, groq] = await Promise.all([
    get<{ credentials: Array<Credential>; revision: number }>(
      `${root}/gateway`,
    ),
    get<{ apiKeyConfigured: boolean }>(`${root}/groq`),
  ])
  return {
    credentials: gateway.credentials,
    revision: gateway.revision,
    groq: groq.apiKeyConfigured,
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
              <HStack
                key={`${key.id}:${data.revision}:${revealGeneration}`}
                gap={3}
                hAlign="between"
                vAlign="center"
                wrap="wrap"
              >
                <SecretValue
                  label={key.label}
                  maskedValue={key.maskedValue}
                  revealPath={`${root}/gateway/${encodeURIComponent(key.id)}/reveal`}
                />
                <ConfirmButton
                  label="Delete"
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
              </HStack>
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
