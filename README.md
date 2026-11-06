# Hourly Manager

An overbearing manager that asks every hour what you did.

- Up to 5 daily priorities in the morning stand-up.
- Weekly schedule: each weekday has its own hours and **blocked times** (lectures, travel…) with an optional *quiet after* buffer. No check-ins or reminders during a block; one check-in 10 min before it starts; the interval restarts when it ends. Vanilla JS PWA, no build step; all data stays on the device (localStorage).

## Run locally (Mac)
    python3 tools/serve.py 4180   → http://127.0.0.1:4180

## Put it on an iPhone
iPhones can only install a web app served over **HTTPS**, so the folder has to be hosted once:
- **Netlify Drop** — drag this whole `hourly-manager` folder onto https://app.netlify.com/drop, or
- **GitHub Pages** — push the folder to a repo and enable Pages.

Then on the iPhone:
1. Open the URL in **Safari** → Share → **Add to Home Screen**.
2. Open it from the home screen, tap **Enable** for notifications (iOS 16.4+).
3. Settings → **Add check-ins to Calendar** → Add All.

### Why the Calendar alarms?
iOS freezes web apps in the background, so the in-app hourly timer only fires while the app is open.
The Calendar events ring at every check-in even when the app is closed; tapping one opens the check-in.
Re-add them (after deleting the old ones) whenever you change your schedule.
