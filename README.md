# Ramayana Reading

A tiny app for two people (Udit and Mum) to share where they stopped reading.
Open it, tap your name once, tap "Add my page", draw a line where you stopped, tap Save.
The home screen always shows the latest page. "History" shows the timeline.

Runs fully on Cloudflare's free plan. No card needed.
- Worker + static page: the app
- D1: the timeline (who, when)
- KV: the photos (compressed on the phone before upload)

## Put it online (3 commands)

    npm install
    npx wrangler login
    npx wrangler deploy

Wrangler prints your link, like `https://ramayana-reading.<you>.workers.dev`.
The first deploy creates the D1 database and KV store by itself.
Send the link to Mum on WhatsApp. Then on her phone: Share, "Add to Home Screen".

## Optional: lock it with a secret key

    npx wrangler secret put ACCESS_KEY

Type any word as the key. Then share the link as `https://<your-link>/?k=thatword`.
Each phone remembers it after the first open. Without a key, anyone with the link can use the app.

## Change the two names

Edit `PEOPLE` in `public/index.html` and in `src/worker.js`.

## Free plan room

Each photo is about 0.4 to 0.6 MB and uses 2 KV writes.
Roughly 500 photos a day and about 2000 photos in total.

## Try it on your computer

    npm run dev
