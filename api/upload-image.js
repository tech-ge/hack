// api/upload-image.js
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

export const config = {
  api: {
    bodyParser: false, // Disable Vercel's default parser so we can read the raw buffer
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
    }
    const boundary = contentType.split('boundary=')[1];

    // Read raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);

    // Parse the multipart data
    const file = parseMultipart(rawBody, boundary);

    if (!file) {
      return res.status(400).json({ error: 'No image file found in request' });
    }

    // Validate Image Type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
    if (!allowedTypes.includes(file.contentType)) {
      return res.status(415).json({ error: `Unsupported image type: ${file.contentType}` });
    }

    // Validate Size (MongoDB limit is 16MB, we'll cap at 10MB for safety)
    if (file.data.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large. Max size is 10MB' });
    }

    await client.connect();
    const db = client.db('techgeo'); // Update with your DB name

    // OPTION A: Save to GridFS (Matches your admin dashboard structure)
    // If your admin dashboard looks for GridFS files, use this block:
    /* 
    const { GridFSBucket } = await import('mongodb');
    const bucket = new GridFSBucket(db);
    const uploadStream = bucket.openUploadStream(file.filename, {
      contentType: file.contentType,
    });
    
    // Write the buffer to GridFS
    const { Readable } = await import('stream');
    const bufferStream = Readable.from(file.data);
    
    const fileId = await new Promise((resolve, reject) => {
      bufferStream.pipe(uploadStream)
        .on('error', reject)
        .on('finish', () => resolve(uploadStream.id));
    });
    
    return res.status(200).json({ ok: true, fileId: fileId.toString() });
    */

    // OPTION B: Save to standard collection (Simpler, but doesn't show in standard GridFS admin)
    const collection = db.collection('images');
    const result = await collection.insertOne({
      filename: file.filename,
      contentType: file.contentType,
      size: file.data.length,
      data: file.data, // Store as BSON Binary
      uploadDate: new Date()
    });

    return res.status(200).json({ 
      ok: true, 
      fileId: result.insertedId.toString(),
      message: 'Image saved to DB'
    });

  } catch (error) {
    console.error('Upload Image Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Helper function to parse multipart/form-data
function parseMultipart(buffer, boundary) {
  const boundaryStr = `--${boundary}`;
  const parts = [];
  let startIndex = buffer.indexOf(boundaryStr);

  while (startIndex !== -1) {
    const endIndex = buffer.indexOf(boundaryStr, startIndex + boundaryStr.length);
    if (endIndex === -1) break;
    parts.push(buffer.slice(startIndex + boundaryStr.length, endIndex));
    startIndex = endIndex;
  }

  for (const part of parts) {
    if (part.toString('utf8').includes('filename=')) {
      const headerEndIndex = part.indexOf('\r\n\r\n');
      const headers = part.slice(0, headerEndIndex).toString('utf8');
      
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type: ([^\r\n]+)/);

      const filename = filenameMatch ? filenameMatch[1] : 'unknown.jpg';
      const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
      
      // Trim trailing \r\n
      const fileData = part.slice(headerEndIndex + 4, part.length - 2); 

      return { filename, contentType, data: fileData };
    }
  }
  return null;
}
