# This Day Then

A first demo for a calm five-line journal.

The prototype is intentionally static so the product feeling can be tested quickly before adding a backend or native iOS app.

## What works

- Audio-first warm-friend check-in UI
- Browser demo live voice mode with speech recognition/synthesis where supported
- Green meditative design with a breathing canvas background
- Drafts a five-line memory from the conversation
- Saves entries in local storage
- Shows the selected date across five years
- Adds sample same-date memories for demoing comparison
- Light and soft dark themes

## Try it

Run the local web service:

```sh
npm start
```

Then open `http://127.0.0.1:3000`.

This version still uses local summary drafting. The server includes `/api/realtime-session`
for OpenAI Realtime WebRTC, but real voice AI requires setting `OPENAI_API_KEY` in the
Render environment.
