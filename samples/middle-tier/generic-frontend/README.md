# RTClient Chat Sample

A Next.js-based chat application demonstrating the usage of RTClient for real-time conversations with OpenAI and Azure OpenAI models. This sample showcases text and audio interactions, streaming responses, and various configuration options.

## Features

- 🔄 Real-time text and audio conversations
- 🎙️ Audio recording and streaming playback
- 🔊 Voice Activity Detection (VAD) support
- ☁️ Support for both OpenAI and Azure OpenAI
- 🛠️ Configurable conversation settings
- 🔧 Tool integration support (coming soon)
- 🌙 Light, dark and Matrix theme toggle

## Prerequisites

- Node.js (version 18 or higher)
- npm or yarn
- An API key from OpenAI or Azure OpenAI
- For Azure OpenAI: deployment name and endpoint URL

## Getting Started

1. Clone the repository:
```bash
git clone <repository-url>
cd <project-directory>
```

2. Install dependencies:
```bash
npm install
# or
yarn install
```

3. Start the development server:
```bash
npm run dev
# or
yarn dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.
   Use the moon icon in the sidebar to switch between light, dark, or Matrix themes.
   When using the Phi-3 model the app now streams results from `/phi3-stream` and updates the UI in real time.

## Usage

### Middle Tier Endpoint

-  Update with your middle tier service endpoint, if needed

## Project Structure

```
src/
├── app/
│   └── page.tsx          # Main application page
├── components/
│   └── ui/              # shadcn/ui components
├── lib/
│   └── audio.ts         # Audio processing utilities
└── chat-interface.tsx   # Main chat component
```

## Dependencies

- `rt-client`: Real-time client library for OpenAI/Azure OpenAI
- `shadcn/ui`: UI component library
- `lucide-react`: Icon library
- Web Audio API for audio processing
