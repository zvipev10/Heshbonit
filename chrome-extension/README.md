# Heshbonit Browser Capture Extension

Development install:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this `chrome-extension` folder.

The extension listens for capture requests from the Heshbonit web app, opens invoice links in an inactive tab, prints the page to PDF through Chrome DevTools, uploads the PDF to the existing backend upload endpoint, and returns the processed invoice result to the page.
