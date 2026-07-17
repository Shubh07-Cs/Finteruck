const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer } = require('electron');

// CRITICAL: Chromium flags MUST be set before app is ready
app.commandLine.appendSwitch('enable-media-stream');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity,BlockInsecurePrivateNetworkRequests,AudioServiceOutOfProcess');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');


const fs = require('fs');
const os = require('os');
const path = require('path');
const screenshot = require('screenshot-desktop');

// Helper function to check if running in dev mode
function isDevelopment() {
  return !app.isPackaged;
}

// Helper function to get the correct path based on environment
function getAppPath() {
  return isDevelopment() ? __dirname : path.join(process.resourcesPath, 'app.asar');
}

// Load .env from the correct location (handles both dev and production)
// Do this after app is ready
const isDev = !app.isPackaged;
let envPath;

if (isDev) {
  envPath = path.join(__dirname, '..', '.env');
} else {
  envPath = path.join(process.resourcesPath, '.env');
}

require('dotenv').config({ path: envPath });

console.log('Loaded .env from:', envPath);
console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✅ Found' : '❌ Missing');


require('dotenv').config({ path: envPath });

const GeminiService = require('./gemini-service');

(async () => {

let mainWindow;
let screenshots = [];
let chatContext = [];
const MAX_SCREENSHOTS = 3;

// Safe IPC sender to prevent "Render frame was disposed" errors during shutdown/reload
function safeSend(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, ...args);
    } catch (e) {
      console.warn(`[IPC] Suppressed error sending to ${channel}: ${e.message}`);
    }
  }
}

// ==========================================
// IPC HANDLERS - SYSTEM AUDIO
// ==========================================
ipcMain.handle('get-desktop-sources', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        return sources.map(source => ({
            id: source.id,
            name: source.name
        }));
    } catch (err) {
        console.error('Error getting desktop sources:', err);
        return [];
    }
});

// ==========================================
// IPC HANDLERS - SCREENSHOTS & AI
// ==========================================


// Initialize Gemini Service with rate limiting
let geminiService = null;

try {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not found in environment variables');
  } else {
    console.log('Initializing Gemini AI Service with rate limiting...');
    geminiService = new GeminiService(process.env.GEMINI_API_KEY);
    console.log('Gemini AI Service initialized successfully');
  }
} catch (error) {
  console.error('Failed to initialize Gemini AI Service:', error);
}

function createStealthWindow() {
  console.log('Creating stealth window...');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const windowWidth = 900;
  const windowHeight = 700;
  const x = Math.floor((width - windowWidth) / 2);
  const y = 40;

  console.log(`Window position: ${x}, ${y}, size: ${windowWidth}x${windowHeight}`);

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 400,
    minHeight: 32,
    maxWidth: width,
    maxHeight: height,
    x: x,
    y: y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      partition: 'persist:chatgpt'
    },
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    show: false,
    opacity: 1.0,
    type: 'toolbar',
    acceptFirstMouse: true,
    hasShadow: false,
    thickFrame: false,
    titleBarStyle: 'hidden'
  });

  console.log('BrowserWindow created');
  
  // --- Load ChatGPT DIRECTLY in the main window (no BrowserView!) ---
  console.log('Loading ChatGPT directly...');
  mainWindow.loadURL('https://chatgpt.com');

  // Grant ALL permissions (microphone, camera, etc.)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log('Permission requested:', permission);
    callback(true);
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return true;
  });

  // Handle popups (Google OAuth login)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('Popup requested:', url);
    // Navigate in-place for OAuth
    if (url.includes('accounts.google.com') || url.includes('auth0.com') || 
        url.includes('openai.com') || url.includes('chatgpt.com') ||
        url.includes('login') || url.includes('auth') || url.includes('signin')) {
      mainWindow.webContents.loadURL(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
  
  // Apply stealth settings
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { 
      visibleOnFullScreen: true,
      skipTransformProcessType: true 
    });
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu', 1);
    app.dock.hide();
    mainWindow.setHiddenInMissionControl(true);
  } else if (process.platform === 'win32') {
    console.log('Applying Windows stealth settings');
    mainWindow.setSkipTaskbar(true);
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
    mainWindow.setAppDetails({
      appId: 'SystemProcess',
      appIconPath: '',
      relaunchCommand: '',
      relaunchDisplayName: ''
    });
  }
  
  // Content protection will be set AFTER the window shows to prevent Windows from resetting the WDA flag

  
  mainWindow.setIgnoreMouseEvents(false);
  
  // Inject drag handle after ChatGPT loads
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('ChatGPT page loaded, injecting drag handle...');
    
    mainWindow.webContents.insertCSS(`
      /* Injected stealth drag bar */
      #stealth-drag-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 32px;
        background: #212121;
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding-right: 10px;
        -webkit-app-region: drag;
        cursor: move;
        user-select: none;
        -webkit-user-select: none;
      }
      #stealth-close-btn {
        -webkit-app-region: no-drag;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 59, 48, 0.7);
        color: white;
        font-size: 13px;
        font-weight: bold;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        padding: 0;
        line-height: 1;
        margin-left: 8px;
      }
      #stealth-close-btn:hover {
        background: rgba(255, 59, 48, 1);
        transform: scale(1.15);
      }
      
      #stealth-minimize-btn {
        -webkit-app-region: no-drag;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 199, 44, 0.7);
        color: white;
        font-size: 18px;
        font-weight: bold;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        padding: 0;
        line-height: 0.5;
        padding-bottom: 4px;
      }
      #stealth-minimize-btn:hover {
        background: rgba(255, 199, 44, 1);
        transform: scale(1.15);
      }
      
      /* Push ChatGPT content down so it's not hidden behind the bar */
      body {
        padding-top: 32px !important;
      }
      
      /* Make ChatGPT background translucent */
      html, body, #__next, main, div[class*="bg-token-main-surface"] {
        background-color: transparent !important;
        background: transparent !important;
      }
      
      /* The glassmorphism is now handled by #stealth-glass-bg to prevent breaking position:fixed */
      
      /* Ensure text remains readable */
      * {
        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
      }
    `).then(() => console.log('CSS injected'));
    
    mainWindow.webContents.executeJavaScript(`
      if (!document.getElementById('stealth-drag-bar')) {
        const bar = document.createElement('div');
        bar.id = 'stealth-drag-bar';
        
        const minBtn = document.createElement('button');
        minBtn.id = 'stealth-minimize-btn';
        minBtn.textContent = '-';
        minBtn.title = 'Minimize';
        minBtn.addEventListener('click', () => {
          if (window.electronAPI && window.electronAPI.toggleCollapse) {
            window.electronAPI.toggleCollapse();
          }
        });

        const closeBtn = document.createElement('button');
        closeBtn.id = 'stealth-close-btn';
        closeBtn.textContent = 'x';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', () => {
          if (window.electronAPI) {
            window.electronAPI.closeApp();
          }
        });
        
        bar.appendChild(minBtn);
        bar.appendChild(closeBtn);
        document.body.prepend(bar);
        console.log('Stealth drag bar injected');
        
        // Inject a dedicated fixed background div for glassmorphism
        const glassBg = document.createElement('div');
        glassBg.id = 'stealth-glass-bg';
        glassBg.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: -9999; background: rgba(30, 30, 30, 0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); pointer-events: none;';
        document.body.prepend(glassBg);
      }
    `).then(() => console.log('Drag bar JS injected'));
    
    mainWindow.show();
    mainWindow.focus();
    console.log('Window shown');
    
    // CRITICAL: Apply content protection AFTER the window is shown. 
    // On Windows, calling show() on a hidden window can reset the WDA flag.
    mainWindow.setContentProtection(true);
    console.log('Content protection enabled for stealth (post-show)');
  });
  
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });
  
  // Handle console messages
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (message.includes('popover') || message.includes('SafeArea')) return; // Suppress noise
    console.log(`ChatGPT console.${level}: ${message}`);
  });
  
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

function registerStealthShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+Shift+H', () => {
    toggleStealthMode();
  });

  globalShortcut.register('CommandOrControl+Alt+Shift+S', async () => {
    await takeStealthScreenshot();
  });

  globalShortcut.register('CommandOrControl+Alt+Shift+A', async () => {
    safeSend('trigger-analyze');
  });

  globalShortcut.register('CommandOrControl+Alt+Shift+X', () => {
    emergencyHide();
  });

  globalShortcut.register('CommandOrControl+Alt+Shift+V', () => {
    safeSend('toggle-voice-recognition');
  });

  globalShortcut.register('CommandOrControl+Alt+Shift+Left', () => {
    moveToPosition('left');
  });
  
  globalShortcut.register('CommandOrControl+Alt+Shift+Right', () => {
    moveToPosition('right');
  });
  
  globalShortcut.register('CommandOrControl+Alt+Shift+Up', () => {
    moveToPosition('top');
  });
  
  globalShortcut.register('CommandOrControl+Alt+Shift+Down', () => {
    moveToPosition('bottom');
  });
}

let isVisible = true;
let autoHideTimer = null;

function toggleStealthMode() {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }

  if (isVisible) {
    mainWindow.setOpacity(0.6);
    safeSend('set-stealth-mode', true);
    isVisible = false;
  } else {
    mainWindow.setOpacity(1.0);
    safeSend('set-stealth-mode', false);
    isVisible = true;
  }
}

function emergencyHide() {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }

  mainWindow.setOpacity(0.01);
  safeSend('emergency-clear');

  // ENHANCED: Wipe all stealth screenshots from disk immediately
  try {
    screenshots.forEach(screenshotPath => {
      if (fs.existsSync(screenshotPath)) {
        fs.unlinkSync(screenshotPath);
        console.log('Emergency deleted:', screenshotPath);
      }
    });
    screenshots = [];

    // Also nuke the entire screenshots directory to be safe
    const screenshotsDirDev = path.join(__dirname, '..', '.stealth_screenshots');
    const screenshotsDirProd = path.join(app.getPath('userData'), '.stealth_screenshots');
    [screenshotsDirDev, screenshotsDirProd].forEach(dir => {
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach(file => {
          try { fs.unlinkSync(path.join(dir, file)); } catch (e) {}
        });
        console.log('Emergency wiped screenshots dir:', dir);
      }
    });

    // Clear all AI context
    chatContext = [];
    if (geminiService) {
      geminiService.clearHistory();
    }
    console.log('Emergency: All traces wiped');
  } catch (error) {
    console.error('Emergency cleanup error:', error);
  }
  
  autoHideTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(1.0);
      isVisible = true;
    }
    autoHideTimer = null;
  }, 2000);
}

function moveToPosition(position) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const windowBounds = mainWindow.getBounds();
  
  let x, y;
  
  switch (position) {
    case 'left':
      x = 20;
      y = windowBounds.y;
      break;
    case 'right':
      x = width - windowBounds.width - 20;
      y = windowBounds.y;
      break;
    case 'top':
      x = Math.floor((width - windowBounds.width) / 2);
      y = 40;
      break;
    case 'bottom':
      x = Math.floor((width - windowBounds.width) / 2);
      y = height - windowBounds.height - 40;
      break;
    default:
      return;
  }
  
  mainWindow.setPosition(x, y);
}

async function takeStealthScreenshot() {
  try {
    console.log('Taking stealth screenshot...');
    const currentOpacity = mainWindow.getOpacity();
    
    mainWindow.setOpacity(0.01);
    
    await new Promise(resolve => setTimeout(resolve, 200));

    // Use app data directory for screenshots in production
    const screenshotsDir = isDevelopment()
      ? path.join(__dirname, '..', '.stealth_screenshots')
      : path.join(app.getPath('userData'), '.stealth_screenshots');

    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    
    const screenshotPath = path.join(screenshotsDir, `stealth-${Date.now()}.png`);
    await screenshot({ filename: screenshotPath });
    
    screenshots.push(screenshotPath);
    if (screenshots.length > MAX_SCREENSHOTS) {
      const oldPath = screenshots.shift();
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }
    
    mainWindow.setOpacity(currentOpacity);
    
    console.log(`Screenshot saved: ${screenshotPath}`);
    console.log(`Total screenshots: ${screenshots.length}`);
    
    safeSend('screenshot-taken-stealth', screenshots.length);
    
    return screenshotPath;
  } catch (error) {
    mainWindow.setOpacity(1.0);
    console.error('Stealth screenshot error:', error);
    throw error;
  }
}

async function analyzeForMeetingWithContext(context = '') {
  console.log('Starting context-aware analysis...');
  console.log('Context length:', context.length);
  console.log('API Key exists:', !!process.env.GEMINI_API_KEY);
  console.log('Model initialized:', !!(geminiService && geminiService.model));
  console.log('Screenshots count:', screenshots.length);

  if (!process.env.GEMINI_API_KEY) {
    console.error('No GEMINI_API_KEY found');
    safeSend('analysis-result', {
      error: 'No API key configured. Please add GEMINI_API_KEY to your .env file.'
    });
    return;
  }

  if (!geminiService || !geminiService.model) {
    console.error('Gemini model not initialized');
    safeSend('analysis-result', {
      error: 'AI model not initialized. Please check your API key.'
    });
    return;
  }

  if (screenshots.length === 0) {
    console.error('No screenshots to analyze');
    safeSend('analysis-result', {
      error: 'No screenshots to analyze. Take a screenshot first.'
    });
    return;
  }

  try {
    console.log('Sending analysis start signal...');
    safeSend('analysis-start');
    
    console.log('Processing screenshots...');
    const imageParts = await Promise.all(
      screenshots.map(async (path) => {
        console.log(`Processing screenshot: ${path}`);
        
        if (!fs.existsSync(path)) {
          console.error(`Screenshot file not found: ${path}`);
          throw new Error(`Screenshot file not found: ${path}`);
        }
        
        const imageData = fs.readFileSync(path);
        console.log(`Image data size: ${imageData.length} bytes`);
        
        return {
          inlineData: {
            data: imageData.toString('base64'),
            mimeType: 'image/png'
          }
        };
      })
    );

    console.log(`Prepared ${imageParts.length} image parts for analysis`);

    const contextPrompt = context ? `
    
CONVERSATION CONTEXT:
${context}

Based on the conversation context above and the screenshots provided, please:
1. Answer any questions that were asked in the conversation
2. Provide relevant insights about what's shown in the screenshots
3. If there are specific questions in the context, focus on answering those
4. Be concise but comprehensive

FORMAT YOUR RESPONSE AS:
    ` : '';

    const prompt = `You are an expert AI assistant for technical meetings and interviews. Analyze the provided screenshots and conversation context.

${contextPrompt}

**CODE SOLUTION:**
\`\`\`[language]
[Your complete, working code solution here - if applicable]
\`\`\`

**ANALYSIS:**
[Clear explanation of what you see in the screenshots and answers to any questions from the conversation]

**KEY INSIGHTS:**
• [Important insight 1]
• [Important insight 2]
• [Important insight 3]

Rules:
1. If there are questions in the conversation context, answer them directly
2. Provide code solutions if the screenshots show coding problems
3. Be concise but complete
4. Focus on actionable insights
5. If it's a meeting/presentation, summarize key points
6. Include time/space complexity for coding solutions

Analyze the screenshots and conversation context:`;

    console.log('Sending request to Gemini with rate limiting...');
    const text = await geminiService.generateMultimodal([prompt, ...imageParts]);
    console.log('Received response from Gemini');
    
    console.log('Generated text length:', text.length);
    console.log('Generated text preview:', text.substring(0, 200) + '...');

    chatContext.push({
      type: 'analysis',
      content: text,
      timestamp: new Date().toISOString(),
      screenshotCount: screenshots.length
    });

    safeSend('analysis-result', { text });
    console.log('Analysis result sent to renderer');
    
  } catch (error) {
    console.error('Analysis error details:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    let errorMessage = 'Analysis failed';
    
    if (error.message.includes('API_KEY')) {
      errorMessage = 'Invalid API key. Please check your GEMINI_API_KEY.';
    } else if (error.message.includes('quota')) {
      errorMessage = 'API quota exceeded. Please try again later.';
    } else if (error.message.includes('network') || error.message.includes('fetch')) {
      errorMessage = 'Network error. Please check your internet connection.';
    } else if (error.message.includes('model')) {
      errorMessage = 'AI model error. Please try a different model.';
    } else {
      errorMessage = `Analysis failed: ${error.message}`;
    }
    
    safeSend('analysis-result', {
      error: errorMessage
    });
  }
}

async function analyzeForMeeting() {
  await analyzeForMeetingWithContext();
}

// IPC handlers
ipcMain.handle('get-screenshots-count', () => {
  console.log('IPC: get-screenshots-count called, returning:', screenshots.length);
  return screenshots.length;
});

ipcMain.handle('toggle-stealth', () => {
  console.log('IPC: toggle-stealth called');
  return toggleStealthMode();
});

ipcMain.handle('emergency-hide', () => {
  console.log('IPC: emergency-hide called');
  return emergencyHide();
});

ipcMain.handle('take-stealth-screenshot', async () => {
  console.log('IPC: take-stealth-screenshot called');
  return await takeStealthScreenshot();
});

ipcMain.handle('analyze-stealth', async () => {
  console.log('IPC: analyze-stealth called');
  return await analyzeForMeeting();
});

ipcMain.handle('analyze-multimodal', async (event, audioBase64) => {
  console.log('Starting multimodal analysis with audio length:', audioBase64 ? audioBase64.length : 0);
  
  if (!process.env.GEMINI_API_KEY) {
    return { error: 'No API key configured.' };
  }

  if (screenshots.length === 0 && !audioBase64) {
    return { error: 'No screenshots or audio available to analyze.' };
  }

  safeSend('analysis-start');
  
  try {
    let finalResult = "";

    // 1. Analyze Screenshots (if any)
    if (screenshots.length > 0) {
      const screenParts = [
        { text: "Analyze this screen. Answer questions or provide solutions for what's visible." }
      ];
      
      for (const imgPath of screenshots) {
        if (fs.existsSync(imgPath)) {
          const base64 = fs.readFileSync(imgPath, { encoding: 'base64' });
          screenParts.push({
            inlineData: {
              mimeType: 'image/png',
              data: base64
            }
          });
        }
      }
      
      console.log('Sending screenshot analysis request...');
      const screenResult = await geminiService.generateMultimodal(screenParts);
      finalResult += "📸 **Screen Analysis:**\n" + screenResult + "\n\n";
    }

    // 2. Analyze Audio (if any)
    if (audioBase64) {
      const audioParts = [
        { text: "Listen to this audio recording of a meeting/conversation. Summarize what is being discussed, extract key points, and answer any direct questions or problems the speakers are facing." },
        {
          inlineData: {
            mimeType: 'audio/wav',
            data: audioBase64
          }
        }
      ];
      
      console.log('Sending audio analysis request...');
      const audioResult = await geminiService.generateMultimodal(audioParts);
      finalResult += "🎤 **Audio Analysis:**\n" + audioResult + "\n\n";
    }

    console.log('Multimodal analysis complete');
    const finalTrimmed = finalResult.trim();
    safeSend('analysis-result', { text: finalTrimmed });
    return { text: finalTrimmed };
  } catch (error) {
    console.error('Multimodal analysis error:', error);
    safeSend('analysis-result', { error: error.message });
    return { error: error.message };
  }
});

ipcMain.handle('analyze-stealth-with-context', async (event, context) => {
  console.log('IPC: analyze-stealth-with-context called with context length:', context.length);
  return await analyzeForMeetingWithContext(context);
});

ipcMain.handle('clear-stealth', () => {
  console.log('IPC: clear-stealth called');
  screenshots.forEach(path => {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
      console.log(`Deleted screenshot: ${path}`);
    }
  });
  screenshots = [];
  chatContext = [];
  console.log('All screenshots and context cleared');
  return { success: true };
});

ipcMain.handle('close-app', () => {
  console.log('IPC: close-app called');
  app.quit();
  return { success: true };
});

let isCollapsed = false;
let preCollapseBounds = null;

ipcMain.handle('toggle-collapse', () => {
  console.log('IPC: toggle-collapse called');
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  
  if (isCollapsed) {
    // Expand
    if (preCollapseBounds) {
      mainWindow.setBounds(preCollapseBounds);
    }
    isCollapsed = false;
  } else {
    // Collapse
    preCollapseBounds = mainWindow.getBounds();
    mainWindow.setBounds({
      x: preCollapseBounds.x,
      y: preCollapseBounds.y,
      width: preCollapseBounds.width,
      height: 32 // Just the height of the drag bar
    });
    isCollapsed = true;
  }
  return { success: true, collapsed: isCollapsed };
});



// New Cluely-style feature handlers

// Add voice transcript to history
ipcMain.handle('add-voice-transcript', async (event, transcript) => {
  console.log('IPC: add-voice-transcript called');
  if (geminiService) {
    geminiService.addToHistory('user', transcript);
  }
  return { success: true };
});

// "What should I say?" feature
ipcMain.handle('suggest-response', async (event, context) => {
  console.log('IPC: suggest-response called');
  try {
    if (!geminiService) {
      throw new Error('Gemini service not initialized');
    }
    const suggestions = await geminiService.suggestResponse(context);
    return { success: true, suggestions };
  } catch (error) {
    console.error('Error generating suggestions:', error);
    return { success: false, error: error.message };
  }
});

// Generate meeting notes
ipcMain.handle('generate-meeting-notes', async () => {
  console.log('IPC: generate-meeting-notes called');
  try {
    if (!geminiService) {
      throw new Error('Gemini service not initialized');
    }
    const notes = await geminiService.generateMeetingNotes();
    return { success: true, notes };
  } catch (error) {
    console.error('Error generating meeting notes:', error);
    return { success: false, error: error.message };
  }
});

// Generate follow-up email
ipcMain.handle('generate-follow-up-email', async () => {
  console.log('IPC: generate-follow-up-email called');
  try {
    if (!geminiService) {
      throw new Error('Gemini service not initialized');
    }
    const email = await geminiService.generateFollowUpEmail();
    return { success: true, email };
  } catch (error) {
    console.error('Error generating email:', error);
    return { success: false, error: error.message };
  }
});

// Answer specific question
ipcMain.handle('answer-question', async (event, question) => {
  console.log('IPC: answer-question called');
  try {
    if (!geminiService) {
      throw new Error('Gemini service not initialized');
    }
    const answer = await geminiService.answerQuestion(question);
    return { success: true, answer };
  } catch (error) {
    console.error('Error answering question:', error);
    return { success: false, error: error.message };
  }
});

// Get conversation insights
ipcMain.handle('get-conversation-insights', async () => {
  console.log('IPC: get-conversation-insights called');
  try {
    if (!geminiService) {
      throw new Error('Gemini service not initialized');
    }
    const insights = await geminiService.getConversationInsights();
    return { success: true, insights };
  } catch (error) {
    console.error('Error getting insights:', error);
    return { success: false, error: error.message };
  }
});

// Clear conversation history
ipcMain.handle('clear-conversation-history', async () => {
  console.log('IPC: clear-conversation-history called');
  try {
    if (geminiService) {
      geminiService.clearHistory();
    }
    chatContext = [];
    return { success: true };
  } catch (error) {
    console.error('Error clearing history:', error);
    return { success: false, error: error.message };
  }
});

// Get conversation history
ipcMain.handle('get-conversation-history', async () => {
  console.log('IPC: get-conversation-history called');
  try {
    if (!geminiService) {
      return { success: true, history: [] };
    }
    return { success: true, history: geminiService.conversationHistory };
  } catch (error) {
    console.error('Error getting history:', error);
    return { success: false, error: error.message };
  }
});

// App event handlers
app.whenReady().then(() => {
  console.log('App is ready, creating window...');
  createStealthWindow();
  registerStealthShortcuts();
  
  isVisible = true;
  
  console.log('Window setup complete - will show after content loads');
});

app.on('window-all-closed', () => {
  // Keep running in background for stealth operation
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createStealthWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  
  screenshots.forEach(path => {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  });
});

app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    // Allow OAuth popups, block everything else
    if (navigationUrl.includes('accounts.google.com') || 
        navigationUrl.includes('chatgpt.com') || 
        navigationUrl.includes('auth0.com') ||
        navigationUrl.includes('openai.com')) {
      return; // Allow
    }
    event.preventDefault();
  });
  
  // Do NOT block navigation — ChatGPT and OAuth need full navigation freedom
});

process.title = 'SystemIdleProcess';
})();