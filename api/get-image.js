import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';

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
  cachedBucket = new GridFSBucket(db, { bucketName: 'images' });
  return cachedBucket;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing image ID' });

  try {
    const bucket = await getBucket();
    const _id = new ObjectId(id);

    // Find the file metadata first to set the correct Content-Type
    const files = await bucket.find({ _id }).toArray();
    if (!files.length) return res.status(404).json({ error: 'Image not found' });

    const file = files[0];
    
    // Set appropriate headers for browsers to display the image
    res.setHeader('Content-Type', file.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Cache for 1 year

    // Stream the image directly from GridFS to the browser
    bucket.openDownloadStream(_id).pipe(res);
  } catch (err) {
    console.error('Get image error:', err);
    return res.status(500).json({ error: err.message });
  }
}
