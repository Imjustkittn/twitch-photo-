# Twitch Subscriber Photo Gallery Extension

A complete Twitch Extension that shows a **subscriber-only photo gallery** with clickable photos, **comments gated by a 500 Bits unlock**, and **photo tipping** (100/500/1000 Bits). Broadcaster can hide comments.

> ⚠️ Payments inside an Extension must use **Bits-in-Extensions**. Direct $ donations in-extension are not permitted by Twitch policy. Show Bits amounts, not dollar values.

## Features
- **Subscriber-only view** (server-enforced via Helix `channel:read:subscriptions`).
- **Commenting** requires a one-time **COMMENT_500** (500 Bits) purchase.
- **Tipping** per photo via SKUs **TIP_100 / TIP_500 / TIP_1000**. Total Bits overlay per photo updates live.
- **Moderation**: broadcaster can click a comment to hide it.
- **Real-time updates** using Extensions PubSub.

## Project layout
```
frontend/
  index.html       # Panel view (viewer UI)
  panel.js
  styles.css
  config.html      # Broadcaster config view -> OAuth to EBS
server/
  server.js        # EBS (Express)
  twitch.js        # JWT verify/sign, PubSub, OAuth helpers
  db.js            # SQLite schema + seed
.env.example
package.json
```

## 1) Create a Twitch Extension
1. Go to **https://dev.twitch.tv/console/extensions** → **Create Extension**.
2. Enable these **Capabilities**:
   - **Identity Link** (to get a viewer's Twitch ID)
   - **Subscription Status Support**
   - **Bits in Extensions**
3. In **Monetization → Bits Products**, create products:
   - `COMMENT_500` — 500 Bits (mark **In Development** while testing)
   - `TIP_100` — 100 Bits
   - `TIP_500` — 500 Bits
   - `TIP_1000` — 1000 Bits
4. In **Asset Hosting**, set viewer URL to `frontend/index.html` and config URL to `frontend/config.html`.
5. In **Capabilities → Allowlist for URL Fetching Domains**, add your EBS origin (e.g. `https://your-ebs.example.com`).

## 2) EBS setup
1. Create an OAuth app at **https://dev.twitch.tv/console/apps** and set **Redirect URL** to your EBS `/auth/callback`.
2. Copy `.env.example` to `.env` and fill:
   - `EXTENSION_CLIENT_ID`, `EXTENSION_SECRET_B64` (from Extension → **Secrets**)
   - `TWITCH_APP_CLIENT_ID`, `TWITCH_APP_CLIENT_SECRET` (from your OAuth app)
   - `OAUTH_REDIRECT_URL`, `SERVER_BASE_URL`
   - `SESSION_SECRET`
3. Install & run:
```bash
npm i
npm run start
```
4. Deploy the EBS (Render, Fly, Railway, etc.) over **HTTPS** and update your `.env` and Twitch allowlists.

## 3) Connect the broadcaster (config view)
- In the Extension **Config** view, click **Connect with Twitch**. This grants the EBS the scope **channel:read:subscriptions** and stores the broadcaster token.

## 4) Local/Hosted Test
- Use **Local Test** first (self-signed HTTPS) then **Hosted Test** to upload `frontend` files as a zip.
- In **Monetization → Products**, leave products **In Development** during test. Twitch won't deduct live Bits.

## 5) How it works
- Frontend requests `/api/status` with the **Extension JWT**. EBS verifies the JWT and (if identity shared) checks subscriber status via Helix.
- `/api/photos` is **server-gated** and returns only to subscribers.
- Commenting: if the user hasn't unlocked, clicking the button triggers `useBits('COMMENT_500')`. On `onTransactionComplete`, the frontend posts the **transactionReceipt** to `/api/transactions/complete`, which verifies the receipt and grants a one-time unlock.
- Tipping: same flow using `TIP_*` SKUs, EBS adds `bits` to that photo and broadcasts a PubSub update.
- Broadcaster moderation uses a PATCH endpoint gated by `role: broadcaster` in the verified JWT.

## 6) Environment variables
See `.env.example`. In production you'll also want to set:
- `EXTENSION_OWNER_USER_ID` — your Twitch user ID (used when signing PubSub external JWT).

## 7) Notes & TODOs
- Replace the demo image URLs with your own. You could add upload/admin endpoints later.
- Identity linking: Users must click **Share identity** to participate (required for subscription checks and attribution).
- You may style or enhance the UI; the code keeps it intentionally minimal.

---

MIT License © 2025
