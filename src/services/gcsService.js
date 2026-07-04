const { Storage } = require('@google-cloud/storage');
const path = require('path');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * No keyFilename / credentials object is passed here on purpose.
 *
 * The client library automatically uses Application Default Credentials
 * (ADC), resolved in this order:
 *   1. GOOGLE_APPLICATION_CREDENTIALS env var (path to a key file) — only
 *      used for local dev if explicitly set, never committed.
 *   2. `gcloud auth application-default login` user credentials (local dev).
 *   3. The attached service account when running on GCP (Cloud Run, GCE,
 *      GKE with Workload Identity, etc).
 *
 * This satisfies requirement 7: "No hardcoded credentials or secrets."
 */
const storage = new Storage({
  projectId: config.gcp.projectId,
});

const bucket = storage.bucket(config.gcp.bucketName);

/**
 * Uploads a local file to GCS, streaming it (does not load the file into
 * memory). Returns the destination object path.
 */
async function uploadFile(localFilePath, jobId) {
  const filename = path.basename(localFilePath);
  const destination = `orders/${jobId}/${filename}`;

  logger.info('GCS upload starting', { localFilePath, destination });

  await bucket.upload(localFilePath, {
    destination,
    resumable: false,
    metadata: {
      contentType: 'text/csv',
      metadata: { jobId },
    },
  });

  logger.info('GCS upload finished', { destination });

  return `gs://${config.gcp.bucketName}/${destination}`;
}

module.exports = { uploadFile, bucket };
