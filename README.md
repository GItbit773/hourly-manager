# Time Keeper

A time keeper that checks in through your day and asks what you did. Vanilla JS PWA, no build step; all data stays on the device (localStorage).

- **Priorities:** up to 5 a day in the morning stand-up, a daily reminder (default 7:00 AM), and **Plan ahead** to set priorities for future dates — they're pre-filled on the day and you can add more.
- **Schedule:** a drag-to-edit calendar per weekday. Tap/drag to block out time (lectures, travel…), drag to move, drag the bottom edge to resize, tap to rename / set a "quiet after" buffer / repeat on other days. Drag the Start/End bars to set the day. No check-ins during blocks; one check-in 10 min before a block; the interval restarts after it.
- **Personalities:** Mildly concerned, Micromanager, Drill sergeant, Hype coach, Zen master, Posh butler, Disappointed parent, Sarcastic coworker, Efficiency bot.

Live: https://gitbit773.github.io/hourly-manager/

## Run locally (Mac)
    python3 tools/serve.py 4180   → http://127.0.0.1:4180

## On an iPhone
1. Open the live URL in **Safari** → Share → **Add to Home Screen**.
2. Open it from the home screen and tap **Enable** for notifications (iOS 16.4+).
3. Settings → **Add check-ins to Calendar** → Add All.

iOS freezes web apps in the background, so the in-app timer only fires while the app is open. The Calendar events (every check-in plus the daily priorities reminder) ring even when it's closed; tapping one opens the app. Delete the old events and re-add them whenever you change your schedule.
