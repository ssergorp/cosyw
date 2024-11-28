// services/avatar_generation_service.mjs

import Replicate from 'replicate';
// import { OllamaService as AIService } from './ollamaService.mjs';
import { OpenRouterService as AIService } from './openrouterService.mjs';
import https from 'https';
import { MongoClient, ObjectId } from 'mongodb';
import process from 'process';
import winston from 'winston';
import { v2 as cloudinary } from 'cloudinary';
import { extractJSON } from './utils.mjs';

import { uploadImage } from './s3imageService.mjs';

import fs from 'fs/promises';
import { ArweaveService } from './arweaveService.mjs';
import fetch from 'node-fetch';

export class AvatarGenerationService {
  constructor() {
    this.aiService = new AIService();
    this.replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    this.db = null; // Will be set when connecting to the database

    // Initialize Logger
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(
          ({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`
        )
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'avatarService.log' }),
      ],
    });

    // MongoDB connection URI and database name from environment variables
    this.MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    this.DB_NAME = process.env.MONGO_DB_NAME || 'imageRequests';
    this.COLLECTION_NAME = process.env.MONGO_COLLECTION_NAME || 'requests';
    this.AVATARS_COLLECTION = process.env.AVATARS_COLLECTION || 'avatars';

    // Initialize MongoDB client
    this.mongoClient = new MongoClient(this.MONGO_URI);

    // Initialize Cloudinary
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });

    this.arweaveService = new ArweaveService();
    this.prompts = null;
  }
  
  /**
   * Connects the service to the MongoDB database.
   */
  async connectToDatabase() {
    try {
      await this.mongoClient.connect();
      this.db = this.mongoClient.db(this.DB_NAME);
      this.avatarsCollection = this.db.collection(this.AVATARS_COLLECTION);
      this.logger.info('AvatarGenerationService connected to the MongoDB database.');
    } catch (error) {
      this.logger.error(`Failed to connect to MongoDB: ${error.message}`);
      throw error; // Re-throw to handle it in the calling function
    }
  }

  /**
   * Disconnects the service from the MongoDB database.
   */
  async disconnectFromDatabase() {
    try {
      await this.mongoClient.close();
      this.logger.info('AvatarGenerationService disconnected from MongoDB.');
    } catch (error) {
      this.logger.error(`Error disconnecting from MongoDB: ${error.message}`);
    }
  }

  async getAllAvatars() {
    try {
      const collection = this.db.collection(this.AVATARS_COLLECTION);
      const avatars = await collection.find({
        name: { $exists: true },
        name: { $ne: null },
      }).toArray();
      
      // Assign 'id' from '_id' if 'id' is missing
      return avatars.map(avatar => ({
        ...avatar,
        id: avatar.id || avatar._id.toString(),
      }));
    } catch (error) {
      this.logger.error(`Error fetching avatars: ${error.message}`);
      return [];
    }
  }

  async retryOperation(operation, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        this.logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async getAvatar(name) {
    try {
      const collection = this.db.collection(this.AVATARS_COLLECTION);
      const avatar = await collection.findOne({ name });
      if (!avatar) {
        throw new Error(`Avatar with name "${name}" not found.`);
      }
      return avatar;
    } catch (error) {
      this.logger.error(`Error fetching avatar: ${error.message}`);
      return null;
    }
  }

  /**
   * Generates an avatar description using Ollama.
   * @param {string} name - The name of the avatar.
   * @param {string} emoji - The emoji representing the avatar.
   * @param {string} traits - Traits describing the avatar.
   * @returns {string|null} - The generated description or null if failed.
   */
  async generateAvatarDetails(userPrompt) {
    try {
      const maxRetries = 3;
      const baseDelay = 1000; // Start with 1 second delay

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const prompt = `Provide a detailed visual description, an appropriate emoji, and a personality description for a character based on the following prompt
          
          "${userPrompt}".
          
          Please respond in the following JSON format. ONLY provide valid JSON as a response.
          Creatively fill in any details without comment, keep all responses to no more than four sentences. 
          {
            "name": "<name the character>",
            "emoji": "<insert an emoji 🤗, (be sure to use proper JSON notation), that best represents the character>",
            "description": "<insert a one paragraph detailed description of the characters profile picture>",
            "personality": "<generate a short unique personality description>'}"
          }`;

          const response = await this.aiService.chat([
            { role: 'system', content: 'You are a creative and unsettling character designer.' },
            { role: 'user', content: prompt },
          ], { format: "json" });

          // Check if the response is valid
          if (!response) {
            throw new Error('Failed to generate avatar details.');
          }
          const avatarDetails = JSON.parse(extractJSON(response.trim()));

          // Destructure the necessary fields from the parsed JSON
          const { name, description, emoji, personality } = avatarDetails;

          // Validate that all required fields are present
          if (!name || !description || !personality) {
            throw new Error('Incomplete avatar details received.');
          }

          // Return the structured avatar details
          return { name, description, emoji: emoji || "🤗", personality };
        } catch (error) {
          this.logger.warn(`Avatar generation attempt ${attempt}/${maxRetries} failed: ${error.message}`);

          if (attempt === maxRetries) {
            throw new Error(`Failed to generate avatar after ${maxRetries} attempts: ${error.message}`);
          }

          // Exponential backoff: 1s, 2s, 4s
          const delay = baseDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      return
    } catch (error) {
      // Log any unexpected errors
      this.logger.error(`Error while generating avatar details: ${error.message}`);
      return null;
    }
  }


  /**
   * Checks if the daily limit for image generation has been reached.
   * @param {string} channelId - The Discord channel ID associated with the avatar.
   * @returns {boolean} - True if under the limit, false otherwise.
   */
  async checkDailyLimit(channelId) {
    try {
      const collection = this.db.collection(this.COLLECTION_NAME);
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Start of the day

      const count = await collection.countDocuments({
        channelId,
        date: { $gte: today },
      });

      this.logger.info(`Daily request count for channel ${channelId}: ${count}`);
      return count < 100; // Set your daily limit here
    } catch (error) {
      this.logger.error(`Error checking daily limit: ${error.message}`);
      return false;
    }
  }

  /**
   * Inserts a new request record into MongoDB.
   * @param {string} prompt - The prompt used for image generation.
   * @param {string} result - The Cloudinary URL of the image.
   * @param {string} channelId - The Discord channel ID associated with the avatar.
   */
  async insertRequestIntoMongo(prompt, result, channelId) {
    try {
      const collection = this.db.collection(this.COLLECTION_NAME);
      const now = new Date();

      const record = {
        prompt,
        result,
        channelId,
        date: now,
      };

      await collection.insertOne(record);
      this.logger.info('Record inserted into MongoDB successfully.');
    } catch (error) {
      this.logger.error(`Error inserting into MongoDB: ${error.message}`);
    }
  }

  /**
   * Checks if an image URL is accessible.
   * @param {string} url - The URL of the image to check.
   * @returns {boolean} - True if accessible, false otherwise.
   */
  async isImageAccessible(url) {
    try {
      const response = await axios.head(url);
      return response.status === 200;
    } catch (error) {
      this.logger.warn(`Image URL inaccessible: ${url} - ${error.message}`);
      return false;
    }
  }

  /**
   * Generates an avatar image using Replicate with polling.
   * @param {string} prompt - The prompt for image generation.
   * @returns {string|null} - The URL of the generated image or null if failed.
   */
  async generateAvatarImage(prompt) {
    // Step 1: Initiate the image generation request using Replicate API
    const [output] = await this.replicate.run(
      "immanencer/mirquo:dac6bb69d1a52b01a48302cb155aa9510866c734bfba94aa4c771c0afb49079f",
      {
        input: {
          prompt: `MRQ ${prompt} neon watercolor MRQ`,
          model: "dev",
          lora_scale: 1,
          num_outputs: 1,
          aspect_ratio: "1:1",
          output_format: "png",
          guidance_scale: 3.5,
          output_quality: 90,
          prompt_strength: 0.8,
          extra_lora_scale: 1,
          num_inference_steps: 28
        }
      }
    );
    // Get the temporary URL from Replicate

    const imageUrl = output.url ? output.url() : [output];

    console.log('Generated image URL:', imageUrl.toString());
    const imageBuffer = await this.downloadImage(imageUrl.toString());

    const uuid = `avatar_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const filename = `./images/${uuid}.png`;
    await fs.mkdir('./images', { recursive: true });
    await fs.writeFile(filename, imageBuffer);
    return filename;
  }

  /**
 * Updates an avatar's details.
 * @param {object} avatar - The avatar object to update.
 **/
  async updateAvatar(avatar) {
    if (!this.db) {
      this.logger.error('Database is not connected. Cannot update avatar.');
      return null;
    }

    try {
      // Sync Arweave prompt if it exists
      if (avatar.arweave_prompt) {
        await this.syncArweavePrompt(avatar);
      }

      // Prepare the update document
      const updateDoc = {
        $set: {
          ...avatar,
          updatedAt: new Date(),
        },
      };

      // Update the avatar in the 'avatars' collection
      const updateResult = await this.db.collection(this.AVATARS_COLLECTION).updateOne(
        { _id: avatar._id },
        updateDoc
      );

      if (updateResult.matchedCount === 0) {
        this.logger.error(`Avatar with ID ${avatar._id} not found.`);
        return null;
      }

      if (updateResult.modifiedCount === 1) {
        this.logger.info(`Avatar ID ${avatar._id} updated successfully.`);
        // Fetch the updated document correctly using ObjectId
        const updatedAvatar = await this.db.collection(this.AVATARS_COLLECTION).findOne({ _id: avatar._id });
        return updatedAvatar;
      } else {
        this.logger.error(`Failed to update avatar with ID ${avatar._id}.`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Error during avatar update: ${error.message}`);
      return null;
    }
  }

  /**
   * Downloads an image from a given URL and returns it as a buffer.
   * @param {string} url - The URL of the image to download.
   * @returns {Buffer|null} - The image buffer or null if failed.
   */
  // Function to download image
  async downloadImage(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to get '${url}' (${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return buffer;
    } catch (error) {
      throw new Error('Error downloading the image: ' + error.message);
    }
  }
  /**
   * Creates a new avatar by generating its description and image, then saving it to the database.
   * @param {Object} avatarData - The data for the new avatar.
   * @param {string} avatarData.name - The name of the avatar.
   * @param {string} avatarData.emoji - The emoji representing the avatar.
   * @param {string} [avatarData.personality='kind and wise'] - Traits describing the avatar.
   * @param {string} [avatarData.channelId] - The Discord channel ID associated with the avatar.
   * @returns {Object|null} - The created avatar document or null if creation failed.
   */
  async createAvatar(data) {
    let prompt = data.prompt;
    let systemPrompt;

    try {
      if (this.arweaveService.isArweaveUrl(prompt)) {
        // Load prompt from Arweave
        const arweaveData = await this.arweaveService.fetchPrompt(prompt);
        systemPrompt = arweaveData.systemPrompt;
        prompt = arweaveData.prompt || prompt;
      }

      // Proceed with avatar creation using either Arweave data or original prompt
      return await this._createAvatarWithPrompt(prompt, systemPrompt, data);
    } catch (error) {
      throw new Error(`Avatar creation failed: ${error.message}`);
    }
  }

  async _createAvatarWithPrompt(prompt, systemPrompt, data) {

    if (!this.db) {
      this.logger.error('Database is not connected. Cannot create avatar.');
      return null;
    }

    try {
      // Step 1: Check Daily Limit
      const underLimit = await this.checkDailyLimit(data.channelId);
      if (!underLimit) {
        this.logger.warn('Daily limit reached. Cannot create more avatars today.');
        return null;
      }

      // Step 2: Generate Avatar Description
      const avatar = await this.generateAvatarDetails(prompt);
      if (!avatar) {
        this.logger.error('Avatar creation aborted: avatar generation failed.');
        return null;
      }

      // Assign a unique ID if not already present
      if (!avatar.id) {
        avatar.id = this.generateUniqueId();
      }

      // Ensure the name is set; default if not provided
      if (!avatar.name) {
        avatar.name = `Avatar_${avatar.id}`;
      }

      // Step 4: Download the Image as Buffer
      const imageFile = await this.generateAvatarImage(avatar.description);

      // Step 5: Upload the Image to S3
      const s3url = await uploadImage(imageFile);
      console.log('S3 URL:', s3url);

      // Step 6: Insert the Prompt and Result into MongoDB
      await this.insertRequestIntoMongo(avatar.description, s3url, data.channelId);

      // Step 7: Create Avatar Document
      const avatarDocument = {
        name: avatar.name,
        emoji: avatar.emoji,
        personality: avatar.personality,
        description: avatar.description,
        imageUrl: s3url,
        channelId: data.channelId,
        createdAt: new Date(),
      };

      // Check for Arweave prompt before generating
      if (data.arweave_prompt) {
        avatarDocument.arweave_prompt = data.arweave_prompt;
        const syncedPrompt = await this.syncArweavePrompt(avatarDocument);
        if (syncedPrompt) {
          avatarDocument.prompt = syncedPrompt;
        }
      }

      // Step 8: Insert Avatar into the 'avatars' Collection
      const result = await this.db.collection(this.AVATARS_COLLECTION).insertOne(avatarDocument);
      if (result.acknowledged === true) {
        this.logger.info(`Avatar "${avatar.name} ${avatar.emoji}" created successfully with ID: ${result.insertedId}`);
        return { _id: result.insertedId, ...avatarDocument };
      } else {
        this.logger.error('Failed to insert avatar into the database.');
        return null;
      }
    } catch (error) {
      this.logger.error(`Error during avatar creation: ${error.message}`);
      return null;
    }
  }

  /**
   * Regenerates an avatar image if the current image URL is defunct.
   * @param {string} avatarId - The ID of the avatar to check and regenerate.
   * @returns {boolean} - True if regeneration was successful, false otherwise.
   */
  async regenerateAvatarImage(avatarId) {
    if (!this.db) {
      this.logger.error('Database is not connected. Cannot regenerate avatar image.');
      return false;
    }

    try {
      const avatar = await this.db.collection(this.AVATARS_COLLECTION).findOne({ _id: ObjectId.createFromTime(avatarId) });
      if (!avatar) {
        this.logger.error(`Avatar with ID ${avatarId} not found.`);
        return false;
      }

      // Step 1: Check if the current image URL is accessible
      const isAccessible = await this.isImageAccessible(avatar.imageUrl);
      if (isAccessible) {
        this.logger.info(`Avatar image for ID ${avatarId} is accessible. No regeneration needed.`);
        return true;
      }

      this.logger.warn(`Avatar image for ID ${avatarId} is defunct. Regenerating...`);

      // Step 3: Download the new image
      const imageFile = await this.generateAvatarImage(avatar.description)
      if (!imageFile) {
        this.logger.error('Regeneration aborted: Image download failed.');
        return false;
      }

      const s3Url = await uploadImage(imageFile);

      // Step 5: Update the avatar document with the new image URL
      const updateResult = await this.db.collection(this.AVATARS_COLLECTION).updateOne(
        { _id: ObjectId.createFromTime(avatarId) },
        { $set: { imageUrl: s3Url, updatedAt: new Date() } }
      );

      if (updateResult.modifiedCount === 1) {
        this.logger.info(`Avatar ID ${avatarId} image regenerated successfully.`);
        return true;
      } else {
        this.logger.error(`Failed to update avatar ID ${avatarId} with the new image URL.`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Error during avatar image regeneration: ${error.message}`);
      return false;
    }
  }

  // Add a method to generate unique IDs
  generateUniqueId() {
    return new ObjectId().toString();
  }

  async syncArweavePrompt(avatar) {
    if (!avatar.arweave_prompt || !this.isValidUrl(avatar.arweave_prompt)) {
      return null;
    }

    try {
      const response = await fetch(avatar.arweave_prompt);
      if (!response.ok) {
        throw new Error(`Failed to fetch Arweave prompt: ${response.statusText}`);
      }
      const prompt = await response.text();
      
      // Update the avatar's prompt
      await this.avatarsCollection.updateOne(
        { _id: avatar._id },
        { $set: { prompt: prompt.trim() } }
      );

      return prompt.trim();
    } catch (error) {
      console.error(`Error syncing Arweave prompt: ${error.message}`);
      return null;
    }
  }

  isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (err) {
      return false;
    }
  }

  async updateAllArweavePrompts() {
    if (!this.db) {
      this.logger.error('Database is not connected. Cannot update Arweave prompts.');
      return;
    }

    try {
      const avatarsCollection = this.db.collection(this.AVATARS_COLLECTION);
      const avatarsWithArweave = await avatarsCollection.find({
        arweave_prompt: { $exists: true, $ne: null }
      }).toArray();

      this.logger.info(`Found ${avatarsWithArweave.length} avatars with Arweave prompts to update`);

      for (const avatar of avatarsWithArweave) {
        try {
          const syncedPrompt = await this.syncArweavePrompt(avatar);
          if (syncedPrompt) {
            this.logger.info(`Updated Arweave prompt for avatar: ${avatar.name}`);
          }
        } catch (error) {
          this.logger.error(`Failed to update Arweave prompt for avatar ${avatar.name}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error updating Arweave prompts: ${error.message}`);
    }
  }
}
