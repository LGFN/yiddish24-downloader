# Yiddish24 Downloader Chrome Extension

This Chrome extension adds download buttons to each audio track on Yiddish24.com, allowing you to easily download the MP3 files.

## Features

- Adds a download icon beside each track's share/queue buttons (on the homepage they appear on hover, like the site's own buttons)
- Downloads audio files with proper headers and referer
- Works with dynamically loaded content
- Visual feedback on successful/failed downloads
- Optional **Compatibility mode** (off by default): re-encodes to constant bitrate (128 kbps, 44.1 kHz) MP3 for car stereos and older players. Toggle it from the extension's toolbar icon. Uses the bundled [lamejs](https://github.com/zhuker/lamejs) encoder (`lame.min.js`, LGPL).

## Installation Instructions

### Method 1: Load Unpacked Extension (For Development/Testing)

1. Open Google Chrome
2. Navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in the top-right corner)
4. Click "Load unpacked"
5. Select the `yiddish24-downloader` folder
6. The extension should now appear in your extensions list
7. Navigate to https://www.yiddish24.com/cat/49 (or any Yiddish24 category page)
8. You should see a download icon next to each track's share button

### Method 2: Pack and Install as CRX

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Pack extension"
4. Select the `yiddish24-downloader` folder as the extension root
5. Click "Pack Extension"
6. Install the generated .crx file

## Usage

1. Browse to any Yiddish24 page with audio tracks (e.g., https://www.yiddish24.com/cat/49)
2. Look for the download icon next to each track's share button (hover over a card on the homepage)
3. Click the download icon to download the audio file
4. The file will be saved to your default downloads folder
5. The icon will briefly turn green on success or red on error

## Technical Details

- **Manifest Version**: 3
- **Permissions**: 
  - `downloads` - Required to initiate file downloads
  - Host permissions for `yiddish24.com` and `cloudfront.yiddish24.com`
- **Content Script**: Injects download buttons into the page
- **Background Script**: Handles download requests with proper headers

## Files Structure

```
yiddish24-downloader/
├── manifest.json       # Extension configuration
├── content.js          # Script that adds download buttons to pages
├── background.js       # Service worker handling downloads
├── styles.css          # Styling for download buttons
├── icon16.png          # Extension icon (16x16)
├── icon48.png          # Extension icon (48x48)
├── icon128.png         # Extension icon (128x128)
└── README.md           # This file
```

## Troubleshooting

### Downloads not working
- Make sure you have granted the extension permission to access yiddish24.com
- Check the Chrome console (F12) for any error messages
- Verify that the audio URL is accessible

### Download buttons not appearing
- Refresh the page after installing the extension
- Make sure the page has fully loaded
- Check if JavaScript is enabled in your browser

### Icons not showing correctly
- The extension uses the Font Awesome 6 icons the site itself loads
- If Font Awesome is not loaded, the download icon may not display

## Privacy

This extension:
- Only runs on yiddish24.com domains
- Does not collect or transmit any personal data
- Does not modify page content except to add download buttons
- Downloads are handled locally by Chrome's download manager

## License

This extension is provided as-is for personal use.

## Version History

- **8.0**
  - Updated for the redesigned Yiddish24 site (new card layouts)

- **1.0** (Initial Release)
  - Add download buttons to audio tracks
  - Support for dynamically loaded content
  - Proper header handling for downloads
