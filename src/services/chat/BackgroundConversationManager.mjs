
export class BackgroundConversationManager {
  constructor(logger) {
    this.logger = logger;
    this.lastUpdateTime = new Map(); // channelId -> timestamp
    this.UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
    this.MAX_UPDATES_PER_CYCLE = 2; // Max number of channels to update per cycle
  }

  shouldUpdateChannel(channelId, currentTime) {
    const lastUpdate = this.lastUpdateTime.get(channelId) || 0;
    return currentTime - lastUpdate >= this.UPDATE_INTERVAL;
  }

  markChannelUpdated(channelId) {
    this.lastUpdateTime.set(channelId, Date.now());
  }

  getNextChannelsToUpdate(channels) {
    const currentTime = Date.now();
    return channels
      .filter(channel => this.shouldUpdateChannel(channel.id, currentTime))
      .slice(0, this.MAX_UPDATES_PER_CYCLE);
  }
}