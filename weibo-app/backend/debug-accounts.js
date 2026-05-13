import { MongoClient } from 'mongodb';
const client = new MongoClient('mongodb://localhost:27017');

(async () => {
  try {
    await client.connect();
    const db = client.db('weibo_app');
    
    // List all collections
    const collections = await db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));
    
    // Try to find any accounts
    const doc = await db.collection('accounts').findOne({});
    console.log('Accounts document keys:', Object.keys(doc || {}));
    
    if (doc) {
      if (doc.accounts) {
        console.log('Has .accounts array');
        for (let i = 20; i < 25 && i < doc.accounts.length; i++) {
          console.log(`  [${i}] "${doc.accounts[i]?.name || 'NO NAME'}"`);
        }
      } else if (Array.isArray(doc)) {
        console.log('Document is array');
      } else {
        console.log('Document structure:', JSON.stringify(doc).substring(0, 500));
      }
    }
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await client.close();
  }
})();
