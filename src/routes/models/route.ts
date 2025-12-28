import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    // Copilot models
    const copilotModels =
      state.models?.data.map((model) => ({
        id: model.id,
        object: "model",
        type: "model",
        created: 0, // No date available from source
        created_at: new Date(0).toISOString(), // No date available from source
        owned_by: model.vendor,
        display_name: model.name,
      })) ?? []

    // Azure OpenAI deployments
    const azureModels =
      state.azureOpenAIDeployments?.map((deployment) => ({
        id: deployment.id,
        object: "model",
        type: "model",
        created: deployment.created,
        created_at: new Date(deployment.created * 1000).toISOString(),
        owned_by: deployment.owned_by,
        display_name: `${deployment.deploymentName} (${deployment.model})`,
      })) ?? []

    const allModels = [...copilotModels, ...azureModels]

    return c.json({
      object: "list",
      data: allModels,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
