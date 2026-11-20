<p align="center">
  <img src="icons/icon-128.png" width="128" height="128" alt="YapBlocker logo">
</p>

# YapBlocker

A Chrome extension that suppresses high pitches on YouTube. While a voice above your pitch threshold is speaking, the tab drops to 25% volume. When a lower voice takes over, the volume comes back.

Everything runs in your browser. No audio is sent anywhere.

## What you need

- Chrome or Chromium 123 or newer, on a computer.
- It is developed on Chromium on Linux. The install steps are the same on Windows and macOS.
- Edge, Brave and other Chromium browsers should work but are untested.
- Firefox, Safari and phone browsers are not supported.

YapBlocker is not in the Chrome Web Store, so you load it by hand. It takes about a minute.

## Install

### 1. Get the files

Pick one:

- **Download.** Open the [latest release](https://github.com/mattmartinez/YapBlocker/releases/latest), download "Source code (zip)" and unzip it.
- **Git.** Run `git clone https://github.com/mattmartinez/YapBlocker.git`.

Put the folder somewhere it can stay. Chrome loads the extension from that folder every time it starts, so if you move or delete the folder, the extension stops working.

### 2. Load it into Chrome

1. Type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode**, the switch in the top right corner.
3. Click **Load unpacked**.
4. Pick the folder that has `manifest.json` in it. From a release zip, that is the `YapBlocker-1.0.0` folder.

YapBlocker now appears in the list of extensions.

### 3. Pin the icon

Click the puzzle piece in the toolbar, find YapBlocker and click the pin next to it.

### 4. Check that it works

1. Open a YouTube video where someone is talking.
2. Click the YapBlocker icon, then **Enable on this YouTube tab**.
3. Watch the popup. It shows **Listening** and a pitch reading while someone speaks. When a voice above the threshold talks, it shows **High pitch detected** and the badge reads **25% volume**.

## Use

1. Open a YouTube tab and click the YapBlocker icon.
2. Click **Enable on this YouTube tab**. From then on, the tab's sound plays through YapBlocker.
3. Close the popup if you like. It keeps running.

It works on one tab at a time. Enabling it on a second tab turns it off on the first.

It turns off when you click **Disable for this tab**, close the tab, or leave YouTube in that tab. It also turns off when Chrome restarts, so enable it again after a restart.

### The pitch threshold

The slider sets where "high" starts, from 140 to 230 Hz. It starts at 180 Hz and remembers where you leave it.

- If a high voice is getting through, move the slider down.
- If a low voice is getting turned down, move the slider up.

### The readings in the popup

| Reading | Meaning |
|---|---|
| Pitch | The pitch of the voice it hears right now, in Hz. Use it to pick a threshold. |
| Clarity | How clearly pitched the sound is. Spoken vowels score high, noise scores low. |
| Volume badge | 100% normally, 25% while it is turning the tab down. |

## Update

1. Download the new release and replace the files in the folder, or run `git pull` in it.
2. Open `chrome://extensions` and click the reload arrow on the YapBlocker card.
3. Enable it again on your YouTube tab.

## Remove

Open `chrome://extensions`, click **Remove** on the YapBlocker card, then delete the folder.

## Troubleshooting

| What happens | What to do |
|---|---|
| Chrome says "Manifest file is missing or unreadable" | You picked the wrong folder. Pick the one that contains `manifest.json`. |
| The popup says "Open YouTube in the active tab to use this extension." | It only works on `youtube.com` tabs. Switch to one and open the popup again. |
| It was working and now it is off | It turns off when Chrome restarts, when the extension is reloaded and when the tab leaves YouTube. Enable it again. |
| A high voice is not turned down | Lower the threshold. Watch the pitch reading while that voice talks to see where it sits. |
| A low voice gets turned down | Raise the threshold. |
| Music gets turned down | A held note at the pitch of a high voice looks the same to it. See the limits below. |
| The extension is gone from Chrome | The folder was moved or deleted. Load it again from where it is now. |

To see what it is doing, open `chrome://extensions` and click **offscreen.html** under "Inspect views" on the YapBlocker card. It is listed while YapBlocker is enabled on a tab. Set the console to show Verbose messages. Lines that start with `[voice]` log every time the volume goes down or comes back, and why.

## How it works

1. Chrome hands the tab's audio to the extension. The audio stays on your computer.
2. A pitch tracker measures the pitch of the voice about 60 times a second.
3. Every moment of speech votes for "above the threshold" or "below it". When enough votes add up, the volume switches.
4. Pauses and consonants don't vote, so the volume holds steady between words. A lower voice brings it back, and so does a second and a half of sound with no voice in it.

### Limits

- It follows pitch and nothing else. A low voice that climbs high gets turned down too.
- When two people talk at once, it can go either way.
- Held musical notes at the pitch of a high voice can set it off.

Measurements on real audio are in [tools/score](tools/score/README.md).

## Privacy

- Audio is processed inside the browser and never uploaded. The extension makes no network requests.
- It stores one setting, your threshold, in Chrome's extension storage.

| Permission | Why it is needed |
|---|---|
| `tabCapture` | To read the sound of the YouTube tab. |
| `offscreen` | To run the audio processing in a hidden page. |
| `storage` | To remember your threshold. |
| `activeTab` and `youtube.com` | To work on the YouTube tab you enable it on. |

## Develop

- `npm test` runs the unit tests. It needs Node and nothing else.
- `npm run score` measures the detector against real audio. See [tools/score](tools/score/README.md).
- After you change a file, click the reload arrow on the YapBlocker card at `chrome://extensions`.

| File | What it does |
|---|---|
| `manifest.json` | Extension manifest. |
| `background.js` | Starts and stops the capture and keeps the settings. |
| `offscreen.html`, `offscreen.js` | Hidden page that receives the tab's audio and plays it back through the filter. |
| `voice-worklet.js` | Runs on the audio thread and applies the volume change. |
| `voice-detector.js` | Pitch tracking and the decision to turn the volume down. |
| `popup.html`, `popup.js`, `popup.css` | The popup. |
| `icons/` | The logo in the sizes Chrome asks for. |
| `tests/` | Unit tests. |
| `tools/score/` | Scores the detector against real audio. |

## License

MIT. See [LICENSE](LICENSE).
