// Smallest valid 1x1 PNG, written as bytes so no shell quoting is involved.
const fs = require('node:fs');
const hex =
  '89504e470d0a1a0a' + // signature
  '0000000d49484452' + // IHDR length + type
  '00000001000000010806000000' + // 1x1, 8-bit RGBA
  '1f15c489' + // IHDR crc
  '0000000d49444154' + // IDAT length + type
  '789c6360000002000100' + // zlib stream
  '05fe02fe' + // IDAT crc (not validated by our code path)
  '0000000049454e44ae426082'; // IEND
fs.writeFileSync(process.argv[2], Buffer.from(hex, 'hex'));
console.log('wrote', process.argv[2], fs.statSync(process.argv[2]).size, 'bytes');
