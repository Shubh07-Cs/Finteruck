const WebSocket = require('ws');

class DeepgramService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.transcriptCallback = null;
    this.isConnected = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: 'nova-3',
        language: 'en',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        punctuate: 'true',
        smart_format: 'true',
        interim_results: 'true',
        utterance_end_ms: '1500',
        vad_events: 'true',
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      this.ws.on('open', () => {
        console.log('Deepgram WebSocket connected');
        this.isConnected = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'Results') {
            const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
            const isFinal = msg.is_final || false;
            const speechFinal = msg.speech_final || false;
            if (this.transcriptCallback) {
              this.transcriptCallback({ text: transcript, isFinal, speechFinal });
            }
          } else if (msg.type === 'UtteranceEnd') {
            if (this.transcriptCallback) {
              this.transcriptCallback({ utteranceEnd: true });
            }
          }
        } catch (e) {
          console.error('Deepgram parse error:', e);
        }
      });

      this.ws.on('error', (err) => {
        console.error('Deepgram WebSocket error:', err.message);
        this.isConnected = false;
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('Deepgram WebSocket closed');
        this.isConnected = false;
      });

      // Timeout after 10s
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Deepgram connection timeout'));
        }
      }, 10000);
    });
  }

  sendAudio(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(Buffer.from(buffer));
    }
  }

  stop() {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
      this.isConnected = false;
    }
  }

  onTranscript(callback) {
    this.transcriptCallback = callback;
  }
}

module.exports = DeepgramService;
