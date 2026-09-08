const WebSocket = require('ws');

// ---------------------------------------------------------------------------
// Configuration constants (adapted from Natively's DeepgramStreamingSTT.ts)
// ---------------------------------------------------------------------------
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS  = 30000;
const RECONNECT_MAX_ATTEMPTS  = 10;
const KEEPALIVE_INTERVAL_MS   = 8000;
const AUDIO_BUFFER_MAX_CHUNKS = 500;
const REVIVE_COOLDOWN_MS      = 15000;

class DeepgramService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.transcriptCallback = null;
    this.isConnected = false;
    this.isActive = false;
    this.shouldReconnect = false;
    this.isConnecting = false;

    // Ring buffer: holds audio chunks while WebSocket is connecting/reconnecting
    // so no words at the start of a sentence are ever lost.
    this.audioBuffer = [];

    // Reconnection state (exponential backoff)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stabilityTimer = null;
    this.exhaustedAt = null;

    // Keepalive: prevents Deepgram idle-timeout (closes after ~12s of silence)
    this.keepAliveInterval = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.isActive) { resolve(); return; }
      this.isActive = true;
      this.shouldReconnect = true;
      this.reconnectAttempts = 0;
      this.exhaustedAt = null;

      this._connect()
        .then(resolve)
        .catch(reject);
    });
  }

  _connect() {
    return new Promise((resolve, reject) => {
      if (this.isConnecting) { resolve(); return; }
      this.isConnecting = true;

      const params = new URLSearchParams({
        model: 'nova-3',
        language: 'en',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        punctuate: 'true',
        smart_format: 'true',
        interim_results: 'true',
        // --- UPGRADED: Ultra-low latency endpointing (from Natively) ---
        // endpointing: 300ms means Deepgram finalizes a segment after just
        // 300ms of silence (down from the default 460ms).
        endpointing: '300',
        // utterance_end_ms: 3000ms — wait 3 full seconds of silence before
        // declaring the utterance "done". Prevents premature sends when
        // interviewers pause to think ("hmm...", "so...", "let me think...").
        utterance_end_ms: '3000',
        vad_events: 'true',
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      // Identity guard (from Natively): on reconnection, the OLD websocket's
      // event handlers must not mutate state for the NEW connection.
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      this.ws = ws;

      let resolved = false;

      ws.on('open', () => {
        // Stale connection guard
        if (ws !== this.ws) return;

        console.log('[Deepgram] Connected');
        this.isConnecting = false;
        this.isConnected = true;

        // --- UPGRADED: Flush buffered audio (from Natively) ---
        // Any audio that arrived while we were connecting is immediately
        // sent so no words are lost at the start of a sentence.
        const buffered = this.audioBuffer.splice(0);
        if (buffered.length > 0) {
          console.log(`[Deepgram] Flushing ${buffered.length} buffered audio chunks`);
          for (const chunk of buffered) {
            try { ws.send(chunk); } catch {}
          }
        }

        // --- UPGRADED: Keepalive ping (from Natively) ---
        // Deepgram closes idle WebSockets after ~12s. Sending a keepalive
        // every 8s prevents this during natural interview pauses.
        this._clearTimers();
        this.keepAliveInterval = setInterval(() => {
          if (this.isConnected && ws === this.ws) {
            try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
          }
        }, KEEPALIVE_INTERVAL_MS);

        // --- UPGRADED: Stability timer (from Natively) ---
        // Reset backoff counter only after 5s of stable connection, so a
        // rapid connect/drop cycle doesn't reset the backoff prematurely.
        this.stabilityTimer = setTimeout(() => {
          this.stabilityTimer = null;
          if (this.isConnected) this.reconnectAttempts = 0;
        }, 5000);

        if (!resolved) { resolved = true; resolve(); }
      });

      ws.on('message', (data) => {
        if (ws !== this.ws) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'Results') {
            const alt = msg.channel?.alternatives?.[0];
            const transcript = alt?.transcript || '';
            const isFinal = msg.is_final || false;
            const speechFinal = isFinal && msg.speech_final === true;

            if (this.transcriptCallback) {
              // --- UPGRADED: Emit speech_final endpoint (from Natively) ---
              // speech_final is more precise than utterance_end. It fires when
              // Deepgram is confident the speaker finished their thought.
              if (!transcript && speechFinal) {
                this.transcriptCallback({ endpoint: true, type: 'speech_final' });
                return;
              }
              if (transcript) {
                this.transcriptCallback({
                  text: transcript,
                  isFinal,
                  speechFinal,
                  confidence: alt?.confidence ?? 1.0,
                });
              }
              if (speechFinal && transcript) {
                this.transcriptCallback({ endpoint: true, type: 'speech_final' });
              }
            }
          } else if (msg.type === 'UtteranceEnd') {
            if (this.transcriptCallback) {
              this.transcriptCallback({ endpoint: true, type: 'utterance_end' });
            }
          }
        } catch (e) {
          console.error('[Deepgram] Parse error:', e);
        }
      });

      ws.on('error', (err) => {
        if (ws !== this.ws) return;
        console.error('[Deepgram] WebSocket error:', err.message);
        this.isConnected = false;
        this.isConnecting = false;
        if (!resolved) { resolved = true; reject(err); }
      });

      ws.on('close', (code, reason) => {
        if (ws !== this.ws) return;
        console.log(`[Deepgram] Closed (code=${code})`);
        this.isConnected = false;
        this.isConnecting = false;
        this._clearTimers();

        // --- UPGRADED: Auto-reconnection (from Natively) ---
        // If the close was unexpected (not code 1000 normal), and we haven't
        // been told to stop, schedule a reconnect with exponential backoff.
        if (this.shouldReconnect && code !== 1000) {
          this._scheduleReconnect();
        }
      });

      // Timeout
      setTimeout(() => {
        if (!resolved && !this.isConnected) {
          resolved = true;
          reject(new Error('Deepgram connection timeout'));
        }
      }, 10000);
    });
  }

  sendAudio(buffer) {
    if (!this.isActive) return;

    const data = Buffer.from(buffer);

    if (!this.isConnected) {
      // --- UPGRADED: Ring buffer (from Natively) ---
      // Buffer audio while disconnected so words aren't lost.
      this.audioBuffer.push(data);
      if (this.audioBuffer.length > AUDIO_BUFFER_MAX_CHUNKS) {
        this.audioBuffer.shift();
      }

      // --- UPGRADED: Revival after exhaustion (from Natively) ---
      // If reconnect was exhausted but real audio is still arriving
      // (user came back after a long pause), grant one fresh attempt.
      if (!this.shouldReconnect && !this.isConnecting && this.exhaustedAt) {
        const elapsed = Date.now() - this.exhaustedAt;
        if (elapsed >= REVIVE_COOLDOWN_MS) {
          console.log('[Deepgram] Reviving exhausted reconnect (real audio detected)');
          this.shouldReconnect = true;
          this.reconnectAttempts = 0;
          this.exhaustedAt = null;
          this._connect().catch(() => {});
        }
      }

      // If we should reconnect but aren't currently doing so, trigger it.
      if (this.shouldReconnect && !this.isConnecting && !this.reconnectTimer) {
        this._connect().catch(() => {});
      }
      return;
    }

    try {
      this.ws.send(data);
    } catch (err) {
      console.error('[Deepgram] Send error:', err.message);
    }
  }

  stop() {
    this.shouldReconnect = false;
    this.isActive = false;
    this._clearTimers();

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000);
        }
      } catch {}
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.audioBuffer = [];
    console.log('[Deepgram] Stopped');
  }

  onTranscript(callback) {
    this.transcriptCallback = callback;
  }

  // --- Reconnection with exponential backoff (from Natively) ---
  _scheduleReconnect() {
    if (!this.shouldReconnect) return;

    // Discard stale buffered audio on reconnect — replaying seconds-old
    // audio overwhelms Deepgram's real-time endpoint.
    this.audioBuffer = [];

    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.error(`[Deepgram] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached`);
      this.exhaustedAt = Date.now();
      this.shouldReconnect = false;
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS
    );
    this.reconnectAttempts++;
    console.log(`[Deepgram] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this._connect().catch(() => {});
      }
    }, delay);
  }

  _clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.stabilityTimer) { clearTimeout(this.stabilityTimer); this.stabilityTimer = null; }
    if (this.keepAliveInterval) { clearInterval(this.keepAliveInterval); this.keepAliveInterval = null; }
  }
}

module.exports = DeepgramService;
