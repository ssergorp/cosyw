import ollama from 'ollama';

export class OllamaService {
  constructor() {
    this.model = 'llama3.2';
  }

  // Method to generate a completion from Ollama
  async generateCompletion(prompt, options = {}) {
    try {
      const response = await ollama.generate({
        model: this.model,
        prompt,
        ...options,
      });
      if (!response || !response.response || response.response.length === 0) {
        console.error('Invalid response from Ollama during completion generation.');
        return null;
      }
      return response.response.trim();
    } catch (error) {
      console.error('Error while generating completion from Ollama:', error);
      return null;
    }
  }

  // Method to have a chat with Ollama
  async chat(messages, options = {}) {
    try {
      const response = await ollama.chat({
        model: this.model,
        messages,
        ...options,
      });
      if (!response || !response.message || !response.message.content) {
        console.error('Invalid response from Ollama during chat.');
        return null;
      }
      return response.message.content.trim();
    } catch (error) {
      console.error('Error while chatting with Ollama:', error);
      return null;
    }
  }
}