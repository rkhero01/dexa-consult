# ClinicOS — Per-Minute Consultation Module (Prototype)

Astrotalk-style "book any doctor, pay per minute" module — chat / call / video
alag-alag rates ke saath. Multi-doctor, multi-state ready.

## Naya: Self-Serve Doctor & Patient Accounts

Ab doctor aur patient dono khud signup/login kar sakte hain — koi admin banaye bina.
Ek hi file **`platform.html`** kholo — usme "Main Doctor Hoon" / "Main Patient Hoon"
chunke signup/login ho jata hai, uske baad seedha apna dashboard mil jata hai:

- **Doctor dashboard**: apne rates set karo, online/offline toggle karo, live active
  session dekho (agar koi patient book kare), earnings, poori consultation history
- **Patient dashboard**: wallet recharge, online doctors browse karo, ek click me
  book karo (chat/call/video), live billing dikhta hai, session history

`console.html` purani admin-style testing page hai (jisme tum khud doctor/patient
bana ke test karte the) — abhi bhi kaam karti hai, quick backend testing ke liye
rakh sakte ho. Production/asli use ke liye `platform.html` hi use karna.

## Kya hai isme

- **Doctor rate card** — har doctor ke chat/call/video ke alag ₹/min rates
- **Patient wallet** — prepaid balance, recharge, transaction ledger
- **Live per-minute billing engine** — har 10 second me wallet se deduction, balance khatam hote hi auto-disconnect
- **Real-time updates** — Server-Sent Events (SSE) se balance tick, session-end, aur chat messages live push hote hain
- **Doctor earnings/payout** — platform commission (default 20%) kaat kar net payout
- **Zero dependencies** — sirf Node.js core modules use kiye hain, `npm install` ki zaroorat nahi

## Setup

```bash
cd clinicos-consult
node server.js
```

Server `http://localhost:4000` par chalega (ya `PORT=5000 node server.js` se custom port).
Data `data/*.json` files me store hota hai (prototype ke liye — production me DB use karein, neeche dekhein).

## API Reference

### Auth (self-serve signup/login)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/doctor/signup` | `{ name, email, password, state, rates }` | Naya doctor account |
| POST | `/api/auth/doctor/login` | `{ email, password }` | Returns `{ token, doctor }` |
| POST | `/api/auth/patient/signup` | `{ name, email, phone, password }` | Naya patient account |
| POST | `/api/auth/patient/login` | `{ email, password }` | Returns `{ token, patient }` |

Login se mila `token` har `/api/me/*` call me `Authorization: Bearer <token>`
header me bhejo.

### Doctor's own dashboard (`/api/me/doctor`)

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/me/doctor` | Profile + `activeSession` (agar koi patient book kare hue hai) |
| PATCH | `/api/me/doctor` | `{ rates?, status?, state? }` — apne rates/availability update karo |
| GET | `/api/me/doctor/earnings` | Gross, commission, net payout |
| GET | `/api/me/doctor/sessions` | Poori consultation history |

### Patient's own dashboard (`/api/me/patient`)

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/me/patient` | Profile + wallet + `activeSession` |
| GET | `/api/me/patient/doctors` | Sab doctors browse karo (rates + online status) |
| POST | `/api/me/patient/recharge` | `{ amount }` |
| POST | `/api/me/patient/book` | `{ doctorId, type }` — ek click booking |
| GET | `/api/me/patient/sessions` | Poori consultation history |

### Doctors (admin/public — bina login ke, sirf testing/admin ke liye)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/doctors` | `{ name, specialization, state, rates: {chat, call, video} }` | Naya doctor add karo, rates ₹/min me |
| GET | `/api/doctors?state=Gujarat&online=true` | — | Filter by state/availability |
| GET | `/api/doctors/:id` | — | Ek doctor ki detail |
| PATCH | `/api/doctors/:id` | `{ rates?, status?, state? }` | Rates update, ya status: `online`/`offline`/`busy` |
| GET | `/api/doctors/:id/earnings` | — | Gross, commission, net payout |

### Patients / Wallet

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/patients` | `{ name, phone }` | Naya patient (existing phone ho to wahi return hoga) |
| POST | `/api/wallet/recharge` | `{ patientId, amount, paymentRef }` | Wallet me paisa add karo |
| GET | `/api/wallet/:patientId` | — | Current balance |
| GET | `/api/wallet/:patientId/transactions` | — | Poora ledger |

### Sessions (consultation booking + billing)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/sessions/start` | `{ patientId, doctorId, type }` | `type` = `chat`/`call`/`video`. Balance check hota hai, doctor `busy` ho jata hai |
| POST | `/api/sessions/:id/end` | — | Session manually end karo, final billing lock ho jati hai |
| GET | `/api/sessions/:id` | — | Status, elapsed seconds, amount charged so far |
| GET | `/api/sessions/:id/events` | — | **SSE stream** — live balance ticks + chat, browser me `EventSource` se subscribe karo |
| POST | `/api/sessions/:id/chat` | `{ sender: "patient"\|"doctor", message }` | Sirf `type: chat` sessions ke liye |

Billing har 10 seconds me tick karti hai (`billingEngine.js` me `TICK_SEC` badal sakte ho).
Wallet balance agle tick ke liye kam pade to session apne aap `low_balance` reason ke saath end ho jata hai.

## Apni website me connect karna

Ye backend ek alag domain/server par chalega — aapki website (frontend) isko plain
`fetch()` se call karegi. CORS already open hai (`Access-Control-Allow-Origin: *`),
production me isko apne asli domain tak restrict kar dena.

```js
// 1. Session start karo jab patient "Book Now" dabaye
const res = await fetch('https://your-consult-api.com/api/sessions/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ patientId, doctorId, type: 'video' }),
});
const session = await res.json();

// 2. Live balance/chat updates ke liye SSE subscribe karo
const events = new EventSource(`https://your-consult-api.com${session.eventsUrl}`);
events.addEventListener('tick', (e) => {
  const data = JSON.parse(e.data);
  updateBalanceUI(data.walletBalance, data.elapsedSec);
});
events.addEventListener('session_ended', (e) => {
  const data = JSON.parse(e.data);
  disconnectCallUI(data.reason); // 'manual' | 'low_balance'
});
events.addEventListener('chat_message', (e) => {
  renderChatBubble(JSON.parse(e.data));
});

// 3. Call/video khatam hone par (ya patient khud kaate)
await fetch(`https://your-consult-api.com/api/sessions/${session.id}/end`, { method: 'POST' });
```

## Real Call/Video — ab built-in hai (WebRTC, koi third-party SDK nahi)

`platform.html` ab **real peer-to-peer audio/video** karta hai seedha browser
`RTCPeerConnection` se — Agora/Twilio ki zaroorat nahi hai, koi extra dependency
nahi. Signaling (offer/answer/ICE) isi module ke existing SSE room ke upar
relay hoti hai, ek naye endpoint se:

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/sessions/:id/signal` | `{ from: 'caller'\|'callee', data }` | Pure relay — koi state store nahi karta, sirf dusre subscriber tak broadcast karta hai `event: signal` ke roop me |

Flow: jo booking karta hai (patient) wahi `caller` hai, doctor `callee` hai.
Dono `/api/sessions/:id/events` par already subscribed hain (billing ticks
+ chat ke liye) — signal events usi stream par aate hain.

**Production ke liye important**: abhi sirf public **STUN** use ho raha hai
(`stun.l.google.com`), jo zyadatar home/office networks par kaam karega.
Strict corporate firewalls ya kuch mobile carrier NATs ke peeche connection
fail ho sakta hai — us case me ek **TURN server** (coturn khud host karo, ya
Twilio/Xirsys/Cloudflare jaisi managed service) `platform.html` ke
`ICE_SERVERS` array me add karna hoga. Agora/Twilio Video abhi bhi ek valid
alternative hai agar tumhe managed infrastructure, recording, ya bigger-group
calls chahiye — is built-in WebRTC path se unpe switch karna sirf
`startWebRTC()`/`handleSignal()` ko unke SDK calls se replace karna hai,
baaki backend (billing, session lifecycle) same rehta hai.

Chat type sessions ke liye alag se koi third-party chahiye nahi — is module ka apna
SSE-based chat relay use kar sakte ho, ya apna existing chat system rakh ke sirf
billing ke liye `start`/`end` call karo.

## Production me le jaane se pehle (important)

- **Auth**: login tokens abhi kabhi expire nahi hote aur `/api/doctors`, `/api/patients`, `/api/sessions/:id/end`, `/api/sessions/:id/chat` jaise purane endpoints bina login ke bhi kaam karte hain (backward-compatibility + testing ke liye rakhe hain) — production me tokens ko expiry dena aur in open endpoints ko bhi auth se protect karna zaroori hai
- **Payment verification**: `wallet/recharge` abhi seedha credit karta hai — Razorpay/PhonePe ka webhook verify karke hi credit karna
- **Database**: `db.js` me sirf JSON files hain (prototype ke liye) — Postgres/MySQL/Mongo par swap karna hai, sirf `db.js` badalna padega, baaki code same rahega
- **CORS**: `*` ko apne real domain se replace karo
- **HTTPS**: production me reverse proxy (nginx) ke peeche HTTPS par chalao
- **Scaling**: multiple server instances chalane ho to billing timers aur SSE state ko Redis me move karna padega (abhi in-memory hai)

## Structure

```
clinicos-consult/
├── server.js          # HTTP server + routing (no framework)
├── db.js              # JSON file data layer (swap for real DB later)
├── auth.js            # Signup/login, password hashing, token auth
├── billingEngine.js   # Per-minute tick, deduction, auto-cutoff, earnings
├── sse.js             # Real-time events (balance ticks, chat, session-end)
├── platform.html       # Self-serve doctor + patient dashboards (main UI)
├── console.html        # Admin-style testing page (no login)
├── routes/
│   ├── doctors.js      # Admin/public doctor listing
│   ├── wallet.js        # Admin/public patient + wallet (no login)
│   ├── sessions.js      # Consultation booking + billing + chat
│   ├── meDoctor.js      # Logged-in doctor's own dashboard
│   └── mePatient.js     # Logged-in patient's own dashboard
└── data/               # auto-created JSON storage
```
