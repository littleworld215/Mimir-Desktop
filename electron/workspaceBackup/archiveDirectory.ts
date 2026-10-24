/** 补足锁定yauzl未校验的中央目录字节覆盖；条目解码仍全部交给yauzl。 */
import { read } from 'node:fs'
import { VerifyError } from './archivePolicy'

export interface ArchiveDirectory { start: number; end: number; count: number }
const invalid = () => new VerifyError('READ_FAILED', 'ZIP中央目录边界或条目计数不符')

async function bytesAt(fd: number, offset: number, length: number): Promise<Buffer> {
  const result = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const count = await new Promise<number>((resolveRead, reject) => read(fd, result, filled, length - filled, offset + filled,
      (error, bytes) => error ? reject(error) : resolveRead(bytes)))
    if (count === 0) throw invalid()
    filled += count
  }
  return result
}
function integer64(bytes: Buffer, offset: number): number {
  const value = bytes.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid()
  return Number(value)
}

/** 固定读取最多约64KiB尾部和56字节ZIP64头，不按包自报长度分配内存。 */
export async function readArchiveDirectory(fd: number, fileSize: number): Promise<ArchiveDirectory> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 22) throw invalid()
  const tailOffset = Math.max(0, fileSize - 22 - 65535 - 20)
  const tail = await bytesAt(fd, tailOffset, fileSize - tailOffset)
  let end = tail.length - 22
  for (; end >= 0; end--) {
    if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break
  }
  if (end < 0) throw invalid()
  const endOffset = tailOffset + end
  let start = tail.readUInt32LE(end + 16)
  let size = tail.readUInt32LE(end + 12)
  let count = tail.readUInt16LE(end + 10)
  let directoryEnd = endOffset
  if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
    const locator = tail.subarray(end - 20, end)
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw invalid()
    const recordOffset = integer64(locator, 8)
    if (recordOffset > endOffset - 20 - 56) throw invalid()
    const header = await bytesAt(fd, recordOffset, 56)
    if (header.readUInt32LE(0) !== 0x06064b50 || integer64(header, 4) !== endOffset - 20 - recordOffset - 12
      || header.readUInt32LE(16) !== 0 || header.readUInt32LE(20) !== 0
      || integer64(header, 24) !== integer64(header, 32)) throw invalid()
    count = integer64(header, 32)
    size = integer64(header, 40)
    start = integer64(header, 48)
    directoryEnd = recordOffset
  } else if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0
    || tail.readUInt16LE(end + 8) !== count) throw invalid()
  if (start > directoryEnd || size !== directoryEnd - start) throw invalid()
  return { start, end: directoryEnd, count }
}
