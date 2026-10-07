# Running a service with Agent HSP

A checklist for the person at the projection desk. Keep it next to the laptop.

## The week before

1. Install the latest build. On a Mac, open the `.dmg`, drag Agent HSP to Applications, then open it once from Applications (right-click, Open, if macOS warns).
2. Allow the microphone when macOS asks. If you missed the prompt: System Settings, Privacy & Security, Microphone, turn on Agent HSP.
3. Open Settings (the sliders button, top right):
   - Speech model: "Nemotron" on a Mac (fastest; works offline). Press Load and wait for "ready". "Deepgram" also works if you have a key and good internet; `small.en` is the fallback.
   - Audio input: the sound desk feed (USB from the mixer) if you have one, else the laptop microphone.
4. On the Look page, pick a background and set the church name. Pick backgrounds while you have internet; they download once and then work offline.
5. On the Service page, import songs (VideoPsalm `.vpagd` or songbook `.json`, OpenLyrics, OpenSong or plain text) and build the order of service. Use Duplicate to start from last week.

## Sunday, 30 minutes before

1. Connect the projector. Drag the "Agent HSP · Output" window onto it and double-click it to go full screen.
2. Open the service on the Service page. Click through each item once to check the slides.
3. Press Listen and speak a test reference ("John 3 16"). The top bar should say LISTENING in green and the verse should appear. Press B to black out again.
4. Check the level bar moves when someone speaks at the pulpit. If the status turns red (NOT TRANSCRIBING), see "If something goes wrong".

## During the service

| Key | What it does |
|---|---|
| → or Page Down | Next slide (a presentation clicker works) |
| ← or Page Up | Previous slide |
| B | Blackout. Press again to bring the slide back |
| L or Esc | Logo screen. Press L again to bring the slide back |
| H | Hold: the AI cannot change the screen; detected verses wait as cards |
| Enter | Show the oldest waiting card |

- Voice commands the preacher can use: "next" or "next verse", "previous verse", "next chapter", "previous chapter", "jump to chapter 2", "go to chapter 4 verse 5", "go to verse 20", "verse 95" (in the chapter on screen), "show it again", "read it in the Berean". They do nothing while Hold is on.
- Songs, readings and announcements: only you change the screen. The AI is held.
- Sermon: going live on the Sermon item turns Hold off and starts listening. Verses the preacher names go up on their own. Press H if you want to approve each one.
- A wrong verse: press B, or just let the next verse replace it. "Turn to Mark 2" alone does not change the screen; "Mark 2 verse 5" does.
- The summary slide only appears if you press "Summary now". It never replaces a verse on its own.

## If something goes wrong

- **Status says NOT TRANSCRIBING or BEHIND:** press Stop, then Listen. If it keeps happening, choose `base.en` in Settings (faster) and Listen again. You can still show verses by typing in "Find a verse" on the Live page.
- **Nothing is heard:** check the audio input in Settings and the microphone permission.
- **The app closes:** open it again. It puts the last slide back on the projector and the Service page remembers where you were.
- **The projector window closes:** it reopens with the current slide when the app restarts.

## After the service

Each listening session is saved in the app data folder under `sessions/` (audio, transcript and every slide shown). On a Mac: `~/Library/Application Support/com.agenthsp.desktop/sessions/`. Folder names use UTC time. Send the folder to the developers if a verse was missed or wrong; it lets us replay the service exactly.
