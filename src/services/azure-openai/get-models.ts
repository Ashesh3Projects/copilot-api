import consola from "consola"

import { HTTPError } from "~/lib/error"

import { AZURE_OPENAI_MODEL_PREFIX } from "./config"
import type {
  AzureOpenAIConfig,
  AzureOpenAIDeploymentInfo,
  AzureOpenAIDeploymentsResponse,
} from "./types"

// Different API versions for different endpoints
const AZURE_DEPLOYMENTS_API_VERSION = "2022-12-01"

export async function getAzureOpenAIDeployments(
  config: AzureOpenAIConfig,
): Promise<Array<AzureOpenAIDeploymentInfo>> {
  try {
    const response = await fetch(
      `${config.endpoint}/openai/deployments?api-version=${AZURE_DEPLOYMENTS_API_VERSION}`,
      {
        headers: {
          "api-key": config.apiKey,
          "Content-Type": "application/json",
        },
      },
    )

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      consola.error(
        `Failed to fetch Azure OpenAI deployments: ${response.status}`,
        errorText,
      )
      throw new HTTPError("Failed to fetch Azure OpenAI deployments", response)
    }

    const data = (await response.json()) as AzureOpenAIDeploymentsResponse

    // Only include deployments that are successfully deployed
    return data.data
      .filter((deployment) => deployment.status === "succeeded")
      .map((deployment) => ({
        id: `${AZURE_OPENAI_MODEL_PREFIX}${deployment.id}`,
        deploymentName: deployment.id,
        model: deployment.model,
        created: deployment.created_at,
        object: "deployment",
        owned_by: deployment.owner || "azure-openai",
      }))
  } catch (error) {
    if (error instanceof HTTPError) {
      throw error
    }
    consola.error("Failed to fetch Azure OpenAI deployments:", error)
    return []
  }
}
