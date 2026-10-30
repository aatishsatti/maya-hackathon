# Progress
- Done: F1 voice loop, F2 per-profile memory, F3 calling-first (reminders, call-back, smart alerts, safety escalation, family Seen).
- Done: one Maya (cheerful start, soft/calm by conversation), pain ladder, greeting rules, no-repeat (identity once, normal replies), profile isolation.
- Stack: Meta Transcribe + Spark, ElevenLabs. Keys in server .env only; data/ git-ignored; no transcripts kept.
- Tests: node --test test/*.test.js (101 total, 98 pass, 0 fail, 3 skipped need MAYA_REAL_SPARK=1).
- Open: ring only while app is open; family push only on open family page; no locked-phone ringing; WhatsApp sends are live (text, voice, photo, family panel and STOP all passed live on 5a5e54c).
- Open: no fall detection; safety-line wording can still repeat; tired brightness is prompt-only (no code hook).
- Next: live re-test of tone and repeats, then F4 scam shield, F5 dashboard. F6 WhatsApp is finished (live on 5a5e54c).
- WhatsApp prototype (render-test, WIP): text and voice notes in/out through the same Maya (whatsapp.js), outgoing from the family page with opt-in / 24 h window / template / spam guards, never a call. Server env: WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID (+ optional WHATSAPP_TEMPLATE_NAME / _LANG, WHATSAPP_API_VERSION). Webhook URL: /api/whatsapp/webhook. Live tests passed on the Meta test number (recipient must be on its allowed list).
- WhatsApp lesson (live, 2026-10-30): an outbound template send can work while inbound never arrives. WABA 1116892537450220 was subscribed only to "WA DevX Webhook Events 1P App" (2202427980234937), not to Maya. `GET /1116892537450220/subscribed_apps` showed it; `POST` to the same path returned `success: true` and inbound worked at once. Ticking the `messages` field on the app is not enough: the WABA itself must be subscribed to the Maya app. Check this first if Render logs show no `webhook POST arrived` line. Text chat now works both ways live (config 986976c, API v26.0).
