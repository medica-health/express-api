import type { Request, Response } from "express";
import { currentUser } from "../middlewares/authenticate";
import { input } from "../middlewares/validate";
import * as records from "../services/records.service";
import { created, ok } from "../utils/respond";
import type { ListRecordsQuery, UploadRecordBody } from "../validators/clinical";

export async function upload(req: Request, res: Response) {
  created(res, "Record uploaded", await records.uploadRecord(currentUser(req), input<UploadRecordBody>(res, "body"), req.file));
}

export async function list(req: Request, res: Response) {
  ok(res, "Records fetched", await records.listRecords(currentUser(req), input<ListRecordsQuery>(res, "query")));
}

export async function download(req: Request, res: Response) {
  const { record, stream } = await records.openRecordDownload(currentUser(req), input<{ id: string }>(res, "params").id);
  res.setHeader("Content-Type", record.mime_type);
  res.setHeader("Content-Length", String(record.size_bytes));
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(record.file_name)}"`);
  res.setHeader("Cache-Control", "private, no-store");
  stream.on("error", (err) => {
    console.error("Record download failed:", err.message);
    if (!res.headersSent) res.status(404).end();
    else res.destroy(err);
  });
  stream.pipe(res);
}

export async function remove(req: Request, res: Response) {
  await records.deleteRecord(currentUser(req), input<{ id: string }>(res, "params").id);
  ok(res, "Record deleted");
}
