// Content script for Chrome Extension Audio Transcription
// This script helps with communication between the sidepanel and background script

class ContentScriptHandler {
    constructor() {
        this.init();
    }

    init() {
        // Listen for messages from background script
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'transcriptionResult' || message.type === 'error') {
                // Forward messages to sidepanel if it's open
                this.forwardToSidepanel(message);
            }
        });

        // Monitor tab audio state
        this.monitorAudioState();
    }

    forwardToSidepanel(message) {
        // Post message to window for sidepanel to catch
        window.postMessage({
            source: 'chrome-extension-transcription',
            ...message
        }, '*');
    }

    monitorAudioState() {
        // Check if tab is playing audio
        const checkAudioState = () => {
            const audioElements = document.querySelectorAll('audio, video');
            let hasActiveAudio = false;

            audioElements.forEach(element => {
                if (!element.paused && !element.muted && element.currentTime > 0) {
                    hasActiveAudio = true;
                }
            });

            // Also check for Web Audio API usage
            if (window.AudioContext || window.webkitAudioContext) {
                // This is a simplified check - in practice, you'd need more sophisticated detection
                hasActiveAudio = hasActiveAudio || this.detectWebAudioActivity();
            }

            // Send audio state to background
            chrome.runtime.sendMessage({
                type: 'audioStateUpdate',
                hasActiveAudio: hasActiveAudio,
                tabId: this.getTabId(),
                url: window.location.href,
                title: document.title
            });
        };

        // Check audio state periodically
        setInterval(checkAudioState, 2000);

        // Also check when audio/video elements change
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                if (mutation.type === 'childList') {
                    const addedNodes = Array.from(mutation.addedNodes);
                    const hasMediaElements = addedNodes.some(node => 
                        node.nodeType === 1 && (node.tagName === 'AUDIO' || node.tagName === 'VIDEO')
                    );
                    
                    if (hasMediaElements) {
                        setTimeout(checkAudioState, 100);
                    }
                }
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    detectWebAudioActivity() {
        // This is a simplified detection method
        // In a real implementation, you might need to hook into the Web Audio API
        // to detect active audio processing
        return false;
    }

    getTabId() {
        // This is a simplified way to identify the tab
        // Chrome extensions can't directly access tab ID from content scripts
        return window.location.href;
    }
}

// Only initialize if we're not in an iframe and the page is loaded
if (window.top === window && document.readyState !== 'loading') {
    new ContentScriptHandler();
} else if (window.top === window) {
    document.addEventListener('DOMContentLoaded', () => {
        new ContentScriptHandler();
    });
}