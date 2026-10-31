# homebridge-keurig-smart

Homebridge plugin for **Keurig SMART** brewers (K-Supreme SMART, K-Supreme Plus SMART, K-Café SMART) using the Keurig cloud, the same one the Keurig app uses.

> **Unofficial.** Keurig has no public API. This plugin copies what the open-source Home Assistant integration ([pykeurig](https://github.com/arketec/pykeurig), [homeassistant-keurig](https://github.com/AdamSand10/homeassistant-keurig)) does. It can stop working whenever Keurig changes its app.

## What shows up in the Home app

One accessory per brewer, with:

| Tile | Type | What it does |
|---|---|---|
| **Coffee Maker Power** | Switch | On = brewer awake (`idle`), Off = standby. |
| **Brew** | Switch | Brews the loaded pod at your default cup size. Powers the brewer on first if needed. Turns itself off when the brew is done. Turn it off early to cancel. |
| **Needs Water** | Occupancy sensor | "Detected" when the reservoir needs water. |
| **Pod Loaded** | Occupancy sensor | "Detected" when there is a pod in the brewer. |
| **Lid** | Contact sensor | "Open" when the brewer reports the lid open. |
| **Hot Water** (optional) | Switch | Brews hot water with no pod. Off by default. |

If the brewer can't brew (no water, lid open, no pod, old pod not removed), the Brew switch flips back off and the Homebridge log says why.

The brewer still needs **water in the tank, a fresh pod, a closed lid and a mug**. The plugin can't do those for you.

Status is checked every 60 seconds by default (minimum 30), and every 5 seconds while brewing. If Keurig errors or rate-limits, it backs off automatically (up to 10 minutes). A wrong password is retried only once an hour so your account doesn't get locked.

## Install (from the Homebridge UI on a phone)

This plugin isn't on npm, so `hb-service add` won't work, because it only accepts npm package names. Install it with `npm` from the Homebridge terminal instead:

1. In the Homebridge UI, tap **☰ → Terminal**. If you don't see Terminal, turn it on under **☰ → Settings → Terminal** first.
2. Paste this single line and press Enter:

   ```
   npm --prefix /var/lib/homebridge install https://github.com/Orrzy2/homebridge-keurig-smart/archive/refs/heads/main.tar.gz
   ```

   That URL downloads the latest code from this GitHub repository. This is exactly what `hb-service add` runs internally.
3. Wait until it says `added 1 package`, then restart Homebridge (the ⏻ / restart icon at the top right).
4. Go to **☰ → Plugins**, find **Keurig SMART**, tap **⋮ → Plugin Config** (or the settings/gear icon), then enter your **Keurig app email and password** and save.
5. Restart Homebridge again. Your brewer appears in the Home app under the Homebridge bridge.

Optional: under the plugin's **⋮ → Bridge Settings**, run it as a **child bridge** so a Keurig problem can never slow down your cameras or other accessories.

### Update / uninstall

* Update: run the same `npm --prefix /var/lib/homebridge install <NEW-PACKAGE-URL>` again, then restart.
* Uninstall: `npm --prefix /var/lib/homebridge uninstall homebridge-keurig-smart`, then restart. You can also uninstall from the Plugins page.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `email`, `password` | (required) | Your Keurig **app** login. Stored only in Homebridge's `config.json`, like every other plugin. |
| `pollInterval` | 60 | Seconds between status checks (≥ 30). |
| `brewMode` | `recommended` | `recommended` uses Keurig's recipe for the recognized pod at your size and falls back to custom if the pod isn't recognized. `custom` uses the temperature and strength below. |
| `brewSize` | 8 | 4, 6, 8, 10 or 12 oz. |
| `brewTemperature` | `Hot` | Warm 187°F, Warmer 191, Hot 194, Hotter 197, XHot 200, MaxHot 204. |
| `brewIntensity` | `Balanced` | Balanced, Rich, Robust, Strong, Intense. |
| `autoPowerOn` | true | Wake the brewer when Brew is turned on. |
| `showSensors` | true | Needs Water / Pod Loaded / Lid. |
| `showHotWaterSwitch` | false | Adds the Hot Water switch. |
| `hotWaterSize`, `hotWaterTemperature` | 8, `MaxHot` | |
| `subscriptionKey`, `apiUrl` | (blank) | Advanced. Only if Keurig rotates the app key and the community publishes a new one. |

Example `config.json` block:

```json
{
  "platform": "KeurigSmart",
  "name": "Keurig",
  "email": "you@example.com",
  "password": "your-keurig-password",
  "pollInterval": 60,
  "brewMode": "recommended",
  "brewSize": 8
}
```

## Troubleshooting

* **"Keurig login failed"**: use the same email and password that work in the Keurig app. If you sign in to the app with Apple or Google, set a password on the Keurig account first.
* **Brew flips back off**: check the log for the reason (needs water, lid open, no pod, used pod).
* **Status update failed (HTTP 401/403) for everyone**: Keurig probably rotated its app key or changed the login. Check the pykeurig / homeassistant-keurig repos for an updated key and paste it into *Advanced → subscriptionKey*.

## Development

No runtime dependencies (uses Node's built-in `fetch`). Works with Homebridge 1.8+ and 2.x on Node 18–24.

```
npm install      # dev only: installs homebridge for tests
npm test         # API client + platform tests against a mock Keurig cloud
node test/mock-server.js 18765   # fake Keurig cloud for running homebridge locally (set apiUrl to http://127.0.0.1:18765/connected-platform/)
```

## Credits

API behaviour comes from pykeurig by Dominick Meglio (@dcmeglio), maintained by @jspeckman, @arketec and @AdamSand10 (MIT).

### One-button mode (0.2.0)

Set `showPowerSwitch: false` to hide the Coffee Maker Power switch, and `brewSwitchName` (e.g. "Brew 10 oz") with `brewSize: 10` for a single button that powers on and brews.
