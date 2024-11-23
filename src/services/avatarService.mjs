// services/avatar_generation_service.mjs

import Replicate from 'replicate';
// import { OllamaService as AIService } from './ollamaService.mjs';
import { OpenRouterService as AIService } from './openrouterService.mjs';
import https from 'https';
import { MongoClient } from 'mongodb';
import process from 'process';
import winston from 'winston';
import { v2 as cloudinary } from 'cloudinary';
import { extractJSON } from './utils.mjs';

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
  }

  /**
   * Connects the service to the MongoDB database.
   */
  async connectToDatabase() {
    try {
      await this.mongoClient.connect();
      this.db = this.mongoClient.db(this.DB_NAME);
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
      const avatars = await collection.find({}).toArray();
      return avatars;
    } catch (error) {
      this.logger.error(`Error fetching avatars: ${error.message}`);
      return [];
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
      // Define the prompt to request description, emoji, and personality
      const prompt = `Provide a detailed visual description, an appropriate emoji, and a personality description for a character based on the following prompt
      
      "${userPrompt}".
      
      Please respond in the following JSON format. ONLY provide valid JSON as a response.
      Creatively fill in any details without comment, keep all responses to no more than four sentences. 
  {
    "name": "<name the character>",
    "emoji": "<insert an emoji 🤗 that best represents the character>",
    "description": "<insert a one paragraph detailed description of the characters profile picture>",
    "personality": "<generate a short unique personality description>'}"
  }`;

      // Generate the completion using Ollama service
      const response = await this.aiService.generateCompletion(prompt, { format: "json" });

      // Check if the response is valid
      if (!response) {
        this.logger.error('Failed to generate avatar details.');
        return null;
      }

      // Attempt to parse the response as JSON
      let avatarDetails;
      try {
        avatarDetails = JSON.parse(extractJSON(response.trim()));
      } catch (parseError) {
        this.logger.error('Failed to parse avatar details response as JSON.');
        return null;
      }
      // Destructure the necessary fields from the parsed JSON
      const { name, description, emoji, personality } = avatarDetails;

      // Validate that all required fields are present
      if (!name || !description || !personality) {
        this.logger.error('Incomplete avatar details received.');
        return null;
      }

      // Return the structured avatar details
      return { name, description, emoji: emoji || "🤗", personality };
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
      return count < 10; // Set your daily limit here
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
    try {
      const input = { prompt };

      // Step 1: Initiate the image generation request using Replicate API
      const prediction = await this.replicate.predictions.create({
        model: process.env["REPLICATE_MODEL"],
        input: `MRQ ${input} \n\n cthonic watercolor MRQ`,
      });
      this.logger.info(`Prediction started: ${prediction.id}`);

      // Step 2: Poll the prediction status until the image is ready
      let completed = null;
      const maxAttempts = 30; // Maximum number of polling attempts (e.g., 30 * 2s = 60s)
      for (let i = 0; i < maxAttempts; i++) {
        const latest = await this.replicate.predictions.get(prediction.id);
        this.logger.info(`Polling attempt ${i + 1}/${maxAttempts}: Status - ${latest.status}`);

        if (latest.status === 'succeeded') {
          completed = latest;
          break;
        } else if (latest.status === 'failed') {
          throw new Error('Prediction failed');
        }

        // Wait for 2 seconds before the next poll
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!completed) {
        throw new Error('Prediction did not complete within the expected time.');
      }

      // Step 3: Extract the image URL
      const imageUrl = completed.output; // Adjust if the output structure is different
      if (!imageUrl) {
        throw new Error('No output URL found in the prediction result.');
      }

      this.logger.info(`Image generated successfully: ${imageUrl}`);
      return imageUrl;
    } catch (error) {
      this.logger.error(`Error during avatar image generation: ${error.message}`);
      return null;
    }
  }

  /**
 * Updates an avatar's details.
 * @param {string} avatarId - The ID of the avatar to update.
 * @param {Object} updates - The fields to update.
 * @param {string} [updates.name] - The new name of the avatar.
 * @param {string} [updates.emoji] - The new emoji representing the avatar.
 * @param {string} [updates.personality] - The new personality traits.
 * @param {string} [updates.description] - The new description of the avatar.
 * @param {string} [updates.channelId] - The updated Discord channel ID associated with the avatar.
 * @returns {Object|null} - The updated avatar document or null if the update failed.
 */
  async updateAvatar(avatarId, updates) {
    if (!this.db) {
      this.logger.error('Database is not connected. Cannot update avatar.');
      return null;
    }

    try {
      // Prepare the update document
      const updateDoc = {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      };

      // Update the avatar in the 'avatars' collection
      const updateResult = await this.db.collection(this.AVATARS_COLLECTION).updateOne(
        { _id: new MongoClient.ObjectId(avatarId) },
        updateDoc
      );

      if (updateResult.matchedCount === 0) {
        this.logger.error(`Avatar with ID ${avatarId} not found.`);
        return null;
      }

      if (updateResult.modifiedCount === 1) {
        this.logger.info(`Avatar ID ${avatarId} updated successfully.`);
        // Fetch the updated document
        const updatedAvatar = await this.db.collection(this.AVATARS_COLLECTION).findOne({ _id: new MongoClient.ObjectId(avatarId) });
        return updatedAvatar;
      } else {
        this.logger.error(`Failed to update avatar with ID ${avatarId}.`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Error during avatar update: ${error.message}`);
      return null;
    }
  }


  /**
   * Uploads an image buffer to Cloudinary.
   * @param {Buffer} imageBuffer - The image data as a buffer.
   * @param {string} publicId - The desired public ID for the image.
   * @returns {string|null} - The Cloudinary URL of the uploaded image or null if failed.
   */
  async uploadImageToCloudinary(imageBuffer, publicId) {
    try {
      // Convert buffer to base64 string
      const base64Image = imageBuffer.toString('base64');
      const dataUri = `data:image/png;base64,${base64Image}`; // Adjust MIME type if necessary

      const result = await cloudinary.uploader.upload(dataUri, {
        public_id: publicId,
        folder: 'avatars', // Optional: Organize images into folders
        overwrite: true, // Overwrite if public_id already exists
        resource_type: 'image',
      });

      this.logger.info(`Image uploaded to Cloudinary: ${result.secure_url}`);
      return result.secure_url;
    } catch (error) {
      this.logger.error(`Cloudinary upload failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Downloads an image from a given URL and returns it as a buffer.
   * @param {string} url - The URL of the image to download.
   * @returns {Buffer|null} - The image buffer or null if failed.
   */
  // Function to download image
  async downloadImage(imageUrl) {
    return new Promise((resolve, reject) => {
      const options = {
        rejectUnauthorized: false // Allow self-signed certificates
      };

      https.get(imageUrl, options, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to get image. Status code: ${response.statusCode}`));
          return;
        }

        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          resolve(data);
        });
      }).on('error', (error) => {
        reject(new Error(`Error downloading the image: ${error.message}`));
      });
    });
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
  async createAvatar({ prompt, channelId = null }) {
    if (!this.db) {
      this.logger.error('Database is not connected. Cannot create avatar.');
      return null;
    }

    try {
      // Step 1: Check Daily Limit
      const underLimit = await this.checkDailyLimit(channelId);
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

      // Step 3: Generate Avatar Image with Polling
      // Step 3: Generate Avatar Image with Retry Logic
      const MAX_RETRIES = 3; // Maximum number of retry attempts
      const RETRY_DELAY_MS = 1000; // Delay between retries in milliseconds (optional)

      let replicateImageUrl = null;
      let attempt = 0;

      while (attempt < MAX_RETRIES && !replicateImageUrl) {
        try {
          attempt += 1;
          this.logger.info(`Attempt ${attempt} to generate avatar image.`);

          replicateImageUrl = await this.generateAvatarImage(avatar.description);

          if (!replicateImageUrl) {
            this.logger.warn(`Attempt ${attempt} failed: No image URL returned.`);

            if (attempt < MAX_RETRIES) {
              this.logger.info(`Retrying in ${RETRY_DELAY_MS}ms...`);
              await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
            }
          }
        } catch (error) {
          this.logger.error(`Attempt ${attempt} encountered an error: ${error.message}`);

          if (attempt < MAX_RETRIES) {
            this.logger.info(`Retrying in ${RETRY_DELAY_MS}ms...`);
            await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
          } else {
            this.logger.error('Maximum retry attempts reached. Avatar creation aborted.');
            return null;
          }
        }
      }

      if (!replicateImageUrl) {
        this.logger.error('Avatar creation aborted: Image generation failed after multiple attempts.');
        return null;
      }

      // Step 4: Download the Image as Buffer
      const imageBuffer = await this.downloadImage(replicateImageUrl);
      if (!imageBuffer) {
        this.logger.error('Avatar creation aborted: Image download failed.');
        return null;
      }

      // Step 5: Upload Image to Cloudinary
      const publicId = `avatar_${Date.now()}_${Math.floor(Math.random() * 1000)}`; // Unique public ID
      const cloudinaryUrl = await this.uploadImageToCloudinary(imageBuffer, publicId);
      if (!cloudinaryUrl) {
        this.logger.error('Avatar creation aborted: Cloudinary upload failed.');
        return null;
      }

      // Step 6: Insert the Prompt and Result into MongoDB
      await this.insertRequestIntoMongo(avatar.description, cloudinaryUrl, channelId);

      // Step 7: Create Avatar Document
      const avatarDocument = {
        name: avatar.name,
        emoji: avatar.emoji,
        personality: avatar.personality,
        description: avatar.description,
        imageUrl: cloudinaryUrl,
        channelId,
        createdAt: new Date(),
      };

      // Step 8: Insert Avatar into the 'avatars' Collection
      const result = await this.db.collection(this.AVATARS_COLLECTION).insertOne(avatarDocument);
      if (result.acknowledged === true) {
        this.logger.info(`Avatar "${name}" created successfully with ID: ${result.insertedId}`);
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
      const avatar = await this.db.collection(this.AVATARS_COLLECTION).findOne({ _id: new MongoClient.ObjectId(avatarId) });
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

      // Step 2: Generate a new avatar image
      const newImageUrl = await this.generateAvatarImage(avatar.description);
      if (!newImageUrl) {
        this.logger.error('Regeneration aborted: Image generation failed.');
        return false;
      }

      // Step 3: Download the new image
      const imageBuffer = await this.downloadImage(newImageUrl);
      if (!imageBuffer) {
        this.logger.error('Regeneration aborted: Image download failed.');
        return false;
      }

      // Step 4: Upload the new image to Cloudinary
      const publicId = `avatar_${Date.now()}_${Math.floor(Math.random() * 1000)}`; // Unique public ID
      const cloudinaryUrl = await this.uploadImageToCloudinary(imageBuffer, publicId);
      if (!cloudinaryUrl) {
        this.logger.error('Regeneration aborted: Cloudinary upload failed.');
        return false;
      }

      // Step 5: Update the avatar document with the new image URL
      const updateResult = await this.db.collection(this.AVATARS_COLLECTION).updateOne(
        { _id: new MongoClient.ObjectId(avatarId) },
        { $set: { imageUrl: cloudinaryUrl, updatedAt: new Date() } }
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
}
