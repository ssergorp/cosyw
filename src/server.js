
const express = require('express');
const { MongoClient } = require('mongodb');
const app = express();
const port = process.env.PORT || 3000;

// ...existing code...

app.get('/api/dungeon/log', async (req, res) => {
  try {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    
    const db = client.db('discord');
    const log = await db.collection('dungeon_log')
      .find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();
    
    await client.close();
    res.json(log);
  } catch (error) {
    console.error('Error fetching combat log:', error);
    res.status(500).json({ error: 'Failed to fetch combat log' });
  }
});

// ...existing code...

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});