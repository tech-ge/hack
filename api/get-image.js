// api/get-image.js
import { MongoClient, ObjectId } from 'mongodb';
const client = new MongoClient(process.env.MONGODB_URI);

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('ID required');

  await client.connect();
  const db = client.db('techgeo');
  const image = await db.collection('images').findOne({ _id: new ObjectId(id) });

  if (!image) return res.status(404).send('Image not found');

  // Set the headers so the browser knows it's an image
  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  
  // Send the raw binary data
  res.send(image.data.buffer);
}
