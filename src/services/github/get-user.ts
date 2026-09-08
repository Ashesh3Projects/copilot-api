import { standardHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { githubApiBaseUrl } from "~/lib/github-instance"
import { state } from "~/lib/state"

export async function getGitHubUser(
  githubToken = state.githubToken,
  instanceDomain = state.githubInstanceDomain,
) {
  const response = await fetch(`${githubApiBaseUrl(instanceDomain)}/user`, {
    headers: {
      authorization: `token ${githubToken}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok) {
    throw new HTTPError(
      `Failed to get GitHub user (HTTP ${response.status})`,
      response,
    )
  }

  return (await response.json()) as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  id: number
  login: string
}
