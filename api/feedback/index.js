// api/feedback/index.js

const { BlobServiceClient } = require("@azure/storage-blob");

const feedbackConnStr = process.env.FEEDBACK_STORAGE_CONNECTION_STRING;
const rawContainerName = process.env.FEEDBACK_CONTAINER_RAW || "cases-raw";
const approvedContainerName = process.env.FEEDBACK_CONTAINER_APPROVED || "cases-approved";

const blobServiceClient = feedbackConnStr
  ? BlobServiceClient.fromConnectionString(feedbackConnStr)
  : null;

async function streamToString(readable) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (d) => chunks.push(d));
    readable.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    readable.on("error", reject);
  });
}

async function readJsonFromBlob(containerName, blobName) {
  const container = blobServiceClient.getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobName);
  const download = await blockBlob.download(0);
  const text = await streamToString(download.readableStreamBody);
  return JSON.parse(text);
}

async function writeJsonToBlob(containerName, blobName, obj) {
  const container = blobServiceClient.getContainerClient(containerName);
  await container.createIfNotExists();
  const blockBlob = container.getBlockBlobClient(blobName);
  const json = JSON.stringify(obj, null, 2);

  await blockBlob.uploadData(Buffer.from(json, "utf8"), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

module.exports = async function (context, req) {
  context.log("HTTP trigger 'feedback' processed a request.");

  try {
    if (!blobServiceClient) {
      context.res = { status: 500, body: { error: "Feedback storage not configured." } };
      return;
    }

    const body = req.body || {};
    const caseId = body.caseId;
    if (!caseId) {
      context.res = { status: 400, body: { error: "Missing 'caseId'." } };
      return;
    }

    const blobName = `${caseId}.json`;

    const machine = body.machine || null;
    const resolution = body.resolution || {};
    const feedback = body.feedback || {};

    let caseRecord;
    try {
      caseRecord = await readJsonFromBlob(rawContainerName, blobName);
    } catch (e) {
      context.res = { status: 404, body: { error: "Case not found", caseId } };
      return;
    }

    const now = new Date().toISOString();

    const merged = {
      ...caseRecord,
      status: "closed",
      closedAt: now,
      machine: machine || caseRecord.machine || null,
      resolution: {
        ...(caseRecord.resolution || {}),
        ...resolution,
      },
      feedback: {
        ...(caseRecord.feedback || {}),
        ...feedback,
      },
    };

    await writeJsonToBlob(rawContainerName, blobName, merged);

    const success = merged.resolution?.success === true;
    const rating = Number(merged.feedback?.rating || 0);
    const autoApprove = success && rating >= 4;

    if (autoApprove) {
      await writeJsonToBlob(approvedContainerName, blobName, merged);
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ok: true, caseId, autoApproved: autoApprove },
    };
  } catch (err) {
    context.log.error("Feedback function error:", err);
    context.res = { status: 500, body: { error: "Feedback failed", details: err.message } };
  }
};

