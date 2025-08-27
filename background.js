class TranscriptionService {
    constructor() {
        this.isRecording = false;
        this.audioBuffer = [];
        this.retryQueue = [];
        this.maxRetries = 3;
        this.baseDelay = 1000;
        
        this.init();
    }

    init() {
        // Listen for messages from sidepanel
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep message channel open for async response
        });

        // Handle extension icon click
        chrome.action.onClicked.addListener(async (tab) => {
            await chrome.sidePanel.open({ tabId: tab.id });
        });

        // Process retry queue periodically
        setInterval(() => this.processRetryQueue(), 5000);
    }

    async handleMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'startRecording':
                    await this.startRecording(message.sourceType);
                    sendResponse({ success: true });
                    break;

                case 'stopRecording':
                    await this.stopRecording();
                    sendResponse({ success: true });
                    break;

                case 'transcribeAudio':
                    await this.transcribeAudio(message.audioData, message.timestamp);
                    sendResponse({ success: true });
                    break;

                default:
                    sendResponse({ success: false, error: 'Unknown message type' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ success: false, error: error.message });
            
            // Send error to sidepanel
            this.sendToSidepanel({
                type: 'error',
                message: error.message
            });
        }
    }

    async startRecording(sourceType) {
        this.isRecording = true;
        console.log('Started recording:', sourceType);
    }

    async stopRecording() {
        this.isRecording = false;
        this.audioBuffer = [];
        console.log('Stopped recording');
    }

    async transcribeAudio(audioData, timestamp) {
        if (!this.isRecording) return;

        try {
            const settings = await chrome.storage.sync.get([
                'apiProvider',
                'gemini_api_key',
                'whisper_api_key',
                'deepgram_api_key',
                'fireworks_api_key'
            ]);

            const apiProvider = settings.apiProvider || 'gemini';
            const apiKey = settings[`${apiProvider}_api_key`];

            if (!apiKey) {
                throw new Error(`No API key configured for ${apiProvider}`);
            }

            const transcriptionResult = await this.callTranscriptionAPI(
                apiProvider,
                apiKey,
                audioData,
                timestamp
            );

            // Send result to sidepanel
            this.sendToSidepanel({
                type: 'transcriptionResult',
                data: transcriptionResult
            });

        } catch (error) {
            console.error('Transcription error:', error);
            
            // Add to retry queue
            this.retryQueue.push({
                audioData,
                timestamp,
                retryCount: 0,
                lastError: error.message
            });

            this.sendToSidepanel({
                type: 'error',
                message: `Transcription failed: ${error.message}`
            });
        }
    }

    async callTranscriptionAPI(provider, apiKey, audioData, timestamp) {
        switch (provider) {
            case 'gemini':
                return await this.callGeminiAPI(apiKey, audioData, timestamp);
            case 'whisper':
                return await this.callWhisperAPI(apiKey, audioData, timestamp);
            case 'deepgram':
                return await this.callDeepgramAPI(apiKey, audioData, timestamp);
            case 'fireworks':
                return await this.callFireworksAPI(apiKey, audioData, timestamp);
            default:
                throw new Error(`Unsupported API provider: ${provider}`);
        }
    }

    async callGeminiAPI(apiKey, audioData, timestamp) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;
        
        const payload = {
            contents: [{
                parts: [
                    {
                        text: "Please transcribe the following audio file. Return only the transcribed text without any additional commentary or formatting."
                    },
                    {
                        inline_data: {
                            mime_type: "audio/webm",
                            data: audioData
                        }
                    }
                ]
            }]
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Gemini API error: ${response.status} - ${errorData}`);
        }

        const result = await response.json();
        
        if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
            throw new Error('Invalid response from Gemini API');
        }

        const transcribedText = result.candidates[0].content.parts[0].text;

        return {
            text: transcribedText,
            timestamp: timestamp,
            source: 'Tab Audio',
            confidence: null,
            provider: 'gemini'
        };
    }

    async callWhisperAPI(apiKey, audioData, timestamp) {
        // Convert base64 to blob for OpenAI API
        const audioBlob = this.base64ToBlob(audioData, 'audio/webm');
        
        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
        formData.append('model', 'whisper-1');
        formData.append('response_format', 'json');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Whisper API error: ${response.status} - ${errorData}`);
        }

        const result = await response.json();

        return {
            text: result.text,
            timestamp: timestamp,
            source: 'Tab Audio',
            confidence: null,
            provider: 'whisper'
        };
    }

    async callDeepgramAPI(apiKey, audioData, timestamp) {
        const audioBlob = this.base64ToBlob(audioData, 'audio/webm');

        const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
            method: 'POST',
            headers: {
                'Authorization': `Token ${apiKey}`,
                'Content-Type': 'audio/webm'
            },
            body: audioBlob
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Deepgram API error: ${response.status} - ${errorData}`);
        }

        const result = await response.json();

        if (!result.results || !result.results.channels || !result.results.channels[0]) {
            throw new Error('Invalid response from Deepgram API');
        }

        const transcript = result.results.channels[0].alternatives[0].transcript;
        const confidence = result.results.channels[0].alternatives[0].confidence;

        return {
            text: transcript,
            timestamp: timestamp,
            source: 'Tab Audio',
            confidence: confidence,
            provider: 'deepgram'
        };
    }

    async callFireworksAPI(apiKey, audioData, timestamp) {
        // Note: This is a placeholder implementation
        // Fireworks AI may not have a direct speech-to-text API
        // You would need to check their actual API documentation
        throw new Error('Fireworks API implementation not available');
    }

    base64ToBlob(base64Data, contentType) {
        const byteCharacters = atob(base64Data);
        const byteArrays = [];

        for (let offset = 0; offset < byteCharacters.length; offset += 512) {
            const slice = byteCharacters.slice(offset, offset + 512);
            const byteNumbers = new Array(slice.length);
            
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            
            const byteArray = new Uint8Array(byteNumbers);
            byteArrays.push(byteArray);
        }

        return new Blob(byteArrays, { type: contentType });
    }

    async processRetryQueue() {
        if (this.retryQueue.length === 0) return;

        const item = this.retryQueue.shift();
        
        if (item.retryCount >= this.maxRetries) {
            console.error(`Max retries exceeded for transcription: ${item.lastError}`);
            return;
        }

        try {
            const delay = this.baseDelay * Math.pow(2, item.retryCount);
            await new Promise(resolve => setTimeout(resolve, delay));

            const settings = await chrome.storage.sync.get([
                'apiProvider',
                'gemini_api_key',
                'whisper_api_key',
                'deepgram_api_key',
                'fireworks_api_key'
            ]);

            const apiProvider = settings.apiProvider || 'gemini';
            const apiKey = settings[`${apiProvider}_api_key`];

            if (!apiKey) {
                throw new Error(`No API key configured for ${apiProvider}`);
            }

            const result = await this.callTranscriptionAPI(
                apiProvider,
                apiKey,
                item.audioData,
                item.timestamp
            );

            this.sendToSidepanel({
                type: 'transcriptionResult',
                data: result
            });

        } catch (error) {
            item.retryCount++;
            item.lastError = error.message;
            this.retryQueue.push(item);
        }
    }

    sendToSidepanel(message) {
        // Send message to all tabs (sidepanel will receive it)
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, message).catch(() => {
                    // Ignore errors for tabs that can't receive messages
                });
            });
        });

        // Also try to send via runtime messaging
        chrome.runtime.sendMessage(message).catch(() => {
            // Ignore errors if no listeners
        });
    }
}

// Initialize the background service
new TranscriptionService();