/**
 * Storage driver factory — picks the BlobStore from config.
 */

import { config } from '../config.ts'
import type { BlobStore } from './blobstore.ts'
import { FsBlobStore } from './fs.ts'
import { S3BlobStore } from './s3.ts'

let cached: BlobStore | null = null

export function getStore(): BlobStore {
  if (cached) return cached
  cached = config.store === 's3' ? new S3BlobStore(config.s3) : new FsBlobStore(config.dataDir)
  return cached
}

export type { BlobStore } from './blobstore.ts'
export { entryPath, manifestPath } from './blobstore.ts'
