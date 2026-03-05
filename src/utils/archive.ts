export type TarEntry = { filename: string; content: string; mode?: string };

/**
 * Creates a minimal tar archive containing one or more files.
 * Used to inject files into Docker containers via putArchive.
 *
 * Each entry is { filename, content, mode? } where mode defaults to '0000644'.
 * Pass mode '0000755' for executable scripts.
 */
export function createTarArchive(entries: TarEntry | TarEntry[]): Buffer {
  const list = Array.isArray(entries) ? entries : [entries];
  const parts = list.map((e) => createTarEntry(e));
  // Two 512-byte zero blocks mark end of archive
  const endBlocks = Buffer.alloc(1024, 0);
  return Buffer.concat([...parts, endBlocks]);
}

/**
 * Creates a tar entry (header + padded content) for a single file.
 * Used internally by createTarArchive.
 */
function createTarEntry({ filename, content, mode = '0000644' }: TarEntry): Buffer {
  const contentBuffer = Buffer.from(content, 'utf8');
  const nameBuffer = Buffer.from(filename, 'utf8');

  // TAR header is 512 bytes
  const header = Buffer.alloc(512, 0);

  // Filename (max 100 chars)
  nameBuffer.copy(header, 0, 0, Math.min(nameBuffer.length, 100));

  // File permissions
  Buffer.from(`${mode}\0`).copy(header, 100);

  // Owner/group UID/GID
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);

  // File size in octal
  const sizeOctal = contentBuffer.length.toString(8).padStart(11, '0') + '\0';
  Buffer.from(sizeOctal).copy(header, 124);

  // Modification time
  const mtime =
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0') + '\0';
  Buffer.from(mtime).copy(header, 136);

  // Link indicator (regular file)
  header[156] = 0x30; // '0'

  // Checksum (computed over the header with checksum field = spaces)
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);

  // Pad content to 512-byte boundary
  const paddedSize = Math.ceil(contentBuffer.length / 512) * 512;
  const paddedContent = Buffer.alloc(paddedSize, 0);
  contentBuffer.copy(paddedContent);

  return Buffer.concat([header, paddedContent]);
}
