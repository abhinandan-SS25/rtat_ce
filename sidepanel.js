class AudioTranscriptionPanel {
    constructor() {
        this.isRecording = false;
        this.isPaused = false;
        this.startTime = null;
        this.sessionData = [];
        this.timerInterval = null;
        this.audioContext = null;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.chunkBuffer = [];
        this.lastOverlapBuffer = null;
        this.currentStream = null;
        this.tabStream = null;
        this.currentSourceLabel = 'Audio';
        
        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadSettings();
        this.updateConnectionStatus();
        this.setupPeriodicTranscription();
    }

    bindEvents() {
        // Main controls
        document.getElementById('startRecording').addEventListener('click', () => this.startRecording());
        document.getElementById('stopRecording').addEventListener('click', () => this.stopRecording());
        document.getElementById('pauseRecording').addEventListener('click', () => this.togglePause());

        // Export controls
        document.getElementById('copyTranscript').addEventListener('click', () => this.copyToClipboard());
        document.getElementById('downloadTxt').addEventListener('click', () => this.downloadTranscript('txt'));
        document.getElementById('downloadJson').addEventListener('click', () => this.downloadTranscript('json'));

        // Settings
        document.getElementById('saveApiKey').addEventListener('click', () => this.saveApiKey());
        document.getElementById('apiSelect').addEventListener('change', () => this.saveSettings());
        document.getElementById('chunkSize').addEventListener('change', () => this.saveSettings());
        document.getElementById('overlapSize').addEventListener('change', () => this.saveSettings());
        document.getElementById('showTimestamps').addEventListener('change', () => this.saveSettings());
        document.getElementById('autoScroll').addEventListener('change', () => this.saveSettings());

        // Error notification
        document.querySelector('.error-close').addEventListener('click', () => this.hideError());

        // Listen for messages from background script
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'transcriptionResult') {
                this.addTranscriptionEntry(message.data);
            } else if (message.type === 'error') {
                this.showError(message.message);
            }
        });
    }

    async loadSettings() {
        const settings = await chrome.storage.sync.get({
            apiProvider: 'gemini',
            chunkSize: 30,
            overlapSize: 3,
            showTimestamps: true,
            autoScroll: true
        });

        document.getElementById('apiSelect').value = settings.apiProvider;
        document.getElementById('chunkSize').value = settings.chunkSize;
        document.getElementById('overlapSize').value = settings.overlapSize;
        document.getElementById('showTimestamps').checked = settings.showTimestamps;
        document.getElementById('autoScroll').checked = settings.autoScroll;
    }

    async saveSettings() {
        const settings = {
            apiProvider: document.getElementById('apiSelect').value,
            chunkSize: parseInt(document.getElementById('chunkSize').value),
            overlapSize: parseInt(document.getElementById('overlapSize').value),
            showTimestamps: document.getElementById('showTimestamps').checked,
            autoScroll: document.getElementById('autoScroll').checked
        };

        await chrome.storage.sync.set(settings);
    }

    async saveApiKey() {
        const apiKey = document.getElementById('apiKey').value;
        const apiProvider = document.getElementById('apiSelect').value;
        
        if (!apiKey.trim()) {
            this.showError('Please enter an API key');
            return;
        }

        await chrome.storage.sync.set({ [`${apiProvider}_api_key`]: apiKey });
        document.getElementById('apiKey').value = '';
        this.showSuccess('API key saved successfully');
        this.updateConnectionStatus();
    }

    async startRecording() {
        try {
            const sourceType = document.getElementById('sourceSelect').value;
            
            // Request permissions based on source type
            if (sourceType === 'microphone' || sourceType === 'both') {
                const micPermission = await this.requestMicrophonePermission();
                if (!micPermission) {
                    this.showError('Microphone permission is required');
                    return;
                }
            }

            // Start audio capture
            await this.initializeAudioCapture(sourceType);
            
            this.isRecording = true;
            this.isPaused = false;
            this.startTime = Date.now();
            this.sessionData = [];
            
            this.updateUI();
            this.startTimer();
            this.updateRecordingStatus('recording');
            
            // Clear previous transcription
            this.clearTranscription();
            
            // Send message to background script
            chrome.runtime.sendMessage({
                type: 'startRecording',
                sourceType: sourceType
            });

        } catch (error) {
            console.error('Failed to start recording:', error);
            this.showError('Failed to start recording: ' + error.message);
        }
    }

    async initializeAudioCapture(sourceType) {
        if (sourceType === 'current' || sourceType === 'both') {
            // Capture tab audio using the correct API signature
            const tab = await this.getCurrentTab();
            
            // Use callback-based approach for tabCapture
            const stream = await new Promise((resolve, reject) => {
                chrome.tabCapture.capture(
                    {
                        audio: true,
                        video: false
                    },
                    (stream) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        if (!stream) {
                            reject(new Error('Failed to capture tab audio - no stream returned'));
                            return;
                        }
                        resolve(stream);
                    }
                );
            });
            
            if (sourceType === 'current') {
                this.setupMediaRecorder(stream, 'Tab Audio');
                return;
            }
            
            // Store tab stream for combining with microphone
            this.tabStream = stream;
        }
        
        if (sourceType === 'microphone' || sourceType === 'both') {
            // Capture microphone
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            if (sourceType === 'microphone') {
                this.setupMediaRecorder(micStream, 'Microphone');
                return;
            }
            
            // Combine both streams if both selected
            if (this.tabStream) {
                const combinedStream = await this.combineAudioStreams(this.tabStream, micStream);
                this.setupMediaRecorder(combinedStream, 'Tab Audio + Microphone');
            } else {
                this.setupMediaRecorder(micStream, 'Microphone');
            }
        }
    }

    async combineAudioStreams(stream1, stream2) {
        // Create audio context for mixing streams
        const audioContext = new AudioContext();
        
        // Create sources from both streams
        const source1 = audioContext.createMediaStreamSource(stream1);
        const source2 = audioContext.createMediaStreamSource(stream2);
        
        // Create a destination for the mixed audio
        const destination = audioContext.createMediaStreamDestination();
        
        // Connect both sources to the destination
        source1.connect(destination);
        source2.connect(destination);
        
        return destination.stream;
    }

    setupMediaRecorder(stream, sourceLabel = 'Tab Audio') {
        this.audioContext = new AudioContext();
        this.currentStream = stream;
        this.currentSourceLabel = sourceLabel;
        
        // Check if MediaRecorder is supported with the stream
        if (!MediaRecorder.isTypeSupported('audio/webm')) {
            throw new Error('Audio recording not supported by this browser');
        }
        
        this.mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm'
        });
        
        this.audioChunks = [];
        
        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                this.audioChunks.push(event.data);
                console.log(`Audio chunk received: ${event.data.size} bytes`);
            }
        };

        this.mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event.error);
            this.showError('Recording error: ' + event.error.message);
        };

        this.mediaRecorder.onstop = () => {
            console.log('MediaRecorder stopped');
        };

        // Start recording and request data every 5 seconds
        this.mediaRecorder.start(5000);
    }

    async getCurrentTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab;
    }

    async requestMicrophonePermission() {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            return true;
        } catch (error) {
            return false;
        }
    }

    stopRecording() {
        this.isRecording = false;
        this.isPaused = false;
        
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        
        // Stop all tracks in the current stream
        if (this.currentStream) {
            this.currentStream.getTracks().forEach(track => track.stop());
            this.currentStream = null;
        }
        
        // Stop tab stream if it exists separately
        if (this.tabStream) {
            this.tabStream.getTracks().forEach(track => track.stop());
            this.tabStream = null;
        }
        
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        
        this.stopTimer();
        this.updateUI();
        this.updateRecordingStatus('inactive');
        
        // Send message to background script
        chrome.runtime.sendMessage({ type: 'stopRecording' });
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        
        if (this.isPaused) {
            if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.pause();
            }
            this.stopTimer();
        } else {
            if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
                this.mediaRecorder.resume();
            }
            this.startTimer();
        }
        
        this.updateUI();
        this.updateRecordingStatus(this.isPaused ? 'paused' : 'recording');
    }

    setupPeriodicTranscription() {
        setInterval(async () => {
            if (this.isRecording && !this.isPaused && this.audioChunks.length > 0) {
                await this.processAudioChunk();
            }
        }, 30000); // Process every 30 seconds
    }

    async processAudioChunk() {
        if (this.audioChunks.length === 0) return;

        const settings = await chrome.storage.sync.get(['chunkSize', 'overlapSize']);
        const chunkSize = settings.chunkSize || 30;
        const overlapSize = settings.overlapSize || 3;

        // Create audio blob from chunks
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
        
        // Add overlap from previous chunk if available
        let finalBlob = audioBlob;
        if (this.lastOverlapBuffer) {
            finalBlob = new Blob([this.lastOverlapBuffer, audioBlob], { type: 'audio/webm' });
        }

        // Save overlap for next chunk
        const overlapStart = Math.max(0, this.audioChunks.length - Math.floor(overlapSize * 1000 / 100));
        this.lastOverlapBuffer = new Blob(
            this.audioChunks.slice(overlapStart), 
            { type: 'audio/webm' }
        );

        // Send to background script for transcription
        chrome.runtime.sendMessage({
            type: 'transcribeAudio',
            audioData: await this.blobToBase64(finalBlob),
            timestamp: Date.now()
        });

        // Clear processed chunks but keep some for overlap
        this.audioChunks = this.audioChunks.slice(overlapStart);
    }

    async blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
        });
    }

    addTranscriptionEntry(data) {
        const settings = JSON.parse(localStorage.getItem('transcriptionSettings') || '{}');
        const showTimestamps = settings.showTimestamps !== false;
        const autoScroll = settings.autoScroll !== false;

        const entry = {
            timestamp: data.timestamp || Date.now(),
            text: data.text || '',
            source: data.source || this.currentSourceLabel || 'Audio',
            confidence: data.confidence || null
        };

        this.sessionData.push(entry);

        // Update display
        const display = document.getElementById('transcriptionDisplay');
        const placeholder = display.querySelector('.placeholder');
        
        if (placeholder) {
            placeholder.remove();
        }

        const entryElement = this.createTranscriptEntry(entry, showTimestamps);
        display.appendChild(entryElement);

        if (autoScroll) {
            display.scrollTop = display.scrollHeight;
        }
    }

    createTranscriptEntry(entry, showTimestamps) {
        const div = document.createElement('div');
        div.className = 'transcript-entry';

        if (showTimestamps) {
            const timestampDiv = document.createElement('div');
            timestampDiv.className = 'transcript-timestamp';
            timestampDiv.textContent = this.formatTimestamp(entry.timestamp);
            div.appendChild(timestampDiv);
        }

        const sourceDiv = document.createElement('div');
        sourceDiv.className = 'transcript-source';
        sourceDiv.textContent = entry.source;
        div.appendChild(sourceDiv);

        const textDiv = document.createElement('div');
        textDiv.className = 'transcript-text';
        textDiv.textContent = entry.text;
        div.appendChild(textDiv);

        return div;
    }

    formatTimestamp(timestamp) {
        if (!this.startTime) return '';
        
        const elapsed = timestamp - this.startTime;
        const seconds = Math.floor(elapsed / 1000) % 60;
        const minutes = Math.floor(elapsed / 60000) % 60;
        const hours = Math.floor(elapsed / 3600000);

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    clearTranscription() {
        const display = document.getElementById('transcriptionDisplay');
        display.innerHTML = `
            <div class="placeholder">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                </svg>
                <p>Start recording to see transcription...</p>
            </div>
        `;
    }

    startTimer() {
        if (this.timerInterval) return;
        
        this.timerInterval = setInterval(() => {
            if (this.startTime && !this.isPaused) {
                const elapsed = Date.now() - this.startTime;
                document.getElementById('sessionTimer').textContent = this.formatElapsedTime(elapsed);
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    formatElapsedTime(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000) % 60;
        const minutes = Math.floor(milliseconds / 60000) % 60;
        const hours = Math.floor(milliseconds / 3600000);

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    updateUI() {
        const startBtn = document.getElementById('startRecording');
        const stopBtn = document.getElementById('stopRecording');
        const pauseBtn = document.getElementById('pauseRecording');

        if (this.isRecording) {
            startBtn.disabled = true;
            stopBtn.disabled = false;
            pauseBtn.disabled = false;
            pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
        } else {
            startBtn.disabled = false;
            stopBtn.disabled = true;
            pauseBtn.disabled = true;
            pauseBtn.textContent = 'Pause';
        }
    }

    updateRecordingStatus(status) {
        const statusElement = document.getElementById('recordingStatus');
        const statusText = statusElement.querySelector('.text');
        
        statusElement.className = `status ${status}`;
        
        switch (status) {
            case 'recording':
                statusText.textContent = 'Recording';
                break;
            case 'paused':
                statusText.textContent = 'Paused';
                break;
            case 'inactive':
                statusText.textContent = 'Inactive';
                break;
        }
    }

    async updateConnectionStatus() {
        const apiProvider = document.getElementById('apiSelect').value;
        const apiKey = await chrome.storage.sync.get(`${apiProvider}_api_key`);
        
        const statusElement = document.getElementById('connectionStatus');
        const statusText = statusElement.querySelector('.text');
        
        if (apiKey[`${apiProvider}_api_key`]) {
            statusElement.className = 'status online';
            statusText.textContent = 'Connected';
        } else {
            statusElement.className = 'status offline';
            statusText.textContent = 'No API Key';
        }
    }

    async copyToClipboard() {
        const text = this.sessionData.map(entry => `${entry.source}: ${entry.text}`).join('\n');
        
        try {
            await navigator.clipboard.writeText(text);
            this.showSuccess('Transcript copied to clipboard');
        } catch (error) {
            this.showError('Failed to copy to clipboard');
        }
    }

    downloadTranscript(format) {
        let content, filename, mimeType;

        if (format === 'txt') {
            content = this.sessionData.map(entry => 
                `[${this.formatTimestamp(entry.timestamp)}] ${entry.source}: ${entry.text}`
            ).join('\n');
            filename = `transcript_${new Date().toISOString().split('T')[0]}.txt`;
            mimeType = 'text/plain';
        } else if (format === 'json') {
            content = JSON.stringify({
                sessionStart: this.startTime,
                sessionEnd: Date.now(),
                entries: this.sessionData
            }, null, 2);
            filename = `transcript_${new Date().toISOString().split('T')[0]}.json`;
            mimeType = 'application/json';
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    showError(message) {
        const notification = document.getElementById('errorNotification');
        const messageElement = notification.querySelector('.error-message');
        
        messageElement.textContent = message;
        notification.classList.remove('hidden');
        
        // Auto-hide after 5 seconds
        setTimeout(() => this.hideError(), 5000);
    }

    hideError() {
        document.getElementById('errorNotification').classList.add('hidden');
    }

    showSuccess(message) {
        // Simple success feedback - could be enhanced with a proper success notification
        console.log('Success:', message);
        // You could implement a success notification similar to error notification
    }
}

// Initialize the panel when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new AudioTranscriptionPanel();
});