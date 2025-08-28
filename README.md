# Real-Time Audio Transcriber Chrome Extension
A Chrome extension that captures audio from browser tabs and provides real-time transcription.

## Features
**Captures audio from active browser tab**
**Live Transcription**
**Update transcript every 30 seconds and display in sidepanel**
**COmprehensive error handling and user feedback**
**Export/Copy transcript functionality**
**Channel labeling (tab vs microphone)**
**Offline buffering capability**
**Use overlap of 3 seconds of audio between consecutive 30 second chunks to make sure that no words are lost between chunks**
**Configurable Chunk Sizes**

## Installation
### Prerequisites
Google Chrome browser (version 88 or higher)

API key from one of the supported services (Google Gemini currently supported!)

### Setup Instructions
#### Download or Clone the Extension
`git clone https://github.com/abhinandan-SS25/rtat_ce`
#### Load the Extension in Chrome

- Open Chrome and navigate to chrome://extensions/
- Enable "Developer mode" using the toggle in the top right corner
- Click "Load unpacked" and select the extension directory

#### Configure API Key

- Click the extension icon in the toolbar to open the sidepanel
- Enter your API key in the settings section
- Select Gemini
- Click "Save" to store your settings

## Usage
#### Start Transcription

- Open the sidepanel by clicking the extension icon
- Select your audio source (Current Tab is recommended)
- Click the "Start Recording" button
- Begin playing audio in your browser tab

#### Monitor Transcription

- Watch as transcriptions appear in real-time
- View recording status and timer in the interface
- Use pause/resume if needed during the session

#### Export Results

- During or after recording, use the export buttons to:
- Copy transcript to clipboard
- Download as text file (.txt)
- Download as JSON with metadata (.json)

## Supported APIs
#### Google Gemini 

## Technical Details
#### Architecture
**Manifest V3**: Modern Chrome extension architecture
**Service Worker**: Handles background processing and API calls
**Sidepanel UI**: Primary user interface for controls and display
**Content Scripts**: Minimal tab interaction for audio state detection

## Performance
- Minimal CPU usage through efficient audio processing
- Memory management for long recording sessions
- Background processing to avoid UI blocking
- Optimized chunk processing with configurable intervals

## Limitations
- Requires Chrome 88 or higher
- Currently only Gemini API supported
- User has to get their own API key to use service
- Tab audio capture only works on HTTP/HTTPS pages (not Chrome internal pages)
- Audio quality affects transcription accuracy