import {
  createConfigExportZip,
  type ConfigExportArchive,
} from "~/lib/config-export"

export function createExportSettingsHandler(
  createArchive: () => Promise<ConfigExportArchive> = createConfigExportZip,
): () => Promise<Response> {
  return async () => {
    const archive = await createArchive()
    return new Response(archive.zip, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${archive.filename}"`,
        "content-type": "application/zip",
      },
    })
  }
}

export const handleExportSettings = createExportSettingsHandler()
