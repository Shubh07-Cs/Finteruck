# Stealth AI Meeting & Interview Assistant

A stealth, **100% screen-share undetectable** AI meeting assistant powered by direct ChatGPT integration and Deepgram real-time streaming speech-to-text.

Designed for Windows desktop environments.

---

## ⚡ Quick Start (1-Click Setup)

### 1. Clone the repository
```bash
git clone https://github.com/Shubh07-Cs/Finteruck.git
cd Finteruck
```

### 2. Run the Setup & Launcher
Double-click **`setup-and-run.bat`** in File Explorer.

- **First Run:** It will automatically install all Node.js dependencies and generate a `.env` configuration file.
- **Configure `.env`:** Open the generated `.env` file and paste your API keys:
  ```env
  GEMINI_API_KEY=your_gemini_api_key_here
  DEEPGRAM=your_deepgram_api_key_here
  ```
- **Launch:** Double-click **`setup-and-run.bat`** again. The application will launch silently in stealth mode (no terminal window, no taskbar icon).

---

## 🎮 Controls & Shortcuts

| Shortcut | Action | Description |
| :--- | :--- | :--- |
| **`Alt + S`** | **Silent Screenshot** | Instantly captures screen content & copies image to clipboard. Click ChatGPT & press `Ctrl+V` to paste. |
| **`Alt + R`** | **Live Audio Stream** | Toggles Deepgram real-time audio transcription. Listens to meeting audio, transcribes it, types it into ChatGPT & auto-sends. |
| **`Alt + A`** | **AI Analysis** | Triggers automated analysis workflow. |
| **Yellow `-`** | **Collapse / Rollup** | Shrinks window to a minimal top drag bar. Click again to expand. |
| **Red `X`** | **Quit App** | Force-closes the stealth application. |

---

## 🛡️ Stealth Capabilities

- **100% Invisible to Screen Share:** Employs Windows DWM Display Affinity (`SetWindowDisplayAffinity`) to completely exclude the window from Google Meet, Zoom, MS Teams, and screen recorders.
- **Hidden Window Controls:** Frameless, taskbar-hidden, and runs without an open terminal window using a silent VBS background host.
- **Glassmorphism Overlay:** Semi-translucent frosted glass design allowing you to easily view screen content behind the window.

---

## 📋 Requirements

- **Windows 10 / 11**
- **Node.js 18+** (Download from [nodejs.org](https://nodejs.org/))
- **Deepgram API Key** (Free tier from [deepgram.com](https://deepgram.com))
