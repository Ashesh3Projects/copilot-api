import type { ReactNode } from "react"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Center } from "@astryxdesign/core/Center"
import { VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useState } from "react"

import { api, authProbe, clearLegacyCredentials } from "./lib/api"

interface AdminAuthStatus {
  configured: boolean
  gatewayConfigured: boolean
  passwordManagedExternally: boolean
}

type GateStatus = "checking" | "authed" | "login" | "setup"

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>("checking")
  const [gatewayKey, setGatewayKey] = useState("")
  const [setupCode, setSetupCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    clearLegacyCredentials()
    let cancelled = false
    authProbe()
      .then(() => {
        if (!cancelled) setStatus("authed")
      })
      .catch(async () => {
        try {
          const authStatus = await api<AdminAuthStatus>(
            "GET",
            "/dashboard/auth/status",
          )
          if (!cancelled) {
            setStatus(authStatus.configured ? "login" : "setup")
          }
        } catch {
          if (!cancelled) {
            setStatus("login")
            setError("Unable to load administrator authentication status.")
          }
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleConnect = async () => {
    setError(undefined)
    if (status === "setup" && password !== confirmation) {
      setError("Passwords do not match.")
      return
    }
    setIsConnecting(true)
    try {
      await api(
        "POST",
        status === "setup" ? "/dashboard/auth/setup" : "/dashboard/auth/login",
        { gatewayKey, password, ...(status === "setup" ? { setupCode } : {}) },
      )
      setGatewayKey("")
      setSetupCode("")
      setPassword("")
      setConfirmation("")
      setStatus("authed")
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Authentication failed",
      )
    } finally {
      setIsConnecting(false)
    }
  }

  if (status === "authed") return <>{children}</>

  if (status === "checking") {
    return (
      <Center height="100dvh">
        <Text color="secondary">Checking administrator session...</Text>
      </Center>
    )
  }

  return (
    <Center height="100dvh">
      <Card width={420}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Copilot API</Heading>
            <Text color="secondary">
              {status === "setup" ?
                "Create the administrator password"
              : "Sign in to the administrator dashboard"}
            </Text>
          </VStack>

          {error ?
            <Banner status="error" title={error} />
          : null}

          {status === "setup" ?
            <VStack gap={2}>
              <Text color="secondary">
                Run copilot-api admin --setup-code on the server, then enter the
                one-use code. Choose a gateway key for your API clients.
              </Text>
              <TextInput
                type="password"
                label="Setup code"
                value={setupCode}
                onChange={setSetupCode}
                placeholder="One-use setup code"
              />
            </VStack>
          : null}

          <TextInput
            type="password"
            label="Gateway key"
            value={gatewayKey}
            onChange={setGatewayKey}
            placeholder="Enter the gateway key"
            hasAutoFocus
          />
          {status === "setup" ?
            <>
              <Button
                label="Generate a random gateway key"
                variant="secondary"
                onClick={() =>
                  setGatewayKey(
                    crypto.randomUUID().replaceAll("-", "")
                      + crypto.randomUUID().replaceAll("-", ""),
                  )
                }
              />
              <Text color="secondary">
                Save this key in your password manager before completing setup.
                Use a long random API secret, not a memorable password. Imported
                existing keys stay compatible.
              </Text>
              {gatewayKey ?
                <TextInput
                  label="Gateway key to save"
                  value={gatewayKey}
                  onChange={() => {}}
                />
              : null}
            </>
          : null}
          <TextInput
            type="password"
            label={status === "setup" ? "New admin password" : "Admin password"}
            value={password}
            onChange={setPassword}
            placeholder={
              status === "setup" ? "At least 4 characters" : "Enter password"
            }
          />
          {status === "setup" ?
            <TextInput
              type="password"
              label="Confirm admin password"
              value={confirmation}
              onChange={setConfirmation}
              placeholder="Repeat password"
            />
          : null}

          <Button
            label={status === "setup" ? "Create administrator" : "Sign in"}
            variant="primary"
            isLoading={isConnecting}
            isDisabled={
              gatewayKey.trim().length === 0
              || password.length === 0
              || (status === "setup"
                && (confirmation.length === 0 || setupCode.trim().length === 0))
            }
            onClick={() => void handleConnect()}
          />
        </VStack>
      </Card>
    </Center>
  )
}
