import { MongoClient } from 'mongodb';

// Assuming you have a MongoDB URI in your Vercel Environment Variables
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // 1. Get the boundary from the content-type header
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return res.status(400).json({ ok: false, error: 'Content-Type must be multipart/form-data' });
    }
    const boundary = contentType.split('boundary=')[1];

    // 2. Read the raw body as a buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);

    // 3. Parse the buffer to extract the image file
    const file = parseMultipart(rawBody, boundary);

    if (!file) {
      return res.status(400).json({ ok: false, error: 'No image file found in request' });
    }

    // 4. Validate Image Type & Size (MongoDB limit is 16MB, we'll cap at 10MB to be safe)
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
    if (!allowedTypes.includes(file.contentType)) {
      return res.status(415).json({ ok: false, error: `Unsupported image type: ${file.contentType}` });
    }
    if (file.data.length > 10 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: 'Image too large. Max size is 10MB' });
    }

    // 5. Connect to MongoDB and save
    await client.connect();
    const db = client.db('techgeo'); // Change this to your actual DB name
    const collection = db.collection('images'); // Change this to your actual collection name

    const result = await collection.insertOne({
      filename: file.filename,
      contentType: file.contentType,
      size: file.data.length,
      data: file.data, // Storing as BSON Binary (Buffer)
      createdAt: new Date()
    });

    return res.status(200).json({ 
      ok: true, 
      message: 'Image saved to MongoDB',
      id: result.insertedId.toString(),
      // This URL won't work yet, you'll need a GET route to serve the image later
      url: `/api/get-image?id=${result.insertedId}` 
    });

  } catch (error) {
    console.error('Upload Image Error:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

// --- Helper function to parse multipart/form-data manually ---
function parseMultipart(buffer, boundary) {
  const boundaryStr = `--${boundary}`;
  const parts = [];
  let startIndex = buffer.indexOf(boundaryStr);

  while (startIndex !== -1) {
    const endIndex = buffer.indexOf(boundaryStr, startIndex + boundaryStr.length);
    if (endIndex === -1) break;

    const part = buffer.slice(startIndex + boundaryStr.length, endIndex);
    parts.push(part);

    startIndex = endIndex;
  }

  for (const part of parts) {
    // Look for the file part (usually contains filename="...")
    if (part.toString('utf8').includes('filename=')) {
      const headerEndIndex = part.indexOf('\r\n\r\n');
      const headers = part.slice(0, headerEndIndex).toString('utf8');
      
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type: ([^\r\n]+)/);

      const filename = filenameMatch ? filenameMatch[1] : 'unknown';
      const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
      
      // The actual image data starts after the headers
      const fileData = part.slice(headerEndIndex + 4, part.length - 2); // -2 to trim trailing \r\n

      return { filename, contentType, data: fileData };
    }
  }
  return null;
}
