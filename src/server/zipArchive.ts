import JSZip from "jszip";

export interface ZipEntryInput {
  filename: string;
  content: string | Buffer;
  modifiedAt?: Date;
}

/**
 * Creates a standard PKZIP archive buffer using JSZip (DEFLATE compression, DOS platform
 * attributes for maximum Windows Explorer / macOS / Linux compatibility).
 */
export async function createZipArchive(entries: ZipEntryInput[]): Promise<Buffer> {
  const zip = new JSZip();
  const seenNames = new Set<string>();

  const expectedBytesByName = new Map<string, number>();

  for (const entry of entries) {
    const cleanName = entry.filename.replace(/^\/+/, "").trim();
    if (!cleanName || seenNames.has(cleanName)) continue;
    seenNames.add(cleanName);

    const rawBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, "utf-8");

    expectedBytesByName.set(cleanName, rawBuf.length);
    zip.file(cleanName, rawBuf, {
      date: entry.modifiedAt ?? new Date(),
      createFolders: false,
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  });

  await validateZipArchive(buffer, expectedBytesByName);
  return buffer;
}

export async function validateZipArchive(
  buffer: Buffer,
  expectedBytesByName?: Map<string, number>
): Promise<{ valid: boolean; entryNames: string[]; entrySizes: Record<string, number> }> {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("ZIP archive validation failed: buffer is empty or truncated.");
  }
  if (buffer.subarray(0, 4).toString("binary") !== "PK\x03\x04") {
    throw new Error("ZIP archive validation failed: missing local PKZIP file header signature.");
  }
  if (buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) === -1) {
    throw new Error("ZIP archive validation failed: missing End-of-Central-Directory (EOCD) record.");
  }

  const verified = await JSZip.loadAsync(buffer);
  const entryNames: string[] = [];
  const entrySizes: Record<string, number> = {};

  for (const [name, entry] of Object.entries(verified.files)) {
    if (entry.dir) continue;
    const inflated = await entry.async("nodebuffer");
    entryNames.push(name);
    entrySizes[name] = inflated.length;
    if (expectedBytesByName && expectedBytesByName.has(name)) {
      const expectedLen = expectedBytesByName.get(name)!;
      if (inflated.length !== expectedLen) {
        throw new Error(
          `ZIP archive validation failed: entry '${name}' decoded ${inflated.length} bytes (expected ${expectedLen}).`
        );
      }
    }
  }

  if (expectedBytesByName) {
    for (const [expectedName] of expectedBytesByName.entries()) {
      if (!entryNames.includes(expectedName)) {
        throw new Error(`ZIP archive validation failed: missing expected entry '${expectedName}'.`);
      }
    }
  }

  return { valid: true, entryNames, entrySizes };
}
