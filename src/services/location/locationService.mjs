import Fuse from 'fuse.js';
import { OpenRouterService } from '../openrouterService.mjs';
import { uploadImage } from '../s3imageService.mjs';
import { sendAsWebhook } from '../discordService.mjs';
import Replicate from 'replicate';
import fs from 'fs/promises';

export class LocationService {
  constructor(discordClient, aiService = null) {
    if (!discordClient) {
      throw new Error('Discord client is required for LocationService');
    }
    this.client = discordClient;
    this.aiService = aiService || new OpenRouterService(); // Allow injection or create new
    this.fuseOptions = {
      threshold: 0.4,
      keys: ['name']
    };

    // Add Replicate for image generation
    this.replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN
    });
  }
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

  async generateLocationImage(locationName, description) {
    const [output] = await this.replicate.run(
      "immanencer/mirquo:dac6bb69d1a52b01a48302cb155aa9510866c734bfba94aa4c771c0afb49079f",
      {
        input: {
          prompt: `MRQ ${locationName} holographic black neon location ${description} MRQ`,
          model: "dev",
          lora_scale: 1,
          num_outputs: 1,
          aspect_ratio: "16:9",
          output_format: "png",
          guidance_scale: 3.5,
          output_quality: 90,
          prompt_strength: 0.8,
          extra_lora_scale: 1,
          num_inference_steps: 28,
          disable_safety_checker: true,
        }
      }
    );

    const imageUrl = output.url ? output.url() : [output];
    const imageBuffer = await this.downloadImage(imageUrl.toString());
    const filename = `./images/location_${Date.now()}.png`;
    await fs.mkdir('./images', { recursive: true });
    await fs.writeFile(filename, imageBuffer);
    return await uploadImage(filename);
  }

  async generateDepartureMessage(avatar, currentLocation, newLocation) {
    const prompt = `You are ${currentLocation.name}. Describe ${avatar.name}'s departure to ${newLocation.name} in a brief atmospheric message.`;
    const response = await this.aiService.chat([
      { role: 'system', content: 'You are a mystical location describing travelers.' },
      { role: 'user', content: prompt }
    ]);
    return response;
  }

  async generateLocationDescription(locationName, imageUrl) {
    const prompt = `
      You are a master storyteller describing a mystical location.
      Looking at this scene of ${locationName}, write a vivid, evocative description that brings it to life.
      Focus on the atmosphere, unique features, and feelings it evokes.
      Keep it to 2-3 compelling sentences.`;

    const response = await this.aiService.chat([
      { role: 'system', content: 'You are a poetic location narrator skilled in atmospheric descriptions.' },
      { role: 'user', content: prompt }
    ]);

    return response;
  }

  async findOrCreateLocation(guild, locationName) {
    if (!guild) {
      throw new Error('Guild is required to find or create location');
    }

    try {
      const channels = await this.getAllLocations(guild);
      const fuse = new Fuse(channels, this.fuseOptions);
      
      // Try to find existing location
      const matches = fuse.search(locationName);
      if (matches.length > 0) {
        return matches[0].item;
      }

      // Create new thread in the nearest matching channel
      const channelFuse = new Fuse(guild.channels.cache.filter(c => c.isTextBased()).map(c => ({
        name: c.name,
        channel: c
      })), this.fuseOptions);

      const channelMatch = channelFuse.search(locationName)[0]?.item.channel || 
                          guild.channels.cache.find(c => c.isTextBased());

      const locationsChannel = guild.channels.cache.find(c => 
        (c.name === 'locations' && c.threads) || // Check for thread support
        c.type === 15 || // Forum channel type
        (c.isTextBased() && c.threads) // Any text channel with thread support
      );

      if (!locationsChannel) {
        throw new Error('No suitable channel found for creating location');
      }

      const locationDescription = await this.aiService.chat([
        { role: 'system', content: 'Generate a brief, atmospheric description of this fantasy location.' },
        { role: 'user', content: `Describe ${locationName} in 2-3 sentences.` }
      ]);

      // First generate and upload the image
      const locationImage = await this.generateLocationImage(locationName, locationDescription);

      // Create the thread
      const thread = await locationsChannel.threads.create({
        name: locationName,
        autoArchiveDuration: 60
      });

      // Post image by itself first
      await thread.send({ 
        files: [{ 
          attachment: locationImage,
          name: `${locationName.toLowerCase().replace(/\s+/g, '_')}.png`
        }]
      });

      // Generate evocative description based on the image
      const evocativeDescription = await this.generateLocationDescription(locationName, locationImage);

      // Send the description as the location
      await sendAsWebhook(
        this.client,
        thread.id,
        evocativeDescription,
        locationName,
        locationImage
      );

      // Return the location data
      return {
        id: thread.id,
        name: locationName,
        channel: thread,
        description: evocativeDescription,
        imageUrl: locationImage
      };
    } catch (error) {
      console.error('Error in findOrCreateLocation:', error);
      return null;
    }
  }

  async getAllLocations(guild) {
    const locations = [];
    
    // Get all text channels
    const textChannels = guild.channels.cache.filter(c => c.isTextBased());
    locations.push(...textChannels.map(c => ({ name: c.name, channel: c })));

    // Get all active threads from channels that support threading
    for (const channel of textChannels.values()) {
      // Check if channel supports threads
      if (channel.threads && typeof channel.threads.fetchActive === 'function') {
        try {
          const threads = await channel.threads.fetchActive();
          if (threads?.threads?.size > 0) {
            locations.push(...threads.threads.map(t => ({ name: t.name, channel: t })));
          }
        } catch (error) {
          console.warn(`Failed to fetch threads for channel ${channel.name}:`, error.message);
          continue; // Skip this channel and continue with others
        }
      }
    }

    return locations;
  }

  async generateAvatarResponse(avatar, location) {
    const prompt = `You are ${avatar.name}, a ${avatar.personality}. You have just arrived at ${location.name}. Write a short IC (in-character) message about your arrival or your reaction to this place.`;
    
    const response = await this.aiService.chat([
      { role: 'system', content: 'You are a character in a roleplay setting. Keep responses brief and in-character.' },
      { role: 'user', content: prompt }
    ]);

    return response;
  }
}