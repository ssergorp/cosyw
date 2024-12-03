import { BaseTool } from './BaseTool.mjs';
import { LocationService } from '../../location/locationService.mjs';
import { sendAsWebhook } from '../../discordService.mjs';

export class MoveTool extends BaseTool {
  constructor(dungeonService) {
    super(dungeonService);
    if (!dungeonService.client) {
      throw new Error('Discord client is required for MoveTool');
    }
    this.locationService = new LocationService(dungeonService.client, dungeonService.aiService);
  }

  async execute(message, params, avatar) {
  

    if (!message.channel.guild) {
      return "This command can only be used in a guild!";
    }

    if (!params || !params[0]) {
      return "Move where? Specify a destination!";
    }

    let destination = params.join(' ');

    // remove 'to ' from the beginning
    if (destination.toLowerCase().startsWith('to ')) {
      destination = destination.substring(3);
    }

    try {
      const currentLocation = await this.dungeonService.getAvatarLocation(avatar._id);
      const newLocation = await this.locationService.findOrCreateLocation(
        message.channel.guild, 
        destination,
        message.channel
      );

      if (!newLocation) {
        return "Failed to find or create that location!";
      }

      // Handle departure message
      if (currentLocation?.channel) {  // Add null check and channel check
        if (currentLocation.channel.id === newLocation.channel.id) {
          return "You're already there!";
        }
        try {
          const departureMessage = await this.locationService.generateDepartureMessage(avatar, currentLocation, newLocation);
          return departureMessage;
        } catch (error) {
          console.error('Error sending departure message:', error);
        }
      }

      // Update position and set maximum attention in new location
      await this.dungeonService.updateAvatarPosition(avatar._id, newLocation.channel.id);

      // Generate and send arrival message
      try {
        const arrivalMessage = await this.locationService.generateAvatarResponse(avatar, newLocation);
        // Process any user/channel mentions in the message
        await sendAsWebhook(
          newLocation.channel.id,
          arrivalMessage,
          avatar.name,
          avatar.imageUrl);

        avatar.channelId = newLocation.channel.id;
        await this.dungeonService.avatarService.updateAvatar(avatar);
      } catch (error) {
        console.error('Error sending arrival message:', error);
      }

      return `${avatar.name} moved to ${newLocation.channel.name}!`;
    } catch (error) {
      console.error('Error in MoveTool execute:', error);
      return "Failed to move: " + error.message;
    }
  }

  getDescription() {
    return 'Move to a different area';
  }

  getSyntax() {
    return '!move <location>';
  }
}