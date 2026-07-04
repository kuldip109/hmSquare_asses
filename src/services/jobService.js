/**
 * Minimal in-memory job registry.
 *
 * For this assessment's scope, an in-memory Map is sufficient to track
 * upload/processing status and lets /upload-orders respond immediately
 * (202 Accepted) while the real work happens in the background — see
 * fileProcessorService.
 *
 * Production note: for a multi-instance deployment this should be backed
 * by a real queue (e.g. Cloud Tasks, pg-boss, BullMQ + Redis) so job state
 * survives restarts and is visible across instances. That upgrade path is
 * called out in the README as a follow-up.
 */
const jobs = new Map();

function createJob(jobId, meta = {}) {
  const job = {
    jobId,
    status: 'pending', // pending -> uploading -> processing -> completed | failed
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalRows: 0,
    insertedRows: 0,
    failedRows: 0,
    gcsPath: null,
    error: null,
    ...meta,
  };
  jobs.set(jobId, job);
  return job;
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function getMetrics() {
  const all = [...jobs.values()];
  return {
    totalJobs: all.length,
    byStatus: all.reduce((acc, j) => {
      acc[j.status] = (acc[j.status] || 0) + 1;
      return acc;
    }, {}),
    totalRowsInserted: all.reduce((sum, j) => sum + j.insertedRows, 0),
    totalRowsFailed: all.reduce((sum, j) => sum + j.failedRows, 0),
  };
}

module.exports = { createJob, updateJob, getJob, getMetrics };
