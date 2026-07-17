const {app, BrowserWindow} = require('electron');
const screenshot = require('screenshot-desktop');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800, 
    height: 600, 
    x: 0, 
    y: 0, 
    backgroundColor: '#ff0000', 
    frame: false, 
    transparent: false, 
    alwaysOnTop: true, 
    type: 'toolbar', 
    skipTaskbar: true,
    titleBarStyle: 'hidden'
  });
  
  win.loadURL('about:blank');
  win.setContentProtection(true);
  win.show();
  
  await new Promise(r => setTimeout(r, 2000));
  
  screenshot({filename: 'test_stealth2.png'}).then(() => {
    console.log('Screenshot 2 saved');
    app.quit();
  }).catch(e => {
    console.error(e);
    app.quit();
  });
});
