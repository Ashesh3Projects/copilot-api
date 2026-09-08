import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Switch } from "@astryxdesign/core/Switch"
import { Heading, Text } from "@astryxdesign/core/Text"
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"

import type { CodeMirrorDocumentHandle } from "../components/CodeMirrorDocument"
import type { LlmDebugDetail, ReplayResult } from "../lib/types"

import { ConfirmButton, EmptyState, MonoText } from "../components/common"
import { JsonCodeEditor } from "../components/JsonCodeEditor"
import { Page } from "../components/Page"
import { RequestExportMenu } from "../components/RequestExportMenu"
import { ResponseInspector } from "../components/ResponseInspector"
import { CopyIcon, PlayIcon, RefreshCwIcon } from "../icons"
import { ApiError, get, post } from "../lib/api"
import {
  canEditReplayCapture,
  hasReplacementReplayBody,
} from "../lib/capture-state"
import {
  formatJsonDocument,
  prepareReplayDocument,
  validateReplayDocument,
} from "../lib/json-document"
import { jsonCopyErrorMessage } from "../lib/json-tree"
import {
  acceptReplayResult,
  advanceReplayRun,
  advanceReplaySource,
  classifyReplayResult,
  initialReplayRunState,
  isCurrentReplayRun,
  isSameReplaySource,
  replayErrorMessage,
  replayResponse,
  type AcceptedReplayResult,
  type ReplayRunState,
  type ReplaySourceIdentity,
} from "../lib/replay-result"
import { navigate, useHashRoute } from "../lib/router"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

function loadDetail(id: string): Promise<LlmDebugDetail> {
  return get<LlmDebugDetail>(`/dashboard/api/llm-debug/${id}`)
}

export default function LlmReplayScreen() {
  const { param } = useHashRoute()

  if (!param) {
    return (
      <Page kicker="Monitor" title="LLM Replay">
        <EmptyState
          icon={<PlayIcon />}
          title="No entry selected"
          description="Open a POST /chat/completions or /responses entry from LLM Debug and click Replay there."
          actions={
            <Button
              label="Go to LLM Debug"
              variant="primary"
              onClick={() => navigate("llm-debug")}
            />
          }
        />
      </Page>
    )
  }

  return <LlmReplayView key={param} id={param} />
}

function LlmReplayView({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsyncData(
    () => loadDetail(id),
    [id],
  )
  const toast = useToast()
  const editorRef = useRef<CodeMirrorDocumentHandle>(null)
  const initializedSourceRef = useRef<ReplaySourceIdentity | undefined>(
    undefined,
  )
  const acceptedResultRef = useRef<AcceptedReplayResult | undefined>(undefined)
  const replayRunStateRef = useRef<ReplayRunState>(initialReplayRunState())

  const [body, setBody] = useState("")
  const [originalBody, setOriginalBody] = useState("")
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<AcceptedReplayResult>()
  const [replayError, setReplayError] = useState<string>()
  const [wrap, setWrap] = useState(false)

  const sourceBody = data?.request.body ?? ""
  const sourceId = data?.id
  const renderedSource =
    sourceId === undefined ? undefined : { body: sourceBody, id: sourceId }
  const renderedSourceRef = useRef<ReplaySourceIdentity | undefined>(
    renderedSource,
  )
  renderedSourceRef.current = renderedSource

  useEffect(
    () => () => {
      replayRunStateRef.current = advanceReplaySource(replayRunStateRef.current)
    },
    [],
  )

  useEffect(() => {
    if (
      sourceId === undefined
      || isSameReplaySource(initializedSourceRef.current, sourceId, sourceBody)
    ) {
      return
    }

    initializedSourceRef.current = { body: sourceBody, id: sourceId }
    replayRunStateRef.current = advanceReplaySource(replayRunStateRef.current)
    const preparedBody = prepareReplayDocument(sourceBody)
    // The source record is external state; initialize the local editor session
    // only when its stable id/body pair actually changes.
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setBody(preparedBody)
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setOriginalBody(preparedBody)
    acceptedResultRef.current = undefined
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setResult(undefined)
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setReplayError(undefined)
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setIsRunning(false)
  }, [sourceBody, sourceId])

  const deferredBody = useDeferredValue(body)
  const validation = useMemo(
    () => validateReplayDocument(deferredBody),
    [deferredBody],
  )
  const validationPending = deferredBody !== body
  const replacementReady =
    data?.replayable === true || hasReplacementReplayBody(originalBody, body)
  const canRun =
    validation.ok
    && !validationPending
    && !isRunning
    && replacementReady
    && Boolean(data && canEditReplayCapture(data))
  const diagnostic =
    validationPending || validation.ok ? null : validation.diagnostic
  const dirty = body !== originalBody
  const sourceReady =
    sourceId === id
    && isSameReplaySource(initializedSourceRef.current, sourceId, sourceBody)

  function formatBody(): void {
    const formatted = formatJsonDocument(body)
    if (formatted === null) {
      const currentValidation = validateReplayDocument(body)
      setReplayError(
        currentValidation.ok ?
          "Request body could not be formatted."
        : currentValidation.diagnostic.message,
      )
      editorRef.current?.focus()
      return
    }
    setBody(formatted)
    setReplayError(undefined)
    editorRef.current?.focus()
  }

  function resetBody(): void {
    setBody(originalBody)
    setReplayError(undefined)
    editorRef.current?.focus()
  }

  async function copyRequest(): Promise<void> {
    try {
      await navigator.clipboard.writeText(body)
      toast.success("Copied request")
    } catch (caught) {
      toast.error(jsonCopyErrorMessage(caught))
    }
  }

  async function runReplay(): Promise<void> {
    if (!canRun || !sourceReady) return
    const currentValidation = validateReplayDocument(body)
    if (!currentValidation.ok) {
      setReplayError(currentValidation.diagnostic.message)
      editorRef.current?.focus()
      return
    }

    const source = initializedSourceRef.current
    const currentSource = renderedSourceRef.current
    if (
      !source
      || !currentSource
      || currentSource.id !== id
      || !isSameReplaySource(source, currentSource.id, currentSource.body)
    ) {
      return
    }

    const run = advanceReplayRun(replayRunStateRef.current, source)
    replayRunStateRef.current = run.state
    const isCurrentRun = () => {
      const latestSource = renderedSourceRef.current
      return (
        latestSource !== undefined
        && isCurrentReplayRun(
          run.token,
          replayRunStateRef.current,
          latestSource,
        )
      )
    }

    setIsRunning(true)
    setReplayError(undefined)
    try {
      const replayResult = await post<ReplayResult>(
        `/dashboard/api/llm-debug/${id}/replay`,
        { body },
      )
      if (!isCurrentRun()) return

      const classification = classifyReplayResult(replayResult)
      if (!classification.ok) {
        setReplayError(classification.message)
        return
      }

      const accepted = acceptReplayResult(
        id,
        replayResult,
        acceptedResultRef.current,
      )
      acceptedResultRef.current = accepted
      setResult(accepted)
    } catch (caught) {
      if (!isCurrentRun()) return

      setReplayError(
        caught instanceof ApiError ?
          caught.message
        : replayErrorMessage(caught),
      )
    } finally {
      if (isCurrentRun()) {
        setIsRunning(false)
        editorRef.current?.focus()
      }
    }
  }

  return (
    <Page
      kicker="Monitor"
      title="LLM Replay"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <Button
          label="Back to Debug Log"
          variant="secondary"
          onClick={() => navigate("llm-debug", id)}
        />
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load source entry"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={4}>
          <Skeleton height={120} />
          <Skeleton height={420} index={1} />
        </VStack>
      : null}

      {data ?
        <VStack gap={4}>
          {!data.replayable ?
            <Banner
              status="warning"
              title="Supply a replacement request"
              description="The captured body was redacted, omitted, or interrupted. Review the full request, replace any redacted values, and edit it before running a replay."
            />
          : null}
          <HStack
            className="replay-header"
            gap={3}
            hAlign="between"
            vAlign="center"
            wrap="wrap"
          >
            <HStack gap={3} vAlign="center" wrap="wrap">
              <Badge variant="neutral" label={data.request.method} />
              <MonoText>{data.request.path}</MonoText>
            </HStack>
            <Button
              label="Run Replay"
              variant="primary"
              icon={<PlayIcon />}
              isLoading={isRunning}
              isDisabled={!canRun || !sourceReady}
              onClick={() => void runReplay()}
            />
          </HStack>

          <div className="replay-workspace">
            <Card className="replay-pane replay-request-pane">
              <VStack gap={3}>
                <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
                  <Heading level={3}>Request JSON</Heading>
                  <RequestExportMenu
                    body={body}
                    id={id}
                    isJsonValid={validation.ok && !validationPending}
                    request={data.request}
                    onError={toast.error}
                    onExport={(format) => toast.success(`Exported ${format}`)}
                  />
                </HStack>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Button
                    label="Format JSON"
                    variant="secondary"
                    size="sm"
                    isDisabled={validationPending || !validation.ok}
                    onClick={formatBody}
                  />
                  <Button
                    label="Copy request"
                    variant="secondary"
                    size="sm"
                    icon={<CopyIcon />}
                    onClick={() => void copyRequest()}
                  />
                  <ConfirmButton
                    label="Reset request"
                    confirmTitle="Reset request?"
                    confirmDescription="Discard all edits and restore the captured request body?"
                    confirmActionLabel="Reset"
                    variant="secondary"
                    size="sm"
                    icon={<RefreshCwIcon />}
                    isDisabled={!dirty}
                    onConfirm={resetBody}
                  />
                  <Switch
                    label="Wrap request"
                    value={wrap}
                    onChange={setWrap}
                  />
                </HStack>
                <JsonCodeEditor
                  ref={editorRef}
                  diagnostic={diagnostic}
                  label="Request JSON"
                  value={body}
                  wrap={wrap}
                  onChange={setBody}
                />
              </VStack>
            </Card>

            <Card className="replay-pane replay-result-pane">
              <VStack gap={3}>
                <Heading level={3}>Replay result</Heading>
                {replayError ?
                  <Banner
                    status="error"
                    title="Replay failed"
                    description={replayError}
                  />
                : null}
                {replayError && result ?
                  <Text type="label" color="secondary">
                    Last successful result
                  </Text>
                : null}
                {result ?
                  <ResponseInspector
                    durationMs={result.result.durationMs}
                    id={`${id}-replay`}
                    responseIdentity={result.responseIdentity}
                    response={replayResponse(result.result)}
                    onCopyError={toast.error}
                    onCopySuccess={() => toast.success("Copied")}
                    onExport={(format) => toast.success(`Exported ${format}`)}
                    onExportError={toast.error}
                  />
                : null}
                {!result && !replayError ?
                  <EmptyState
                    icon={<PlayIcon />}
                    title="Ready to replay"
                    description="Run the edited request to inspect the upstream response."
                  />
                : null}
              </VStack>
            </Card>
          </div>
        </VStack>
      : null}
    </Page>
  )
}
