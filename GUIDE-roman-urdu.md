# HexPour — Istemaal Guide (Roman Urdu)

> Factory rule: har published project mein yeh file `GUIDE-roman-urdu.md` ke naam se zaroori hai.

## 1. Yeh project kya hai?

HexPour ek **offline hex sort / pour** puzzle game hai. Hex cells ke andar color stacks hoti hain; aap **sirf padosi (adjacent) hex** par pour karte ho. Yeh TubeSort / water tubes **nahi** hai — hive / hex board hai.

## 2. Kahan se download karein?

- GitHub Pages (jab publish ho): `…/hexpour/`
- Source / ZIP: factory repo path `/workspace/factory/projects/hexpour`
- Local: `npm run build` ke baad `dist/` folder

## 3. Pehle kya chahiye? (requirements)

- Node.js 20+ (dev / build ke liye)
- Modern browser (Chrome / Edge / Firefox / Safari) — phone ya desktop
- Internet sirf pehli load / install ke liye; phir PWA offline chal sakti hai

## 4. Install + Run (step-by-step)

1. Project folder kholo: `cd /workspace/factory/projects/hexpour`
2. Packages: `npm install`
3. Dev server: `npm run dev` — browser mein URL kholo
4. Production check: `npm test && npm run build && npm run preview`
5. Phone par: browser se site kholo → “Add to Home Screen” (PWA)

## 5. Demo login (agar ho)

Koi login nahi. Progress `localStorage` mein save hoti hai.

## 6. Features — har ek kya karta hai

### Play / Levels
- **Kahan:** Home → Play ya Levels
- **Kaise:** Level select se koi unlocked level chuno; pehla level se shuru
- **Result:** Hex board dikhega, stacks ke sath

### Pour (core)
- **Kahan:** Play screen — hex cells
- **Kaise:** Pehle source cell tap (colors honi chahiye), phir **adjacent** target tap
- **Result:** Top same-color run target par chali jati hai (agar empty ho ya top color match + capacity free). Galat move par shake + toast

### Win
- Har occupied cell ek hi color ki solid stack ho; khali cells OK
- Win screen → Next / **Share** / Levels / Home
- Share: `navigator.share` ya clipboard + toast (offline OK)

### How to play
- **Kahan:** Pehli open par auto overlay; Home → **How to play**
- **Kaise:** 4–6 bullets (adjacent pour, capacity, win, Undo, Hint); Got it → `hexpour:howto` save
- **Result:** Rules samajh aati hain; Play block nahi hota

### Add to Home Screen (A2HS tip)
- **Kahan:** Sirf Home — soft tip
- **Kaise:** EN + Roman Urdu; Got it → session dismiss (`hexpour:a2hs`)
- **Result:** Levels/play/win par tip nahi; pehle howto, phir Home+A2HS OK

### Undo
- **Kahan:** Play toolbar → Undo
- **Kaise:** Unlimited — pehle wala board wapas
- **Result:** Aakhri pour undo

### Hint
- **Kahan:** Play toolbar → Hint
- **Kaise:** Level mein 1 free hint; phir rewarded ad stub
- **Result:** Ek legal pour highlight

### Mute / Settings
- **Kahan:** Home → Settings, ya play topbar ⚙
- **Kaise:** Mute On/Off; Remove ads (stub purchase)
- **Result:** Preference `localStorage` mein save

### Ads stubs
- Interstitial win / restart par (agar ads remove na hon)
- Rewarded hint ke baad
- Remove-ads stub Settings se

## 7. Common masail (troubleshooting)

- **Pour nahi ho raha:** Sirf 6-neighbor adjacent cells; top color match ya empty; capacity full to nahi?
- **Level lock:** Pehle wale levels clear karo — sequential unlock
- **Blank screen / assets 404:** `base: '/hexpour/'` — Pages path sahi ho; local preview bhi `/hexpour/` expect karta hai
- **Progress gayab:** Browser data clear / alag browser = naya save
- **PWA update nahi:** Tab band karke dubara kholo; SW autoUpdate hai

## 8. Security / privacy tips

- Koi account / password nahi
- Progress aur settings sirf device `localStorage` mein
- Real AdMob / billing keys MVP mein nahi — stubs only
- Teesri party ko personal data nahi bhejte (offline-first)

## 9. Agla update

- Unreleased polish: in-app howto, win Share, Home A2HS tip
- Zyada levels / real ads SDK (jab factory decide kare)
- TubeSort / tubes kabhi nahi aayenge — hex adjacency hi core hai
