const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const config = require('../config/env');
const logger = require('../utils/logger');
const jobService = require('../services/jobService');
const gcsService = require('../services/gcsService');
const { processOrdersFile } = require('../services/fileProcessorService');

const router = express.Router();

if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

// Disk storage (NOT memory storage) — required so large files are never
// held fully in process memory, even before we start streaming them.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const jobId = randomUUID();
    req.jobId = jobId;
    cb(null, `${jobId}${path.extname(file.originalname) || '.csv'}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB safety cap
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv)$/i.test(file.originalname);
    if (!ok) {
      return cb(new Error('Only .csv files are accepted'));
    }
    cb(null, true);
  },
});

/**
 * POST /upload-orders
 *
 * Accepts the file, immediately responds 202 Accepted with a jobId, and
 * does the GCS upload + parse + DB insert in the background so the HTTP
 * request doesn't have to stay open for the whole ~10k-row job (bonus:
 * background processing).
 *
 * Poll GET /upload-orders/:jobId for status.
 */
router.post('/upload-orders', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Field name must be "file".' });
    }

    const jobId = req.jobId;
    const localFilePath = req.file.path;

    jobService.createJob(jobId, { originalFilename: req.file.originalname });

    logger.info('Upload received, starting background processing', {
      jobId,
      filename: req.file.originalname,
      size: req.file.size,
    });

    res.status(202).json({
      message: 'File accepted and is being processed',
      jobId,
      statusUrl: `/upload-orders/${jobId}`,
    });

    // Fire-and-forget background job (does not block the response above).
    setImmediate(async () => {
      try {
        jobService.updateJob(jobId, { status: 'uploading' });
        const gcsPath = await gcsService.uploadFile(localFilePath, jobId);
        jobService.updateJob(jobId, { gcsPath });

        await processOrdersFile(localFilePath, jobId);
      } catch (err) {
        logger.error('Background job failed', { jobId, error: err.message });
        jobService.updateJob(jobId, { status: 'failed', error: err.message });
      } finally {
        fs.unlink(localFilePath, () => {});
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /upload-orders/:jobId — poll job/processing status.
 */
router.get('/upload-orders/:jobId', (req, res) => {
  const job = jobService.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

module.exports = router;
