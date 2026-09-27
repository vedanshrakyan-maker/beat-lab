import { describe, expect, it } from "vitest";
import {
  blindIndex,
  decrypt,
  encrypt,
  fingerprintHash,
  maskPan,
  maskUpi,
  PAN_REGEX,
  UPI_REGEX,
} from "@/lib/crypto";

describe("crypto", () => {
  it("round-trips AES-256-GCM with random IVs", () => {
    const a = encrypt("ABCDE1234F");
    const b = encrypt("ABCDE1234F");
    expect(a).not.toBe(b);
    expect(a).not.toContain("ABCDE1234F");
    expect(decrypt(a)).toBe("ABCDE1234F");
  });

  it("detects tampering", () => {
    const c = encrypt("rahul@okicici");
    const parts = c.split(".");
    const data = Buffer.from(parts[3]!, "base64");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64");
    expect(() => decrypt(parts.join("."))).toThrow();
  });

  it("builds stable, case-insensitive blind indexes", () => {
    expect(blindIndex("Rahul@OKICICI")).toBe(blindIndex("rahul@okicici"));
    expect(blindIndex("a@b")).not.toBe(blindIndex("a@c"));
    expect(fingerprintHash("1.2.3.4")).toHaveLength(32);
  });

  it("masks PAN and UPI for display", () => {
    expect(maskPan("abcde1234f")).toBe("ABCDE****F");
    expect(maskUpi("rahul.sharma@okicici")).toBe("ra**********@okicici");
    expect(maskUpi("ab@ybl")).toBe("ab***@ybl");
  });

  it("validates PAN and UPI formats", () => {
    expect(PAN_REGEX.test("ABCDE1234F")).toBe(true);
    expect(PAN_REGEX.test("ABCD1234F")).toBe(false);
    expect(UPI_REGEX.test("rahul.sharma@okicici")).toBe(true);
    expect(UPI_REGEX.test("not-a-upi")).toBe(false);
  });
});
