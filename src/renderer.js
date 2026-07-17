// NEW renderer.js for ChatGPT embedded interface

const emergencyOverlay = document.getElementById('emergency-overlay');
const statusText = document.getElementById('status-text');

// Utility for UI feedback
function showStatus(msg) {
    if (!statusText) return;
    statusText.textContent = msg;
    statusText.style.display = 'block';
    statusText.classList.add('show');
    
    setTimeout(() => {
        statusText.classList.remove('show');
        setTimeout(() => {
            statusText.style.display = 'none';
        }, 300);
    }, 2000);
}

async function init() {
    console.log('Initializing ChatGPT Embedded Renderer...');
    setupEventListeners();
    setupIpcListeners();
    document.body.style.visibility = 'visible';
}

function setupEventListeners() {
    const closeAppBtn = document.getElementById('close-app-btn');
    if (closeAppBtn) {
        closeAppBtn.addEventListener('click', () => {
            if (window.electronAPI) window.electronAPI.closeApp();
        });
    }
}

function setupIpcListeners() {
    if (!window.electronAPI) return;

    window.electronAPI.onScreenshotTakenStealth((count) => {
        showStatus('Screenshot captured');
    });

    window.electronAPI.onEmergencyClear(() => {
        showStatus('Emergency cleared');
    });
}

// Start app
document.addEventListener('DOMContentLoaded', init);
