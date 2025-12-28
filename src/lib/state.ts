import type { ModelsResponse } from "~/services/copilot/get-models"
import type {
  AzureOpenAIConfig,
  AzureOpenAIDeploymentInfo,
} from "~/services/azure-openai/types"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Azure OpenAI configuration
  azureOpenAIConfig?: AzureOpenAIConfig
  azureOpenAIDeployments?: Array<AzureOpenAIDeploymentInfo>
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
