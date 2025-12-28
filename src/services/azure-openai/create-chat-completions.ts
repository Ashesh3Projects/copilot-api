import consola from "consola"
import { events } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { getAzureDeploymentName } from "./config"
import type { AzureOpenAIConfig } from "./types"

const AZURE_API_VERSION = "2024-10-21"

export async function createAzureOpenAIChatCompletions(
  config: AzureOpenAIConfig,
  payload: ChatCompletionsPayload,
) {
  // Extract the actual deployment name from the prefixed model ID
  const deploymentName = getAzureDeploymentName(payload.model)

  // Convert max_tokens to max_completion_tokens for newer models (GPT-4o, GPT-5, etc.)
  // Azure OpenAI newer models require max_completion_tokens instead of max_tokens
  const { max_tokens, ...restPayload } = payload
  const azurePayload = {
    ...restPayload,
    model: deploymentName,
    ...(max_tokens != null && { max_completion_tokens: max_tokens }),
  }

  const response = await fetch(
    `${config.endpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=${AZURE_API_VERSION}`,
    {
      method: "POST",
      headers: {
        "api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(azurePayload),
    },
  )

  if (!response.ok) {
    consola.error("Failed to create Azure OpenAI chat completions:", response)
    throw new HTTPError(
      "Failed to create Azure OpenAI chat completions",
      response,
    )
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}
