import { MongoClient, GridFSBucket } from 'mongodb';
import { Readable } from 'stream';

let cachedClient = null;
let cachedBucket = null;

async function getBucket() {
  if (cachedBucket) return cachedBucket;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not defined');
  if (!cachedClient) {
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }
  const db = cachedClient.db(process.env.MONGODB_DB || 'techgeo');
  cachedBucket = new GridFSBucket(db, { bucketName: 'uploads' });
  return cachedBucket;
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const bucket = await getBucket();
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) return res.status(400).json({ error: 'Invalid multipart' });
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const boundaryBuf = Buffer.from(`--${boundary}`);
    const parts = splitBuffer(buffer, boundaryBuf);

    let fileBuffer = null;
    let filename = 'upload.bin';

    for (const part of parts) {
      if (!part.length) continue;
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headerStr = part.slice(0, headerEnd).toString('utf8');
      const body = part.slice(headerEnd + 4, part.length - 2);
      const nameMatch = headerStr.match(/name="([^"]+)"/i);
      const fileMatch = headerStr.match(/filename="([^"]*)"/i);
      if (nameMatch && nameMatch[1] === 'file' && fileMatch) {
        fileBuffer = body;
        filename = fileMatch[1] || 'upload.bin';
        break;
      }
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: 'No file found in request' });
    }

    const uploadStream = bucket.openUploadStream(filename);
    await new Promise((resolve, reject) => {
      Readable.from(fileBuffer)
        .pipe(uploadStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    return res.status(200).json({
      success: true,
      fileId: uploadStream.id.toString(),
      filename,
      size: fileBuffer.length,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function splitBuffer(buf, delim) {
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const idx = buf.indexOf(delim, start);
    if (idx === -1) { parts.push(buf.slice(start)); break; }
    if (idx > start) parts.push(buf.slice(start, idx));
    start = idx + delim.length;
  }
  return parts;
}
