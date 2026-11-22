import { describe, expect, test } from "bun:test";
import { sniffMimeType } from "../services/records.service";

describe("sniffMimeType", () => {
  test("detects allowed types by magic number", () => {
    expect(sniffMimeType(Buffer.from("%PDF-1.7 rest"))).toBe("application/pdf");
    expect(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  test("rejects anything else, whatever the filename says", () => {
    expect(sniffMimeType(Buffer.from("<script>alert(1)</script>"))).toBeNull();
    expect(sniffMimeType(Buffer.from("MZ\x90\x00"))).toBeNull();
  });
});
