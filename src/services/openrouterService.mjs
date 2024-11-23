import OpenAI from 'openai';

export class OpenRouterService {
  constructor(apiKey) {
    this.model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct:free';
    this.openai = new OpenAI({
      apiKey: ( apiKey || process.env.OPENROUTER_API_TOKEN),
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://ratimics.com', // Optional, for including your app on openrouter.ai rankings.
        'X-Title': 'rativerse',      // Optional. Shows in rankings on openrouter.ai.
      },
    });
  }

  // Method to generate a completion from OpenRouter
  async generateCompletion(prompt, options = {}) {
    try {
      const response = await this.openai.completions.create({
        model: this.model,
        prompt,
        ...options,
      });
      if (!response || !response.choices || response.choices.length === 0) {
        console.error('Invalid response from OpenRouter during completion generation.');
        return null;
      }
      return response.choices[0].text.trim();
    } catch (error) {
      console.error('Error while generating completion from OpenRouter:', error);
      return null;
    }
  }

  // Method to have a chat with OpenRouter
  async chat(messages, options = {}) {
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        ...options,
      });
      if (!response || !response.choices || response.choices.length === 0) {
        console.error('Invalid response from OpenRouter during chat.');
        return null;
      }
      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error while chatting with OpenRouter:', error);
      return null;
    }
  }
}
