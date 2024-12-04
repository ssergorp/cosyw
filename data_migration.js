const { MongoClient } = require("mongodb");

const localUri = "mongodb://127.0.0.1:27017"; // Local MongoDB URI
const cloudUri = "mongodb+srv://cosyworld8:L9n8yYZKHgqBr9Vk@cosycluster0.vupveyt.mongodb.net/?retryWrites=true&w=majority&appName=CosyCluster0"; // Replace with your cloud MongoDB URI

const localDbName = "cosyworld2";
const cloudDbName = "cosyworld8";

async function migrateData() {
  const localClient = new MongoClient(localUri);
  const cloudClient = new MongoClient(cloudUri);

  try {
    // Connect to both MongoDB instances
    await localClient.connect();
    await cloudClient.connect();

    console.log("Connected to both local and cloud MongoDB instances.");

    const localDb = localClient.db(localDbName);
    const cloudDb = cloudClient.db(cloudDbName);

    // Get all collections in the local database
    const collections = await localDb.listCollections().toArray();

    for (const collectionInfo of collections) {
      const collectionName = collectionInfo.name;
      console.log(`Migrating collection: ${collectionName}`);

      const localCollection = localDb.collection(collectionName);
      const cloudCollection = cloudDb.collection(collectionName);

      // Fetch all documents from the local collection
      const documents = await localCollection.find({}).toArray();

      if (documents.length > 0) {
        // Insert documents into the cloud collection
        const insertResult = await cloudCollection.insertMany(documents);
        console.log(
          `Inserted ${insertResult.insertedCount} documents into collection: ${collectionName}`
        );
      } else {
        console.log(`No documents found in collection: ${collectionName}`);
      }
    }

    console.log("Data migration complete.");
  } catch (error) {
    console.error("Error during migration:", error);
  } finally {
    // Close the MongoDB connections
    await localClient.close();
    await cloudClient.close();
    console.log("Closed MongoDB connections.");
  }
}

migrateData();
