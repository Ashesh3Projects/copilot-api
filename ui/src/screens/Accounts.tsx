import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useState } from "react"

import { ConfirmButton, EmptyState } from "../components/common"
import { Page } from "../components/Page"
import { RefreshCwIcon } from "../icons"
import {
  refreshModelsSummary,
  type AccountModelRefreshBatch,
} from "../lib/account-model-refresh"
import { api, del, get, post } from "../lib/api"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

interface Account {
  id: number
  instanceDomain: string
  login: string | null
  label: string | null
  enabled: boolean
  deleting: boolean
  healthy: boolean
  modelCount: number
}
interface AccountList {
  accounts: Array<Account>
  revision: number
}
interface DeviceLogin {
  id: string
  status: string
  userCode?: string
  verificationUri?: string
  intervalSeconds: number
  expiresAt: number
  accountId: number | null
}
const root = "/dashboard/api/accounts"
const load = () => get<AccountList>(root)

function accountBadge(account: Account): {
  variant: "neutral" | "success" | "warning"
  label: string
} {
  if (account.deleting) return { variant: "neutral", label: "Removing" }
  if (!account.enabled) return { variant: "warning", label: "Disabled" }
  if (account.healthy) return { variant: "success", label: "Ready" }
  return { variant: "warning", label: "Needs attention" }
}
export default function AccountsScreen() {
  const { data, error, loading, reload } = useAsyncData(load, [])
  const toast = useToast()
  const [domain, setDomain] = useState("github.com")
  const [label, setLabel] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState<string>()
  const [login, setLogin] = useState<DeviceLogin>()
  const [refreshBatch, setRefreshBatch] = useState<AccountModelRefreshBatch>()
  const [resumeId, setResumeId] = useState("")
  const [edit, setEdit] = useState<number>()
  const [replacement, setReplacement] = useState("")

  const mutate = <T,>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => api<T>(method, path, body, { expectedRevision: data?.revision })
  async function act(
    id: string,
    work: () => Promise<unknown>,
    message: string,
  ) {
    setBusy(id)
    try {
      await work()
      toast.success(message)
      reload()
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Account operation failed",
      )
      reload()
    } finally {
      setBusy(undefined)
    }
  }

  async function refreshModels(id?: number) {
    setBusy(id === undefined ? "refresh-all" : `refresh-${id}`)
    try {
      if (id === undefined) {
        const result = await mutate<AccountModelRefreshBatch>(
          "POST",
          `${root}/refresh-models`,
        )
        setRefreshBatch(result)
        if (result.failed) toast.error(refreshModelsSummary(result))
        else toast.success(refreshModelsSummary(result))
      } else {
        const result = await mutate<{ modelCount: number }>(
          "POST",
          `${root}/${id}/refresh-models`,
        )
        toast.success(`Account ${id}: refreshed ${result.modelCount} models`)
      }
    } catch (caught) {
      toast.error(
        caught instanceof Error ?
          caught.message
        : "Model refresh failed. The last catalog was retained.",
      )
    } finally {
      setBusy(undefined)
      reload()
    }
  }
  useEffect(() => {
    if (!login || !["pending", "polling"].includes(login.status)) return
    let canceled = false
    const timer = setTimeout(
      () => {
        get<DeviceLogin>(`${root}/device-login/${login.id}`)
          .then((next) => {
            if (canceled) return
            setLogin(next)
            if (next.status === "complete" || next.status === "completed")
              reload()
          })
          .catch((caught: unknown) => {
            if (!canceled) {
              toast.error(
                caught instanceof Error ?
                  caught.message
                : "Sign-in check failed",
              )
              setLogin(undefined)
            }
          })
      },
      Math.max(1, login.intervalSeconds) * 1000,
    )
    return () => {
      canceled = true
      clearTimeout(timer)
    }
  }, [login, reload, toast])

  return (
    <Page
      kicker="Control"
      title="GitHub accounts"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <Button
          label="Refresh all models"
          icon={<RefreshCwIcon />}
          variant="secondary"
          isDisabled={
            Boolean(busy)
            || !data?.accounts.some((account) => !account.deleting)
          }
          isLoading={busy === "refresh-all"}
          onClick={() => void refreshModels()}
        />
      }
    >
      <VStack gap={4}>
        {error ?
          <Banner
            status="error"
            title="Could not load accounts"
            description={error.message}
          />
        : null}
        {refreshBatch ?
          <Banner
            status={refreshBatch.failed ? "warning" : "info"}
            title={refreshModelsSummary(refreshBatch)}
            description={refreshBatch.results
              .map(
                (result) =>
                  `#${result.id}: ${result.status === "refreshed" ? `${result.modelCount} models` : result.error || "Refresh failed; previous catalog retained"}`,
              )
              .join(" · ")}
          />
        : null}
        <Card>
          <VStack gap={3}>
            <Heading level={3}>Connect an account</Heading>
            <Text color="secondary">
              Connect GitHub.com or your Enterprise Cloud domain. A failed
              connection stays separate from your other accounts.
            </Text>
            <HStack gap={3} wrap="wrap" vAlign="end">
              <TextInput
                label="GitHub domain"
                value={domain}
                onChange={setDomain}
                placeholder="github.com or tenant.ghe.com"
              />
              <TextInput
                label="Label (optional)"
                value={label}
                onChange={setLabel}
              />
              <Button
                label="Sign in with GitHub"
                variant="primary"
                isDisabled={Boolean(busy)}
                isLoading={busy === "signin"}
                onClick={() =>
                  void act(
                    "signin",
                    async () => {
                      setLogin(
                        await post<DeviceLogin>(`${root}/device-login`, {
                          instanceDomain: domain,
                          label,
                        }),
                      )
                    },
                    "Sign-in started",
                  )
                }
              />
            </HStack>
            <TextInput
              label="Or paste a GitHub OAuth token"
              type="password"
              value={token}
              onChange={setToken}
              placeholder="Token is stored in your configured database"
            />
            <Button
              label="Add token"
              variant="secondary"
              isDisabled={Boolean(busy) || !token.trim()}
              isLoading={busy === "add"}
              onClick={() =>
                void act(
                  "add",
                  async () => {
                    await post(root, { instanceDomain: domain, label, token })
                    setToken("")
                    setLabel("")
                  },
                  "Account connected",
                )
              }
            />
            <HStack gap={2} wrap="wrap" vAlign="end">
              <TextInput
                label="Resume sign-in ID after reload"
                value={resumeId}
                onChange={setResumeId}
              />
              <Button
                label="Resume sign-in"
                variant="secondary"
                isDisabled={Boolean(busy) || !resumeId.trim()}
                onClick={() =>
                  void act(
                    "resume",
                    async () => {
                      setLogin(
                        await get<DeviceLogin>(
                          `${root}/device-login/${encodeURIComponent(resumeId.trim())}`,
                        ),
                      )
                    },
                    "Sign-in resumed",
                  )
                }
              />
            </HStack>
            {login ?
              <Banner
                status={
                  ["denied", "expired", "failed"].includes(login.status) ?
                    "error"
                  : "info"
                }
                title={`GitHub sign-in: ${login.status}`}
                description={
                  login.userCode ?
                    `Enter code ${login.userCode} at GitHub. Resume ID: ${login.id}. This code expires at ${new Date(login.expiresAt).toLocaleTimeString()}.`
                  : undefined
                }
                endContent={
                  <HStack gap={2}>
                    {login.verificationUri ?
                      <a
                        href={login.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open GitHub
                      </a>
                    : null}
                    <Button
                      label="Dismiss"
                      variant="secondary"
                      onClick={() =>
                        void act(
                          "cancel",
                          async () => {
                            await del(`${root}/device-login/${login.id}`)
                            setLogin(undefined)
                          },
                          "Sign-in dismissed",
                        )
                      }
                    />
                  </HStack>
                }
              />
            : null}
          </VStack>
        </Card>
        <Banner
          status="info"
          title="Account changes affect routing"
          description="Changing eligible accounts can move later turns of conversations that use ordinary session routing. Requests already running retain their selected credentials."
        />
        {data?.accounts.length === 0 ?
          <EmptyState
            title="No GitHub accounts"
            description="Connect an account above. Custom providers can be configured independently."
          />
        : null}
        {data?.accounts.map((account) => (
          <Card key={account.id}>
            <VStack gap={3}>
              <HStack gap={2} wrap="wrap" vAlign="center">
                <Heading level={3}>
                  {account.label || account.login || `Account ${account.id}`}
                </Heading>
                <Badge {...accountBadge(account)} />
              </HStack>
              <Text color="secondary">
                {account.instanceDomain} · #{account.id} · {account.modelCount}{" "}
                models
              </Text>
              <HStack gap={2} wrap="wrap">
                <Button
                  label={account.enabled ? "Disable" : "Enable"}
                  variant="secondary"
                  isDisabled={Boolean(busy) || account.deleting}
                  onClick={() =>
                    void act(
                      String(account.id),
                      () =>
                        mutate("PATCH", `${root}/${account.id}`, {
                          enabled: !account.enabled,
                        }),
                      "Account updated",
                    )
                  }
                />
                <Button
                  label="Refresh models"
                  icon={<RefreshCwIcon />}
                  variant="secondary"
                  isDisabled={Boolean(busy) || account.deleting}
                  isLoading={busy === `refresh-${account.id}`}
                  onClick={() => void refreshModels(account.id)}
                />
                <Button
                  label="Reconnect"
                  variant="secondary"
                  isDisabled={account.deleting}
                  onClick={() => {
                    setEdit(edit === account.id ? undefined : account.id)
                    setReplacement("")
                  }}
                />
                <ConfirmButton
                  label="Remove"
                  confirmTitle="Remove GitHub account"
                  confirmDescription="New requests stop using this account. Its stored credential is removed after active requests finish. Existing conversations pinned to it may no longer continue."
                  onConfirm={() =>
                    act(
                      String(account.id),
                      () => mutate("DELETE", `${root}/${account.id}`),
                      "Account removal started",
                    )
                  }
                />
              </HStack>
              {edit === account.id ?
                <HStack gap={2} wrap="wrap" vAlign="end">
                  <TextInput
                    type="password"
                    label="Replacement OAuth token for this same account"
                    value={replacement}
                    onChange={setReplacement}
                  />
                  <Button
                    label="Save credential"
                    variant="primary"
                    isDisabled={Boolean(busy) || !replacement.trim()}
                    onClick={() =>
                      void act(
                        String(account.id),
                        async () => {
                          await mutate(
                            "PUT",
                            `${root}/${account.id}/credential`,
                            { token: replacement },
                          )
                          setEdit(undefined)
                          setReplacement("")
                        },
                        "Credential updated",
                      )
                    }
                  />
                </HStack>
              : null}
            </VStack>
          </Card>
        ))}
      </VStack>
    </Page>
  )
}
