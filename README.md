# This Day Then

A first demo for a calm five-line journal.

The prototype now includes a small built-in backend for private accounts and saved diary entries.

## What works

- Audio-first warm-friend check-in UI
- Optional local Chatterbox TTS voice for more natural open-source speech
- Browser demo live voice mode with speech recognition/synthesis where supported
- Green meditative design with a breathing canvas background
- Drafts a five-line memory from the conversation
- Creates accounts, logs users in with HttpOnly cookie sessions, and saves entries per user
- Supports Google sign-in when OAuth credentials are configured
- Lets signed-out visitors use the full diary UI with temporary in-memory entries
- Stores diary data in a local JSON database
- Shows the selected date across five years
- Adds sample same-date memories for demoing comparison
- Light and soft dark themes

## Try it

Run the local web service:

```sh
npm start
```

Then open `http://127.0.0.1:3000`.

By default the app writes its database to `data/this-day-then-db.json`. To use a
different database path, set:

```sh
DIARY_DB_PATH=/absolute/path/diary-db.json npm start
```

## Google sign-in

Create a Google OAuth client for a web application, then set these environment
variables:

```sh
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://thisdaythen.com/api/auth/google/callback
CANONICAL_HOST=thisdaythen.com
```

Add the same redirect URI in Google Cloud Console. If `GOOGLE_REDIRECT_URI` is
not set, the server uses the current request origin plus
`/api/auth/google/callback`.
`CANONICAL_HOST` keeps `www.thisdaythen.com` and `thisdaythen.com` on the same
host so OAuth state cookies survive the Google redirect.

This version still uses local summary drafting. The server includes `/api/realtime-session`
for OpenAI Realtime WebRTC, but real voice AI requires setting `OPENAI_API_KEY` in the
Render environment.

## Natural local voice

For open-source TTS, run a local Chatterbox service in one terminal:

```sh
python3 -m venv .venv-tts
. .venv-tts/bin/activate
pip install chatterbox-tts
python local_tts/chatterbox_server.py
```

Then run the app with the local TTS bridge enabled:

```sh
npm run start:local-tts
```

The app will call `POST /api/local-tts`, which forwards text to
`http://127.0.0.1:7861/synthesize` and plays the returned WAV audio. If the local
model is unavailable, the browser voice remains as a fallback.

To clone or guide a specific voice, point Chatterbox at a short reference clip you
have permission to use:

```sh
CHATTERBOX_REFERENCE_AUDIO=/absolute/path/reference.wav python local_tts/chatterbox_server.py
```

Useful knobs:

- `LOCAL_TTS_URL` - local synthesis endpoint, defaults in `start:local-tts` to Chatterbox
- `VOICE_MODE=local-tts` - prefer local TTS over OpenAI Realtime when both are configured
- `LOCAL_TTS_EXAGGERATION=0.45` - emotion intensity sent to Chatterbox
- `CHATTERBOX_DEVICE=cuda|mps|cpu` - force the model device
