console.log('Testing require electron...');
const electron = require('electron');
console.log('electron:', typeof electron);
console.log('electron.app:', typeof electron.app);

if (electron.app) {
    electron.app.whenReady().then(() => {
        console.log('App ready!');
        electron.app.quit();
    });
} else {
    console.log('ERROR: electron.app is undefined');
    process.exit(1);
}
