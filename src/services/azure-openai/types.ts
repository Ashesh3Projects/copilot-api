export interface AzureOpenAIConfig {
  endpoint: string
  apiKey: string
}

// Azure OpenAI Deployment (what's actually deployed to your resource)
export interface AzureOpenAIDeployment {
  id: string // deployment name
  model: string // underlying model (e.g., gpt-4, gpt-35-turbo)
  owner: string
  object: string
  status: string
  created_at: number
  updated_at: number
  scale_settings: {
    scale_type: string
  }
}

export interface AzureOpenAIDeploymentsResponse {
  object: string
  data: Array<AzureOpenAIDeployment>
}

// Deployment info with the azure_openai_ prefix applied
export interface AzureOpenAIDeploymentInfo {
  id: string // azure_openai_<deployment-name>
  deploymentName: string // The actual deployment name in Azure
  model: string // The underlying model
  created: number
  object: string
  owned_by: string
}
