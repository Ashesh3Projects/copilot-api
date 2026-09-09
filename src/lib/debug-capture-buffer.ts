import { randomUUID } from "node:crypto"
import { open, unlink, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"

const SPOOL_THRESHOLD = 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export class DebugCaptureEncodingError extends Error {}

function decodeText(
  decoder: TextDecoder,
  bytes?: Uint8Array,
  stream = false,
): string {
  try {
    return decoder.decode(bytes, { stream })
  } catch (cause) {
    throw new DebugCaptureEncodingError("Captured body is not valid UTF-8", {
      cause,
    })
  }
}

/** A temporary capture buffer; durable history remains in the selected backend. */
export class DebugCaptureBuffer {
  private chunks: Array<Uint8Array> = []
  private reservedBytes = 0
  private bufferedBytes = 0
  private file: FileHandle | undefined
  private fileBytes = 0
  private path: string | undefined

  async append(chunk: Uint8Array): Promise<void> {
    const reservation = chunk.byteLength * 4
    if (
      !this.file
      && this.bufferedBytes + chunk.byteLength <= SPOOL_THRESHOLD
      && reserveDebugCaptureMemory(reservation)
    ) {
      this.reservedBytes += reservation
      this.bufferedBytes += chunk.byteLength
      this.chunks.push(chunk.slice())
      return
    }
    if (!this.file) {
      const path = join(tmpdir(), `copilot-api-debug-${randomUUID()}`)
      this.file = await open(path, "wx+", 0o600)
      this.path = path
      // Delete-on-close on Windows, anonymous inode on Unix. A process crash
      // cannot leave a raw transcript on disk after the handle is released.
      await unlink(this.path)
      this.path = undefined
      for (const buffered of this.chunks) await this.write(buffered)
      this.releaseChunks()
    }
    await this.write(chunk)
  }

  private async write(chunk: Uint8Array): Promise<void> {
    if (!this.file) throw new Error("Debug capture file is unavailable")
    let offset = 0
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await this.file.write(
        chunk,
        offset,
        chunk.byteLength - offset,
        this.fileBytes,
      )
      if (!bytesWritten) throw new Error("Debug capture write made no progress")
      offset += bytesWritten
      this.fileBytes += bytesWritten
    }
  }

  async text(): Promise<string> {
    const decoder = new TextDecoder(undefined, { fatal: true, ignoreBOM: true })
    if (!this.file) return decodeText(decoder, Buffer.concat(this.chunks))
    const parts: Array<string> = []
    const chunk = new Uint8Array(READ_CHUNK_BYTES)
    let position = 0
    while (position < this.fileBytes) {
      const { bytesRead } = await this.file.read(
        chunk,
        0,
        Math.min(chunk.byteLength, this.fileBytes - position),
        position,
      )
      if (!bytesRead) throw new Error("Debug capture read ended early")
      position += bytesRead
      parts.push(decodeText(decoder, chunk.subarray(0, bytesRead), true))
    }
    parts.push(decodeText(decoder))
    return parts.join("")
  }

  private releaseChunks(): void {
    this.chunks.length = 0
    releaseDebugCaptureMemory(this.reservedBytes)
    this.reservedBytes = 0
    this.bufferedBytes = 0
  }

  async close(): Promise<void> {
    this.releaseChunks()
    try {
      await this.file?.close()
    } finally {
      if (this.path) await unlink(this.path)
    }
  }
}
