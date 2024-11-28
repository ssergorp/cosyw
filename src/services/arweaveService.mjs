import axios from 'axios';

export class ArweaveService {
  constructor() {
    this.cache = new Map();
  }

  isArweaveUrl(prompt) {
    return prompt.includes('arweave.net');
  }

  async fetchPrompt(url) {
    if (this.cache.has(url)) {
      return this.cache.get(url);
    }

    try {
      const response = await axios.get(url);
      const data = response.data;
      this.cache.set(url, data);
      return data;
    } catch (error) {
      throw new Error(`Failed to fetch Arweave data: ${error.message}`);
    }
  }
}